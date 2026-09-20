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
const businessConfig = {
  id: '3', businessRecordId: '3', business_id: '3', businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom',
  services: [{ name: 'test', durationMinutes: 15 }],
};
const sessionId = 'wa_active_slot_route';
const arabic = 'الساعة 14:00 تناسبني. يرجى اختيار هذا الوقت.';
const arabicWithForeignWord = `${arabic} وبالمناسبة، قال لي أحدهم اليوم "hej".`;
const english = '14:00 works for me. Please choose that time.';

const pending = (language: 'ar' | 'en') => ({
  bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
  businessConfig, businessId: '3', platform: 'whatsapp', userId: sessionId, sessionId,
  operation: 'new_booking', status: 'awaiting_time_selection', expectedInput: 'slot_selection',
  service: 'test', serviceResolution: 'authoritative', language,
  selectedDate: '2026-09-22', durationMinutes: 15,
  normalizedBookingRequest: { intent: 'new_booking', language, sourceMode: 'text',
    requiresClarification: false, date: { kind: 'exact_date', value: '2026-09-22', confidence: 'high' } },
  offeredSlots: [`Tuesday at 14:00 (ISO: ${start})`],
  ownedOfferedSlots: [{ start, end, durationMinutes: 15, service: 'test', businessId: '3',
    platform: 'whatsapp', userId: sessionId, generatedAt: Date.now(),
    searchStartDate: '2026-09-22', searchEndDate: '2026-09-22' }],
  dateTime: null, selectedSlotEnd: null, createdAt: Date.now(), updatedAt: Date.now(),
});

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

const store = new PendingStore();
const configure = () => {
  boundary.reset();
  boundary.configure({
    supabaseClient: store as any,
    calendarAdapter: { getEvents: async () => [], checkSlots: async () => ({ available_slots_string: '' }) },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
};
const select = async (text: string) => boundary.turn({
  sessionId, platformName: 'whatsapp', recipientUserId: sessionId,
  text, businessConfig, now: new Date('2026-09-20T12:00:00+02:00'),
});

// The ordinary active booking state consumes an exact owned slot.
configure();
boundary.seedPending(sessionId, pending('ar'));
assert.equal((await boundary.whatsappPreDispatchDecisionAfterStateLoad(sessionId, arabic, businessConfig)).returnsAmbiguousClarification, false);
let result = await select(arabic);
assert.equal(result.handled, true);
assert.equal(result.pending?.status, 'awaiting_confirmation');
assert.equal(result.pending?.dateTime, start);
assert.equal(result.pending?.language, 'ar');

// Reproduce the production ordering: only durable state survives before the
// WhatsApp ambiguity gate runs. A quoted foreign word cannot reroute the turn.
configure();
await boundary.stateAuditPersist(sessionId, 'whatsapp', pending('ar'));
boundary.dropBookingSessionMemory(sessionId);
assert.equal(boundary.whatsappPreDispatchDecision(sessionId, arabicWithForeignWord).returnsAmbiguousClarification, true);
const restored = await boundary.whatsappPreDispatchDecisionAfterStateLoad(sessionId, arabicWithForeignWord, businessConfig);
assert.equal(restored.intent, 'ambiguous');
assert.equal(restored.returnsAmbiguousClarification, false);
assert.equal(restored.dispatchesUnifiedBooking, true);
result = await select(arabicWithForeignWord);
assert.equal(result.pending?.status, 'awaiting_confirmation');
assert.equal(result.pending?.dateTime, start);
assert.equal(result.pending?.language, 'ar');

// The same state precedence works in English.
configure();
boundary.seedPending(sessionId, pending('en'));
assert.equal((await boundary.whatsappPreDispatchDecisionAfterStateLoad(sessionId, english, businessConfig)).returnsAmbiguousClarification, false);
result = await select(english);
assert.equal(result.pending?.status, 'awaiting_confirmation');
assert.equal(result.pending?.dateTime, start);

// A clear request to cancel a previous booking remains an intentional pivot.
configure();
boundary.seedPending(sessionId, pending('en'));
const conflict = await boundary.whatsappPreDispatchDecisionAfterStateLoad(
  sessionId, 'I want to cancel my previous booking instead.', businessConfig,
);
assert.equal(conflict.intent, 'cancellation');
assert.equal(conflict.returnsAmbiguousClarification, false);
assert.equal(conflict.dispatchesUnifiedBooking, true);
result = await select('I want to cancel my previous booking instead.');
assert.notEqual(result.pending?.status, 'awaiting_confirmation');
assert.notEqual(result.pending?.dateTime, start);

console.log = originalLog;
console.error = originalError;
console.log('WhatsApp active slot routing regressions passed');
