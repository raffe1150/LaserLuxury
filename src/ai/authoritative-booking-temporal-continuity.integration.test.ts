import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const start = '2026-09-22T14:00:00+02:00';
const end = '2026-09-22T14:15:00+02:00';
const now = new Date('2026-09-20T12:00:00+02:00');
const businessConfig = {
  id: '3', businessRecordId: '3', business_id: '3', businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom',
  services: [{ name: 'test', durationMinutes: 15 }],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map(day => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};

class PendingStore {
  row: { user_id: string; ai_summary: string } | null = null;
  from(table: string) {
    assert.equal(table, 'appointments_leads');
    return {
      select: (_columns: string) => ({ eq: (_key: string, _value: string) => ({
        maybeSingle: async () => ({ data: this.row, error: null }),
      }) }),
      update: (value: { ai_summary: string }) => ({ eq: async () => {
        if (this.row) this.row.ai_summary = value.ai_summary;
        return { error: null };
      } }),
      insert: async (values: Array<{ user_id: string; ai_summary: string }>) => {
        this.row = { user_id: values[0].user_id, ai_summary: values[0].ai_summary };
        return { error: null };
      },
    };
  }
}

function seed(sessionId: string, language: 'ar' | 'en', status: 'awaiting_confirmation' | 'awaiting_contact') {
  boundary.reset();
  boundary.configure({
    supabaseClient: new PendingStore() as any,
    calendarAdapter: { getEvents: async () => [], checkSlots: async () => ({ available_slots_string: '' }) },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  const pending = {
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessConfig, businessId: '3', platform: 'whatsapp', userId: sessionId, sessionId,
    operation: 'new_booking', status, expectedInput: status === 'awaiting_confirmation' ? 'confirmation' : 'contact',
    service: 'test', serviceResolution: 'authoritative', language,
    selectedDate: '2026-09-22', durationMinutes: 15,
    normalizedBookingRequest: {
      intent: 'new_booking', language, sourceMode: 'text', requiresClarification: false,
      date: { kind: 'exact_date', value: '2026-09-22', confidence: 'high' },
      timeConstraint: { kind: 'exact', startMinutes: 840, confidence: 'high' },
    },
    ownedOfferedSlots: [{ start, end, durationMinutes: 15, service: 'test', businessId: '3',
      platform: 'whatsapp', userId: sessionId, generatedAt: Date.now(),
      searchStartDate: '2026-09-22', searchEndDate: '2026-09-22' }],
    offeredSlots: [], dateTime: start, selectedSlotEnd: end,
    customerName: null, customerPhone: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  boundary.seedPending(sessionId, pending);
  return pending;
}

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId, platformName: 'whatsapp', recipientUserId: sessionId,
  text, businessConfig, now,
});
const unchanged = (result: Awaited<ReturnType<typeof turn>>) => {
  assert.equal(result.handled, true);
  assert.equal(result.pending?.selectedDate, '2026-09-22');
  assert.equal(new Date(result.pending?.dateTime).getTime(), new Date(start).getTime());
  assert.equal(new Date(result.pending?.selectedSlotEnd).getTime(), new Date(end).getTime());
  assert.equal(result.pending?.ownedOfferedSlots?.length, 1);
  assert.doesNotMatch(result.replies.join(' '), /مغلقون|closed|available slots|المواعيد المتاحة/iu);
};

seed('wa_ar-name', 'ar', 'awaiting_contact');
const arabicName = await turn('wa_ar-name', 'اسمي لينا اختبار. وبالمناسبة، قال لي أحدهم اليوم "hej".');
unchanged(arabicName);
assert.equal(arabicName.pending?.status, 'awaiting_contact');
assert.ok(arabicName.pending?.customerName, 'the Arabic name is captured');
assert.equal(arabicName.pending?.language, 'ar');

const durablePending = seed('wa_ar-restored-name', 'ar', 'awaiting_contact');
await boundary.stateAuditPersist('wa_ar-restored-name', 'whatsapp', durablePending);
boundary.dropBookingSessionMemory('wa_ar-restored-name');
const restoredName = await turn('wa_ar-restored-name', 'اسمي لينا اختبار. وبالمناسبة، قال لي أحدهم اليوم "hej".');
unchanged(restoredName);
assert.ok(restoredName.pending?.customerName);

seed('wa_en-name', 'en', 'awaiting_contact');
const englishName = await turn('wa_en-name', 'My name is Lina Test. Someone said "hej" to me today.');
unchanged(englishName);
assert.ok(englishName.pending?.customerName, 'the English name is captured');

seed('wa_en-phone', 'en', 'awaiting_contact');
const phone = await turn('wa_en-phone', 'My phone is 0701234567. I worked yesterday.');
unchanged(phone);
assert.match(phone.pending?.customerPhone || '', /701234567/);

seed('wa_en-confirm', 'en', 'awaiting_confirmation');
const confirmation = await turn('wa_en-confirm', 'Yes, book it. Tomorrow I have another meeting.');
unchanged(confirmation);
assert.equal(confirmation.pending?.status, 'awaiting_contact');

seed('wa_en-date-correction', 'en', 'awaiting_contact');
const dateCorrection = await turn('wa_en-date-correction', 'Actually, change the booking to tomorrow.');
assert.equal(dateCorrection.pending?.selectedDate, '2026-09-21');
assert.equal(dateCorrection.pending?.status, 'awaiting_time_selection');
assert.equal(dateCorrection.pending?.dateTime, null);

seed('wa_en-time-correction', 'en', 'awaiting_contact');
const timeCorrection = await turn('wa_en-time-correction', 'I meant 15:00, not 14:00.');
assert.equal(timeCorrection.pending?.status, 'awaiting_time_selection');
assert.equal(timeCorrection.pending?.selectedDate, '2026-09-22');
assert.equal(timeCorrection.pending?.dateTime, null);

seed('wa_en-cancel', 'en', 'awaiting_contact');
const cancellation = await turn('wa_en-cancel', 'I want to cancel my previous booking instead.');
assert.ok(cancellation.handled || cancellation.operation?.operation === 'cancellation',
  'an explicit conflicting cancellation remains eligible for existing operation routing');

console.log = originalLog;
console.error = originalError;
console.log('Authoritative booking temporal continuity regressions passed');
