import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { AiReliabilityError } from './reliability';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
import { normalizeConversationText } from './booking-intelligence';
import { firstVisitCases, firstVisitSource } from '../../tests/fixtures/first-visit-planning-recovery';
import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, incidentChannels, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';

// SYNTHETIC language, extraction and independent-verifier outputs. These tests
// exercise real native adapters, recovery, citation/numerical/coverage checks,
// current in-memory sources and publication, never a real provider or database.
incidentFlags();
Object.assign(process.env, {
  OPENAI_API_KEY: 'synthetic-offline-only', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77', ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2',
  ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: 'false', ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS: 'source-partitioned-v1',
});
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
type Fault = 'none' | 'rejected' | 'incomplete' | 'foreign' | 'revoked' | 'number' | 'scope' | 'required';

async function exercise(t: any, channel: IncidentChannel, spec: typeof firstVisitCases[number], fault: Fault = 'none', realTimer = false) {
  b.reset();
  t.after(() => b.reset());
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  const [language, question, answer] = spec;
  const normalizedQuestion = normalizeConversationText(question);
  const storage = new InMemoryKnowledgeStorage(), service = new KnowledgeService(storage, storage, null);
  const doc = documentChunks([{ text: firstVisitSource, page: 1 }], 'arrival.txt');
  for (const tenant of [77, 88]) {
    const content = tenant === 77 ? doc.content : 'FOREIGN_SOURCE_SENTINEL: arrive 99 minutes early.';
    await storage.create({ id: `arrival-${tenant}`, businessId: tenant, type: 'document', title: 'arrival.txt', status: 'ready',
      content, metadata: doc.metadata, createdAt: '2026', updatedAt: '2026' });
    await storage.replaceChunks(tenant, `arrival-${tenant}`, [{ chunkIndex: 0, content, metadata: { source: 'document', page: 1 } }]);
  }
  const stages: string[] = [], decisions: any[] = [], inputs: any[] = [], replies: string[] = [], providerErrors: string[] = [];
  let plannerCalls = 0, actions = 0, aborted = false;
  const forbidden = async () => { actions++; assert.fail('No booking/calendar/database action is authorized'); };
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  b.configure({
    offlineAi: true, postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
    semanticLanguageResolver: async () => ({ language, confidence: 1 }),
    knowledgeSourceLanguages: async id => { assert.equal(id, 77); return fault === 'foreign' ? [] : ['sv']; },
    knowledgeSearch: async (id, q, limit) => {
      assert.equal(id, 77);
      return fault === 'foreign' ? [{ businessId: 88, sourceId: 'arrival-88', text: 'FOREIGN_SOURCE_SENTINEL: arrive 99 minutes early.',
        score: 1, metadata: { source: 'document' } }] : service.search(id, q, limit);
    },
    semanticKnowledgeSearchQueries: async () => [],
    completeKnowledgeCorpus: async (id, matches, options, mode) => fault === 'foreign' ? null : service.completeSmallCorpus(id, matches, options, mode),
    completeKnowledgeDocuments: async () => null,
    validateKnowledgeMatches: async (id, matches) => {
      assert.equal(id, 77);
      return service.validateMatches(id, matches, { strictSources: true, captureRevision: true, signal: nativeKnowledgeTiming()?.signal });
    },
    knowledgeServiceCatalog: async id => { assert.equal(id, 77); return incidentConfig.services; },
    evidenceFirstDecisionDiagnostic: event => decisions.push(event),
    aiGenerate: async request => {
      try {
        if (request.systemInstruction.includes('retrieval query planner')) {
          plannerCalls++;
          if (realTimer) return new Promise((_resolve, reject) => {
            assert.ok(request.signal);
            request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal!.reason); }, { once: true });
          });
          throw new AiReliabilityError('TIMEOUT', 'SYNTHETIC forced planner timeout');
        }
        const data = JSON.parse(request.messages[0].content);
        assert.equal(data.question, normalizedQuestion, 'Only the existing channel punctuation normalization may change the question');
        assert.deepEqual(request.tools, []);
        assert.equal(data.facets.length, 1);
        assert.equal(data.facets[0].obligations[0].description, normalizedQuestion);
        assert.ok(data.evidence.length > 0);
        assert.ok(data.evidence.every((e: any) => e.businessId === 77));
        assert.ok(!JSON.stringify(data).includes('FOREIGN_SOURCE_SENTINEL'));
        inputs.push(data);
        const evidence = data.evidence.find((e: any) => e.text.includes(firstVisitSource));
        assert.ok(evidence, 'Use the actual source wording, including cirka');
        if (request.systemInstruction.includes('UNIT EXTRACTION')) {
          stages.push('extraction');
          if (fault === 'revoked') await storage.delete(77, 'arrival-77');
          const text = fault === 'number' ? answer.replace(/10|۱۰/u, '20') : fault === 'scope'
            ? 'All visitors are recommended to arrive approximately 10 minutes before their booked appointment.' : fault === 'required'
            ? 'First-time visitors must arrive approximately 10 minutes before their booked appointment.' : answer;
          return { functionCalls: [], text: JSON.stringify({ oversized: false, units: [{ facetIds: ['f1'], subject: 'first-time visitors', predicate: 'arrival recommendation',
            value: 'approximately 10 minutes before booked appointment', modality: fault === 'required' ? 'required' : 'recommended', negation: false,
            scope: fault === 'scope' ? 'all visitors' : 'first-time visitors', qualifiers: ['approximately', 'before booked appointment'], language, text,
            evidenceRefs: [{ evidenceId: evidence.id, ...(request.systemInstruction.includes('literal-evidence-v1') ? {} : { exactQuote: firstVisitSource }) }] }] }) };
        }
        assert.ok(request.systemInstruction.includes('BATCH ENTAILMENT'), 'No unrestricted or optional answer generation');
        stages.push('verification');
        assert.equal(data.units.length, 1, 'The real numerical/citation parser must admit the source-grounded unit');
        for (const ref of data.units[0].evidenceRefs) assert.ok(evidence.text.includes(ref.exactQuote));
        const ids = data.units.map((u: any) => u.id), valid = !['rejected', 'scope', 'required'].includes(fault), complete = valid && fault !== 'incomplete';
        return { functionCalls: [], text: JSON.stringify({
          decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: valid ? 'ENTAILED' : 'UNKNOWN',
            meaningPreserved: valid, modalityPreserved: fault !== 'required', qualifiersPreserved: fault !== 'scope',
            relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
          coverage: [{ facetId: 'f1', requestAligned: true, materialFactsComplete: complete, incompletenessReason: complete ? 'NONE' : 'MISSING_RELEVANT_FACT',
            materialUnitIds: valid ? ids : [], obligations: [{ obligationId: 'f1.o1', status: complete ? 'COVERED' : 'UNRESOLVED', unitIds: valid ? ids : [] }] }],
          sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: complete,
            conditionsPreserved: valid, conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: valid ? ids : [],
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
  if (fault === 'none') {
    assert.deepEqual(stages, ['extraction', 'verification'], JSON.stringify(decisions.map(e => ({ stage: e.stage, reason: e.reason }))));
    assert.equal(publication?.route, 'verified_manifest');
    assert.equal(publication?.publishableUnits, 1);
    assert.equal(replies[0], answer);
    assert.ok(inputs[0].evidence.some((e: any) => e.text.includes('cirka 10 minuter före')));
  } else {
    assert.ok(!['verified_manifest', 'partial_manifest'].includes(publication?.route));
    assert.notEqual(replies[0], answer);
    assert.doesNotMatch(replies[0], /10|20|99|approximately|recommended|must arrive|All visitors/u);
    if (fault === 'foreign') assert.deepEqual(stages, []);
    else if (fault === 'number' || fault === 'revoked') assert.deepEqual(stages, ['extraction']);
    else assert.deepEqual(stages, ['extraction', 'verification']);
    if (fault === 'number') assert.ok(decisions.some(e => e.reason === 'NUMERICAL_CONSTRAINT'));
  }
  if (realTimer) {
    assert.equal(aborted, true);
    const timeout = decisions.find(e => e.stage === 'planning' && e.eventType === 'transport');
    assert.equal(timeout.timeoutMs, 2500);
    assert.equal(timeout.timeoutScope, 'stage');
    assert.ok(timeout.remainingMs > 6000);
  }
}

for (const channel of incidentChannels) for (const spec of firstVisitCases)
  test(`SYNTHETIC native recovery/${channel}/${spec[0]}: ${spec[1]}`, t => exercise(t, channel, spec));
test('SYNTHETIC WhatsApp exact incident recovers after the real 2500ms abort boundary', t => exercise(t, 'whatsapp', firstVisitCases[0], 'none', true));
for (const fault of ['rejected', 'incomplete', 'foreign', 'revoked', 'number', 'scope', 'required'] as const)
  test(`SYNTHETIC recovered WhatsApp request remains fail-closed: ${fault}`, t => exercise(t, 'whatsapp', firstVisitCases[0], fault));
