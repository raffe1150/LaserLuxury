import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { APIError } from 'openai';
import { Responses } from 'openai/resources/responses';
import { AiReliabilityError } from './reliability';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const fact = fixture.sources[0].content;
const plan = buildConfiguredServiceCatalogPlan(fixture.business.services);
const addressFingerprint = createHash('sha256').update('aurora street 742').digest('hex').slice(0, 12);
const cases = [
  ['en', 'What services do you offer and where are you located?', 'You can find us at Aurora Street 742.', /cannot verify/u],
  ['sv', 'Hej! Vilka tjänster erbjuder ni och var finns ni?', 'Ni hittar oss på Aurora Street 742.', /kan inte verifiera/u],
  ['de', 'Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?', 'Sie finden uns in der Aurora Street 742.', /kann.*nicht überprüfen/u],
  ['es', '¿Qué servicios ofrecen y dónde están ubicados?', 'Nos encuentras en Aurora Street 742.', /No puedo verificar/u],
  ['ar', 'ما الخدمات التي تقدمونها وأين يقع مكانكم؟', 'تجدوننا في Aurora Street 742.', /لا أستطيع التحقق/u],
  ['fa', 'چه خدماتی دارید و کجا هستین؟', 'ما را در Aurora Street 742 پیدا می‌کنید.', /نمی‌توانم.*تأیید/u],
] as const;
const falseAbsence = /can't find a specific answer|ingen specifik uppgift|keine konkrete Angabe|No encuentro información|پاسخ مشخصی|لا أجد/u;
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-verification' });
  delete process.env.OPENAI_MODEL;
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  b.reset();
});
function claim(text: string, source: string, quote: string) {
  return { claim: text, candidateQuote: text, claimKind: 'OTHER', requiresBusinessEvidence: true,
    supported: true, evidence: [{ source, quote }] };
}
function harness(t: any, language: string, question: string, location: string, mode: string, retrieved = fact) {
  const catalog = formatConfiguredServiceCatalogPlan(plan, language);
  const candidate = `${catalog}\n${location}`;
  const requests: any[] = [], diagnostics: any[] = [], failures: any[] = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', (label: string, data: any) => {
    if (label === '[OpenAIProviderFailure]') failures.push(data);
  });
  b.configure({ businessGroundingDiagnostic: data => diagnostics.push(data) });
  b.businessInformationState('unavailable', fixture.business, question, language,
    retrieved ? `KNOWLEDGE CHUNK 1\nsource_id: ${fixture.sources[0].id}\n${retrieved}` : '');
  const sdkMock = t.mock.method(Responses.prototype, 'create', async (params: any) => {
    requests.push(params);
    assert.equal(params.model, 'gpt-5.6-luna');
    assert.equal(params.tools, undefined);
    for (const key of ['temperature', 'reasoning', 'max_output_tokens', 'text', 'stream']) assert.equal(Object.hasOwn(params, key), false);
    const body = JSON.parse(params.input[0].content);
    if (params.instructions === 'offline conversation candidate') return { output_text: candidate };
    if (params.instructions.includes('strict business-response claim and citation extractor')) {
      assert.equal(body.candidateReply, candidate);
      if (retrieved) assert.ok(body.groundingEvidence.includes(retrieved));
      if (mode === 'timeout') throw new AiReliabilityError('TIMEOUT', 'offline timeout');
      if (mode === 'provider-failure') throw APIError.generate(400, { error: { message: 'offline invalid request' } }, undefined, new Headers());
      if (mode === 'malformed') return { output_text: '{}' };
      return { output_text: JSON.stringify({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [claim(catalog, 'structured_business_config', '"name": "Video Consultation"'), claim(location, 'retrieved_knowledge', retrieved)] }) };
    }
    if (mode === 'entailment-failure' && body.atomicClaim === location) throw new AiReliabilityError('TIMEOUT', 'offline entailment timeout');
    return { output_text: '{"relation":"ENTAILED","claimKind":"OTHER","explicitAbsenceEvidence":false}' };
  });
  return { catalog, candidate, requests, diagnostics, failures, sdkMock, async run() {
    const generated = await b.promptAuditGenerate(null, { messages: [{ role: 'user', content: JSON.stringify({ question }) }],
      systemInstruction: 'offline conversation candidate', model: 'gemini-2.5-flash',
      context: { businessId: 3, channel: 'whatsapp', stage: 'conversation', language } });
    const grounded = await b.finalizeGeneralAiReply('unavailable', question, generated.text, language);
    return b.finalConversationConcision(grounded, b.finalConversationConcisionBudget(question));
  } };
}
for (const [language, question, location, unavailable] of cases) {
  test(`${language}: successful verification preserves location and one catalog`, async t => {
    const h = harness(t, language, question, location, 'success');
    assert.equal(await h.run(), h.candidate);
    assert.equal(h.diagnostics[0].claimsEntailed, true);
    assert.equal(h.failures.length, 0);
  });
  for (const mode of ['timeout', 'provider-failure', 'malformed', 'entailment-failure']) {
    test(`${language}: ${mode} cannot turn known evidence into a location-absence claim`, async t => {
      const h = harness(t, language, question, location, mode);
      const reply = await h.run();
      assert.ok(reply.startsWith(h.catalog));
      for (const service of plan.displayedServices) assert.equal(reply.split(`• ${service.name} (`).length - 1, 1);
      assert.doesNotMatch(reply, falseAbsence);
      assert.match(reply, unavailable);
      assert.doesNotMatch(reply, /Aurora Street 742/u, 'unverified candidate is withheld, never promoted on transport failure');
      assert.ok(b.businessInformationState('unavailable')!.retrievedKnowledge.includes(fact), 'evidence remains intact');
      assert.equal(h.diagnostics[0].retrievedAddressPhrasePresent, true);
      assert.equal(h.diagnostics[0].candidateContainsRetrievedAddressPhrase, true);
      assert.ok(h.diagnostics[0].retrievedAddressPhraseFingerprints.includes(addressFingerprint));
      assert.ok(h.diagnostics[0].candidateAddressPhraseFingerprints.includes(addressFingerprint));
      assert.equal(h.diagnostics[0].verificationUnavailable, true);
      if (mode === 'provider-failure') assert.equal(h.failures[0].httpStatus, 400);
      if (mode === 'entailment-failure') assert.ok(h.requests.length > 2);
      else assert.equal(h.requests.length, 2, 'no timeout retry or second conversation generation');
    });
  }
  test(`${language}: outage with no retrieved location cannot fabricate candidate address`, async t => {
    const h = harness(t, language, question, location, 'provider-failure', '');
    const reply = await h.run();
    assert.ok(reply.startsWith(h.catalog));
    assert.match(reply, unavailable);
    assert.doesNotMatch(reply, /Aurora Street 742/u);
    assert.equal(h.diagnostics[0].retrievedAddressPhrasePresent, false);
    assert.equal(h.diagnostics[0].candidateContainsRetrievedAddressPhrase, false);
  });
}

test('independently verified location survives another claim verifier failure', async t => {
  const [language, question, location] = cases[1];
  const hours = 'Öppettiderna är alltid 08–20.';
  const compound = `${question} Vilka öppettider gäller?`;
  const h = harness(t, language, compound, location, 'success');
  const catalogClaim = claim(h.catalog, 'structured_business_config', '"name": "Video Consultation"');
  b.configure({
    assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
      claims: [catalogClaim, claim(location, 'retrieved_knowledge', fact), claim(hours, 'business_system_prompt', 'Example')] }),
    assessBusinessClaimEntailment: async request => request.atomicClaim === hours ? null :
      ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }),
  });
  // The hours citation is real but the outage must not authorize its proposition.
  const config = structuredClone(fixture.business);
  config.systemPrompt += '\nExample';
  b.businessInformationState('unavailable', config, compound, language, fact);
  const reply = await b.finalizeGeneralAiReply('unavailable', compound, `${h.candidate}\n${hours}`, language);
  assert.ok(reply.includes(location));
  assert.doesNotMatch(reply, /Öppettiderna är alltid|ingen specifik uppgift/u);
  assert.match(reply, /kan inte verifiera.*öppettider/u);
});

test('actual SDK deadline abort produces the later generation failure diagnostic for the same verifier, without a second generation', async t => {
  const [language, question, location, unavailable] = cases[1];
  const h = harness(t, language, question, location, 'success');
  h.sdkMock.mock.restore();
  const timings: any[] = [], events: string[] = [];
  t.mock.method(console, 'info', (label: string, data: any) => {
    if (label === '[BusinessSupportVerifierTiming]') timings.push(data);
    if (label === '[BusinessSupportGroundingDiagnostic]') events.push('grounding-diagnostic');
  });
  t.mock.method(console, 'error', (label: string, data: any) => {
    if (label === '[OpenAIProviderFailure]') { h.failures.push(data); events.push('adapter-failure'); }
  });
  let notifyStart!: () => void;
  const started = new Promise<void>(resolve => { notifyStart = resolve; });
  let requests = 0, aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    requests++;
    const params = JSON.parse(init.body);
    assert.equal(params.model, 'gpt-5.6-luna');
    assert.match(params.instructions, /strict business-response claim and citation extractor/u);
    const body = JSON.parse(params.input[0].content);
    assert.ok(body.groundingEvidence.includes(fact));
    assert.ok(body.candidateReply.includes('Aurora Street 742'));
    assert.equal(params.tools, undefined);
    notifyStart();
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Offline transport aborted', 'AbortError'));
      }, { once: true });
    });
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const pending = b.finalizeGeneralAiReply('unavailable', question, h.candidate, language);
  await started;
  t.mock.timers.tick(20_000);
  const reply = await pending;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(requests, 1);
  assert.match(reply, unavailable);
  assert.doesNotMatch(reply, falseAbsence);
  assert.doesNotMatch(reply, /Aurora Street 742/u);
  assert.equal(h.diagnostics[0].verifierReturnedAssessment, false);
  const timeout = timings.find(row => row.stage.endsWith('_attempt_timeout'));
  assert.equal(timeout.elapsedMs, 20_000);
  assert.equal(timeout.providerExecutionMs, 20_000);
  assert.equal(timeout.timeoutBudgetMs, 20_000);
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0].correlationId, timeout.correlationId);
  assert.equal(h.failures[0].stage, 'generation', 'adapter label applies to the verification request too');
  assert.equal(h.failures[0].message, 'OpenAI generation failed');
  for (const field of ['httpStatus', 'errorType', 'errorCode', 'requestId']) assert.equal(h.failures[0][field], null);
  assert.ok(events.indexOf('grounding-diagnostic') < events.indexOf('adapter-failure'), 'deadline can return before the SDK abort log');
});

test('known retrieved address is retained as evidence even when the candidate omitted it', async t => {
  const [language, question, , unavailable] = cases[1];
  const h = harness(t, language, question, 'Jag hjälper dig gärna.', 'provider-failure');
  const reply = await h.run();
  assert.match(reply, unavailable);
  assert.doesNotMatch(reply, falseAbsence);
  assert.equal(h.diagnostics[0].retrievedAddressPhrasePresent, true);
  assert.equal(h.diagnostics[0].candidateContainsRetrievedAddressPhrase, false);
});

test('retrieval chunk labels and source identifiers are not diagnosed as an address', async t => {
  const [language, question, location] = cases[0];
  const h = harness(t, language, question, location, 'provider-failure', 'Ask the business about directions.');
  await h.run();
  assert.equal(h.diagnostics[0].retrievedAddressPhrasePresent, false);
  assert.equal(h.diagnostics[0].candidateContainsRetrievedAddressPhrase, false);
});

test('retryable verifier provider failure keeps the existing bounded retry policy and cannot assert missing location', async t => {
  const [language, question, location, unavailable] = cases[0];
  const h = harness(t, language, question, location, 'success');
  const create = Responses.prototype.create;
  let extractions = 0;
  t.mock.method(Responses.prototype, 'create', async function(this: any, params: any, ...rest: any[]) {
    if (params.instructions.includes('strict business-response claim and citation extractor')) {
      extractions++;
      throw APIError.generate(503, { error: { message: 'offline unavailable' } }, undefined, new Headers());
    }
    return create.call(this, params, ...rest);
  });
  const reply = await h.run();
  assert.equal(extractions, 2);
  assert.equal(h.failures.length, 2);
  assert.match(reply, unavailable);
  assert.doesNotMatch(reply, falseAbsence);
  assert.doesNotMatch(reply, /Aurora Street 742/u);
});
