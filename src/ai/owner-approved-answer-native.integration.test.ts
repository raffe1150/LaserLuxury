/** Synthetic evidence, simulated approval storage and scripted verification. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { incidentChannels, incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalDocument, canonicalHash } from '../knowledge/documents/canonical';

incidentFlags();
Object.assign(process.env, {
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: 'source-exhaustive-v2',
});
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const question = 'برای اولین مراجعه حضوری چند دقیقه قبل از نوبت بهتر است برسم؟';
// Original live WhatsApp question (exact text). The source below is synthetic.
const incidentQuestion = 'من اولین باره می‌خوام بیام استودیو. بهتره چقدر زودتر از نوبتم اونجا باشم؟';
const recommendation = 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sitt bokade besök för att hinna förbereda sig i lugn och ro.';
const condition = 'Rekommendationen gäller endast besök på plats.';
const qualifier = 'فقط برای مراجعه حضوری';
const source: KnowledgeSource = {
  id: 'synthetic-owner-policy', businessId: 77, type: 'document', status: 'ready',
  title: 'Synthetic owner policy', content: [recommendation, condition].join('\n\n'),
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
  metadata: { segments: [{ start: 0, end: recommendation.length, page: 1 },
    { start: recommendation.length + 2, end: recommendation.length + 2 + condition.length, page: 2 }] },
};
const record = {
  businessId: 77, sourceId: source.id, revision: knowledgeSourceRevision(source), language: 'fa',
  answer: {
    subject: 'first-time visitors', predicate: 'arrival timing', value: 'approximately ten minutes before the appointment',
    scope: 'first in-person appointment', modality: 'recommended', negation: false, qualifiers: [qualifier],
    text: 'فقط برای مراجعه حضوری، به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده حاضر شوند، برای اینکه با آرامش آماده شوند.',
  },
  spans: [recommendation, condition].map(quote => {
    const start = source.content.indexOf(quote);
    return { start, end: start + quote.length, digest: canonicalHash(quote) };
  }),
  conditions: [{ spanIndex: 1, answerPhrase: qualifier }],
  approval: { ownerId: 'simulated-owner', actionId: 'simulated-review', approvedAt: '2026-01-02T00:00:00Z' },
};
const conflictText = 'Förstagångsbesökare rekommenderas att komma cirka 25 minuter före sitt bokade besök.';
const conflictSource: KnowledgeSource = { ...source, id: 'synthetic-conflict', content: conflictText,
  metadata: { segments: [{ start: 0, end: conflictText.length, page: 1 }] } };
// Unrelated, non-conflicting second source: the owner review no longer covers
// the whole admitted inventory, so the appended-proposal path must apply.
const otherText = 'Parkering finns på gatan utanför studion.';
const otherSource: KnowledgeSource = { ...source, id: 'synthetic-other', content: otherText,
  metadata: { segments: [{ start: 0, end: otherText.length, page: 1 }] } };
type Mode = 'approved' | 'revoked' | 'stale-approval' | 'changed-revision' | 'missing-condition' |
  'unsupported-maximum' | 'foreign-tenant' | 'conflict' | 'malformed-verifier' | 'parse-loss' | 'missing-citation' |
  'different-question' | 'flag-off' | 'late-revocation' | 'late-revision' | 'late-flag-off' |
  'incident-sibling' | 'incident-multisource';
const ownerFirstModes: readonly Mode[] = ['approved', 'incident-sibling', 'changed-revision', 'missing-condition',
  'malformed-verifier', 'late-revocation', 'late-revision', 'late-flag-off'];
const appendedVerifierModes: readonly Mode[] = ['conflict', 'parse-loss', 'incident-multisource'];
const published = (mode: Mode) => mode === 'approved' || mode === 'incident-sibling';

async function exercise(t: TestContext, channel: IncidentChannel, mode: Mode, inboundQuestion = question, extraction = 'v2') {
  boundary.reset();
  const previousServices = incidentConfig.services;
  incidentConfig.services = [];
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  const storage = new InMemoryKnowledgeStorage();
  const service = new KnowledgeService(storage);
  const sources = mode === 'conflict' ? [source, conflictSource] :
    mode === 'parse-loss' || mode === 'incident-multisource' ? [source, otherSource] : [source];
  for (const item of sources) await storage.create(item);
  const matches = sources.flatMap(item => canonicalDocument(item).chunks.map(chunk => ({ ...chunk.match, score: 1 })));
  process.env.ODINLINK_OWNER_ANSWER_APPROVALS = mode === 'flag-off' ? 'false' : 'true';
  process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL = extraction;
  const { text: answerText, qualifiers: _qualifiers, ...proposition } = record.answer;
  const reviewed = {
    question: mode === 'different-question' ? inboundQuestion.replace('اولین', 'دومین') : inboundQuestion,
    answerText: mode === 'unsupported-maximum' ? answerText.replace('حدود', 'حداکثر') :
      mode === 'missing-condition' ? answerText.replace(qualifier + '، ', '') : answerText,
    proposition,
    confirmCompleteReview: true,
    spans: mode === 'missing-condition' || mode === 'missing-citation' ? record.spans.slice(0, 1) : record.spans,
    qualifications: mode === 'missing-condition' ? [] : record.conditions,
  };
  let revoked = mode === 'revoked';
  let sourceChanged = false;
  const approval = {
    id: record.approval.actionId, business_id: 77, source_id: source.id,
    source_revision: mode === 'stale-approval' ? 'previous' : record.revision, language: record.language,
    approved_by: record.approval.ownerId, approved_at: record.approval.approvedAt, reviewed_answer: reviewed,
  };
  let lookups = 0;
  let finalLookups = 0;
  const db = {
    from(table: string) {
      assert.equal(table, 'knowledge_answer_approvals');
      const filters = new Map<string, unknown>();
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.set(key, value); return query; },
        is: (key: string, value: unknown) => { filters.set(key, value); return query; },
        abortSignal: () => query,
        maybeSingle: async () => {
          lookups++;
          if (filters.has('id')) {
            finalLookups++;
            assert.equal(filters.get('id'), approval.id);
          }
          const row = { ...approval, revoked_at: revoked ? 'revoked' : null };
          if (![...filters].every(([key, value]) => row[key] === value)) return { data: null };
          return { data: { ...row, source: {
            id: source.id, business_id: mode === 'foreign-tenant' ? 88 : source.businessId,
            title: sourceChanged ? 'Revised policy' : source.title, type: source.type, status: source.status,
            content: source.content, metadata: source.metadata, created_at: source.createdAt, updated_at: source.updatedAt,
          } } };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const replies: string[] = [];
  const stages: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let unexpected = 0;
  const deny = async () => { unexpected++; throw new Error('unexpected external action'); };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    replies.push(interceptedIncidentSend(url, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }], message_id: 'offline' }));
  });
  boundary.configure({
    offlineAi: true, postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    semanticLanguageResolver: async () => ({ language: 'fa', confidence: 1 }),
    knowledgeSearch: async () => matches, knowledgeSourceLanguages: async () => [],
    completeKnowledgeCorpus: async () => matches, semanticKnowledgeSearchQueries: async () => [],
    validateKnowledgeMatches: (id, found) => service.validateMatches(id, found, {
      strictSources: true, captureRevision: true, requireCompleteDocumentContext: true,
    }),
    ownerAnswerApprovalDatabase: db,
    knowledgeServiceCatalog: async () => [],
    evidenceFirstPublicationDiagnostic: event => {
      if (event.phase !== 'publication_result' || !event.units) return;
      if (mode === 'late-revocation') revoked = true;
      if (mode === 'late-revision') sourceChanged = true;
      if (mode === 'late-flag-off') process.env.ODINLINK_OWNER_ANSWER_APPROVALS = 'false';
    },
    evidenceFirstDecisionDiagnostic: event => events.push(event),
    aiGenerate: async request => {
      const data = JSON.parse(request.messages[0].content);
      const scripted = (payload: unknown) => ({ functionCalls: [], text: JSON.stringify(payload) });
      if (request.systemInstruction.includes('retrieval query planner')) {
        return scripted({ requestKind: 'BUSINESS_INFORMATION', canonicalMeaning: inboundQuestion, queries: [inboundQuestion],
          queryLanguages: [], referenceResolution: 'NOT_REQUIRED',
          requestedFacets: [{ subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' }] });
      }
      if (request.systemInstruction.includes('UNIT EXTRACTION')) {
        stages.push('extraction');
        const modelUnit = {
          // Incident modes: the live failure shape, a purpose clause written with
          // Persian «تا» that the numerical parser reads as a maximum.
          ...proposition, text: mode.startsWith('incident') ? answerText.replace('برای اینکه', 'تا') :
            answerText.replace('حدود', 'حداکثر'), language: 'fa',
          qualifiers: [qualifier], facetIds: [data.facets[0].id],
          evidenceRefs: data.evidence.map((item: { id: string; text: string }) => request.structuredOutput?.name.includes('literal')
            ? { evidenceId: item.id } : { evidenceId: item.id, exactQuote: item.text }),
        };
        return scripted({ oversized: false, units: mode === 'parse-loss' || mode.startsWith('incident') ? [modelUnit] : [] });
      }
      assert.ok(request.systemInstruction.includes('BATCH ENTAILMENT'));
      stages.push('verification');
      assert.equal(request.structuredOutput?.name, 'odinlink_knowledge_source_exhaustive_v2');
      assert.equal(data.units.length, 1);
      assert.equal(data.units[0].text, reviewed.answerText);
      if (mode === 'changed-revision') await storage.create({ ...source, title: 'Revised policy' });
      assert.deepEqual(data.units[0].evidenceRefs.map((ref: { exactQuote: string }) => ref.exactQuote), mode === 'missing-condition' ? [recommendation] : [recommendation, condition]);
      if (mode === 'malformed-verifier') return { functionCalls: [], text: '{' };
      if (mode === 'conflict') assert.ok(data.evidence.some((item: { text: string }) => item.text === conflictText));
      const [unit] = data.units;
      const missingCondition = mode === 'missing-condition';
      if (missingCondition) assert.ok(data.evidence.some((item: { text: string }) => item.text === condition));
      const complete = mode !== 'conflict' && !missingCondition;
      return scripted({
        decisions: [{ unitId: unit.id, facetIds: unit.facetIds, relation: mode === 'conflict' ? 'CONTRADICTED' : 'ENTAILED',
          meaningPreserved: complete || missingCondition, modalityPreserved: true, qualifiersPreserved: true, relevant: true,
          languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false }],
        coverage: data.facets.map((facet: any) => ({ facetId: facet.id, requestAligned: true, materialFactsComplete: complete,
          incompletenessReason: complete ? 'NONE' : missingCondition ? 'MISSING_CONDITION' : 'UNRESOLVED', materialUnitIds: complete ? [unit.id] : [],
          obligations: facet.obligations.map((obligation: any) => ({ obligationId: obligation.id,
            status: complete ? 'COVERED' : 'UNRESOLVED', unitIds: complete ? [unit.id] : [] })) })),
        sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: complete,
          conditionsPreserved: !missingCondition, conflictsAbsent: mode !== 'conflict', evidenceIdsReviewed: data.evidence.map((item: any) => item.id),
          acceptedUnitIdsReviewed: complete || missingCondition ? [unit.id] : [],
          obligations: data.facets.flatMap((facet: any) => facet.obligations.map((obligation: any) =>
            ({ facetId: facet.id, obligationId: obligation.id, state: complete ? 'COMPLETE' : 'UNRESOLVED' }))) },
      });
    },
    calendarAdapter: { getCalendarId: () => 'offline', getEvents: deny, checkSlots: deny,
      insertAppointment: deny, cancelAppointment: deny }, recordAppointment: deny, cancelAppointmentRow: deny,
  });
  try {
    await incidentInbound(boundary, channel, inboundQuestion);
    assert.equal(unexpected, 0);
    const late = mode.startsWith('late-');
    assert.equal(replies.length, late ? 0 : 1);
    // Owner-first: no model extraction call. Owner text rejected by the existing
    // numerical gate: nothing reaches verification. Otherwise the baseline path.
    const expectedStages = ownerFirstModes.includes(mode) ? ['verification'] : mode === 'unsupported-maximum' ? [] :
      appendedVerifierModes.includes(mode) ? ['extraction', 'verification'] : ['extraction'];
    assert.deepEqual(stages, expectedStages, JSON.stringify({ lookups, reasons: events.map(event => event.reason) }));
    assert.equal(replies[0] === answerText, published(mode), JSON.stringify({ mode, channel, replies, events }));
    if (!published(mode)) assert.notEqual(replies[0], answerText.replace('برای اینکه', 'تا'));
    assert.equal(lookups > 0, mode !== 'flag-off');
    assert.equal(finalLookups, published(mode) || mode === 'late-revision' || mode === 'late-revocation' ? 1 : 0);
    if (mode === 'missing-condition') assert.ok(events.some(event => event.reason === 'INVALID_COVERAGE'));
    if (mode === 'unsupported-maximum') assert.ok(events.some(event => event.reason === 'NUMERICAL_CONSTRAINT'));
    if (mode === 'incident-sibling') assert.ok(!events.some(event => event.reason === 'NUMERICAL_CONSTRAINT' || event.reason === 'INVALID_COVERAGE'));
    if (mode === 'parse-loss' || mode === 'incident-multisource') {
      assert.ok(events.some(event => event.stage === 'extraction' && event.reason === 'NUMERICAL_CONSTRAINT'));
      assert.ok(events.some(event => event.stage === 'verification' && event.reason === 'INVALID_COVERAGE'));
    }
  } finally {
    delete process.env.ODINLINK_OWNER_ANSWER_APPROVALS;
    delete process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL;
    incidentConfig.services = previousServices;
    boundary.reset();
  }
}

for (const channel of incidentChannels) {
  test('owner approval earns complete coverage through ' + channel, t => exercise(t, channel, 'approved'));
}
test('owner approval for the original Persian first-visit replay', t =>
  exercise(t, 'whatsapp', 'approved', 'برای اولین مراجعه چند دقیقه قبل از نوبت برسم؟', 'literal-evidence-v1'));
for (const channel of incidentChannels) {
  for (const extraction of ['v2', 'literal-evidence-v1']) {
    test(`exact Persian incident publishes the owner inventory without a model sibling through ${channel} (${extraction})`, t =>
      exercise(t, channel, 'incident-sibling', incidentQuestion, extraction));
  }
  test('exact Persian incident with a mixed-source inventory keeps the rejected-sibling veto through ' + channel, t =>
    exercise(t, channel, 'incident-multisource', incidentQuestion));
  test('feature OFF baseline for the exact Persian incident through ' + channel, t =>
    exercise(t, channel, 'flag-off', incidentQuestion));
}
for (const mode of ['revoked', 'stale-approval', 'changed-revision', 'missing-condition', 'unsupported-maximum',
  'foreign-tenant', 'conflict', 'malformed-verifier', 'parse-loss', 'missing-citation',
  'different-question', 'flag-off', 'late-revocation', 'late-revision', 'late-flag-off'] as const) {
  test('owner approval fails closed for ' + mode, t => exercise(t, 'whatsapp', mode));
}
