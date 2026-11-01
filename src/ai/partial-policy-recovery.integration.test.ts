import assert from 'node:assert/strict';
import test from 'node:test';
import { Responses } from 'openai/resources/responses';
import { cancellationAspects, cancellationInformationNotice } from './cancellation-information';
import { incidentFlags, incidentConfig, incidentInbound, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const rows = [
  { language: 'en', question: 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?',
    chat: 'You can cancel automatically through chat.', fee: 'There is no late cancellation fee.', bad: 'No advance cancellation notice is required.',
    extra: 'Where is the customer entrance?', entrance: 'The customer entrance is on Birch Street.', and: ', and ' },
  { language: 'sv', question: 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?',
    chat: 'Du kan avboka automatiskt via chatten.', fee: 'Det finns ingen sen avbokningsavgift.', bad: 'Ingen framförhållning krävs vid avbokning.',
    extra: 'Var ligger kundentrén?', entrance: 'Kundentrén ligger på Björkgatan.', and: ', och ' },
  { language: 'de', question: 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?',
    chat: 'Sie können automatisch über den Chat stornieren.', fee: 'Es gibt keine Gebühr für eine späte Stornierung.', bad: 'Für die Stornierung ist keine Vorankündigung erforderlich.',
    extra: 'Wo ist der Kundeneingang?', entrance: 'Der Kundeneingang befindet sich in der Birkenstraße.', and: ', und ' },
  { language: 'es', question: '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?',
    chat: 'Puedes cancelar automáticamente por el chat.', fee: 'No hay cargo por cancelación tardía.', bad: 'No se requiere aviso previo para cancelar.',
    extra: '¿Dónde está la entrada de clientes?', entrance: 'La entrada de clientes está en la calle Abedul.', and: ', y ' },
  { language: 'fa', question: 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟',
    chat: 'می‌توانید نوبت را به صورت خودکار از طریق چت لغو کنید.', fee: 'هزینه لغو دیرهنگام وجود ندارد.', bad: 'برای لغو نوبت نیازی به اطلاع قبلی نیست.',
    extra: 'ورودی مشتریان کجاست؟', entrance: 'ورودی مشتریان در خیابان توس است.', and: '، و ' },
  { language: 'ar', question: 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟',
    chat: 'يمكنك إلغاء الموعد تلقائياً عبر الدردشة.', fee: 'لا توجد رسوم إلغاء متأخر.', bad: 'لا يلزم إشعار مسبق لإلغاء الموعد.',
    extra: 'أين مدخل العملاء؟', entrance: 'مدخل العملاء في شارع البتولا.', and: '، و ' },
];
const channels = ['whatsapp', 'instagram', 'messenger', 'telegram'] as const;
const scenarios = ['incident', 'complete', 'qualified_fact', 'shared_verified_sentence', 'shared_rejected_sentence', 'repair_rejected', 'negative_only',
  'missing_absence', 'mixed_topic', 'malformed_extraction', 'malformed_entailment', 'revoked', 'settings_changed',
  'coverage_revoked', 'coverage_malformed', 'invented_notice', 'numerical_overclaim', 'fragment', 'qualified_fragment'] as const;
for (const fixture of rows) for (const channel of channels) for (const scenario of scenarios)
test(`partial recovery/${channel}/${fixture.language}/${scenario}`, async t => {
  const qualifiedChat = ({ en: 'You can cancel through chat only after staff approval.', sv: 'Du kan avboka via chatten endast efter personalens godkännande.',
    de: 'Sie können nur nach Genehmigung des Personals über den Chat stornieren.', es: 'Puedes cancelar por el chat solo con la aprobación del personal.',
    fa: 'لغو نوبت از طریق چت فقط پس از تأیید کارکنان مجاز است.', ar: 'يمكنك إلغاء الموعد عبر الدردشة فقط بعد موافقة الموظفين.' } as Record<string, string>)[fixture.language];
  const row = scenario === 'qualified_fact' ? { ...fixture, chat: qualifiedChat } : fixture;
  b.reset();
  const saved = structuredClone(incidentConfig), replies: string[] = [], verdicts: any[] = [];
  let repairs = 0, calendarCalls = 0, current = true, changed = false;
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  // Same settings shape as the incident, on an unrelated synthetic tenant.
  const raw = { id: 77, language: row.language, allow_cancellation: true, cancellation_fee_enabled: false,
    cancellation_deadline_minutes: 1440, cancellation_fee_amount: 250, cancellation_fee_currency: 'SEK' };
  const config = b.promptAuditNormalize(raw);
  const mixed = scenario === 'mixed_topic';
  const completeFee = ({ en: 'Cancellation is free.', sv: 'Avbokning är avgiftsfri.', de: 'Stornierung ist kostenlos.',
    es: 'La cancelación es gratuita.', fa: 'لغو رایگان است.', ar: 'الإلغاء مجاني.' } as Record<string, string>)[row.language];
  const completeQuestion = ({ en: 'Is cancellation free?', sv: 'Är avbokning avgiftsfri?', de: 'Ist die Stornierung kostenlos?',
    es: '¿La cancelación es gratuita?', fa: 'آیا لغو رایگان است؟', ar: 'هل الإلغاء مجاني؟' } as Record<string, string>)[row.language];
  const question = scenario === 'complete' ? completeQuestion : row.question + (mixed ? ` ${row.extra}` : '');
  const notice = ({ en: 'You must cancel at least 24 hours before your appointment.', sv: 'Du måste avboka minst 24 timmar före besöket.',
    de: 'Sie müssen mindestens 24 Stunden vor dem Termin stornieren.', es: 'Debes cancelar al menos 24 horas antes de la cita.',
    fa: 'لغو نوبت باید حداقل ۲۴ ساعت قبل انجام شود.', ar: 'يجب إلغاء الموعد قبل 24 ساعة على الأقل.' } as Record<string, string>)[row.language];
  const bad = ['invented_notice', 'numerical_overclaim'].includes(scenario) ? notice : row.bad;
  const joined = row.chat.slice(0, -1) + row.and + (scenario === 'shared_verified_sentence' ? row.fee : bad);
  const fragment = scenario === 'qualified_fragment' ? `Only if separately approved: ${row.chat}` : `Not true: ${row.chat}`;
  const candidate = scenario === 'complete' ? completeFee : ['shared_rejected_sentence', 'repair_rejected'].includes(scenario) ? `${joined} ${row.fee}`
    : scenario === 'shared_verified_sentence' ? `${joined} ${bad}`
    : ['fragment', 'qualified_fragment'].includes(scenario) ? `${fragment} ${bad}`
    : scenario === 'negative_only' ? `${row.fee} ${bad}` : `${row.chat} ${bad} ${row.fee}${mixed ? ` ${row.entrance}` : ''}`;
  const corpus = scenario === 'qualified_fact' ? qualifiedChat : mixed ? row.entrance : 'This fictional source describes the studio entrance and contains no cancellation terms.';
  const claim = (text: string, quote = text) => ({ claim: text, candidateQuote: quote, requiresBusinessEvidence: true,
    claimKind: text === row.fee || text === completeFee || text === bad && scenario !== 'numerical_overclaim' ? 'NEGATIVE_ABSENCE' : 'OTHER',
    supported: text !== bad || scenario === 'numerical_overclaim',
    evidence: text === bad && scenario !== 'numerical_overclaim' ? [] : [{ source: text === row.entrance || text === qualifiedChat ? 'retrieved_knowledge' : 'structured_business_config',
      quote: text === row.entrance || text === qualifiedChat ? corpus : text === row.fee || text === completeFee ? '"lateFeeEnabled": false' : '"automaticCancellationEnabled": true' }] });
  const forbidden = async () => { calendarCalls++; assert.fail('Information-only turn reached Calendar or a booking write'); };
  try {
    Object.assign(incidentConfig, { language: row.language, services: [], systemPrompt: '',
      allowCancellation: config.allowCancellation, cancellationFeeEnabled: config.cancellationFeeEnabled,
      cancellationDeadlineMinutes: config.cancellationDeadlineMinutes, cancellationFeeAmount: config.cancellationFeeAmount,
      cancellationFeeCurrency: config.cancellationFeeCurrency, cancellationSettingsEvidence: config.cancellationSettingsEvidence });
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }),
      loadCancellationConfig: async () => changed ? { ...raw, allow_cancellation: false } : raw,
      knowledgeSearch: async id => [{ businessId: id, sourceId: 'synthetic-policy', text: corpus, score: 1, metadata: { source: 'document' } }],
      semanticKnowledgeSearchQueries: async () => [], validateKnowledgeMatches: async (_id, matches) => current ? matches : [],
      calendarAdapter: { getCalendarId: () => 'synthetic', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
      geminiGenerate: async p => {
        if (p.config.systemInstruction.includes('retrieval query planner')) return { text: JSON.stringify({ canonicalMeaning: question, queries: [corpus] }) };
        if (p.config.systemInstruction.includes('COMPLETENESS REPAIR')) {
          repairs++;
          return { text: ['repair_rejected', 'fragment', 'qualified_fragment'].includes(scenario) ? bad : `${row.chat} ${row.fee}` };
        }
        return { text: candidate };
      },
      assessBusinessSupportGrounding: async r => {
        assert.equal(String(r.businessId), '77');
        if (scenario === 'malformed_extraction') return null;
        if (r.candidateReply !== candidate) {
          const rejectedRepair = ['repair_rejected', 'fragment', 'qualified_fragment'].includes(scenario);
          return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: !rejectedRepair,
            claims: rejectedRepair ? [claim(bad)] : [claim(row.chat), claim(row.fee)] } as any;
        }
        const facts = scenario === 'complete' ? [claim(completeFee)] : scenario === 'negative_only' ? [claim(row.fee), claim(bad)]
          : ['fragment', 'qualified_fragment'].includes(scenario) ? [claim(row.chat), claim(bad)]
          : [claim(row.chat, ['shared_verified_sentence', 'shared_rejected_sentence', 'repair_rejected'].includes(scenario) ? row.chat.slice(0, -1) : row.chat), claim(bad),
            claim(row.fee)];
        if (mixed) facts.push(claim(row.entrance));
        return { hasBusinessFactualClaims: true, allBusinessClaimsSupported: ['complete', 'numerical_overclaim'].includes(scenario), claims: facts } as any;
      },
      assessBusinessClaimEntailment: async r => {
        verdicts.push(r);
        if (r.cancellationCoverage) {
          if (scenario === 'coverage_revoked') current = false;
          return { relation: scenario === 'complete' ? 'ENTAILED' : 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false,
            coverage: scenario === 'coverage_malformed' ? [] : cancellationAspects.map(aspect => ({ aspect,
              status: scenario === 'complete' ? aspect === 'fees_and_windows' ? 'covered' : 'not_requested'
                : aspect === 'other_requested_details' && !mixed ? 'not_requested' : 'missing', quote: scenario === 'complete' ? completeFee : '' })) };
        }
        if (scenario === 'revoked') current = false;
        if (scenario === 'settings_changed') changed = true;
        if (scenario === 'malformed_entailment') return null;
        return { relation: r.atomicClaim === bad ? 'UNKNOWN' : 'ENTAILED', claimKind: r.claimKind,
          explicitAbsenceEvidence: scenario !== 'missing_absence' };
      },
    });
    await incidentInbound(b, channel, question);
    assert.equal(calendarCalls, 0); assert.equal(replies.length, 1); assert.ok(repairs <= 1, 'Repair must remain bounded');
    const reply = replies[0];
    const invalid = ['revoked', 'settings_changed', 'coverage_revoked'].includes(scenario);
    const unavailable = ['malformed_extraction', 'malformed_entailment'].includes(scenario);
    if (scenario === 'complete') {
      assert.equal(reply, completeFee, 'A complete answer must not gain uncertainty or a repair'); assert.equal(repairs, 0);
    } else if (invalid || unavailable) {
      assert.equal(reply.includes(row.chat), false, reply); assert.equal(reply.includes(row.fee), false, reply);
    } else if (['fragment', 'qualified_fragment'].includes(scenario)) {
      assert.equal(reply.includes(row.chat), false, 'A fragment cannot authorize dropping a negation or qualifier');
    } else {
      if (scenario !== 'negative_only' && scenario !== 'repair_rejected') assert.ok(reply.includes(row.chat) || reply.includes(row.chat.slice(0, -1)), reply);
      if (scenario !== 'missing_absence') assert.ok(reply.includes(row.fee), reply);
      else assert.equal(reply.includes(row.fee), false, reply);
      if (mixed) assert.ok(reply.includes(row.entrance), reply);
      assert.ok(reply.includes(cancellationInformationNotice(row.language, scenario === 'coverage_malformed' ? 'verifier_failed' : 'incomplete_scope')), reply);
      assert.equal(reply.includes(cancellationInformationNotice(row.language, 'unsupported_claims')), false, reply);
    }
    assert.equal(reply.includes(bad), false, reply);
    assert.doesNotMatch(reply, /24|۲۴|٢٤/u, 'The stored free-fee boundary is not mandatory notice');
    if (scenario === 'numerical_overclaim') assert.equal(verdicts.some(r => r.atomicClaim === bad), false, 'Numerical authority must reject the overclaim before model entailment');
    if (scenario === 'shared_rejected_sentence') assert.equal(repairs, 1);
    if (['incident', 'negative_only', 'shared_verified_sentence', 'mixed_topic'].includes(scenario)) assert.equal(repairs, 0);
    assert.ok(verdicts.every(r => String(r.businessId) === '77'));
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});

const otherPolicies = [
  ['en', 'Which payment methods are accepted, and which documents should I bring?', 'Card payments are accepted.', 'No identity document is required.', 'A passport is always required.'],
  ['sv', 'Vilka betalningsvillkor gäller, och vilka dokument ska jag ta med?', 'Kortbetalning accepteras.', 'Ingen identitetshandling krävs.', 'Pass krävs alltid.'],
  ['de', 'Welche Zahlungsmethoden sind erlaubt und welche Dokumente muss ich mitbringen?', 'Kartenzahlungen werden akzeptiert.', 'Ein Ausweisdokument ist nicht erforderlich.', 'Ein Reisepass ist immer erforderlich.'],
  ['es', '¿Qué métodos de pago se aceptan y qué documentos debo llevar?', 'Se aceptan pagos con tarjeta.', 'No se requiere documento de identidad.', 'Siempre se requiere un pasaporte.'],
  ['fa', 'شرایط پرداخت چیست و چه مدارکی باید همراه داشته باشم؟', 'پرداخت با کارت پذیرفته می‌شود.', 'مدرک شناسایی لازم نیست.', 'همیشه گذرنامه لازم است.'],
  ['ar', 'ما شروط الدفع وما المستندات التي يجب إحضارها؟', 'يُقبل الدفع بالبطاقة.', 'لا يلزم مستند هوية.', 'يلزم جواز سفر دائماً.'],
] as const;
for (const [language, question, positive, negative, unsupported] of otherPolicies) for (const channel of channels)
for (const complete of [false, true]) test(`other policies/${channel}/${language}/${complete ? 'complete' : 'partial'}`, async t => {
  b.reset(); const saved = structuredClone(incidentConfig), replies: string[] = [];
  const flag = process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = 'false';
  const candidate = `${positive} ${negative}${complete ? '' : ` ${unsupported}`}`;
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
  });
  const forbidden = async () => assert.fail('Information-only question reached Calendar');
  try {
    Object.assign(incidentConfig, { language, systemPrompt: '', services: [] });
    b.configure({ postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      semanticLanguageResolver: async () => ({ language, confidence: 1 }),
      knowledgeSearch: async id => [{ businessId: id, sourceId: 'other-policy', text: `${positive} ${negative}`, score: 1, metadata: { source: 'document' } }],
      semanticKnowledgeSearchQueries: async () => [], validateKnowledgeMatches: async (_id, matches) => matches,
      calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden, cancelAppointment: forbidden }, recordAppointment: forbidden,
      geminiGenerate: async p => p.config.systemInstruction.includes('retrieval query planner') ? { text: JSON.stringify({ canonicalMeaning: question, queries: [positive] }) } : { text: candidate },
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: complete,
        claims: [positive, negative, ...(complete ? [] : [unsupported])].map(text => ({ claim: text, candidateQuote: text,
          claimKind: text === negative ? 'NEGATIVE_ABSENCE' : 'OTHER', requiresBusinessEvidence: true, supported: text !== unsupported,
          evidence: text === unsupported ? [] : [{ source: 'retrieved_knowledge', quote: text }] })) }),
      assessBusinessClaimEntailment: async r => ({ relation: 'ENTAILED', claimKind: r.claimKind, explicitAbsenceEvidence: true }),
    });
    await incidentInbound(b, channel, question);
    assert.equal(replies.length, 1); assert.ok(replies[0].includes(positive), replies[0]); assert.ok(replies[0].includes(negative), replies[0]);
    assert.equal(replies[0].includes(unsupported), false);
    if (complete) assert.equal(replies[0], candidate, 'Fully verified answers must stay unchanged');
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key]; Object.assign(incidentConfig, saved);
    if (flag === undefined) delete process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE; else process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE = flag;
    b.reset();
  }
});

test('OpenAI SDK parsing: verified positive and explicit negative survive an unsupported sibling', async t => {
  b.reset();
  const previous = { AI_PROVIDER: process.env.AI_PROVIDER, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-offline' });
  const row = rows[0], stages: string[] = [];
  const candidate = `${row.chat} ${row.bad} ${row.fee}`;
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  t.mock.method(Responses.prototype, 'create', async (request: any) => {
    const body = JSON.parse(request.input[0].content), instruction = request.instructions;
    let result: unknown;
    if (instruction.includes('coverage verifier')) {
      stages.push('coverage');
      assert.ok(body.exactCandidateQuote.includes(row.chat)); assert.ok(body.exactCandidateQuote.includes(row.fee));
      assert.equal(body.exactCandidateQuote.includes(row.bad), false);
      result = { relation: 'UNKNOWN', claimKind: 'OTHER', explicitAbsenceEvidence: false,
        coverage: cancellationAspects.map(aspect => ({ aspect, status: aspect === 'other_requested_details' ? 'not_requested' : 'missing', quote: '' })) };
    } else if (instruction.includes('claim and citation extractor')) {
      stages.push('extraction');
      result = { hasBusinessFactualClaims: true, allBusinessClaimsSupported: false,
        claims: [row.chat, row.bad, row.fee].map(text => ({ claim: text, candidateQuote: text, requiresBusinessEvidence: true,
          claimKind: text === row.chat ? 'OTHER' : 'NEGATIVE_ABSENCE', supported: text !== row.bad,
          evidence: text === row.bad ? [] : [{ source: 'structured_business_config', quote: text === row.chat ? '"automaticCancellationEnabled": true' : '"lateFeeEnabled": false' }] })) };
    } else {
      stages.push('entailment');
      result = { relation: 'ENTAILED', claimKind: body.atomicClaim === row.fee ? 'NEGATIVE_ABSENCE' : 'OTHER', explicitAbsenceEvidence: true };
    }
    return { output_text: JSON.stringify(result), output: [] } as any;
  });
  try {
    const raw = { id: 77, allow_cancellation: true, cancellation_fee_enabled: false, cancellation_deadline_minutes: 1440 };
    b.configure({ loadCancellationConfig: async () => raw });
    b.businessInformationState('sdk-partial', raw, row.question, 'en', '');
    const reply = await b.businessSupportGrounding('sdk-partial', row.question, candidate, 'en');
    assert.ok(reply.includes(row.chat), reply); assert.ok(reply.includes(row.fee), reply); assert.equal(reply.includes(row.bad), false);
    assert.equal(stages[0], 'extraction'); assert.equal(stages.at(-1), 'coverage'); assert.equal(stages.filter(s => s === 'entailment').length, 4);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    b.reset();
  }
});

test('OpenAI SDK parsing: malformed extraction cannot authorize a partial factual answer', async t => {
  b.reset();
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'openai';
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-offline';
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, () => {});
  t.mock.method(Responses.prototype, 'create', async () => ({ output_text: '{"claims":"malformed"}', output: [] }) as any);
  try {
    const raw = { id: 77, allow_cancellation: true, cancellation_fee_enabled: false };
    b.configure({ loadCancellationConfig: async () => raw });
    b.businessInformationState('malformed-partial', raw, rows[0].question, 'en', '');
    const reply = await b.businessSupportGrounding('malformed-partial', rows[0].question, `${rows[0].chat} ${rows[0].fee}`, 'en');
    assert.equal(reply.includes(rows[0].chat), false); assert.equal(reply.includes(rows[0].fee), false);
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previous;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    b.reset();
  }
});
