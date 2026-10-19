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
  stage: 'claimed' | 'execution_error' | 'lease_lost' | 'failed' | 'verified' | 'finalized' | 'stopped' | 'send_claimed' | 'transport_result' | 'settlement_failed';
  outcome?: DeliveryOutcome['kind']; customerDelivery: 'UNCONFIRMED' }>;

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
    const tasks = await this.repository.recover(scope);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing = false; let heartbeatFailure: unknown; let primaryFailure: unknown; let renewal: Promise<void> | undefined;
    let task: KnowledgeTask | null = null;
    try {
      task = await this.repository.claim(scope, taskId, this.owner, this.leaseMs);
      if (!task || abort.signal.aborted) return null;
      const token: TaskToken = { taskId: task.id, owner: this.owner, fence: task.fence };
      const current = () => {
        if (abort.signal.aborted || Date.now() >= task!.expiresAt) throw new Error('knowledge_runner_stopped');
      };
      current();
      timer = setTimeout(() => abort.abort(), Math.max(1, task.expiresAt - Date.now()));
      heartbeat = setInterval(() => {
        if (renewing || abort.signal.aborted) return;
        renewing = true;
        renewal = this.repository.renew(scope, token, this.leaseMs).then(ok => { if (!ok) { if (task) this.event(task, 'lease_lost'); abort.abort(); } },
          error => { heartbeatFailure = error; abort.abort(); }).finally(() => { renewing = false; });
      }, Math.max(10, Math.floor(this.leaseMs / 3)));
      this.event(task, 'claimed');
      if (task.state !== 'VERIFIED') {
        let checkpoint = task.checkpoint;
        const order: Checkpoint[] = ['planning', 'retrieval', 'extraction'];
        const result = await this.execute(task, { signal: abort.signal, expiresAt: task.expiresAt,
          reserveModelAttempt: async () => {
            current();
            if (!await this.repository.reserveModelAttempt(scope, token)) { abort.abort(); throw new Error('knowledge_attempt_not_reserved'); }
            current();
          },
          checkpoint: async stage => {
            current();
            // Recovery may recompute earlier stages, without regressing markers.
            if (order.indexOf(stage) <= order.indexOf(checkpoint!)) return;
            if (!await this.repository.checkpoint(scope, token, stage)) { abort.abort(); throw new Error('knowledge_checkpoint_rejected'); }
            checkpoint = stage; current();
          },
        });
        current();
        if (!result) { this.event(task, await this.repository.fail(scope, token) ? 'failed' : 'lease_lost'); return null; }
        if (!await this.repository.verified(scope, token, captureVerified(result))) return null;
        this.event(task, 'verified');
      }
      current();
      // Repository invokes its trusted live authority dependency anew here,
      // including for recovered VERIFIED tasks. Stored flags grant no authority.
      const delivery = await this.repository.finalize(scope, token);
      if (delivery) this.event(task, 'finalized');
      return delivery;
    } catch (error) { primaryFailure = error; if (task) this.event(task, 'execution_error'); throw error; }
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

/** Not attached to native adapters. Never retries a remote send in this call. */
export async function deliverKnowledge(repository: KnowledgeLifecycleRepository, transport: GuardedKnowledgeTransport,
  scope: KnowledgeScope, taskId: string, deliveryId: string, owner: string,
  telemetry?: (event: RunnerEvent) => unknown, stopSignal?: AbortSignal): Promise<Readonly<{ outcome: DeliveryOutcome; settled: boolean; settlementError?: unknown }> | null> {
  requireId(owner); scope = snapshot(scope);
  if (stopSignal?.aborted) return null;
  const task = await repository.get(scope, taskId); if (!task) return null;
  const resolved = await transport.resolve(task);
  const target = resolved ? Object.freeze({ recipient: resolved.recipient, channel: resolved.channel,
    providerAccount: resolved.providerAccount, ...(resolved.businessId !== undefined ? {businessId:resolved.businessId} : {}),
    ...(resolved.conversationId ? {conversationId:resolved.conversationId} : {}), ...(resolved.taskId ? {taskId:resolved.taskId} : {}) }) : null;
  if (!target || typeof target.recipient !== 'string' || !/^[^\u0000-\u0020\u007f]{1,256}$/u.test(target.recipient) || target.channel !== scope.channel || target.providerAccount !== scope.providerAccount ||
    !await transport.eligible(task, target) || !await transport.authorize(task, 'send')) return null;
  const delivery = await repository.claimDelivery(scope, deliveryId, owner, 15000);
  if (!delivery || delivery.taskId !== taskId || !delivery.lease) return null;
  const event = (stage: RunnerEvent['stage'], outcome?: DeliveryOutcome['kind']) => runOptionalDiagnostic(() => telemetry?.({
    turnId: task.turnId, channel: scope.channel, fence: delivery.fence, attempt: delivery.attempts, stage, ...(outcome ? { outcome } : {}), customerDelivery: 'UNCONFIRMED' }));
  const token = { deliveryId, owner, fence: delivery.fence };
  // Slice 2 sends only the exact verified final text. Progress remains deferred;
  // an outbox artifact is never independent factual-publication authority.
  if (delivery.kind !== 'final' || !task.result || delivery.text !== task.result.text) {
    await repository.settleDelivery(scope, token, { kind: 'DEFINITIVELY_UNSENT', retryable: false });
    return null;
  }
  const abort = new AbortController();
  const signal = stopSignal ? AbortSignal.any([abort.signal,stopSignal]) : abort.signal;
  const timer = setTimeout(() => abort.abort(), Math.max(1, Math.min(delivery.lease.until, task.expiresAt) - Date.now()));
  try {
    // Reauthorize after the claim, immediately before entering transport.
    // claimDelivery separately performs live source/turn authorization.
    if (signal.aborted || Date.now() >= task.expiresAt || !await transport.eligible(task, target) || !await transport.authorize(task, 'send') ||
      signal.aborted || Date.now() >= delivery.lease.until || Date.now() >= task.expiresAt) {
      const outcome: DeliveryOutcome = { kind: 'DEFINITIVELY_UNSENT', retryable: false };
      return { outcome, settled: await repository.settleDelivery(scope, token, outcome) };
    }
    event('send_claimed');
    let outcome: DeliveryOutcome;
    try { outcome = await transport.send(target, delivery.text, signal); }
    catch (error) {
      // Unclassified exceptions may have occurred AFTER provider acceptance.
      // Persist ambiguity if possible; preserve the original transport error.
      try { await repository.settleDelivery(scope, token, { kind: 'AMBIGUOUS' }); } catch { event('settlement_failed'); }
      throw error;
    }
    event('transport_result', outcome.kind);
    try { return { outcome, settled: await repository.settleDelivery(scope, token, outcome) }; }
    catch (settlementError) {
      // Preserve the actual provider result. Expired SENDING will quarantine on
      // recovery; settlement failure must never cause an automatic resend.
      event('settlement_failed'); return { outcome, settled: false, settlementError };
    }
  } finally { clearTimeout(timer); abort.abort(); }
}
