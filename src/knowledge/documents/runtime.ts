import { createClient } from '@supabase/supabase-js';
import { getBackendSupabaseConfiguration } from '../../auth/backend-supabase';
import { DocumentService } from './service';
export function createDocumentRuntime(): DocumentService {
  if (process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED !== 'true') return new DocumentService(null);
  try {
    const { url, serviceRoleKey } = getBackendSupabaseConfiguration();
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init: RequestInit = {}) => fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) },
    });
    return new DocumentService(client);
  } catch { return new DocumentService(null); }
}
export function startDocumentRecovery(service: DocumentService): () => void {
  if (process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED !== 'true') return () => {};
  let running = false; let stopped = false;
  const recover = async () => {
    if (running || stopped) return; running = true;
    try { await service.recover(); }
    catch { console.warn('[KnowledgeDocuments] recovery unavailable'); }
    finally { running = false; }
  };
  const timer = setInterval(recover, 10_000); timer.unref(); void recover();
  return () => { stopped = true; clearInterval(timer); };
}
