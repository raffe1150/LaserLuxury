import {
  boundedInteger, captureInput, captureVerified, requireId, requireProviderId, snapshot, validateScope,
  type Acceptance, type Checkpoint, type DeliveryOutcome, type DeliveryToken, type KnowledgeAuthority,
  type KnowledgeDelivery, type KnowledgeInput, type KnowledgeLifecycleRepository, type KnowledgeScope,
  type KnowledgeTask, type TaskToken,
} from './knowledge-lifecycle';

/** Service-side client only. No credentials, application clients or automatic activation. */
export type KnowledgeDatabase = { from(table: string): any; rpc(name: string, args: Record<string, unknown>): any };
const date = (v: unknown): number => {
  const n = Date.parse(String(v));
  if (!Number.isFinite(n)) throw new Error('knowledge_invalid_database_time');
  return n;
};
const uuid = (v: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(v)) throw new Error('knowledge_invalid_uuid');
};

/** All mutations use the installed atomic RPC, never a read/update emulation.
 * canonicalKey must come from authenticated provider context, not task input.
 * authority is a server composition dependency, not a parameter to finalize/send.
 */
export class SupabaseKnowledgeLifecycleRepository implements KnowledgeLifecycleRepository {
  constructor(protected readonly db: KnowledgeDatabase,
    protected readonly canonicalKey: (scope: KnowledgeScope) => Promise<string>,
    private readonly authority: KnowledgeAuthority) {}

  protected async result(operation: PromiseLike<any>): Promise<any> {
    const { data, error } = await operation;
    // Do not surface database exception text: it may include stored input.
    if (error) throw new Error('knowledge_repository_operation_failed');
    return data;
  }
  protected async scope(s: KnowledgeScope): Promise<boolean> {
    s = snapshot(s);
    validateScope(s); uuid(s.conversationId);
    const row = await this.result(this.db.from('odin_conversations').select('conversation_key,knowledge_channel,knowledge_account')
      .eq('business_id', s.businessId).eq('id', s.conversationId).maybeSingle());
    return Boolean(row && row.conversation_key === await this.canonicalKey(s) &&
      (row.knowledge_channel === null || row.knowledge_channel === s.channel && row.knowledge_account === s.providerAccount));
  }
  protected async task(s: KnowledgeScope, row: any): Promise<KnowledgeTask | null> {
    if (!row) return null;
    if (row.business_id !== s.businessId || row.conversation_id !== s.conversationId ||
      row.knowledge_channel !== s.channel || row.knowledge_account !== s.providerAccount || row.task_type !== 'knowledge_async_v1')
      throw new Error('knowledge_database_scope_mismatch');
    const inbox = await this.result(this.db.from('odin_inbox').select('provider_event_id')
      .eq('business_id', s.businessId).eq('conversation_id', s.conversationId).eq('channel', s.channel)
      .eq('provider_scope', s.providerAccount).eq('id', row.knowledge_inbox_id).maybeSingle());
    if (!inbox) throw new Error('knowledge_database_ingress_missing');
    return snapshot({ id: row.id, turnId: row.knowledge_turn_id, eventId: inbox.provider_event_id, scope: s,
      sequence: Number(row.knowledge_sequence), acceptedAt: date(row.knowledge_accepted_at), expiresAt: date(row.knowledge_expires_at),
      input: captureInput(row.payload), state: row.knowledge_state, revision: Number(row.task_revision), fence: Number(row.knowledge_fence),
      lease: row.knowledge_owner && row.knowledge_lease_until ? { owner: row.knowledge_owner, fence: Number(row.knowledge_fence), until: date(row.knowledge_lease_until) } : null,
      runAttempts: row.knowledge_run_attempts, maxRunAttempts: row.knowledge_max_runs,
      modelAttempts: row.knowledge_model_attempts, maxModelAttempts: row.knowledge_max_models,
      checkpoint: row.knowledge_checkpoint, result: row.knowledge_result ? captureVerified(row.knowledge_result) : null,
      resultDigest: row.knowledge_result_digest });
  }
  private delivery(row: any): KnowledgeDelivery | null {
    return row ? snapshot({ id: row.id, taskId: row.knowledge_task_id, kind: row.knowledge_kind,
      key: row.delivery_key, text: row.artifact.text, state: row.knowledge_state, fence: Number(row.knowledge_fence),
      lease: row.knowledge_owner && row.knowledge_lease_until ? { owner: row.knowledge_owner, fence: Number(row.knowledge_fence), until: date(row.knowledge_lease_until) } : null,
      attempts: row.attempt_count, maxAttempts: row.knowledge_max_attempts,
      providerMessageId: row.provider_message_id, customerDelivery: 'UNCONFIRMED' }) : null;
  }
  private async transition(s: KnowledgeScope, taskId: string, command: string, args: Record<string, unknown> = {}): Promise<any> {
    s = snapshot(s);
    uuid(taskId);
    if (!await this.scope(s)) return null;
    return this.result(this.db.rpc('odin_transition_knowledge_v1', { p_business: s.businessId, p_conversation: s.conversationId,
      p_task: taskId, p_channel: s.channel, p_account: s.providerAccount, p_command: command, p_args: args }));
  }
  private token(t: TaskToken | DeliveryToken) { requireId(t.owner); boundedInteger(t.fence, 1, Number.MAX_SAFE_INTEGER); return { owner: t.owner, fence: t.fence }; }
  private async receipt(s: KnowledgeScope, id: string, phase: 'finalize' | 'send') {
    const task = await this.get(s, id);
    if (!task || !await this.authority(task, phase)) return null;
    return { allowed: true, businessId: s.businessId, conversationId: s.conversationId, channel: s.channel,
      account: s.providerAccount, taskId: id, turnId: task.turnId, sequence: task.sequence,
      resultDigest: task.resultDigest, phase, checkedAt: new Date().toISOString() };
  }
  async accept(s: KnowledgeScope, eventId: string, input?: KnowledgeInput,
    limits: { executionMs?: number; maxRunAttempts?: number; maxModelAttempts?: number } = {}): Promise<Acceptance> {
    s = snapshot(s);
    requireProviderId(eventId);
    input = input ? captureInput(input) : undefined; limits = snapshot(limits);
    if (!await this.scope(s)) throw new Error('knowledge_conversation_scope_mismatch');
    const data = await this.result(this.db.rpc('odin_accept_knowledge_turn_v1', {
      p_business: s.businessId, p_conversation: s.conversationId, p_channel: s.channel, p_account: s.providerAccount,
      p_event: eventId, p_input: input ?? null,
      p_execution_ms: boundedInteger(limits.executionMs ?? 40000, 1000, 120000),
      p_max_runs: boundedInteger(limits.maxRunAttempts ?? 3, 1, 5), p_max_models: boundedInteger(limits.maxModelAttempts ?? 4, 1, 8),
    }));
    const i = data.inbox;
    return snapshot({ identity: { turnId: i.knowledge_turn_id, eventId: i.provider_event_id, sequence: Number(i.knowledge_sequence),
      acceptedAt: date(i.knowledge_accepted_at), expiresAt: date(i.knowledge_expires_at), taskId: data.task?.id ?? null },
      task: await this.task(s, data.task), inserted: data.inserted });
  }
  async get(s: KnowledgeScope, id: string): Promise<KnowledgeTask | null> {
    s = snapshot(s);
    uuid(id); if (!await this.scope(s)) return null;
    return this.task(s, await this.result(this.db.from('odin_tasks').select('*').eq('business_id', s.businessId)
      .eq('conversation_id', s.conversationId).eq('knowledge_channel', s.channel).eq('knowledge_account', s.providerAccount)
      .eq('id', id).eq('task_type', 'knowledge_async_v1').not('knowledge_turn_id', 'is', null).maybeSingle()));
  }
  async claim(s: KnowledgeScope, id: string, owner: string, leaseMs: number) {
    s = snapshot(s);
    requireId(owner); boundedInteger(leaseMs, 1, 30000);
    return this.task(s, await this.transition(s, id, 'claim', { owner, leaseMs }));
  }
  async renew(s: KnowledgeScope, t: TaskToken, leaseMs: number) { boundedInteger(leaseMs, 1, 30000); return Boolean(await this.transition(s, t.taskId, 'renew', { ...this.token(t), leaseMs })); }
  async reserveModelAttempt(s: KnowledgeScope, t: TaskToken) { return Boolean(await this.transition(s, t.taskId, 'model_attempt', this.token(t))); }
  async checkpoint(s: KnowledgeScope, t: TaskToken, checkpoint: Checkpoint) { return Boolean(await this.transition(s, t.taskId, 'checkpoint', { ...this.token(t), checkpoint })); }
  async verified(s: KnowledgeScope, t: TaskToken, result: Parameters<KnowledgeLifecycleRepository['verified']>[2]) {
    return Boolean(await this.transition(s, t.taskId, 'verified', { ...this.token(t), result: captureVerified(result) }));
  }
  async fail(s: KnowledgeScope, t: TaskToken) { return Boolean(await this.transition(s, t.taskId, 'fail', this.token(t))); }
  async finalize(s: KnowledgeScope, t: TaskToken) {
    s = snapshot(s);
    t = snapshot(t);
    const authority = await this.receipt(s, t.taskId, 'finalize');
    return authority ? this.delivery(await this.transition(s, t.taskId, 'finalize', { ...this.token(t), authority })) : null;
  }
  async enqueueProgress(s: KnowledgeScope, id: string, text: string) {
    s = snapshot(s);
    if (!text.trim() || text.length > 240) throw new Error('knowledge_progress_bounds');
    return this.delivery(await this.transition(s, id, 'progress', { text }));
  }
  private async deliveryTask(s: KnowledgeScope, id: string): Promise<string | null> {
    s = snapshot(s);
    uuid(id); if (!await this.scope(s)) return null;
    const row = await this.result(this.db.from('odin_outbox').select('knowledge_task_id').eq('business_id', s.businessId)
      .eq('conversation_id', s.conversationId).eq('channel', s.channel).eq('id', id).maybeSingle());
    return row?.knowledge_task_id ?? null;
  }
  async claimDelivery(s: KnowledgeScope, id: string, owner: string, leaseMs: number) {
    s = snapshot(s);
    requireId(owner); boundedInteger(leaseMs, 1, 30000);
    const taskId = await this.deliveryTask(s, id); if (!taskId) return null;
    const authority = await this.receipt(s, taskId, 'send');
    return authority ? this.delivery(await this.transition(s, taskId, 'claim_delivery', { owner, leaseMs, deliveryId: id, authority })) : null;
  }
  async settleDelivery(s: KnowledgeScope, t: DeliveryToken, outcome: DeliveryOutcome) {
    s = snapshot(s);
    if (outcome.kind === 'API_ACCEPTED') requireProviderId(outcome.providerMessageId);
    t = snapshot(t); outcome = snapshot(outcome);
    const taskId = await this.deliveryTask(s, t.deliveryId);
    return taskId ? Boolean(await this.transition(s, taskId, 'settle_delivery', { ...this.token(t), deliveryId: t.deliveryId,
      outcome: outcome.kind, ...(outcome.kind === 'API_ACCEPTED' ? { providerMessageId: outcome.providerMessageId } :
        outcome.kind === 'DEFINITIVELY_UNSENT' ? { retryable: outcome.retryable } : {}) })) : false;
  }
  /** Bounded privileged discovery. Returned metadata is not execution authority;
   * every subsequent claim still checks canonical scope and the database fence. */
  async discoverWork(limit = 16): Promise<readonly { scope: KnowledgeScope; taskId: string }[]> {
    boundedInteger(limit, 1, 100);
    const rows = await this.result(this.db.from('odin_tasks')
      .select('id,business_id,conversation_id,knowledge_channel,knowledge_account')
      .eq('task_type', 'knowledge_async_v1').not('knowledge_turn_id', 'is', null).in('knowledge_state', ['ACCEPTED', 'RUNNING', 'VERIFIED'])
      .order('knowledge_expires_at', { ascending: true }).limit(limit));
    return snapshot(rows.map((row: any) => ({ taskId: row.id, scope: { businessId: row.business_id,
      conversationId: row.conversation_id, channel: row.knowledge_channel, providerAccount: row.knowledge_account } })));
  }
  async discoverDeliveries(limit = 16): Promise<readonly { scope: KnowledgeScope; taskId: string; deliveryId: string }[]> {
    boundedInteger(limit, 1, 100);
    const rows = await this.result(this.db.from('odin_outbox').select('id,business_id,conversation_id,channel,knowledge_task_id')
      .eq('knowledge_kind', 'final').in('knowledge_state', ['PENDING', 'FAILED', 'SENDING']).order('created_at', { ascending: true }).limit(limit));
    const work: { scope: KnowledgeScope; taskId: string; deliveryId: string }[] = [];
    for (const row of rows) {
      if (!row.knowledge_task_id) continue;
      const task = await this.result(this.db.from('odin_tasks').select('knowledge_account').eq('business_id', row.business_id)
        .eq('conversation_id', row.conversation_id).eq('knowledge_channel', row.channel).eq('id', row.knowledge_task_id).eq('task_type', 'knowledge_async_v1').not('knowledge_turn_id', 'is', null).maybeSingle());
      if (task) work.push({ deliveryId: row.id, taskId: row.knowledge_task_id, scope: { businessId: row.business_id,
        conversationId: row.conversation_id, channel: row.channel, providerAccount: task.knowledge_account } });
    }
    return snapshot(work);
  }
  async recover(s: KnowledgeScope): Promise<readonly KnowledgeTask[]> {
    s = snapshot(s);
    if (!await this.scope(s)) return [];
    const rows = await this.result(this.db.from('odin_tasks').select('id').eq('business_id', s.businessId)
      .eq('conversation_id', s.conversationId).eq('knowledge_channel', s.channel).eq('knowledge_account', s.providerAccount)
      .eq('task_type', 'knowledge_async_v1').not('knowledge_turn_id', 'is', null).in('knowledge_state', ['ACCEPTED', 'RUNNING', 'VERIFIED'])
      .order('knowledge_accepted_at', { ascending: true }).limit(100));
    const tasks: KnowledgeTask[] = [];
    for (const row of rows) { const task = await this.task(s, await this.transition(s, row.id, 'recover')); if (task) tasks.push(task); }
    // Delivery recovery is independent: expired SENDING must become UNCERTAIN,
    // including when its task is already FINALIZED or superseded.
    const deliveries = await this.result(this.db.from('odin_outbox').select('knowledge_task_id')
      .eq('business_id', s.businessId).eq('conversation_id', s.conversationId).eq('channel', s.channel)
      .eq('knowledge_state', 'SENDING').order('knowledge_lease_until', { ascending: true }).limit(100));
    for (const id of new Set<string>(deliveries.map((d: any) => d.knowledge_task_id))) await this.transition(s, id, 'recover');
    return snapshot(tasks);
  }
}
