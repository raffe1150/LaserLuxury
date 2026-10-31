import assert from 'node:assert/strict';
import test from 'node:test';
import { detectNormalizedIntent, normalizeConversationText } from './booking-intelligence';
import { isBusinessInformationQuestion, isExplicitBusinessActionRequest } from './business-information';
import { prepareLiteralTurn } from './conversation-intent-continuity';
import { incidentFlags, incidentConfig, incidentInbound, incidentSession, interceptedIncidentSend } from '../../tests/helpers/p0-incident-knowledge';

incidentFlags();
Object.assign(process.env, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'synthetic-offline', ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const incident = 'What is your cancellation policy, and how far in advance do I need to cancel my appointment?';
const channels = ['whatsapp', 'instagram', 'messenger', 'telegram'] as const;
const config = { id: '3', businessId: '3', businessName: 'Synthetic Studio', language: 'en',
  timezone: 'Europe/Stockholm', allowCancellation: true, allowRescheduling: true,
  services: [{ id: 'video', name: 'Video Consultation', durationMinutes: 30 }] };

function fixture(t: any, language = 'en', unavailable = true) {
  b.reset();
  const reads: any[] = [], trace: any[][] = [];
  let mutations = 0, knowledgeReads = 0;
  for (const name of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, name, (...args: any[]) => { trace.push(args); });
  const forbidden = async () => { mutations++; throw Error('Unexpected operational side effect'); };
  // Run the real Google getEvents implementation; only its SDK transport is
  // replaced. Any accidental read meets the same OAuth failure as production.
  const adapter = b.googleCalendarForTest({ events: {
    list: async (args: any) => {
      reads.push(args);
      if (unavailable) throw Object.assign(Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
      return { data: { items: [] } };
    }, insert: forbidden, update: forbidden, delete: forbidden, get: forbidden,
  } }, 'synthetic');
  b.configure({ calendarAdapter: adapter,
    recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden,
    postProcess: async () => {}, incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    semanticLanguageResolver: async () => ({ language, confidence: 1 }),
    knowledgeSearch: () => { knowledgeReads++; return []; }, semanticKnowledgeSearch: () => [], semanticKnowledgeSearchQueries: async () => [],
    geminiGenerate: async () => ({ text: 'I cannot verify this policy from the available business information.' }),
    assessBusinessSupportGrounding: async () => null, assessBusinessClaimEntailment: async () => null });
  return { reads, trace, mutations: () => mutations, knowledgeReads: () => knowledgeReads };
}

for (const channel of channels) test(`${channel}: exact October 31 policy question never enters invalid_grant recovery`, async t => {
  const { reads, trace } = fixture(t);
  try {
    const result = await b.turn({ sessionId: `incident-${channel}`, platformName: channel, recipientUserId: 'synthetic-customer',
      text: incident, businessConfig: config, now: new Date('2026-10-31T10:00:00Z') });
    const evidence = JSON.stringify({ normalizedIntent: detectNormalizedIntent(incident), information: isBusinessInformationQuestion(incident),
      explicitAction: isExplicitBusinessActionRequest(incident), reads, result, trace });
    assert.equal(reads.length, 0, evidence);
    assert.equal(result.handled, false, evidence);
    assert.ok(b.businessInformationState(`incident-${channel}`), evidence);
  } finally { b.reset(); }
});

const matrix = [
  { language: 'en', information: incident, requirement: 'How much notice do I need to cancel my appointment?', action: 'Please cancel my appointment.', lookup: 'Do I already have an appointment?' },
  { language: 'sv', information: 'Vad är er avbokningspolicy, och hur långt i förväg måste jag avboka min tid?', requirement: 'Hur långt innan måste jag avboka min tid?', action: 'Jag vill avboka min tid.', lookup: 'Har jag en bokning?' },
  { language: 'de', information: 'Was ist Ihre Stornierungsrichtlinie und wie weit im Voraus muss ich meinen Termin stornieren?', requirement: 'Wie lange vorher muss ich meinen Termin stornieren?', action: 'Bitte stornieren Sie meinen Termin.', lookup: 'Habe ich einen Termin?' },
  { language: 'es', information: '¿Cuál es su política de cancelación y con cuánta antelación debo cancelar mi cita?', requirement: '¿Con cuánta antelación tengo que cancelar mi cita?', action: 'Quiero cancelar mi cita.', lookup: '¿Tengo una cita?' },
  { language: 'fa', information: 'سیاست لغو شما چیست و چند ساعت قبل باید نوبت را لغو کنم؟', requirement: 'چند ساعت قبل باید نوبت را لغو کنم؟', action: 'لطفاً نوبتم را لغو کنید.', lookup: 'آیا وقت دارم؟' },
  { language: 'ar', information: 'ما هي سياسة الإلغاء لديكم وكم ساعة قبل الموعد يجب إلغاء الحجز؟', requirement: 'كم ساعة قبل الموعد يجب إلغاء الحجز؟', action: 'أريد إلغاء موعدي.', lookup: 'هل لدي حجز قادم؟' },
];
const conjunctions: Record<string, string> = { en: 'and', sv: 'och', de: 'und', es: 'y', fa: 'و', ar: 'و' };
const compoundAction = (row: typeof matrix[number]) => `${row.information.replace(/[?؟]$/u, '')}, ${conjunctions[row.language]} ${row.action}`;

for (const row of matrix) {
  test(`${row.language}: compound information and independent cancellation clauses keep distinct authority`, () => {
    for (const text of [row.information, row.requirement]) {
      assert.equal(isBusinessInformationQuestion(text), true, text);
      assert.equal(isExplicitBusinessActionRequest(text), false, text);
      assert.equal(detectNormalizedIntent(text), 'general_question', text);
      assert.equal(prepareLiteralTurn(text).kind, 'single', text);
    }
    assert.equal(isExplicitBusinessActionRequest(row.action), true);
    assert.equal(isBusinessInformationQuestion(row.action), false);
    for (const text of [`${row.information} ${row.action}`, `${row.action} ${row.information}`, compoundAction(row)]) {
      const prepared = prepareLiteralTurn(text);
      assert.equal(prepared.kind, 'mixed', text);
      assert.equal(prepared.clauses.filter(c => c.kind === 'action').length, 1);
    }
  });

  for (const channel of channels) {
    test(`${channel}/${row.language}: policy detour preserves cancellation consent and pending booking state`, async t => {
      const f = fixture(t, row.language);
      const id = `detour-${channel}-${row.language}`;
      const scoped = { ...config, language: row.language };
      b.seedPending(id, { bookingStateVersion: 3, businessId: '3', platform: channel, userId: id,
        businessConfig: scoped, operation: 'new_booking', status: 'awaiting_contact', language: row.language,
        service: 'Video Consultation', serviceId: 'video', durationMinutes: 30, dateTime: '2026-11-05T10:00:00Z',
        selectedDate: '2026-11-05', selectedSlotEnd: '2026-11-05T10:30:00Z', customerName: 'Synthetic Customer', customerPhone: '0701234567',
        ownedOfferedSlots: [{ businessId: '3', platform: channel, userId: id, start: '2026-11-05T10:00:00Z',
          end: '2026-11-05T10:30:00Z', durationMinutes: 30, service: 'Video Consultation', serviceId: 'video', generatedAt: Date.now() }] });
      b.seedOwnedAppointment({ sessionId: id, platform: channel, userId: id, businessConfig: scoped,
        operation: 'cancellation', appointment: { id: 'synthetic-owned', business_id: 3, service: 'Video Consultation',
          start_time: '2026-11-05T10:00:00Z', end_time: '2026-11-05T10:30:00Z' } });
      const pending = b.pendingStateSnapshot(id), consent = b.cancellationState(id);
      try {
        for (const text of [row.information, row.requirement]) {
          const result = await b.turn({ sessionId: id, platformName: channel, recipientUserId: id, businessConfig: scoped, text });
          assert.equal(result.handled, false, result.replies.join(' '));
          assert.equal(b.businessInformationState(id)?.question, normalizeConversationText(text));
          for (const key of ['status', 'service', 'dateTime', 'selectedSlotEnd', 'customerName', 'customerPhone']) assert.deepEqual(result.pending[key], pending[key], key);
          // Reply language may follow the current question; operation authority
          // and consent must stay intact.
          assert.deepEqual({ ...b.cancellationState(id), language: consent.language }, consent, 'information must not consume or grant cancellation consent');
        }
        assert.equal(f.reads.length, 0); assert.equal(f.mutations(), 0);
        assert.equal(f.trace.some(([label]) => label === '[UnifiedBookingFailure]'), false);
      } finally { b.reset(); }
    });

    for (const kind of ['information', 'requirement', 'action', 'mixed', 'mixed_action_first', 'compound_action', 'lookup'] as const)
      test(`native ${channel}/${row.language}/${kind}: invalid_grant respects current-turn authority`, async t => {
        const f = fixture(t, row.language);
        const saved = { ...incidentConfig }, replies: string[] = [];
        t.mock.method(globalThis, 'fetch', async (input, options) => {
          replies.push(interceptedIncidentSend(input, options));
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, message_id: 'synthetic', messages: [{ id: 'synthetic' }] }));
        });
        try {
          Object.assign(incidentConfig, { id: 3, businessId: 3, language: row.language, allowCancellation: true, allowRescheduling: true });
          const text = kind === 'mixed' ? `${row.information} ${row.action}` : kind === 'mixed_action_first' ? `${row.action} ${row.information}` : kind === 'compound_action' ? compoundAction(row) : row[kind];
          await incidentInbound(b, channel, text);
          const id = incidentSession(b, channel, '46700000001');
          assert.equal(f.mutations(), 0, 'No mutation or success without provider verification');
          assert.ok(replies.length > 0, 'Actual adapter must deliver an intercepted response');
          if (kind === 'information' || kind === 'requirement') {
            assert.equal(f.reads.length, 0, JSON.stringify(f.trace));
            assert.ok(b.businessInformationState(id), 'Actual adapter reaches shared information path');
            assert.equal(f.trace.some(([label]) => label === '[UnifiedBookingFailure]' || label === '[BookingRecoveryState]'), false);
            assert.doesNotMatch(replies.join(' '), /kept your booking|reach the calendar|calendar_unavailable/iu);
            assert.deepEqual(b.geminiToolNames(id).filter(name => name !== 'logSystemAnalysis'), [], 'Information grants no appointment tools');
          } else if (kind === 'lookup') {
            // Some adapters collect identity before attempting a lookup.
            assert.equal(f.knowledgeReads(), 0, 'Real appointment lookup must stay outside business information');
            assert.equal(b.businessInformationState(id), null);
            if (f.reads.length) assert.ok(f.trace.some(([label]) => label === 'Google Calendar getEvents Error:'));
          } else {
            assert.ok(f.reads.length > 0, 'A genuine operation still reads Calendar and fails closed');
            assert.ok(f.trace.some(([label]) => label === 'Google Calendar getEvents Error:'));
            if (kind === 'mixed' || kind === 'mixed_action_first' || kind === 'compound_action') assert.ok(b.businessInformationState(id), 'Mixed request also preserves the policy question');
          }
        } finally { Object.assign(incidentConfig, saved); delete (incidentConfig as any).allowCancellation; delete (incidentConfig as any).allowRescheduling; b.reset(); }
      });

    test(`${channel}/${row.language}: real cancellation with a healthy Calendar still requests identity`, async t => {
      const f = fixture(t, row.language, false), id = `action-${channel}-${row.language}`;
      try {
        const result = await b.turn({ sessionId: id, platformName: channel, recipientUserId: id, text: row.action,
          businessConfig: { ...config, language: row.language } });
        assert.equal(result.handled, true);
        assert.equal(result.operation.operation, 'cancellation');
        assert.equal(result.appointment, null, 'No appointment selected without identity verification');
        assert.ok(f.reads.length > 0); assert.equal(f.mutations(), 0);
      } finally { b.reset(); }
    });
  }
}
