/** Offline controls. Genuine judgments remain verbatim; every new sourceCoverage
 * certificate below is SCRIPTED and must be obtained genuinely before release. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { completeKnowledgeManifest, publishableKnowledgeManifest, pruneAnswerManifest, buildEvidenceFirstAnswer,
  InformationBudget, parseRequestedFacets, answerEvidence } from './business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
import { SOURCE_EXHAUSTIVE_PROTOCOL, SOURCE_EXHAUSTIVE_V2_PROTOCOL } from './source-exhaustive-coverage';
import { knowledgeStructuredOutput, selectKnowledgeVerificationProtocol } from './knowledge-answer-protocol';
import { incidentConfig, incidentFlags, incidentInbound, interceptedIncidentSend, incidentChannels } from '../../tests/helpers/p0-incident-knowledge';

const capture = JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', import.meta.url), 'utf8'));
incidentFlags();
Object.assign(process.env, { ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: SOURCE_EXHAUSTIVE_PROTOCOL, ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const limitation = 'The complete cancellation policy and required advance notice cannot be confirmed from the available information.';
const receipts: any[] = [];
after(() => { if (process.env.ODINLINK_SOURCE_EXHAUSTIVE_RECEIPT) writeFileSync(process.env.ODINLINK_SOURCE_EXHAUSTIVE_RECEIPT,
  JSON.stringify({ mode: 'OFFLINE_CAPTURE_REPLAY_WITH_SCRIPTED_NEW_CERTIFICATES_NOT_GENUINE_ACCEPTANCE', providerRequests: 0, receipts }, null, 2), { flag: 'wx', mode: 0o600 }); });

function certificate(data: any, protocol: string = SOURCE_EXHAUSTIVE_PROTOCOL) {
  return { protocol, requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true,
    conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: data.units.map((u: any) => u.id),
    obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id,
      state: o.questionType === 'requirement' ? 'UNRESOLVED_REQUIREMENT' : 'REQUESTED_INFORMATION_NOT_VERIFIED' }))) };
}
const quiet = (t: any) => { for (const n of ['log', 'info', 'warn', 'error']) t.mock.method(console, n, () => {}); };
async function replay(t: any, fault = 'none', inspect?: (manifest: any, evidence: any[]) => void) {
  quiet(t); b.reset(); const saved = structuredClone(incidentConfig), row = structuredClone(capture.frozen.rawCancellationSettings);
  const normalized = b.promptAuditNormalize(row), events: any[] = [], stages: string[] = [];
  const originalVerdict = JSON.parse(capture.verification.outputText); let actualVerdict: any, actions = 0;
  const matches = structuredClone(capture.frozen.matches);
  const additional: Record<string, string> = {
    'omitted-fact': 'Cancellation requests require an appointment reference.',
    condition: 'Automatic cancellation through chat is enabled only when an appointment reference is supplied.',
    conflict: 'Automatic appointment cancellation through chat is disabled.',
  };
  if (additional[fault]) matches.push({ businessId: 77, sourceId: `material-policy-${fault}`, text: additional[fault], score: 1,
    metadata: { source: 'document', documentRevision: 'negative-control-r1' } });
  const forbidden = async () => { actions++; throw Error('OFFLINE_ACTION_FORBIDDEN'); };
  try {
    Object.assign(incidentConfig, row, { id: 77, businessId: 77, businessRecordId: 77, business_id: 77, language: 'en',
      cancellationSettingsEvidence: normalized.cancellationSettingsEvidence, allowCancellation: true, cancellationDeadlineMinutes: 1440,
      cancellationFeeEnabled: false, cancellationFeeAmount: 0, cancellationFeeCurrency: 'SEK' });
    b.configure({ offlineAi: true, postProcess: async () => {},
      knowledgeCancellationConfig: async () => structuredClone(row), validateKnowledgeMatches: async (_id, matches) => matches,
      knowledgeServiceCatalog: async () => incidentConfig.services, evidenceFirstDecisionDiagnostic: e => events.push(e),
      aiGenerate: async r => {
        const stage = r.systemInstruction.includes('UNIT EXTRACTION') ? 'extraction' : r.systemInstruction.includes('BATCH ENTAILMENT') ? 'verification' : 'UNEXPECTED';
        stages.push(stage); assert.notEqual(stage, 'UNEXPECTED', 'Scoped answers require no composer or retry');
        const data = JSON.parse(r.messages[0].content);
        if (stage === 'extraction') {
          const raw = JSON.parse(capture.extraction.outputText);
          if (fault === 'citation') raw.units[0].evidenceRefs[0].evidenceId = 'foreign';
          if (fault === 'deadline') raw.units[0].text = 'You must cancel at least 24 hours before the appointment.';
          if (fault === 'fee') raw.units[0].text = 'The cancellation fee is 999 SEK.';
          if (fault === 'free') raw.units[0].text = 'All cancellations are always free.';
          if (fault === 'full-policy-known') raw.units[0].text = 'The full cancellation policy is confirmed: all cancellations are free.';
          return { text: JSON.stringify(raw), functionCalls: [] };
        }
        assert.equal(r.structuredOutput.name, 'odinlink_knowledge_source_exhaustive_v1');
        assert.deepEqual((r.structuredOutput.schema as any).properties.coverage, capture.verification.structuredOutput.schema.properties.coverage);
        assert.match(r.systemInstruction, /explicit independent certification/);
        const raw = { ...structuredClone(originalVerdict), sourceCoverage: certificate(data) };
        if (fault === 'no-certificate') delete raw.sourceCoverage;
        if (fault === 'omitted-fact') { raw.sourceCoverage.availableMaterialFactsComplete = false; raw.sourceCoverage.obligations[0].state = 'AVAILABLE_SOURCE_FACT_OMITTED'; }
        if (fault === 'condition') { raw.sourceCoverage.conditionsPreserved = false; raw.coverage[0].incompletenessReason = 'MISSING_CONDITION'; raw.decisions[0].qualifiersPreserved = false; }
        if (fault === 'conflict') { raw.decisions[0].relation = 'CONTRADICTED'; raw.sourceCoverage.conflictsAbsent = false; }
        if (fault === 'free' || fault === 'full-policy-known') raw.decisions[0].relation = 'UNKNOWN';
        if (fault === 'missing-coverage') raw.coverage.pop();
        if (fault === 'inconsistent') raw.coverage[0].materialFactsComplete = true;
        actualVerdict = structuredClone(raw);
        return { text: JSON.stringify(raw), functionCalls: [] };
      }, calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden,
        cancelAppointment: forbidden, updateAppointment: forbidden }, recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
    let result: any;
    await b.nativeKnowledgeEvidenceRequest({ sessionId: `source-exhaustive-${fault}`, channel: 'telegram', businessConfig: incidentConfig,
      question: capture.frozen.question, language: 'en', facets: capture.verification.input.facets, matches }, async api => {
      const generated = await api.generate(), m = api.manifest()!;
      const allowed = publishableKnowledgeManifest(m, 77);
      if (fault === 'none') inspect?.(m, (api.snapshot() as any).evidence);
      result = { allowed, manifest: m, final: await api.publish(generated.text), events, stages };
    });
    assert.equal(actions, 0);
    if (fault === 'none') assert.deepEqual({ decisions: actualVerdict.decisions, coverage: actualVerdict.coverage }, originalVerdict);
    return result;
  } finally { for (const k of Object.keys(incidentConfig)) delete (incidentConfig as any)[k]; Object.assign(incidentConfig, saved); b.reset(); }
}

test('captured facts plus a SCRIPTED new certificate publish scoped facts without changing genuine coverage', async t => {
  const r = await replay(t, 'none', (m) => {
    assert.equal(completeKnowledgeManifest(m), false);
    assert.equal(m.qualifiedPartial, undefined);
    assert.ok(m.sourceScopedPartial);
    assert.ok(m.outcomes.every((o: any) => !o.materialFactsComplete && o.obligations.every((d: any) => d.status === 'UNRESOLVED')));
  });
  assert.equal(r.allowed, true); assert.deepEqual(r.stages, ['extraction', 'verification']);
  assert.equal(r.manifest.units.length, 4, 'Retain every accepted sentence; no semantic deduplication or hidden qualification loss');
  assert.ok(r.final.includes('Automatic appointment cancellation through chat is enabled.'));
  assert.ok(r.final.includes('The optional late cancellation fee is disabled.'));
  assert.ok(r.final.endsWith(limitation)); assert.doesNotMatch(r.final, /cannot verify an answer|24 hours|always free/);
  receipts.push({ kind: 'GENUINE_VERDICT_PLUS_SCRIPTED_CERTIFICATE', originalVerdict: JSON.parse(capture.verification.outputText),
    originalVerdictUnchanged: true, publishedInsideOwner: r.allowed, fullAnswerComplete: completeKnowledgeManifest(r.manifest),
    final: r.final, manifest: r.manifest });
  assert.equal(publishableKnowledgeManifest(r.manifest, 77), false, 'Authority cannot escape its native owner');
});
for (const fault of ['no-certificate', 'omitted-fact', 'condition', 'conflict', 'citation', 'deadline', 'fee', 'free', 'full-policy-known', 'missing-coverage', 'inconsistent'])
  test(`new partial authority fails closed/${fault}`, async t => {
    const r = await replay(t, fault); assert.equal(r.allowed, false); assert.equal(r.final, capture.finalInterceptedResponse);
  });
test('new token binds disclosures, facts, outcome statuses, language, tenant and presentation', async t => {
  await replay(t, 'none', (m) => {
    for (const changed of [{ ...m, sourceLimitations: [] }, { ...m, sourceScopedPartial: {} }, { ...m, text: m.units.map((u: any) => u.text).join(' ') },
      { ...m, units: m.units.slice(1) }, { ...m, language: 'sv' }, { ...m, naturalAttachment: {} },
      { ...m, presentation: { ...m.presentation, unitIds: ['u1'] } },
      { ...m, outcomes: m.outcomes.map((o: any) => ({ ...o, materialFactsComplete: true, status: 'VERIFIED',
        obligations: o.obligations.map((d: any) => ({ ...d, status: 'COVERED', unitIds: ['u1'] })) })) }, JSON.parse(JSON.stringify(m))])
      assert.equal(publishableKnowledgeManifest(changed, 77), false);
    assert.equal(publishableKnowledgeManifest(m, 88), false);
  });
});
for (const fault of ['text', 'revision', 'removed', 'foreign', 'added'] as const)
test(`even an uncited source change permanently revokes source-exhaustive authority/${fault}`, async t => {
  await replay(t, 'none', (m, evidence) => {
    assert.ok(m.units.every((u: any) => u.evidenceRefs.every((r: any) => r.evidenceId !== 'e1')));
    const current = evidence.map(e => e.id !== 'e1' ? e : ({ ...e, ...(fault === 'text' ? { text: e.text + ' changed' } :
      fault === 'revision' ? { version: e.version + '-changed' } : fault === 'foreign' ? { businessId: 88 } : {}) }));
    if (fault === 'removed') current.splice(current.findIndex(e => e.id === 'e1'), 1);
    if (fault === 'added') current.push({ ...evidence[0], id: 'new', sourceId: 'new' });
    const pruned = pruneAnswerManifest(m, current);
    assert.equal(publishableKnowledgeManifest(pruned, 77), false);
    assert.equal(publishableKnowledgeManifest(m, 77), false, 'Previously held tokens cannot revive after source restoration');
    assert.equal(publishableKnowledgeManifest(pruneAnswerManifest(pruned, evidence), 77), false);
  });
});

const languages = [
  ['en', capture.frozen.question, 'Automatic appointment cancellation through chat is enabled.', 'The optional late cancellation fee is disabled.'],
  ['sv', 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?', 'Automatisk avbokning av tider via chatt är aktiverad.', 'Den valfria avgiften för sen avbokning är inaktiverad.'],
  ['de', 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?', 'Die automatische Terminabsage per Chat ist aktiviert.', 'Die optionale Gebühr für eine verspätete Stornierung ist deaktiviert.'],
  ['es', '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?', 'La cancelación automática de citas por chat está habilitada.', 'El cargo opcional por cancelación tardía está desactivado.'],
  ['fa', 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟', 'لغو خودکار نوبت از طریق چت فعال است.', 'هزینه اختیاری لغو دیرهنگام غیرفعال است.'],
  ['ar', 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟', 'إلغاء المواعيد تلقائياً عبر الدردشة مفعّل.', 'رسوم الإلغاء المتأخر الاختيارية معطّلة.'],
];
for (const protocol of [SOURCE_EXHAUSTIVE_PROTOCOL, SOURCE_EXHAUSTIVE_V2_PROTOCOL]) for (const [language, question, chat, fee] of languages) for (const channel of incidentChannels)
test(`real adapter scoped source-exhaustive answer/${protocol}/${language}/${channel}`, async t => {
  quiet(t); b.reset(); const savedProtocol = process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL;
  process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = protocol; const saved = structuredClone(incidentConfig), answers: string[] = []; let actions = 0;
  const row = structuredClone(capture.frozen.rawCancellationSettings), normalized = b.promptAuditNormalize(row), stages: string[] = [];
  const forbidden = async () => { actions++; throw Error('OFFLINE_ACTION_FORBIDDEN'); };
  try {
    Object.assign(incidentConfig, row, { id: 77, businessId: 77, businessRecordId: 77, business_id: 77, language,
      cancellationSettingsEvidence: normalized.cancellationSettingsEvidence, allowCancellation: true, cancellationFeeEnabled: false });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      answers.push(interceptedIncidentSend(url, options)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, messages: [{ id: 'offline' }] }));
    });
    b.configure({ offlineAi: true, postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language, confidence: 1 }), knowledgeCancellationConfig: async () => structuredClone(row),
      knowledgeSearch: async () => structuredClone(capture.frozen.matches), knowledgeSourceLanguages: async () => [],
      semanticKnowledgeSearch: async () => [], semanticKnowledgeSearchQueries: async () => [], completeKnowledgeCorpus: async () => null,
      validateKnowledgeMatches: async (_id, matches) => matches, knowledgeServiceCatalog: async () => incidentConfig.services,
      aiGenerate: async r => {
        if (r.systemInstruction.includes('retrieval query planner')) throw new DOMException('offline forced planner timeout', 'TimeoutError');
        const data = JSON.parse(r.messages[0].content);
        if (r.systemInstruction.includes('UNIT EXTRACTION')) {
          stages.push('extraction'); assert.match(r.systemInstruction, /literal-evidence-v1/);
          return { text: JSON.stringify({ oversized: false, units: [chat, fee].map((text, i) => ({ facetIds: ['f1'], subject: 'configuration', predicate: 'setting', value: text,
            modality: 'descriptive', negation: i === 1, scope: 'chat automation and optional fee only', qualifiers: [], language, text,
            evidenceRefs: [{ evidenceId: 'configured-cancellation:77' }] })) }), functionCalls: [] };
        }
        assert.ok(r.systemInstruction.includes('BATCH ENTAILMENT')); stages.push('verification');
        assert.equal(r.structuredOutput.name, protocol === SOURCE_EXHAUSTIVE_PROTOCOL ? 'odinlink_knowledge_source_exhaustive_v1' : 'odinlink_knowledge_source_exhaustive_v2');
        if (protocol === SOURCE_EXHAUSTIVE_V2_PROTOCOL) assert.match(r.systemInstruction, /BOTH judge the supplied REQUEST PLAN/);
        return { text: JSON.stringify({ decisions: data.units.map((u: any) => ({ unitId: u.id, relation: 'ENTAILED', facetIds: u.facetIds, meaningPreserved: true,
          modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
          coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: false, incompletenessReason: 'MISSING_RELEVANT_FACT',
            materialUnitIds: data.units.filter((u: any) => u.facetIds.includes(f.id)).map((u: any) => u.id),
            obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'UNRESOLVED', unitIds: [] })) })), sourceCoverage: certificate(data, protocol) }), functionCalls: [] };
      }, calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden,
        cancelAppointment: forbidden, updateAppointment: forbidden }, recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
    await incidentInbound(b, channel, question);
    assert.equal(answers.length, 1); assert.deepEqual(stages, ['extraction', 'verification']); assert.equal(actions, 0);
    assert.ok(answers[0].includes(chat) && answers[0].includes(fee), answers[0]);
    assert.doesNotMatch(answers[0], /cannot verify an answer|24 hours|always free/);
    assert.ok(answers[0].length > chat.length + fee.length + 20, 'Explicit localized limitation required');
    if (language === 'en') assert.equal(answers[0], `${chat} ${fee}\n\n${limitation}`);
    receipts.push({ kind: 'SCRIPTED_REAL_ADAPTER', protocol, language, channel, final: answers[0], stages, actions });
  } finally { for (const k of Object.keys(incidentConfig)) delete (incidentConfig as any)[k]; Object.assign(incidentConfig, saved);
    if (savedProtocol === undefined) delete process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL; else process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = savedProtocol; b.reset(); }
});

test('managed model profile cannot silently fall back to another model for the new protocol', () => {
  const old = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;
  try { process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'sol-low-v1'; assert.throws(selectKnowledgeVerificationProtocol, /managed_profile_unsupported/); }
  finally { if (old === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = old; }
});

test('genuinely COMPLETE normative answer still uses the unchanged full-answer gate', async () => {
  await runAccuracyFirstNative(async () => {
    const question = 'What is your mandatory cancellation notice requirement?', text = 'Appointments must be cancelled at least 48 hours before the appointment.';
    const evidence = answerEvidence(4382, [{ businessId: 4382, sourceId: 'policy', text, metadata: { documentRevision: 'r1' } }]);
    const facets = parseRequestedFacets([{ subject: 'cancellation policy', attribute: 'mandatory cancellation notice requirement', questionType: 'requirement' }]).facets;
    const m = await buildEvidenceFirstAnswer({ question, language: 'en', businessId: 4382, facets, evidence, foreground: true,
      verificationProtocol: SOURCE_EXHAUSTIVE_PROTOCOL, authoritativeEvidence: '', businessTone: {}, history: [],
      budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true, revalidateEvidence: async () => evidence, languageSafe: () => true,
      generate: async (stage, _instruction, data: any) => stage === 'extraction' ? { text: JSON.stringify({ units: [{ facetIds: ['f1'], subject: 'appointments', predicate: 'cancellation notice', value: '48 hours',
        scope: 'appointments', modality: 'required', negation: false, qualifiers: [], language: 'en', text, evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] }] }) } :
        { text: JSON.stringify({ decisions: [{ unitId: 'u1', relation: 'ENTAILED', facetIds: ['f1'], meaningPreserved: true, modalityPreserved: true,
          qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false }],
          coverage: [{ facetId: 'f1', requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: ['u1'], obligations: [{ obligationId: 'f1.o1', status: 'COVERED', unitIds: ['u1'] }] }],
          sourceCoverage: { ...certificate(data), obligations: [{ facetId: 'f1', obligationId: 'f1.o1', state: 'COMPLETE' }] } }) } });
    assert.equal(completeKnowledgeManifest(m), true); assert.equal(publishableKnowledgeManifest(m, 4382), true); assert.equal(m.sourceScopedPartial, undefined);
  }, async () => assert.fail('Unexpected native failure'));
});

test('general scoped authority works for a different tenant and a non-cancellation question', async () => {
  await runAccuracyFirstNative(async () => {
    const question = 'Where is the studio entrance, and which entry documents are required?', text = 'The studio entrance is at Aurora 7.';
    const facets = parseRequestedFacets([{ subject: 'studio', attribute: 'Where is the studio entrance', questionType: 'description' },
      { subject: 'studio entry', attribute: 'which entry documents are required', questionType: 'requirement' }]).facets;
    const evidence = answerEvidence(4382, [{ businessId: 4382, sourceId: 'entrance-guide', text, metadata: { documentRevision: 'r1' } }]);
    const manifest = await buildEvidenceFirstAnswer({ question, language: 'en', businessId: 4382, facets, evidence, foreground: true,
      verificationProtocol: SOURCE_EXHAUSTIVE_PROTOCOL, authoritativeEvidence: '', businessTone: {}, history: [],
      budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true, revalidateEvidence: async () => evidence, languageSafe: () => true,
      generate: async (stage, _instruction, data: any) => {
        if (stage === 'extraction') return { text: JSON.stringify({ units: [{ facetIds: ['f1'], subject: 'studio entrance', predicate: 'location', value: 'Aurora 7',
          modality: 'descriptive', negation: false, scope: 'studio', qualifiers: [], language: 'en', text, evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] }] }) };
        const sourceCoverage = certificate(data); sourceCoverage.obligations[0].state = 'COMPLETE';
        return { text: JSON.stringify({ decisions: [{ unitId: 'u1', relation: 'ENTAILED', facetIds: ['f1'], meaningPreserved: true, modalityPreserved: true,
          qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false }],
          coverage: [{ facetId: 'f1', requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: ['u1'],
            obligations: [{ obligationId: 'f1.o1', status: 'COVERED', unitIds: ['u1'] }] },
          { facetId: 'f2', requestAligned: true, materialFactsComplete: false, incompletenessReason: 'UNRESOLVED', materialUnitIds: [],
            obligations: [{ obligationId: 'f2.o1', status: 'UNRESOLVED', unitIds: [] }] }], sourceCoverage }) };
      } });
    assert.equal(publishableKnowledgeManifest(manifest, 4382), true); assert.equal(completeKnowledgeManifest(manifest), false);
    assert.ok(manifest.text.startsWith(text)); assert.match(manifest.text, /which entry documents are required/);
    assert.doesNotMatch(manifest.text, /cancel|fee|24/);
  }, async () => assert.fail('Unexpected native failure'));
});
