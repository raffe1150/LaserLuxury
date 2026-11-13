/** Production-wide Sol routing through the REAL channel adapters (Telegram,
 * WhatsApp, Instagram, Messenger) and the real shared engine. Model OUTPUT is
 * SYNTHETIC; for every model request the host made we record the model the
 * production OpenAI adapter would put on the wire (routeOpenAiRequest), the
 * routing stage and whether an owner permit was attached. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { productionInventory } from '../../tests/helpers/multidoc-production-inventory';
import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import { answerEvidenceBindings } from './business-information-answer-plan';
import { AiReliabilityError } from './reliability';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
import { configureKnowledgeBudgetOwner } from './knowledge-model-policy';
import { routeOpenAiRequest } from './providers/openai';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';

incidentFlags();
Object.assign(process.env, { OPENAI_API_KEY: 'synthetic-offline-only',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2', ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: 'false',
  ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS: 'source-partitioned-v1', KNOWLEDGE_MAX_ACTIVE_REQUESTS: '1',
  ODINLINK_AI_DEFAULT_MODEL: 'gpt-6.1-sol' });
incidentConfig.id = 3; incidentConfig.businessId = 3;
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const SOL = 'gpt-6.1-sol', LUNA = 'gpt-5.6-luna';
const QUESTIONS = {
  ar: ['إذا كانت هذه زيارتي الأولى، قبل كم دقيقة من موعدي يُنصح أن أصل؟', 'ينصح الزوار للمرة الأولى بالوصول قبل موعدك المحجوز بحوالي 10 دقائق.'],
  fa: ['اگر اولین بار است که می‌آیم، چند دقیقه قبل از نوبتم بهتر است برسم؟', 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند.'],
} as const;
type Route = { stage: string; model: string; permit: boolean; fallback?: string };

async function turn(t: any, channel: IncidentChannel, language: keyof typeof QUESTIONS, env: Record<string, string | undefined>, ownerTenants?: number[]) {
  const [question, publishedAnswer] = QUESTIONS[language];
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const owner = ownerTenants ? Object.assign(new ScriptedKnowledgeBudgetOwner(), { businessIds: ownerTenants }) : undefined;
  configureKnowledgeBudgetOwner(owner); t.after(() => configureKnowledgeBudgetOwner());
  b.reset(); t.after(() => b.reset());
  const logs: string[] = [], timings: any[] = [];
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  t.mock.method(console, 'info', (...args: unknown[]) => { if (args[0] === '[KnowledgeModelRouting]') logs.push(String(args[1]));
    else if (args[0] === '[KnowledgeTimingPolicy]') timings.push(args[1]); });
  let now = 1_000_000; t.mock.method(Date, 'now', () => now);
  const { service, matches: canonical } = await productionInventory();
  const partial = [0, 3, 4, 5, 2].map(i => canonical[i]);
  const quote = canonical[0].text!.match(/Kunder som besöker studion för första gången[^.]+\./u)![0];
  const routes: Route[] = [], replies: string[] = [], errors: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  b.configure({ offlineAi: true, postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
    semanticLanguageResolver: async () => { now += 1572; return { language, confidence: 1 }; },
    knowledgeSourceLanguages: async () => ['sv'], knowledgeSearch: async () => partial.map(m => ({ ...m, score: 1 })),
    semanticKnowledgeSearchQueries: async () => [], completeKnowledgeCorpus: async () => null,
    completeKnowledgeDocuments: async (id, found, anchors, options) => { now += 130; return service.completeSelectedDocuments(id, found, anchors, options); },
    validateKnowledgeMatches: async (id, found) => service.validateMatches(id, found, { strictSources: true, captureRevision: true,
      requireCompleteDocumentContext: true, signal: nativeKnowledgeTiming()?.signal }),
    knowledgeServiceCatalog: async () => incidentConfig.services,
    aiGenerate: async request => {
      const route = routeOpenAiRequest(request.model, request);
      routes.push({ stage: route.stage, model: route.model, permit: !!request.knowledgeExecution, ...(route.fallbackReason ? { fallback: route.fallbackReason } : {}) });
      if ((request.systemInstruction ?? '').includes('retrieval query planner')) { now += 2500; throw new AiReliabilityError('TIMEOUT', 'SYNTHETIC planner timeout'); }
      try {
        const data = JSON.parse(request.messages[0].content);
        const evidence = data.evidence.find((e: any) => e.text.includes(quote));
        if ((request.systemInstruction ?? '').includes('UNIT EXTRACTION')) {
          now += 3000;
          return { functionCalls: [], text: JSON.stringify({ oversized: false, units: [{ facetIds: ['f1'], subject: 'first-time visitors', predicate: 'arrival recommendation',
            value: 'approximately 10 minutes before booked appointment', modality: 'recommended', negation: false, scope: 'first-time visitors',
            qualifiers: ['approximately', 'before booked appointment'], language, text: publishedAnswer, evidenceRefs: [{ evidenceId: evidence.id, exactQuote: quote }] }] }) };
        }
        now += 1000; const ids = data.units.map((u: any) => u.id);
        return { functionCalls: [], text: JSON.stringify({ decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED',
          meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
          coverage: [{ facetId: 'f1', requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: ids,
            obligations: [{ obligationId: 'f1.o1', status: 'COVERED', unitIds: ids }] }],
          sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true, conflictsAbsent: true,
            evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: ids, obligations: [{ facetId: 'f1', obligationId: 'f1.o1', state: 'COMPLETE' }] } }) };
      } catch (error) { errors.push(error); throw error; }
    },
    calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: async () => assert.fail('no calendar'), checkSlots: async () => assert.fail('no calendar'),
      insertAppointment: async () => assert.fail('no booking write'), cancelAppointment: async () => assert.fail('no booking write'), updateAppointment: async () => assert.fail('no booking write') },
  });
  await incidentInbound(b, channel, question);
  assert.deepEqual(errors, []);
  assert.equal(replies.length, 1, 'exactly one customer reply');
  return { routes, reply: replies[0], publishedAnswer, logs: logs.map(l => JSON.parse(l)), timings };
}
const knowledgeStages = (routes: Route[]) => routes.filter(r => r.stage.startsWith('knowledge_') && r.stage !== 'knowledge_planning' && r.stage !== 'knowledge_composition');

for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) for (const language of ['ar', 'fa'] as const) {
  test(`Sol production / ${channel} / ${language}: owner-metered extraction + source-exhaustive verification on Sol, verified reply published`, async t => {
    const r = await turn(t, channel, language, {}, [3]);
    assert.equal(r.reply, r.publishedAnswer);
    assert.deepEqual(knowledgeStages(r.routes), [
      { stage: 'knowledge_extraction', model: SOL, permit: true }, { stage: 'knowledge_verification', model: SOL, permit: true }]);
    // Latency-bound planner (2500 ms host budget) stays on the interactive baseline; all else Sol.
    assert.ok(r.routes.filter(x => x.stage === 'knowledge_planning').every(x => x.model === LUNA && x.fallback === 'latency_budget'), JSON.stringify(r.routes));
    assert.ok(r.routes.filter(x => x.stage !== 'knowledge_planning').every(x => x.model === SOL), JSON.stringify(r.routes));
    assert.deepEqual(r.logs.map(l => [l.profile, l.channel, l.publication]), [['sol-knowledge-v2', channel, 'published']]);
  });
  test(`Sol production / ${channel} / ${language}: no financial owner -> whole-turn Luna for metered stages, gates unchanged`, async t => {
    const r = await turn(t, channel, language, {});
    assert.equal(r.reply, r.publishedAnswer);
    assert.deepEqual(knowledgeStages(r.routes), [
      { stage: 'knowledge_extraction', model: LUNA, permit: false, fallback: 'financial_control_unavailable' },
      { stage: 'knowledge_verification', model: LUNA, permit: false, fallback: 'financial_control_unavailable' }]);
    assert.ok(r.routes.filter(x => !knowledgeStages([x]).length && x.stage !== 'knowledge_planning').every(x => x.model === SOL));
    assert.deepEqual(r.logs.map(l => [l.profile, l.fallbackReason]), [['default', 'budget_owner_unavailable']]);
  });
  test(`Rollback / ${channel} / ${language}: ODINLINK_AI_DEFAULT_MODEL=Luna restores Luna everywhere`, async t => {
    const r = await turn(t, channel, language, { ODINLINK_AI_DEFAULT_MODEL: LUNA }, [3]);
    assert.equal(r.reply, r.publishedAnswer);
    assert.ok(r.routes.length >= 2 && r.routes.every(x => x.model === LUNA && !x.permit && !x.fallback), JSON.stringify(r.routes));
    assert.deepEqual(r.logs, [], 'no managed profile was captured');
  });
}

test('Sol production: a tenant without a financial entitlement falls back pre-turn; others are unaffected', async t => {
  const r = await turn(t, 'whatsapp', 'ar', {}, [4, 5]);
  assert.equal(r.reply, r.publishedAnswer);
  assert.deepEqual(r.logs.map(l => l.fallbackReason), ['budget_owner_tenant']);
  assert.ok(knowledgeStages(r.routes).every(x => x.model === LUNA && x.fallback === 'financial_control_unavailable'));
});

// Tenant-scoped 50s Knowledge deadline through the real channel adapters. The
// authoritative tenant resolved for every channel here is business 3.
const deadline = (r: { timings: any[] }) => r.timings.map(e => [e.turnMs, e.knowledgeMs, e.turnExtensionMs, 'turnExtensionInvalid' in e]);
for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger'] as const) {
  test(`50s deadline / ${channel}: listed business 3 gets 50/40s; reply, Sol stages and owner permits unchanged`, async t => {
    const r = await turn(t, channel, 'fa', { ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS: '5000', ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS: '3' }, [3]);
    assert.equal(r.reply, r.publishedAnswer);
    assert.deepEqual(knowledgeStages(r.routes), [
      { stage: 'knowledge_extraction', model: SOL, permit: true }, { stage: 'knowledge_verification', model: SOL, permit: true }]);
    assert.deepEqual(deadline(r), [[50000, 40000, 5000, false]]);
  });
  test(`50s deadline / ${channel}: business 3 not listed (list=4) keeps 45/35s`, async t => {
    const r = await turn(t, channel, 'ar', { ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS: '5000', ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS: '4' }, [3]);
    assert.equal(r.reply, r.publishedAnswer);
    assert.deepEqual(deadline(r), [[45000, 35000, 0, false]]);
  });
  for (const list of [undefined, 'all'])
    test(`50s deadline / ${channel}: 5000 with ${list === undefined ? 'no' : 'an invalid'} tenant list fails closed to 45/35s`, async t => {
      const r = await turn(t, channel, 'fa', { ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS: '5000', ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS: list }, [3]);
      assert.equal(r.reply, r.publishedAnswer);
      assert.deepEqual(deadline(r), [[45000, 35000, 0, true]]);
    });
  test(`50s deadline / ${channel}: flag unset keeps 45/35s with no invalid marker`, async t => {
    const r = await turn(t, channel, 'fa', { ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS: undefined, ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS: '3' }, [3]);
    assert.equal(r.reply, r.publishedAnswer);
    assert.deepEqual(deadline(r), [[45000, 35000, 0, false]]);
  });
}
