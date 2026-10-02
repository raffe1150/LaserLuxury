import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Responses } from 'openai/resources/responses';
import { buildConfiguredServiceCatalogPlan, formatRecommendationClarification, formatRecommendationServiceSummary, isGenericRecommendationClarificationQuestion } from './business-information';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import(process.env.REMAINING_LATENCY_BASELINE === '1' ? '../../.remaining-baseline-server.ts' : '../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const baseline = process.env.REMAINING_LATENCY_BASELINE === '1';
const cases = [
  ['en', 'What would you recommend for a first-time visitor?'],
  ['sv', 'Vad rekommenderar ni för någon som kommer första gången?'],
  ['de', 'Welche Leistung empfehlen Sie beim ersten Besuch?'],
  ['es', '¿Qué servicio recomendarían para alguien que viene por primera vez?'],
  ['fa', 'برای بار اول چه خدماتی پیشنهاد می‌کنید؟'],
  ['ar', 'ما الخدمة التي توصي بها لزيارة أولى؟'],
] as const;
for (const [language, question] of cases) test(`${language}: generic recommendation needs catalog scaffolding, not generation/verification`, async t => {
  const env = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-recommendation' });
  b.reset();
  t.after(() => { b.reset(); for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); });
  const config = { ...fixture.business, language };
  const id = `recommendation-${language}`;
  b.promptAuditHistory(id, []);
  const summary = formatRecommendationServiceSummary(buildConfiguredServiceCatalogPlan(config.services), language);
  const neutralGoals = { en: 'What is your main goal?', sv: 'Vilket mål vill du uppnå?', de: 'Welches Ergebnis möchten Sie erreichen?', es: '¿Qué resultado buscas?', fa: 'بیشتر برای چه هدفی کمک می‌خواهید؟', ar: 'ما الهدف الأساسي الذي تريد المساعدة فيه؟' };
  const candidate = `${summary}\n${neutralGoals[language]}`;
  const deterministic = `${summary}\n${formatRecommendationClarification(language)}`;
  const counts = { language: 0, planner: 0, generation: 0, extraction: 0, repair: 0, entailment: 0, lexical: 0, semantic: 0 };
  const timings: any[] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (label: string, event: any) => {
    if (['[BusinessInformationTiming]', '[KnowledgeRetrieval]', '[AIRequest]', '[BusinessSupportVerifierTiming]', '[BusinessInformationProviderTiming]'].includes(label)) timings.push({ label, ...event });
  });
  b.configure({ postProcess: async () => {},
    knowledgeSearch: async () => { counts.lexical++; await delay(5); return []; },
    semanticKnowledgeSearch: async () => { counts.semantic++; await delay(5); return []; },
  });
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    await delay(10);
    const instructions = params.instructions;
    if (instructions.includes('language-routing classifier')) { counts.language++; return { output_text: JSON.stringify({ language, requestedReplyLanguage: null, confidence: 0.99 }), output: [] } as any; }
    if (instructions.includes('retrieval query planner')) { counts.planner++; return { output_text: JSON.stringify({ canonicalMeaning: 'unspecified first visit recommendation', queries: [question] }), output: [] } as any; }
    if (instructions.includes('claim and citation extractor')) { const body = JSON.parse(params.input[0].content); if (body.previousAssessment) counts.repair++; else counts.extraction++; return { output_text: JSON.stringify({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [{
      claim: summary, candidateQuote: summary, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
      evidence: [{ source: 'structured_business_config', quote: '"name": "Video Consultation"' }],
    }] }), output: [] } as any; }
    if (instructions.includes('entailment gate')) { counts.entailment++; return { output_text: JSON.stringify({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }), output: [] } as any; }
    assert.equal(instructions, 'offline conversation candidate'); counts.generation++;
    return { output_text: candidate, output: [] } as any;
  });
  const started = performance.now();
  assert.equal(await b.prepareConversationLanguageForTest(id, question, config), language);
  const result = await b.turn({ sessionId: id, platformName: 'whatsapp', recipientUserId: '46700000001', text: question, businessConfig: config });
  let final = result.replies.join('\n');
  if (!result.handled) {
    const generated = await b.promptAuditGenerate(null, { messages: [{ role: 'user', content: question }], systemInstruction: 'offline conversation candidate', context: { businessId: 3, channel: 'whatsapp', stage: 'conversation', language } });
    final = await b.finalizeGeneralAiReply(id, question, generated.text, language);
  }
  if (baseline) assert.ok([candidate, deterministic].includes(final));
  else assert.equal(final, deterministic);
  assert.equal(result.pending, null);
  assert.equal(counts.language, 1, 'real language classifier is included in request count');
  if (!baseline) {
    assert.equal(result.handled, true);
    assert.deepEqual(counts, { language: 1, planner: 0, generation: 0, extraction: 0, repair: 0, entailment: 0, lexical: 0, semantic: 0 });
    const stages = timings.filter(e => e.label === '[BusinessInformationTiming]');
    assert.ok(stages.some(e => e.stage === 'response_ready'));
    assert.ok(stages.some(e => e.stage === 'response_dispatch_complete'));
    assert.ok(stages.some(e => e.stage === 'grounding_complete' && e.disposition === 'configured_catalog_clarification'));
    assert.equal(new Set(stages.map(e => e.businessInfoTurnId)).size, 1);
    assert.equal(timings.filter(e => e.label === '[AIRequest]').length, 1);
  }
  t.diagnostic(JSON.stringify({ mode: baseline ? 'before' : 'after', language, counts, elapsedMs: Math.round(performance.now() - started),
    provider: timings.filter(e => e.label === '[AIRequest]').map(e => ({ stage: e.stage, durationMs: e.durationMs, providerExecutionMs: e.providerExecutionMs, queueWaitMs: e.queueWaitMs })),
    stages: timings.filter(e => e.label === '[BusinessInformationTiming]') }));
});

const informationCases = [
  ['en', 'Hello! What services do you offer and where are you located?'],
  ['sv', 'Hej! Vilka tjänster erbjuder ni och var finns ni?'],
  ['de', 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?'],
  ['es', '¡Hola! ¿Qué servicios ofrecen y dónde están ubicados?'],
  ['fa', 'سلام! چه خدماتی دارید و کجا هستین؟'],
  ['ar', 'مرحباً! ما الخدمات التي تقدمونها وأين موقعكم؟'],
] as const;
for (const [language, question] of informationCases) test(`${language}: configured business info still includes only the existing language provider call`, async t => {
  const env = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-configured-info' });
  b.reset(); t.after(() => { b.reset(); for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); });
  const config = { ...fixture.business, address: 'Aurora Street 742', language };
  const id = `configured-info-${language}`; b.promptAuditHistory(id, []);
  const events: any[] = []; let languageCalls = 0;
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (label: string, event: any) => {
    if (['[AIRequest]', '[BusinessInformationTiming]'].includes(label)) events.push({ label, ...event });
  });
  b.configure({ postProcess: async () => {}, knowledgeSearch: async () => { throw new Error('configured info does not retrieve'); },
    semanticKnowledgeSearch: async () => { throw new Error('configured info does not embed'); } });
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    assert.match(params.instructions, /language-routing classifier/u); languageCalls++; await delay(10);
    return { output_text: JSON.stringify({ language, requestedReplyLanguage: null, confidence: 0.99 }), output: [] } as any;
  });
  const started = performance.now();
  assert.equal(await b.prepareConversationLanguageForTest(id, question, config), language);
  const r = await b.turn({ sessionId: id, platformName: 'whatsapp', recipientUserId: '46700000001', text: question, businessConfig: config });
  assert.equal(r.handled, true); assert.equal(languageCalls, 1); assert.equal(events.filter(e => e.label === '[AIRequest]').length, 1);
  assert.ok(r.replies.join(' ').includes('Aurora Street 742'));
  t.diagnostic(JSON.stringify({ mode: baseline ? 'before' : 'after', flow: 'configured_business_info', language, languageCalls,
    elapsedMs: Math.round(performance.now() - started), provider: events.filter(e => e.label === '[AIRequest]').map(e => ({ stage: e.stage, durationMs: e.durationMs, providerExecutionMs: e.providerExecutionMs, queueWaitMs: e.queueWaitMs })),
    stages: events.filter(e => e.label === '[BusinessInformationTiming]') }));
});

if (!baseline) {
for (const question of [
  'I am not sure which service suits me. What do you need to know before recommending one?',
  'Jag vet inte vilken tjänst som passar mig. Vad behöver ni veta innan ni rekommenderar en?',
  'Ich weiß nicht, welche Dienstleistung zu mir passt. Was müssen Sie wissen, bevor Sie eine empfehlen?',
  'No sé qué servicio me conviene. ¿Qué necesitan saber antes de recomendar uno?',
  'نمی‌دانم کدام خدمت برای من مناسب است. پیش از پیشنهاد یک خدمت چه اطلاعاتی نیاز دارید؟',
  'لا أعرف أي خدمة تناسبني. ما الذي تحتاجون إلى معرفته قبل التوصية بخدمة؟',
]) test(`uncertain service-fit clarification is recognized: ${question}`, () => {
  assert.equal(isGenericRecommendationClarificationQuestion(question), true);
});

for (const question of [
  'Hi! Can you tell me a little about your services and what you would recommend for someone visiting for the first time?',
  'Hej! Kan ni berätta lite om era tjänster och vad ni rekommenderar för någon som kommer första gången?',
  'Hallo! Können Sie mir etwas über Ihre Dienstleistungen erzählen und was Sie für einen ersten Besuch empfehlen?',
  '¡Hola! ¿Pueden contarme un poco sobre sus servicios y qué recomendarían para alguien que viene por primera vez?',
  'سلام! می‌توانید کمی درباره خدماتتان بگویید و برای کسی که بار اول می‌آید چه پیشنهادی دارید؟',
  'مرحباً! هل يمكنك إخباري قليلاً عن خدماتكم وما الذي توصي به لشخص يزوركم لأول مرة؟',
  'What services do you offer and what do you recommend for a first-time visitor?',
  'Vilka tjänster har ni och vad rekommenderar ni för första gången?',
  'Welche Dienstleistungen bieten Sie an und was empfehlen Sie beim ersten Besuch?',
  '¿Qué servicios ofrecen y qué recomiendan para alguien que viene por primera vez?',
  'چه خدماتی دارید و برای بار اول چه پیشنهادی دارید؟',
  'ما الخدمات التي تقدمونها وماذا توصي به لزيارة أولى؟',
]) test(`generic catalog plus recommendation is recognized: ${question}`, () => {
  assert.equal(isGenericRecommendationClarificationQuestion(question), true);
});
for (const [language, question] of cases) {
  for (const suffix of [' I want a wedding video.', ' What is your address?', ' Please book it tomorrow.']) {
    test(`${language}: extra goals/facts/actions do not qualify for scaffolding: ${suffix}`, () => {
      assert.equal(isGenericRecommendationClarificationQuestion(`${question} ${suffix}`), false);
    });
  }
}
for (const question of [
  'I am not sure which service suits me for a wedding video. What do you need to know before recommending one?',
  'I am not sure which service suits me. Tell me about your company and what do you need to know before recommending one?',
]) test(`structured clarification with specific context retains grounding: ${question}`, () => {
  assert.equal(isGenericRecommendationClarificationQuestion(question), false);
});

for (const question of [
  'Which service would you recommend for a wedding video?',
  'Vad rekommenderar ni för att filma mitt bröllop?',
  'Welche Dienstleistung empfehlen Sie für meine Hochzeit?',
  '¿Qué servicio recomendarían para mi boda?',
  'برای فیلم عروسی چه خدماتی پیشنهاد می‌کنید؟',
  'ما الخدمة التي توصي بها لتصوير حفل زفاف؟',
  'What would you recommend for a first-time visitor? Is parking free?',
  'What would you recommend for a first-time visitor and where are you located?',
  'What is the difference between your services?',
]) test(`specific or compound question retains grounding: ${question}`, () => {
  assert.equal(isGenericRecommendationClarificationQuestion(question), false);
});
for (const channel of ['whatsapp', 'telegram', 'messenger', 'instagram'] as const) {
  test(`${channel}: configured recommendation scaffold uses shared format and no provider`, async t => {
    b.reset(); t.after(() => b.reset());
    for (const method of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, method, () => {});
    b.configure({ postProcess: async () => {}, knowledgeSearch: async () => { throw new Error('no retrieval'); },
      semanticKnowledgeSearch: async () => { throw new Error('no embeddings'); },
      geminiGenerate: async () => { throw new Error('no generation'); },
      assessBusinessSupportGrounding: async () => { throw new Error('no extraction'); },
      assessBusinessClaimEntailment: async () => { throw new Error('no verification'); },
    });
    t.mock.method(Responses.prototype, 'create', async () => { throw new Error('no provider'); });
    const id = `scaffold-${channel}`; b.seedFlowLanguage(id, 'ar'); b.promptAuditHistory(id, []);
    const config = { ...fixture.business, services: fixture.business.services.map((s: any, i: number) => ({ ...s, currency: ['EUR', 'USD', 'SEK'][i % 3] })) };
    const r = await b.turn({ sessionId: id, platformName: channel, recipientUserId: '46700000001', text: cases[5][1], businessConfig: config });
    assert.equal(r.handled, true); assert.equal(r.pending, null);
    const expected = `${formatRecommendationServiceSummary(buildConfiguredServiceCatalogPlan(config.services), 'ar')}\n${formatRecommendationClarification('ar')}`;
    assert.equal(r.replies.join('\n'), expected);
    for (const currency of ['EUR', 'USD', 'SEK']) assert.ok(expected.includes(` ${currency}`));
  });
}
for (const scenario of ['prior_goal', 'active_booking', 'no_catalog', 'inactive_catalog', 'specific_goal'] as const) {
  test(`${scenario}: existing read-only retrieval path remains active`, async t => {
    b.reset(); t.after(() => b.reset());
    for (const method of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, method, () => {});
    let searches = 0;
    b.configure({ postProcess: async () => {}, knowledgeSearch: async () => { searches++; return []; },
      semanticKnowledgeSearch: async () => [],
      geminiGenerate: async () => ({ text: JSON.stringify({ canonicalMeaning: 'recommendation', queries: [] }) }),
    });
    const id = '46700000001'; b.seedFlowLanguage(id, 'en');
    b.promptAuditHistory(id, scenario === 'prior_goal' ? [{ role: 'user', content: 'I need a video for my wedding.' }] : []);
    const config = { ...fixture.business, ...(scenario === 'no_catalog' ? { services: [] } : {}),
      ...(scenario === 'inactive_catalog' ? { services: fixture.business.services.map((s: any) => ({ ...s, active: false })) } : {}) };
    if (scenario === 'active_booking') b.seedPending(id, {
      bookingStateVersion: 3, createdAt: Date.now(), businessId: '3', platform: 'whatsapp', userId: id,
      businessConfig: config, operation: 'new_booking', status: 'awaiting_contact', expectedInput: 'contact', language: 'en',
      service: 'Video Consultation', durationMinutes: 60, selectedDate: '2027-05-21', dateTime: '2027-05-21T15:30:00+02:00',
      selectedSlotEnd: '2027-05-21T14:30:00Z', ownedOfferedSlots: [{ businessId: '3', platform: 'whatsapp', userId: id,
        service: 'Video Consultation', durationMinutes: 60, start: '2027-05-21T15:30:00+02:00', end: '2027-05-21T14:30:00Z', generatedAt: Date.now() }],
    });
    const before = scenario === 'active_booking' ? await b.stateAuditRestore(id, 'whatsapp', config) : null;
    const r = await b.turn({ sessionId: id, platformName: 'whatsapp', recipientUserId: id,
      text: scenario === 'specific_goal' ? 'Which service would you recommend for a wedding video?' : cases[0][1], businessConfig: config });
    assert.equal(r.handled, false); assert.ok(searches > 0);
    if (before) assert.deepEqual(r.pending, before);
  });
}

}
