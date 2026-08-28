import assert from 'node:assert/strict';
import { parseTimeConstraint } from './booking-intelligence';

const after = (startMinutes: number) => ({
  kind: 'after', startMinutes, startInclusive: false, endInclusive: false, confidence: 'high',
});
const before = (endMinutes: number) => ({
  kind: 'before', endMinutes, endInclusive: false, confidence: 'high',
});
const between = (startMinutes: number, endMinutes: number) => ({
  kind: 'between', startMinutes, endMinutes, startInclusive: true, endInclusive: true, confidence: 'high',
});
const exact = (startMinutes: number) => ({
  kind: 'exact', startMinutes, startInclusive: true, endInclusive: true, confidence: 'high',
});

assert.deepEqual(parseTimeConstraint('nach 15 Uhr'), after(15 * 60));
assert.deepEqual(parseTimeConstraint('vor 12 Uhr'), before(12 * 60));
assert.deepEqual(parseTimeConstraint('zwischen 14 und 16 Uhr'), between(14 * 60, 16 * 60));
assert.equal(parseTimeConstraint('am Abend')?.kind, 'evening');
assert.deepEqual(parseTimeConstraint('um 16 Uhr'), exact(16 * 60));
assert.deepEqual(parseTimeConstraint('um 16:30 Uhr'), exact(16 * 60 + 30));

assert.deepEqual(parseTimeConstraint('después de las 15'), after(15 * 60));
assert.deepEqual(parseTimeConstraint('antes de las 12'), before(12 * 60));
assert.deepEqual(parseTimeConstraint('entre las 14 y las 16'), between(14 * 60, 16 * 60));
assert.equal(parseTimeConstraint('por la tarde')?.kind, 'afternoon');
assert.deepEqual(parseTimeConstraint('a las 16:00'), exact(16 * 60));
assert.deepEqual(parseTimeConstraint('a las 16:30'), exact(16 * 60 + 30));

assert.deepEqual(parseTimeConstraint('الساعة 16:00'), exact(16 * 60));
assert.deepEqual(parseTimeConstraint('الساعة ١٦:٠٠'), exact(16 * 60));
assert.deepEqual(parseTimeConstraint('بعد الساعة 15'), after(15 * 60));
assert.deepEqual(parseTimeConstraint('قبل الساعة 12'), before(12 * 60));
assert.deepEqual(parseTimeConstraint('بين الساعة 14 و16'), between(14 * 60, 16 * 60));
assert.equal(parseTimeConstraint('في المساء')?.kind, 'evening');

assert.equal(parseTimeConstraint('16:00 passt nicht'), undefined);
assert.equal(parseTimeConstraint('Las 16:00 no me va'), undefined);
assert.equal(parseTimeConstraint('الساعة 16:00 لا تناسبني'), undefined);

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: 'priority-2-1-time',
  businessRecordId: 'priority-2-1-time',
  businessName: 'Time Constraint Clinic',
  language: 'en',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  defaultBookingService: 'Video Consultation',
  services: [{ name: 'Video Consultation', duration: 30 }],
};

async function assertContinuation(
  sessionId: string,
  language: 'de' | 'es' | 'ar',
  text: string,
  expectedConstraint: ReturnType<typeof parseTimeConstraint>,
) {
  boundary.reset();
  let calendarReads = 0;
  boundary.configure({
    calendarAdapter: {
      getEvents: async () => {
        calendarReads += 1;
        return [];
      },
      checkSlots: () => ({ available_slots_string: '' }),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  boundary.seedPending(sessionId, {
    businessConfig,
    bookingStateVersion: 3,
    businessId: businessConfig.id,
    platform: 'messenger',
    userId: sessionId,
    sessionId,
    service: 'Video Consultation',
    selectedDate: '2026-08-31',
    requestedTime: null,
    durationMinutes: 30,
    language,
    operation: 'new_booking',
    expectedInput: 'date_or_constraint',
    status: 'awaiting_date_or_time',
  });
  boundary.seedFlowLanguage(sessionId, language, 'booking');

  const result = await boundary.turn({
    sessionId,
    platformName: 'messenger',
    recipientUserId: sessionId,
    text,
    businessConfig,
    now: new Date('2026-08-28T12:00:00Z'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.language, language);
  assert.deepEqual(result.pending?.normalizedBookingRequest?.timeConstraint, expectedConstraint);
  assert.ok(calendarReads > 0, `${language}: deterministic availability receives the constraint`);
}

try {
  await assertContinuation('p2-1-de', 'de', 'nach 15 Uhr', after(15 * 60));
  await assertContinuation('p2-1-es', 'es', 'antes de las 12', before(12 * 60));
  await assertContinuation('p2-1-ar', 'ar', 'الساعة ١٦:٠٠', exact(16 * 60));
  originalLog('Priority 2.1 multilingual time regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
