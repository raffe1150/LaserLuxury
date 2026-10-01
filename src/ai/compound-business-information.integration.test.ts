import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, test } from 'node:test';
import { Models } from '@google/genai';
import { Responses } from 'openai/resources/responses';
import { Embeddings } from 'openai/resources/embeddings';
import { InMemoryKnowledgeStorage, KnowledgeService, SupabaseKnowledgeStorage } from '../../knowledge';
import { ConfiguredEmbeddingProvider } from './providers/embeddings';
import { isSimpleCatalogLocationQuestion } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
// Read-only production snapshot; no credentials or customer records.
const snapshot = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const productionProbes = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3-retrieval.json', import.meta.url), 'utf8'));
const config = snapshot.business;
const locationFact = snapshot.sources[0].content;
const address = /kundentrén ligger på (.+)\.$/u.exec(locationFact)![1];
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.AI_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-offline-test';
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  b.reset();
});
function claim(text: string, source: string, quote: string, supported = true) {
  return { claim: text, candidateQuote: text, claimKind: 'OTHER', requiresBusinessEvidence: true,
    supported, evidence: supported ? [{ source, quote }] : [] };
}
function assess(claims: any[]) {
  return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: claims.every(c => c.supported), claims };
}
function configureAssessment(claims: any[], entailment?: (r: any) => any) {
  b.configure({
    assessBusinessSupportGrounding: async () => assess(claims),
    assessBusinessClaimEntailment: async r => entailment?.(r) || ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
  });
}
async function enter(t: any, question: string, language: string, withLocation = true) {
  let googleCalls = 0;
  t.mock.method(Models.prototype as any, 'embedContentInternal', async () => { googleCalls++; throw new Error('Gemini must not run'); });
  t.mock.method(Responses.prototype, 'create', async (params: any) => ({ output_text: params.instructions.includes('entailment gate')
    ? JSON.stringify({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false })
    : '{"canonicalMeaning":"services and location","queries":["services location"]}' }));
  t.mock.method(Embeddings.prototype, 'create', async (r: any) => ({ data: r.input.map((_: string, index: number) => ({ index, embedding: Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0) })) }));
  const storage = new InMemoryKnowledgeStorage();
  if (withLocation) {
    await storage.create(snapshot.sources[0]);
    await storage.replaceChunks(3, snapshot.sources[0].id, [{ chunkIndex: 0, content: locationFact, metadata: snapshot.sources[0].metadata }]);
  }
  // A second tenant must never enter the evidence corpus.
  await storage.create({ ...snapshot.sources[0], id: 'foreign', businessId: 99, content: 'Private foreign address Foreign Road 999.' });
  await storage.replaceChunks(99, 'foreign', [{ chunkIndex: 0, content: 'Private foreign address Foreign Road 999.', metadata: {} }]);
  const service = new KnowledgeService(storage, storage, new ConfiguredEmbeddingProvider(() => 'unused-google-key'));
  b.configure({
    knowledgeSearch: (id, query, limit) => service.search(id, query, limit),
    semanticLanguageResolver: async () => ({ language, requestedReplyLanguage: null, confidence: 1 }),
    semanticKnowledgeSearch: (id, query, limit) => service.semanticSearch(id, query, limit),
    geminiGenerate: async () => { googleCalls++; throw new Error('Gemini must not run'); },
  });
  const id = `compound-${language}`;
  const result = await b.turn({ sessionId: id, platformName: 'whatsapp', recipientUserId: id, text: question, businessConfig: config });
  assert.equal(result.handled, withLocation && isSimpleCatalogLocationQuestion(question));
  if (result.handled) {
    assert.ok(result.replies.join('\n').includes(address));
    assert.doesNotMatch(result.replies.join('\n'), /Foreign Road|Private foreign/);
  }
  const state = b.businessInformationState(id)!;
  assert.equal(state.language, language);
  const instruction = b.completedSupportInstruction(id);
  assert.match(instruction, /SOURCE structured_business_config:[\s\S]*Video Consultation/);
  if (withLocation) {
    assert.ok(state.retrievedKnowledge.includes(locationFact));
    assert.ok(state.retrievedKnowledge.includes(snapshot.sources[0].id));
  }
  assert.doesNotMatch(instruction, /Foreign Road|Private foreign/);
  assert.equal(googleCalls, 0);
  return { id, googleCalls: () => googleCalls };
}
const cases = [
  ['en', 'Hello! What services do you offer and where are you located?', 'We offer Video Consultation.', `Our customer entrance is at ${address}.`],
  ['de', 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?', 'Unsere Dienstleistungen umfassen Video Consultation.', `Unser Kundeneingang befindet sich in ${address}.`],
  ['sv', 'Hej! Vilka tjänster erbjuder ni och var ligger ni?', 'Våra tjänster omfattar Video Consultation.', `Vår kundentré ligger på ${address}.`],
] as const;
for (const [language, question, services, location] of cases) {
  test(`${language}: exact compound WhatsApp path merges structured services and tenant location`, async t => {
    const { id, googleCalls } = await enter(t, question, language);
    configureAssessment([claim(services, 'structured_business_config', '"name": "Video Consultation"'), claim(location, 'retrieved_knowledge', locationFact)]);
    const reply = await b.finalizeGeneralAiReply(id, question, `${services} ${location}`, language);
    for (const service of config.services.slice(0, 5)) {
      assert.ok(reply.includes(service.name));
      assert.equal(reply.split(service.name).length - 1, 1);
    }
    assert.ok(reply.includes(address));
    assert.doesNotMatch(reply, /can't find a specific answer|keine konkrete Angabe|ingen specifik uppgift/);
    assert.equal(googleCalls(), 0);
  });
  test(`${language}: known services survive unavailable location and uncovered limitation prose`, async t => {
    const { id } = await enter(t, question, language, false);
    configureAssessment([claim(services, 'structured_business_config', '"name": "Video Consultation"')]);
    const reply = await b.finalizeGeneralAiReply(id, question, `${services} I cannot verify the requested location.`, language);
    assert.match(reply, /Video Consultation/);
    assert.doesNotMatch(reply, /Aurora|question about services|Frage über die Dienstleistungen|fråga för tjänsterna/);
    assert.match(reply, language === 'en' ? /location|address/i : language === 'de' ? /Standort|Adresse/i : /plats|adress/i);
  });
}
test('compound catalog recovery survives missing assessment without inventing an address', async t => {
  const question = cases[0][1];
  const { id } = await enter(t, question, 'en', false);
  b.configure({ assessBusinessSupportGrounding: async () => null });
  const reply = await b.finalizeGeneralAiReply(id, question, 'I cannot answer that.', 'en');
  for (const service of config.services.slice(0, 5)) assert.ok(reply.includes(service.name));
  assert.match(reply, /300 SEK/);
  assert.match(reply, /location|address/i);
  assert.doesNotMatch(reply, /Aurora|question about services/);
});
test('inverse partial support preserves location and removes unsupported requested service fact', async t => {
  const question = 'Hello! What is the preparation for your Laser service and where are you located?';
  const { id } = await enter(t, question, 'en');
  const location = `Our customer entrance is at ${address}.`;
  const unsupported = 'Laser requires no preparation.';
  configureAssessment([claim(unsupported, 'structured_business_config', '', false), claim(location, 'retrieved_knowledge', locationFact)]);
  const reply = await b.finalizeGeneralAiReply(id, question, `${unsupported} ${location}`, 'en');
  assert.ok(reply.includes(address));
  assert.doesNotMatch(reply, /requires no preparation|Video Consultation/);
  assert.match(reply, /preparation/i);
});
test('one failed entailment does not discard another independently verified compound claim', async t => {
  const question = 'Hello! What are your prices and where are you located?';
  const { id } = await enter(t, question, 'en');
  const price = 'Video Consultation costs 999 SEK.';
  const location = `Our customer entrance is at ${address}.`;
  configureAssessment([claim(price, 'structured_business_config', '"price": 300'), claim(location, 'retrieved_knowledge', locationFact)], r => ({ relation: r.atomicClaim === price ? 'CONTRADICTED' : 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }));
  const reply = await b.finalizeGeneralAiReply(id, question, `${price} ${location}`, 'en');
  assert.ok(reply.includes(address));
  assert.doesNotMatch(reply, /999/);
  assert.match(reply, /prices/);
});
test('exact evidence safety rejects fabricated citations while preserving real structured evidence', async t => {
  const question = cases[0][1];
  const { id } = await enter(t, question, 'en');
  const services = cases[0][2];
  const fake = 'Our address is Foreign Road 999.';
  configureAssessment([claim(services, 'structured_business_config', '"name": "Video Consultation"'), claim(fake, 'retrieved_knowledge', fake)]);
  const reply = await b.finalizeGeneralAiReply(id, question, `${services} ${fake}`, 'en');
  assert.match(reply, /Video Consultation/);
  assert.doesNotMatch(reply, /Foreign Road|999/);
});
test('compound recovery never emits a verifier quote absent from the candidate', async t => {
  const question = 'Hello! What are your prices and where are you located?';
  const { id } = await enter(t, question, 'en');
  configureAssessment([claim(`Our address is ${address}.`, 'retrieved_knowledge', locationFact)]);
  const reply = await b.finalizeGeneralAiReply(id, question, 'The price is unknown.', 'en');
  assert.doesNotMatch(reply, /Aurora/);
});

for (const [, question] of cases.slice(0, 2)) {
  test(`production lexical RPC replay retrieves tenant 3 location during OpenAI outage: ${question}`, async t => {
    let googleCalls = 0;
    t.mock.method(Models.prototype as any, 'embedContentInternal', async () => { googleCalls++; throw new Error('must not run'); });
    t.mock.method(Responses.prototype, 'create', async () => ({ output_text: JSON.stringify({ canonicalMeaning: 'services and location', queries: [question] }) }));
    t.mock.method(Embeddings.prototype, 'create', async () => { throw new Error('injected OpenAI outage'); });
    const queries: string[] = [];
    const storage = new SupabaseKnowledgeStorage({ rpc: async (name: string, args: any) => {
      assert.equal(name, 'search_knowledge_chunks');
      assert.equal(args.p_business_id, 3);
      queries.push(args.p_query);
      return { data: productionProbes.find((p: any) => p.question === args.p_query)?.matches || [], error: null };
    } });
    t.mock.method(storage, 'initialize', async () => undefined);
    t.mock.method(storage, 'list', async (id: number) => {
      assert.equal(id, 3);
      return snapshot.sources;
    });
    const service = new KnowledgeService(storage, new InMemoryKnowledgeStorage(), new ConfiguredEmbeddingProvider(() => 'unused'));
    b.configure({
      knowledgeSearch: (id, query, limit) => service.search(id, query, limit),
      semanticKnowledgeSearch: (id, query, limit) => service.semanticSearch(id, query, limit),
      geminiGenerate: async () => { googleCalls++; throw new Error('must not run'); },
    });
    const retrieved = await b.retrieveBusinessKnowledge(question, config);
    assert.ok(retrieved.includes(locationFact));
    assert.ok(retrieved.includes(snapshot.sources[0].id));
    assert.ok(queries.includes('kundentré adress'));
    assert.equal(productionProbes.find((p: any) => p.question === question).matches, null);
    assert.equal(googleCalls, 0);
  });
}

for (const [question, supported, source, evidence, missing] of [
  ['Hello! What services do you offer and what are your opening hours?', 'We offer Video Consultation.', 'structured_business_config', '"name": "Video Consultation"', 'opening hours'],
  ['Hello! What contact details and opening hours do you have?', 'Contact us at studio@example.test.', 'business_system_prompt', 'Contact us at studio@example.test.', 'opening hours'],
  ['Hello! What are the opening hours and contact details?', 'Opening hours are 09:00 to 17:00.', 'business_system_prompt', 'Opening hours are 09:00 to 17:00.', 'contact details'],
  ['Hello! What service and preparation instructions apply to Video Consultation?', 'Preparation requires photo ID.', 'business_system_prompt', 'Preparation requires photo ID.', 'services'],
] as const) {
  test(`general compound partial recovery: ${question}`, async () => {
    const id = 'general-compound';
    b.businessInformationState(id, { ...config, systemPrompt: evidence }, question, 'en');
    configureAssessment([claim(supported, source, evidence)]);
    const reply = await b.finalizeGeneralAiReply(id, question, `${supported} Other details could not be verified.`, 'en');
    if (source === 'structured_business_config') {
      for (const service of config.services.slice(0, 5)) assert.ok(reply.includes(service.name));
    } else {
      assert.ok(reply.includes(supported));
    }
    assert.ok(reply.includes(missing));
    assert.doesNotMatch(reply, /Other details could not be verified/);
  });
}

test('negative absence claims keep the strict entailment gate in compound recovery', async t => {
  const question = 'Hello! What are your prices and where are you located?';
  const { id } = await enter(t, question, 'en');
  const unsupported = { ...claim('All services are free.', 'structured_business_config', '"price": 300'), claimKind: 'NEGATIVE_ABSENCE' };
  const location = `Our customer entrance is at ${address}.`;
  configureAssessment([unsupported, claim(location, 'retrieved_knowledge', locationFact)], r => ({
    relation: r.claimKind === 'NEGATIVE_ABSENCE' ? 'UNKNOWN' : 'ENTAILED',
    claimKind: r.claimKind, explicitAbsenceEvidence: false,
  }));
  const reply = await b.finalizeGeneralAiReply(id, question, `${unsupported.claim} ${location}`, 'en');
  assert.ok(reply.includes(address));
  assert.doesNotMatch(reply, /free/);
});
