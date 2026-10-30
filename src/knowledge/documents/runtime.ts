import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getBackendSupabaseConfiguration } from '../../auth/backend-supabase';
import { DocumentService } from './service';
import { SourceIndexCoordinator, SupabaseSourceIndexRepository, type SourceIndexLimits } from './indexing';
import type { KnowledgeBackfillEmbeddingIdentity } from '../embedding-backfill';
import type { EmbeddingProvider } from '../../ai/embeddings';
export type DocumentIndexingOptions = { provider: Pick<EmbeddingProvider, 'embedDocuments'>;
  identity: KnowledgeBackfillEmbeddingIdentity; limits: SourceIndexLimits; shutdownSignal: AbortSignal };
export function documentServiceForClient(client: SupabaseClient,
  indexing?: DocumentIndexingOptions): DocumentService {
  let coordinator: SourceIndexCoordinator | undefined;
  if (indexing) {
    try {
      if (!indexing.shutdownSignal || typeof indexing.shutdownSignal.addEventListener !== 'function') throw new Error('knowledge_index_shutdown_required');
      coordinator = new SourceIndexCoordinator(new SupabaseSourceIndexRepository(client), indexing.provider, indexing.identity, indexing.limits, indexing.shutdownSignal);
    }
    catch { console.warn('[KnowledgeDocuments] indexing disabled: invalid configuration'); }
  }
  return new DocumentService(client, undefined, coordinator);
}
// Deliberately opt-in: the unchanged server call supplies no indexing authorization.
export function createDocumentRuntime(indexing?: DocumentIndexingOptions): DocumentService {
  if (process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED !== 'true') return new DocumentService(null);
  try {
    const { url, serviceRoleKey } = getBackendSupabaseConfiguration();
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init: RequestInit = {}) => fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) },
    });
    return documentServiceForClient(client, indexing);
  } catch { return new DocumentService(null); }
}
export function startDocumentRecovery(service: DocumentService): () => void {
  if (process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED !== 'true') return () => service.stopIndexing();
  let running = false; let stopped = false; let lastIndexIssue = '';
  const recover = async () => {
    if (running || stopped) return; running = true;
    try {
      const results = await Promise.allSettled([service.recover(), service.recoverIndex()]);
      if (results[0].status === 'rejected') console.warn('[KnowledgeDocuments] recovery unavailable');
      if (results[1].status === 'rejected') console.warn('[KnowledgeDocuments] index recovery unavailable');
      if (results[1].status === 'fulfilled' && Array.isArray(results[1].value)) {
        const failures: Record<string, number> = {};
        for (const item of results[1].value) if (item?.status === 'failed') {
          const code = ['storage','stale','configuration','credentials','invalid_vectors','provider_failure','provider_timeout','cancelled','scope'].includes(item.reason) ? item.reason : 'unknown';
          failures[code] = (failures[code] || 0) + 1;
        }
        const signature = JSON.stringify(failures);
        if (Object.keys(failures).length && signature !== lastIndexIssue) console.warn('[KnowledgeDocuments] index recovery incomplete', failures);
        lastIndexIssue = signature;
      }
    }
    finally { running = false; }
  };
  const timer = setInterval(recover, 10_000); timer.unref(); void recover();
  return () => { stopped = true; clearInterval(timer); service.stopIndexing(); };
}
