import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { answerEvidenceBindings } from './business-information-answer-plan';

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
const sources: KnowledgeSource[] = captured.map((s: any) => ({
  ...s, businessId: s.business_id, createdAt: s.created_at, updatedAt: s.updated_at,
}));
const inline = sources.find(s => s.type === 'text')!;
const pdf = sources.find(s => s.metadata.format === 'pdf')!;

async function fixture(rows = sources) {
  const storage = new InMemoryKnowledgeStorage();
  for (const source of rows) await storage.create(structuredClone(source));
  return { storage, service: new KnowledgeService(storage, storage, null) };
}

test('the recorded four-document-chunk corpus still works after adding the fifth, inline chunk', async () => {
  const { storage, service } = await fixture(sources.filter(s => s.type === 'document'));
  const documents = await service.completeSmallCorpus(3, [], undefined, 'native-documentary');
  assert.equal(documents?.length, 4);
  await storage.create(inline);
  const mixed = await service.completeSmallCorpus(3, [], undefined, 'native-documentary');
  assert.ok(mixed, 'baseline 6b3e2a8 declines when the text source is added');
  assert.equal(mixed.length, 5);
  assert.deepEqual(mixed.filter(row => row.sourceId !== inline.id), documents);
  assert.deepEqual(await service.validateMatches(3, mixed, { strictSources: true, requireCompleteDocumentContext: true }), mixed);
  const bindings = answerEvidenceBindings(3, mixed);
  assert.equal(bindings.length, 5);
  assert.equal(bindings.find(({ evidence }) => evidence.sourceId === inline.id)?.evidence.version, knowledgeSourceRevision(inline));
});

test('mixed inventory declines unsupported types, incomplete documents, foreign rows, and size overflow', async () => {
  const scenarios: [string, KnowledgeSource, string][] = [
    ['unsupported type', { ...inline, type: 'faq' }, 'unsupported_source_type'],
    ['missing document segment', { ...pdf, metadata: { ...pdf.metadata, segments: (pdf.metadata.segments as any[]).slice(1) } }, 'source_validation'],
    ['extra inline chunk', { ...inline, content: 'x'.repeat(1801) }, 'size_limit'],
    ['serialized overflow', { ...inline, title: 'Extra source', content: '"'.repeat(1800) }, 'size_limit'],
  ];
  // Inflate document provenance so the rendered envelope exceeds the cap
  // while the five canonical items and their raw text still fit.
  const escapedTitle = { ...pdf, title: '"'.repeat(800) };
  for (const [label, changed, reason] of scenarios) {
    const rows = sources.map(source => source.id === changed.id ? changed :
      label === 'serialized overflow' && source.id === pdf.id ? escapedTitle : source);
    const { service } = await fixture(rows);
    const reasons: string[] = [];
    assert.equal(await service.completeSmallCorpus(3, [], undefined, 'native-documentary', r => reasons.push(r)), null, label);
    assert.deepEqual(reasons, [reason], label);
  }
  const { storage, service } = await fixture();
  storage.listReadyComplete = async () => sources.map(s => s === inline ? { ...s, businessId: 4 } : s);
  assert.equal(await service.completeSmallCorpus(3, [], undefined, 'native-documentary'), null);
});

const turns = [
  ['ar', 'whatsapp', 'أنا أزور الاستوديو لأول مرة. هل يجب أن أصل قبل موعدي بعشر دقائق بالضبط، أم أن هذا مجرد توصية؟ وهل أحتاج إلى إحضار تأكيد الحجز؟', 'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق.'],
  ['fa', 'telegram', 'اگه برای اولین بار میام، چند دقیقه قبل از وقت رزرو باید اونجا باشم؟', 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت خود حاضر شوند.'],
  ['sv', 'telegram', 'Hur tidigt rekommenderar ni att jag kommer till studion vid mitt första besök?', 'Vid ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid.'],
  ['en', 'whatsapp', 'How early do you recommend arriving at the studio for a first visit?', 'For a first visit, we recommend arriving about 10 minutes before your appointment.'],
  ['de', 'whatsapp', 'Wie früh empfehlen Sie bei einem ersten Besuch im Studio anzukommen?', 'Beim ersten Besuch empfiehlt es sich, etwa 10 Minuten vor dem Termin anzukommen.'],
  ['es', 'telegram', '¿Con cuánta antelación recomiendan llegar al estudio para la primera visita?', 'Para la primera visita se recomienda llegar unos 10 minutos antes de la cita.'],
] as const;

type Fault = 'conflict' | 'stale_inline' | 'foreign_chunk' | 'missing_document_chunk' | 'verifier_protocol' | 'retry_no_hits';
async function replay(t: TestContext, [language, channel, question, answer]: typeof turns[number], fault?: Fault) {
  boundary.reset();
  t.after(() => boundary.reset());
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  const conflict = { ...inline, content: 'Förstagångsbesökare måste komma exakt 20 minuter före sin bokade tid.' };
  const { storage, service } = await fixture(fault === 'conflict' ? sources.map(s => s === inline ? conflict : s) : sources);
  const confirmation = language === 'ar' ? 'يُنصح بإحضار تأكيد الحجز، رقميًا أو على ورق.' : '';
  const noInventory = fault === 'verifier_protocol' || fault === 'retry_no_hits';
  if (fault === 'verifier_protocol') {
    process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'v2';
    t.after(() => { process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'source-exhaustive-v2'; });
  }
  const expected = await service.completeSmallCorpus(3, [], undefined, 'native-documentary');
  assert.equal(expected?.length, 5);
  const replies: string[] = [], stages: string[] = [], errors: unknown[] = [], retrieval: any[] = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }] }));
  });
  const forbidden = async () => { errors.push('unexpected action'); throw Error('offline'); };
  boundary.configure({
    offlineAi: true, structuredUnderstandingAdoptionRuntime: null,
    postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    semanticLanguageResolver: async () => ({ language, confidence: 1 }),
    knowledgeSearch: noInventory ? async () => [] : forbidden,
    semanticKnowledgeSearchQueries: noInventory ? async () => [] : forbidden,
    completeKnowledgeCorpus: (id, anchors, options, mode, decline) => {
      if (fault === 'retry_no_hits') { decline?.('size_limit'); return Promise.resolve(null); }
      return service.completeSmallCorpus(id, anchors, options, mode, decline);
    },
    knowledgeSourceLanguages: async () => fault === 'retry_no_hits' ? ['sv'] : [],
    validateKnowledgeMatches: async (id, matches) => {
      const current = await service.validateMatches(id, matches, { strictSources: true, requireCompleteDocumentContext: true });
      if (fault === 'foreign_chunk') return current.map((row, i) => i === 0 ? { ...row, businessId: 4 } : row);
      if (fault === 'missing_document_chunk') return current.filter((row, i) => !(i === current.findIndex(m => m.sourceId === pdf.id)));
      return current;
    },
    knowledgeRetrievalDiagnostic: event => retrieval.push(event),
    aiGenerate: async request => {
      try {
        const data = JSON.parse(request.messages[0].content);
        if (request.systemInstruction.includes('source-language search query')) {
          assert.equal(fault, 'retry_no_hits');
          assert.equal(data.targetLanguage, 'sv');
          return { text: JSON.stringify({ query: 'synthetic query with no hits' }) };
        }
        if (request.systemInstruction.includes('retrieval query planner')) {
          return { text: JSON.stringify({
            requestKind: 'BUSINESS_INFORMATION', canonicalMeaning: 'first visit arrival and preparation',
            referenceResolution: 'NOT_REQUIRED', queries: [question.slice(0, 120)],
            requestedFacets: [{ subject: 'first-time visitor', attribute: 'first visit preparation', questionType: 'description' }],
          }) };
        }
        assert.equal(data.evidence.length, 5);
        assert.deepEqual(data.evidence.map((item: any) => item.text), expected!.map(row => row.text));
        assert.ok(data.evidence.every((item: any) => item.businessId === 3));
        if (request.systemInstruction.includes('UNIT EXTRACTION')) {
          stages.push('extraction');
          const row = expected!.findIndex(item => item.sourceId === (fault === 'conflict' || fault === 'stale_inline' ? pdf.id : inline.id) && item.text?.includes('cirka 10 minuter'));
          const source = data.evidence[row];
          assert.ok(source);
          const quote = source.text.match(/Kunder som besöker[^.]+\./u)[0];
          const arrival = {
            facetIds: [data.facets[0].id], subject: 'first-time visitors', predicate: 'arrival timing',
            value: 'approximately 10 minutes before the booked appointment', modality: 'recommended',
            negation: false, scope: 'first visit', qualifiers: ['approximately'], language, text: answer,
            evidenceRefs: [{ evidenceId: source.id, exactQuote: quote }],
          };
          const document = data.evidence.find((item: any) => item.text.includes('Ta gärna med din bokningsbekräftelse, digitalt eller på papper.'));
          assert.ok(document);
          const units = confirmation ? [arrival, {
            ...arrival, predicate: 'bringing booking confirmation', value: 'digital or paper confirmation',
            qualifiers: [], text: confirmation, evidenceRefs: [{ evidenceId: document.id, exactQuote: 'Ta gärna med din bokningsbekräftelse, digitalt eller på papper.' }],
          }] : [arrival];
          return { text: JSON.stringify({ oversized: false, units }) };
        }
        assert.match(request.systemInstruction, /BATCH ENTAILMENT/u);
        stages.push('verification');
        assert.equal(request.structuredOutput?.name, 'odinlink_knowledge_source_exhaustive_v2');
        assert.ok(data.units.every((unit: any) => unit.modality === 'recommended'));
        if (fault === 'stale_inline') await storage.create({ ...inline, content: inline.content + '\nRevision changed.' });
        const ok = fault !== 'conflict';
        const ids = ok ? data.units.map((u: any) => u.id) : [];
        return { text: JSON.stringify({
          decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: ok ? 'ENTAILED' : 'CONTRADICTED',
            meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true,
            languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
          coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: ok,
            incompletenessReason: ok ? 'NONE' : 'UNRESOLVED', materialUnitIds: ids,
            obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: ok ? 'COVERED' : 'UNRESOLVED', unitIds: ids })) })),
          sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: ok,
            conditionsPreserved: true, conflictsAbsent: ok, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: ids,
            obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({
              facetId: f.id, obligationId: o.id, state: ok ? 'COMPLETE' : 'SOURCE_CONFLICT',
            }))) },
        }) };
      } catch (error) { errors.push(error); throw error; }
    },
    calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden,
      cancelAppointment: forbidden, updateAppointment: forbidden },
    recordAppointment: forbidden,
  });
  await incidentInbound(boundary, channel, question);
  assert.deepEqual(errors, []);
  assert.equal(retrieval.length, 1);
  assert.equal(replies.length, 1);
  if (fault === 'retry_no_hits') {
    assert.equal(retrieval[0].canonicalCompletion[0].reason, 'size_limit');
    assert.deepEqual(retrieval[0].sourceLanguageRetry, {
      targetLanguage: 'sv', outcome: 'searched', lexicalValidated: 0, lexicalScoped: 0, semanticReturned: 0, merged: 0,
    });
    assert.deepEqual(stages, []);
  } else if (fault === 'verifier_protocol') {
    assert.equal(retrieval[0].canonicalCompletion[0].reason, 'verification_protocol');
    assert.deepEqual(stages, []);
  } else {
    assert.equal(retrieval[0].completeCorpusUsed, true);
    assert.equal(retrieval[0].matchCount, 5);
    assert.deepEqual(stages, fault === 'missing_document_chunk' || fault === 'foreign_chunk' ? [] : ['extraction', 'verification']);
  }
  if (fault) assert.ok(!replies[0].includes(answer));
  else {
    assert.ok(replies[0].includes(answer));
    if (confirmation) assert.ok(replies[0].includes(confirmation));
    else assert.equal(replies[0], answer);
  }
}
for (const turn of turns) test(`mixed inventory reaches exhaustive Verification /${turn[0]}/${turn[1]}`, t => replay(t, turn));
for (const fault of ['conflict', 'stale_inline', 'foreign_chunk', 'missing_document_chunk', 'verifier_protocol', 'retry_no_hits'] as const) {
  test(`mixed inventory fails closed /${fault}`, t => replay(t, turns[0], fault));
}
