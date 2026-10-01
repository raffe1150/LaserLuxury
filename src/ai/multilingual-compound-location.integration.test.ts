import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { businessInformationTopics, buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan,
  isBusinessAddressQuestion, isServiceCatalogQuestion } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const fact = fixture.sources[0].content;
const plan = buildConfiguredServiceCatalogPlan(fixture.business.services);
const cases = [
  ['en', 'Hello! What services do you offer and where are you located?', 'You can find us at Aurora Street 742.'],
  ['sv', 'Hej! Vilka tjänster erbjuder ni och var finns ni?', 'Ni hittar oss på Aurora Street 742.'],
  ['de', 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?', 'Sie finden uns in der Aurora Street 742.'],
  ['es', '¡Hola! ¿Qué servicios ofrecen y dónde están ubicados?', 'Nos encuentras en Aurora Street 742.'],
  ['ar', 'مرحباً! ما الخدمات التي تقدمونها وأين يقع مكانكم؟', 'تجدوننا في Aurora Street 742.'],
  ['fa', 'سلام! چه خدماتی دارید و کجا هستین؟', 'ما را در Aurora Street 742 پیدا می‌کنید.'],
] as const;
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-location-roles' });
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  b.reset();
});

function claim(text: string, source: string, quote: string, supported = true) {
  return { claim: text, candidateQuote: text, claimKind: 'OTHER' as const, requiresBusinessEvidence: true,
    supported, evidence: [{ source, quote }] };
}

async function enter(t: any, language: string, question: string, withLocation = true) {
  const queries: string[] = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(Responses.prototype, 'create', async () => ({
    output_text: JSON.stringify({ canonicalMeaning: 'customer question', queries: [question] }),
  }));
  b.configure({
    semanticLanguageResolver: async () => ({ language, requestedReplyLanguage: null, confidence: 1 }),
    knowledgeSearch: async (businessId: number, query: string) => {
      assert.equal(businessId, 3);
      queries.push(query);
      // Replay the existing lexical bridge, rather than giving every request
      // the address irrespective of whether its location role was recognized.
      return withLocation && query === 'kundentré adress' ? [{
        businessId: 3, sourceId: fixture.sources[0].id, text: fact, score: 1,
      }] : [];
    },
    semanticKnowledgeSearch: async () => [],
  });
  const sessionId = `location-role-${language}`;
  const result = await b.turn({ sessionId, platformName: 'whatsapp', recipientUserId: '46700000001',
    text: question, businessConfig: fixture.business });
  assert.equal(result.handled, false);
  return { sessionId, queries, state: b.businessInformationState(sessionId)! };
}

for (const [language, question, location] of cases) {
  test(`${language}: compound request keeps services and location roles before generation`, async t => {
    assert.deepEqual(businessInformationTopics(question), ['services', 'contact']);
    assert.equal(isBusinessAddressQuestion(question), true);
    assert.equal(isServiceCatalogQuestion(question), false, 'compound cannot enter service-only fallback');
    const h = await enter(t, language, question);
    assert.ok(h.queries.includes('kundentré adress'));
    assert.ok(h.state.retrievedKnowledge.includes('Aurora Street 742'));
    assert.equal(h.state.language, language);
    assert.equal(b.finalConversationConcisionBudget(question), Infinity);
  });

  for (const recover of [false, true]) {
    test(`${language}: verified natural location role survives ${recover ? 'partial recovery' : 'fully grounded normalization'} without false gap`, async t => {
      const h = await enter(t, language, question);
      const catalog = formatConfiguredServiceCatalogPlan(plan, language);
      const unknown = 'Every service has a guaranteed result.';
      const claims = [claim(catalog, 'structured_business_config', '"name": "Video Consultation"'),
        claim(location, 'retrieved_knowledge', fact),
        ...(recover ? [claim(unknown, 'structured_business_config', '', false)] : [])];
      b.configure({
        assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true,
          allBusinessClaimsSupported: !recover, claims }),
        assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
      });
      const candidate = `${catalog}\n${location}${recover ? `\n${unknown}` : ''}`;
      const grounded = await b.finalizeGeneralAiReply(h.sessionId, question, candidate, language);
      const presented = b.enforceAssistantIdentityLifecycle(b.suppressRepeatedPromotionalCta(h.sessionId, grounded), question, false);
      const sent = b.finalConversationConcision(presented, b.finalConversationConcisionBudget(question));
      assert.equal(sent, `${catalog}\n${location}`, 'keep the localized catalog/help continuation and exact verified location only');
      for (const service of plan.displayedServices) assert.equal(sent.split(`• ${service.name} (`).length - 1, 1);
      assert.equal(sent.split('Aurora Street 742').length - 1, 1);
      assert.equal(sent.includes(unknown), false);
      assert.doesNotMatch(sent, /can't find a specific answer|ingen specifik uppgift|keine konkrete Angabe|No encuentro información|پاسخ مشخصی|لا أجد/u);
    });
  }
}

test('Swedish incomplete catalog must still independently recover a verified location', async t => {
  const [language, question, location] = cases[1];
  const h = await enter(t, language, question);
  const offered = 'Vi erbjuder Video Consultation.';
  let assessments = 0;
  b.configure({
    assessBusinessSupportGrounding: async () => {
      assessments++;
      return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [claim(offered, 'structured_business_config', '"name": "Video Consultation"'), claim(location, 'retrieved_knowledge', fact)] };
    },
    assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
  });
  const result = await b.finalizeGeneralAiReply(h.sessionId, question, `${offered}\n${location}`, language);
  assert.ok(result.includes(location));
  assert.equal(assessments, 1, 'grounding must run rather than returning a service-only catalog early');
});

test('single services and single location retain their respective routing and presentation budgets', async t => {
  assert.deepEqual(businessInformationTopics('Vilka tjänster erbjuder ni?'), ['services']);
  assert.equal(isServiceCatalogQuestion('Vilka tjänster erbjuder ni?'), true);
  assert.equal(b.finalConversationConcisionBudget('Vilka tjänster erbjuder ni?'), 90);
  const h = await enter(t, 'sv', 'Var finns ni?');
  assert.deepEqual(businessInformationTopics('Var finns ni?'), ['contact']);
  assert.equal(isServiceCatalogQuestion('Var finns ni?'), false);
  assert.ok(h.state.retrievedKnowledge.includes('Aurora Street 742'));
  assert.equal(b.finalConversationConcisionBudget('Var finns ni?'), 45);
});

test('an unknown compound factual question must not fabricate an address or unsupported policy', async t => {
  const question = 'What services do you offer and what is your refund policy?';
  const h = await enter(t, 'en', question, false);
  assert.equal(h.queries.includes('kundentré adress'), false);
  b.configure({ assessBusinessSupportGrounding: async () => null });
  const result = await b.finalizeGeneralAiReply(h.sessionId, question, 'All refunds are free.', 'en');
  assert.ok(result.includes(formatConfiguredServiceCatalogPlan(plan, 'en')));
  assert.doesNotMatch(result, /Aurora Street 742|All refunds are free/u);
});

for (const text of [
  'Where can I find your services?', 'Var finns tjänsterna?',
  'Sie finden Ihren Termin in der Bestätigung.', 'Encuentras tu cita en el calendario.',
  'تجدون الخدمات في القائمة.', 'خدمات را در فهرست پیدا می‌کنید.',
]) {
  test(`finding a service or appointment does not introduce a business location role: ${text}`, () => {
    assert.equal(isBusinessAddressQuestion(text), false);
    assert.equal(businessInformationTopics(text).includes('contact'), false);
  });
}

test('single-location final reply preserves its independently grounded fact without a catalog', async t => {
  const question = 'Var finns ni?';
  const location = cases[1][2];
  const h = await enter(t, 'sv', question);
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [claim(location, 'retrieved_knowledge', fact)] }),
    assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
  });
  assert.equal(await b.finalizeGeneralAiReply(h.sessionId, question, location, 'sv'), location);
});

test('single-service final reply retains the complete configured catalog fallback', async t => {
  const question = 'Vilka tjänster erbjuder ni?';
  const h = await enter(t, 'sv', question, false);
  assert.equal(await b.finalizeGeneralAiReply(h.sessionId, question, 'Vi erbjuder Video Consultation.', 'sv'),
    formatConfiguredServiceCatalogPlan(plan, 'sv'));
});

test('saved German catalog-plus-gap shape cannot distinguish missing retrieval, extraction or rejected entailment', async t => {
  const [language, question, location] = cases[2];
  const catalog = formatConfiguredServiceCatalogPlan(plan, language);
  let firstReply: string | undefined;
  for (const failure of ['missing-retrieval', 'missing-assessment', 'contradicted-claim']) {
    b.reset();
    const h = await enter(t, language, question, failure !== 'missing-retrieval');
    const diagnostics: any[] = [];
    b.configure({
      assessBusinessSupportGrounding: async () => failure === 'missing-assessment' ? null : ({
        hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [claim(catalog, 'structured_business_config', '"name": "Video Consultation"'),
          claim(location, 'retrieved_knowledge', fact)],
      }),
      assessBusinessClaimEntailment: async request => ({
        relation: failure === 'contradicted-claim' && request.atomicClaim === location ? 'CONTRADICTED' : 'ENTAILED',
        claimKind: 'OTHER', explicitAbsenceEvidence: false,
      }),
      businessGroundingDiagnostic: value => diagnostics.push(value),
    });
    const reply = await b.finalizeGeneralAiReply(h.sessionId, question, `${catalog}\n${location}`, language);
    assert.ok(reply.startsWith(catalog));
    assert.match(reply, /keine konkrete Angabe.*Standort\/die Adresse/u);
    assert.doesNotMatch(reply, /Aurora Street 742/u);
    assert.equal(diagnostics.length, 1);
    if (firstReply === undefined) firstReply = reply;
    else assert.equal(reply, firstReply, 'same final reply despite distinct upstream failures');
  }
});
