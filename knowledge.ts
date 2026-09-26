import crypto from "crypto";

export const KNOWLEDGE_SOURCE_TYPES = ["faq", "pdf", "website", "text"] as const;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];
export type KnowledgeSourceStatus = "pending" | "ready" | "disabled" | "error";
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

    return (data || []).map(mapKnowledgeSourceRow);
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

    const normalizedChunks = chunks.map((chunk) => ({
      chunk_index: chunk.chunkIndex,
      content: String(chunk.content || "").trim(),
      metadata: chunk.metadata || {},
    }));

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

export class KnowledgeService {
  private storage: KnowledgeStorage;
  private initialized = false;
  private readonly primaryStorage: KnowledgeStorage;
  private readonly fallbackStorage: KnowledgeStorage;

  constructor(
    primaryStorage: KnowledgeStorage = new InMemoryKnowledgeStorage(),
    fallbackStorage: KnowledgeStorage = new InMemoryKnowledgeStorage()
  ) {
    this.primaryStorage = primaryStorage;
    this.fallbackStorage = fallbackStorage;
    this.storage = primaryStorage;
  }

  async initialize(): Promise<void> {
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

    const chunks =
      savedSource.status === "ready"
        ? chunkKnowledgeContent(savedSource.content)
        : [];

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

    return this.storage.search(
      normalizedBusinessId,
      normalizedQuery,
      Math.max(1, Math.min(Number(limit) || 5, 10))
    );
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
  return value === "pending" || value === "ready" || value === "disabled" || value === "error";
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
