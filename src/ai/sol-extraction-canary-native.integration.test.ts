/** Actual native channel handlers + the real OpenAI adapter (SDK create mocked)
 * + scripted budget owner. Synthetic one-tenant source; every send, model call
 * and booking action is offline and intercepted. NOT production approval. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from '../../knowledge';
import { incidentChannels, incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import { canonicalDocument } from '../knowledge/documents/canonical';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';
import { configureKnowledgeBudgetOwner } from './knowledge-model-policy';

incidentFlags();
Object.assign(process.env, {
  OPENAI_API_KEY: 'synthetic-offline-only', ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2',
});
delete process.env.OPENAI_BASE_URL;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const question = 'من اولین باره می‌خوام بیام استودیو. بهتره چقدر زودتر از نوبتم اونجا باشم؟';
const recommendation = 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sitt bokade besök för att hinna förbereda sig i lugn och ro.';
const qualification = 'Detta är en rekommendation, inte ett krav.';
const faithful = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند، برای اینکه با آرامش آماده شوند.';
// Re-extraction trigger: a human-labelled faithful purpose (semantic-recovery-eval
// fa-purpose-8) whose post-quantity «تا» the closed parser grammar still treats as
// a possible limit. («تا با آرامش آماده شوند» is now recognised and no longer triggers.)
const purposeTa = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با خیال راحت آماده شوند.';
const source: KnowledgeSource = {
  id: '6a1f0c2e-0d4b-4c51-9b8e-3f2a1c0d9e77', businessId: 77, type: 'document', status: 'ready', title: 'Synthetic first visit',
  content: [recommendation, qualification].join('\n\n'), createdAt: '2026-01-01', updatedAt: '2026-01-01',
  metadata: { segments: [{ start: 0, end: recommendation.length, page: 1 },
    { start: recommendation.length + 2, end: recommendation.length + 2 + qualification.length, page: 1 }] },
};
type Mode = 'active' | 'off' | 'no-owner' | 'shadow' | 'flag-flip' | 're-extraction-fails' | 'other-tenant' | 'production';
const SHADOW_SETTLE_MS = 50;

async function exercise(t: TestContext, channel: IncidentChannel, mode: Mode) {
  boundary.reset();
  const previousServices = incidentConfig.services; incidentConfig.services = [];
  const lines: string[] = [];
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, (label: unknown, payload: unknown) => {
    if (label === '[SolExtractionCanary]') lines.push(String(payload)); });
  const storage = new InMemoryKnowledgeStorage(); const service = new KnowledgeService(storage);
  await storage.create(source);
  const matches = canonicalDocument(source).chunks.map(chunk => ({ ...chunk.match, score: 1 }));
  process.env.ODINLINK_SOL_EXTRACTION_MODE = mode === 'off' || mode === 'production' ? 'off' : mode === 'shadow' ? 'shadow' : 'active';
  // Production profile: Sol is the managed Knowledge default; the canary is off.
  const savedDefault = process.env.ODINLINK_AI_DEFAULT_MODEL;
  if (mode === 'production') process.env.ODINLINK_AI_DEFAULT_MODEL = 'gpt-6.1-sol';
  process.env.ODINLINK_SOL_EXTRACTION_TENANT_IDS = mode === 'other-tenant' ? '78' : '77';
  const owner = new ScriptedKnowledgeBudgetOwner();
  configureKnowledgeBudgetOwner(mode === 'no-owner' ? undefined : owner);
  const replies: string[] = [], calls: { stage: string; model: string }[] = [], telemetry: any[] = [], shadow: any[] = [];
  let actions = 0, unexpected: string[] = [];
  const deny = async () => { actions++; throw new Error('booking/calendar mutation forbidden'); };
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    replies.push(interceptedIncidentSend(url, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }], message_id: 'offline' }));
  });
  const reply = (p: any, value: unknown) => ({ id: 'resp_' + calls.length, object: 'response', model: p.model, status: 'completed', service_tier: 'default',
    reasoning: p.reasoning ?? null, prompt_cache_options: p.prompt_cache_options, output_text: JSON.stringify(value),
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 }, output_tokens_details: { reasoning_tokens: 5 } } });
  t.mock.method(Responses.prototype, 'create', async (p: any) => {
    const d = JSON.parse(p.input[0].content), instruction: string = p.instructions;
    if (instruction.startsWith('OdinLink source-language search query.')) return reply(p, { query: 'förstagångsbesökare minuter' });
    if (instruction.includes('retrieval query planner')) return reply(p, { requestKind: 'BUSINESS_INFORMATION', canonicalMeaning: question, queries: [question],
      queryLanguages: [], referenceResolution: 'NOT_REQUIRED',
      requestedFacets: [{ subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' }] });
    if (instruction.includes('UNIT EXTRACTION')) {
      const reExtraction = instruction.includes('RE-EXTRACTION');
      calls.push({ stage: reExtraction ? 're_extraction' : 'extraction', model: p.model });
      if (reExtraction && mode === 're-extraction-fails') throw new Error('synthetic provider outage');
      assert.ok(d.evidence.every((e: any) => e.businessId === 77));
      const rec = d.evidence.find((e: any) => e.text.includes('rekommenderas')), literal = p.text?.format?.name?.includes('literal');
      return reply(p, { oversized: false, units: [{ subject: 'first-time visitors', predicate: 'arrival timing', value: 'about ten minutes before',
        modality: 'recommended', negation: false, scope: 'first visit', qualifiers: [], language: 'fa', facetIds: [d.facets[0].id],
        text: reExtraction ? faithful : purposeTa,
        evidenceRefs: [literal ? { evidenceId: rec.id } : { evidenceId: rec.id, exactQuote: recommendation }] }] });
    }
    if (instruction.includes('BATCH ENTAILMENT')) {
      calls.push({ stage: 'verification', model: p.model });
      const [unit] = d.units;
      return reply(p, { decisions: [{ unitId: unit.id, facetIds: unit.facetIds, relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true,
          qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false }],
        coverage: d.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: [unit.id],
          obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: [unit.id] })) })),
        sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true, conflictsAbsent: true,
          evidenceIdsReviewed: d.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: [unit.id],
          obligations: d.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id, state: 'COMPLETE' }))) } });
    }
    unexpected.push(instruction.slice(0, 60)); throw new Error('unscripted provider stage');
  });
  boundary.configure({
    postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    semanticLanguageResolver: async () => {
      if (mode === 'flag-flip') process.env.ODINLINK_SOL_EXTRACTION_MODE = 'active';
      return { language: 'fa', confidence: 1 };
    },
    knowledgeSearch: async () => matches, knowledgeSourceLanguages: async () => [], completeKnowledgeCorpus: async () => matches,
    semanticKnowledgeSearchQueries: async () => [],
    validateKnowledgeMatches: (id, found) => {
      assert.equal(id, 77);
      // Turn the flag off after the Sol first pass: no NEW Sol spend, no model switch.
      if (mode === 'flag-flip' && calls.some(c => c.stage === 'extraction')) process.env.ODINLINK_SOL_EXTRACTION_MODE = 'off';
      return service.validateMatches(id, found, { strictSources: true, captureRevision: true, requireCompleteDocumentContext: true });
    },
    knowledgeServiceCatalog: async () => [],
    solCanaryTelemetry: e => telemetry.push(e), solShadowTelemetry: e => shadow.push(e),
    solShadowGenerate: async (r: any) => (await import('./providers/openai')).generateWithOpenAi(r),
    calendarAdapter: { getCalendarId: () => 'offline', getEvents: deny, checkSlots: deny, insertAppointment: deny, cancelAppointment: deny, updateAppointment: deny },
    recordAppointment: deny, cancelAppointmentRow: deny, updateAppointmentRow: deny,
  });
  try {
    await incidentInbound(boundary, channel, question);
    if (mode === 'shadow') await new Promise(resolve => setTimeout(resolve, SHADOW_SETTLE_MS));
    assert.deepEqual(unexpected, []);
    assert.equal(actions, 0, 'no booking or calendar action');
    assert.equal(replies.length, 1, 'exactly one customer delivery');
    const sol = calls.filter(c => c.model === 'gpt-6.1-sol'), luna = calls.filter(c => c.model === 'gpt-5.6-luna');
    if (mode === 'active') {
      assert.deepEqual(calls, [{ stage: 'extraction', model: 'gpt-6.1-sol' }, { stage: 're_extraction', model: 'gpt-6.1-sol' },
        { stage: 'verification', model: 'gpt-5.6-luna' }]);
      assert.equal(replies[0], faithful);
      assert.deepEqual(owner.events, ['reserve', 'settle', 'reserve', 'settle']);
      assert.deepEqual([...owner.reservations.values()].map(r => r.quote.stage), ['extraction', 're_extraction']);
      assert.equal(telemetry.length, 1);
      assert.equal(telemetry[0].publication, 'published');
      assert.equal(telemetry[0].reExtraction.trigger, 'ambiguous_connective');
      assert.deepEqual(telemetry[0].stages.map((s: any) => [s.stage, s.model]), [['extraction', 'sol'], ['re_extraction', 'sol'], ['verification', 'luna']]);
      assert.ok(telemetry[0].stages.filter((s: any) => s.model === 'sol').every((s: any) => s.costNanoUsd > 0));
    } else if (mode === 'production') {
      // Production profile recovery: the one-shot re-extraction still repairs a
      // legitimately rejected proposal when the turn has time, under the same
      // money controls, and the unchanged source-exhaustive Verification runs.
      assert.deepEqual(calls, [{ stage: 'extraction', model: 'gpt-6.1-sol' }, { stage: 're_extraction', model: 'gpt-6.1-sol' },
        { stage: 'verification', model: 'gpt-6.1-sol' }]);
      assert.equal(replies[0], faithful);
      assert.deepEqual([...owner.reservations.values()].map(r => r.quote.stage), ['extraction', 're_extraction', 'verification']);
      assert.ok(!owner.events.includes('retainUnknown'));
    } else {
      assert.notEqual(replies[0], purposeTa, 'the rejected purpose-تا proposal is never published');
      assert.notEqual(replies[0], faithful);
    }
    if (mode === 'off' || mode === 'other-tenant' || mode === 'no-owner') {
      assert.equal(sol.length, 0, 'no Sol request'); assert.ok(!calls.some(c => c.stage === 're_extraction'));
      assert.deepEqual(owner.events, []);
      assert.equal(telemetry.length, mode === 'no-owner' ? 1 : 0);
      if (mode === 'no-owner') { assert.equal(telemetry[0].profile, 'default'); assert.equal(telemetry[0].fallbackReason, 'budget_owner_unavailable');
        assert.equal(telemetry[0].publication, 'safe_fallback'); }
    }
    if (mode === 'flag-flip') {
      assert.deepEqual(calls.map(c => [c.stage, c.model]), [['extraction', 'gpt-6.1-sol']], 'no re_extraction, no Luna substitute extraction');
      assert.equal(telemetry[0].reExtraction.outcome, 'skipped'); assert.equal(telemetry[0].reExtraction.skipReason, 'flag_disabled');
    }
    if (mode === 're-extraction-fails') {
      assert.deepEqual(calls.map(c => c.stage), ['extraction', 're_extraction']);
      assert.ok(owner.events.includes('retainUnknown'));
      assert.equal(telemetry[0].reExtraction.outcome, 'failed'); assert.equal(telemetry[0].publication, 'safe_fallback');
      assert.equal(luna.length, 0, 'no mid-turn switch to Luna extraction or verification');
    }
    if (mode === 'shadow') {
      // The reply turn ran entirely on Luna and failed closed as today; the
      // detached shadow replayed extraction on Sol after the reply.
      assert.ok(luna.length >= 1 && luna.every(c => c.stage === 'extraction'));
      assert.deepEqual(sol.map(c => c.stage), ['extraction', 're_extraction']);
      assert.ok(!calls.some(c => c.stage === 'verification'), 'shadow never verifies; live turn rejected before verification');
      assert.equal(shadow.length, 1); assert.equal(shadow[0].publication, 'never_published');
      assert.equal(shadow[0].reExtraction.outcome, 'dispatched');
    }
    for (const line of [...lines, ...telemetry.map(e => JSON.stringify(e)), ...shadow.map(e => JSON.stringify(e))])
      assert.doesNotMatch(line, /rekommenderas|توصیه|اولین|46700000001/u, 'telemetry carries no source, question, reply or recipient text');
  } finally {
    configureKnowledgeBudgetOwner();
    delete process.env.ODINLINK_SOL_EXTRACTION_MODE; delete process.env.ODINLINK_SOL_EXTRACTION_TENANT_IDS;
    if (savedDefault === undefined) delete process.env.ODINLINK_AI_DEFAULT_MODEL; else process.env.ODINLINK_AI_DEFAULT_MODEL = savedDefault;
    incidentConfig.services = previousServices; boundary.reset();
  }
}

for (const channel of incidentChannels) {
  for (const mode of ['active', 'off', 'no-owner', 'shadow'] as const)
    test(`Sol extraction canary ${mode} through ${channel}`, t => exercise(t, channel, mode));
}
for (const channel of incidentChannels)
  test(`Sol production profile re-extraction recovery through ${channel}`, t => exercise(t, channel, 'production'));
for (const mode of ['flag-flip', 're-extraction-fails', 'other-tenant'] as const)
  test(`Sol extraction canary ${mode} (whatsapp)`, t => exercise(t, 'whatsapp', mode));
