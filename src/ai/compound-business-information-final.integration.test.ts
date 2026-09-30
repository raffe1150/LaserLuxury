import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, test } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { Models } from '@google/genai';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const fact = fixture.sources[0].content;
const address = /kundentrén ligger på (.+)\.$/u.exec(fact)![1];
const exactLocationEvidence = /kundentrén ligger på .+\.$/u.exec(fact)![0];
const catalogPlan = buildConfiguredServiceCatalogPlan(fixture.business.services);
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-compound-final' });
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv); b.reset();
});
const scenarios = [
  ['de', 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?', `Sie finden uns in der ${address}.`, `Der Standort befindet sich in der ${address}.`],
  ['en', 'Hello! What services do you offer and where are you located?', `Our location is ${address}.`, `Our location is ${address}.`],
  ['sv', 'Hej! Var ligger ni och vilka tjänster erbjuder ni?', `Vår kundentré ligger på ${address}.`, `Vår kundentré ligger på ${address}.`],
  ['es', '¿Dónde están ubicados y qué servicios ofrecen?', `Nuestra ubicación es ${address}.`, `Nuestra ubicación es ${address}.`],
  ['fa', 'آدرستون کجاست و چه خدماتی دارید؟', `آدرس ما ${address} است.`, `آدرس ما ${address} است.`],
  ['ar', 'ما عنوانكم وما الخدمات التي تقدمونها؟', `عنواننا هو ${address}.`, `عنواننا هو ${address}.`],
] as const;
function claim(atomicClaim: string, candidateQuote: string, source: 'structured_business_config' | 'retrieved_knowledge', quote: string, supported = true) {
  return { claim: atomicClaim, candidateQuote, claimKind: 'OTHER' as const, requiresBusinessEvidence: true, supported,
    evidence: [{ source, quote }] };
}
function harness(t: any, language: string, question: string, quote: string, atomicClaim: string,
  relation = 'ENTAILED', citation = exactLocationEvidence, order = 'services-first', locationSupported = true, extraSupported = true) {
  const catalog = formatConfiguredServiceCatalogPlan(catalogPlan, language);
  const extra = 'Video Consultation costs 300 SEK.';
  const catalogClaim = claim(catalog, catalog, 'structured_business_config', '"name": "Video Consultation"');
  const unknown = claim(extra, extra, 'structured_business_config', '"price": 300', extraSupported);
  const locationClaim = claim(atomicClaim, quote, 'retrieved_knowledge', citation, locationSupported);
  const claims = order === 'location-first' ? [locationClaim, unknown, catalogClaim] : [catalogClaim, unknown, locationClaim];
  const candidate = order === 'location-first' ? `${quote}\n${extra}\n${catalog}` : `${catalog}\n${extra}\n${quote}`;
  const assessments: any[] = [], calls: any[] = [];
  let extractionCalls = 0;
  t.mock.method(console, 'info', () => {}); t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
  t.mock.method(Models.prototype as any, 'generateContentInternal', async () => { throw new Error('Gemini must not run'); });
  b.configure({ businessGroundingDiagnostic: value => assessments.push(value) });
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    const body = JSON.parse(params.input[0].content);
    const value = params.instructions.includes('strict business-response claim and citation extractor')
      ? (extractionCalls++, { hasBusinessFactualClaims: true, allBusinessClaimsSupported: claims.every(c => c.supported), claims })
      : (calls.push(body), { relation: body.atomicClaim === extra ? 'UNKNOWN' : body.atomicClaim === atomicClaim ? relation : 'ENTAILED',
          claimKind: 'OTHER', explicitAbsenceEvidence: false });
    return { output_text: JSON.stringify(value), output: [] } as any;
  });
  const id = `final-${language}`;
  b.businessInformationState(id, fixture.business, question, language, `source_id: ${fixture.sources[0].id}\n${fact}`);
  return { catalog, extra, candidate, assessments, calls, extractionCalls: () => extractionCalls, async run() {
    const recovered = await b.finalizeGeneralAiReply(id, question, candidate, language);
    const budget = b.finalConversationConcisionBudget(question);
    // All four production channel handlers apply these same functions after
    // grounding/recovery, whereas older guard-only tests stopped before this.
    const sent = b.finalConversationConcision(recovered, budget);
    return { recovered, sent, budget };
  } };
}
for (const [language, question, quote, atomicClaim] of scenarios) {
  test(`${language}: separately ENTAILED location survives UNKNOWN structured claim, authoritative catalog and final channel concision`, async t => {
    const h = harness(t, language, question, quote, atomicClaim);
    const { recovered, sent } = await h.run();
    assert.ok(recovered.includes(quote), 'recovery must preserve the verified quote');
    assert.ok(sent.includes(quote), 'the final channel presentation must preserve the verified quote');
    assert.ok(sent.includes(h.catalog));
    assert.equal(sent.includes(h.extra), false);
    assert.equal(h.assessments[0].verifiedEvidence, true);
    assert.equal(h.assessments[0].claimsEntailed, false);
    assert.equal(h.extractionCalls(), 1);
    assert.equal(h.calls.filter(r => r.atomicClaim === atomicClaim).length, 1);
    assert.equal(h.calls.filter(r => r.atomicClaim === h.extra).length, 3, 'UNKNOWN retains retry and adjudication, without emission');
    for (const service of catalogPlan.displayedServices) assert.equal(sent.split(service.name).length - 1, 1);
    assert.doesNotMatch(sent, /keine konkrete Angabe|can't find a specific answer|ingen specifik uppgift|No encuentro información específica|پاسخ مشخصی|لا أجد/);
    if (language === 'de') {
      assert.equal(quote.length, 40); assert.equal(exactLocationEvidence.length, 39); assert.equal(atomicClaim.length, 52);
      assert.equal(b.finalConversationConcision(recovered, 45).includes(address), false, 'reproduces the old presentation drop');
    }
  });
}
for (const [label, supported, relation, citation] of [
  ['unsupported location', false, 'ENTAILED', exactLocationEvidence],
  ['contradicted location', true, 'CONTRADICTED', exactLocationEvidence],
  ['fabricated citation', true, 'ENTAILED', 'This exact quote is absent from tenant knowledge.'],
] as const) {
  test(`${label}: location is omitted, catalog is authoritative and missing-topic handling remains`, async t => {
    const [language, question, quote, atomicClaim] = scenarios[0];
    const h = harness(t, language, question, quote, atomicClaim, relation, citation, 'services-first', supported);
    const { sent } = await h.run();
    assert.equal(sent.includes(address), false); assert.ok(sent.includes(h.catalog)); assert.equal(sent.includes(h.extra), false);
    assert.match(sent, /Standort\/die Adresse/);
    if (label !== 'contradicted location') assert.equal(h.calls.some(r => r.atomicClaim === atomicClaim), false, 'exact evidence gate precedes entailment');
    else assert.equal(h.calls.filter(r => r.atomicClaim === atomicClaim).length, 1);
  });
}
test('English reversed topic and claim order preserve both supported topics', async t => {
  const [, , quote, atomicClaim] = scenarios[1];
  const h = harness(t, 'en', 'Where are you located and what services do you offer?', quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'location-first');
  const { sent } = await h.run(); assert.ok(sent.includes(h.catalog)); assert.ok(sent.includes(quote)); assert.equal(sent.includes(h.extra), false);
});
test('a verified compound quote exceeding a finite word limit cannot be silently lost', async t => {
  const [language, question, location, atomicClaim] = scenarios[1];
  // Repeated presentation of the same proposition adds no new business fact.
  const quote = Array.from({ length: 8 }, () => location).join(' ');
  const h = harness(t, language, question, quote, atomicClaim);
  const { recovered, sent } = await h.run();
  assert.ok(recovered.split(/\s+/u).length > 90);
  assert.ok(sent.includes(quote)); assert.equal(sent.includes(h.extra), false);
});
test('recommendation, single services, single location and actual booking-action presentation budgets stay unchanged', () => {
  for (const [question, budget] of [
    ['What services do you offer?', 90], ['Where are you located?', 45],
    ['What services and location would you recommend for a first visit?', 90],
    ['What services do you offer and where are you located? Please book an appointment.', 45],
  ] as const) assert.equal(b.finalConversationConcisionBudget(question), budget);
});
test('single-topic services and location replies still require exact evidence and independent entailment', async t => {
  for (const [question, text, source, evidence] of [
    ['What services do you offer?', formatConfiguredServiceCatalogPlan(catalogPlan, 'en'), 'structured_business_config', '"name": "Video Consultation"'],
    ['Where are you located?', scenarios[1][2], 'retrieved_knowledge', exactLocationEvidence],
  ] as const) {
    let entailments = 0;
    b.configure({
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [claim(text, text, source, evidence)] }),
      assessBusinessClaimEntailment: async () => { entailments++; return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; },
    });
    b.businessInformationState('single-topic', fixture.business, question, 'en', fact);
    const grounded = await b.finalizeGeneralAiReply('single-topic', question, text, 'en');
    assert.equal(b.finalConversationConcision(grounded, b.finalConversationConcisionBudget(question)), text);
    assert.equal(entailments, 1);
    b.reset();
  }
});


test('unsupported extra structured claim does not leak or prevent the independently verified location', async t => {
  const [language, question, quote, atomicClaim] = scenarios[0];
  const h = harness(t, language, question, quote, atomicClaim, 'ENTAILED', exactLocationEvidence, 'services-first', true, false);
  const { sent } = await h.run();
  assert.ok(sent.includes(quote)); assert.ok(sent.includes(h.catalog)); assert.equal(sent.includes(h.extra), false);
  assert.equal(h.calls.some(r => r.atomicClaim === h.extra), false, 'unsupported extraction flag fails the exact-evidence gate');
});

test('recommendation catalog and natural clarification remain unchanged through final presentation', async () => {
  const question = 'Welche Dienstleistungen bieten Sie an und welche empfehlen Sie mir?';
  const catalog = formatConfiguredServiceCatalogPlan(catalogPlan, 'de');
  const text = `${catalog}\nWelches Ergebnis möchten Sie erreichen?`;
  let entailments = 0;
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [claim(catalog, catalog, 'structured_business_config', '"name": "Video Consultation"')] }),
    assessBusinessClaimEntailment: async () => { entailments++; return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }; },
  });
  b.businessInformationState('recommendation-final', fixture.business, question, 'de', fact);
  const grounded = await b.finalizeGeneralAiReply('recommendation-final', question, text, 'de');
  assert.equal(b.finalConversationConcisionBudget(question), 90);
  assert.equal(b.finalConversationConcision(grounded, b.finalConversationConcisionBudget(question)), text);
  assert.equal(entailments, 1);
});
