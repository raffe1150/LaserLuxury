import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-27T09:00:00+02:00');
const platforms = ['telegram', 'whatsapp', 'messenger', 'instagram'] as const;
const cases = {
  sv: { text: 'Då bokar jag in mig på 13:00 den 13 oktober.', marker: /(?:boka|bokningen|namn|mobilnummer|bekräfta)/iu },
  de: { text: 'Dann buche ich den Termin am 13. Oktober um 13:00 Uhr.', marker: /(?:buchen|Buchung|Namen|Mobilnummer|bestätigen)/iu },
} as const;

const configure = () => {
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getEvents: async () => [],
      checkSlots: () => ({ available_slots_string: '' }),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
};

try {
  for (const platform of platforms) {
    for (const [language, scenario] of Object.entries(cases) as Array<[keyof typeof cases, (typeof cases)[keyof typeof cases]]>) {
      configure();
      const businessConfig = {
        id: `continuity-${platform}-${language}`,
        businessRecordId: `continuity-${platform}-${language}`,
        businessName: 'Continuity Clinic',
        language: 'en',
        timezone: 'Europe/Stockholm',
        calendarProvider: 'custom',
        defaultBookingService: 'Consultation',
      };
      const sessionId = `${platform}-continuity-${language}`;
      const start = '2026-10-13T13:00:00+02:00';
      const end = '2026-10-13T14:00:00+02:00';
      boundary.seedPending(sessionId, {
        bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
        businessConfig,
        businessId: businessConfig.id,
        platform,
        userId: sessionId,
        sessionId,
        operation: 'new_booking',
        status: 'awaiting_time_selection',
        expectedInput: 'slot_selection',
        service: 'Consultation',
        language,
        selectedDate: '2026-10-13',
        durationMinutes: 60,
        normalizedBookingRequest: {
          intent: 'new_booking', language, sourceMode: 'text', requiresClarification: false,
          date: { kind: 'exact_date', value: '2026-10-13', confidence: 'high' },
        },
        availabilityConstraint: { startDate: '2026-10-13', endDate: '2026-10-13', kind: 'day', rejectedTimes: [] },
        offeredSlots: [`Tuesday at 13:00 (ISO: ${start})`],
        ownedOfferedSlots: [{
          start, end, durationMinutes: 60, service: 'Consultation', businessId: businessConfig.id,
          platform, userId: sessionId, generatedAt: Date.now(),
          searchStartDate: '2026-10-13', searchEndDate: '2026-10-13',
        }],
        dateTime: null,
        selectedSlotEnd: null,
      });
      boundary.seedFlowLanguage(sessionId, 'en', 'availability');

      const result = await boundary.turn({
        sessionId,
        platformName: platform,
        recipientUserId: sessionId,
        text: scenario.text,
        businessConfig,
        now,
      });

      assert.equal(result.handled, true, `${platform}/${language}: selection is handled`);
      assert.equal(result.pending?.language, language, `${platform}/${language}: pending language remains authoritative`);
      assert.notEqual(result.pending?.status, 'awaiting_time_selection', `${platform}/${language}: owned slot selection advances`);
      assert.equal(boundary.conversationState(sessionId).language, language, `${platform}/${language}: stale flow language is repaired`);
      assert.match(result.replies[0], scenario.marker, `${platform}/${language}: reply stays localized`);
      assert.doesNotMatch(result.replies[0], /Which proposed time|Which one suits you|I found these available times/iu);
    }
  }

  originalLog('booking language continuity regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
