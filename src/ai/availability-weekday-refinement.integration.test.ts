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
const now = new Date('2026-08-20T23:00:00Z'); // Friday 01:00 in Stockholm

function fixture() {
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      checkSlots: async () => ({ available_slots_string: '' }),
      getEvents: async () => [],
      insertAppointment: async () => ({ success: false }),
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  });
}

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'telegram',
  recipientUserId: sessionId,
  text,
  businessConfig,
  now,
});

async function activeFriday(sessionId: string) {
  fixture();
  const initial = await turn(
    sessionId,
    'Do you have any consultation appointments on 21 August 2026?',
  );
  assert.equal(initial.pending?.availabilityConstraint?.startDate, '2026-08-21');
  assert.equal(initial.pending?.availabilityConstraint?.endDate, '2026-08-21');
}

await activeFriday('bare-friday-before');
const before = await turn('bare-friday-before', 'before 18:00 on Friday');
assert.equal(before.pending?.availabilityConstraint?.startDate, '2026-08-21');
assert.equal(before.pending?.availabilityConstraint?.endDate, '2026-08-21');
assert.equal(before.pending?.availabilityConstraint?.timeBoundary?.kind, 'exclusive_upper');

await activeFriday('bare-friday-window');
const window = await turn('bare-friday-window', 'between 18:00 and 20:00 on Friday');
assert.equal(window.pending?.availabilityConstraint?.startDate, '2026-08-21');
assert.equal(window.pending?.availabilityConstraint?.endDate, '2026-08-21');
assert.equal(window.pending?.availabilityConstraint?.kind, 'time_window');

await activeFriday('bare-friday-earlier');
const earlier = await turn('bare-friday-earlier', 'earlier on Friday');
assert.equal(earlier.pending?.availabilityConstraint?.startDate, '2026-08-21');
assert.equal(earlier.pending?.availabilityConstraint?.endDate, '2026-08-21');

await activeFriday('next-friday');
const nextFriday = await turn('next-friday', 'before 18:00 next Friday');
assert.equal(nextFriday.pending?.availabilityConstraint?.startDate, '2026-08-28');
assert.equal(nextFriday.pending?.availabilityConstraint?.endDate, '2026-08-28');

await activeFriday('different-weekday');
const monday = await turn('different-weekday', 'before 18:00 on Monday');
assert.equal(monday.pending?.availabilityConstraint?.startDate, '2026-08-24');
assert.equal(monday.pending?.availabilityConstraint?.endDate, '2026-08-24');

await activeFriday('explicit-date');
const explicitDate = await turn('explicit-date', 'before 18:00 on 25 August 2026');
assert.equal(explicitDate.pending?.availabilityConstraint?.startDate, '2026-08-25');
assert.equal(explicitDate.pending?.availabilityConstraint?.endDate, '2026-08-25');

for (const [sessionId, text] of [
  ['literal-2000', '20:00'],
  ['at-2000', 'at 20:00'],
  ['how-about-2000', 'I see. How about 20:00 instead? Is that available for a Video Consultation on Friday?'],
] as const) {
  await activeFriday(sessionId);
  const result = await turn(sessionId, text);
  assert.equal(result.pending?.availabilityConstraint?.kind, 'exact_time');
  assert.equal(result.pending?.availabilityConstraint?.exactTime, '20:00');
}

await activeFriday('around-2000');
const around = await turn(
  'around-2000',
  'Is around 20:00 available for a Video Consultation on Friday?',
);
assert.equal(around.pending?.availabilityConstraint?.kind, 'approximate_time');
assert.equal(around.pending?.availabilityConstraint?.exactTime, '20:00');
assert.equal(around.pending?.availabilityConstraint?.timeBoundary?.time, '20:00');

boundary.reset();
console.log('availability weekday refinement integration tests passed');
