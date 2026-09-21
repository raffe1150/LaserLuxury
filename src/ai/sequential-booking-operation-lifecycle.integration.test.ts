import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const sessionId = 'sequential-instagram-ar';
const now = new Date('2026-09-21T12:00:00+02:00');
const config = {
  id: '3', businessRecordId: '3', business_id: '3', businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-3',
  services: [{ name: 'test', durationMinutes: 15 }],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map(day => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};
const events = new Map<string, any>();
const bookings: Array<{ id: number; start_time: string }> = [];
const claims = new Map<string, any>();
boundary.reset();
boundary.configure({
  calendarAdapter: {
    getCalendarId: () => 'cal-3', checkSlots: async () => ({ available_slots_string: '' }),
    getEvents: async () => [...events.values()],
    insertAppointment: async (name: string, phone: string, _service: string, dateTime: string, duration = 15, marker = '') => {
      const id = `event-${events.size + 1}`;
      const start = new Date(dateTime).toISOString();
      const event = { id, status: 'confirmed', summary: `Booked: ${name} - ${phone}`,
        description: `BusinessId: 3\nPlatform: instagram\nUserId: ${marker}`,
        start: { dateTime: start },
        end: { dateTime: new Date(Date.parse(start) + duration * 60_000).toISOString() },
        extendedProperties: { private: { businessId: '3', platform: 'instagram', userId: marker } } };
      events.set(id, event);
      return { success: true, event };
    },
    getEventById: async (id: string) => events.get(id) || null,
  },
  recordAppointment: async (params: any) => {
    const start = new Date(params.dateTime).toISOString();
    const row = { id: bookings.length + 1, business_id: '3', platform: params.platform,
      user_id: String(params.userId), service: params.service, start_time: start,
      end_time: new Date(Date.parse(start) + Number(params.durationMinutes) * 60_000).toISOString(),
      status: 'booked' };
    bookings.push(row);
    return row;
  },
  claimOperation: async (params: any) => {
    const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
    const existing = claims.get(key);
    if (existing) return { ...existing, claimed: false, duplicateStatus: existing.state.status };
    const handle = { claimed: true, keyHash: key, storageId: key,
      state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } };
    claims.set(key, handle);
    return handle;
  },
  settleOperation: async (handle: any, status: string) => { handle.state.status = status; return true; },
  notifyBooking: async () => true, postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 15 }),
} as any);

const turn = (text: string) => boundary.turn({
  sessionId, platformName: 'instagram', recipientUserId: sessionId, text, businessConfig: config, now,
});
const firstStart = '2026-09-22T14:00:00+02:00';
const firstEnd = '2026-09-22T14:15:00+02:00';
boundary.seedPending(sessionId, {
  bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, businessConfig: config,
  businessId: '3', platform: 'instagram', userId: sessionId, sessionId,
  operation: 'new_booking', status: 'awaiting_time_selection', expectedInput: 'slot_selection',
  service: 'test', serviceResolution: 'authoritative', language: 'ar',
  selectedDate: '2026-09-22', durationMinutes: 15,
  normalizedBookingRequest: { intent: 'new_booking', language: 'ar', sourceMode: 'text',
    requiresClarification: false, date: { kind: 'exact_date', value: '2026-09-22', confidence: 'high' } },
  offeredSlots: [`Tuesday at 14:00 (ISO: ${firstStart})`],
  ownedOfferedSlots: [{ start: firstStart, end: firstEnd, durationMinutes: 15, service: 'test',
    businessId: '3', platform: 'instagram', userId: sessionId, generatedAt: Date.now(),
    searchStartDate: '2026-09-22', searchEndDate: '2026-09-22' }],
  dateTime: null, selectedSlotEnd: null, createdAt: Date.now(), updatedAt: Date.now(),
});
boundary.promptAuditHistory(sessionId, [{ role: 'user', content: 'First booking request' }]);
const firstSelection = await turn('الساعة 14:00 تناسبني. يرجى اختيار هذا الوقت.');
assert.equal(firstSelection.pending?.status, 'awaiting_confirmation');
const staleFirstOperation = structuredClone(firstSelection.pending);
assert.equal((await turn('نعم، يرجى إتمام الحجز.')).pending?.status, 'awaiting_contact');
assert.equal((await turn('اسمي لينا اختبار ورقم هاتفي 0700001106.')).pending, null);
assert.equal(bookings.length, 1);
const firstBookingId = boundary.recentCompletionState(sessionId).completed?.bookingOperation?.bookingId;

// Model a stale durable/cache copy from the completed operation becoming visible
// again on another runtime instance.
boundary.seedPending(sessionId, staleFirstOperation);
const fresh = await turn('مرحباً، أريد حجز موعد بتاريخ الأربعاء، 30 سبتمبر 2026.');
assert.equal(fresh.pending?.status, 'awaiting_service');
assert.equal(fresh.pending?.selectedDate, '2026-09-30');
assert.equal(fresh.pending?.dateTime, null);
assert.deepEqual(fresh.pending?.ownedOfferedSlots, []);
assert.doesNotMatch(fresh.replies.join(' '), /الوقت المحدد|14:00/u);
assert.equal(boundary.recentCompletionState(sessionId).completed?.bookingOperation?.bookingId, firstBookingId);
assert.equal(
  boundary.recentCompletionClassification(
    sessionId,
    'هل يمكنك تأكيد الحجز السابق من فضلك؟',
    config,
    now,
  )?.category,
  'current_booking_status',
);
const service = await turn('test');
assert.equal(service.pending?.status, 'awaiting_time_selection');
const secondSlot = service.pending?.ownedOfferedSlots?.[0];
assert.ok(secondSlot);
const selectedTime = new Date(secondSlot.start).toLocaleTimeString('sv-SE', {
  timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit',
});
assert.equal((await turn(`الساعة ${selectedTime} تناسبني. يرجى اختيار هذا الوقت.`)).pending?.status, 'awaiting_confirmation');
assert.equal((await turn('نعم، يرجى إتمام الحجز.')).pending?.status, 'awaiting_contact');
assert.equal((await turn('اسمي لينا اختبار ورقم هاتفي 0700001106.')).pending, null);
assert.equal(bookings.length, 2);
assert.notEqual(bookings[0].id, bookings[1].id);
assert.notEqual(bookings[0].start_time, bookings[1].start_time);
assert.equal(boundary.promptAuditHistory(sessionId)[0]?.content, 'First booking request');

console.log = originalLog;
console.error = originalError;
console.log('Two successive verified booking operations passed');
