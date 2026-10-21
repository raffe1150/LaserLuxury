import { knowledgeOperation, knowledgeOperationSignal, knowledgeExecutionDeadline, KNOWLEDGE_OPERATION_LIMITS } from './knowledge-operation';
import { runOptionalDiagnostic } from '../ai/business-information-timing';
import { boundedInteger, captureVerified, requireId, snapshot, type Checkpoint, type DeliveryOutcome,
  type KnowledgeAuthority, type KnowledgeDelivery, type KnowledgeLifecycleRepository, type KnowledgeScope, type KnowledgeTask,
  type TaskToken, type VerifiedKnowledge } from './knowledge-lifecycle';

/** A server-only Knowledge entry point. Must reuse the existing evidence-first
 * path; no Booking executor, recipient, authority boolean or raw model output.
 * Each real provider invocation must reserve an attempt immediately beforehand.
 * Checkpoints are markers, not cached planner/evidence/verification artifacts.
 */
export type KnowledgeExecutor = (task: KnowledgeTask, context: Readonly<{
  signal: AbortSignal; expiresAt: number;
  progress?(stage: 'extraction' | 'verification' | null, labels?: readonly string[]): void;
  reserveModelAttempt(): Promise<void>;
  checkpoint(stage: Checkpoint): Promise<void>;
}>) => Promise<VerifiedKnowledge | null>;
export type RunnerEvent = Readonly<{ turnId: string; channel: KnowledgeScope['channel'];
  fence: number; attempt: number;
  stage: 'claimed' | 'execution_error' | 'lease_lost' | 'failed' | 'verified' | 'finalized' | 'stopped' | 'send_claimed' | 'transport_result' | 'settlement_failed' | 'settled';
  outcome?: DeliveryOutcome['kind']; settled?:boolean; durationMs?:number; customerDelivery: 'UNCONFIRMED' }>;

/** Inactive bounded executor, not a queue or a durable scheduler. A host must
 * discover durable work and call run/recover after startup; no constructor side
 * effects or production feature flag is enabled by this module. */
export class KnowledgeRunner {
  private active = new Map<string, AbortController>();
  private stopped = false;
  constructor(private readonly repository: KnowledgeLifecycleRepository, private readonly execute: KnowledgeExecutor,
    private readonly owner: string, private readonly concurrency = 2,
    private readonly telemetry?: (event: RunnerEvent) => unknown, private readonly leaseMs = 15000) {
    requireId(owner); boundedInteger(concurrency, 1, 8); boundedInteger(leaseMs, 30, 30000);
  }
  private event(task: KnowledgeTask, stage: RunnerEvent['stage']) {
    runOptionalDiagnostic(() => this.telemetry?.({ turnId: task.turnId, channel: task.scope.channel, fence: task.fence, attempt: task.runAttempts, stage, customerDelivery: 'UNCONFIRMED' }));
  }
  get capacity(): number { return this.concurrency; }
  stop(): void { this.stopped = true; for (const controller of this.active.values()) controller.abort(); }
  async recover(scope: KnowledgeScope): Promise<void> {
    const tasks = await knowledgeOperation(()=>this.repository.recover(scope));
    // Bounded one scan; no recursive polling or detached retries.
    for (let i = 0; i < tasks.length; i += this.concurrency) {
      await Promise.all(tasks.slice(i, i + this.concurrency).filter(t => ['ACCEPTED', 'RUNNING', 'VERIFIED'].includes(t.state))
        .map(t => this.run(scope, t.id)));
    }
  }
  async run(scope: KnowledgeScope, taskId: string): Promise<KnowledgeDelivery | null> {
    scope = snapshot(scope);
    const key = JSON.stringify([scope, taskId]);
    if (this.stopped || this.active.has(key) || this.active.size >= this.concurrency) return null;
    const abort = new AbortController(); this.active.set(key, abort);
    const inherited=knowledgeOperationSignal();const signal=AbortSignal.any([abort.signal,...(inherited?[inherited]:[])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing = false; let heartbeatFailure: unknown; let primaryFailure: unknown; let renewal: Promise<void> | undefined;
    let task: KnowledgeTask | null = null;
    try {
      task = await knowledgeOperation(()=>this.repository.claim(scope, taskId, this.owner, this.leaseMs),{signal});
      if (!task || signal.aborted) return null;
      const token: TaskToken = { taskId: task.id, owner: this.owner, fence: task.fence };
      const current = () => {
        if (signal.aborted || Date.now() >= task!.expiresAt) throw new Error('knowledge_runner_stopped');
      };
      current();
      timer = setTimeout(() => abort.abort(), Math.max(1, task.expiresAt - Date.now()));
      heartbeat = setInterval(() => {
        if (renewing || signal.aborted) return;
        renewing = true;
        renewal = knowledgeOperation(()=>this.repository.renew(scope, token, this.leaseMs),{signal}).then(ok => { if (!ok) { if (task) this.event(task, 'lease_lost'); abort.abort(); } },
          error => { heartbeatFailure = error; abort.abort(); }).finally(() => { renewing = false; });
      }, Math.max(10, Math.floor(this.leaseMs / 3)));
      this.event(task, 'claimed');
      if (task.state !== 'VERIFIED') {
        let checkpoint = task.checkpoint;
        const order: Checkpoint[] = ['planning', 'retrieval', 'extraction'];
        const result = await knowledgeOperation(executionSignal=>this.execute(task!, { signal: executionSignal, expiresAt: task!.expiresAt,
          reserveModelAttempt: async () => {
            if(executionSignal.aborted)throw new Error('knowledge_runner_stopped');
            current();
            if (!await knowledgeOperation(()=>this.repository.reserveModelAttempt(scope, token),{signal:executionSignal})) { abort.abort(); throw new Error('knowledge_attempt_not_reserved'); }
            current();
          },
          checkpoint: async stage => {
            if(executionSignal.aborted)throw new Error('knowledge_runner_stopped');
            current();
            // Recovery may recompute earlier stages, without regressing markers.
            if (order.indexOf(stage) <= order.indexOf(checkpoint!)) return;
            if (!await knowledgeOperation(()=>this.repository.checkpoint(scope, token, stage),{signal:executionSignal})) { abort.abort(); throw new Error('knowledge_checkpoint_rejected'); }
            checkpoint = stage; current();
          },
        }),{signal,deadlineAt:knowledgeExecutionDeadline(task),timeoutMs:120000});
        current();
        if (!result) { this.event(task, await knowledgeOperation(()=>this.repository.fail(scope, token),{signal}) ? 'failed' : 'lease_lost'); return null; }
        if (!await knowledgeOperation(()=>this.repository.verified(scope, token, captureVerified(result)),{signal})) return null;
        this.event(task, 'verified');
      }
      current();
      // Repository invokes its trusted live authority dependency anew here,
      // including for recovered VERIFIED tasks. Stored flags grant no authority.
      const delivery = await knowledgeOperation(()=>this.repository.finalize(scope, token),{signal,deadlineAt:task.expiresAt,timeoutMs:15000});
      if (delivery) this.event(task, 'finalized');
      else this.event(task,await knowledgeOperation(()=>this.repository.fail(scope,token),{signal})?'failed':'lease_lost');
      return delivery;
    } catch (error) {
      primaryFailure = error;
      if (task) {
        this.event(task, 'execution_error');
        const token:TaskToken={taskId:task.id,owner:this.owner,fence:task.fence};
        try{await knowledgeOperation(()=>this.repository.interrupt?.(scope,token)??Promise.resolve(false),{independent:true});}catch{}
      }
      throw error;
    }
    finally {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      abort.abort();
      await renewal;
      this.active.delete(key);
      if (task) this.event(task, 'stopped');
      // Repository/heartbeat errors are business errors, not swallowed telemetry.
      if (heartbeatFailure && !primaryFailure) throw heartbeatFailure;
    }
  }
}

/** Resolved only by authenticated server-side provider context. A conversation
 * key, task input, or unvalidated stored artifact cannot be used as a recipient.
 * The future native bridge must enforce channel eligibility and account binding.
 */
export type TrustedDeliveryTarget = Readonly<{ recipient: string; channel: KnowledgeScope['channel']; providerAccount: string; businessId?: number; conversationId?: string; taskId?: string }>;
export interface GuardedKnowledgeTransport {
  authorize: KnowledgeAuthority;
  resolve(task: KnowledgeTask): Promise<TrustedDeliveryTarget | null>;
  eligible(task: KnowledgeTask, target: TrustedDeliveryTarget): Promise<boolean>;
  send(target: TrustedDeliveryTarget, text: string, signal: AbortSignal): Promise<DeliveryOutcome>;
}

/** One bounded delivery attempt. Only definitively-unsent outcomes may retry;
 * factual settlement has its own bounded window and grants no send authority. */
export async function deliverKnowledge(repository: KnowledgeLifecycleRepository, transport: GuardedKnowledgeTransport,
  scope: KnowledgeScope, taskId: string, deliveryId: string, owner: string,
  telemetry?: (event: RunnerEvent) => unknown, stopSignal?: AbortSignal): Promise<Readonly<{ outcome: DeliveryOutcome; settled: boolean; settlementError?: unknown }> | null> {
  requireId(owner); scope=snapshot(scope);
  const started=Date.now();const inherited=knowledgeOperationSignal();
  const signal=AbortSignal.any([...(stopSignal?[stopSignal]:[]),...(inherited?[inherited]:[])]);
  if(signal.aborted)return null;
  let deadlineAt=started+KNOWLEDGE_OPERATION_LIMITS.deliveryMs;
  const step=<T>(work:(signal:AbortSignal)=>PromiseLike<T>)=>knowledgeOperation(work,{signal,deadlineAt,timeoutMs:KNOWLEDGE_OPERATION_LIMITS.deliveryMs});
  let task:KnowledgeTask|null;
  let target:TrustedDeliveryTarget|null;
  let delivery:KnowledgeDelivery|null;
  try {
    task=await step(()=>repository.get(scope,taskId));
    if(!task){
      if(repository.rejectDelivery)await knowledgeOperation(()=>repository.rejectDelivery!(scope,taskId,deliveryId),{independent:true});
      return null;
    }
    deadlineAt=Math.min(deadlineAt,task.expiresAt);
    const reject=async()=>{if(repository.rejectDelivery)await knowledgeOperation(()=>repository.rejectDelivery!(scope,taskId,deliveryId),{independent:true});return null;};
    const resolved=await step(()=>transport.resolve(task));
    target=resolved?Object.freeze({recipient:resolved.recipient,channel:resolved.channel,providerAccount:resolved.providerAccount,
    ...(resolved.businessId!==undefined?{businessId:resolved.businessId}:{}),...(resolved.conversationId?{conversationId:resolved.conversationId}:{}),
    ...(resolved.taskId?{taskId:resolved.taskId}:{})}):null;
    if(!target || typeof target.recipient!=='string' || !/^[^\u0000-\u0020\u007f]{1,256}$/u.test(target.recipient) || target.channel!==scope.channel || target.providerAccount!==scope.providerAccount ||
    !await step(()=>transport.eligible(task,target)) || !await step(()=>transport.authorize(task,'send')))return reject();
    delivery=await step(()=>repository.claimDelivery(scope,deliveryId,owner,15000));
    if(!delivery || delivery.taskId!==taskId || !delivery.lease)return null;
    deadlineAt=Math.min(deadlineAt,delivery.lease.until);
  } catch(error) {
    try { await knowledgeOperation(()=>repository.deferDelivery?.(scope,taskId,deliveryId)??Promise.resolve(false),{independent:true}); } catch {}
    throw error;
  }
  const token={deliveryId,owner,fence:delivery.fence};
  const event=(stage:RunnerEvent['stage'],outcome?:DeliveryOutcome['kind'],settled?:boolean)=>runOptionalDiagnostic(()=>telemetry?.({
    turnId:task.turnId,channel:scope.channel,fence:delivery.fence,attempt:delivery.attempts,stage,
    ...(outcome?{outcome}:{}),...(settled!==undefined?{settled}:{}),durationMs:Date.now()-started,customerDelivery:'UNCONFIRMED'}));
  const settle=async(outcome:DeliveryOutcome)=>{
    try {
      const settled=await knowledgeOperation(()=>repository.settleDelivery(scope,token,outcome),{independent:true});
      event(settled?'settled':'settlement_failed',outcome.kind,settled);return {outcome,settled};
    } catch(settlementError){event('settlement_failed',outcome.kind,false);return {outcome,settled:false,settlementError};}
  };
  if(delivery.kind!=='final' || !task.result || delivery.text!==task.result.text){
    await settle({kind:'DEFINITIVELY_UNSENT',retryable:false});return null;
  }
  let entered=false;
  try {
    if(signal.aborted || Date.now()>=deadlineAt || !await step(()=>transport.eligible(task,target)) || !await step(()=>transport.authorize(task,'send')) ||
      signal.aborted || Date.now()>=deadlineAt)return settle({kind:'DEFINITIVELY_UNSENT',retryable:false});
    event('send_claimed');entered=true;
    const outcome=await knowledgeOperation(sendSignal=>transport.send(target!,delivery!.text,sendSignal),{signal,deadlineAt,timeoutMs:KNOWLEDGE_OPERATION_LIMITS.deliveryMs,factualResult:true});
    event('transport_result',outcome.kind);return settle(outcome);
  } catch(error){
    // Timeouts/exceptions after transport entry can follow remote acceptance.
    // No retry is authorized, including when settlement itself is unavailable.
    await settle(entered?{kind:'AMBIGUOUS'}:{kind:'DEFINITIVELY_UNSENT',retryable:false});
    throw error;
  }
}
