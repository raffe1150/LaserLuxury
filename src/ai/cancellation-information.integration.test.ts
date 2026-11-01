import assert from 'node:assert/strict';
import test from 'node:test';
import { Responses } from 'openai/resources/responses';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { captureCancellationSettings, cancellationAspects, cancellationInformationNotice, cancellationInformationSubject,
  parseCancellationCoverage } from './cancellation-information';
import { cancellationGroundingConfig, readCancellationPolicy, cancellationPolicyFingerprint } from './cancellation-policy';
import { numericalConstraintSafe } from './numerical-constraints';
import { businessInformationSubject } from './business-information';
import { normalizeConversationText } from './booking-intelligence';
import { incidentFlags, incidentConfig, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['whatsapp', 'instagram', 'messenger', 'telegram'] as const;
const cases = [
  { language: 'en', question: 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?',
    permission: 'Appointments may be cancelled.', notice: 'Appointments must be cancelled at least 37 hours before the visit.', fee: 'The cancellation fee is 99 SEK.', free: 'Free cancellation is available at least 24 hours before the visit.' },
  { language: 'sv', question: 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?',
    permission: 'Bokade tider får avbokas.', notice: 'Bokade tider måste avbokas minst 37 timmar före besöket.', fee: 'Avbokningsavgiften är 99 SEK.', free: 'Avgiftsfri avbokning är möjlig minst 24 timmar före besöket.' },
  { language: 'de', question: 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?',
    permission: 'Termine dürfen storniert werden.', notice: 'Termine müssen mindestens 37 Stunden vor dem Besuch storniert werden.', fee: 'Die Stornierungsgebühr beträgt 99 SEK.', free: 'Eine kostenlose Stornierung ist mindestens 24 Stunden vor dem Besuch möglich.' },
  { language: 'es', question: '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?',
    permission: 'Se permite cancelar las citas.', notice: 'Las citas deben cancelarse al menos 37 horas antes de la visita.', fee: 'El cargo por cancelación es de 99 SEK.', free: 'La cancelación gratuita está disponible al menos 24 horas antes de la visita.' },
  { language: 'fa', question: 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟',
    permission: 'لغو نوبت مجاز است.', notice: 'نوبت باید حداقل ۳۷ ساعت پیش از مراجعه لغو شود.', fee: 'هزینه لغو ۹۹ SEK است.', free: 'لغو رایگان حداقل ۲۴ ساعت پیش از مراجعه امکان‌پذیر است.' },
  { language: 'ar', question: 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟',
    permission: 'يُسمح بإلغاء المواعيد.', notice: 'يجب إلغاء الموعد قبل 37 ساعة على الأقل.', fee: 'رسوم الإلغاء هي 99 SEK.', free: 'الإلغاء المجاني متاح قبل 24 ساعة على الأقل.' },
];
const explicit = { allow_cancellation: true, cancellation_deadline_minutes: 1440,
  cancellation_fee_enabled: true, cancellation_fee_amount: 250, cancellation_fee_currency: 'SEK' };

for (const raw of [{}, { allow_cancellation: null, cancellation_deadline_minutes: null },
  { allow_cancellation: 'yes', cancellation_deadline_minutes: '', cancellation_fee_enabled: 'false', cancellation_fee_amount: '250', cancellation_fee_currency: '???' }])
test(`normalization retains raw evidence and preserves operational behavior: ${JSON.stringify(raw)}`, () => {
  const row = { id: 3, ...raw }, normalized = b.promptAuditNormalize(row);
  assert.deepEqual(normalized.cancellationSettingsEvidence, captureCancellationSettings(row));
  assert.equal(cancellationGroundingConfig(normalized), undefined);
  const withoutEvidence = { ...normalized }; delete withoutEvidence.cancellationSettingsEvidence;
  assert.deepEqual(readCancellationPolicy(normalized), readCancellationPolicy(withoutEvidence));
  assert.equal(cancellationPolicyFingerprint(normalized), cancellationPolicyFingerprint(withoutEvidence), 'Consent fingerprint must not change');
});
test('explicit false and zero remain present; missing fields cannot acquire currency, fees or a free window', () => {
  const config = b.promptAuditNormalize({ id: 3, allow_cancellation: false, cancellation_deadline_minutes: 0 });
  const evidence = cancellationGroundingConfig(config)!;
  assert.equal(evidence.automaticCancellationEnabled, false);
  assert.equal(evidence.freeCancellationDeadlineMinutes, undefined);
  assert.equal(evidence.lateFeeEnabled, undefined);
  assert.equal(evidence.lateFeeAmount, undefined);
  assert.equal(evidence.lateFeeCurrency, undefined);
});
test('incomplete or inconsistent fee settings cannot assert an applicable fee policy', () => {
  for (const raw of [{ cancellation_fee_enabled: true }, { ...explicit, allow_cancellation: undefined, cancellation_fee_amount: 0 },
    { ...explicit, allow_cancellation: undefined, cancellation_fee_currency: '?' }, { cancellation_deadline_minutes: 1440 }]) {
    assert.equal(cancellationGroundingConfig(b.promptAuditNormalize({ id: 3, ...raw })), undefined);
  }
});
test('legacy normalized defaults and contradictory aliases cannot acquire factual policy authority', () => {
  const legacy = { id: 3, businessRecordId: 3, allowCancellation: false, cancellationDeadlineMinutes: 0,
    cancellationFeeEnabled: false, cancellationFeeAmount: 0, cancellationFeeCurrency: 'SEK' };
  assert.equal(cancellationGroundingConfig(legacy), undefined);
  const aliases = { id: 3, allowCancellation: true, allow_cancellation: false };
  assert.equal(captureCancellationSettings(aliases).fields.allowCancellation.presence, 'invalid');
  assert.equal(cancellationGroundingConfig(aliases), undefined);
});
test('coverage validation rejects missing, repeated, invented and unquoted aspect decisions', () => {
  assert.equal(parseCancellationCoverage(undefined, 'answer'), null);
  const valid = cancellationAspects.map(aspect => ({ aspect, status: 'covered', quote: 'answer' }));
  assert.ok(parseCancellationCoverage(valid, 'answer'));
  assert.equal(parseCancellationCoverage(valid.slice(1), 'answer'), null);
  assert.equal(parseCancellationCoverage(valid.map(() => valid[0]), 'answer'), null);
  assert.equal(parseCancellationCoverage(valid.map(item => ({ ...item, quote: 'invented' })), 'answer'), null);
});
test('an omitted hard-cutoff field cannot turn disabled chat automation into a global cancellation prohibition', () => {
  const evidence = { source: 'structured_business_config', quote: '"automaticCancellationEnabled": false' };
  const snapshot = JSON.stringify({ cancellation: { available: true, automaticCancellationEnabled: false } });
  assert.equal(numericalConstraintSafe('You cannot cancel.', 'You cannot cancel.', [evidence], snapshot), false);
  assert.equal(numericalConstraintSafe('You cannot cancel automatically through chat.', 'You cannot cancel automatically through chat.', [evidence], snapshot), true);
});

const modes = ['document', 'absent', 'null', 'malformed', 'partial_settings', 'settings_only', 'conflict', 'stale', 'revoked',
  'missing', 'retrieval_failure', 'verifier_failure', 'unsupported', 'partial', 'coverage_failure', 'compound', 'invalid_source',
  'stale_document', 'coverage_revoked', 'verifier_rejected', 'document_prohibition', 'semantic_failure', 'semantic_invalid_source'] as const;
const extraQuestion: Record<string, string> = { en: 'Where is the customer entrance?', sv: 'Var ligger kundentrén?', de: 'Wo ist der Kundeneingang?',
  es: '¿Dónde está la entrada de clientes?', fa: 'ورودی مشتریان کجاست؟', ar: 'أين مدخل العملاء؟' };
const prohibition: Record<string, string> = { en: 'Appointments cannot be cancelled.', sv: 'Bokade tider får inte avbokas.', de: 'Termine können nicht storniert werden.',
  es: 'No se permite cancelar las citas.', fa: 'لغو نوبت مجاز نیست.', ar: 'لا يُسمح بإلغاء المواعيد.' };
for (const row of cases) {
  test(`${row.language}: free windows, mandatory notice and document prohibitions have distinct numerical authority`, () => {
    const settings = JSON.stringify({ cancellation: cancellationGroundingConfig({ id: 3, ...explicit }) });
    const citation = { source: 'structured_business_config', quote: '"freeCancellationDeadlineMinutes": 1440' };
    assert.equal(numericalConstraintSafe(row.free, row.free, [citation], settings), true);
    assert.equal(numericalConstraintSafe(row.notice, row.notice, [citation], settings), false);
    assert.equal(numericalConstraintSafe(row.notice, row.notice, [row.notice], JSON.stringify({})), true);
    const conflictingFree = row.free.replace(/24|۲۴/gu, row.language === 'fa' ? '۳۷' : '37');
    assert.equal(numericalConstraintSafe(conflictingFree, conflictingFree, [conflictingFree], settings), false);
    assert.equal(businessInformationSubject(row.question, row.language), cancellationInformationSubject(row.language));
  });

  for (const channel of channels) for (const mode of modes)
  test(`native ${channel}/${row.language}/${mode}: grounded cancellation information preserves provenance and scope`, async t => {
    b.reset();
    const saved = structuredClone(incidentConfig), replies: string[] = [], outcomes: any[] = [];
    let calendarCalls = 0, coverageCalls = 0;
    for (const name of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, name, () => {});
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      replies.push(interceptedIncidentSend(input, options));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
    });
    const raw = { id: 3, business_name: 'Synthetic Policy Studio', language: row.language,
      ...(mode === 'null' ? { allow_cancellation: null, cancellation_deadline_minutes: null, cancellation_fee_enabled: null, cancellation_fee_amount: null, cancellation_fee_currency: null } : {}),
      ...(mode === 'malformed' ? { allow_cancellation: 'invalid', cancellation_deadline_minutes: '', cancellation_fee_enabled: 'false', cancellation_fee_amount: '250', cancellation_fee_currency: '?' } : {}),
      ...(mode === 'partial_settings' ? { allow_cancellation: true } : {}),
      ...(['settings_only', 'conflict'].includes(mode) ? explicit : {}) };
    const normalized = b.promptAuditNormalize(raw);
    const question = mode === 'compound' ? `${row.question} ${extraQuestion[row.language]}` : row.question;
    const conflicting = row.free.replace(/24|۲۴/gu, row.language === 'fa' ? '۳۷' : '37');
    const facts = mode === 'settings_only' ? [row.free] : mode === 'conflict' ? [conflicting]
      : mode === 'partial' ? [row.notice] : mode === 'document_prohibition' ? [prohibition[row.language]] : [row.permission, row.notice, row.fee];
    const candidate = facts.join(' '), document = (['conflict', 'document_prohibition'].includes(mode) ? facts : [row.permission, row.notice, row.fee]).join(' ');
    const storage = new InMemoryKnowledgeStorage(), service = new KnowledgeService(storage, storage);
    const parsed = documentChunks([{ text: document }], 'SyntheticPolicy.txt');
    await storage.create({ id: 'policy', businessId: 3, type: 'document', status: 'ready', title: 'SyntheticPolicy.txt',
      content: parsed.content, metadata: parsed.metadata, createdAt: '2026-10-31', updatedAt: '2026-10-31' });
    await storage.replaceChunks(3, 'policy', parsed.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: c.metadata as any })));
    const forbidden = async () => { calendarCalls++; throw Error('invalid_grant'); };
    try {
      Object.assign(incidentConfig, { id: 3, businessId: 3, businessName: normalized.businessName, language: row.language,
        timezone: normalized.timezone, services: [], systemPrompt: '', allowCancellation: normalized.allowCancellation,
        cancellationDeadlineMinutes: normalized.cancellationDeadlineMinutes, cancellationFeeEnabled: normalized.cancellationFeeEnabled,
        cancellationFeeAmount: normalized.cancellationFeeAmount, cancellationFeeCurrency: normalized.cancellationFeeCurrency,
        cancellationSettingsEvidence: normalized.cancellationSettingsEvidence });
      b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
        semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }),
        loadCancellationConfig: async () => mode === 'stale' ? { ...raw, ...explicit } : raw,
        knowledgeSearch: async (id, q, limit) => {
          assert.equal(id, 3);
          if (mode === 'retrieval_failure') throw Error('synthetic retrieval unavailable');
          if (mode === 'invalid_source') return [{ sourceId: 'foreign', businessId: 88, text: 'FOREIGN-TENANT-SECRET', score: 1, metadata: { source: 'document' } }];
          return ['missing', 'settings_only', 'semantic_failure', 'semantic_invalid_source'].includes(mode) ? [] : service.search(id, q, limit);
        }, semanticKnowledgeSearchQueries: async (_id, _queries, _limit, options) => {
          if (mode === 'semantic_failure' || mode === 'semantic_invalid_source') options?.onStatus?.({ status: 'unavailable', reason: mode === 'semantic_failure' ? 'storage_unavailable' : 'source_changed' });
          return [];
        }, validateKnowledgeMatches: (id, matches) => service.validateMatches(id, matches),
        cancellationInformationDiagnostic: event => outcomes.push(event),
        calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
        recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
        geminiGenerate: async p => {
          if (p.config.systemInstruction.includes('retrieval query planner')) return { text: JSON.stringify({ canonicalMeaning: 'cancellation policy', queries: [document] }) };
          if (mode === 'revoked') await storage.delete(3, 'policy');
          if (mode === 'stale_document') {
            const previous = (await storage.list(3))[0];
            await storage.create({ ...previous, content: previous.content + ' A changed revision.', updatedAt: '2026-11-01' });
          }
          return { text: candidate };
        },
        assessBusinessSupportGrounding: async r => {
          const projection = JSON.parse(r.structuredBusinessConfig || '{}').cancellation;
          if (['absent', 'null', 'malformed', 'document'].includes(mode)) assert.equal(projection, undefined, 'Defaults must never enter factual evidence');
          if (mode === 'verifier_failure') return null;
          const supported = !['missing', 'retrieval_failure', 'unsupported', 'invalid_source', 'semantic_failure', 'semantic_invalid_source'].includes(mode);
          return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: supported,
            claims: facts.map(fact => ({ claim: fact, candidateQuote: fact, claimKind: ['settings_only', 'document_prohibition'].includes(mode) ? 'NEGATIVE_ABSENCE' : 'OTHER',
              requiresBusinessEvidence: true, supported, evidence: supported ? [{ source: mode === 'settings_only' ? 'structured_business_config' : 'retrieved_knowledge',
                quote: mode === 'settings_only' ? '"freeCancellationDeadlineMinutes": 1440' : fact }] : [] })) } as any;
        },
        assessBusinessClaimEntailment: async r => {
          if (!r.cancellationCoverage) return { relation: mode === 'verifier_rejected' ? 'UNKNOWN' : 'ENTAILED', claimKind: r.claimKind, explicitAbsenceEvidence: true };
          coverageCalls++;
          assert.equal(normalizeConversationText(r.customerMessage), normalizeConversationText(question));
          if (mode === 'coverage_failure') return null;
          if (mode === 'coverage_revoked') await storage.delete(3, 'policy');
          const partial = ['partial', 'settings_only', 'compound', 'document_prohibition'].includes(mode);
          return { relation: partial ? 'UNKNOWN' : 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false,
            coverage: cancellationAspects.map(aspect => ({ aspect,
              status: mode === 'compound' ? aspect === 'other_requested_details' ? 'missing' : 'covered'
                : aspect === 'other_requested_details' ? 'not_requested'
                : mode === 'document_prohibition' ? aspect === 'permission' ? 'covered' : 'missing'
                : partial && (mode === 'settings_only' || aspect !== 'advance_notice') ? 'missing' : 'covered',
              quote: candidate })) };
        },
      });
      await incidentInbound(b, channel, question);
      assert.equal(calendarCalls, 0); assert.equal(replies.length, 1);
      const reply = replies[0];
      if (['document', 'absent', 'null', 'malformed', 'partial_settings'].includes(mode)) {
        for (const fact of facts) assert.ok(reply.includes(fact), reply);
        assert.equal(coverageCalls, 1);
      } else if (['partial', 'settings_only', 'coverage_failure', 'compound', 'document_prohibition'].includes(mode)) {
        assert.ok(reply.includes(facts[0]), reply);
        assert.ok(reply.includes(cancellationInformationNotice(row.language, mode === 'coverage_failure' ? 'verifier_failed' : 'incomplete_scope')), reply);
        assert.ok(outcomes.some(event => event.reason === (mode === 'coverage_failure' ? 'verifier_failed' : 'incomplete_scope')), JSON.stringify(outcomes));
      } else {
        const expected = ['stale', 'revoked', 'invalid_source', 'stale_document', 'coverage_revoked', 'semantic_invalid_source'].includes(mode) ? 'source_invalid' : mode === 'verifier_failure' ? 'verifier_failed'
          : ['retrieval_failure', 'semantic_failure'].includes(mode) ? 'retrieval_failed' : mode === 'missing' ? 'no_matching_evidence' : 'unsupported_claims';
        assert.ok(reply.includes(cancellationInformationNotice(row.language, expected)), JSON.stringify({ reply, outcomes }));
        assert.equal(reply.includes(facts[0]), false);
      }
      assert.doesNotMatch(reply, /FOREIGN-TENANT-SECRET|terms and preparation/u);
    } finally { for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key]; Object.assign(incidentConfig, saved); b.reset(); }
  });
}

test('installed OpenAI SDK uses the same extraction, entailment and independent scope contracts offline', async t => {
  b.reset();
  const previous = { AI_PROVIDER: process.env.AI_PROVIDER, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL };
  const row = cases[0], stages: string[] = [];
  for (const name of ['log', 'warn', 'info', 'error'] as const) t.mock.method(console, name, () => {});
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-offline', OPENAI_MODEL: 'gpt-5.6-luna' });
  t.mock.method(Responses.prototype, 'create', async (request: any) => {
    const body = JSON.parse(request.input[0].content), instruction = request.instructions;
    let result: unknown;
    if (instruction.includes('coverage verifier')) {
      stages.push('coverage'); assert.equal(body.relevantContext.customerQuestion, row.question);
      result = { relation: 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false,
        coverage: cancellationAspects.map(aspect => ({ aspect, status: aspect === 'other_requested_details' ? 'not_requested' : 'missing', quote: '' })) };
    } else if (instruction.includes('claim and citation extractor')) {
      stages.push('extraction');
      result = { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [{ claim: row.free, candidateQuote: row.free,
        claimKind: 'NEGATIVE_ABSENCE', requiresBusinessEvidence: true, supported: true,
        evidence: [{ source: 'structured_business_config', quote: '"freeCancellationDeadlineMinutes": 1440' }] }] };
    } else {
      stages.push('entailment'); assert.match(instruction, /entailment gate/u);
      result = { relation: 'ENTAILED', claimKind: 'NEGATIVE_ABSENCE', explicitAbsenceEvidence: true };
    }
    return { output_text: JSON.stringify(result), output: [] } as any;
  });
  try {
    b.configure({});
    b.businessInformationState('sdk-policy', { id: 3, ...explicit }, row.question, 'en', '');
    const reply = await b.businessSupportGrounding('sdk-policy', row.question, row.free, 'en');
    assert.ok(reply.includes(row.free)); assert.ok(reply.includes('Still unverified:'));
    assert.deepEqual(stages, ['extraction', 'entailment', 'coverage']);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    b.reset();
  }
});
