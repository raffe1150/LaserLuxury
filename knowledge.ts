import crypto from "crypto";

export const KNOWLEDGE_SOURCE_TYPES = ["faq", "pdf", "website", "text"] as const;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];
export type KnowledgeSourceStatus = "pending" | "ready" | "disabled" | "error";
export type KnowledgeSourceMetadata = Record<string, unknown>;

export interface KnowledgeSource {
  id: string;
  type: KnowledgeSourceType;
  title: string;
  status: KnowledgeSourceStatus;
  createdAt: string;
  updatedAt: string;
  metadata: KnowledgeSourceMetadata;
}

export interface CreateKnowledgeSourceInput {
  type: KnowledgeSourceType;
  title: string;
  status?: KnowledgeSourceStatus;
  metadata?: KnowledgeSourceMetadata;
}

export interface KnowledgeSearchMatch {
  sourceId: string;
  score?: number;
  text?: string;
  metadata?: KnowledgeSourceMetadata;
}

export interface KnowledgeStorage {
  initialize(): Promise<void>;
  list(): Promise<KnowledgeSource[]>;
  create(source: KnowledgeSource): Promise<KnowledgeSource>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryKnowledgeStorage implements KnowledgeStorage {
  private readonly sources = new Map<string, KnowledgeSource>();

  async initialize(): Promise<void> {
    // No setup is required for the in-memory fallback.
  }

  async list(): Promise<KnowledgeSource[]> {
    return Array.from(this.sources.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  async create(source: KnowledgeSource): Promise<KnowledgeSource> {
    this.sources.set(source.id, source);
    return source;
  }

  async delete(id: string): Promise<boolean> {
    return this.sources.delete(id);
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

  async list(): Promise<KnowledgeSource[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select("id,type,title,status,created_at,updated_at,metadata")
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
        type: source.type,
        title: source.title,
        status: source.status,
        created_at: source.createdAt,
        updated_at: source.updatedAt,
        metadata: source.metadata,
      }])
      .select("id,type,title,status,created_at,updated_at,metadata")
      .single();

    if (error) {
      throw new Error(error.message || "Unable to add knowledge source.");
    }

    return mapKnowledgeSourceRow(data);
  }

  async delete(id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(this.tableName)
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      throw new Error(error.message || "Unable to delete knowledge source.");
    }

    return Array.isArray(data) && data.length > 0;
  }
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

  async reload(): Promise<KnowledgeSource[]> {
    await this.initialize();
    return this.storage.list();
  }

  async list(): Promise<KnowledgeSource[]> {
    await this.ensureInitialized();
    return this.storage.list();
  }

  async addSource(input: CreateKnowledgeSourceInput): Promise<KnowledgeSource> {
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const source: KnowledgeSource = {
      id: crypto.randomUUID(),
      type: input.type,
      title: input.title,
      status: input.status || "pending",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata || {},
    };

    const savedSource = await this.storage.create(source);
    console.log("Knowledge source added", { id: savedSource.id, type: savedSource.type });
    return savedSource;
  }

  async deleteSource(id: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.storage.delete(id);
  }

  async search(query: string): Promise<KnowledgeSearchMatch[]> {
    await this.ensureInitialized();
    console.log("Knowledge search", { queryLength: query.length });
    return [];
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
    type: row.type as KnowledgeSourceType,
    title: String(row.title || ""),
    status: (row.status || "pending") as KnowledgeSourceStatus,
    createdAt: String(row.created_at || row.createdAt || ""),
    updatedAt: String(row.updated_at || row.updatedAt || ""),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
