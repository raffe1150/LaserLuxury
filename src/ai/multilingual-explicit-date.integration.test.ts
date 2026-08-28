import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: '7',
  businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Konsultation',
  calendarProvider: 'custom',
  googleCalendarId: 'cal-7',
};
const turnNow = new Date('2026-08-15T12:00:00+02:00');

const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso));
const localMinutes = (iso: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  return Number(parts.find(part => part.type === 'hour')?.value) * 60 +
    Number(parts.find(part => part.type === 'minute')?.value);
};

async function runExactLiveSentence(sessionId: string, text: string) {
  const mutations = { calendar: 0, database: 0 };
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      checkSlots: async () => ({ available_slots_string: '' }),
      getEvents: async () => [],
      insertAppointment: async () => { mutations.calendar += 1; return { success: false }; },
      updateAppointment: async () => { mutations.calendar += 1; return { success: false }; },
      cancelAppointment: async () => { mutations.calendar += 1; return { success: false }; },
      getEventById: async () => null,
      verifyEventDeleted: async () => false,
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    notifyReschedule: async () => true,
    notifyCancellation: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    recordAppointment: async () => { mutations.database += 1; return null; },
  });
  const result = await boundary.turn({
    sessionId,
    platformName: 'telegram',
    recipientUserId: sessionId,
    text,
    inputMode: 'text',
    businessConfig,
    now: turnNow,
  });
  return { result, mutations };
}

for (const testCase of [
  {
    sessionId: 'telegram-german-explicit-date',
    text: 'Haben Sie am Donnerstag, den 17. September 2026, einen Termin später als 15 Uhr?',
    expectedDate: '2026-09-17',
    forbiddenDate: '2026-09-16',
  },
  {
    sessionId: 'telegram-persian-explicit-date',
    text: 'در تاریخ چهارشنبه ۲۳ سپتامبر ۲۰۲۶ بعد از ساعت ۱۵ وقت خالی دارید؟',
    expectedDate: '2026-09-23',
    forbiddenDate: '2026-08-19',
  },
] as const) {
  const { result, mutations } = await runExactLiveSentence(testCase.sessionId, testCase.text);
  const slots = result.pending?.ownedOfferedSlots || [];
  assert.equal(result.pending.availabilityStartDate, testCase.expectedDate);
  assert.equal(result.pending.availabilityEndDate, testCase.expectedDate);
  assert.equal(result.pending.availabilityConstraint.timeBoundary.kind, 'exclusive_lower');
  assert.equal(result.pending.availabilityConstraint.timeBoundary.time, '15:00');
  assert.ok(slots.length > 0);
  assert.ok(slots.every((slot: any) => localDate(slot.start) === testCase.expectedDate));
  assert.ok(slots.every((slot: any) => localDate(slot.start) !== testCase.forbiddenDate));
  assert.ok(slots.every((slot: any) => localMinutes(slot.start) > 15 * 60));
  assert.equal(result.pending.dateTime, null);
  assert.equal(result.pending.status, 'awaiting_time_selection');
  assert.deepEqual(mutations, { calendar: 0, database: 0 });
}

console.log('German and Persian explicit-date integration regressions passed');
