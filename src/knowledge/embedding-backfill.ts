import type {
  EmbeddingProvider,
  EmbeddingVector,
} from "../ai/embeddings";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_VERSION,
} from "../ai/embeddings";

export const KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY = {
  provider: "google",
  model: DEFAULT_EMBEDDING_MODEL,
  dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  version: DEFAULT_EMBEDDING_VERSION,
} as const;

export type KnowledgeBackfillEmbeddingIdentity =
  typeof KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY;

export interface KnowledgeBackfillChunkSnapshot {
  id: string;
  businessId: number;
  sourceId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[] | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingVersion: number | null;
}

export interface KnowledgeBackfillSourceSnapshot {
  businessId: number;
  sourceId: string;
  status: "ready";
  snapshotToken: string;
  chunks: KnowledgeBackfillChunkSnapshot[];
}

export interface KnowledgeBackfillSourceInspection {
  businessId: number;
  sourceId: string;
  status: "ready";
  chunkCount: number;
  expectedEmbeddingChunkCount: number;
  missingEmbeddingChunkCount: number;
}

export interface KnowledgeBackfillPayloadChunk {
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number;
  embedding_version: number;
}

export interface KnowledgeEmbeddingBackfillRepository {
  inspectReadySource(
    businessId: number,
    sourceId: string,
    identity: KnowledgeBackfillEmbeddingIdentity,
  ): Promise<KnowledgeBackfillSourceInspection | null>;
  readReadySourceForWrite(
    businessId: number,
    sourceId: string,
  ): Promise<KnowledgeBackfillSourceSnapshot | null>;
  backfillIfUnchanged(params: {
    businessId: number;
    sourceId: string;
    expectedSnapshotToken: string;
    expectedUpdateCount: number;
    identity: KnowledgeBackfillEmbeddingIdentity;
    chunks: KnowledgeBackfillPayloadChunk[];
  }): Promise<number>;
}

export interface KnowledgeEmbeddingBackfillSummary {
  mode: "dry_run" | "write";
  businessId: number;
  sourceId: string;
  sourceCount: 1;
  chunkCount: number;
  skippedExpectedChunkCount: number;
  missingEmbeddingChunkCount: number;
  incompatibleEmbeddingChunkCount: number;
  pendingEmbeddingChunkCount: number;
  updatedChunkCount: number;
  writePerformed: boolean;
}

export class KnowledgeEmbeddingBackfillError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "KnowledgeEmbeddingBackfillError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidEmbedding(
  values: unknown,
  dimensions: number,
): values is number[] {
  return Array.isArray(values) &&
    values.length === dimensions &&
    values.every((value) =>
      typeof value === "number" && Number.isFinite(value)
    );
}

function isExpectedEmbedding(
  chunk: KnowledgeBackfillChunkSnapshot,
  identity: KnowledgeBackfillEmbeddingIdentity,
): boolean {
  return isValidEmbedding(chunk.embedding, identity.dimensions) &&
    chunk.embeddingProvider === identity.provider &&
    chunk.embeddingModel === identity.model &&
    chunk.embeddingDimensions === identity.dimensions &&
    chunk.embeddingVersion === identity.version;
}

function validateScope(businessId: number, sourceId: string): void {
  if (!Number.isSafeInteger(businessId) || businessId <= 0) {
    throw new KnowledgeEmbeddingBackfillError("invalid_business_id");
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sourceId)) {
    throw new KnowledgeEmbeddingBackfillError("invalid_source_id");
  }
}

function validateSnapshot(
  snapshot: KnowledgeBackfillSourceSnapshot,
  businessId: number,
  sourceId: string,
): void {
  if (
    snapshot.businessId !== businessId ||
    snapshot.sourceId !== sourceId ||
    snapshot.status !== "ready" ||
    !snapshot.snapshotToken
  ) {
    throw new KnowledgeEmbeddingBackfillError("invalid_source_snapshot");
  }

  const seenIndexes = new Set<number>();
  let previousIndex = -1;

  for (const chunk of snapshot.chunks) {
    if (
      chunk.businessId !== businessId ||
      chunk.sourceId !== sourceId ||
      !Number.isSafeInteger(chunk.chunkIndex) ||
      chunk.chunkIndex < 0 ||
      chunk.chunkIndex < previousIndex ||
      seenIndexes.has(chunk.chunkIndex) ||
      !String(chunk.content || "").trim() ||
      !isPlainObject(chunk.metadata)
    ) {
      throw new KnowledgeEmbeddingBackfillError("invalid_chunk_snapshot");
    }

    previousIndex = chunk.chunkIndex;
    seenIndexes.add(chunk.chunkIndex);
  }
}

function validateInspection(
  inspection: KnowledgeBackfillSourceInspection,
  businessId: number,
  sourceId: string,
): void {
  const counts = [
    inspection.chunkCount,
    inspection.expectedEmbeddingChunkCount,
    inspection.missingEmbeddingChunkCount,
  ];

  if (
    inspection.businessId !== businessId ||
    inspection.sourceId !== sourceId ||
    inspection.status !== "ready" ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    inspection.expectedEmbeddingChunkCount +
        inspection.missingEmbeddingChunkCount >
      inspection.chunkCount
  ) {
    throw new KnowledgeEmbeddingBackfillError("invalid_source_inspection");
  }
}

function validateGeneratedEmbedding(
  embedding: EmbeddingVector,
  identity: KnowledgeBackfillEmbeddingIdentity,
): void {
  if (
    embedding.provider !== identity.provider ||
    embedding.model !== identity.model ||
    embedding.dimensions !== identity.dimensions ||
    embedding.version !== identity.version ||
    !isValidEmbedding(embedding.values, identity.dimensions)
  ) {
    throw new KnowledgeEmbeddingBackfillError("invalid_generated_embedding");
  }
}

function validateCompletePayload(
  snapshot: KnowledgeBackfillSourceSnapshot,
  payload: KnowledgeBackfillPayloadChunk[],
  identity: KnowledgeBackfillEmbeddingIdentity,
): void {
  if (payload.length !== snapshot.chunks.length) {
    throw new KnowledgeEmbeddingBackfillError("incomplete_backfill_payload");
  }

  for (let index = 0; index < snapshot.chunks.length; index += 1) {
    const original = snapshot.chunks[index];
    const candidate = payload[index];

    if (
      candidate.chunk_index !== original.chunkIndex ||
      candidate.content !== original.content ||
      candidate.metadata !== original.metadata ||
      candidate.embedding_provider !== identity.provider ||
      candidate.embedding_model !== identity.model ||
      candidate.embedding_dimensions !== identity.dimensions ||
      candidate.embedding_version !== identity.version ||
      !isValidEmbedding(candidate.embedding, identity.dimensions)
    ) {
      throw new KnowledgeEmbeddingBackfillError("invalid_backfill_payload");
    }
  }
}

async function generateEmbeddings(
  chunks: KnowledgeBackfillChunkSnapshot[],
  embeddingProvider: EmbeddingProvider,
  identity: KnowledgeBackfillEmbeddingIdentity,
): Promise<Map<number, number[]>> {
  const generated = new Map<number, number[]>();
  const batchSize = 20;

  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    let embeddings: EmbeddingVector[];

    try {
      embeddings = await embeddingProvider.embedDocuments(
        batch.map((chunk) => chunk.content),
      );
    } catch {
      throw new KnowledgeEmbeddingBackfillError("embedding_generation_failed");
    }

    if (embeddings.length !== batch.length) {
      throw new KnowledgeEmbeddingBackfillError("embedding_result_count_mismatch");
    }

    embeddings.forEach((embedding, index) => {
      validateGeneratedEmbedding(embedding, identity);
      generated.set(batch[index].chunkIndex, embedding.values);
    });
  }

  return generated;
}

export async function runKnowledgeEmbeddingBackfill(params: {
  businessId: number;
  sourceId: string;
  write?: boolean;
  repository: KnowledgeEmbeddingBackfillRepository;
  embeddingProvider?: EmbeddingProvider;
  identity?: KnowledgeBackfillEmbeddingIdentity;
}): Promise<KnowledgeEmbeddingBackfillSummary> {
  const businessId = Number(params.businessId);
  const sourceId = String(params.sourceId || "").trim();
  const write = params.write === true;
  const identity =
    params.identity || KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY;

  validateScope(businessId, sourceId);

  if (!write) {
    let inspection: KnowledgeBackfillSourceInspection | null;
    try {
      inspection = await params.repository.inspectReadySource(
        businessId,
        sourceId,
        identity,
      );
    } catch {
      throw new KnowledgeEmbeddingBackfillError("knowledge_inspection_failed");
    }

    if (!inspection) {
      throw new KnowledgeEmbeddingBackfillError(
        "ready_knowledge_source_not_found",
      );
    }

    validateInspection(inspection, businessId, sourceId);

    const incompatibleEmbeddingChunkCount =
      inspection.chunkCount -
      inspection.expectedEmbeddingChunkCount -
      inspection.missingEmbeddingChunkCount;

    return {
      mode: "dry_run",
      businessId,
      sourceId,
      sourceCount: 1,
      chunkCount: inspection.chunkCount,
      skippedExpectedChunkCount: inspection.expectedEmbeddingChunkCount,
      missingEmbeddingChunkCount: inspection.missingEmbeddingChunkCount,
      incompatibleEmbeddingChunkCount,
      pendingEmbeddingChunkCount:
        inspection.chunkCount - inspection.expectedEmbeddingChunkCount,
      updatedChunkCount: 0,
      writePerformed: false,
    };
  }

  let snapshot: KnowledgeBackfillSourceSnapshot | null;
  try {
    snapshot = await params.repository.readReadySourceForWrite(
      businessId,
      sourceId,
    );
  } catch {
    throw new KnowledgeEmbeddingBackfillError("knowledge_snapshot_read_failed");
  }

  if (!snapshot) {
    throw new KnowledgeEmbeddingBackfillError("ready_knowledge_source_not_found");
  }

  validateSnapshot(snapshot, businessId, sourceId);

  const expectedChunks = snapshot.chunks.filter((chunk) =>
    isExpectedEmbedding(chunk, identity)
  );
  const pendingChunks = snapshot.chunks.filter((chunk) =>
    !isExpectedEmbedding(chunk, identity)
  );
  const missingEmbeddingChunkCount = pendingChunks.filter((chunk) =>
    chunk.embedding == null
  ).length;
  const incompatibleEmbeddingChunkCount =
    pendingChunks.length - missingEmbeddingChunkCount;

  const baseSummary = {
    businessId,
    sourceId,
    sourceCount: 1 as const,
    chunkCount: snapshot.chunks.length,
    skippedExpectedChunkCount: expectedChunks.length,
    missingEmbeddingChunkCount,
    incompatibleEmbeddingChunkCount,
    pendingEmbeddingChunkCount: pendingChunks.length,
  };

  if (pendingChunks.length === 0) {
    return {
      mode: "write",
      ...baseSummary,
      updatedChunkCount: 0,
      writePerformed: false,
    };
  }

  if (!params.embeddingProvider) {
    throw new KnowledgeEmbeddingBackfillError("embedding_provider_required");
  }

  const generated = await generateEmbeddings(
    pendingChunks,
    params.embeddingProvider,
    identity,
  );

  const payload = snapshot.chunks.map((chunk) => ({
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    metadata: chunk.metadata,
    embedding:
      generated.get(chunk.chunkIndex) || chunk.embedding || [],
    embedding_provider: identity.provider,
    embedding_model: identity.model,
    embedding_dimensions: identity.dimensions,
    embedding_version: identity.version,
  }));

  validateCompletePayload(snapshot, payload, identity);

  let updatedChunkCount: number;
  try {
    updatedChunkCount = await params.repository.backfillIfUnchanged({
      businessId,
      sourceId,
      expectedSnapshotToken: snapshot.snapshotToken,
      expectedUpdateCount: pendingChunks.length,
      identity,
      chunks: payload,
    });
  } catch (error) {
    if (error instanceof KnowledgeEmbeddingBackfillError) throw error;
    throw new KnowledgeEmbeddingBackfillError("guarded_backfill_write_failed");
  }

  if (updatedChunkCount !== pendingChunks.length) {
    throw new KnowledgeEmbeddingBackfillError("unexpected_backfill_update_count");
  }

  return {
    mode: "write",
    ...baseSummary,
    updatedChunkCount,
    writePerformed: true,
  };
}

function parseStoredEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.map(Number);
  }

  if (typeof value !== "string" || !value.startsWith("[") || !value.endsWith("]")) {
    return null;
  }

  const body = value.slice(1, -1).trim();
  if (!body) return [];

  const parsed = body.split(",").map((coordinate) => Number(coordinate));
  return parsed.every(Number.isFinite) ? parsed : null;
}

export class SupabaseKnowledgeEmbeddingBackfillRepository
  implements KnowledgeEmbeddingBackfillRepository {
  constructor(private readonly client: any) {}

  async inspectReadySource(
    businessId: number,
    sourceId: string,
    identity: KnowledgeBackfillEmbeddingIdentity,
  ): Promise<KnowledgeBackfillSourceInspection | null> {
    const { data: source, error: sourceError } = await this.client
      .from("knowledge_sources")
      .select("id,business_id,status")
      .eq("business_id", businessId)
      .eq("id", sourceId)
      .eq("status", "ready")
      .maybeSingle();

    if (sourceError) {
      throw new KnowledgeEmbeddingBackfillError("knowledge_inspection_failed");
    }
    if (!source) return null;

    const baseChunkCountQuery = () => this.client
      .from("knowledge_chunks")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("source_id", sourceId);

    const [allChunks, expectedChunks, missingChunks] = await Promise.all([
      baseChunkCountQuery(),
      baseChunkCountQuery()
        .not("embedding", "is", null)
        .eq("embedding_provider", identity.provider)
        .eq("embedding_model", identity.model)
        .eq("embedding_dimensions", identity.dimensions)
        .eq("embedding_version", identity.version),
      baseChunkCountQuery().is("embedding", null),
    ]);

    if (allChunks.error || expectedChunks.error || missingChunks.error) {
      throw new KnowledgeEmbeddingBackfillError("knowledge_inspection_failed");
    }

    return {
      businessId: Number(source.business_id),
      sourceId: String(source.id),
      status: "ready",
      chunkCount: Number(allChunks.count || 0),
      expectedEmbeddingChunkCount: Number(expectedChunks.count || 0),
      missingEmbeddingChunkCount: Number(missingChunks.count || 0),
    };
  }

  async readReadySourceForWrite(
    businessId: number,
    sourceId: string,
  ): Promise<KnowledgeBackfillSourceSnapshot | null> {
    const { data, error } = await this.client.rpc(
      "read_knowledge_embedding_backfill_source",
      {
        p_business_id: businessId,
        p_source_id: sourceId,
      },
    );

    if (error) {
      throw new KnowledgeEmbeddingBackfillError("knowledge_snapshot_read_failed");
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    const rawChunks = Array.isArray(row.chunks) ? row.chunks : [];

    return {
      businessId: Number(row.business_id),
      sourceId: String(row.source_id),
      status: "ready",
      snapshotToken: String(row.snapshot_token || ""),
      chunks: rawChunks.map((chunk: any) => ({
        id: String(chunk.id || ""),
        businessId: Number(chunk.business_id),
        sourceId: String(chunk.source_id || ""),
        chunkIndex: Number(chunk.chunk_index),
        content: String(chunk.content || ""),
        metadata: isPlainObject(chunk.metadata) ? chunk.metadata : {},
        embedding: parseStoredEmbedding(chunk.embedding),
        embeddingProvider:
          chunk.embedding_provider == null
            ? null
            : String(chunk.embedding_provider),
        embeddingModel:
          chunk.embedding_model == null
            ? null
            : String(chunk.embedding_model),
        embeddingDimensions:
          chunk.embedding_dimensions == null
            ? null
            : Number(chunk.embedding_dimensions),
        embeddingVersion:
          chunk.embedding_version == null
            ? null
            : Number(chunk.embedding_version),
      })),
    };
  }

  async backfillIfUnchanged(params: {
    businessId: number;
    sourceId: string;
    expectedSnapshotToken: string;
    expectedUpdateCount: number;
    identity: KnowledgeBackfillEmbeddingIdentity;
    chunks: KnowledgeBackfillPayloadChunk[];
  }): Promise<number> {
    const { data, error } = await this.client.rpc(
      "backfill_knowledge_chunk_embeddings_if_unchanged",
      {
        p_business_id: params.businessId,
        p_source_id: params.sourceId,
        p_expected_snapshot_token: params.expectedSnapshotToken,
        p_expected_update_count: params.expectedUpdateCount,
        p_embedding_provider: params.identity.provider,
        p_embedding_model: params.identity.model,
        p_embedding_dimensions: params.identity.dimensions,
        p_embedding_version: params.identity.version,
        p_chunks: params.chunks,
      },
    );

    if (error) {
      const message = String(error.message || "");
      if (message.includes("knowledge_backfill_snapshot_changed")) {
        throw new KnowledgeEmbeddingBackfillError(
          "knowledge_backfill_snapshot_changed",
        );
      }
      throw new KnowledgeEmbeddingBackfillError("guarded_backfill_write_failed");
    }

    return Number(data);
  }
}
