import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: '7',
  businessName: 'Test Clinic',
  language: 'sv',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'cal-7',
  defaultBookingService: 'Konsultation',
  services: [{ name: 'Konsultation', duration: 30 }],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((day) => [day, [{ start: '09:00', end: '17:00' }]]),
  ),
};

const sessionId = 'wa_7:46700000000';
const userId = '46700000000';
const persistedUserId = sessionId.replace(/\D/g, '');
const staleDate = '2026-10-15';
const staleStart = '2026-10-15T10:45:00+02:00';
const staleEnd = '2026-10-15T09:15:00.000Z';
const now = new Date('2026-08-30T10:00:00+02:00');

function configure() {
  boundary.reset();
  const availabilityReads: Array<{ startDate: string; endDate: string }> = [];
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      getEvents: async (startDate: string, endDate: string) => {
        availabilityReads.push({ startDate, endDate });
        return [];
      },
      checkSlots: async () => ({ available_slots_string: '' }),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  return availabilityReads;
}

function seedStalePending(status: 'awaiting_time_selection' | 'awaiting_contact') {
  const selected = status === 'awaiting_contact';
  boundary.seedPending(sessionId, {
    businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessId: '7',
    platform: 'whatsapp',
    userId: persistedUserId,
    sessionId,
    operation: 'new_booking',
    status,
    expectedInput: selected ? 'contact' : 'slot_selection',
    service: 'Konsultation',
    durationMinutes: 30,
    selectedDate: staleDate,
    dateTime: selected ? staleStart : null,
    selectedSlotEnd: selected ? staleEnd : null,
    availabilityStartDate: staleDate,
    availabilityEndDate: staleDate,
    availabilityConstraint: {
      startDate: staleDate,
      endDate: staleDate,
      kind: 'whole_day',
      rejectedTimes: [],
      generatedFromLatestRequestAt: Date.now(),
    },
    normalizedBookingRequest: {
      intent: 'new_booking',
      language: 'sv',
      service: { normalized: 'Konsultation', confidence: 'high' },
      date: { kind: 'exact_date', value: staleDate, confidence: 'high' },
      requiresClarification: false,
    },
    offeredSlots: [],
    ownedOfferedSlots: [{
      start: staleStart,
      end: staleEnd,
      durationMinutes: 30,
      service: 'Konsultation',
      businessId: '7',
      platform: 'whatsapp',
      userId,
      generatedAt: Date.now(),
      searchStartDate: staleDate,
      searchEndDate: staleDate,
    }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  boundary.seedFlowLanguage(sessionId, 'sv');
}

try {
  for (const status of ['awaiting_time_selection', 'awaiting_contact'] as const) {
    const availabilityReads = configure();
    seedStalePending(status);
    const result = await boundary.turn({
      sessionId,
      platformName: 'whatsapp',
      recipientUserId: userId,
      text: 'Hej, jag vill boka en tid till i morgon.',
      businessConfig,
      now,
    });

    assert.equal(result.pending?.availabilityStartDate, '2026-08-31', status);
    assert.equal(result.pending?.availabilityEndDate, '2026-08-31', status);
    assert.equal(result.pending?.selectedDate, '2026-08-31', status);
    assert.equal(result.pending?.availabilityConstraint?.startDate, '2026-08-31', status);
    assert.equal(result.pending?.availabilityConstraint?.kind, 'whole_day', status);
    assert.notEqual(result.pending?.availabilityConstraint?.daypart, 'morning', status);
    assert.ok(
      availabilityReads.some((read) => read.startDate === '2026-08-31' && read.endDate === '2026-08-31'),
      `${status}: tomorrow availability was requested`,
    );
    assert.ok(
      availabilityReads.every((read) => read.startDate !== staleDate && read.endDate !== staleDate),
      `${status}: stale October date was not requested`,
    );
    assert.doesNotMatch(result.replies.join(' '), /15\s+oktober/iu, status);
  }

  originalLog('WhatsApp Swedish tomorrow stale-state regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
