import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getBackendSupabaseConfiguration } from '../../auth/backend-supabase';
import { DocumentService } from './service';
import { SourceIndexCoordinator, SupabaseSourceIndexRepository, type SourceIndexLimits } from './indexing';
import type { KnowledgeBackfillEmbeddingIdentity } from '../embedding-backfill';
import type { EmbeddingProvider } from '../../ai/embeddings';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY } from '../embedding-backfill';
import { createSourceIndexProvider } from './indexing-provider';
export type DocumentIndexingOptions = { provider: Pick<EmbeddingProvider, 'embedDocuments'>;
  identity: KnowledgeBackfillEmbeddingIdentity; limits: SourceIndexLimits; shutdownSignal: AbortSignal; newDocumentsSince?: string };

/** Explicit operator opt-in, with no key access or provider call at construction.
 * Keep a fixed activation timestamp across restarts. It must be approved BEFORE
 * new uploads; historical initialization uses a separate exact-source job.
 * Limits are per process, not a durable account-wide monetary authorization.
 */
export function newDocumentIndexingOptions(raw: string | undefined, shutdownSignal: AbortSignal): DocumentIndexingOptions | undefined {
  if (!raw) return undefined;
  const p=JSON.parse(raw);
  if (!p || p.version!=='new-documents-v1' || typeof p.notBefore!=='string' ||
      !Number.isFinite(Date.parse(p.notBefore)) || new Date(p.notBefore).toISOString()!==p.notBefore ||
      !Array.isArray(p.allowedBusinessIds) || !p.allowedBusinessIds.length || p.allowedBusinessIds.length>10 ||
      p.allowedBusinessIds.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0) ||
      ![[p.maxSources,50],[p.maxRequests,100],[p.maxInputChars,1_000_000],[p.maxInputBytes,4_000_000]]
        .every(([value,max])=>Number.isSafeInteger(value)&&value>0&&value<=max)) throw new Error('knowledge_index_invalid_configuration');
  return {identity:OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,provider:createSourceIndexProvider(OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,()=>undefined),
    limits:{allowedBusinessIds:[...p.allowedBusinessIds],maxSources:p.maxSources,maxRequests:p.maxRequests,maxInputChars:p.maxInputChars,maxInputBytes:p.maxInputBytes},
    shutdownSignal,newDocumentsSince:p.notBefore};
}
export function documentServiceForClient(client: SupabaseClient,
  indexing?: DocumentIndexingOptions): DocumentService {
  let coordinator: SourceIndexCoordinator | undefined;
  if (indexing) {
    try {
      if (!indexing.shutdownSignal || typeof indexing.shutdownSignal.addEventListener !== 'function') throw new Error('knowledge_index_shutdown_required');
      coordinator = new SourceIndexCoordinator(new SupabaseSourceIndexRepository(client,indexing.newDocumentsSince), indexing.provider, indexing.identity, indexing.limits, indexing.shutdownSignal);
    }
    catch { console.warn('[KnowledgeDocuments] indexing disabled: invalid configuration'); }
  }
  return new DocumentService(client, undefined, coordinator);
}
// Default OFF. The existing server call can install approved new-upload indexing;
// absent/invalid configuration keeps text processing available without embedding.
export function createDocumentRuntime(indexing?: DocumentIndexingOptions): DocumentService {
  if (process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED !== 'true') return new DocumentService(null);
  try {
    const { url, serviceRoleKey } = getBackendSupabaseConfiguration();
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init: RequestInit = {}) => fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) },
    });
    if (!indexing && process.env.ODINLINK_DOCUMENT_INDEXING_POLICY) {
      const shutdown=new AbortController();
      try {
        indexing=newDocumentIndexingOptions(process.env.ODINLINK_DOCUMENT_INDEXING_POLICY,shutdown.signal);
        const stop=()=>shutdown.abort();
        process.once('SIGTERM',stop);process.once('SIGINT',stop);
      } catch { console.warn('[KnowledgeDocuments] indexing disabled: invalid configuration'); }
    }
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
