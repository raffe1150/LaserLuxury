import { boundedInteger, captureInput, requireProviderId, snapshot,
  type Acceptance, type KnowledgeInput, type KnowledgeScope } from './knowledge-lifecycle';
import { captureNativeOrder, type NativeKnowledgeOrder, type OrderedAdmission } from './native-knowledge-order';
import { SupabaseKnowledgeLifecycleRepository } from './supabase-knowledge-lifecycle-repository';

/** Explicit opt-in repository. Never falls back to v1 when the new RPC is absent.
 * No native entry/runtime instantiates this class yet. No startup side effects.
 * Claim/renew/verification/finalization/delivery retain the existing Slice 2 core.
 */
export class SupabaseOrderedKnowledgeRepository extends SupabaseKnowledgeLifecycleRepository {
  protected override readonly lifecycleV2:boolean=true;
  async accept(_scope: KnowledgeScope, _eventId: string, _input?: KnowledgeInput,
    _limits?: { executionMs?: number; maxRunAttempts?: number; maxModelAttempts?: number }): Promise<Acceptance> {
    throw new Error('knowledge_native_order_required');
  }
  async acceptOrdered(scope: KnowledgeScope, eventId: string, order: NativeKnowledgeOrder | null,
    input?: KnowledgeInput, limits: { executionMs?: number; maxRunAttempts?: number; maxModelAttempts?: number } = {}): Promise<OrderedAdmission> {
    scope = snapshot(scope); requireProviderId(eventId);
    order = captureNativeOrder(scope.channel, order); input = input ? captureInput(input) : undefined; limits = snapshot(limits);
    if (!await this.scope(scope)) throw new Error('knowledge_conversation_scope_mismatch');
    const data = await this.result(this.db.rpc('odin_accept_knowledge_turn_v2', {
      p_business: scope.businessId, p_conversation: scope.conversationId, p_channel: scope.channel,
      p_account: scope.providerAccount, p_event: eventId, p_key: await this.canonicalKey(scope), p_order: order, p_input: input ?? null,
      p_execution_ms: boundedInteger(limits.executionMs ?? 40000, 1000, 120000),
      p_max_runs: boundedInteger(limits.maxRunAttempts ?? 3, 1, 5), p_max_models: boundedInteger(limits.maxModelAttempts ?? 4, 1, 8),
    }));
    return this.decodeOrdered(scope, data);
  }
  async intake(scope: KnowledgeScope, eventId: string, order: NativeKnowledgeOrder | null,
    command: 'begin' | 'prepare' | 'reconcile' | 'finish' | 'legacy', owner: string, context = '', input?: KnowledgeInput, executionMs = 20000) {
    scope = snapshot(scope); requireProviderId(eventId); order = captureNativeOrder(scope.channel, order);
    if (!await this.scope(scope)) throw new Error('knowledge_conversation_scope_mismatch');
    const data = await this.result(this.db.rpc('odin_native_intake_v1', {
      p_business: scope.businessId, p_conversation: scope.conversationId, p_channel: scope.channel,
      p_account: scope.providerAccount, p_event: eventId, p_key: await this.canonicalKey(scope), p_order: order,
      p_command: command, p_owner: owner, p_context: context, p_input: input ? captureInput(input) : null,
      p_execution_ms: boundedInteger(executionMs, 1000, 120000),
    }));
    if (!data || !['ROUTING','PREPARED','ATTACHED','TERMINAL'].includes(data.intakeState)) throw new Error('knowledge_intake_response');
    return snapshot({ result: await this.decodeOrdered(scope, data), state: data.intakeState as 'ROUTING'|'PREPARED'|'ATTACHED'|'TERMINAL',
      reason: data.intakeReason as string | null, owner: data.intakeOwner as string | undefined });
  }
  async recoverIntakes(): Promise<void> {
    await this.result(this.db.rpc('odin_recover_native_intakes_v1', {p_limit:16}));
  }
  protected async decodeOrdered(scope: KnowledgeScope, data: any): Promise<OrderedAdmission> {
    if (!data || !['ACCEPTED', 'DUPLICATE', 'STALE', 'AMBIGUOUS', 'BLOCKED'].includes(data.disposition) ||
      typeof data.mayAttach !== 'boolean' ||
      (data.mayAttach && (!data.inbox || !['ACCEPTED', 'DUPLICATE'].includes(data.disposition))) ||
      (['STALE', 'BLOCKED'].includes(data.disposition) && (data.inbox || data.task))) throw new Error('knowledge_invalid_ordered_response');
    const i = data.inbox;
    const time = (v: unknown) => { const n = Date.parse(String(v)); if (!Number.isFinite(n)) throw new Error('knowledge_invalid_database_time'); return n; };
    const acceptance: Acceptance | null = i ? snapshot({ identity: { turnId: i.knowledge_turn_id, eventId: i.provider_event_id,
      sequence: Number(i.knowledge_sequence), acceptedAt: time(i.knowledge_accepted_at), expiresAt: time(i.knowledge_expires_at), taskId: data.task?.id ?? null },
      task: await this.task(scope, data.task), inserted: data.inserted }) : null;
    return snapshot({ disposition: data.disposition, mayAttach: data.mayAttach, acceptance });
  }
}
