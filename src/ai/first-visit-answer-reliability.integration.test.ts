import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, type KnowledgeSource } from '../../knowledge';
import { incidentChannels, incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import { ACCEPTANCE_ROWS, type AcceptanceRow } from '../../tests/helpers/first-visit-acceptance-cases';
import { formatBusinessSupportVerificationUnavailable } from './business-information';
import { configureKnowledgeBudgetOwner, executeKnowledgeGeneration } from './knowledge-model-policy';
import { AiReliabilityError } from './reliability';
import { routeOpenAiRequest } from './providers/openai';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';

// SYNTHETIC end-to-end acceptance matrix for the shared Knowledge answer path:
// real native adapters, retrieval/corpus completion, citation, numerical,
// recovery, verification-protocol, coverage, language, budget and publication
// gates. Provider outputs are deterministic mocks; the verifier mock models an
// accurate independent verifier (it entails only faithful texts and requires
// every requested fact). No paid provider, network, database or live message.
incidentFlags();
Object.assign(process.env, {
  OPENAI_API_KEY: 'synthetic-offline-only',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2',
  ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: 'false',
  ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS: 'off',
  ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off',
  ODINLINK_HIERARCHICAL_SEARCH: 'off',
  KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED: 'false',
});
Object.assign(incidentConfig, { id: 3, businessId: 3 });
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const captured = JSON.parse(readFileSync(new URL('../../tests/fixtures/admotion-mixed-inventory.json', import.meta.url), 'utf8')).sources;
const sources: KnowledgeSource[] = captured.map((s: any) => ({ ...s, businessId: s.business_id, createdAt: s.created_at, updatedAt: s.updated_at }));
const inline = sources.find(s => s.type === 'text')!;
const CONFIRMATION_QUOTE = 'Ta gärna med din bokningsbekräftelse, digitalt eller på papper.';

export type Positive = 'digit' | 'written' | 'relative' | 'denial' | 'redundant' | 'unanchored';
export type Negative = 'wrong' | 'after' | 'required' | 'requiredExact' | 'negated' | 'wrong_citation' | 'missing_citation' | 'foreign' |
  'stale' | 'missing_fact' | 'invalid_coverage' | 'mixed_language' | 'recovery_deadline' | 'recovery_denied' | 'recovery_repeat';
const RECOVERED: readonly Positive[] = ['redundant', 'unanchored'];

type Outcome = { reply: string; stages: string[]; routes: string[]; quotes: number; ownerEvents: string[]; reExtraction: any[]; errors: unknown[] };

async function run(t: TestContext, channel: IncidentChannel, row: AcceptanceRow, positive?: Positive, negative?: Negative): Promise<Outcome> {
  let now = Date.now();
  if (negative === 'recovery_deadline') t.mock.method(Date, 'now', () => now);
  boundary.reset();
  t.after(() => boundary.reset());
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  const storage = new InMemoryKnowledgeStorage();
  for (const source of sources) await storage.create(structuredClone(source));
  const service = new KnowledgeService(storage, storage, null);
  const owner = new ScriptedKnowledgeBudgetOwner();
  owner.businessIds = [3];
  const previousModel = process.env.ODINLINK_AI_DEFAULT_MODEL;
  process.env.ODINLINK_AI_DEFAULT_MODEL = 'gpt-6.1-sol';
  configureKnowledgeBudgetOwner(owner);
  t.after(() => {
    if (previousModel === undefined) delete process.env.ODINLINK_AI_DEFAULT_MODEL; else process.env.ODINLINK_AI_DEFAULT_MODEL = previousModel;
    configureKnowledgeBudgetOwner();
  });
  const decisions: any[] = [], summaries: any[] = [], replies: string[] = [], stages: string[] = [], errors: unknown[] = [];
  t.mock.method(console, 'info', (label: unknown, value: any) => { if (label === '[EvidenceFirstKnowledge]') summaries.push(JSON.parse(value)); });
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }] }));
  });
  const forbidden = async () => { errors.push('unexpected action'); throw Error('offline'); };
  const firstArrival = positive ? row[positive] : negative && ['wrong', 'after', 'required', 'requiredExact', 'negated'].includes(negative)
    ? row[negative as 'wrong'] : negative?.startsWith('recovery_') ? row.redundant : row.digit;
  const replacementArrival = negative === 'recovery_repeat' ? row.redundant : negative === 'requiredExact' ? row.requiredExact : row.digit;
  // The verifier mock models an accurate verifier, except in the mixed-language
  // scenario, where it reproduces the observed verifier blind spot (approving a
  // mixed-language unit) so that only the local language backstop can block it.
  const mixedConfirmation = row.confirmation + row.foreignClause;
  const faithful = new Set([row.digit, row.written, row.relative, row.denial, row.confirmation, ...(negative === 'mixed_language' ? [mixedConfirmation] : [])]);
  const arrivalTexts = new Set([row.digit, row.written, row.relative, row.denial]);
  boundary.configure({
    offlineAi: true, structuredUnderstandingAdoptionRuntime: null,
    postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }),
    knowledgeSearch: forbidden, semanticKnowledgeSearchQueries: forbidden,
    completeKnowledgeCorpus: (id: number, anchors: any, options: any, mode: any, decline: any) => service.completeSmallCorpus(id, anchors, options, mode, decline),
    knowledgeSourceLanguages: async () => [],
    validateKnowledgeMatches: async (id: number, matches: any) => {
      const current = await service.validateMatches(id, matches, { strictSources: true, requireCompleteDocumentContext: true });
      return negative === 'foreign' ? current.map((r: any, i: number) => i === 0 ? { ...r, businessId: 4 } : r) : current;
    },
    evidenceFirstDecisionDiagnostic: (event: any) => decisions.push(event),
    aiGenerate: async (request: any) => {
      try {
        const respond = async () => {
          const data = JSON.parse(request.messages[0].content);
          if (request.systemInstruction.includes('retrieval query planner')) return { text: JSON.stringify({
            requestKind: 'BUSINESS_INFORMATION', canonicalMeaning: 'first visit arrival and preparation', referenceResolution: 'NOT_REQUIRED',
            queries: [row.question.slice(0, 120)],
            requestedFacets: [{ subject: 'first-time visitor', attribute: 'first visit preparation', questionType: 'description' }] }) };
          assert.ok(data.evidence.every((item: any) => item.businessId === 3), 'Only same-tenant evidence reaches a provider');
          assert.equal(data.requestedLanguage, row.language);
          const reExtracting = request.knowledgeExecution?.stage === 're_extraction';
          const extracting = request.systemInstruction.includes('UNIT EXTRACTION');
          const route = routeOpenAiRequest(request.model, request);
          assert.equal(route.model, 'gpt-6.1-sol');
          assert.equal(route.stage, reExtracting ? 'knowledge_re_extraction' : extracting ? 'knowledge_extraction' : 'knowledge_verification');
          if (extracting) {
            stages.push(reExtracting ? 're_extraction' : 'extraction');
            const arrivalItem = data.evidence.find((item: any) => /Kunder som besöker[^.]+cirka 10 minuter/u.test(item.text));
            const confirmationItem = data.evidence.find((item: any) => item.text.includes(CONFIRMATION_QUOTE));
            assert.ok(arrivalItem && confirmationItem);
            const quote = arrivalItem.text.match(/Kunder som besöker[^.]+\./u)[0];
            const arrival: any = { facetIds: [data.facets[0].id], subject: 'first-time visitors', predicate: 'arrival timing',
              value: 'approximately 10 minutes before the booked appointment', modality: 'recommended', negation: false, scope: 'first visit',
              qualifiers: ['approximately'], language: row.language, text: reExtracting ? replacementArrival : firstArrival,
              evidenceRefs: [{ evidenceId: arrivalItem.id, exactQuote: quote }] };
            if (!reExtracting && negative === 'wrong_citation') arrival.evidenceRefs[0].exactQuote = 'Not present in the source.';
            if (!reExtracting && negative === 'missing_citation') arrival.evidenceRefs = [];
            if (!reExtracting && negative === 'recovery_denied') owner.mode = 'deny';
            const confirmation = { ...arrival, predicate: 'bringing booking confirmation', value: 'digital or paper confirmation', qualifiers: [],
              text: negative === 'mixed_language' ? row.confirmation + row.foreignClause : row.confirmation,
              evidenceRefs: [{ evidenceId: confirmationItem.id, exactQuote: CONFIRMATION_QUOTE }] };
            return { text: JSON.stringify({ oversized: false, units: negative === 'missing_fact' ? [arrival] : [arrival, confirmation] }) };
          }
          assert.match(request.systemInstruction, /BATCH ENTAILMENT/u);
          stages.push('verification');
          if (negative === 'stale') await storage.create({ ...inline, content: inline.content + '\nRevision changed.' });
          const entailed = (u: any) => faithful.has(u.text);
          const complete = data.units.every(entailed) && data.units.some((u: any) => arrivalTexts.has(u.text)) &&
            data.units.some((u: any) => u.text === row.confirmation || (negative === 'mixed_language' && u.text === mixedConfirmation));
          const ids = data.units.filter(entailed).map((u: any) => u.id);
          return { text: JSON.stringify({
            decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: entailed(u) ? 'ENTAILED' : 'CONTRADICTED',
              meaningPreserved: entailed(u), modalityPreserved: entailed(u), qualifiersPreserved: true, relevant: true,
              languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
            coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: complete,
              incompletenessReason: complete ? 'NONE' : 'MISSING_RELEVANT_FACT', materialUnitIds: ids,
              obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: complete ? 'COVERED' : 'UNRESOLVED', unitIds: ids })) })),
            sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: complete, conditionsPreserved: true,
              conflictsAbsent: true, evidenceIdsReviewed: negative === 'invalid_coverage' ? [] : data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: ids,
              obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id,
                state: complete ? 'COMPLETE' : 'AVAILABLE_SOURCE_FACT_OMITTED' }))) },
          }) };
        };
        if (!request.knowledgeExecution) return { functionCalls: [], ...await respond() };
        const { response, usage } = await executeKnowledgeGeneration(request, {
          model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, instructions: request.systemInstruction,
          input: [{ role: 'user', content: request.messages[0].content }], text: { format: { type: 'json_schema', ...request.structuredOutput } },
        }, async () => ({ ...await respond(), model: 'gpt-6.1-sol', service_tier: 'default', reasoning: { effort: 'low' },
          prompt_cache_options: { mode: 'implicit', ttl: '30m' },
          usage: { input_tokens: 200, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
        if (negative === 'recovery_deadline') now += 18_000;
        return { text: response.text, knowledgeUsage: usage, functionCalls: [] };
      } catch (error) {
        if (!(negative === 'recovery_denied' && /reservation_denied/u.test(String(error)))) errors.push(error);
        throw error;
      }
    },
    calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden,
      cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden,
  });
  await incidentInbound(boundary, channel, row.question);
  const routes = decisions.filter(e => e.eventType === 'publication').map(e => e.route);
  return { reply: replies[0] ?? '', stages, routes, quotes: owner.reservations.size, ownerEvents: owner.events,
    reExtraction: summaries.map(s => s.reExtraction).filter(Boolean), errors: replies.length === 1 ? errors : [...errors, `replies=${replies.length}`] };
}

const ownerCycle = (stages: readonly string[]) => stages.flatMap(() => ['reserve', 'settle']);

for (const row of ACCEPTANCE_ROWS) for (const channel of incidentChannels) for (const positive of ['digit', 'written', 'relative', 'denial', 'redundant', 'unanchored'] as const) {
  test(`positive/${row.language}/${channel}/${positive}: delivers the complete verified answer`, async t => {
    const recovered = RECOVERED.includes(positive);
    const outcome = await run(t, channel, row, positive);
    assert.deepEqual(outcome.errors, []);
    const arrival = recovered ? row.digit : row[positive];
    // Delivered-answer level: the complete answer, both requested facts, in the target language.
    assert.equal(outcome.reply, [arrival, row.confirmation].join(' '));
    assert.ok(outcome.routes.length > 0 && outcome.routes.every(route => route === 'verified_manifest'), JSON.stringify(outcome.routes));
    assert.deepEqual(outcome.stages, recovered ? ['extraction', 're_extraction', 'verification'] : ['extraction', 'verification']);
    // Every provider stage is budget-reserved and settled; at most one replacement extraction.
    assert.equal(outcome.quotes, outcome.stages.length);
    assert.deepEqual(outcome.ownerEvents, ownerCycle(outcome.stages));
    assert.deepEqual(outcome.reExtraction, recovered ? [{ trigger: 'numerical_representation', outcome: 'dispatched' }] : [{ trigger: 'none', outcome: 'not_needed' }]);
  });
}

const negativeStages: Record<Negative, readonly string[]> = {
  wrong: ['extraction'], after: ['extraction'], negated: ['extraction'],
  required: ['extraction', 'verification'],
  requiredExact: ['extraction', 're_extraction'],
  wrong_citation: ['extraction'], missing_citation: ['extraction'],
  foreign: [],
  stale: ['extraction', 'verification'], missing_fact: ['extraction', 'verification'], invalid_coverage: ['extraction', 'verification'],
  mixed_language: ['extraction', 'verification'],
  recovery_deadline: ['extraction'], recovery_denied: ['extraction'], recovery_repeat: ['extraction', 're_extraction'],
};
for (const row of ACCEPTANCE_ROWS) for (const channel of incidentChannels) for (const negative of Object.keys(negativeStages) as Negative[]) {
  test(`negative/${row.language}/${channel}/${negative}: never publishes an unsafe or incomplete answer`, async t => {
    const outcome = await run(t, channel, row, undefined, negative);
    assert.deepEqual(outcome.errors, []);
    // Publication safety first (UNSAFE_PUBLICATION marks a delivered unsafe answer).
    assert.ok(outcome.routes.every(route => route !== 'verified_manifest' && route !== 'partial_manifest'), `UNSAFE_PUBLICATION route ${JSON.stringify(outcome.routes)}`);
    for (const unsafe of [row.wrong, row.after, row.required, row.requiredExact, row.negated, row.redundant, row.foreignClause.trim(), row.confirmation])
      assert.ok(!outcome.reply.includes(unsafe), `UNSAFE_PUBLICATION text: ${unsafe}`);
    if (negative !== 'foreign' && negative !== 'stale')
      assert.equal(outcome.reply, formatBusinessSupportVerificationUnavailable(row.language, row.fallbackSubject));
    assert.deepEqual(outcome.stages, negativeStages[negative]);
    // Strict provider limits: never more than one replacement, every stage reserved.
    assert.ok(outcome.stages.filter(stage => stage === 're_extraction').length <= 1);
    assert.equal(outcome.quotes, outcome.stages.length);
    // A denied replacement reservation is attempted once and never dispatched.
    assert.deepEqual(outcome.ownerEvents, [...ownerCycle(outcome.stages), ...(negative === 'recovery_denied' ? ['reserve'] : [])]);
    if (negative === 'recovery_deadline') assert.deepEqual(outcome.reExtraction, [{ trigger: 'numerical_representation', outcome: 'skipped', skipReason: 'deadline' }]);
    if (negative === 'recovery_repeat') assert.deepEqual(outcome.reExtraction, [{ trigger: 'numerical_representation', outcome: 'dispatched' }]);
    if (['wrong', 'after', 'negated', 'wrong_citation', 'missing_citation'].includes(negative))
      assert.deepEqual(outcome.reExtraction, [{ trigger: 'other_rejection', outcome: 'not_eligible' }]);
  });
}
