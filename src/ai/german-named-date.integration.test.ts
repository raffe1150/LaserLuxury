import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;

const { parseBookingDate } = await import('./booking-intelligence');
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-01-01T12:00:00Z');
const months = [
  ['Januar', '01'],
  ['Februar', '02'],
  ['März', '03'],
  ['April', '04'],
  ['Mai', '05'],
  ['Juni', '06'],
  ['Juli', '07'],
  ['August', '08'],
  ['September', '09'],
  ['Oktober', '10'],
  ['November', '11'],
  ['Dezember', '12'],
] as const;

try {
  for (const [monthName, monthNumber] of months) {
    const expected = `2026-${monthNumber}-15`;
    for (const spelling of [monthName, monthName.toLowerCase()]) {
      const text = `Am 15. ${spelling} 2026.`;
      assert.equal(parseBookingDate(text, 'Europe/Stockholm', now)?.value, expected);
      assert.equal(boundary.resolveExplicitBookingDate(text), expected);
    }
  }

  assert.equal(
    parseBookingDate('Am 31. August 2026.', 'Europe/Stockholm', now)?.value,
    '2026-08-31',
  );
  assert.equal(boundary.resolveExplicitBookingDate('Am 31. August 2026.'), '2026-08-31');

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

  const businessConfig = {
    id: 'german-named-date-continuation',
    businessRecordId: 'german-named-date-continuation',
    businessName: 'Configured Services Clinic',
    language: 'de',
    timezone: 'Europe/Stockholm',
    calendarProvider: 'custom',
    defaultBookingService: 'Video Consultation',
    services: [{ name: 'Video Consultation', duration: 30 }],
  };
  const sessionId = 'german-named-date-continuation';
  const turn = async (text: string) => {
    boundary.resolveConversationLanguage(sessionId, text, businessConfig);
    return boundary.turn({
      sessionId,
      platformName: 'messenger',
      recipientUserId: 'german-date-customer',
      text,
      businessConfig,
    });
  };

  await turn('Ich möchte eine Haarbehandlung um 16:00 Uhr buchen.');
  await turn('Dann nehme ich Video Consultation.');
  const continuation = await turn('Am 31. August 2026.');

  assert.equal(continuation.handled, true, 'date continuation stays in deterministic booking');
  assert.equal(continuation.pending?.selectedDate, '2026-08-31');
  assert.equal(continuation.pending?.service, 'Video Consultation');
  assert.equal(continuation.pending?.requestedService, 'Haarbehandlung');
  assert.equal(continuation.pending?.requestedTime, '16:00');
  assert.equal(continuation.pending?.language, 'de');
  assert.ok(calendarReads > 0, 'date continuation proceeds to a read-only availability lookup');

  originalLog('German named-date regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
