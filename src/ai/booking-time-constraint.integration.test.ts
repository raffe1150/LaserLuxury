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
  sessionId: 'telegram-live-senare-an',
  platformName: 'telegram',
  recipientUserId: 'telegram-live-senare-an',
  text: 'Finns det någon ledig tid måndag den 14 september 2026 senare än klockan 15?',
  inputMode: 'text',
  businessConfig,
  now: new Date('2026-08-15T12:00:00+02:00'),
});
const offeredMinutes = (result.pending?.ownedOfferedSlots || []).map((slot: any) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(slot.start));
  return Number(parts.find(part => part.type === 'hour')?.value) * 60 +
    Number(parts.find(part => part.type === 'minute')?.value);
});

assert.equal(result.pending.availabilityConstraint.kind, 'time_boundary');
assert.deepEqual(result.pending.availabilityConstraint.timeBoundary, {
  kind: 'exclusive_lower',
  time: '15:00',
});
assert.ok(offeredMinutes.length > 0);
assert.equal(offeredMinutes.includes(15 * 60), false);
assert.equal(offeredMinutes[0], 15 * 60 + 15);
assert.equal(result.pending.dateTime, null);
assert.equal(result.pending.status, 'awaiting_time_selection');
assert.deepEqual(mutations, { calendar: 0, database: 0 });

console.log('Booking strict time-constraint integration regression passed');
