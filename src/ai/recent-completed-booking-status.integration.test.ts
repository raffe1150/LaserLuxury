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
  {
    sessionId: 'recent-completed-status-sv',
    language: 'sv',
    question: 'Ja, bekräfta bokningen.',
    customerName: 'OdinLink Test',
    expectedService: /consultation/i,
  },
  {
    sessionId: 'recent-completed-status-de',
    language: 'de',
    question: 'Ja, bitte bestätigen Sie meine Buchung.',
    customerName: 'Max',
    expectedService: /beratung|konsultation|consultation/i,
  },
  {
    sessionId: 'recent-completed-status-es',
    language: 'es',
    question: 'Sí, confirma mi reserva.',
    customerName: 'Lucía',
    expectedService: /consulta|consultation/i,
  },
  {
    sessionId: 'recent-completed-status-fa',
    language: 'fa',
    question: 'بله، رزرو من را تأیید کن.',
    customerName: 'رضا',
    expectedService: /مشاوره|consultation/u,
  },
] as const;

const expectedStatusCards = {
  en: { header: 'Yes, the booking is verified.', date: 'Date', time: 'Time' },
  sv: { header: 'Ja, bokningen är verifierad.', date: 'Datum', time: 'Tid' },
  de: { header: 'Ja, die Buchung ist bestätigt.', date: 'Datum', time: 'Uhrzeit' },
  es: { header: 'Sí, la reserva está verificada.', date: 'Fecha', time: 'Hora' },
  fa: { header: 'بله، رزرو تأیید شده است.', date: 'تاریخ', time: 'زمان' },
  ar: { header: 'نعم، الحجز مؤكد.', date: 'التاريخ', time: 'الوقت' },
} as const;

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

    const expectedCard = expectedStatusCards[testCase.language];
    assert.equal(
      result.replies[0].startsWith(`${expectedCard.header}\n\n`),
      true,
      `${testCase.language} status reply should use a mini-card header`,
    );
    assert.match(
      result.replies[0],
      new RegExp(`\\n\\n${expectedCard.date}:`, 'u'),
    );
    assert.match(
      result.replies[0],
      new RegExp(`\\n${expectedCard.time}: 18:30`, 'u'),
    );
    const expectedDate = new Date('2026-08-26T18:30:00+02:00').toLocaleDateString(
      testCase.language === 'ar' ? 'ar-SA' :
      testCase.language === 'sv' ? 'sv-SE' :
      testCase.language === 'de' ? 'de-DE' :
      testCase.language === 'es' ? 'es-ES' :
      testCase.language === 'fa' ? 'fa-IR-u-ca-gregory' :
      'en-GB',
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
