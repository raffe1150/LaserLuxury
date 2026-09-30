import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Models } from "@google/genai";
import { Embeddings } from "openai/resources/embeddings";
import { Responses } from "openai/resources/responses";
import { ConfiguredEmbeddingProvider } from "./embeddings";
import { embedWithOpenAi } from "./openai";
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from "../../../knowledge";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../../server");
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test-secret";
  boundary.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  boundary.reset();
});
const values = (axis = 0) => Array.from({ length: 768 }, (_, i) => i === axis ? 1 : 0);
const source = (id: string, businessId = 77, status: KnowledgeSource["status"] = "ready", content = "Customer parking is behind the studio."): KnowledgeSource => ({
  id, businessId, status, content, type: "text", title: id,
  createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", metadata: {},
});
function sdkMocks(t: any) {
  const inputs: string[][] = [];
  let googleCalls = 0;
  t.mock.method(Models.prototype as any, "embedContentInternal", async () => { googleCalls++; throw new Error("Google must not be called"); });
  t.mock.method(Embeddings.prototype, "create", async (request: any) => {
    assert.equal(request.model, "text-embedding-3-small");
    assert.equal(request.dimensions, 768);
    assert.equal(request.encoding_format, "float");
    inputs.push(request.input);
    return { data: request.input.map((text: string, index: number) => ({ index, embedding: values(text.includes("unrelated") ? 1 : 0) })) };
  });
  return { inputs, googleCalls: () => googleCalls };
}
async function fixture() {
  const storage = new InMemoryKnowledgeStorage();
  const provider = new ConfiguredEmbeddingProvider(() => "google-test-secret");
  const service = new KnowledgeService(storage, storage, provider);
  await storage.create(source("parking")); // Pre-existing corpus, with no OpenAI index.
  await storage.replaceChunks(77, "parking", [{ chunkIndex: 0, content: source("parking").content, metadata: {} }]);
  return { storage, service, provider };
}

test("OpenAI semantic search works on pre-existing knowledge, preserves evidence, never calls Gemini", async (t) => {
  const sdk = sdkMocks(t);
  const { service } = await fixture();
  const matches = await service.semanticSearch(77, "Where can I leave my car?");
  assert.deepEqual(matches, [{ sourceId: "parking", businessId: 77, text: "Customer parking is behind the studio.", metadata: {}, score: 1 }]);
  assert.deepEqual(sdk.inputs, [["Where can I leave my car?"], ["Customer parking is behind the studio."]]);
  assert.equal(sdk.googleCalls(), 0);
});

test("OpenAI ingestion uses the same configured embedding runtime", async (t) => {
  const sdk = sdkMocks(t);
  const { service, storage } = await fixture();
  let savedChunks: any[] = [];
  t.mock.method(storage, "replaceChunks", async (_businessId: number, _sourceId: string, chunks: any[]) => { savedChunks = chunks; });
  await service.addSource({ businessId: 77, type: "text", title: "Price", status: "ready", content: "Consultation costs 500 SEK." });
  assert.equal(savedChunks[0].embeddingProvider, "openai");
  assert.equal(savedChunks[0].embeddingDimensions, 768);
  assert.equal(sdk.inputs.length, 1);
  assert.equal(sdk.googleCalls(), 0);
});

test("OpenAI tenant isolation rejects foreign and unready sources even from malformed storage", async (t) => {
  const sdk = sdkMocks(t);
  const { service, storage } = await fixture();
  t.mock.method(storage, "list", async () => [source("parking"), source("foreign", 88, "ready", "Business B private knowledge"), source("disabled", 77, "disabled"), source("pending", 77, "pending")]);
  assert.deepEqual((await service.semanticSearch(77, "parking")).map((match) => match.sourceId), ["parking"]);
  assert.equal(JSON.stringify(sdk.inputs).includes("Business B"), false);
  assert.equal(sdk.googleCalls(), 0);
});

test("compatible cache is tenant scoped, reused, and invalidated on source changes/deletion", async (t) => {
  const sdk = sdkMocks(t);
  const { service, storage } = await fixture();
  await storage.create(source("business-b", 88, "ready", "Business B parking is outside."));
  await service.semanticSearch(77, "parking");
  await service.semanticSearch(77, "parking");
  assert.equal(sdk.inputs.length, 3); // Two queries, one corpus embedding.
  assert.equal((await service.semanticSearch(88, "parking"))[0].sourceId, "business-b");
  await storage.create(source("parking", 77, "ready", "Parking changed to courtyard."));
  assert.match((await service.semanticSearch(77, "parking"))[0].text!, /courtyard/);
  await storage.delete(77, "parking");
  assert.deepEqual(await service.semanticSearch(77, "parking"), []);
});

test("source disabled during embedding is never returned as evidence", async (t) => {
  sdkMocks(t);
  const { service, storage } = await fixture();
  let listCalls = 0;
  t.mock.method(storage, "list", async () => [source("parking", 77, ++listCalls === 1 ? "ready" : "disabled")]);
  assert.deepEqual(await service.semanticSearch(77, "parking"), []);
});

test("cosine threshold filters unrelated chunks and respects result limit", async (t) => {
  sdkMocks(t);
  const { service, storage } = await fixture();
  await storage.create(source("unrelated", 77, "ready", "unrelated knowledge"));
  await storage.create(source("second", 77, "ready", "Parking available outside."));
  assert.deepEqual((await service.semanticSearch(77, "parking", 1)).map((match) => match.sourceId), ["parking"]);
  assert.equal((await service.semanticSearch(77, "parking", 10)).length, 2);
});

for (const stage of ["query", "documents"] as const) {
  test(`OpenAI ${stage} failure preserves lexical fallback, never invokes Gemini, and logs no payload`, async (t) => {
    const sdk = sdkMocks(t);
    const { service } = await fixture();
    const logs: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
    let count = 0;
    t.mock.method(Embeddings.prototype, "create", async () => {
      if (++count === (stage === "query" ? 1 : 2)) throw new Error("sk-test-secret customer-prompt business-private-knowledge");
      return { data: [{ index: 0, embedding: values() }] };
    });
    assert.deepEqual(await service.semanticSearch(77, "customer-prompt"), []);
    assert.equal((await service.search(77, "parking"))[0].sourceId, "parking");
    assert.equal(sdk.googleCalls(), 0);
    assert.doesNotMatch(JSON.stringify(logs), /sk-test-secret|customer-prompt|business-private-knowledge/);
  });
}

test("Gemini retains the exact query embedding and persisted semantic lookup", async (t) => {
  process.env.AI_PROVIDER = "gemini";
  let openAiCalls = 0;
  t.mock.method(Embeddings.prototype, "create", async () => { openAiCalls++; throw new Error("OpenAI must not run"); });
  t.mock.method(Models.prototype as any, "embedContentInternal", async (request: any) => {
    assert.equal(request.model, "gemini-embedding-2");
    assert.deepEqual(request.contents, [{ role: "user", parts: [{ text: "Where can I park?" }] }]);
    assert.deepEqual(request.config, { outputDimensionality: 768 });
    return { embeddings: [{ values: values() }] };
  });
  const { service, storage } = await fixture();
  Object.assign(storage, { semanticSearch: async (businessId: number, embedding: any, limit: number, threshold: number) => {
    assert.equal(businessId, 77); assert.equal(embedding.provider, "google"); assert.equal(limit, 5); assert.equal(threshold, 0.55);
    return [{ sourceId: "parking", businessId, score: 0.9, text: "Parking is behind the studio." }];
  } });
  assert.equal((await service.semanticSearch(77, "Where can I park?"))[0].sourceId, "parking");
  assert.equal(openAiCalls, 0);
});

test("Gemini embedding failure remains lexical-only without OpenAI fallback", async (t) => {
  process.env.AI_PROVIDER = "gemini";
  let openAiCalls = 0;
  t.mock.method(Embeddings.prototype, "create", async () => { openAiCalls++; throw new Error("must not run"); });
  t.mock.method(Models.prototype as any, "embedContentInternal", async () => { throw new Error("402 depleted"); });
  const { service, storage } = await fixture();
  Object.assign(storage, { semanticSearch: async () => { throw new Error("must not run"); } });
  assert.deepEqual(await service.semanticSearch(77, "parking"), []);
  assert.equal((await service.search(77, "parking"))[0].sourceId, "parking");
  assert.equal(openAiCalls, 0);
});

test("OpenAI embedding normalization orders SDK results and rejects malformed vectors", async (t) => {
  t.mock.method(Embeddings.prototype, "create", async () => ({ data: [{ index: 1, embedding: values(1) }, { index: 0, embedding: values() }] }));
  assert.deepEqual((await embedWithOpenAi(["first", "second"])).map((v) => v.values), [values(), values(1)]);
  t.mock.method(Embeddings.prototype, "create", async () => ({ data: [{ index: 0, embedding: [NaN] }] }));
  await assert.rejects(() => embedWithOpenAi(["first"]), /invalid vector/);
});

test("OpenAI planning and real semantic search merge lexical evidence with source IDs intact", async (t) => {
  const sdk = sdkMocks(t);
  let googleGenerationCalls = 0;
  const { service } = await fixture();
  t.mock.method(Responses.prototype, "create", async (request: any) => {
    assert.match(request.instructions, /multilingual Knowledge retrieval query planner/);
    return { output_text: JSON.stringify({ canonicalMeaning: "parking location", queries: ["parking"] }) };
  });
  boundary.configure({
    geminiGenerate: async () => { googleGenerationCalls++; throw new Error("Gemini must not run"); },
    knowledgeSearch: async () => [{ sourceId: "hours", businessId: 77, score: 0.8, text: "The studio opens at 09:00." }],
    semanticKnowledgeSearch: (businessId: number, query: string, limit: number) => service.semanticSearch(businessId, query, limit),
  });
  const result = await boundary.retrieveBusinessKnowledge("Where can I leave my car?", { businessId: 77, id: 77 });
  assert.match(result, /source_id: parking/); assert.match(result, /source_id: hours/);
  assert.match(result, /Customer parking is behind the studio/);
  assert.equal(sdk.googleCalls(), 0); assert.equal(googleGenerationCalls, 0);
});

test("OpenAI semantic failure leaves completed lexical results in the actual retrieval pipeline", async (t) => {
  const sdk = sdkMocks(t);
  const { service } = await fixture();
  t.mock.method(Embeddings.prototype, "create", async () => { throw new Error("injected outage"); });
  t.mock.method(Responses.prototype, "create", async () => ({ output_text: '{"canonicalMeaning":"parking","queries":["parking"]}' }));
  boundary.configure({
    geminiGenerate: async () => { throw new Error("Gemini must not run"); },
    knowledgeSearch: (businessId: number, query: string, limit: number) => service.search(businessId, query, limit),
    semanticKnowledgeSearch: (businessId: number, query: string, limit: number) => service.semanticSearch(businessId, query, limit),
  });
  const result = await boundary.retrieveBusinessKnowledge("parking", { businessId: 77, id: 77 });
  assert.match(result, /source_id: parking/); assert.equal(sdk.googleCalls(), 0);
});

for (const compound of [false, true]) {
  test(`OpenAI semantic evidence preserves grounded ${compound ? "compound service/recommendation" : "factual service"} behavior`, async (t) => {
    const sdk = sdkMocks(t);
    const { service, storage } = await fixture();
    await storage.create(source("service-policy", 77, "ready", "Bring photo ID for Intro Facial."));
    t.mock.method(Responses.prototype, "create", async () => ({ output_text: '{"canonicalMeaning":"services","queries":["facial"]}' }));
    boundary.configure({
      knowledgeSearch: (businessId: number, query: string, limit: number) => service.search(businessId, query, limit),
      semanticKnowledgeSearch: (businessId: number, query: string, limit: number) => service.semanticSearch(businessId, query, limit),
    });
    const question = compound ? "What services do you offer and what do you recommend for a first-time visitor?" : "What services and prices do you offer?";
    const config = { id: 77, businessId: 77, businessName: "Verified Studio", language: "en", timezone: "Europe/Stockholm",
      systemPrompt: "Customers should bring photo ID.", services: [{ name: "Intro Facial", description: "A gentle introductory facial.", durationMinutes: 45, price: 650, currency: "SEK", active: true }] };
    const retrieved = await boundary.retrieveBusinessKnowledge(question, config);
    assert.match(retrieved, /source_id: service-policy/);
    boundary.businessInformationState("grounded-openai", config, question, "en", retrieved);
    const instruction = boundary.completedSupportInstruction("grounded-openai");
    assert.match(instruction, /SOURCE structured_business_config:[\s\S]*Intro Facial/);
    assert.match(instruction, /SOURCE business_system_prompt:[\s\S]*photo ID/);
    assert.match(instruction, /SOURCE retrieved_knowledge:[\s\S]*source_id: service-policy/);
    boundary.configure({
      assessBusinessSupportGrounding: async () => compound ? null : ({
        hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [{ claim: "Intro Facial costs 650 SEK.", candidateQuote: "Intro Facial costs 650 SEK.", claimKind: "OTHER",
          requiresBusinessEvidence: true, supported: true, evidence: [{ source: "structured_business_config", quote: '"price": 650' }] }],
      }),
      assessBusinessClaimEntailment: async () => ({ relation: "ENTAILED", claimKind: "OTHER", explicitAbsenceEvidence: false }),
    });
    const reply = await boundary.businessSupportGrounding("grounded-openai", question,
      compound ? "I recommend our Premium treatment." : "Intro Facial costs 650 SEK.", "en");
    assert.match(reply, /Intro Facial/); assert.match(reply, /650 SEK/);
    assert.doesNotMatch(reply, /Premium|999/);
    if (compound) assert.match(reply, /\?$/);
    assert.equal(sdk.googleCalls(), 0);
  });
}

test("OpenAI ingestion failure preserves lexical chunks without logging provider payload", async (t) => {
  const sdk = sdkMocks(t);
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  t.mock.method(Embeddings.prototype, "create", async () => { throw new Error("sk-test-secret private-knowledge customer-prompt"); });
  const { service } = await fixture();
  const saved = await service.addSource({ businessId: 77, type: "text", title: "Preparation", status: "ready", content: "Bring photo ID." });
  assert.equal((await service.search(77, "photo ID"))[0].sourceId, saved.id);
  assert.equal(sdk.googleCalls(), 0);
  assert.doesNotMatch(JSON.stringify(logs), /sk-test-secret|private-knowledge|customer-prompt/);
});

test("Gemini without a semantic-capable store retains its existing no-call behavior", async (t) => {
  process.env.AI_PROVIDER = "gemini";
  const sdk = sdkMocks(t);
  const { service } = await fixture();
  assert.deepEqual(await service.semanticSearch(77, "parking"), []);
  assert.equal(sdk.inputs.length, 0); assert.equal(sdk.googleCalls(), 0);
});
