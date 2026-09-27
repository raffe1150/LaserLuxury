import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { EmbeddingProvider } from "../ai/embeddings";
import {
  KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY,
  KnowledgeEmbeddingBackfillError,
  SupabaseKnowledgeEmbeddingBackfillRepository,
  runKnowledgeEmbeddingBackfill,
  type KnowledgeBackfillPayloadChunk,
  type KnowledgeBackfillSourceSnapshot,
  type KnowledgeEmbeddingBackfillRepository,
} from "./embedding-backfill";

const businessId = 77;
const sourceId = "11111111-1111-4111-8111-111111111111";

function vector(value: number): number[] {
  return Array(KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY.dimensions).fill(value);
}

function snapshot(params?: {
  firstEmbedded?: boolean;
  secondEmbedded?: boolean;
}): KnowledgeBackfillSourceSnapshot {
  const createChunk = (
    chunkIndex: number,
    content: string,
    metadata: Record<string, unknown>,
    embedded: boolean,
  ) => ({
    id: `${chunkIndex + 1}1111111-1111-4111-8111-111111111111`,
    businessId,
    sourceId,
    chunkIndex,
    content,
    metadata,
    embedding: embedded ? vector(0.25 + chunkIndex) : null,
    embeddingProvider: embedded ? "google" : null,
    embeddingModel: embedded ? "gemini-embedding-2" : null,
    embeddingDimensions: embedded ? 768 : null,
    embeddingVersion: embedded ? 1 : null,
  });

  return {
    businessId,
    sourceId,
    status: "ready",
    snapshotToken: "opaque-snapshot-token",
    chunks: [
      createChunk(
        0,
        "First stored Knowledge chunk.",
        { language: "en", nested: { preserved: true } },
        params?.firstEmbedded === true,
      ),
      createChunk(
        1,
        "Second stored Knowledge chunk.",
        { language: "sv", order: 2 },
        params?.secondEmbedded === true,
      ),
    ],
  };
}

function embeddingProvider(
  onEmbed?: (texts: string[]) => void,
): EmbeddingProvider {
  return {
    async embedDocuments(texts: string[]) {
      onEmbed?.(texts);
      return texts.map((_text, index) => ({
        values: vector(0.5 + index),
        ...KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY,
      }));
    },
    async embedQuery() {
      throw new Error("not used");
    },
  };
}

test("Knowledge embedding backfill defaults to a content-free dry run", async () => {
  let writeCalls = 0;
  let embedCalls = 0;
  let guardedReadCalls = 0;

  const repository: KnowledgeEmbeddingBackfillRepository = {
    async inspectReadySource() {
      return {
        businessId,
        sourceId,
        status: "ready",
        chunkCount: 2,
        expectedEmbeddingChunkCount: 1,
        missingEmbeddingChunkCount: 1,
      };
    },
    async readReadySourceForWrite() {
      guardedReadCalls += 1;
      throw new Error("guarded RPC must not be used for a dry run");
    },
    async backfillIfUnchanged() {
      writeCalls += 1;
      return 0;
    },
  };

  const summary = await runKnowledgeEmbeddingBackfill({
    businessId,
    sourceId,
    repository,
    embeddingProvider: embeddingProvider(() => {
      embedCalls += 1;
    }),
  });

  assert.deepEqual(summary, {
    mode: "dry_run",
    businessId,
    sourceId,
    sourceCount: 1,
    chunkCount: 2,
    skippedExpectedChunkCount: 1,
    missingEmbeddingChunkCount: 1,
    incompatibleEmbeddingChunkCount: 0,
    pendingEmbeddingChunkCount: 1,
    updatedChunkCount: 0,
    writePerformed: false,
  });
  assert.equal(embedCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(guardedReadCalls, 0);

  const report = JSON.stringify(summary);
  assert.doesNotMatch(report, /stored Knowledge|0\.25|api.?key/iu);
});

test("Supabase dry-run inspection uses existing tables without backfill RPCs", async () => {
  const rpcCalls: string[] = [];
  const selections: Array<{ table: string; columns: string }> = [];
  const client = {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let columns = "";
      const builder: any = {
        select(value: string) {
          columns = value;
          selections.push({ table, columns });
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push(["eq", column, value]);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          filters.push(["not", `${column}:${operator}`, value]);
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push(["is", column, value]);
          return builder;
        },
        async maybeSingle() {
          return {
            data: { id: sourceId, business_id: businessId, status: "ready" },
            error: null,
          };
        },
        then(resolve: (value: unknown) => void) {
          const isMissing = filters.some(([kind, column]) =>
            kind === "is" && column === "embedding"
          );
          const isExpected = filters.some(([kind, column]) =>
            kind === "not" && column === "embedding:is"
          );
          resolve({
            count: isMissing ? 1 : isExpected ? 1 : 3,
            error: null,
          });
        },
      };
      return builder;
    },
    async rpc(name: string) {
      rpcCalls.push(name);
      return { data: null, error: null };
    },
  };
  const repository = new SupabaseKnowledgeEmbeddingBackfillRepository(client);

  const inspection = await repository.inspectReadySource(
    businessId,
    sourceId,
    KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY,
  );

  assert.deepEqual(inspection, {
    businessId,
    sourceId,
    status: "ready",
    chunkCount: 3,
    expectedEmbeddingChunkCount: 1,
    missingEmbeddingChunkCount: 1,
  });
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(selections, [
    { table: "knowledge_sources", columns: "id,business_id,status" },
    { table: "knowledge_chunks", columns: "id" },
    { table: "knowledge_chunks", columns: "id" },
    { table: "knowledge_chunks", columns: "id" },
  ]);
});

test("Supabase write snapshot path requires the guarded read RPC", async () => {
  const rpcCalls: string[] = [];
  const client = {
    async rpc(name: string) {
      rpcCalls.push(name);
      return {
        data: name === "read_knowledge_embedding_backfill_source"
          ? {
              business_id: businessId,
              source_id: sourceId,
              snapshot_token: "guarded-token",
              chunks: [],
            }
          : null,
        error: null,
      };
    },
  };
  const repository = new SupabaseKnowledgeEmbeddingBackfillRepository(client);

  const current = await repository.readReadySourceForWrite(
    businessId,
    sourceId,
  );

  assert.equal(current?.snapshotToken, "guarded-token");
  assert.deepEqual(rpcCalls, ["read_knowledge_embedding_backfill_source"]);
});

test("write payload preserves chunk order, content, metadata, and source scope", async () => {
  const current = snapshot({ firstEmbedded: true });
  let embeddedTexts: string[] = [];
  let captured: Parameters<
    KnowledgeEmbeddingBackfillRepository["backfillIfUnchanged"]
  >[0] | null = null;

  const repository: KnowledgeEmbeddingBackfillRepository = {
    async inspectReadySource() {
      throw new Error("not used for write");
    },
    async readReadySourceForWrite() {
      return current;
    },
    async backfillIfUnchanged(params) {
      captured = params;
      return params.expectedUpdateCount;
    },
  };

  const summary = await runKnowledgeEmbeddingBackfill({
    businessId,
    sourceId,
    write: true,
    repository,
    embeddingProvider: embeddingProvider((texts) => {
      embeddedTexts = texts;
    }),
  });

  assert.deepEqual(embeddedTexts, ["Second stored Knowledge chunk."]);
  assert.ok(captured);
  assert.equal(captured.businessId, businessId);
  assert.equal(captured.sourceId, sourceId);
  assert.equal(captured.expectedSnapshotToken, "opaque-snapshot-token");
  assert.equal(captured.expectedUpdateCount, 1);
  assert.deepEqual(
    captured.chunks.map((chunk: KnowledgeBackfillPayloadChunk) => ({
      chunkIndex: chunk.chunk_index,
      content: chunk.content,
      metadata: chunk.metadata,
    })),
    current.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      metadata: chunk.metadata,
    })),
  );
  assert.deepEqual(captured.chunks[0].embedding, current.chunks[0].embedding);
  assert.equal(summary.skippedExpectedChunkCount, 1);
  assert.equal(summary.updatedChunkCount, 1);
  assert.equal(summary.writePerformed, true);
});

test("snapshot change aborts instead of overwriting newer chunks", async () => {
  const current = snapshot();
  let storedContent = current.chunks.map((chunk) => chunk.content);

  const repository: KnowledgeEmbeddingBackfillRepository = {
    async inspectReadySource() {
      throw new Error("not used for write");
    },
    async readReadySourceForWrite() {
      return current;
    },
    async backfillIfUnchanged() {
      storedContent = ["Newer content written by another operation."];
      throw new KnowledgeEmbeddingBackfillError(
        "knowledge_backfill_snapshot_changed",
      );
    },
  };

  await assert.rejects(
    () => runKnowledgeEmbeddingBackfill({
      businessId,
      sourceId,
      write: true,
      repository,
      embeddingProvider: embeddingProvider(),
    }),
    (error: any) =>
      error?.code === "knowledge_backfill_snapshot_changed",
  );

  assert.deepEqual(storedContent, [
    "Newer content written by another operation.",
  ]);
});

test("embedding validation failure performs no partial replacement", async () => {
  const current = snapshot();
  let writeCalls = 0;

  const repository: KnowledgeEmbeddingBackfillRepository = {
    async inspectReadySource() {
      throw new Error("not used for write");
    },
    async readReadySourceForWrite() {
      return current;
    },
    async backfillIfUnchanged() {
      writeCalls += 1;
      return 2;
    },
  };

  const invalidProvider: EmbeddingProvider = {
    async embedDocuments() {
      return [
        {
          values: vector(0.1),
          ...KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY,
        },
        {
          values: [0.2],
          ...KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY,
        },
      ];
    },
    async embedQuery() {
      throw new Error("not used");
    },
  };

  await assert.rejects(
    () => runKnowledgeEmbeddingBackfill({
      businessId,
      sourceId,
      write: true,
      repository,
      embeddingProvider: invalidProvider,
    }),
    (error: any) => error?.code === "invalid_generated_embedding",
  );

  assert.equal(writeCalls, 0);
});

test("rerun skips already backfilled chunks and performs no second write", async () => {
  let current = snapshot();
  let writeCalls = 0;
  let embedCalls = 0;

  const repository: KnowledgeEmbeddingBackfillRepository = {
    async inspectReadySource() {
      throw new Error("not used for write");
    },
    async readReadySourceForWrite() {
      return current;
    },
    async backfillIfUnchanged(params) {
      writeCalls += 1;
      current = {
        ...current,
        snapshotToken: "post-backfill-token",
        chunks: current.chunks.map((chunk, index) => ({
          ...chunk,
          embedding: params.chunks[index].embedding,
          embeddingProvider: params.identity.provider,
          embeddingModel: params.identity.model,
          embeddingDimensions: params.identity.dimensions,
          embeddingVersion: params.identity.version,
        })),
      };
      return params.expectedUpdateCount;
    },
  };
  const provider = embeddingProvider(() => {
    embedCalls += 1;
  });

  const first = await runKnowledgeEmbeddingBackfill({
    businessId,
    sourceId,
    write: true,
    repository,
    embeddingProvider: provider,
  });
  const second = await runKnowledgeEmbeddingBackfill({
    businessId,
    sourceId,
    write: true,
    repository,
    embeddingProvider: provider,
  });

  assert.equal(first.updatedChunkCount, 2);
  assert.equal(second.updatedChunkCount, 0);
  assert.equal(second.skippedExpectedChunkCount, 2);
  assert.equal(second.writePerformed, false);
  assert.equal(embedCalls, 1);
  assert.equal(writeCalls, 1);
});

test("guarded backfill migration validates and detects changes before its only write", () => {
  const sql = readFileSync(
    new URL(
      "../../supabase/migrations/20260927000939_add_guarded_knowledge_embedding_backfill.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const guardedFunction = sql.slice(
    sql.indexOf("create function public.backfill_knowledge_chunk_embeddings_if_unchanged"),
  );
  const sourceLock = guardedFunction.indexOf("for update;");
  const chunkTableLock = guardedFunction.indexOf(
    "lock table public.knowledge_chunks in share row exclusive mode",
  );
  const snapshotCheck = guardedFunction.indexOf(
    "knowledge_backfill_snapshot_changed",
  );
  const payloadValidation = guardedFunction.indexOf(
    "knowledge_backfill_content_changed",
  );
  const updateStatement = guardedFunction.indexOf(
    "update public.knowledge_chunks kc",
  );

  assert.match(
    guardedFunction,
    /lock table public\.knowledge_chunks in share row exclusive mode/iu,
  );
  assert.match(guardedFunction, /set lock_timeout = '5s'/iu);
  assert.match(
    guardedFunction,
    /p_embedding_dimensions is null\s+or p_embedding_dimensions <> 768/iu,
  );
  assert.ok(sourceLock >= 0 && sourceLock < chunkTableLock);
  assert.ok(snapshotCheck >= 0 && snapshotCheck < updateStatement);
  assert.ok(payloadValidation >= 0 && payloadValidation < updateStatement);
  assert.equal(
    (guardedFunction.match(/update public\.knowledge_chunks kc/giu) || []).length,
    1,
  );
  assert.doesNotMatch(guardedFunction, /delete from public\.knowledge/iu);
});
