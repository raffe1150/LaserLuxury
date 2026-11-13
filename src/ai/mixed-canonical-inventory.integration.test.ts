import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { InMemoryKnowledgeStorage, KnowledgeService, knowledgeSourceRevision, type KnowledgeSource } from '../../knowledge';
import { incidentChannels, incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, type IncidentChannel } from '../../tests/helpers/p0-incident-knowledge';
import { answerEvidenceBindings } from './business-information-answer-plan';
import { formatBusinessSupportVerificationUnavailable } from './business-information';
import { configureKnowledgeBudgetOwner, executeKnowledgeGeneration } from './knowledge-model-policy';
import { AiReliabilityError } from './reliability';
import { assessNumericalConstraint } from './numerical-constraints';
import { routeOpenAiRequest } from './providers/openai';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';

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

// Exactness markers are deliberate. These proposals change the recommendation
// into a requirement and must be rejected with CLAIM_AMBIGUOUS.
const turns = [
  ['ar', 'أنا أزور الاستوديو لأول مرة. هل يجب أن أصل قبل موعدي بعشر دقائق بالضبط، أم أن هذا مجرد توصية؟ وهل أحتاج إلى إحضار تأكيد الحجز؟',
    'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق.',
    'يجب الوصول قبل موعدك المحجوز بـ 10 دقائق بالضبط.',
    'يُنصح بإحضار تأكيد الحجز، رقميًا أو على ورق.', 'التفاصيل المطلوبة'],
  ['fa', 'اگه برای اولین بار میام، چند دقیقه قبل از وقت رزرو باید اونجا باشم؟ آیا باید تأییدیه رزرو را همراه داشته باشم؟',
    'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت خود حاضر شوند.',
    'باید دقیقا ۱۰ دقیقه قبل از نوبت رزروشده حاضر شوید.',
    'توصیه می‌شود تأییدیه رزرو را به‌صورت دیجیتال یا کاغذی همراه داشته باشید.', 'جزئیات درخواست‌شده'],
  ['sv', 'Hur tidigt rekommenderar ni att jag kommer till studion vid mitt första besök? Behöver jag ta med min bokningsbekräftelse?',
    'Vid ditt första besök rekommenderas du att komma cirka 10 minuter före din bokade tid.',
    'Du måste komma exakt 10 minuter före din bokade tid.',
    'Ta gärna med din bokningsbekräftelse, digitalt eller på papper.', 'de efterfrågade uppgifterna'],
  ['en', 'How early do you recommend arriving at the studio for a first visit? Do I need to bring my booking confirmation?',
    'For a first visit, we recommend arriving about 10 minutes before your appointment.',
    'You must arrive exactly 10 minutes before your appointment.',
    'We recommend bringing your booking confirmation digitally or on paper.', 'the requested details'],
  ['de', 'Wie früh empfehlen Sie bei einem ersten Besuch im Studio anzukommen? Muss ich meine Buchungsbestätigung mitbringen?',
    'Beim ersten Besuch empfiehlt es sich, etwa 10 Minuten vor dem Termin anzukommen.',
    'Sie müssen genau 10 Minuten vor Ihrem Termin ankommen.',
    'Bringen Sie Ihre Buchungsbestätigung am besten digital oder auf Papier mit.', 'die angefragten Einzelheiten'],
  ['es', '¿Con cuánta antelación recomiendan llegar al estudio para la primera visita? ¿Necesito llevar el comprobante de mi reserva?',
    'Para la primera visita se recomienda llegar unos 10 minutos antes de la cita.',
    'Debe llegar exactamente 10 minutos antes de su cita.',
    'Se recomienda llevar la confirmación de la reserva en formato digital o en papel.', 'los detalles solicitados'],
] as const;

type Fault = 'conflict' | 'stale_inline' | 'foreign_chunk' | 'missing_document_chunk' | 'verifier_protocol' | 'retry_no_hits';
type Scenario = 'faithful' | 'exactness_mention' | 'ambiguous' | 'persian_false_rejection' | Fault;
const exactnessMention = {
  en: ', rather than arriving at an exactly specified time.',
  sv: ', utan ett exakt klockslag.',
  de: ', ohne dass die Ankunftszeit genau festgelegt ist.',
  es: ', sin fijar exactamente la hora de llegada.',
  fa: '، بدون اینکه زمان حضور دقیقا تعیین شود.',
  ar: '، دون تحديد وقت الوصول بالضبط.',
};
const recoveryFailures = [
  ['multiple_reasons', ['extraction']],
  ['missing_citation', ['extraction']],
  ['invalid_citation', ['extraction']],
  ['quantity_mismatch', ['extraction']],
  ['bound_mismatch', ['extraction']],
  ['anchor_mismatch', ['extraction']],
  ['cancellation', ['extraction']],
  ['stale_before_recovery', ['extraction']],
  ['foreign_before_recovery', ['extraction']],
  ['owner_denied', ['extraction']],
  ['short_budget', ['extraction']],
  ['provider_timeout', ['extraction', 're_extraction']],
  ['repeat_exactness', ['extraction', 're_extraction']],
  ['incomplete_replacement', ['extraction', 're_extraction', 'verification']],
  ['invalid_coverage', ['extraction', 're_extraction', 'verification']],
  ['conflicting_sources', ['extraction', 're_extraction', 'verification']],
  ['verification_rejected', ['extraction', 're_extraction', 'verification']],
] as const;
async function replay(t: TestContext, channel: IncidentChannel,
  [language, question, answer, ambiguous, confirmation, fallbackSubject]: typeof turns[number], scenario: Scenario,
  failure?: typeof recoveryFailures[number][0], failureStages?: readonly string[]) {
  const rejected = failure !== undefined;
  const exactness = scenario === 'ambiguous' || scenario === 'exactness_mention';
  const recovered = exactness || scenario === 'persian_false_rejection';
  const fault = scenario !== 'faithful' && !recovered ? scenario : undefined;
  let proposal = scenario === 'persian_false_rejection'
    ? 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با خیال راحت آماده شوند.'
    : scenario === 'exactness_mention' ? answer.replace(/\.$/u, '') + exactnessMention[language]
    : exactness ? ambiguous : answer;
  // The fault cases use the German row.
  if (failure === 'multiple_reasons') proposal = ambiguous.replace(/\.$/u, ' oder nie.');
  if (failure === 'quantity_mismatch') proposal = ambiguous.replace('10', '20');
  if (failure === 'bound_mismatch') proposal = ambiguous.replace('genau', 'genau mindestens');
  if (failure === 'anchor_mismatch') proposal = 'Sie müssen genau 10 Minuten vor der Öffnung da sein. Bringen Sie Ihre Buchungsbestätigung mit.';
  if (failure === 'cancellation') proposal = 'Sie müssen Ihren Termin genau 10 Minuten vorher stornieren.';
  let now = Date.now();
  if (failure === 'short_budget') t.mock.method(Date, 'now', () => now);
  boundary.reset();
  t.after(() => boundary.reset());
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => {});
  const conflict = { ...inline, content: 'Förstagångsbesökare måste komma exakt 20 minuter före sin bokade tid.' };
  const currentSources = fault === 'conflict' ? sources.map(s => s === inline ? conflict : s) :
    failure === 'conflicting_sources' ? sources.map(s => s === inline ? { ...s, content: s.content + '\n' + conflict.content } : s) : sources;
  const { storage, service } = await fixture(currentSources);
  const owner = new ScriptedKnowledgeBudgetOwner();
  if (!fault) {
    owner.businessIds = [3];
    const previousModel = process.env.ODINLINK_AI_DEFAULT_MODEL;
    process.env.ODINLINK_AI_DEFAULT_MODEL = 'gpt-6.1-sol';
    configureKnowledgeBudgetOwner(owner);
    t.after(() => {
      if (previousModel === undefined) delete process.env.ODINLINK_AI_DEFAULT_MODEL;
      else process.env.ODINLINK_AI_DEFAULT_MODEL = previousModel;
      configureKnowledgeBudgetOwner();
    });
  }
  const noInventory = fault === 'verifier_protocol' || fault === 'retry_no_hits';
  if (fault === 'verifier_protocol') {
    process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'v2';
    t.after(() => { process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'source-exhaustive-v2'; });
  }
  const expected = await service.completeSmallCorpus(3, [], undefined, 'native-documentary');
  assert.equal(expected?.length, 5);
  const bindings = answerEvidenceBindings(3, expected!).map(({ evidence }) => evidence);
  assert.equal(bindings.length, 5);
  for (const binding of bindings) {
    const source = currentSources.find(s => s.id === binding.sourceId);
    assert.ok(source);
    assert.equal(binding.businessId, source.businessId);
    assert.equal(binding.version, knowledgeSourceRevision(source));
  }
  const decisions: any[] = [], summaries: any[] = [];
  let foreignAfterExtraction = false;
  t.mock.method(console, 'info', (label, value) => {
    if (label === '[EvidenceFirstKnowledge]') summaries.push(JSON.parse(value));
  });
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
      if (fault === 'foreign_chunk' || foreignAfterExtraction) return current.map((row, i) => i === 0 ? { ...row, businessId: 4 } : row);
      if (fault === 'missing_document_chunk') return current.filter((row, i) => !(i === current.findIndex(m => m.sourceId === pdf.id)));
      return current;
    },
    evidenceFirstDecisionDiagnostic: event => decisions.push(event),
    knowledgeRetrievalDiagnostic: event => retrieval.push(event),
    aiGenerate: async request => {
      try {
        const respond = async () => {
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
          assert.deepEqual(data.evidence.map((item: any) => item.id), bindings.map(item => item.id));
          assert.equal(data.requestedLanguage, language);
          const extracting = request.systemInstruction.includes('UNIT EXTRACTION');
          const reExtracting = request.knowledgeExecution?.stage === 're_extraction';
          if (!fault) {
            assert.ok(!reExtracting || recovered);
            const route = routeOpenAiRequest(request.model, request);
            assert.equal(route.model, 'gpt-6.1-sol');
            assert.equal(route.stage, reExtracting ? 'knowledge_re_extraction' : extracting ? 'knowledge_extraction' : 'knowledge_verification');
            assert.ok(request.knowledgeExecution);
          }
          if (extracting) {
            stages.push(reExtracting ? 're_extraction' : 'extraction');
            if (reExtracting && failure === 'provider_timeout') throw new AiReliabilityError('TIMEOUT', 'Synthetic recovery timeout');
            const row = expected!.findIndex(item => item.sourceId === (fault === 'conflict' || fault === 'stale_inline' ? pdf.id : inline.id) && item.text?.includes('cirka 10 minuter'));
            const source = data.evidence[row];
            assert.ok(source);
            const quote = source.text.match(/Kunder som besöker[^.]+\./u)[0];
            const arrival = {
              facetIds: [data.facets[0].id], subject: 'first-time visitors', predicate: 'arrival timing',
              value: 'approximately 10 minutes before the booked appointment', modality: 'recommended',
              negation: false, scope: 'first visit', qualifiers: ['approximately'], language, text: reExtracting && failure !== 'repeat_exactness' ? answer : proposal,
              evidenceRefs: [{ evidenceId: source.id, exactQuote: quote }],
            };
            const document = data.evidence.find((item: any) => item.text.includes('Ta gärna med din bokningsbekräftelse, digitalt eller på papper.'));
            assert.ok(document);
            if (exactness && !failure) {
              assert.equal(assessNumericalConstraint(proposal, proposal, [quote]).reason, 'CLAIM_AMBIGUOUS');
            }
            const units = [arrival, {
              ...arrival, predicate: 'bringing booking confirmation', value: 'digital or paper confirmation',
              qualifiers: [], text: confirmation, evidenceRefs: [{ evidenceId: document.id, exactQuote: 'Ta gärna med din bokningsbekräftelse, digitalt eller på papper.' }],
            }];
            if (!reExtracting) {
              if (failure === 'foreign_before_recovery') foreignAfterExtraction = true;
              if (failure === 'owner_denied') owner.mode = 'deny';
              if (failure === 'stale_before_recovery') await storage.create({ ...inline, content: inline.content + '\nRevision changed.' });
              if (failure === 'missing_citation') units[0].evidenceRefs = [];
              if (failure === 'invalid_citation') units[0].evidenceRefs[0].exactQuote = 'Not present in the source.';
            }
            if (reExtracting && failure === 'incomplete_replacement') units.pop();
            return { text: JSON.stringify({ oversized: false, units }) };
          }
          assert.match(request.systemInstruction, /BATCH ENTAILMENT/u);
          stages.push('verification');
          assert.equal(request.structuredOutput?.name, 'odinlink_knowledge_source_exhaustive_v2');
          assert.ok(data.units.every((unit: any) => unit.modality === 'recommended'));
          assert.deepEqual(data.units.map((unit: any) => unit.text), failure === 'incomplete_replacement' ? [answer] : [answer, confirmation]);
          assert.ok(data.units.every((unit: any) => unit.language === language));
          assert.equal(data.units[0].value, 'approximately 10 minutes before the booked appointment');
          assert.deepEqual(data.units[0].qualifiers, ['approximately']);
          if (fault === 'stale_inline') await storage.create({ ...inline, content: inline.content + '\nRevision changed.' });
          const conflictFree = fault !== 'conflict' && failure !== 'conflicting_sources';
          const ok = conflictFree && failure !== 'verification_rejected' && failure !== 'incomplete_replacement';
          const ids = ok ? data.units.map((u: any) => u.id) : [];
          return { text: JSON.stringify({
            decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: ok ? 'ENTAILED' : 'CONTRADICTED',
              meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, relevant: true,
              languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
            coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: ok,
              incompletenessReason: ok ? 'NONE' : 'UNRESOLVED', materialUnitIds: ids,
              obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: ok ? 'COVERED' : 'UNRESOLVED', unitIds: ids })) })),
            sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: ok,
              conditionsPreserved: true, conflictsAbsent: conflictFree, evidenceIdsReviewed: failure === 'invalid_coverage' ? [] : data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: ids,
              obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({
                facetId: f.id, obligationId: o.id, state: ok ? 'COMPLETE' : 'SOURCE_CONFLICT',
              }))) },
          }) };
        };
        if (!request.knowledgeExecution) return respond();
        const { response, usage } = await executeKnowledgeGeneration(request, {
          model: 'gpt-6.1-sol',
          reasoning: { effort: 'low' },
          instructions: request.systemInstruction,
          input: [{ role: 'user', content: request.messages[0].content }],
          text: { format: { type: 'json_schema', ...request.structuredOutput } },
        }, async () => ({
          ...await respond(),
          model: 'gpt-6.1-sol', service_tier: 'default', reasoning: { effort: 'low' },
          prompt_cache_options: { mode: 'implicit', ttl: '30m' },
          usage: { input_tokens: 200, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        }));
        if (failure === 'short_budget') now += 18_000;
        return { text: response.text, knowledgeUsage: usage };
      } catch (error) {
        const expectedDenial = failure === 'owner_denied' && /reservation_denied/u.test(String(error));
        const expectedTimeout = failure === 'provider_timeout' && error instanceof AiReliabilityError;
        if (!expectedDenial && !expectedTimeout) errors.push(error);
        throw error;
      }
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
    assert.deepEqual(stages, fault === 'missing_document_chunk' || fault === 'foreign_chunk' ? [] :
      rejected ? failureStages : recovered ? ['extraction', 're_extraction', 'verification'] : ['extraction', 'verification']);
  }
  if (!fault) {
    const publication = decisions.filter(event => event.eventType === 'publication');
    assert.ok(publication.length > 0);
    for (const event of publication) {
      assert.deepEqual([event.businessId, event.nativeChannel, event.route],
        [3, channel, rejected ? 'unavailable' : 'verified_manifest']);
    }
    const quotes = [...owner.reservations.values()].map(reservation => reservation.quote);
    assert.deepEqual(quotes.map(quote => quote.stage), stages);
    assert.ok(quotes.every(quote => quote.businessId === 3));
    const ownerEvents = stages.flatMap(stage => ['reserve',
      failure === 'provider_timeout' && stage === 're_extraction' ? 'retainUnknown' : 'settle']);
    if (failure === 'owner_denied') ownerEvents.push('reserve');
    assert.deepEqual(owner.events, ownerEvents);
    if (exactness && !failure) {
      assert.deepEqual(summaries.map(summary => summary.reExtraction), [{ trigger: 'numerical_exactness', outcome: 'dispatched' }]);
    }
    if (failure === 'repeat_exactness') {
      assert.deepEqual(decisions.filter(event => event.numericalMismatchReason === 'CLAIM_AMBIGUOUS')
        .map(event => event.ambiguityReasons), [['exactness'], ['exactness']]);
      assert.ok(decisions.some(event => event.stage === 'verification' && event.reason === 'INVALID_COVERAGE'));
    }
    if (failure === 'short_budget') {
      assert.deepEqual(summaries.map(summary => summary.reExtraction),
        [{ trigger: 'numerical_exactness', outcome: 'skipped', skipReason: 'deadline' }]);
    }
    assert.ok(quotes.every(quote => quote.turnId === quotes[0].turnId && quote.requestKey === quotes[0].requestKey));
  }
  if (recovered && !failure) {
    const numerical = decisions.filter(event => event.reason === 'NUMERICAL_CONSTRAINT');
    assert.deepEqual(numerical.map(event => [event.unitId, event.numericalMismatchReason]),
      [['u1', exactness ? 'CLAIM_AMBIGUOUS' : 'SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH']]);
    const inlineBinding = bindings.find(item => item.sourceId === inline.id)!;
    assert.deepEqual(numerical[0].evidenceBindings, [{
      evidenceId: inlineBinding.id, sourceId: inline.id, sourceRevision: knowledgeSourceRevision(inline),
    }]);
    if (exactness) assert.deepEqual(numerical[0].ambiguityReasons, ['exactness']);
  }
  if (rejected) {
    assert.equal(replies[0], formatBusinessSupportVerificationUnavailable(language, fallbackSubject));
  } else if (fault) {
    assert.ok(!replies[0].includes(answer));
  } else {
    assert.equal(replies[0], [answer, confirmation].join(' '));
  }
}

for (const turn of turns) {
  for (const channel of incidentChannels) {
    for (const scenario of ['faithful', 'exactness_mention', 'ambiguous'] as const) {
      test(`mixed inventory /${turn[0]}/${channel}/${scenario}`, t => replay(t, channel, turn, scenario));
    }
  }
}
test('mixed inventory reproduces the known faithful Persian purpose-clause rejection', t =>
  replay(t, 'telegram', turns[1], 'persian_false_rejection'));
for (const fault of ['conflict', 'stale_inline', 'foreign_chunk', 'missing_document_chunk', 'verifier_protocol', 'retry_no_hits'] as const) {
  test(`mixed inventory fails closed /${fault}`, t => replay(t, 'whatsapp', turns[0], fault));
}

for (const [failure, stages] of recoveryFailures) {
  test(`exactness recovery fails closed /${failure}`, t => replay(t, 'telegram', turns[4], 'ambiguous', failure, stages));
}
