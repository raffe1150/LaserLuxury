import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturedSources, productionInventory } from '../../tests/helpers/multidoc-production-inventory';
import { createClient } from '@supabase/supabase-js';
import { KnowledgeService, SupabaseKnowledgeStorage } from '../../knowledge';
import { answerEvidenceBindings } from './business-information-answer-plan';
import { AiReliabilityError } from './reliability';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
import { normalizeConversationText } from './booking-intelligence';

import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, incidentChannels, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';

// SYNTHETIC language, extraction and independent-verifier outputs. These tests
// exercise real native adapters, recovery, citation/numerical/coverage checks,
// current in-memory sources and publication, never a real provider or database.
incidentFlags();
Object.assign(process.env, {
  OPENAI_API_KEY: 'synthetic-offline-only', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3', ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2',
  ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: 'false', ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS: 'source-partitioned-v1',
});
incidentConfig.id = 3; incidentConfig.businessId = 3;
const cases = [
  ['en', "How many minutes before my appointment should I arrive if it's my first visit?", 'According to the test document, first-time visitors are recommended to arrive approximately 10 minutes before their booked appointment.'],
  ['de', 'Wie viele Minuten vor meinem Termin sollte ich kommen, wenn ich zum ersten Mal zu Besuch bin?', 'Laut dem Testdokument wird Erstbesuchern empfohlen, etwa 10 Minuten vor ihrem gebuchten Termin zu kommen.'],
] as const;
const persianCase = ['fa',
  'برای مشتری‌هایی که اولین بار به استودیو میان، زمان پیشنهادی برای رسیدن قبل از وقت رزرو چقدره؟',
  'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند.',
] as const;
const persianPurposeCase = ['fa', persianCase[1],
  'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند تا زمان کافی برای آماده شدن داشته باشند.',
] as const; // SYNTHETIC faithful proposal, not historical production output.
const additionalPersianPurposes = [
  ['fa', persianCase[1], persianCase[2].slice(0, -1) + ' تا بتوانند با آرامش آماده شوند.'],
  ['fa', persianCase[1], persianCase[2].slice(0, -1) + ' تا برای آماده شدن زمان کافی داشته باشند.'],
  ['fa', persianCase[1], persianCase[2].slice(0, -1) + '، تا بتوانند با آرامش آماده شوند.'],
] as const;
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
type Fault = 'none' | 'rejected' | 'incomplete' | 'foreign' | 'revoked' | 'number' | 'scope' | 'required' | 'overflow' | 'conflict' | 'revision' | 'badquote' | 'unknown-id';

async function exercise(t: any, channel: IncidentChannel, spec: typeof cases[number] | typeof persianCase | typeof persianPurposeCase | typeof additionalPersianPurposes[number], fault: Fault = 'none', selection: 'old' | 'new' | 'both' = 'both', tombstones = false) {
  b.reset();
  t.after(() => b.reset());
  const recoveryLogs: any[] = [];
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (...args: any[]) => {
    if (args[0] === '[BusinessRecoveryDiagnostic]') recoveryLogs.push(JSON.parse(args[1]));
  });
  const [language, question, answer] = spec;
  const normalizedQuestion = normalizeConversationText(question);
  const { storage, service: memoryService, matches } = await productionInventory(selection);
  if (selection === 'new') {
    assert.equal(matches.length, 3);
    assert.ok(matches.every(m => m.sourceId === '2ac009ba-c913-48bc-b13d-c09adf34c8e0'));
  }
  let service = memoryService;
  if (tombstones) {
    assert.equal(selection, 'new'); assert.ok(['none', 'rejected', 'incomplete', 'unknown-id'].includes(fault));
    assert.equal(matches.length, 3);
    const rows = [...structuredClone(capturedSources)];
    const old = rows.find((r: any) => r.id === '8eec8b5c-87bc-4a7b-9789-b65d977b5ae4');
    old.status = 'deleted'; old.content = ''; old.metadata = { segments: [] };
    for (let i = 0; i < 5; i++) rows.push({ ...old, id: `synthetic-tombstone-${i}` });
    const client = createClient('https://synthetic.invalid', 'synthetic-local-only', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(init?.method || 'GET', 'GET'); assert.equal(url.pathname, '/rest/v1/knowledge_sources');
        if (!url.searchParams.has('business_id')) { assert.equal(url.searchParams.get('select'), 'id'); return new Response('[]'); }
        assert.equal(url.searchParams.get('business_id'), 'eq.3');
        const status = url.searchParams.get('status');
        assert.ok(status === null || status === 'neq.deleted');
        const visible = rows.filter((r: any) => r.business_id === 3 && (status === null || r.status !== 'deleted'));
        return new Response(JSON.stringify(visible.slice(0, Number(url.searchParams.get('limit') || 1000))), {
          headers: { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(0, visible.length - 1)}/${visible.length}` },
        });
      } },
    });
    const backend = new SupabaseKnowledgeStorage(client);
    service = new KnowledgeService(backend, backend, null, true);
  }
  if (fault === 'overflow') {
    const source = (await storage.list(3)).find(s => s.id === matches.at(-1)!.sourceId)!;
    const metadata = structuredClone(source.metadata);
    (metadata.segments as any[]).at(-1).section = 'SYNTHETIC-location-'.repeat(20);
    await storage.create({...source, metadata});
    const updated = await service.completeSmallCorpus(3, [], undefined, 'native-documentary');
    assert.ok(updated); matches.splice(0, matches.length, ...updated);
  }
  // SYNTHETIC conflicting policy, explicitly separate from the captured content.
  if (fault === 'conflict') {
    const source = (await storage.list(3)).find(s => s.id === '2ac009ba-c913-48bc-b13d-c09adf34c8e0');
    assert.ok(source);
    await storage.create({ ...source, content: source.content!.replace('för att hinna förbereda sig i lugn och ro.', 'endast vid besök bokade på vardagar.'.padEnd('för att hinna förbereda sig i lugn och ro.'.length)) });
    const updated = await service.completeSmallCorpus(3, [], undefined, 'native-documentary');
    assert.ok(updated); matches.splice(0, matches.length, ...updated);
  }
  const firstVisitSource = matches.find(m => m.text!.includes('Kunder som besöker studion för första gången'))!.text!.match(/Kunder som besöker studion för första gången[^.]+\./u)![0];
  const expectedBindings = answerEvidenceBindings(3, matches);
  const retrievals: any[] = [];
  const stages: string[] = [], decisions: any[] = [], inputs: any[] = [], replies: string[] = [], providerErrors: string[] = [];
  let plannerCalls = 0, actions = 0;
  const forbidden = async () => { actions++; assert.fail('No booking/calendar/database action is authorized'); };
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  b.configure({
    offlineAi: true, postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
    semanticLanguageResolver: async () => ({ language, confidence: 1 }),
    knowledgeSourceLanguages: async id => { assert.equal(id, 3); return ['sv']; },
    // Captured canonical inventory/ranking replay. No claim of replaying an LLM or vector search.
    knowledgeSearch: async id => { assert.equal(id, 3); return tombstones ? [] : fault === 'foreign' ? matches.map(m => ({...m, businessId: 9})) : matches.map(m => ({...m, score: 1})); },
    semanticKnowledgeSearchQueries: async () => [],
    completeKnowledgeCorpus: async (id, lexical, options, mode) => tombstones ? service.completeSmallCorpus(id, lexical, options, mode) : null,
    completeKnowledgeDocuments: async (id, found, anchors, options) => fault === 'foreign' ? null : service.completeSelectedDocuments(id, found, anchors, options),
    validateKnowledgeMatches: async (id, found) => {
      assert.equal(id, 3);
      try { assert.deepEqual(found.map(({score, ...row}) => row), matches.map(({score, ...row}) => row), 'Freshness receives all canonical rows with original identity, revision and location'); } catch (e) { providerErrors.push(String(e)); throw e; }
      return service.validateMatches(id, found, { strictSources: true, captureRevision: true, requireCompleteDocumentContext: true, signal: nativeKnowledgeTiming()?.signal });
    },
    knowledgeRetrievalDiagnostic: event => retrievals.push(event),
    knowledgeServiceCatalog: async id => { assert.equal(id, 3); return incidentConfig.services; },
    evidenceFirstDecisionDiagnostic: event => decisions.push(event),
    aiGenerate: async request => {
      try {
        if (request.systemInstruction.includes('retrieval query planner')) {
          plannerCalls++;
          throw new AiReliabilityError('TIMEOUT', 'SYNTHETIC forced planner timeout');
        }
        if (fault === 'foreign') { assert.ok(!JSON.stringify(request).includes(firstVisitSource)); return {functionCalls: [], text: 'I cannot verify an answer about the requested details right now. The business can confirm what applies.'}; }
        const data = JSON.parse(request.messages[0].content);
        assert.equal(data.question, normalizedQuestion, 'Only the existing channel punctuation normalization may change the question');
        assert.deepEqual(request.tools, []);
        assert.equal(data.facets.length, 1);
        assert.equal(data.facets[0].obligations[0].description, normalizedQuestion);
        assert.ok(data.evidence.length > 0);
        assert.ok(data.evidence.every((e: any) => e.businessId === 3));
        assert.ok(!JSON.stringify(data).includes('FOREIGN_SOURCE_SENTINEL'));
        inputs.push(data);
        if (fault === 'conflict') {
          assert.ok(data.evidence.some((e: any) => e.text.includes('endast vid besök bokade på vardagar.')));
          assert.ok(data.evidence.some((e: any) => e.text.includes('för att hinna förbereda sig')));
        }
        assert.deepEqual(data.evidence.map((e: any) => [e.id,e.businessId,e.text]), expectedBindings.map(b => [b.evidence.id,b.evidence.businessId,b.evidence.text]), 'Every captured source group reaches the model; source/version/ranges remain backend authority');
        const evidence = data.evidence.find((e: any) => e.text.includes(firstVisitSource));
        assert.ok(evidence, 'Use the actual source wording, including cirka');
        if (request.systemInstruction.includes('UNIT EXTRACTION')) {
          stages.push('extraction');
          if (fault === 'revoked') await storage.delete(3, matches[0].sourceId);
          if (fault === 'revision') { const source = (await storage.list(3)).find(s => s.id === matches[0].sourceId)!; await storage.create({...source, content: source.content + '\nSYNTHETIC revised content'}); }
          const text = fault === 'number' ? answer.replace(/10|۱۰/u, '20') : fault === 'scope'
            ? 'All visitors are recommended to arrive approximately 10 minutes before their booked appointment.' : fault === 'required'
            ? 'First-time visitors must arrive approximately 10 minutes before their booked appointment.' : answer;
          return { functionCalls: [], text: JSON.stringify({ oversized: false, units: [{ facetIds: ['f1'], subject: 'first-time visitors', predicate: 'arrival recommendation',
            value: 'approximately 10 minutes before booked appointment', modality: fault === 'required' ? 'required' : 'recommended', negation: false,
            scope: fault === 'scope' ? 'all visitors' : 'first-time visitors', qualifiers: ['approximately', 'before booked appointment'], language, text,
            evidenceRefs: [{ evidenceId: fault === 'unknown-id' ? 'e999' : evidence.id, ...(request.systemInstruction.includes('literal-evidence-v1') ? {} : { exactQuote: fault === 'badquote' ? 'SYNTHETIC unsupported citation' : firstVisitSource }) }] }] }) };
        }
        assert.ok(request.systemInstruction.includes('BATCH ENTAILMENT'), 'No unrestricted or optional answer generation');
        stages.push('verification');
        assert.equal(data.units.length, 1, 'The real numerical/citation parser must admit the source-grounded unit');
        for (const ref of data.units[0].evidenceRefs) assert.ok(evidence.text.includes(ref.exactQuote));
        const ids = data.units.map((u: any) => u.id), valid = !['rejected', 'scope', 'required', 'conflict'].includes(fault), complete = valid && fault !== 'incomplete';
        return { functionCalls: [], text: JSON.stringify({
          decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: valid ? 'ENTAILED' : 'UNKNOWN',
            meaningPreserved: valid, modalityPreserved: fault !== 'required', qualifiersPreserved: fault !== 'scope',
            relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
          coverage: [{ facetId: 'f1', requestAligned: true, materialFactsComplete: complete, incompletenessReason: complete ? 'NONE' : 'MISSING_RELEVANT_FACT',
            materialUnitIds: valid ? ids : [], obligations: [{ obligationId: 'f1.o1', status: complete ? 'COVERED' : 'UNRESOLVED', unitIds: valid ? ids : [] }] }],
          sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: complete,
            conditionsPreserved: valid, conflictsAbsent: fault !== 'conflict', evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: valid ? ids : [],
            obligations: [{ facetId: 'f1', obligationId: 'f1.o1', state: complete ? 'COMPLETE' : 'AVAILABLE_SOURCE_FACT_OMITTED' }] },
        }) };
      } catch (error) {
        if (!(error instanceof AiReliabilityError)) providerErrors.push(String(error));
        throw error;
      }
    },
    calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden,
      insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
  });
  await incidentInbound(b, channel, question);
  assert.deepEqual(providerErrors, [], 'Synthetic provider assertions must not be hidden by production fallback');
  assert.equal(plannerCalls, 1, 'Exercise forced planner timeout, not a pre-supplied facet or direct-plan shortcut');
  assert.equal(actions, 0);
  assert.equal(replies.length, 1);
  assert.ok(decisions.some(e => e.stage === 'planning' && e.reason === 'DEADLINE'));
  assert.ok(decisions.some(e => e.stage === 'planning' && e.reason === 'LITERAL_REQUEST_FALLBACK'), 'The timeout must recover a full-question facet');
  const publication = decisions.filter(e => e.stage === 'publication').at(-1);
  if (tombstones) assert.ok(retrievals.at(-1)?.canonicalCompletion.some((c: any) => c.kind === 'inventory' && c.outcome === 'complete' && c.chunks === 3));
  if (fault === 'none') {
    assert.equal(retrievals.at(-1)?.formattedKnowledgePresent, true);
    assert.equal(retrievals.at(-1)?.matchCount, matches.length);
    assert.deepEqual(stages, ['extraction', 'verification'], JSON.stringify(decisions.map(e => ({ stage: e.stage, reason: e.reason }))));
    assert.equal(publication?.route, 'verified_manifest');
    assert.equal(publication?.publishableUnits, 1);
    assert.equal(replies[0], answer);
    assert.ok(inputs[0].evidence.some((e: any) => e.text.includes('cirka 10 minuter före')));
  } else {
    assert.ok(!['verified_manifest', 'partial_manifest'].includes(publication?.route));
    assert.notEqual(replies[0], answer);
    assert.doesNotMatch(replies[0], /10|20|99|approximately|recommended|must arrive|All visitors/u);
    if (fault === 'foreign' || fault === 'overflow') assert.deepEqual(stages, []);
    else if (fault === 'number' || fault === 'revoked' || fault === 'revision' || fault === 'badquote' || fault === 'unknown-id') assert.deepEqual(stages, ['extraction']);
    else assert.deepEqual(stages, ['extraction', 'verification']);
    if (fault === 'number') assert.ok(decisions.some(e => e.reason === 'NUMERICAL_CONSTRAINT'));
  }
  if (fault === 'overflow') {
    assert.equal(retrievals.at(-1)?.formattingFailure, 'EVIDENCE_FORMAT_OVERFLOW');
    assert.ok(retrievals.at(-1)?.serializedKnowledgeLength > 9000);
    assert.ok(decisions.some(e => e.stage === 'formatting' && e.reason === 'EVIDENCE_FORMAT_OVERFLOW' && e.failureKind === 'formatting_failure'));
    assert.ok(recoveryLogs.some(e => e.recoveryReason === 'knowledge_formatting_failure'));
    assert.ok(!recoveryLogs.some(e => e.recoveryReason === 'freshness_failure'));
    assert.ok(!decisions.some(e => e.stage === 'freshness' && ['SOURCE_INVALID','SOURCE_CHANGED'].includes(e.reason)));
  }
}

for (const selection of ['old','new','both'] as const) for (const channel of incidentChannels) for (const spec of cases)
  test(`SYNTHETIC model, captured ${selection} PDF inventory/${channel}/${spec[0]}`, t => exercise(t, channel, spec, 'none', selection));
for (const channel of incidentChannels) for (const fault of ['rejected','incomplete','foreign','revoked','number','scope','required','overflow','conflict','revision','badquote'] as const)
  test(`SYNTHETIC model, two-PDF ${channel} remains fail-closed: ${fault}`, t => exercise(t, channel, cases[0], fault));

for (const channel of incidentChannels) for (const spec of [cases[0], persianCase])
  test(`SYNTHETIC tombstone inventory / remaining PDF / ${channel} / ${spec[0]}`, t => exercise(t, channel, spec, 'none', 'new', true));

for (const channel of incidentChannels)
  test(`SYNTHETIC Persian preparation purpose / remaining PDF / ${channel}`, t => exercise(t, channel, persianPurposeCase, 'none', 'new'));
// The smaller PDF can use ID-only transport: corrupt the reference, not a
// quotation that this protocol never asks the model to supply.
for (const fault of ['rejected', 'incomplete', 'foreign', 'unknown-id'] as const)
  test(`SYNTHETIC Persian preparation purpose / remaining PDF / fail-closed ${fault}`, t => exercise(t, 'telegram', persianPurposeCase, fault, 'new'));
test('SYNTHETIC Persian preparation purpose / two PDFs', t => exercise(t, 'telegram', persianPurposeCase));

// Combined candidate: empty lexical search, six deleted rows, actual REST-backed
// canonical completion, purpose-clause parsing, then independent verification.
for (const channel of incidentChannels)
  test(`SYNTHETIC combined fixes / remaining PDF / ${channel}`, t => exercise(t, channel, persianPurposeCase, 'none', 'new', true));
for (const fault of ['rejected', 'incomplete', 'unknown-id'] as const)
  test(`SYNTHETIC combined fixes / remaining PDF / fail-closed ${fault}`, t => exercise(t, 'telegram', persianPurposeCase, fault, 'new', true));

for (const channel of incidentChannels) for (const [i, spec] of additionalPersianPurposes.entries())
  test(`SYNTHETIC additional Persian purpose ${i + 1} / remaining PDF / ${channel}`, t => exercise(t, channel, spec, 'none', 'new', true));
test('SYNTHETIC Persian ability purpose still requires verifier acceptance', t => exercise(t, 'telegram', additionalPersianPurposes[0], 'rejected', 'new', true));
test('SYNTHETIC comma-separated Persian purpose still requires verifier acceptance', t => exercise(t, 'telegram', additionalPersianPurposes[2], 'rejected', 'new', true));
