import type { EmbeddingRequestOptions, EmbeddingVector } from '../ai/embeddings';
import type { KnowledgeSearchMatch } from '../../knowledge';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity } from './embedding-backfill';
import type { CandidateFallback, RetrievalObservation } from './candidate-retrieval';
export const PERSISTENT_SEARCH_RPC = 'search_knowledge_index_snapshot_v1';
export type IndexSourceProof = {
  sourceId: string; businessId: number; sourceStatus: string; ready: boolean; revision: string | null;
  state: string; indexStatus: 'ready'|'incomplete'|'missing'|'blocked'|'unknown'; expectedChunks: number; compatibleChunks: number; generation: string | null; vectorDigest: string | null;
};
export type IndexCoverage = {
  businessId: number; complete: boolean; sourceCount: number; textReadySourceCount: number; readySourceCount: number;
  sources: IndexSourceProof[]; inventoryToken: string; identity: typeof identity; canonicalVersion: 1;
};
export type IndexMatchProof = { source: IndexSourceProof; inventoryToken: string;
  /** Backend stamp: candidate publication also requires the same full inventory. */
  candidatePolicy?: CandidateFallback['policy'] };
export type PersistentSearchResult = { coverage: IndexCoverage; matches: KnowledgeSearchMatch[][] };
export type SemanticStatus = { status: 'complete' | 'incomplete'; coverage: IndexCoverage } |
  { status: 'unavailable'; reason: 'timeout' | 'storage_unavailable' | 'invalid_vector' | 'source_changed' };
export type KnowledgeSemanticOptions = EmbeddingRequestOptions & { observe?: <T>(promise: Promise<T>) => Promise<T>; onStatus?: (status: SemanticStatus) => void;
  candidateFallback?: CandidateFallback; onRetrieval?: (event: RetrievalObservation) => void };
export type PersistentSearchRequest = {
  businessId: number; embeddings: EmbeddingVector[]; limit: number; minSimilarity: number;
  excludedChunks: { source_id: string; content: string }[];
};
export function compatibleQuery(e: EmbeddingVector): boolean {
  return !!e && e.provider === identity.provider && e.model === identity.model && e.dimensions === identity.dimensions &&
    e.version === identity.version && Array.isArray(e.values) && e.values.length === 768 &&
    e.values.every(x => typeof x === 'number' && Number.isFinite(x)) && e.values.some(x => x !== 0);
}
const digest = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s);
export function assertPersistentRequest(r:PersistentSearchRequest):void {
  if(!Number.isSafeInteger(r.businessId)||r.businessId<=0||!Array.isArray(r.embeddings)||r.embeddings.length>3||r.embeddings.some(e=>!compatibleQuery(e))||
    !Number.isInteger(r.limit)||r.limit<1||r.limit>10||!Number.isFinite(r.minSimilarity)||r.minSimilarity < -1||r.minSimilarity>1||
    !Array.isArray(r.excludedChunks)||r.excludedChunks.length>10000||r.excludedChunks.some(e=>!e||typeof e.source_id!=='string'||typeof e.content!=='string'))
    throw new Error('knowledge_index_invalid_request');
}
export function sameSourceProof(a: IndexSourceProof, b: IndexSourceProof): boolean {
  return !!a && !!b && a.ready && b.ready && a.businessId === b.businessId && a.sourceId === b.sourceId &&
    a.revision === b.revision && a.generation === b.generation && a.vectorDigest === b.vectorDigest &&
    a.expectedChunks === b.expectedChunks && a.compatibleChunks === b.compatibleChunks && a.sourceStatus === b.sourceStatus;
}
/** Reject malformed/unscoped adapter output before any evidence enters the shared pipeline. */
export function parsePersistentSearch(data: any, request: PersistentSearchRequest): PersistentSearchResult {
  const c = data?.coverage;
  const invalid = () => { throw new Error('knowledge_index_invalid_response'); };
  if (!c || c.businessId !== request.businessId || c.canonicalVersion !== 1 || JSON.stringify(c.identity && [c.identity.provider,c.identity.model,c.identity.dimensions,c.identity.version]) !==
      JSON.stringify([identity.provider,identity.model,identity.dimensions,identity.version]) ||
      !digest(c.inventoryToken) || typeof c.complete !== 'boolean' || !Array.isArray(c.sources)) invalid();
  const sources = new Map<string,IndexSourceProof>();
  for (const p of c.sources) {
    if (!p || typeof p.sourceId !== 'string' || !p.sourceId || sources.has(p.sourceId) || p.businessId !== request.businessId ||
      typeof p.ready !== 'boolean' || !['pending','processing','ready','failed','disabled','error'].includes(p.sourceStatus) ||
      !['unknown','pending','indexing','retry_wait','ready','blocked','failed'].includes(p.state) ||
      !['ready','incomplete','missing','blocked','unknown'].includes(p.indexStatus) || (p.ready !== (p.indexStatus==='ready')) ||
      !Number.isSafeInteger(p.expectedChunks) || p.expectedChunks < 0 || !Number.isSafeInteger(p.compatibleChunks) ||
      p.compatibleChunks < 0 || p.compatibleChunks > p.expectedChunks ||
      (p.ready && (p.sourceStatus !== 'ready' || !digest(p.revision) || !digest(p.vectorDigest) ||
        typeof p.generation !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(p.generation) || p.expectedChunks < 1 || p.expectedChunks > 200 || p.compatibleChunks !== p.expectedChunks))) invalid();
    sources.set(p.sourceId,p);
  }
  const ready = c.sources.filter((s: IndexSourceProof) => s.ready).length;
  const textReady = c.sources.filter((s: IndexSourceProof) => s.sourceStatus === 'ready').length;
  if (c.sourceCount !== sources.size || c.readySourceCount !== ready || c.textReadySourceCount !== textReady ||
    c.complete !== (textReady > 0 && ready === textReady) || !Array.isArray(data.matches) || data.matches.length !== request.embeddings.length) invalid();
  for (const set of data.matches) {
    if (!Array.isArray(set) || set.length > request.limit) invalid();
    for (const m of set) {
      const p = sources.get(m?.sourceId);
      if (!p?.ready || m.businessId !== request.businessId || typeof m.text !== 'string' || !m.text.trim() ||
        !Number.isFinite(m.score) || m.score < request.minSimilarity || m.score > 1.000001 ||
        !m.indexProof || m.indexProof.inventoryToken !== c.inventoryToken || !sameSourceProof(p,m.indexProof.source) ||
        request.excludedChunks.some(e=>e.source_id===m.sourceId&&e.content===m.text)) invalid();
    }
  }
  return data;
}
export function semanticStatus(options: KnowledgeSemanticOptions | undefined, status: SemanticStatus) {
  try { options?.onStatus?.(status); } catch { /* Diagnostics never grant evidence authority. */ }
}
/** One shared allowance for query embedding, DB reads and canonical validation. No retries. */
export async function semanticBudget<T>(options: KnowledgeSemanticOptions | undefined, run: (options: KnowledgeSemanticOptions) => Promise<T>): Promise<T> {
  options?.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener('abort',abort,{once:true});
  const timeout = Number.isFinite(options?.timeoutMs) ? Math.max(1,Math.min(2500,options!.timeoutMs!)) : 2500;
  const timer = setTimeout(()=>controller.abort(new Error('knowledge_semantic_timeout')),timeout);
  try { return await abortable(run({...options,signal:controller.signal,timeoutMs:timeout}),controller.signal); }
  finally { clearTimeout(timer);options?.signal?.removeEventListener('abort',abort); }
}
export async function abortable<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const pending=Promise.resolve(promise);
  if(signal?.aborted){void pending.catch(()=>{});signal.throwIfAborted();}
  let abort: (()=>void) | undefined;
  try { return await Promise.race([pending, new Promise<never>((_,reject)=>{
    if (signal) { abort=()=>reject(new Error('knowledge_semantic_timeout'));signal.addEventListener('abort',abort,{once:true}); }
  })]); } finally { if(abort)signal?.removeEventListener('abort',abort); }
}
