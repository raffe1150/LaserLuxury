import assert from 'node:assert/strict';
import test from 'node:test';
import { incidentFlags, incidentConfig, incidentInbound, incidentSession, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
import { cancellationAspects, cancellationInformationNotice } from './cancellation-information';
import { InMemoryKnowledgeStorage, KnowledgeService } from '../../knowledge';
import { documentChunks } from '../knowledge/documents/service';
import { cancellationGroundingConfig } from './cancellation-policy';
import { bindCancellationCoverage } from './cancellation-coverage';
import { normalizeConversationText } from './booking-intelligence';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const channels = ['whatsapp', 'instagram', 'messenger', 'telegram'] as const;

for (const channel of channels) test(`native ${channel}: question-less completed support cannot publish changed cancellation settings`, async t => {
  b.reset();
  const saved = structuredClone(incidentConfig), replies: string[] = [];
  let calendarCalls = 0, settingsReads = 0;
  const raw = { id: 3, business_name: 'Synthetic Policy Studio', language: 'de',
    allow_cancellation: true, cancellation_deadline_minutes: 1440,
    cancellation_fee_enabled: true, cancellation_fee_amount: 250, cancellation_fee_currency: 'SEK' };
  let current = { ...raw };
  const config = b.promptAuditNormalize(raw);
  const fact = 'Eine kostenlose Stornierung ist mindestens 24 Stunden vor dem Besuch möglich.';
  // A noun-form support request reaches the completed-booking support branch,
  // rather than the interrogative information branch or a cancellation action.
  const question = 'Stornierungsgebühren bitte';
  for (const name of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, name, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  const forbidden = async () => { calendarCalls++; throw Error('invalid_grant'); };
  try {
    Object.assign(incidentConfig, { id: 3, businessId: 3, services: [], systemPrompt: '', language: 'de',
      allowCancellation: config.allowCancellation, cancellationDeadlineMinutes: config.cancellationDeadlineMinutes,
      cancellationFeeEnabled: config.cancellationFeeEnabled, cancellationFeeAmount: config.cancellationFeeAmount,
      cancellationFeeCurrency: config.cancellationFeeCurrency, cancellationSettingsEvidence: config.cancellationSettingsEvidence });
    const session = incidentSession(b, channel, '46700000001');
    b.seedRecentCompletedBooking(session, 'de', { ok: true, bookingId: 'synthetic-booking', businessId: 3,
      serviceName: 'Video Consultation', startTime: '2030-09-15T14:00:00+02:00', customerName: 'Synthetic Customer',
      customerPhone: '46700000001', sourceChannel: channel }, 30);
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language: 'de', confidence: 1 }),
      loadCancellationConfig: async () => { settingsReads++; return current; },
      knowledgeSearch: async () => [], semanticKnowledgeSearchQueries: async () => [],
      calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
      geminiGenerate: async () => { current = { ...raw, cancellation_deadline_minutes: 2880 }; return { text: fact }; },
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: [{ claim: fact, candidateQuote: fact, claimKind: 'NEGATIVE_ABSENCE', requiresBusinessEvidence: true, supported: true,
          evidence: [{ source: 'structured_business_config', quote: '"freeCancellationDeadlineMinutes": 1440' }] }] }),
      assessBusinessClaimEntailment: async () => ({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: true,
        coverage: cancellationAspects.map(aspect => ({ aspect, status: 'covered', quote: fact })) }),
    });
    await incidentInbound(b, channel, question);
    assert.equal(calendarCalls, 0);
    assert.equal(replies.length, 1);
    assert.ok(!replies[0].includes(fact), JSON.stringify({ reply: replies[0], settingsReads, support: b.recentCompletionState(session).support }));
    assert.ok(replies[0].includes(cancellationInformationNotice('de', 'source_invalid')), replies[0]);
    assert.ok(settingsReads > 0);
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});

const dashboardPayload = { allowCancellation: true, cancellationDeadlineMinutes: 1440,
  cancellationFeeEnabled: true, cancellationFeeAmount: 250, cancellationFeeCurrency: 'SEK' };
const rawDashboard = { id: 3, allow_cancellation: true, cancellation_deadline_minutes: 1440,
  cancellation_fee_enabled: true, cancellation_fee_amount: 250, cancellation_fee_currency: 'SEK' };
const languages = [
  { language: 'en', question: 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?',
    permission: 'Appointments may be cancelled.', notice: 'Appointments must be cancelled at least 37 hours before the visit.',
    fee: 'The cancellation fee is 250 SEK.', free: 'Free cancellation is available at least 24 hours before the visit.',
    entranceQuestion: 'Where is the customer entrance?', entrance: 'The customer entrance is on Studio Street 99.', noun: 'Late fees please' },
  { language: 'sv', question: 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?',
    permission: 'Bokade tider får avbokas.', notice: 'Bokade tider måste avbokas minst 37 timmar före besöket.',
    fee: 'Avbokningsavgiften är 250 SEK.', free: 'Avgiftsfri avbokning är möjlig minst 24 timmar före besöket.',
    entranceQuestion: 'Var ligger kundentrén?', entrance: 'Kundentrén ligger på Studio Street 99.', noun: 'Avbokningsavgifter tack' },
  { language: 'de', question: 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?',
    permission: 'Termine dürfen storniert werden.', notice: 'Termine müssen mindestens 37 Stunden vor dem Besuch storniert werden.',
    fee: 'Die Stornierungsgebühr beträgt 250 SEK.', free: 'Eine kostenlose Stornierung ist mindestens 24 Stunden vor dem Besuch möglich.',
    entranceQuestion: 'Wo ist der Kundeneingang?', entrance: 'Der Kundeneingang befindet sich in Studio Street 99.', noun: 'Stornierungsgebühren bitte' },
  { language: 'es', question: '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?',
    permission: 'Se permite cancelar las citas.', notice: 'Las citas deben cancelarse al menos 37 horas antes de la visita.',
    fee: 'El cargo por cancelación es de 250 SEK.', free: 'La cancelación gratuita está disponible al menos 24 horas antes de la visita.',
    entranceQuestion: '¿Dónde está la entrada de clientes?', entrance: 'La entrada de clientes está en Studio Street 99.', noun: 'Cargos por retraso, por favor' },
  { language: 'fa', question: 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟',
    permission: 'لغو نوبت مجاز است.', notice: 'نوبت باید حداقل ۳۷ ساعت پیش از مراجعه لغو شود.',
    fee: 'هزینه لغو ۲۵۰ SEK است.', free: 'لغو رایگان حداقل ۲۴ ساعت پیش از مراجعه امکان‌پذیر است.',
    entranceQuestion: 'ورودی مشتریان کجاست؟', entrance: 'ورودی مشتریان در Studio Street 99 است.', noun: 'هزینه‌های دیرکرد لطفا' },
  { language: 'ar', question: 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟',
    permission: 'يُسمح بإلغاء المواعيد.', notice: 'يجب إلغاء الموعد قبل 37 ساعة على الأقل.',
    fee: 'رسوم الإلغاء هي 250 SEK.', free: 'الإلغاء المجاني متاح قبل 24 ساعة على الأقل.',
    entranceQuestion: 'أين مدخل العملاء؟', entrance: 'مدخل العملاء في Studio Street 99.', noun: 'رسوم التأخير من فضلك' },
];
const scenarios = ['all_covered', 'all_not_requested', 'all_unresolved', 'notice_omitted', 'compound_omitted', 'compound_complete',
  'complete', 'partial', 'free_conflict', 'fee_conflict', 'coverage_malformed', 'coverage_contradicted', 'coverage_unavailable',
  'revoked_during_coverage', 'changed_during_coverage', 'settings_changed_during_coverage', 'owner_changed_during_publication',
  'postbooking_changed_settings', 'postbooking_forged_marker', 'free_only_complete', 'notice_only_complete', 'compound_unknown', 'permission_omitted',
  'free_deadline_unquantified', 'free_absence_complete', 'service_price_not_policy_fee', 'compound_wrong_attribute',
  'fee_amount_negated', 'fee_status_negated'] as const;

const negatedFees: Record<string, [string, string]> = {
  en: ['The cancellation fee is not 250 SEK.', 'Cancellation is not free.'],
  sv: ['Avbokningsavgiften är inte 250 SEK.', 'Avbokning är inte avgiftsfri.'],
  de: ['Die Stornierungsgebühr beträgt nicht 250 SEK.', 'Die Stornierung ist nicht kostenlos.'],
  es: ['El cargo por cancelación no es de 250 SEK.', 'La cancelación no es gratuita.'],
  fa: ['هزینه لغو ۲۵۰ SEK نیست.', 'لغو رایگان نیست.'],
  ar: ['رسوم الإلغاء ليست 250 SEK.', 'الإلغاء ليس مجاني.'],
};

const closedEntrances: Record<string, string> = { en: 'The customer entrance is closed.', sv: 'Kundentrén är stängd.',
  de: 'Der Kundeneingang ist geschlossen.', es: 'La entrada de clientes está cerrada.', fa: 'ورودی مشتریان بسته است.', ar: 'مدخل العملاء مغلق.' };

const servicePrices: Record<string, [string, string]> = {
  en: ['Cancellation Fee Consultation costs 250 SEK.', 'What cancellation fee applies?'],
  sv: ['Cancellation Fee Consultation kostar 250 SEK.', 'Vilken avbokningsavgift gäller?'],
  de: ['Cancellation Fee Consultation kostet 250 SEK.', 'Welche Stornierungsgebühr gilt?'],
  es: ['Cancellation Fee Consultation cuesta 250 SEK.', '¿Qué cargo por cancelación se aplica?'],
  fa: ['هزینه Cancellation Fee Consultation برابر ۲۵۰ SEK است.', 'هزینه لغو چقدر است؟'],
  ar: ['تكلفة Cancellation Fee Consultation هي 250 SEK.', 'ما رسوم الإلغاء؟'],
};

const freeStatements: Record<string, [string, string]> = {
  en: ['Cancellation is free.', 'Is cancellation free?'],
  sv: ['Avbokning är avgiftsfri.', 'Är avbokning avgiftsfri?'],
  de: ['Die Stornierung ist kostenlos.', 'Ist die Stornierung kostenlos?'],
  es: ['La cancelación es gratuita.', '¿La cancelación es gratuita?'],
  fa: ['لغو رایگان است.', 'آیا لغو رایگان است؟'],
  ar: ['الإلغاء مجاني.', 'هل الإلغاء مجاني؟'],
};

const unknownQuestions: Record<string, string> = { en: 'Can I bring a guest?', sv: 'Får jag ta med en gäst?',
  de: 'Darf ich eine Begleitperson mitbringen?', es: '¿Puedo traer un acompañante?', fa: 'آیا می‌توانم همراه بیاورم؟', ar: 'هل يمكن إحضار مرافق؟' };

const narrowQuestions: Record<string, [string, string]> = {
  en: ['What free-cancellation deadline applies?', 'How far in advance must I cancel my appointment?'],
  sv: ['Vilken tidsgräns gäller för avgiftsfri avbokning?', 'Hur långt i förväg måste jag avboka min tid?'],
  de: ['Welche Frist gilt für die kostenlose Stornierung?', 'Wie weit im Voraus muss ich meinen Termin stornieren?'],
  es: ['¿Qué plazo se aplica a la cancelación gratuita?', '¿Con cuánta antelación debo cancelar mi cita?'],
  fa: ['مهلت لغو رایگان چیست؟', 'چند ساعت قبل باید نوبت را لغو کنم؟'],
  ar: ['ما مهلة الإلغاء المجاني؟', 'كم ساعة قبل الموعد يجب إلغاء الحجز؟'],
};

const facetQuestions: Record<string, [string, string]> = {
  en: ['What is the free-cancellation window and the cancellation fee?', 'May I cancel Therapy appointments and Consultation appointments?'],
  sv: ['Vilken tidsgräns gäller för avgiftsfri avbokning och vilken avbokningsavgift gäller?', 'Får jag avboka Therapy och Consultation?'],
  de: ['Welche Frist gilt für kostenlose Stornierung und welche Stornierungsgebühr gilt?', 'Darf ich Therapy und Consultation stornieren?'],
  es: ['¿Cuál es el plazo de cancelación gratuita y el cargo por cancelación?', '¿Se permite cancelar Therapy y Consultation?'],
  fa: ['مهلت لغو رایگان و هزینه لغو چیست؟', 'آیا لغو Therapy و Consultation مجاز است؟'],
  ar: ['ما فترة الإلغاء المجاني وما رسوم الإلغاء؟', 'هل يسمح بإلغاء Therapy وConsultation؟'],
};
for (const row of languages) test(`${row.language}: neither missing fee evidence nor equal values in different service scopes establish completeness`, () => {
  const coverage = cancellationAspects.map(aspect => ({ aspect, status: 'covered' as const, quote: row.free }));
  const freeOnly = bindCancellationCoverage({ question: facetQuestions[row.language][0], reply: row.free, coverage,
    sources: { retrieved_knowledge: row.free }, propositions: [{ claim: row.free, candidateQuote: row.free,
      evidence: [{ source: 'retrieved_knowledge', quote: row.free }] }] });
  assert.equal(freeOnly.coverage.find(c => c.aspect === 'fees_and_windows')?.status, 'missing');
  const therapy = `Therapy ${row.permission}`, consultation = `Consultation ${row.permission}`;
  const scoped = bindCancellationCoverage({ question: facetQuestions[row.language][1], reply: therapy,
    coverage: coverage.map(c => ({ ...c, quote: therapy })), sources: { retrieved_knowledge: `${therapy} ${consultation}` },
    propositions: [{ claim: therapy, candidateQuote: therapy, evidence: [{ source: 'retrieved_knowledge', quote: therapy }] }] });
  assert.equal(scoped.coverage.find(c => c.aspect === 'permission')?.status, 'missing');
  assert.equal(scoped.conflict, false, 'Distinct entity scopes are not an established same-attribute conflict');
});

test('actual Dashboard field schema has the same evidence attributes as its persisted row, with no mandatory notice', () => {
  const normalized = b.promptAuditNormalize(rawDashboard);
  assert.deepEqual(cancellationGroundingConfig({ id: 3, ...dashboardPayload }), cancellationGroundingConfig(normalized));
  const policy = cancellationGroundingConfig(normalized)!;
  assert.equal(policy.freeCancellationDeadlineMinutes, 1440);
  assert.equal(policy.hardCancellationCutoffMinutes, null);
  assert.equal(policy.lateFeeAmount, 250);
  assert.equal(policy.automaticCancellationEnabled, true);
});

test('a negated parking identifier cannot satisfy an identifier request; its affirmative counterpart can', () => {
  const notice = languages[0].notice, question = 'What cancellation deadline applies, and what is the parking gate identifier?';
  for (const negated of [true, false]) {
    const id = `The parking gate identifier is ${negated ? 'not ' : ''}TALL-742.`, reply = `${notice} ${id}`;
    const coverage = cancellationAspects.map(aspect => ({ aspect, quote: reply,
      status: ['advance_notice', 'other_requested_details'].includes(aspect) ? 'covered' as const : 'not_requested' as const }));
    const decision = bindCancellationCoverage({ question, reply, coverage, sources: { retrieved_knowledge: reply },
      propositions: [notice, id].map(text => ({ claim: text, candidateQuote: text, evidence: [{ source: 'retrieved_knowledge', quote: text }] })) });
    assert.equal(decision.coverage.find(c => c.aspect === 'advance_notice')?.status, 'covered');
    assert.equal(decision.coverage.find(c => c.aspect === 'other_requested_details')?.status, negated ? 'missing' : 'covered');
  }
});

for (const row of languages) for (const channel of channels) for (const scenario of scenarios)
test(`native ${channel}/${row.language}/${scenario}: coverage cannot override grounded aspect obligations`, async t => {
  b.reset();
  const saved = structuredClone(incidentConfig), replies: string[] = [], outcomes: any[] = [];
  let calendarCalls = 0, coverageCalls = 0, afterCoverageValidations = 0, superseded = false, settingsReads = 0;
  const unquantifiedFree = scenario === 'free_deadline_unquantified' || scenario === 'free_absence_complete';
  const servicePrice = scenario === 'service_price_not_policy_fee';
  const negatedFee = scenario === 'fee_amount_negated' || scenario === 'fee_status_negated';
  const raw = { ...(unquantifiedFree || servicePrice || negatedFee ? { id: 3 } : rawDashboard), language: row.language };
  let current = { ...raw };
  const normalized = b.promptAuditNormalize(raw);
  const compound = scenario === 'compound_complete' || scenario === 'compound_omitted' || scenario === 'compound_wrong_attribute';
  const postbooking = scenario.startsWith('postbooking_');
  const question = postbooking ? row.noun : servicePrice || negatedFee ? servicePrices[row.language][1] : scenario === 'free_absence_complete' ? freeStatements[row.language][1]
    : scenario === 'free_only_complete' || scenario === 'free_deadline_unquantified' ? narrowQuestions[row.language][0]
    : scenario === 'notice_only_complete' ? narrowQuestions[row.language][1]
    : `${row.question}${compound ? ` ${row.entranceQuestion}` : scenario === 'compound_unknown' ? ` ${unknownQuestions[row.language]}` : ''}`;
  const free = scenario === 'free_conflict' ? row.free.replace(/24|۲۴/gu, row.language === 'fa' ? '۳۷' : '37') : row.free;
  const fee = scenario === 'fee_conflict' ? row.fee.replace(/250|۲۵۰/gu, row.language === 'fa' ? '۹۹' : '99') : row.fee;
  const entrance = scenario === 'compound_wrong_attribute' ? closedEntrances[row.language] : row.entrance;
  const sourceFacts = negatedFee ? [negatedFees[row.language][scenario === 'fee_amount_negated' ? 0 : 1]] : servicePrice ? [servicePrices[row.language][0]] : unquantifiedFree ? [freeStatements[row.language][0]] : [row.permission, row.notice, fee, free, ...(compound ? [entrance] : [])];
  const partial = ['all_covered', 'all_not_requested', 'all_unresolved', 'notice_omitted', 'partial'].includes(scenario) || postbooking;
  const facts = unquantifiedFree || servicePrice || negatedFee ? sourceFacts : partial || scenario === 'free_only_complete' ? [row.free] : scenario === 'notice_only_complete' ? [row.notice]
    : scenario === 'permission_omitted' ? [row.notice, fee, free]
    : sourceFacts.filter(f => scenario !== 'compound_omitted' || f !== row.entrance);
  const candidate = facts.join(' ');
  const storage = new InMemoryKnowledgeStorage(), service = new KnowledgeService(storage, storage);
  const parsed = documentChunks([{ text: sourceFacts.join(' ') }], 'SyntheticPolicy.txt');
  await storage.create({ id: 'policy', businessId: 3, type: 'document', status: 'ready', title: 'SyntheticPolicy.txt', content: parsed.content,
    metadata: parsed.metadata, createdAt: '2026-10-31', updatedAt: '2026-10-31' });
  await storage.replaceChunks(3, 'policy', parsed.chunks.map(c => ({ chunkIndex: Number(c.chunk_index), content: String(c.content), metadata: c.metadata as any })));
  for (const name of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, name, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  const forbidden = async () => { calendarCalls++; throw Error('invalid_grant'); };
  try {
    Object.assign(incidentConfig, { id: 3, businessId: 3, services: [], systemPrompt: '', language: row.language,
      ...dashboardPayload, cancellationSettingsEvidence: normalized.cancellationSettingsEvidence });
    if (servicePrice) incidentConfig.services = [{ name: 'Cancellation Fee Consultation', price: 250, currency: 'SEK' }] as any;
    if (scenario === 'postbooking_forged_marker') (incidentConfig as any).cancellationSettingsEvidence.fields.cancellationDeadlineMinutes.value = 2880;
    const session = incidentSession(b, channel, '46700000001');
    if (postbooking) b.seedRecentCompletedBooking(session, row.language, {
      ok: true, bookingId: 'synthetic-booking', businessId: 3, serviceName: 'Video Consultation', startTime: '2030-09-15T14:00:00+02:00',
      customerName: 'Synthetic Customer', customerPhone: '46700000001', sourceChannel: channel }, 30);
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }),
      loadCancellationConfig: async () => { settingsReads++; return current; },
      cancellationInformationDiagnostic: event => outcomes.push(event),
      knowledgeSearch: (id, q, limit) => service.search(id, q, limit), semanticKnowledgeSearchQueries: async () => [],
      validateKnowledgeMatches: async (id, matches) => {
        if (coverageCalls && scenario === 'owner_changed_during_publication' && ++afterCoverageValidations === 2) {
          // First validation is the post-verifier guard check; the next is the
          // final send's publication check. Supersede while that check awaits.
          await b.securedRequest(session, async () => {}); superseded = true;
        }
        return service.validateMatches(id, matches);
      },
      calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
      geminiGenerate: async p => {
        if (p.config.systemInstruction.includes('retrieval query planner')) return { text: JSON.stringify({ canonicalMeaning: 'cancellation policy', queries: [sourceFacts.join(' ')] }) };
        if (scenario === 'postbooking_changed_settings') current = { ...raw, cancellation_deadline_minutes: 2880 };
        return { text: candidate };
      },
      assessBusinessSupportGrounding: async r => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
        claims: facts.filter(f => r.candidateReply.includes(f)).map(fact => ({ claim: fact, candidateQuote: fact, claimKind: unquantifiedFree ? 'NEGATIVE_ABSENCE' : 'OTHER', requiresBusinessEvidence: true, supported: true,
          evidence: [{ source: fact === row.free ? 'structured_business_config' : 'retrieved_knowledge',
            quote: fact === row.free ? '"freeCancellationDeadlineMinutes": 1440' : fact }] })) }),
      assessBusinessClaimEntailment: async r => {
        if (!r.cancellationCoverage) return { relation: 'ENTAILED', claimKind: r.claimKind, explicitAbsenceEvidence: true };
        coverageCalls++;
        assert.equal(r.customerMessage, question);
        if (scenario === 'coverage_unavailable') return null;
        if (scenario === 'revoked_during_coverage') await storage.delete(3, 'policy');
        if (scenario === 'changed_during_coverage') {
          const old = (await storage.list(3))[0]; await storage.create({ ...old, updatedAt: '2026-11-01', content: old.content + ' Changed policy.' });
        }
        if (scenario === 'settings_changed_during_coverage') current = { ...raw, cancellation_deadline_minutes: 2880 };
        return { relation: scenario === 'coverage_contradicted' ? 'CONTRADICTED' : scenario === 'partial' ? 'UNKNOWN' : 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false,
          coverage: scenario === 'coverage_malformed' ? [] : cancellationAspects.map(aspect => ({ aspect,
            status: unquantifiedFree || servicePrice || negatedFee ? aspect === 'fees_and_windows' ? 'covered' : 'not_requested'
              : scenario.endsWith('_only_complete') ? aspect === (scenario === 'free_only_complete' ? 'fees_and_windows' : 'advance_notice') ? 'covered' : 'not_requested'
              : scenario === 'all_not_requested' ? 'not_requested' : scenario === 'all_unresolved' ? 'unresolved'
              : scenario === 'partial' ? 'missing' : aspect === 'other_requested_details' && !compound && scenario !== 'compound_unknown' ? 'not_requested' : 'covered',
            quote: unquantifiedFree || servicePrice || negatedFee || partial || scenario.endsWith('_only_complete') || scenario === 'permission_omitted' ? candidate : scenario.endsWith('_conflict') ? r.candidateQuote
              : aspect === 'permission' ? row.permission : aspect === 'advance_notice' ? row.notice
              : aspect === 'fees_and_windows' ? r.candidateQuote : scenario === 'compound_omitted' ? row.free
              : scenario === 'compound_unknown' ? r.candidateQuote : compound ? entrance : '' })) } as any;
      },
    });
    await incidentInbound(b, channel, question);
    assert.equal(calendarCalls, 0);
    if (scenario === 'owner_changed_during_publication') {
      assert.equal(superseded, true); assert.equal(replies.length, 0); return;
    }
    assert.equal(replies.length, 1);
    const reply = replies[0];
    if (['revoked_during_coverage', 'changed_during_coverage', 'settings_changed_during_coverage'].includes(scenario) || postbooking) {
      for (const fact of facts) assert.ok(!reply.includes(fact), reply);
      assert.ok(settingsReads > 0);
      if (postbooking) {
        assert.equal(b.businessInformationState(session), null, 'Must exercise completed support, not the information-question branch');
        assert.equal(normalizeConversationText(b.recentCompletionState(session).support?.question), normalizeConversationText(question));
      }
    } else if (scenario === 'free_conflict' || scenario === 'fee_conflict') {
      assert.ok(reply.includes(cancellationInformationNotice(row.language, 'source_conflict')), reply);
      for (const fact of facts) assert.ok(!reply.includes(fact), reply);
    } else {
      for (const fact of facts) assert.ok(reply.includes(fact), reply);
      if (scenario === 'complete' || scenario === 'compound_complete' || scenario === 'free_absence_complete' || scenario.endsWith('_only_complete')) assert.equal(reply, candidate, 'A genuinely complete answer needs no warning');
      else assert.ok(reply.includes(cancellationInformationNotice(row.language,
        scenario.startsWith('coverage_') ? 'verifier_failed' : 'incomplete_scope')), reply);
    }
    if (!postbooking) assert.equal(coverageCalls, 1, 'No additional coverage provider calls');
    if (scenario === 'all_covered') assert.ok(outcomes.some(event => event.reason === 'incomplete_scope' &&
      event.coverage?.some((c: any) => c.aspect === 'advance_notice' && c.status === 'missing')), 'Diagnostics must record the bound decision, not the misleading model verdict');
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});
