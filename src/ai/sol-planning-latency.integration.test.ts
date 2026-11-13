/** P0 2026-11-12 23:28: Knowledge planning timed out at its 2500 ms host budget
 * on the Sol default. Real native channel handlers + the REAL OpenAI adapter
 * (SDK create mocked, offline) + scripted budget owner. Model OUTPUT is
 * SYNTHETIC; sources are the recorded tenant-3 production inventory. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Responses } from 'openai/resources/responses';
import { productionInventory } from '../../tests/helpers/multidoc-production-inventory';
import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';
import { configureKnowledgeBudgetOwner } from './knowledge-model-policy';
import { KNOWLEDGE_PLANNING_LIMIT_MS } from './knowledge-planning';

incidentFlags();
Object.assign(process.env, {
  OPENAI_API_KEY: 'synthetic-offline-only', ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off', ODINLINK_SOL_EXTRACTION_MODE: 'off',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: 'all',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2', ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: 'false',
  ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS: 'source-partitioned-v1', KNOWLEDGE_MAX_ACTIVE_REQUESTS: '1', ODINLINK_AI_DEFAULT_MODEL: 'gpt-6.1-sol',
});
delete process.env.OPENAI_BASE_URL;
incidentConfig.id = 3; incidentConfig.businessId = 3;
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const SOL = 'gpt-6.1-sol', LUNA = 'gpt-5.6-luna';
const question = 'اگه برای اولین بار میام، چند دقیقه قبل از وقت رزرو باید اونجا باشم؟';
const answer = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند.';

type Scenario = { model: string; planner: 'fast' | 'slow'; rejectOtherSource: boolean;
  rejectQuoteSource?: boolean; rejectAll?: boolean; changeQuoteSourceAfterReserve?: boolean };
async function turn(t: TestContext, channel: IncidentChannel, s: Scenario) {
  b.reset(); t.after(() => b.reset());
  process.env.ODINLINK_AI_DEFAULT_MODEL = s.model;
  let reserved = false;
  const owner = new ScriptedKnowledgeBudgetOwner(); owner.businessIds = [3];
  const reserve = owner.reserve.bind(owner); owner.reserve = async (q, signal) => { const r = await reserve(q, signal); reserved = true; return r; }; configureKnowledgeBudgetOwner(owner); t.after(() => configureKnowledgeBudgetOwner());
  const failures: any[] = [], decisions: any[] = [], replies: string[] = [];
  const calls: { stage: string; model: string; reasoning?: string; at: number; abortedAt?: number }[] = [];
  const plannerSchemas: string[] = [];
  for (const name of ['log', 'info', 'warn'] as const) t.mock.method(console, name, () => {});
  t.mock.method(console, 'error', (label: unknown, payload: any) => { if (label === '[OpenAIProviderFailure]') failures.push(payload); });
  const { service, matches: canonical } = await productionInventory();
  const partial = [0, 3, 4, 5, 2].map(i => canonical[i]);
  const quote = canonical[0].text!.match(/Kunder som besöker studion för första gången[^.]+\./u)![0];
  const otherSource = partial.find(m => m.sourceId !== canonical[0].sourceId)!.sourceId;
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => {
    replies.push(interceptedIncidentSend(url, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }], message_id: 'offline' }));
  });
  const reply = (p: any, value: unknown) => ({ id: 'resp_' + calls.length, object: 'response', model: p.model, status: 'completed', service_tier: 'default',
    reasoning: p.reasoning ?? null, prompt_cache_options: p.prompt_cache_options, output_text: JSON.stringify(value),
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 }, output_tokens_details: { reasoning_tokens: 5 } } });
  t.mock.method(Responses.prototype, 'create', async (p: any, options: any) => {
    const d = JSON.parse(p.input[0].content), instruction: string = p.instructions;
    if (instruction.includes('retrieval query planner')) {
      const call: typeof calls[number] = { stage: 'planning', model: p.model, reasoning: p.reasoning?.effort, at: Date.now() }; calls.push(call);
      plannerSchemas.push(p.text?.format?.name);
      if (s.planner === 'slow') return new Promise((_resolve, reject) => {
        const abort = () => { call.abortedAt = Date.now(); reject(options?.signal?.reason ?? new Error('aborted')); };
        if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
      });
      return reply(p, { requestKind: 'BUSINESS_INFORMATION', canonicalMeaning: 'arrival time before first booked visit', queries: [question, 'första besöket komma före'],
        queryLanguages: [{ query: question, language: 'fa' }, { query: 'första besöket komma före', language: 'sv' }], referenceResolution: 'NOT_REQUIRED',
        requestedFacets: [{ subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' }] });
    }
    if (instruction.startsWith('OdinLink source-language search query.')) { calls.push({ stage: 'source_query', model: p.model, at: Date.now() });
      return reply(p, { query: 'förstagångsbesökare minuter' }); }
    if (instruction.includes('UNIT EXTRACTION')) {
      calls.push({ stage: 'extraction', model: p.model, reasoning: p.reasoning?.effort, at: Date.now() });
      const evidence = d.evidence.find((e: any) => e.text.includes(quote));
      // Faithful extractor: with no evidence for the fact it proposes nothing.
      if (!evidence) return reply(p, { oversized: false, units: [] });
      return reply(p, { oversized: false, units: [{ facetIds: [d.facets[0].id], subject: 'first-time visitors', predicate: 'arrival recommendation',
        value: 'approximately 10 minutes before booked appointment', modality: 'recommended', negation: false, scope: 'first-time visitors',
        qualifiers: ['approximately', 'before booked appointment'], language: 'fa', text: answer,
        evidenceRefs: [p.text?.format?.name?.includes('literal') ? { evidenceId: evidence.id } : { evidenceId: evidence.id, exactQuote: quote }] }] });
    }
    if (instruction.includes('BATCH ENTAILMENT')) {
      calls.push({ stage: 'verification', model: p.model, reasoning: p.reasoning?.effort, at: Date.now() });
      const ids = d.units.map((u: any) => u.id);
      return reply(p, { decisions: d.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true,
          modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
        coverage: d.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: ids,
          obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: ids })) })),
        sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true, conflictsAbsent: true,
          evidenceIdsReviewed: d.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: ids,
          obligations: d.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id, state: 'COMPLETE' }))) } });
    }
    calls.push({ stage: 'other', model: p.model, at: Date.now() });
    throw new Error('unscripted provider stage');
  });
  const deny = async () => { throw new Error('booking/calendar mutation forbidden'); };
  b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
    semanticLanguageResolver: async () => ({ language: 'fa', confidence: 1 }), knowledgeSourceLanguages: async () => ['sv'],
    knowledgeSearch: async () => partial.map(m => ({ ...m, score: 1 })), semanticKnowledgeSearchQueries: async () => [], completeKnowledgeCorpus: async () => null,
    completeKnowledgeDocuments: async (id: number, found: any, anchors: any, options: any) => service.completeSelectedDocuments(id, found, anchors, options),
    validateKnowledgeMatches: async (id: number, found: any) => {
      const valid = await service.validateMatches(id, found, { strictSources: true, captureRevision: true, requireCompleteDocumentContext: true, signal: nativeKnowledgeTiming()?.signal });
      const quoteSource = canonical[0].sourceId;
      if (s.rejectAll) return [];
      return valid.filter((m: any) => !(s.rejectOtherSource && m.sourceId === otherSource) && !(s.rejectQuoteSource && m.sourceId === quoteSource) &&
        // Simulates the quote source changing (new revision) after the financial reservation.
        !(s.changeQuoteSourceAfterReserve && reserved && m.sourceId === quoteSource));
    },
    evidenceFirstDecisionDiagnostic: (e: any) => decisions.push(e), knowledgeServiceCatalog: async () => incidentConfig.services,
    calendarAdapter: { getCalendarId: () => 'offline', getEvents: deny, checkSlots: deny, insertAppointment: deny, cancelAppointment: deny, updateAppointment: deny },
    recordAppointment: deny, cancelAppointmentRow: deny, updateAppointmentRow: deny,
  } as any);
  await incidentInbound(b, channel, question);
  assert.equal(replies.length, 1, 'exactly one customer delivery');
  return { calls, replies, owner, failures, decisions, plannerSchemas };
}
const stages = (r: Awaited<ReturnType<typeof turn>>) => r.calls.map(c => [c.stage, c.model]);

for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const)
  test(`Sol default / ${channel}: planner on the interactive baseline within its budget; Sol extraction + source-exhaustive verification publish`, async t => {
    const r = await turn(t, channel, { model: SOL, planner: 'fast', rejectOtherSource: false });
    assert.deepEqual(stages(r), [['planning', LUNA], ['extraction', SOL], ['verification', SOL]]);
    assert.deepEqual(r.calls.filter(c => c.model === SOL).map(c => c.reasoning), ['low', 'low']);
    assert.deepEqual(r.owner.events, ['reserve', 'settle', 'reserve', 'settle']);
    assert.equal(r.replies[0], answer);
  });

test('slow planner: cancelled at the unchanged 2500 ms budget; extraction and verification keep their allowance and publish', async t => {
  const r = await turn(t, 'whatsapp', { model: SOL, planner: 'slow', rejectOtherSource: false });
  const planning = r.calls.find(c => c.stage === 'planning')!;
  assert.equal(planning.model, LUNA);
  assert.ok(planning.abortedAt !== undefined, 'planner request was cancelled, not left running');
  const waited = planning.abortedAt! - planning.at;
  assert.ok(waited >= KNOWLEDGE_PLANNING_LIMIT_MS - 100 && waited < KNOWLEDGE_PLANNING_LIMIT_MS + 1000, `planner budget ${waited} ms`);
  assert.ok(r.decisions.some(e => e.stage === 'planning' && e.reason === 'LITERAL_REQUEST_FALLBACK'));
  const extraction = r.decisions.find(e => e.stage === 'extraction' && e.transportSuccess === true);
  assert.ok(extraction && extraction.timeoutMs >= 10_000, `extraction allowance ${extraction?.timeoutMs}`);
  assert.deepEqual(stages(r).filter(([stage]) => stage !== 'planning'), [['extraction', SOL], ['verification', SOL]]);
  assert.equal(r.replies[0], answer);
});

test('22:55 fix: one source excluded before the reservation; Sol extracts and verifies the valid subset and publishes', async t => {
  const r = await turn(t, 'whatsapp', { model: SOL, planner: 'fast', rejectOtherSource: true });
  assert.deepEqual(stages(r), [['planning', LUNA], ['extraction', SOL], ['verification', SOL]]);
  assert.deepEqual(r.owner.events, ['reserve', 'settle', 'reserve', 'settle'], 'two reservations, both settled');
  assert.equal(r.failures.length, 0);
  assert.equal(r.replies[0], answer);
});

test('a sent source changes after the reservation: fail closed before dispatch, hold retained, safe reply', async t => {
  const r = await turn(t, 'whatsapp', { model: SOL, planner: 'fast', rejectOtherSource: false, changeQuoteSourceAfterReserve: true });
  assert.deepEqual(stages(r), [['planning', LUNA]], 'no extraction request reached the provider');
  assert.ok(r.failures.some(f => f.policyCode === 'knowledge_sol_source_or_turn_changed'));
  assert.deepEqual(r.owner.events, ['reserve', 'retainUnknown']);
  assert.notEqual(r.replies[0], answer);
});

test('no valid evidence: no reservation, no Sol dispatch, safe reply', async t => {
  const r = await turn(t, 'whatsapp', { model: SOL, planner: 'fast', rejectOtherSource: false, rejectAll: true });
  assert.deepEqual(stages(r).filter(([stage]) => stage !== 'planning'), []);
  assert.deepEqual(r.owner.events, []);
  assert.notEqual(r.replies[0], answer);
});

test('valid sources without the requested fact: Sol extraction runs on them but nothing unsupported is published', async t => {
  const r = await turn(t, 'whatsapp', { model: SOL, planner: 'fast', rejectOtherSource: false, rejectQuoteSource: true });
  assert.deepEqual(stages(r), [['planning', LUNA], ['extraction', SOL]], 'no units -> no verifier call');
  assert.deepEqual(r.owner.events, ['reserve', 'settle']);
  assert.notEqual(r.replies[0], answer);
  assert.doesNotMatch(r.replies[0], /۱۰|10/u, 'no fabricated minutes figure');
});

test('invalid other source on Luna rollback: answers from the valid source under the same gates', async t => {
  const r = await turn(t, 'whatsapp', { model: LUNA, planner: 'fast', rejectOtherSource: true });
  assert.deepEqual(stages(r), [['planning', LUNA], ['extraction', LUNA], ['verification', LUNA]]);
  assert.deepEqual(r.owner.events, []);
  assert.equal(r.replies[0], answer);
});

for (const [flag, expected] of [[undefined, undefined], ['low', 'low'], ['LOW', undefined], ['minimal', undefined]] as const)
  test(`planner reasoning flag ${flag ?? 'unset'}: Luna planner effort ${expected ?? 'default'}; schema, deadline and publication unchanged`, async t => {
    const saved = process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING;
    if (flag === undefined) delete process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING; else process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING = flag;
    t.after(() => { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING; else process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING = saved; });
    const r = await turn(t, 'telegram', { model: SOL, planner: 'fast', rejectOtherSource: false });
    const planning = r.calls.filter(c => c.stage === 'planning');
    assert.deepEqual(planning.map(c => [c.model, c.reasoning]), [[LUNA, expected]]);
    assert.deepEqual(r.plannerSchemas, ['odinlink_knowledge_planning_v2']);
    assert.deepEqual(stages(r).filter(([stage]) => stage !== 'planning'), [['extraction', SOL], ['verification', SOL]]);
    assert.equal(r.replies[0], answer);
  });

test('planner reasoning flag low + slow planner: same 2500 ms cancellation and whole-question fallback', async t => {
  const saved = process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING; process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING = 'low';
  t.after(() => { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING; else process.env.ODINLINK_KNOWLEDGE_PLANNING_REASONING = saved; });
  const r = await turn(t, 'telegram', { model: SOL, planner: 'slow', rejectOtherSource: false });
  const planning = r.calls.find(c => c.stage === 'planning')!;
  assert.equal(planning.reasoning, 'low');
  const waited = planning.abortedAt! - planning.at;
  assert.ok(waited >= KNOWLEDGE_PLANNING_LIMIT_MS - 100 && waited < KNOWLEDGE_PLANNING_LIMIT_MS + 1000, `planner budget ${waited} ms`);
  assert.ok(r.decisions.some(e => e.stage === 'planning' && e.reason === 'LITERAL_REQUEST_FALLBACK'));
  assert.equal(r.replies[0], answer);
});
