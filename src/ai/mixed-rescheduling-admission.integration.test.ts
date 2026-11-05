/** SCRIPTED AI responses; actual native adapters, publication and action selector. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { detectNormalizedIntent, normalizeConversationText } from './booking-intelligence';
import { nativeKnowledgeTiming } from './knowledge-timing-policy';
import { incidentConfig, incidentFlags, incidentChannels, incidentInbound, incidentSession, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';
incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline',
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const rows = [
  { language: 'sv', action: 'Jag vill flytta min tid.', policy: 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?', ambiguous: 'Flytta?',
    reschedulingInformation: 'Hur fungerar ombokning?', contact: /mobilnummer|Numret är verifierat/u, unavailable: 'Jag kan inte verifiera policyn med den tillgängliga informationen.' },
  { language: 'es', action: 'Quiero reprogramar mi cita.', policy: '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?', ambiguous: '¿Reprogramar?',
    reschedulingInformation: '¿Cómo funciona la reprogramación de citas?', contact: /número/u, unavailable: 'No puedo verificar la política con la información disponible.' },
  { language: 'fa', action: 'لطفاً وقت من را تغییر دهید.', policy: 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟', ambiguous: 'تغییر وقت؟',
    reschedulingInformation: 'برای تغییر وقت چه شرایطی دارید؟', contact: /شماره/u, unavailable: 'با اطلاعات موجود نمی‌توانم سیاست را تأیید کنم.' },
  { language: 'ar', action: 'أريد تغيير موعدي.', policy: 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟', ambiguous: 'تغيير الموعد؟',
    reschedulingInformation: 'ما شروط تغيير الموعد؟', contact: /رقم/u, unavailable: 'لا أستطيع التحقق من السياسة بالمعلومات المتاحة.' },
];
const records: unknown[] = [];
after(() => { if (process.env.ODINLINK_MIXED_RESCHEDULING_RECORDS) writeFileSync(process.env.ODINLINK_MIXED_RESCHEDULING_RECORDS,
  JSON.stringify({ mode: 'SCRIPTED_ACTUAL_NATIVE_ADAPTERS', records }, null, 2), { flag: 'wx' }); });
for (const row of rows) for (const channel of incidentChannels)
for (const mode of ['information', 'rescheduling-information', 'explicit', 'mixed', 'ambiguous', 'missing-authorization', 'foreign', 'repeated', 'concurrent'] as const)
test(`native mixed rescheduling ${channel}/${row.language}/${mode}`, async t => {
  b.reset(); const saved = structuredClone(incidentConfig);
  const replies: string[] = [], timingReads: boolean[] = [], events: string[] = [];
  let mutations = 0, calendarReads = 0, knowledgeReads = 0;
  for (const name of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, name, (label: unknown) => { events.push(String(label)); });
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    replies.push(interceptedIncidentSend(input, options));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'offline', messages: [{ id: 'offline' }] }));
  });
  const forbidden = async () => { mutations++; throw Error('No appointment mutation authorized'); };
  try {
    Object.assign(incidentConfig, { id: 3, businessId: 3, businessRecordId: 3, business_id: 3, language: row.language,
      allowCancellation: true, cancellationFeeEnabled: false });
    b.configure({ offlineAi: true, semanticLanguageResolver: async () => ({ language: row.language, confidence: 1 }),
      postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      knowledgeSearch: async () => { knowledgeReads++; return []; }, semanticKnowledgeSearchQueries: async () => [], semanticKnowledgeSearch: async () => [],
      knowledgeCancellationConfig: async () => ({ id: 3, allow_cancellation: true, cancellation_fee_enabled: false }),
      aiGenerate: async () => ({ text: JSON.stringify({ oversized: false, units: [] }), functionCalls: [] }),
      geminiGenerate: async () => ({ text: row.unavailable }),
      assessBusinessSupportGrounding: async () => ({ hasBusinessFactualClaims: false, allBusinessClaimsSupported: true, claims: [] }),
      assessBusinessClaimEntailment: async () => null,
      calendarAdapter: { getCalendarId: () => 'offline', getEvents: async () => {
        calendarReads++; timingReads.push(!!nativeKnowledgeTiming()); return [];
      }, checkSlots: async () => { calendarReads++; timingReads.push(!!nativeKnowledgeTiming()); return []; },
      insertAppointment: forbidden, cancelAppointment: forbidden, updateAppointment: forbidden },
      recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
    });
    const session = incidentSession(b, channel, '46700000001');
    if (mode === 'foreign') b.seedOwnedAppointment({ sessionId: session, platform: channel, userId: '46700000001',
      businessConfig: { ...incidentConfig, id: 88, businessId: 88, businessRecordId: 88, business_id: 88 }, operation: 'reschedule',
      selectedNewStartTime: '2030-11-10T10:00:00Z', appointment: { id: 'FOREIGN-PRIVATE', business_id: 88, customerName: 'FOREIGN-CUSTOMER',
        service: 'FOREIGN-SERVICE', start: '2030-11-09T10:00:00Z', end: '2030-11-09T10:30:00Z', eventId: 'foreign-event' } });
    const mixed = `${row.action} ${row.policy}`;
    const text = mode === 'information' ? row.policy : mode === 'rescheduling-information' ? row.reschedulingInformation : mode === 'ambiguous' ? row.ambiguous
      : ['mixed', 'repeated', 'concurrent'].includes(mode) ? mixed : row.action;
    const admitted = b.inspectNativeKnowledgeAdmissionForTest(channel, text, incidentConfig);
    if (mode === 'concurrent') await Promise.all([incidentInbound(b, channel, text), incidentInbound(b, channel, text)]);
    else { await incidentInbound(b, channel, text); if (mode === 'repeated') await incidentInbound(b, channel, text); }
    const state = b.conversationState(session), info = b.businessInformationState(session), operation = b.appointmentOperationState(session);
    const calls = ['insertAppointment', 'cancelAppointment', 'rescheduleAppointment'].map(name => ({ id: name, function: { name, arguments: '{}' } }));
    const selected = b.documentToolDispatch(calls, session);
    records.push({ channel, language: row.language, mode, text, scalarIntent: detectNormalizedIntent(text), admitted, calendarReads, knowledgeReads,
      timingReads, mutations, selectedActionCalls: selected.length, replies, operation: operation.operation,
      informationQuestion: info?.question, flowLanguage: state.language, events });
    assert.equal(mutations, 0); assert.equal(selected.length, 0, 'No provider call gains action authority outside its request scope');
    // Rejecting a foreign owner can purge its conversation state entirely.
    // The response must still be in the current customer's language.
    if (mode === 'foreign') {
      assert.ok(state.language == null || state.language === row.language);
      const localized: Record<string, RegExp> = { sv: /mobilnummer/u, es: /español/u, fa: /شماره/u, ar: /العربية/u };
      assert.match(replies.join(' '), localized[row.language]);
    } else assert.equal(state.language, row.language);
    assert.ok(replies.length > 0); assert.ok(replies.every(reply => !reply.includes('FOREIGN-')));
    if (mode === 'information' || mode === 'rescheduling-information') { assert.equal(calendarReads, 0); assert.ok(info); }
    if (mode === 'mixed' || mode === 'repeated' || mode === 'concurrent') {
      assert.equal(admitted, false, 'Mixed rescheduling cannot enroll a read-only Knowledge turn');
      assert.ok(timingReads.every(value => !value), 'Appointment reads remain outside the Knowledge timing policy');
      assert.equal(info?.question, normalizeConversationText(row.policy), 'Keep the policy question with only existing conversation normalization');
      assert.match(replies[0], row.contact, 'Publish the existing localized appointment-identification prompt');
    }
    if (mode === 'explicit' || mode === 'missing-authorization') { assert.equal(admitted, false); assert.equal(operation.operation, 'reschedule'); }
  } finally {
    for (const key of Object.keys(incidentConfig)) delete (incidentConfig as any)[key];
    Object.assign(incidentConfig, saved); b.reset();
  }
});
