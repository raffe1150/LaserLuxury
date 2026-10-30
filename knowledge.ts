import type { EmbeddingProvider, EmbeddingVector } from "./src/ai/embeddings";
import crypto from "crypto";
import { PERSISTENT_SEARCH_RPC, assertPersistentRequest, compatibleQuery, parsePersistentSearch, sameSourceProof, semanticBudget, semanticStatus, abortable,
  type IndexMatchProof, type IndexCoverage, type PersistentSearchRequest, type PersistentSearchResult, type KnowledgeSemanticOptions } from './src/knowledge/persistent-search';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY } from './src/knowledge/embedding-backfill';
import { CompatibleSemanticIndex, semanticCorpusFingerprint, type SemanticChunk } from "./src/knowledge/semantic-index";
import { confirmedTextLanguage, normalizeSemanticQuery, explicitlyWrongWorkflow, MAX_SEMANTIC_QUERIES, type SourceLanguage } from './src/knowledge/semantic-queries';
import { CANDIDATE_RETRIEVAL_POLICY } from './src/knowledge/candidate-retrieval';

export const KNOWLEDGE_SOURCE_TYPES = ["faq", "pdf", "website", "text", "document"] as const;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];
export type KnowledgeSourceStatus = "pending" | "processing" | "ready" | "failed" | "deleted" | "disabled" | "error";
export type KnowledgeSourceMetadata = Record<string, unknown>;

export interface KnowledgeSource {
  id: string;
  businessId: number;
  type: KnowledgeSourceType;
  title: string;
  status: KnowledgeSourceStatus;
  content: string;
  createdAt: string;
  updatedAt: string;
  metadata: KnowledgeSourceMetadata;
}

export interface CreateKnowledgeSourceInput {
  businessId: number;
  type: KnowledgeSourceType;
  title: string;
  content?: string;
  status?: KnowledgeSourceStatus;
  metadata?: KnowledgeSourceMetadata;
}

export interface KnowledgeSearchMatch {
  sourceId: string;
  businessId: number;
  /** Backend proof only; independently revalidated at publication. */
  indexProof?: IndexMatchProof;
  score?: number;
  text?: string;
  metadata?: KnowledgeSourceMetadata;
}
type KnowledgeValidationOptions = { signal?: AbortSignal; strictSources?: boolean; captureRevision?: boolean;
  onRejected?: (sourceId:string,reason:'SOURCE_SCOPE'|'SOURCE_MISSING_OR_UNAUTHORIZED'|'SOURCE_NOT_READY'|'SOURCE_REVISION'|'SOURCE_CHUNK')=>void };

/** Operation counts and wall-clock durations only; never query/source contents. */
export type LexicalRetrievalMetrics = {
  path: 'legacy' | 'batch'; queryCount: number; storageSearchCalls: number; searchFailures: number;
  sourceListReads: number; sourceListFailures: number; validationFailures: number; documentReconstructions: number;
  lexicalSearchMs: number; sourceListMs: number; validationMs: number; documentReconstructionMs: number; totalMs: number;
};
type LexicalDiagnostic = (metrics: Readonly<LexicalRetrievalMetrics>) => void;
const lexicalMetrics = (path: LexicalRetrievalMetrics['path'], queryCount: number): LexicalRetrievalMetrics => ({
  path, queryCount, storageSearchCalls: 0, searchFailures: 0, sourceListReads: 0, sourceListFailures: 0,
  validationFailures: 0, documentReconstructions: 0, lexicalSearchMs: 0, sourceListMs: 0, validationMs: 0, documentReconstructionMs: 0, totalMs: 0,
});
function reportLexicalMetrics(metrics: LexicalRetrievalMetrics | undefined, started: number, diagnostic?: LexicalDiagnostic) {
  if (!metrics || !diagnostic) return;
  metrics.totalMs = performance.now() - started;
  try { diagnostic(Object.freeze({ ...metrics })); } catch { /* Diagnostics cannot change retrieval authority. */ }
}

export interface KnowledgeChunkInput {
  chunkIndex: number;
  content: string;
  metadata?: KnowledgeSourceMetadata;
  embedding?: number[];
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingVersion?: number;
}

export interface KnowledgeStorage {
  initialize(): Promise<void>;
  list(businessId: number, options?: KnowledgeSemanticOptions): Promise<KnowledgeSource[]>;
  /** Complete ready-source inventory or null. Ordinary list() does not attest
   * exhaustiveness. A conservative whole-inventory bound is allowed; backend
   * caps and partial pages must never imply completeness. */
  listReadyComplete?(businessId: number, maxSources: number, options?: KnowledgeSemanticOptions): Promise<KnowledgeSource[] | null>;
  create(source: KnowledgeSource): Promise<KnowledgeSource>;
  replaceChunks(
    businessId: number,
    sourceId: string,
    chunks: KnowledgeChunkInput[]
  ): Promise<void>;
  delete(businessId: number, id: string): Promise<boolean>;
  search(
    businessId: number,
    query: string,
    limit?: number,
    options?: KnowledgeSemanticOptions
  ): Promise<KnowledgeSearchMatch[]>;
  persistentSemanticSearch?(request: PersistentSearchRequest, options?: KnowledgeSemanticOptions): Promise<PersistentSearchResult>;
  semanticSearch?(
    businessId: number,
    embedding: EmbeddingVector,
    limit?: number,
    minSimilarity?: number
  ): Promise<KnowledgeSearchMatch[]>;
}

export class InMemoryKnowledgeStorage implements KnowledgeStorage {
  private readonly sources = new Map<string, KnowledgeSource>();
  private readonly chunks = new Map<string, KnowledgeChunkInput[]>();
  private readonly completedIndexes = new Map<string,{revision:string;generation:string;vectorDigest:string}>();

  /** Explicit off-request publication for the local store/test double. No implicit adoption. */
  indexSnapshot(businessId:number,sourceId:string):string | null {
    const source=this.sources.get(sourceId);
    if(!source||source.businessId!==businessId||source.status!=='ready')return null;
    return crypto.createHash('sha256').update(JSON.stringify([source.id,source.businessId,source.type,source.title,source.status,
      source.content,source.metadata,(this.chunks.get(sourceId)||[]).map(c=>[c.chunkIndex,c.content,c.metadata])])).digest('hex');
  }
  completeSemanticIndex(businessId:number,sourceId:string,snapshot:string,embeddings:EmbeddingVector[]):void {
    const chunks=this.chunks.get(sourceId)||[];
    if(this.indexSnapshot(businessId,sourceId)!==snapshot||!snapshot||!chunks.length||chunks.length>200||
      chunks.some((c,i)=>c.chunkIndex!==i||c.embedding!=null)||embeddings.length!==chunks.length||embeddings.some(e=>!compatibleQuery(e)))
      throw new Error('knowledge_index_invalid_completion');
    chunks.forEach((c,i)=>Object.assign(c,{embedding:[...embeddings[i].values],embeddingProvider:embeddings[i].provider,
      embeddingModel:embeddings[i].model,embeddingDimensions:embeddings[i].dimensions,embeddingVersion:embeddings[i].version}));
    this.completedIndexes.set(sourceId,{revision:snapshot,generation:crypto.randomUUID(),vectorDigest:this.vectorDigest(sourceId)});
  }
  private vectorDigest(sourceId:string):string {
    return crypto.createHash('sha256').update(JSON.stringify((this.chunks.get(sourceId)||[]).map(c=>
      [c.embedding,c.embeddingProvider,c.embeddingModel,c.embeddingDimensions,c.embeddingVersion]))).digest('hex');
  }
  async persistentSemanticSearch(request:PersistentSearchRequest,options?:KnowledgeSemanticOptions):Promise<PersistentSearchResult> {
    options?.signal?.throwIfAborted();
    assertPersistentRequest(request);
    if(request.embeddings.some(e=>!compatibleQuery(e)))throw new Error('knowledge_index_invalid_query_vector');
    const sources=(await this.list(request.businessId)).filter(s=>s.businessId===request.businessId&&s.status!=='deleted').sort((a,b)=>a.id.localeCompare(b.id)).map(s=>{
      const done=this.completedIndexes.get(s.id);const revision=this.indexSnapshot(request.businessId,s.id);
      const chunks=this.chunks.get(s.id)||[];
      const compatible=chunks.filter(c=>compatibleQuery({values:c.embedding!,provider:c.embeddingProvider!,model:c.embeddingModel!,dimensions:c.embeddingDimensions!,version:c.embeddingVersion!})).length;
      return {sourceId:s.id,businessId:s.businessId,sourceStatus:s.status,
        ready:!!done&&revision===done.revision&&done.vectorDigest===this.vectorDigest(s.id)&&chunks.length>0&&compatible===chunks.length,
        revision,state:done?'ready':'unknown',indexStatus:(!done?'missing':revision===done.revision&&done.vectorDigest===this.vectorDigest(s.id)&&chunks.length>0&&compatible===chunks.length?'ready':'incomplete') as 'ready'|'missing'|'incomplete',expectedChunks:chunks.length,compatibleChunks:compatible,
        generation:done?.generation||null,vectorDigest:done?.vectorDigest||null};
    });
    const count=sources.filter(s=>s.sourceStatus==='ready').length;
    const inventoryToken=crypto.createHash('sha256').update(JSON.stringify([request.businessId,sources])).digest('hex');
    const coverage:IndexCoverage={businessId:request.businessId,sources,sourceCount:sources.length,textReadySourceCount:count,readySourceCount:sources.filter(s=>s.ready).length,
      complete:count>0&&sources.filter(s=>s.ready).length===count,inventoryToken,identity:OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,canonicalVersion:1};
    const matches=request.embeddings.map(q=>sources.filter(s=>s.ready).flatMap(source=>(this.chunks.get(source.sourceId)||[])
      .filter(c=>!request.excludedChunks.some(e=>e.source_id===source.sourceId&&e.content===c.content)).map(c=>{
        const norm=(v:number[])=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0));
        const score=q.values.reduce((sum,x,i)=>sum+x*c.embedding![i],0)/(norm(q.values)*norm(c.embedding!));
        return {sourceId:source.sourceId,businessId:request.businessId,text:c.content,metadata:c.metadata||{},score,indexProof:{source,inventoryToken}};
      })).filter(m=>m.score>=request.minSimilarity).sort((a,b)=>b.score-a.score||a.sourceId.localeCompare(b.sourceId)).slice(0,request.limit));
    return parsePersistentSearch({coverage,matches},request);
  }

  async initialize(): Promise<void> {
    // No setup is required for the in-memory fallback.
  }

  async list(businessId: number): Promise<KnowledgeSource[]> {
    return Array.from(this.sources.values())
      .filter((source) => source.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listReadyComplete(businessId: number, maxSources: number, options?: KnowledgeSemanticOptions): Promise<KnowledgeSource[] | null> {
    if (!Number.isSafeInteger(businessId) || businessId <= 0 || !Number.isSafeInteger(maxSources) || maxSources <= 0) return null;
    const sources = [...this.sources.values()].filter(s => s.businessId === businessId && s.status === 'ready');
    return sources.length <= maxSources ? sources : null;
  }

  async create(source: KnowledgeSource): Promise<KnowledgeSource> {
    this.sources.set(source.id, source);
    return source;
  }

  async replaceChunks(
    businessId: number,
    sourceId: string,
    chunks: KnowledgeChunkInput[]
  ): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source || source.businessId !== businessId) {
      throw new Error("Knowledge source does not belong to this business.");
    }

    this.chunks.set(
      sourceId,
      chunks.map((chunk) => ({
        ...structuredClone(chunk),
        metadata: structuredClone(chunk.metadata || {}),
      }))
    );
  }

  async delete(businessId: number, id: string): Promise<boolean> {
    const source = this.sources.get(id);
    if (!source || source.businessId !== businessId) return false;

    this.chunks.delete(id);
    return this.sources.delete(id);
  }

  async search(
    businessId: number,
    query: string,
    limit = 5,
    options?: KnowledgeSemanticOptions
  ): Promise<KnowledgeSearchMatch[]> {
    const normalized = String(query || "").trim().toLowerCase();
    if (!normalized) return [];

    const tokens = normalized.split(/\s+/u).filter(Boolean);
    const maxResults = Math.max(1, Math.min(Number(limit) || 5, 10));

    return Array.from(this.sources.values())
      .filter((source) =>
        source.businessId === businessId &&
        source.status === "ready"
      )
      .flatMap((source) =>
        (this.chunks.get(source.id) || []).map((chunk) => {
          const haystack =
            `${source.title}\n${chunk.content}`.toLowerCase();

          const matchedTokens = tokens.filter((token) =>
            haystack.includes(token)
          );

          return {
            sourceId: source.id,
            businessId: source.businessId,
            score:
              tokens.length > 0
                ? matchedTokens.length / tokens.length
                : 0,
            text: chunk.content,
            metadata: {
              ...source.metadata,
              ...(chunk.metadata || {}),
              chunkIndex: chunk.chunkIndex,
            },
          };
        })
      )
      .filter((match) => (match.score || 0) > 0)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, maxResults);
  }
}

export class SupabaseKnowledgeStorage implements KnowledgeStorage {
  private readonly tableName = "knowledge_sources";
  private readonly client: any;

  constructor(client: any) {
    this.client = client;
  }

  async initialize(): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .select("id")
      .limit(1);

    if (error) {
      throw new Error(error.message || "Knowledge storage is unavailable.");
    }
  }

  async list(businessId: number, options?: KnowledgeSemanticOptions): Promise<KnowledgeSource[]> {
    let query = this.client
      .from(this.tableName)
      .select("id,business_id,type,title,status,content,created_at,updated_at,metadata")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    if(options?.signal && typeof query.abortSignal==='function')query=query.abortSignal(options.signal);
    const {data,error}=await abortable<any>(query,options?.signal);

    if (error) {
      throw new Error(error.message || "Unable to list knowledge sources.");
    }

    return (data || []).map(mapKnowledgeSourceRow).filter((source: KnowledgeSource) => source.businessId === businessId && source.status !== "deleted");
  }

  async listReadyComplete(businessId: number, maxSources: number, options?: KnowledgeSemanticOptions): Promise<KnowledgeSource[] | null> {
    if (!Number.isSafeInteger(businessId) || businessId <= 0 || !Number.isSafeInteger(maxSources) || maxSources <= 0) return null;
    try {
      // Prove the ALL-status inventory before selecting ready rows. Existing
      // freshness reads also list all statuses: a ready-only proof could opt in
      // while later capped reads hide older conditions. One data+exact-count
      // response detects overflow/truncation without a separate count or paging.
      let query = this.client.from(this.tableName)
        .select('id,business_id,type,title,status,content,created_at,updated_at,metadata', { count: 'exact' })
        .eq('business_id', businessId)
        .order('created_at', { ascending: false }).limit(maxSources).retry(false);
      if (options?.signal && typeof query.abortSignal==='function') query=query.abortSignal(options.signal);
      const {data,error,count}=await abortable<any>(query,options?.signal);
      if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count < 0 || count > maxSources || count !== data.length ||
          data.some(row => !row || typeof row.id !== 'string' || !row.id.trim() ||
            !['pending','processing','ready','failed','deleted','disabled','error'].includes(row.status))) return null;
      const sources = data.map(mapKnowledgeSourceRow);
      if (new Set(sources.map(s => s.id)).size !== count || sources.some(s => s.businessId !== businessId)) return null;
      return sources.filter(s => s.status === 'ready');
    } catch { return null; } // Unknown inventory must retain semantic retrieval.
  }

  async create(source: KnowledgeSource): Promise<KnowledgeSource> {
    const { data, error } = await this.client
      .from(this.tableName)
      .insert([{
        id: source.id,
        business_id: source.businessId,
        type: source.type,
        title: source.title,
        status: source.status,
        content: source.content,
        created_at: source.createdAt,
        updated_at: source.updatedAt,
        metadata: source.metadata,
      }])
      .select("id,business_id,type,title,status,content,created_at,updated_at,metadata")
      .single();

    if (error) {
      throw new Error(error.message || "Unable to add knowledge source.");
    }

    return mapKnowledgeSourceRow(data);
  }

  async replaceChunks(
    businessId: number,
    sourceId: string,
    chunks: KnowledgeChunkInput[]
  ): Promise<void> {
    const normalizedBusinessId = Number(businessId);

    if (
      !Number.isSafeInteger(normalizedBusinessId) ||
      normalizedBusinessId <= 0 ||
      !sourceId
    ) {
      throw new Error("Invalid knowledge chunk scope.");
    }

    const normalizedChunks = chunks.map((chunk) => {
      const payload: Record<string, unknown> = {
        chunk_index: chunk.chunkIndex,
        content: String(chunk.content || "").trim(),
        metadata: chunk.metadata || {},
      };

      if (Array.isArray(chunk.embedding)) {
        payload.embedding = chunk.embedding;
        payload.embedding_provider = chunk.embeddingProvider;
        payload.embedding_model = chunk.embeddingModel;
        payload.embedding_dimensions = chunk.embeddingDimensions;
        payload.embedding_version = chunk.embeddingVersion;
      }

      return payload;
    });

    const { error } = await this.client.rpc("replace_knowledge_chunks", {
      p_business_id: normalizedBusinessId,
      p_source_id: sourceId,
      p_chunks: normalizedChunks,
    });

    if (error) {
      throw new Error(error.message || "Unable to replace knowledge chunks.");
    }
  }

  async delete(businessId: number, id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(this.tableName)
      .delete()
      .eq("business_id", businessId)
      .eq("id", id)
      .select("id");

    if (error) {
      throw new Error(error.message || "Unable to delete knowledge source.");
    }

    return Array.isArray(data) && data.length > 0;
  }

  async search(
    businessId: number,
    query: string,
    limit = 5,
    options?: KnowledgeSemanticOptions
  ): Promise<KnowledgeSearchMatch[]> {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) return [];

    const normalizedBusinessId = Number(businessId);
    if (!Number.isSafeInteger(normalizedBusinessId) || normalizedBusinessId <= 0) {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 5, 10));

    let queryRequest = this.client.rpc("search_knowledge_chunks", {
      p_business_id: normalizedBusinessId,
      p_query: normalizedQuery,
      p_limit: normalizedLimit,
    });
    if (options?.signal && typeof queryRequest.abortSignal==='function') queryRequest=queryRequest.abortSignal(options.signal);
    const {data,error}=await abortable<any>(queryRequest,options?.signal);

    if (error) {
      throw new Error(error.message || "Unable to search business knowledge.");
    }

    return (data || []).map((row: any) => ({
      sourceId: String(row.source_id),
      businessId: Number(row.business_id),
      score: Number(row.score || 0),
      text: String(row.content || ""),
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    }));
  }

  async persistentSemanticSearch(request: PersistentSearchRequest, options?: KnowledgeSemanticOptions): Promise<PersistentSearchResult> {
    options?.signal?.throwIfAborted();
    assertPersistentRequest(request);
    let query = this.client.rpc(PERSISTENT_SEARCH_RPC, {
      p_business_id: request.businessId, p_identity: OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY,
      p_queries: request.embeddings.map(e=>e.values), p_limit: request.limit,
      p_min_similarity: request.minSimilarity, p_excluded_chunks: request.excludedChunks,
    });
    if (typeof query.retry === 'function') query = query.retry(false);
    if (options?.signal && typeof query.abortSignal === 'function') query = query.abortSignal(options.signal);
    const { data, error } = await abortable<any>(query, options?.signal);
    if (error) throw new Error('knowledge_index_search_unavailable');
    return parsePersistentSearch(data,request);
  }

  async semanticSearch(
    businessId: number,
    embedding: EmbeddingVector,
    limit = 5,
    minSimilarity = 0.55
  ): Promise<KnowledgeSearchMatch[]> {
    const normalizedBusinessId = Number(businessId);

    if (
      !Number.isSafeInteger(normalizedBusinessId) ||
      normalizedBusinessId <= 0 ||
      !embedding ||
      !Array.isArray(embedding.values) ||
      embedding.values.length !== 768
    ) {
      return [];
    }

    const normalizedLimit = Math.max(
      1,
      Math.min(Number(limit) || 5, 10)
    );

    const normalizedThreshold = Number.isFinite(Number(minSimilarity))
      ? Math.max(-1, Math.min(Number(minSimilarity), 1))
      : 0.55;

    const { data, error } = await this.client.rpc(
      "search_knowledge_chunks_semantic",
      {
        p_business_id: normalizedBusinessId,
        p_embedding: embedding.values,
        p_limit: normalizedLimit,
        p_min_similarity: normalizedThreshold,
        p_embedding_provider: embedding.provider,
        p_embedding_model: embedding.model,
        p_embedding_version: embedding.version,
      }
    );

    if (error) {
      throw new Error(
        error.message || "Unable to search semantic business knowledge."
      );
    }

    return (data || []).map((row: any) => ({
      sourceId: String(row.source_id),
      businessId: Number(row.business_id),
      score: Number(row.score || 0),
      text: String(row.content || ""),
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? row.metadata
          : {},
    }));
  }
}

export function chunkKnowledgeContent(
  content: string,
  maxChars = 1800
): KnowledgeChunkInput[] {
  const normalized = String(content || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  if (!normalized) return [];

  const safeMaxChars =
    Number.isInteger(maxChars) && maxChars >= 500
      ? Math.min(maxChars, 4000)
      : 1800;

  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > safeMaxChars) {
      flush();

      for (let offset = 0; offset < paragraph.length; offset += safeMaxChars) {
        const piece = paragraph.slice(offset, offset + safeMaxChars).trim();
        if (piece) chunks.push(piece);
      }

      continue;
    }

    const candidate = current
      ? `${current}\n\n${paragraph}`
      : paragraph;

    if (candidate.length > safeMaxChars) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  flush();

  return chunks.map((chunk, index) => ({
    chunkIndex: index,
    content: chunk,
    metadata: {},
  }));
}

// Reconstruct document chunks from the currently published content and provenance.
// Search rows and cached vectors never supply their own authority or provenance.
function documentCorpus(source: KnowledgeSource): SemanticChunk[] {
  const segments = source.metadata.segments;
  if (!Array.isArray(segments) || !segments.length || segments.length > 200) return [];
  let previousEnd = 0;
  const chunks: SemanticChunk[] = [];
  const revision = documentRevision(source);
  for (const segment of segments) {
    if (!segment || !Number.isInteger(segment.start) || !Number.isInteger(segment.end) ||
      segment.start < previousEnd || segment.end <= segment.start || segment.end > source.content.length) return [];
    previousEnd = segment.end;
    const provenance = {
      ...(Number.isInteger(segment.page) && segment.page > 0 && segment.page <= 100 ? { page: segment.page } : {}),
      ...(typeof segment.sheet === "string" ? { sheet: segment.sheet.slice(0, 200) } : {}),
      ...(typeof segment.section === "string" ? { section: segment.section.slice(0, 200) } : {}),
    };
    for (const chunk of chunkKnowledgeContent(source.content.slice(segment.start, segment.end))) chunks.push({
      sourceId: source.id, businessId: source.businessId, text: chunk.content,
      metadata: { source: "document", filename: source.title, untrusted: true, ...provenance, documentRevision: revision },
    });
  }
  return chunks.length <= 200 ? chunks : [];
}
function documentRevision(source: KnowledgeSource): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    source.id, source.businessId, source.type, source.status, source.title, source.content, source.metadata.segments,
  ])).digest("hex");
}

/** Same source-wide revision used by strict foreground validation. */
export function knowledgeSourceRevision(source: KnowledgeSource): string {
  return source.type === 'document' ? documentRevision(source) :
    crypto.createHash('sha256').update(JSON.stringify([source.id, source.businessId, source.type, source.status,
      source.title, source.content, source.updatedAt, source.metadata])).digest('hex');
}

export class KnowledgeService {
  private storage: KnowledgeStorage;
  private initialized = false;
  private readonly compatibleSemanticIndex = new CompatibleSemanticIndex();
  private readonly primaryStorage: KnowledgeStorage;
  private readonly fallbackStorage: KnowledgeStorage;
  private readonly embeddingProvider: EmbeddingProvider | null;

  constructor(
    primaryStorage: KnowledgeStorage = new InMemoryKnowledgeStorage(),
    fallbackStorage: KnowledgeStorage = new InMemoryKnowledgeStorage(),
    embeddingProvider: EmbeddingProvider | null = null,
    private readonly requireDurableStorage = false
  ) {
    this.primaryStorage = primaryStorage;
    this.fallbackStorage = fallbackStorage;
    this.storage = primaryStorage;
    this.embeddingProvider = embeddingProvider;
  }

  async initialize(): Promise<void> {
    if (this.requireDurableStorage) {
      if (!(this.primaryStorage instanceof SupabaseKnowledgeStorage)) throw new Error("Durable Knowledge storage is required for documents.");
      await this.primaryStorage.initialize();
      this.storage = this.primaryStorage; this.initialized = true;
      return;
    }
    try {
      await this.primaryStorage.initialize();
      this.storage = this.primaryStorage;
    } catch (error) {
      console.warn("Knowledge persistence unavailable; using in-memory storage.", getErrorMessage(error));
      await this.fallbackStorage.initialize();
      this.storage = this.fallbackStorage;
    }

    this.initialized = true;
    console.log("Knowledge initialized");
  }

  async reload(businessId: number): Promise<KnowledgeSource[]> {
    await this.initialize();
    return this.storage.list(businessId);
  }

  async list(businessId: number): Promise<KnowledgeSource[]> {
    await this.ensureInitialized();
    return this.storage.list(businessId);
  }

  async addSource(input: CreateKnowledgeSourceInput): Promise<KnowledgeSource> {
    if (input.type === "document") throw new Error("Use durable document ingestion.");
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const source: KnowledgeSource = {
      id: crypto.randomUUID(),
      businessId: input.businessId,
      type: input.type,
      title: input.title,
      status: input.status || "pending",
      content: input.content || "",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata || {},
    };

    const savedSource = await this.storage.create(source);

    let chunks =
      savedSource.status === "ready"
        ? chunkKnowledgeContent(savedSource.content)
        : [];

    if (chunks.length > 0 && this.embeddingProvider) {
      try {
        const embeddings = await this.embeddingProvider.embedDocuments(
          chunks.map((chunk) => chunk.content)
        );

        if (embeddings.length !== chunks.length) {
          throw new Error("Embedding count does not match Knowledge chunk count.");
        }

        chunks = chunks.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index].values,
          embeddingProvider: embeddings[index].provider,
          embeddingModel: embeddings[index].model,
          embeddingDimensions: embeddings[index].dimensions,
          embeddingVersion: embeddings[index].version,
        }));
      } catch (error) {
        console.warn(
          "Knowledge embedding generation failed; preserving lexical-only chunks.",
          { operation: "knowledge_document_embeddings", outcome: "provider_failure" }
        );
      }
    }

    try {
      await this.storage.replaceChunks(
        savedSource.businessId,
        savedSource.id,
        chunks
      );
    } catch (error) {
      try {
        await this.storage.delete(
          savedSource.businessId,
          savedSource.id
        );
      } catch (cleanupError) {
        console.error("Knowledge source cleanup failed after chunk write failure", {
          businessId: savedSource.businessId,
          sourceId: savedSource.id,
          error: getErrorMessage(cleanupError),
        });
      }

      throw error;
    }

    console.log("Knowledge source added", {
      id: savedSource.id,
      type: savedSource.type,
      chunkCount: chunks.length,
    });

    return savedSource;
  }

  async deleteSource(businessId: number, id: string): Promise<boolean> {
    await this.ensureInitialized();
    if ((await this.storage.list(businessId)).some((s) => s.id === id && s.type === "document")) throw new Error("Use document cleanup.");
    return this.storage.delete(businessId, id);
  }

  async search(
    businessId: number,
    query: string,
    limit = 5,
    diagnostic?: LexicalDiagnostic,
    options?: KnowledgeSemanticOptions,
  ): Promise<KnowledgeSearchMatch[]> {
    const started = performance.now();
    const metrics = diagnostic ? lexicalMetrics('legacy', 1) : undefined;
    try {
      await abortable(this.ensureInitialized(),options?.signal);
      const normalizedBusinessId = Number(businessId);
      const normalizedQuery = String(query || "").trim();
      if (!Number.isSafeInteger(normalizedBusinessId) || normalizedBusinessId <= 0 || !normalizedQuery) return [];
      console.log("Knowledge search", { businessId: normalizedBusinessId, queryLength: normalizedQuery.length });
      const searchStarted = performance.now();
      let matches: KnowledgeSearchMatch[];
      if (metrics) metrics.storageSearchCalls++;
      try { matches = await this.storage.search(normalizedBusinessId, normalizedQuery, Math.max(1, Math.min(Number(limit) || 5, 10)),options); }
      catch (error) { if (metrics) metrics.searchFailures++; throw error; }
      finally { if (metrics) metrics.lexicalSearchMs = performance.now() - searchStarted; }
      return await this.filterCurrentMatches(normalizedBusinessId, matches, {}, metrics, options);
    } finally { reportLexicalMetrics(metrics, started, diagnostic); }
  }

  /** Ordered per-query lexical results. No ranking, deduplication or cross-request cache.
   * Read current sources AFTER all searches; this snapshot expires on return.
   * Subsequent verification/publication must use their existing fresh reads. */
  async searchLexicalQueries(businessId: number, queries: readonly string[], limit = 5,
    diagnostic?: LexicalDiagnostic, options?: KnowledgeSemanticOptions): Promise<KnowledgeSearchMatch[][]> {
    const started = performance.now(), metrics = lexicalMetrics('batch', queries.length);
    try {
      await this.ensureInitialized();
      const id = Number(businessId), normalized = queries.map(query => String(query || "").trim());
      if (!Number.isSafeInteger(id) || id <= 0 || !normalized.some(Boolean)) return queries.map(() => []);
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
      const searchStarted = performance.now();
      const sets = await Promise.all(normalized.map(async query => {
        if (!query) return [];
        metrics.storageSearchCalls++;
        try { return await this.storage.search(id, query, boundedLimit,options); }
        catch { metrics.searchFailures++; return []; }
      }));
      metrics.lexicalSearchMs = performance.now() - searchStarted;
      const listStarted = performance.now(); metrics.sourceListReads++;
      let sources: KnowledgeSource[];
      try { sources = await this.storage.list(id,options); }
      catch { metrics.sourceListFailures++; return queries.map(() => []); }
      finally { metrics.sourceListMs = performance.now() - listStarted; }
      const documents = new Map<string, { revision: string; corpus: SemanticChunk[] }>();
      return sets.map(matches => {
        try { return this.filterMatchesFromSources(id, matches, sources, {}, metrics, documents); }
        catch { metrics.validationFailures++; return []; }
      });
    } finally { reportLexicalMetrics(metrics, started, diagnostic); }
  }

  async semanticSearch(
    businessId: number,
    query: string,
    limit = 5,
    minSimilarity = 0.55,
    options?: KnowledgeSemanticOptions
  ): Promise<KnowledgeSearchMatch[]> {
    if (this.embeddingProvider?.supportsLocalSemanticSearch) {
      return this.openAiSemanticSearch(businessId,[String(query || '').trim()],limit,minSimilarity,options,false);
    }
    await this.ensureInitialized();

    const normalizedBusinessId = Number(businessId);
    const normalizedQuery = String(query || "").trim();

    if (
      !Number.isSafeInteger(normalizedBusinessId) ||
      normalizedBusinessId <= 0 ||
      !normalizedQuery ||
      !this.embeddingProvider
    ) {
      return [];
    }

    if (typeof this.storage.semanticSearch !== "function" && !this.embeddingProvider.supportsLocalSemanticSearch &&
      !(await this.semanticCorpus(normalizedBusinessId, true)).length) return [];
    try {
      const embedding =
        await this.embeddingProvider.embedQuery(normalizedQuery);

      const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
      if (embedding.provider === "openai") {
        return this.openAiSemanticSearch(normalizedBusinessId,[normalizedQuery],safeLimit,minSimilarity,options,false,[embedding]);
      }
      // Documents deliberately have no ingestion-time vectors. Use the same configured
      // provider's existing read-only index for them, retaining persisted manual search.
      const persisted = typeof this.storage.semanticSearch === "function"
        ? await this.storage.semanticSearch(normalizedBusinessId, embedding, safeLimit, minSimilarity) : [];
      let fresh: KnowledgeSearchMatch[] = [];
      try {
        const chunks = await this.semanticCorpus(normalizedBusinessId, true);
        const documents = await this.compatibleSemanticIndex.search(normalizedBusinessId, chunks, embedding,
          this.embeddingProvider, safeLimit, minSimilarity);
        const current = await this.semanticCorpus(normalizedBusinessId, true);
        if (semanticCorpusFingerprint(chunks) === semanticCorpusFingerprint(current)) fresh = documents;
      } catch {
        // A document-index failure must not remove existing persisted manual matches.
        console.warn("Document semantic index unavailable; persisted Knowledge remains available.");
      }
      return this.filterCurrentMatches(normalizedBusinessId, [...persisted, ...fresh]
        .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, safeLimit));
    } catch (error) {
      console.warn(
        "Semantic Knowledge search failed; lexical fallback remains available.",
        { businessId: normalizedBusinessId, operation: "knowledge_semantic_search", outcome: "provider_failure" }
      );
      return [];
    }
  }

  async sourceLanguageHints(businessId: number, options?: KnowledgeSemanticOptions): Promise<SourceLanguage[]> {
    await this.ensureInitialized();
    if (!Number.isSafeInteger(businessId) || businessId <= 0) return [];
    const languages = new Set<SourceLanguage>(); let samples = 0;
    let timer: ReturnType<typeof setTimeout>;
    const listed = await Promise.race([
      (options?.observe || (p=>p))(this.storage.list(businessId,options)).catch(() => [] as KnowledgeSource[]),
      new Promise<KnowledgeSource[]>(resolve => { timer = setTimeout(() => resolve([]), 500); }),
    ]).finally(() => clearTimeout(timer));
    const sources = listed.filter(s => s.businessId === businessId && s.status === 'ready').slice(0, 50);
    for (const source of sources) {
      const texts = source.type === 'document' ? documentCorpus(source).slice(0, 2).map(c => c.text) : [source.content];
      let sourceHint = false;
      for (const text of texts) for (const paragraph of String(text).slice(0, 4000).split(/\n+/u).slice(0, 4)) {
        if (++samples > 100) return [...languages];
        const language = confirmedTextLanguage(paragraph.slice(0, 1600));
        if (language) { languages.add(language); sourceHint = true; }
      }
      // Title/disclaimer lines alone can hide a source's actual language.
      // Fall back to the same distinctive-token classifier over a bounded
      // sample of canonical source text, never locale or editable metadata.
      if (!sourceHint) {
        const language = confirmedTextLanguage(texts.join('\n').slice(0,4000));
        if (language) languages.add(language);
      }
    }
    return [...languages];
  }

  /** Retrieval completeness only, never question coverage. If the ENTIRE current
   * tenant corpus fits the existing evidence envelope, semantic ranking cannot
   * contribute any additional text. Include unmatched conditions/conflicts too.
   * Otherwise return null; lexical hit counts/scores cannot prove completeness.
   * No cache, storage writes or changes to version-1 document reconstruction. */
  async completeSmallCorpus(businessId: number, lexical: readonly KnowledgeSearchMatch[], options?: KnowledgeSemanticOptions): Promise<KnowledgeSearchMatch[] | null> {
    if (!Number.isSafeInteger(businessId) || businessId <= 0 || !lexical.length) return null;
    await this.ensureInitialized();
    const sources = this.storage.listReadyComplete ? await this.storage.listReadyComplete(businessId, 5, options).catch(() => null) : null;
    if (!sources?.length || sources.length > 5 || sources.some(s => s.businessId !== businessId || s.status !== 'ready' || !s.content.trim()) ||
        sources.reduce((sum, s) => sum + s.content.length, 0) > 9000) return null;
    const corpus: KnowledgeSearchMatch[] = [];
    for (const source of sources) {
      const chunks = source.type === 'document' ? documentCorpus(source) : chunkKnowledgeContent(source.content).map(c => ({
        sourceId: source.id, businessId, text: c.content, metadata: { ...c.metadata, sourceRevision: knowledgeSourceRevision(source) },
      }));
      if (!chunks.length || corpus.length + chunks.length > 5) return null;
      corpus.push(...chunks);
    }
    if (corpus.reduce((sum, c) => sum + c.text.length, 0) > 9000) return null;
    const current = this.filterMatchesFromSources(businessId, [...lexical], sources, { strictSources: true, captureRevision: true });
    if (!current.length) return null; // Empty, stale/foreign or fabricated hits cannot opt in.
    const key = (m: KnowledgeSearchMatch) => JSON.stringify([m.sourceId, m.text]);
    const selected = new Map<string, KnowledgeSearchMatch>();
    for (const m of [...current, ...corpus]) if (!selected.has(key(m))) selected.set(key(m), m);
    // Every returned byte must come from the canonical snapshot, even when an
    // injected/legacy search row claims a high score. Revalidate again downstream.
    return [...selected.values()];
  }

  /** OpenAI query embeddings only; corpus generations are prepared off-request. */
  async semanticSearchQueries(businessId: number, queries: string[], limit = 5, options?: KnowledgeSemanticOptions): Promise<KnowledgeSearchMatch[]> {
    const seen = new Set<string>();
    const bounded = queries.slice(0, MAX_SEMANTIC_QUERIES).map(q => String(q).trim()).filter(q => {
      const key = normalizeSemanticQuery(q);
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (!Number.isSafeInteger(businessId) || businessId <= 0 || !bounded.length || bounded[0].length > 4000 || bounded.slice(1).some(q => q.length > 120) || !this.embeddingProvider) return [];
    if (!this.embeddingProvider.supportsLocalSemanticSearch) return this.semanticSearch(businessId,bounded[0],limit,0.55,options);
    return this.openAiSemanticSearch(businessId,bounded,limit,0.55,options,true);
  }

  private async openAiSemanticSearch(businessId: number, queries: string[], limit: number, threshold: number,
    options: KnowledgeSemanticOptions | undefined, batch: boolean, supplied?: EmbeddingVector[]): Promise<KnowledgeSearchMatch[]> {
    if (!Number.isSafeInteger(businessId) || businessId<=0 || !queries.length || !queries[0] || queries[0].length>4000 || !this.embeddingProvider) return [];
    try {
      return await semanticBudget(options,async current=>{
        const trial = current.candidateFallback && Object.freeze({...current.candidateFallback,
          lexicalEmpty:Promise.resolve(current.candidateFallback.lexicalEmpty).catch(() => false)});
        if (trial && (trial.policy !== CANDIDATE_RETRIEVAL_POLICY || threshold !== 0.55)) throw new Error('knowledge_candidate_policy_invalid');
        await abortable(this.ensureInitialized(),current.signal);
        if (!this.storage.persistentSemanticSearch) throw new Error('knowledge_index_search_unavailable');
        const observe = current.observe || (<T>(promise:Promise<T>) => promise);
        const embeddings = supplied || (batch ? await abortable(observe(this.embeddingProvider!.embedDocuments(queries,current)),current.signal) :
          [await abortable(observe(this.embeddingProvider!.embedQuery(queries[0],current)),current.signal)]);
        if (embeddings.length !== queries.length || embeddings.some(e=>!compatibleQuery(e))) {
          semanticStatus(options,{status:'unavailable',reason:'invalid_vector'});return [];
        }
        // Text reconstruction only: workflow exclusion happens BEFORE top-N ranking.
        const corpus = batch || trial ? await abortable(this.semanticCorpus(businessId,false,current),current.signal) : [];
        const request: PersistentSearchRequest = {businessId,embeddings,limit:Math.max(1,Math.min(Number(limit)||5,10)),
          minSimilarity:Number.isFinite(Number(threshold))?Math.max(-1,Math.min(Number(threshold),1)):0.55,
          excludedChunks:corpus.filter(c=>explicitlyWrongWorkflow(c.text,queries[0])).map(c=>({source_id:c.sourceId,content:c.text}))};
        let result = parsePersistentSearch(await this.storage.persistentSemanticSearch(request,current),request);
        let origin: 'strict-semantic' | 'candidate' = 'strict-semantic';
        if (trial && result.coverage.complete && result.matches.every(set => set.length === 0) &&
          await abortable(trial.lexicalEmpty,current.signal) === true) {
          const candidates: PersistentSearchRequest = {...request,limit:Math.min(request.limit,5),minSimilarity:-1};
          const fallback = parsePersistentSearch(await this.storage.persistentSemanticSearch(candidates,current),candidates);
          if (!fallback.coverage.complete || fallback.coverage.inventoryToken !== result.coverage.inventoryToken) {
            semanticStatus(options,{status:'unavailable',reason:'source_changed'});return [];
          }
          result = fallback;
          origin = 'candidate';
        }
        // A newly completed revision can race the text-only exclusion read. Do
        // not let that revision bypass the existing workflow filter/top-N guard.
        if((batch || trial) && result.matches.some(set=>set.some(m=>explicitlyWrongWorkflow(String(m.text),queries[0])))) {
          semanticStatus(options,{status:'unavailable',reason:'source_changed'});return [];
        }
        const ranked = new Map<string,{match:KnowledgeSearchMatch;rank:number}>();
        for (const set of result.matches) for (const [position,match] of set.entries()) {
          const key=JSON.stringify([match.sourceId,match.text]);const prior=ranked.get(key);
          ranked.set(key,{match:prior&&Number(prior.match.score)>Number(match.score)?prior.match:match,rank:(prior?.rank||0)+1/(60+position+1)});
        }
        const selected=[...ranked.values()].sort((a,b)=>b.rank-a.rank).slice(0,origin==='candidate'?Math.min(request.limit,5):request.limit)
          .map(e=>origin==='candidate'?{...e.match,indexProof:{...e.match.indexProof!,candidatePolicy:CANDIDATE_RETRIEVAL_POLICY}}:e.match);
        const valid=await abortable(this.filterCurrentMatches(businessId,selected,{strictSources:true,captureRevision:true},undefined,current),current.signal);
        if(valid.length!==selected.length) semanticStatus(options,{status:'unavailable',reason:'source_changed'});
        else semanticStatus(options,{status:result.coverage.complete?'complete':'incomplete',coverage:result.coverage});
        try { options?.onRetrieval?.({origin,count:valid.length,...(origin==='candidate'?{policy:CANDIDATE_RETRIEVAL_POLICY}:{})}); } catch { /* Observability has no authority. */ }
        return valid;
      });
    } catch(error) {
      semanticStatus(options,{status:'unavailable',reason: options?.signal?.aborted || String(error).includes('timeout') ? 'timeout':'storage_unavailable'});
      return [];
    }
  }

  /** Index coverage is NOT question completeness. Callers relying on inventory must recheck it. */
  async validateSemanticCoverage(businessId:number, coverage:IndexCoverage, options?:KnowledgeSemanticOptions):Promise<boolean> {
    if(coverage.businessId!==businessId)return false;
    try { return await semanticBudget(options,async current=>{
      if(!this.storage.persistentSemanticSearch)return false;
      const request:PersistentSearchRequest={businessId,embeddings:[],limit:1,minSimilarity:0.55,excludedChunks:[]};
      const result=parsePersistentSearch(await this.storage.persistentSemanticSearch(request,current),request);
      return result.coverage.inventoryToken===coverage.inventoryToken;
    }); } catch { return false; }
  }

  async validateMatches(businessId: number, matches: KnowledgeSearchMatch[], options: KnowledgeValidationOptions = {}): Promise<KnowledgeSearchMatch[]> {
    await abortable(this.ensureInitialized(), options.signal);
    return this.filterCurrentMatches(businessId, matches, options, undefined, options.signal ? {signal:options.signal} : undefined);
  }

  private async filterCurrentMatches(businessId: number, matches: KnowledgeSearchMatch[], options: KnowledgeValidationOptions = {},
    metrics?: LexicalRetrievalMetrics, semanticOptions?: KnowledgeSemanticOptions): Promise<KnowledgeSearchMatch[]> {
    const listStarted = performance.now();
    if (metrics) metrics.sourceListReads++;
    let sources: KnowledgeSource[];
    try { sources = await this.storage.list(businessId,semanticOptions); }
    catch (error) { if (metrics) metrics.sourceListFailures++; throw error; }
    finally { if (metrics) metrics.sourceListMs += performance.now() - listStarted; }
    if (matches.some(m=>m.indexProof)) {
      let current: PersistentSearchResult | undefined;
      try { current=await semanticBudget(semanticOptions,async opts=>{
        const request:PersistentSearchRequest={businessId,embeddings:[],limit:1,minSimilarity:0.55,excludedChunks:[]};
        return parsePersistentSearch(await this.storage.persistentSemanticSearch!(request,opts),request);
      }); } catch { /* Fail closed for semantic proofs, retain lexical siblings. */ }
      matches=matches.filter(m=>{
        if(!m.indexProof)return true;
        const source=current?.coverage.sources.find(s=>s.sourceId===m.sourceId&&s.businessId===businessId);
        const valid=!!source&&sameSourceProof(source,m.indexProof.source) &&
          (m.indexProof.candidatePolicy===undefined || m.indexProof.candidatePolicy===CANDIDATE_RETRIEVAL_POLICY &&
            current?.coverage.complete===true && current.coverage.inventoryToken===m.indexProof.inventoryToken);
        if(!valid)options.onRejected?.(m.sourceId,'SOURCE_REVISION');
        return valid;
      });
    }
    try { return this.filterMatchesFromSources(businessId, matches, sources, options, metrics); }
    catch (error) { if (metrics) metrics.validationFailures++; throw error; }
  }

  private filterMatchesFromSources(businessId: number, matches: KnowledgeSearchMatch[], sources: KnowledgeSource[],
    options: KnowledgeValidationOptions, metrics?: LexicalRetrievalMetrics,
    documents?: Map<string, { revision: string; corpus: SemanticChunk[] }>): KnowledgeSearchMatch[] {
    const validationStarted = performance.now();
    try {
      const ready = new Map(sources.filter((s) => s.businessId === businessId && s.status === "ready").map((s) => [s.id, s]));
      return matches.flatMap((match) => {
        const reject=(reason:Parameters<NonNullable<KnowledgeValidationOptions['onRejected']>>[1])=>{options.onRejected?.(match.sourceId,reason);return [];};
        const source = ready.get(match.sourceId);
        if(match.businessId!==businessId)return reject('SOURCE_SCOPE');
        if(!source)return reject(sources.some(s=>s.id===match.sourceId&&s.businessId===businessId)?'SOURCE_NOT_READY':'SOURCE_MISSING_OR_UNAUTHORIZED');
        if (source.type !== "document") {
          if (!options.strictSources) return [match];
          const revision = knowledgeSourceRevision(source);
          if (!chunkKnowledgeContent(source.content).some(chunk => chunk.content === String(match.text || '').trim())) return reject('SOURCE_CHUNK');
          if (match.metadata?.sourceRevision !== revision && (!options.captureRevision || match.metadata?.sourceRevision)) return reject('SOURCE_REVISION');
          return [{ ...match, metadata: { ...match.metadata, sourceRevision: revision } }];
        }
        let document = documents?.get(source.id);
        if (!document) {
          const reconstructionStarted = performance.now();
          const revision = documentRevision(source);
          // Preserve the legacy early revision rejection before reconstruction.
          if (match.metadata?.documentRevision && match.metadata.documentRevision !== revision) return reject('SOURCE_REVISION');
          if (metrics) metrics.documentReconstructions++;
          document = { revision, corpus: documentCorpus(source) };
          if (metrics) metrics.documentReconstructionMs += performance.now() - reconstructionStarted;
          documents?.set(source.id, document);
        }
        const { revision, corpus } = document;
        if (match.metadata?.documentRevision && match.metadata.documentRevision !== revision) return reject('SOURCE_REVISION');
        const canonical = corpus.find((chunk) => chunk.text === String(match.text || "").trim() &&
          (match.metadata?.page === undefined || match.metadata.page === chunk.metadata?.page) &&
          (match.metadata?.sheet === undefined || match.metadata.sheet === chunk.metadata?.sheet) &&
          (!match.indexProof || ['page','sheet','section'].every(key=>match.metadata?.[key]===chunk.metadata?.[key])));
        return canonical ? [{ ...match, text: canonical.text, metadata: { ...canonical.metadata, documentRevision: revision } }] : reject('SOURCE_CHUNK');
      });
    } finally { if (metrics) metrics.validationMs += performance.now() - validationStarted; }
  }

  private async semanticCorpus(businessId: number, documentsOnly = false, options?:KnowledgeSemanticOptions): Promise<SemanticChunk[]> {
    const sources = await this.storage.list(businessId,options);
    return sources.filter((source) => source.businessId === businessId && source.status === "ready" && (!documentsOnly || source.type === "document"))
      .flatMap((source) => source.type === "document" ? documentCorpus(source) : chunkKnowledgeContent(source.content).map((chunk) => ({
        sourceId: source.id, businessId, text: chunk.content, metadata: chunk.metadata,
      })));
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

export function isKnowledgeSourceType(value: unknown): value is KnowledgeSourceType {
  return typeof value === "string" &&
    (KNOWLEDGE_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isKnowledgeSourceStatus(value: unknown): value is KnowledgeSourceStatus {
  return typeof value === "string" && ["pending", "processing", "ready", "failed", "deleted", "disabled", "error"].includes(value);
}

function mapKnowledgeSourceRow(row: any): KnowledgeSource {
  return {
    id: String(row.id),
    businessId: Number(row.business_id ?? row.businessId),
    type: row.type as KnowledgeSourceType,
    title: String(row.title || ""),
    status: (row.status || "pending") as KnowledgeSourceStatus,
    content: String(row.content || ""),
    createdAt: String(row.created_at || row.createdAt || ""),
    updatedAt: String(row.updated_at || row.updatedAt || ""),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
