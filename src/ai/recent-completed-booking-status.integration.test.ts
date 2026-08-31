import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const calls = { availability: 0, bookingMutations: 0, databaseMutations: 0 };
const businessConfig = {
  id: 'completed-status-business',
  businessName: 'Completed Status Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'completed-status-calendar',
};

boundary.reset();
boundary.configure({
  calendarAdapter: {
    getCalendarId: () => 'completed-status-calendar',
    checkSlots: async () => { calls.availability += 1; return { available_slots_string: '' }; },
    getEvents: async () => { calls.availability += 1; return []; },
    insertAppointment: async () => { calls.bookingMutations += 1; return { success: false }; },
  },
  recordAppointment: async () => { calls.databaseMutations += 1; return null; },
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
});

const cases = [
  {
    sessionId: 'recent-completed-status-ar',
    language: 'ar',
    question: 'هل يمكنك تأكيد الحجز من فضلك؟',
    customerName: 'ليلى',
    expectedService: /الاستشارة/u,
  },
  {
    sessionId: 'recent-completed-status-en',
    language: 'en',
    question: 'Can you please confirm my booking?',
    customerName: 'Alex',
    expectedService: /consultation/i,
  },
] as const;

try {
  for (const testCase of cases) {
    boundary.seedRecentCompletedBooking(testCase.sessionId, testCase.language, {
      ok: true,
      bookingId: `booking-${testCase.language}`,
      businessId: businessConfig.id,
      serviceName: 'Consultation',
      startTime: '2026-08-26T18:30:00+02:00',
      customerName: testCase.customerName,
      sourceChannel: 'telegram',
    });

    const result = await boundary.turn({
      sessionId: testCase.sessionId,
      platformName: 'telegram',
      recipientUserId: testCase.sessionId,
      text: testCase.question,
      inputMode: 'text',
      businessConfig,
      now: new Date('2026-08-25T12:00:00+02:00'),
    });

    assert.equal(result.handled, true);
    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0], /18:30/u);
    const expectedDate = new Date('2026-08-26T18:30:00+02:00').toLocaleDateString(
      testCase.language === 'ar' ? 'ar-SA' : 'en-GB',
      { timeZone: 'Europe/Stockholm', weekday: 'long', day: 'numeric', month: 'long' },
    );
    assert.match(result.replies[0], new RegExp(expectedDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    assert.equal(result.pending, null);
    assert.equal(result.operation.operation, 'none');
  }

  assert.deepEqual(calls, {
    availability: 0,
    bookingMutations: 0,
    databaseMutations: 0,
  });
} finally {
  boundary.reset();
}

console.log('Recent completed-booking status regression passed.');
