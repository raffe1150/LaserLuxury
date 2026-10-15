import type { EmbeddingProvider, EmbeddingVector } from "./src/ai/embeddings";
import crypto from "crypto";
import { CompatibleSemanticIndex, semanticCorpusFingerprint, type SemanticChunk } from "./src/knowledge/semantic-index";
import { confirmedTextLanguage, normalizeSemanticQuery, explicitlyWrongWorkflow, MAX_SEMANTIC_QUERIES, type SourceLanguage } from './src/knowledge/semantic-queries';

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
  score?: number;
  text?: string;
  metadata?: KnowledgeSourceMetadata;
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
  list(businessId: number): Promise<KnowledgeSource[]>;
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
    limit?: number
  ): Promise<KnowledgeSearchMatch[]>;
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

  async initialize(): Promise<void> {
    // No setup is required for the in-memory fallback.
  }

  async list(businessId: number): Promise<KnowledgeSource[]> {
    return Array.from(this.sources.values())
      .filter((source) => source.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        metadata: chunk.metadata || {},
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
    limit = 5
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

  async list(businessId: number): Promise<KnowledgeSource[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select("id,business_id,type,title,status,content,created_at,updated_at,metadata")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message || "Unable to list knowledge sources.");
    }

    return (data || []).map(mapKnowledgeSourceRow).filter((source: KnowledgeSource) => source.businessId === businessId && source.status !== "deleted");
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
    limit = 5
  ): Promise<KnowledgeSearchMatch[]> {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) return [];

    const normalizedBusinessId = Number(businessId);
    if (!Number.isSafeInteger(normalizedBusinessId) || normalizedBusinessId <= 0) {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 5, 10));

    const { data, error } = await this.client.rpc("search_knowledge_chunks", {
      p_business_id: normalizedBusinessId,
      p_query: normalizedQuery,
      p_limit: normalizedLimit,
    });

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
    limit = 5
  ): Promise<KnowledgeSearchMatch[]> {
    await this.ensureInitialized();

    const normalizedBusinessId = Number(businessId);
    const normalizedQuery = String(query || "").trim();

    if (
      !Number.isSafeInteger(normalizedBusinessId) ||
      normalizedBusinessId <= 0 ||
      !normalizedQuery
    ) {
      return [];
    }

    console.log("Knowledge search", {
      businessId: normalizedBusinessId,
      queryLength: normalizedQuery.length,
    });

    const matches = await this.storage.search(normalizedBusinessId, normalizedQuery, Math.max(1, Math.min(Number(limit) || 5, 10)));
    return this.filterCurrentMatches(normalizedBusinessId, matches);
  }

  async semanticSearch(
    businessId: number,
    query: string,
    limit = 5,
    minSimilarity = 0.55
  ): Promise<KnowledgeSearchMatch[]> {
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
        // Existing Google vectors are incompatible. Search a read-only, tenant-scoped
        // OpenAI index instead; source text/IDs and the cosine threshold stay intact.
        const chunks = await this.semanticCorpus(normalizedBusinessId);
        const matches = await this.compatibleSemanticIndex.search(
          normalizedBusinessId, chunks, embedding, this.embeddingProvider, safeLimit, minSimilarity,
        );
        // Do not return evidence that changed or was disabled/deleted during embedding.
        const currentChunks = await this.semanticCorpus(normalizedBusinessId);
        return semanticCorpusFingerprint(chunks) === semanticCorpusFingerprint(currentChunks) ? this.filterCurrentMatches(normalizedBusinessId, matches) : [];
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

  async sourceLanguageHints(businessId: number): Promise<SourceLanguage[]> {
    await this.ensureInitialized();
    if (!Number.isSafeInteger(businessId) || businessId <= 0) return [];
    const languages = new Set<SourceLanguage>(); let samples = 0;
    let timer: ReturnType<typeof setTimeout>;
    const listed = await Promise.race([
      this.storage.list(businessId).catch(() => [] as KnowledgeSource[]),
      new Promise<KnowledgeSource[]>(resolve => { timer = setTimeout(() => resolve([]), 500); }),
    ]).finally(() => clearTimeout(timer));
    const sources = listed.filter(s => s.businessId === businessId && s.status === 'ready').slice(0, 50);
    for (const source of sources) {
      const texts = source.type === 'document' ? documentCorpus(source).slice(0, 2).map(c => c.text) : [source.content];
      for (const text of texts) for (const paragraph of String(text).slice(0, 4000).split(/\n+/u).slice(0, 4)) {
        if (++samples > 100) return [...languages];
        const language = confirmedTextLanguage(paragraph.slice(0, 1600));
        if (language) languages.add(language);
      }
    }
    return [...languages];
  }

  /** OpenAI: one query batch, one corpus pass, original threshold and authority.
   * Other providers retain their existing single-query behavior/request shape.
   */
  async semanticSearchQueries(businessId: number, queries: string[], limit = 5): Promise<KnowledgeSearchMatch[]> {
    await this.ensureInitialized();
    const seen = new Set<string>();
    const bounded = queries.slice(0, MAX_SEMANTIC_QUERIES).map(q => String(q).trim()).filter(q => {
      const key = normalizeSemanticQuery(q);
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (!Number.isSafeInteger(businessId) || businessId <= 0 || !bounded.length || bounded[0].length > 4000 || bounded.slice(1).some(q => q.length > 120) || !this.embeddingProvider) return [];
    if (!this.embeddingProvider.supportsLocalSemanticSearch) return this.semanticSearch(businessId, bounded[0], limit);
    try {
      const embeddings = await this.embeddingProvider.embedDocuments(bounded);
      if (embeddings.length !== bounded.length || embeddings.some(e => e.provider !== 'openai')) return [];
      const corpus = await this.semanticCorpus(businessId);
      const chunks = corpus.filter(chunk => !explicitlyWrongWorkflow(chunk.text, bounded[0]));
      const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
      const sets = await this.compatibleSemanticIndex.searchQueries(businessId, chunks, embeddings, this.embeddingProvider, safeLimit, 0.55);
      if (semanticCorpusFingerprint(corpus) !== semanticCorpusFingerprint(await this.semanticCorpus(businessId))) return [];
      const ranked = new Map<string, { match: KnowledgeSearchMatch; rank: number }>();
      for (const set of sets) for (const [position, match] of set.entries()) {
        const key = `${match.sourceId}:${match.text}`;
        const prior = ranked.get(key);
        ranked.set(key, { match: prior && Number(prior.match.score) > Number(match.score) ? prior.match : match,
          rank: (prior?.rank || 0) + 1 / (60 + position + 1) });
      }
      return this.filterCurrentMatches(businessId, [...ranked.values()].sort((a, b) => b.rank - a.rank).slice(0, safeLimit).map(e => e.match));
    } catch {
      console.warn('Planned semantic Knowledge unavailable; lexical fallback remains available.');
      return [];
    }
  }

  async validateMatches(businessId: number, matches: KnowledgeSearchMatch[], options: { strictSources?: boolean; captureRevision?: boolean } = {}): Promise<KnowledgeSearchMatch[]> {
    await this.ensureInitialized();
    return this.filterCurrentMatches(businessId, matches, options);
  }

  private async filterCurrentMatches(businessId: number, matches: KnowledgeSearchMatch[], options: { strictSources?: boolean; captureRevision?: boolean } = {}): Promise<KnowledgeSearchMatch[]> {
    const ready = new Map((await this.storage.list(businessId)).filter((s) => s.businessId === businessId && s.status === "ready").map((s) => [s.id, s]));
    return matches.flatMap((match) => {
      const source = ready.get(match.sourceId);
      if (match.businessId !== businessId || !source) return [];
      if (source.type !== "document") {
        if (!options.strictSources) return [match];
        const revision = crypto.createHash('sha256').update(JSON.stringify([source.id, source.businessId, source.type, source.status, source.title, source.content, source.updatedAt, source.metadata])).digest('hex');
        if (!chunkKnowledgeContent(source.content).some(chunk => chunk.content === String(match.text || '').trim())) return [];
        if (match.metadata?.sourceRevision !== revision && (!options.captureRevision || match.metadata?.sourceRevision)) return [];
        return [{ ...match, metadata: { ...match.metadata, sourceRevision: revision } }];
      }
      const revision = documentRevision(source);
      if (match.metadata?.documentRevision && match.metadata.documentRevision !== revision) return [];
      const canonical = documentCorpus(source).find((chunk) => chunk.text === String(match.text || "").trim() &&
        (match.metadata?.page === undefined || match.metadata.page === chunk.metadata?.page) &&
        (match.metadata?.sheet === undefined || match.metadata.sheet === chunk.metadata?.sheet));
      return canonical ? [{ ...match, text: canonical.text, metadata: { ...canonical.metadata, documentRevision: revision } }] : [];
    });
  }

  private async semanticCorpus(businessId: number, documentsOnly = false): Promise<SemanticChunk[]> {
    const sources = await this.storage.list(businessId);
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
