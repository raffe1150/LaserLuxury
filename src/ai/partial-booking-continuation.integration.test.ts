import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: 'partial-booking-continuation',
  businessRecordId: 'partial-booking-continuation',
  businessName: 'Configured Services Clinic',
  language: 'en',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  defaultBookingService: 'Video Consultation',
  services: [{ name: 'Video Consultation', duration: 30 }],
};

async function runContinuation(params: {
  sessionId: string;
  text: string;
  selectedDate?: string | null;
  requestedTime?: string | null;
}) {
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
  boundary.seedPending(params.sessionId, {
    businessConfig,
    bookingStateVersion: 3,
    businessId: businessConfig.id,
    platform: 'messenger',
    userId: params.sessionId,
    sessionId: params.sessionId,
    service: 'Video Consultation',
    selectedDate: params.selectedDate || null,
    requestedTime: params.requestedTime || null,
    durationMinutes: 30,
    language: 'en',
    operation: 'new_booking',
    expectedInput: 'date_or_constraint',
    status: 'awaiting_date_or_time',
  });
  boundary.seedFlowLanguage(params.sessionId, 'en', 'booking');
  boundary.resolveConversationLanguage(params.sessionId, params.text, businessConfig);
  const result = await boundary.turn({
    sessionId: params.sessionId,
    platformName: 'messenger',
    recipientUserId: 'partial-customer',
    text: params.text,
    businessConfig,
  });
  return { result, calendarReads };
}

try {
  const dateOnly = await runContinuation({
    sessionId: 'pending-time-new-date',
    text: '2026-08-31',
    requestedTime: '16:00',
  });
  assert.equal(dateOnly.result.handled, true);
  assert.equal(dateOnly.result.pending?.selectedDate, '2026-08-31');
  assert.equal(dateOnly.result.pending?.requestedTime, '16:00');
  assert.equal(dateOnly.result.pending?.availabilityConstraint?.exactTime, '16:00');
  assert.equal(dateOnly.result.pending?.service, 'Video Consultation');
  assert.equal(dateOnly.result.pending?.durationMinutes, 30);
  assert.ok(dateOnly.calendarReads > 0);

  const timeOnly = await runContinuation({
    sessionId: 'pending-date-new-time',
    text: 'At 17:00.',
    selectedDate: '2026-09-01',
  });
  assert.equal(timeOnly.result.handled, true);
  assert.equal(timeOnly.result.pending?.selectedDate, '2026-09-01');
  assert.equal(timeOnly.result.pending?.requestedTime, '17:00');
  assert.equal(timeOnly.result.pending?.availabilityConstraint?.exactTime, '17:00');
  assert.equal(timeOnly.result.pending?.service, 'Video Consultation');

  const replaceTime = await runContinuation({
    sessionId: 'replace-pending-time',
    text: 'At 17:00 instead.',
    selectedDate: '2026-09-01',
    requestedTime: '16:00',
  });
  assert.equal(replaceTime.result.pending?.selectedDate, '2026-09-01');
  assert.equal(replaceTime.result.pending?.requestedTime, '17:00');
  assert.equal(replaceTime.result.pending?.availabilityConstraint?.exactTime, '17:00');

  const replaceDate = await runContinuation({
    sessionId: 'replace-pending-date',
    text: '2026-09-02 instead.',
    selectedDate: '2026-09-01',
    requestedTime: '16:00',
  });
  assert.equal(replaceDate.result.pending?.selectedDate, '2026-09-02');
  assert.equal(replaceDate.result.pending?.requestedTime, '16:00');
  assert.equal(replaceDate.result.pending?.availabilityConstraint?.exactTime, '16:00');
  assert.equal(replaceDate.result.pending?.service, 'Video Consultation');

  originalLog('partial booking continuation regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
