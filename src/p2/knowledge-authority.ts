import { knowledgeDatabaseRead, knowledgeOperation } from './knowledge-operation';
import { knowledgeSourceRevision, SupabaseKnowledgeStorage, type KnowledgeService } from '../../knowledge';
import { captureVerified, resultDigest, type KnowledgeAuthority, type KnowledgeTask } from './knowledge-lifecycle';
import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';

/** Trusted backend dependency, never passed in a webhook or stored task input.
 * The implementation must use current authenticated provider ownership and real
 * channel eligibility, not a boolean copied out of a task/artifact. */
export interface KnowledgeProviderAuthority {
  canonicalConversationKey(task: KnowledgeTask): Promise<string | null>;
  eligible(task: KnowledgeTask): Promise<boolean>;
}
export async function knowledgeTurnCurrent(db: KnowledgeDatabase, task: KnowledgeTask,
  provider: KnowledgeProviderAuthority): Promise<boolean> {
  const scope = task.scope;
  const { data, error } = await knowledgeDatabaseRead(db.from('odin_conversations')
    .select('conversation_key,knowledge_channel,knowledge_account,knowledge_sequence')
    .eq('business_id', scope.businessId).eq('id', scope.conversationId).maybeSingle());
  if (error) throw new Error('knowledge_authority_read_failed');
  const key = await provider.canonicalConversationKey(task);
  return Boolean(data && key && key === data.conversation_key && data.knowledge_channel === scope.channel &&
    data.knowledge_account === scope.providerAccount && Number(data.knowledge_sequence) === task.sequence);
}

export function createKnowledgeAuthority(db: KnowledgeDatabase, sources: Pick<KnowledgeService, 'list'>,
  provider: KnowledgeProviderAuthority): KnowledgeAuthority {
  return async (task, phase) => {
    if (!task.result || task.resultDigest !== resultDigest(captureVerified(task.result))) return false;
    // Stored verification flags alone grant nothing: live scope, watermark,
    // source-wide revisions/readiness and provider ownership must all match.
    const scope = task.scope;
    const read = () => knowledgeTurnCurrent(db, task, provider);
    if (!await read()) return false;
    if (!await provider.eligible(task)) return false;
    const live = await knowledgeOperation(()=>sources.list(scope.businessId));
    for (const source of task.result.sources) {
      const matches = live.filter(s => s.id === source.id && s.businessId === scope.businessId && s.status === 'ready');
      if (matches.length !== 1 || knowledgeSourceRevision(matches[0]) !== source.revision) return false;
    }
    // Source checks follow provider I/O; do not reuse a preflight source snapshot.
    // Recheck after async evidence/provider reads. SQL then atomically rechecks
    // current watermark, lease, expiry and digest-bound receipt freshness.
    return await read();
  };
}

/** Production composition: source reads go directly to the tenant-scoped
 * Supabase repository, with no in-memory fallback on database errors. */
export function createDatabaseKnowledgeAuthority(db: KnowledgeDatabase, provider: KnowledgeProviderAuthority): KnowledgeAuthority {
  return createKnowledgeAuthority(db, new SupabaseKnowledgeStorage(db), provider);
}
