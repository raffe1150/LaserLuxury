import { isDeepStrictEqual } from 'node:util';
import { chunkKnowledgeContent } from '../../../knowledge';
import type { EmbeddingProvider } from '../../ai/embeddings';
import { documentChunks } from './service';
import { runKnowledgeEmbeddingBackfill, SupabaseKnowledgeEmbeddingBackfillRepository,
  KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY, OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,
  type KnowledgeBackfillEmbeddingIdentity, type KnowledgeBackfillSourceSnapshot,
  type KnowledgeBackfillPayloadChunk } from '../embedding-backfill';

export type IndexScope = { businessId: number; sourceId: string };
type SourceRow = { id: string; business_id: number; type: string; title: string; status: string; content: string; metadata: Record<string, any>; created_at?: string };
type IndexClaim = { admitted: boolean; reason?: string; lease_token: string; content_revision: string;
  identity: KnowledgeBackfillEmbeddingIdentity; canonical_version: number; snapshot_token: string;
  chunks: any[]; job_deadline: string };
type Prepared = { source: SourceRow; snapshot: KnowledgeBackfillSourceSnapshot };
type Failure = 'storage' | 'stale' | 'configuration' | 'credentials' | 'invalid_vectors' | 'provider_failure' | 'provider_timeout' | 'cancelled';
class IndexFault extends Error { constructor(readonly code: Failure) { super(code); } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Both RPC requests and embedding work are bounded even if a test/transport ignores cancellation. */
async function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(signal.reason); signal.addEventListener('abort', rejectAbort, { once: true }); });
  try { return await Promise.race([Promise.resolve(promise), aborted]); }
  finally { signal.removeEventListener('abort', rejectAbort); }
}

/** Supabase transport only; every read/write remains tenant/source-scoped. */
export class SupabaseSourceIndexRepository {
  constructor(private readonly client: any, private readonly newDocumentsSince?: string) {
    if (newDocumentsSince !== undefined && (!Number.isFinite(Date.parse(newDocumentsSince)) || new Date(newDocumentsSince).toISOString() !== newDocumentsSince))
      throw new IndexFault('configuration');
  }
  private inUploadScope(row: SourceRow): boolean {
    return !this.newDocumentsSince || row.type === 'document' &&
      Number.isFinite(Date.parse(row.created_at || '')) && Date.parse(row.created_at!) >= Date.parse(this.newDocumentsSince);
  }
  private async request(query: any, signal: AbortSignal): Promise<any> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      const result: any = await abortable(typeof query.abortSignal === 'function' ? query.abortSignal(bounded) : query, bounded);
      if (result.error) {
        const message = String(result.error.message || '');
        if (/stale_claim|source_changed|snapshot_changed|scope_mismatch|source_not_ready|completion_expired/u.test(message)) throw new IndexFault('stale');
        if (/invalid_|incomplete_|existing_vectors|content_changed|duplicate_chunk/u.test(message)) throw new IndexFault('configuration');
        throw new IndexFault('storage');
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw new IndexFault(signal.reason?.code === 'provider_timeout' ? 'provider_timeout' : 'cancelled');
      if (error instanceof IndexFault) throw error;
      throw new IndexFault('storage');
    }
  }
  private async rpc(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    return (await this.request(this.client.rpc(name, args), signal)).data;
  }
  async scan(businessId: number, after: string | null, signal: AbortSignal): Promise<SourceRow[]> {
    let q = this.client.from('knowledge_sources').select('id,business_id,type,title,status,content,metadata,created_at')
      .eq('business_id', businessId).eq('status', 'ready').order('id').limit(20);
    if (this.newDocumentsSince) q = q.eq('type', 'document').gte('created_at', this.newDocumentsSince);
    if (after) q = q.gt('id', after);
    const rows = (await this.request(q, signal)).data;
    if (!Array.isArray(rows) || rows.length > 20 || rows.some((r, i) => !this.inUploadScope(r) || Number(r.business_id) !== businessId || r.status !== 'ready' || !uuid.test(r.id) ||
      (after && r.id <= after) || (i > 0 && r.id <= rows[i - 1].id))) throw new IndexFault('configuration');
    return rows;
  }
  async eligible(scope: IndexScope, identity: KnowledgeBackfillEmbeddingIdentity, signal: AbortSignal): Promise<boolean> {
    const args = { p_business_id: scope.businessId, p_source_id: scope.sourceId, p_identity: identity, p_canonical_version: 1 };
    const [r, result] = await Promise.all([this.rpc('knowledge_source_index_readiness_v1', args, signal),
      this.request(this.client.from('knowledge_source_index_state').select('business_id,source_id,target_revision')
        .eq('business_id', scope.businessId).eq('source_id', scope.sourceId).maybeSingle(), signal)]);
    const st = result.data;
    if (!r || typeof r.ready !== 'boolean' || (st && (Number(st.business_id) !== scope.businessId || st.source_id !== scope.sourceId))) throw new IndexFault('configuration');
    if (r.ready || !r.content_revision || r.lease_active) return false;
    if (st?.target_revision === r.content_revision && (['blocked', 'failed'].includes(r.state) ||
      (['indexing', 'retry_wait'].includes(r.state) && !r.retry_eligible))) return false;
    return true;
  }
  async prepare(scope: IndexScope, signal: AbortSignal): Promise<Prepared> {
    // Reuse the existing guarded-snapshot parser/validation contract, not search results.
    const backfill = new SupabaseKnowledgeEmbeddingBackfillRepository({ rpc: async (name: string, args: any) => ({ data: await this.rpc(name, args, signal), error: null }) });
    // Fence the separate source read between identical full database snapshots.
    // Parallel source/chunk reads could otherwise falsely block a legitimate edit.
    const snapshot = await backfill.readReadySourceForWrite(scope.businessId, scope.sourceId);
    const result = await this.request(this.client.from('knowledge_sources').select('id,business_id,type,title,status,content,metadata,created_at')
      .eq('business_id', scope.businessId).eq('id', scope.sourceId).eq('status', 'ready').maybeSingle(), signal);
    const after = await backfill.readReadySourceForWrite(scope.businessId, scope.sourceId);
    const source = result.data;
    if (!source || !snapshot || !after || after.snapshotToken !== snapshot.snapshotToken ||
      source.id !== scope.sourceId || Number(source.business_id) !== scope.businessId || source.status !== 'ready' || !this.inUploadScope(source)) throw new IndexFault('stale');
    return { source, snapshot };
  }
  claim(scope: IndexScope, identity: KnowledgeBackfillEmbeddingIdentity, signal: AbortSignal): Promise<IndexClaim> {
    return this.rpc('claim_knowledge_source_index_v1', { p_business_id: scope.businessId, p_source_id: scope.sourceId, p_identity: identity, p_canonical_version: 1 }, signal);
  }
  async renew(scope: IndexScope, claim: IndexClaim, signal: AbortSignal) {
    if (await this.rpc('transition_knowledge_source_index_v1', { p_business_id: scope.businessId, p_source_id: scope.sourceId,
      p_token: claim.lease_token, p_action: 'renew' }, signal) !== true) throw new IndexFault('stale');
  }
  async fail(scope: IndexScope, claim: IndexClaim, code: Failure) {
    if (!['provider_failure', 'provider_timeout', 'invalid_vectors', 'credentials', 'configuration'].includes(code)) return;
    await this.rpc('transition_knowledge_source_index_v1', { p_business_id: scope.businessId, p_source_id: scope.sourceId,
      p_token: claim.lease_token, p_action: 'fail', p_error: code }, AbortSignal.timeout(30_000));
  }
  async complete(scope: IndexScope, claim: IndexClaim, chunks: KnowledgeBackfillPayloadChunk[], signal: AbortSignal) {
    const args = { p_business_id: scope.businessId, p_source_id: scope.sourceId, p_token: claim.lease_token,
      p_revision: claim.content_revision, p_identity: claim.identity, p_canonical_version: 1,
      p_snapshot_token: claim.snapshot_token, p_chunks: chunks };
    // One bounded SQL acknowledgement retry; never repeat embedding generation.
    let result: any;
    try { result = await this.rpc('complete_knowledge_source_index_v1', args, signal); }
    catch (error) {
      if (!(error instanceof IndexFault) || error.code !== 'storage' || signal.aborted) throw error;
      result = await this.rpc('complete_knowledge_source_index_v1', args, signal);
    }
    if (result?.ready !== true) throw new IndexFault('storage');
  }
}

export type SourceIndexLimits = {
  allowedBusinessIds: readonly number[];
  maxSources: number;
  maxRequests: number;
  maxInputChars: number;
  maxInputBytes: number;
};
export type IndexOutcome = { status: 'ready' | 'skipped' | 'failed'; reason: string };

/** Compare actual canonical bytes/provenance, never sentence similarity or lexical recall. */
function canonical(prepared: Prepared, scope: IndexScope) {
  const { source, snapshot } = prepared;
  if (snapshot.businessId !== scope.businessId || snapshot.sourceId !== scope.sourceId || snapshot.status !== 'ready' ||
    !snapshot.chunks.length || snapshot.chunks.length > 200 || source.content.length > 100_000 || Buffer.byteLength(source.content, 'utf8') > 400_000) throw new IndexFault('configuration');
  let expected: { chunk_index: number; content: string; metadata: Record<string, unknown> }[];
  if (source.type === 'document') {
    const segments = source.metadata?.segments;
    if (!Array.isArray(segments) || !segments.length || segments.length > 200) throw new IndexFault('configuration');
    let end = 0;
    const sections = segments.map((s: any) => {
      if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < end || s.end <= s.start || s.end > source.content.length) throw new IndexFault('configuration');
      if (s.page !== undefined && (!Number.isInteger(s.page) || s.page < 1 || s.page > 100)) throw new IndexFault('configuration');
      if ([s.sheet, s.section].some(v => v !== undefined && (typeof v !== 'string' || v.length > 200))) throw new IndexFault('configuration');
      end = s.end;
      return { text: source.content.slice(s.start, s.end), ...(s.page !== undefined ? { page: s.page } : {}),
        ...(s.sheet !== undefined ? { sheet: s.sheet } : {}), ...(s.section !== undefined ? { section: s.section } : {}) };
    });
    const rebuilt = documentChunks(sections, source.title);
    if (rebuilt.content !== source.content || !isDeepStrictEqual(rebuilt.metadata.segments, segments)) throw new IndexFault('configuration');
    expected = (rebuilt.chunks as typeof expected).map((c, index) => {
      const metadata = { ...c.metadata };
      // Older stored document chunks may omit presentation-only fields. Preserve
      // that immutable representation; every actual page/sheet/section stays exact.
      const stored = snapshot.chunks[index]?.metadata;
      for (const key of ['filename', 'untrusted']) if (stored && !(key in stored)) delete metadata[key];
      return { ...c, metadata };
    });
  } else if (['text', 'faq', 'pdf', 'website'].includes(source.type)) {
    expected = chunkKnowledgeContent(source.content).map(c => ({ chunk_index: c.chunkIndex, content: c.content, metadata: c.metadata }));
  } else throw new IndexFault('configuration');
  if (!isDeepStrictEqual(expected, snapshot.chunks.map(c => ({ chunk_index: c.chunkIndex, content: c.content, metadata: c.metadata }))) ||
    snapshot.chunks.some(c => c.businessId !== scope.businessId || c.sourceId !== scope.sourceId || c.embedding !== null)) throw new IndexFault('configuration');
}

/** Explicitly installed by an operator-supplied runtime option; existing startup stays disabled. */
export class SourceIndexCoordinator {
  private readonly shutdown = new AbortController();
  private readonly lingering = new Set<Promise<unknown>>();
  private busy = false;
  private tenant = 0;
  private cursors = new Map<number, string | null>();
  private readonly limits: SourceIndexLimits;
  private readonly identity: KnowledgeBackfillEmbeddingIdentity;
  private readonly onHostStop = () => this.stop();
  private counts = { sources: 0, reservedRequests: 0, attemptedRequests: 0, reservedChars: 0, reservedBytes: 0 };
  constructor(private readonly repository: SupabaseSourceIndexRepository,
    private readonly provider: Pick<EmbeddingProvider, 'embedDocuments'>,
    identity: KnowledgeBackfillEmbeddingIdentity, limits: SourceIndexLimits, private readonly hostSignal?: AbortSignal) {
    if (![KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY, OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY].some(i => isDeepStrictEqual(i, identity)) ||
      !limits.allowedBusinessIds.length || limits.allowedBusinessIds.length > 10 ||
      limits.allowedBusinessIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      ![[limits.maxSources, 50], [limits.maxRequests, 100], [limits.maxInputChars, 1_000_000], [limits.maxInputBytes, 4_000_000]]
        .every(([n, max]) => Number.isSafeInteger(n) && n > 0 && n <= max)) throw new Error('knowledge_index_invalid_configuration');
    this.identity = Object.freeze({ ...identity });
    this.limits = Object.freeze({ ...limits, allowedBusinessIds: Object.freeze([...new Set(limits.allowedBusinessIds)]) });
    if (hostSignal?.aborted) this.stop();
    else hostSignal?.addEventListener('abort', this.onHostStop, { once: true });
  }
  stop() { this.hostSignal?.removeEventListener('abort', this.onHostStop); this.shutdown.abort(new IndexFault('cancelled')); }
  usage() { return { ...this.counts }; }
  private available() { return !this.shutdown.signal.aborted && !this.busy && !this.lingering.size &&
    this.counts.sources < this.limits.maxSources && this.counts.reservedRequests < this.limits.maxRequests; }
  async recover(): Promise<IndexOutcome[]> {
    if (!this.available()) return [];
    this.busy = true;
    try {
      const id = this.limits.allowedBusinessIds[this.tenant++ % this.limits.allowedBusinessIds.length];
      const rows = await this.repository.scan(id, this.cursors.get(id) || null, this.shutdown.signal);
      if (!rows.length) this.cursors.set(id, null);
      const outcomes: IndexOutcome[] = [];
      for (const row of rows) {
        this.cursors.set(id, row.id);
        const outcome = await this.work({ businessId: id, sourceId: row.id }); outcomes.push(outcome);
        // One generation per recovery tick; skip already-ready/blocked/backoff rows fairly.
        if (outcome.status !== 'skipped' || outcome.reason === 'budget_exhausted') break;
      }
      return outcomes;
    } finally { this.busy = false; }
  }
  async indexSource(scope: IndexScope): Promise<IndexOutcome> {
    if (!this.available()) return { status: 'skipped', reason: 'stopped_busy_or_budget' };
    this.busy = true;
    try { return await this.work(scope); } finally { this.busy = false; }
  }
  private fits(snapshot: KnowledgeBackfillSourceSnapshot) {
    const chars = snapshot.chunks.reduce((n, c) => n + c.content.length, 0);
    const bytes = snapshot.chunks.reduce((n, c) => n + Buffer.byteLength(c.content, 'utf8'), 0);
    const requests = Math.ceil(snapshot.chunks.length / 20);
    return { chars, bytes, requests, fits: this.counts.sources < this.limits.maxSources && requests > 0 &&
      this.counts.reservedRequests + requests <= this.limits.maxRequests &&
      this.counts.reservedChars + chars <= this.limits.maxInputChars && this.counts.reservedBytes + bytes <= this.limits.maxInputBytes };
  }
  private async work(scope: IndexScope): Promise<IndexOutcome> {
    if (!this.limits.allowedBusinessIds.includes(scope.businessId) || !uuid.test(scope.sourceId)) return { status: 'failed', reason: 'scope' };
    let claim: IndexClaim | undefined;
    let failure: Failure | undefined;
    let jobTimer: ReturnType<typeof setTimeout> | undefined;
    const job = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, job.signal]);
    try {
      if (!await this.repository.eligible(scope, this.identity, signal)) return { status: 'skipped', reason: 'ineligible' };
      let prepared = await this.repository.prepare(scope, signal);
      if (!this.fits(prepared.snapshot).fits) return { status: 'skipped', reason: 'budget_exhausted' };
      claim = await this.repository.claim(scope, this.identity, signal);
      if (typeof claim?.admitted !== 'boolean') throw new IndexFault('configuration');
      if (!claim.admitted) return { status: 'skipped', reason: claim.reason || 'not_admitted' };
      this.counts.sources++;
      if (!uuid.test(claim.lease_token) || !/^[a-f0-9]{64}$/u.test(claim.content_revision) ||
        !isDeepStrictEqual(claim.identity, this.identity) || claim.canonical_version !== 1 || !Number.isFinite(Date.parse(claim.job_deadline))) throw new IndexFault('configuration');
      jobTimer = setTimeout(() => job.abort(new IndexFault('provider_timeout')), Math.max(1, Math.min(300_000, Date.parse(claim.job_deadline) - Date.now())));
      if (claim.snapshot_token !== prepared.snapshot.snapshotToken) prepared = await this.repository.prepare(scope, signal);
      if (claim.snapshot_token !== prepared.snapshot.snapshotToken || !Array.isArray(claim.chunks) || claim.chunks.some(c => c.embedding !== null) || !isDeepStrictEqual(claim.chunks.map(c => [c.id,c.business_id,c.source_id,c.chunk_index,c.content,c.metadata]),
        prepared.snapshot.chunks.map(c => [c.id,c.businessId,c.sourceId,c.chunkIndex,c.content,c.metadata]))) throw new IndexFault('stale');
      canonical(prepared, scope);
      const budget = this.fits(prepared.snapshot);
      // The just-admitted source already consumed one source slot.
      if (this.counts.sources > this.limits.maxSources || this.counts.reservedRequests + budget.requests > this.limits.maxRequests ||
        this.counts.reservedChars + budget.chars > this.limits.maxInputChars || this.counts.reservedBytes + budget.bytes > this.limits.maxInputBytes) return { status: 'skipped', reason: 'budget_exhausted' };
      this.counts.reservedRequests += budget.requests; this.counts.reservedChars += budget.chars; this.counts.reservedBytes += budget.bytes;
      const boundedProvider: EmbeddingProvider = {
        embedQuery: async () => { throw new Error('indexing_only'); },
        embedDocuments: async texts => {
          try {
            signal.throwIfAborted();
            if (!texts.length || texts.length > 20) throw new IndexFault('configuration');
            if (this.counts.attemptedRequests >= this.counts.reservedRequests || this.counts.attemptedRequests >= this.limits.maxRequests) throw new IndexFault('configuration');
            await this.repository.renew(scope, claim!, signal);
          } catch (error) {
            failure = this.shutdown.signal.aborted ? 'cancelled' : job.signal.aborted ? 'provider_timeout' : error instanceof IndexFault ? error.code : 'storage';
            throw error;
          }
          const request = new AbortController(); const requestSignal = AbortSignal.any([signal, request.signal]);
          const timer = setTimeout(() => request.abort(new IndexFault('provider_timeout')), 20_000);
          this.counts.attemptedRequests++;
          const pending = Promise.resolve().then(() => { requestSignal.throwIfAborted(); return this.provider.embedDocuments(texts, { signal: requestSignal, timeoutMs: 20_000 }); });
          this.lingering.add(pending); void pending.finally(() => this.lingering.delete(pending)).catch(() => {});
          try {
            const vectors = await abortable(pending, requestSignal);
            if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(v => !v ||
              !isDeepStrictEqual({ provider: v.provider, model: v.model, dimensions: v.dimensions, version: v.version }, this.identity) ||
              !Array.isArray(v.values) || v.values.length !== 768 || v.values.some(x => !Number.isFinite(x)) || !v.values.some(x => x !== 0))) throw new IndexFault('invalid_vectors');
            return vectors;
          } catch (error) {
            failure = this.shutdown.signal.aborted ? 'cancelled' : requestSignal.aborted ? 'provider_timeout' : error instanceof IndexFault ? error.code :
              [401,403].includes(Number((error as any)?.status)) ? 'credentials' : [400,404].includes(Number((error as any)?.status)) ? 'configuration' : 'provider_failure';
            throw error;
          } finally { clearTimeout(timer); request.abort(); }
        },
      };
      await runKnowledgeEmbeddingBackfill({ ...scope, write: true, identity: this.identity, embeddingProvider: boundedProvider,
        repository: {
          inspectReadySource: async () => { throw new Error('write_only'); },
          readReadySourceForWrite: async () => prepared.snapshot,
          backfillIfUnchanged: async params => {
            try {
              const current = await this.repository.prepare(scope, signal);
              if (current.snapshot.snapshotToken !== claim!.snapshot_token) throw new IndexFault('stale');
              canonical(current, scope);
              await this.repository.renew(scope, claim!, signal);
              await this.repository.complete(scope, claim!, params.chunks, signal);
              return params.expectedUpdateCount;
            } catch (error) { failure = error instanceof IndexFault ? error.code : 'storage'; throw error; }
          },
        } });
      return { status: 'ready', reason: 'committed' };
    } catch (error) {
      const code = failure || (error instanceof IndexFault ? error.code : this.shutdown.signal.aborted ? 'cancelled' : 'storage');
      if (claim?.admitted) { try { await this.repository.fail(scope, claim, code); } catch { /* Expiry/backoff recovers storage loss without a new provider request here. */ } }
      return { status: 'failed', reason: code };
    } finally { if (jobTimer) clearTimeout(jobTimer); job.abort(); }
  }
}
