import assert from 'node:assert/strict';
import { isPositiveBookingConfirmation } from './booking-state-machine';
process.env.NODE_ENV = 'test';
const log = console.log;
console.log = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const now = new Date('2026-09-07T09:00:00+02:00');
const start = '2026-09-14T14:00:00+02:00';
const end = '2026-09-14T12:30:00.000Z';
const businessConfig = {
  id: 'confirmation-availability', businessName: 'Clinic', language: 'en',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'fixture-calendar',
  workingHours: { monday: [{ start: '14:00', end: '17:00' }] },
  bookingBufferMinutes: 15,
  services: [{ name: 'test', duration: 30 }, { name: 'Other', duration: 60 }],
};
try {
  for (const text of ['Yes, please complete the booking.', 'Please complete my booking.', 'Yes']) {
    assert.equal(isPositiveBookingConfirmation(text), true, text);
  }
  for (const text of ['No, please complete the booking.', 'Yes, do not complete the booking.', 'Maybe complete the booking.', 'Yes, please complete the booking tomorrow.', 'Yes, please complete the booking at 15:00.', 'Yes, please complete the form.']) {
    assert.equal(isPositiveBookingConfirmation(text), false, text);
  }
  for (const platformName of ['instagram', 'whatsapp', 'messenger', 'telegram'] as const) {
    for (const scenario of ['free', 'self-alias', 'late-calendar', 'calendar', 'calendar-buffer', 'other-hold', 'stale-duration', 'unclear', 'yes', 'yes-please', 'book-it'] as const) {
      boundary.reset();
      const events: any[] = [];
      let reads = 0;
      let writes = 0;
      boundary.configure({ calendarAdapter: {
        getCalendarId: () => 'fixture-calendar',
        getEvents: async () => { reads++; return [...events]; },
        insertAppointment: async () => { writes++; throw Error('contact is still required'); },
        checkSlots: () => { throw Error('legacy availability path'); },
      }, postProcess: async () => undefined, incrementUsage: async () => ({ allowed: true }) } as any);
      const recipientUserId = '46701234567';
      const sessionId = boundary.channelSessionId(platformName, recipientUserId, businessConfig);
      const turn = (text: string) => boundary.turn({ sessionId, platformName, recipientUserId, businessConfig, text, now });
      const rejected = await turn("I'd like to book wedding photography for Monday, 14 September 2026.");
      assert.equal(rejected.pending?.status, 'awaiting_service');
      assert.equal(reads, 0);
      const offered = await turn('test');
      assert.deepEqual(offered.pending.ownedOfferedSlots.map((slot: any) => slot.start.slice(11, 16)), ['14:00', '14:15', '14:30']);
      const selected = await turn('14:00 works for me. Please use that time.');
      assert.equal(selected.pending?.status, 'awaiting_confirmation');
      assert.equal(selected.pending?.dateTime, start);
      assert.equal(selected.pending?.selectedSlotEnd, end);
      assert.deepEqual(selected.pending?.offeredSlots, []);
      assert.equal(selected.pending?.ownedOfferedSlots.length, 1);
      assert.match(selected.replies.join(' '), /14:00/);
      // Explicitly model a customer whose required contact has not yet been supplied.
      const pending = { ...selected.pending, customerName: null };
      boundary.seedPending(sessionId, pending);
      if (scenario === 'calendar' || scenario === 'calendar-buffer') {
        events.push({ id: 'occupied', status: 'confirmed',
          start: { dateTime: scenario === 'calendar' ? '2026-09-14T12:00:00Z' : '2026-09-14T11:30:00Z' },
          end: { dateTime: scenario === 'calendar' ? end : '2026-09-14T11:50:00Z' },
        });
      }
      if (scenario === 'other-hold' || scenario === 'self-alias') {
        const userId = scenario === 'other-hold' ? '46709999999' : recipientUserId;
        boundary.seedPending('fixture-hold', { ...pending, sessionId: 'fixture-hold', userId,
          ownedOfferedSlots: pending.ownedOfferedSlots.map((slot: any) => ({ ...slot, userId })),
        });
      }
      if (scenario === 'stale-duration') boundary.seedPending(sessionId, { ...pending, durationMinutes: 60 });
      const readsBefore = reads;
      const confirmed = await turn(scenario === 'unclear' ? 'Hmm.' : scenario === 'yes' ? 'Yes' : scenario === 'yes-please' ? 'Yes, please' : scenario === 'book-it' ? 'Book it' : 'Yes, please complete the booking.');
      const label = `${platformName}/${scenario}`;
      assert.equal(writes, 0, label);
      assert.equal(confirmed.pending?.service, 'test', label);
      assert.equal(confirmed.pending?.selectedDate, '2026-09-14', label);
      if (scenario === 'free' || scenario === 'self-alias' || scenario === 'late-calendar' || ['yes', 'yes-please', 'book-it'].includes(scenario)) {
        assert.equal(confirmed.pending?.status, 'awaiting_contact', label);
        assert.equal(confirmed.pending?.dateTime, start, label);
        assert.equal(confirmed.pending?.selectedSlotEnd, end, label);
        assert.equal(confirmed.pending?.durationMinutes, 30, label);
        assert.match(confirmed.replies.join(' '), /name/iu, label);
        assert.doesNotMatch(confirmed.replies.join(' '), /already booked|no.*available/iu, label);
        assert.ok(reads > readsBefore, `${label}: confirmation revalidates the live fixture calendar`);
        if (scenario === 'late-calendar') {
          events.push({ id: 'late-occupied', status: 'confirmed', start: { dateTime: start }, end: { dateTime: end } });
          const final = await turn('My name is Ada Lovelace, 0701234567');
          assert.equal(final.pending?.status, 'awaiting_time_selection', label);
          assert.equal(final.pending?.dateTime, null, label);
          assert.equal(final.pending?.selectedDate, '2026-09-14', label);
          assert.equal(final.pending?.service, 'test', label);
          assert.equal(writes, 0, `${label}: final validation still blocks a newly occupied slot`);
        }
      } else if (scenario === 'unclear') {
        assert.equal(confirmed.pending?.status, 'awaiting_confirmation', label);
        assert.equal(confirmed.pending?.dateTime, start, label);
        assert.equal(confirmed.pending?.operationIdentity, pending.operationIdentity, label);
        assert.deepEqual(confirmed.pending?.ownedOfferedSlots, pending.ownedOfferedSlots, label);
        assert.equal(confirmed.pending?.durationMinutes, pending.durationMinutes, label);
        assert.match(confirmed.replies.join(' '), /book the selected time/iu, label);
        assert.doesNotMatch(confirmed.replies.join(' '), /already booked|available/iu, label);
        assert.equal(reads, readsBefore, label);
      } else {
        assert.equal(confirmed.pending?.status, 'awaiting_time_selection', label);
        assert.equal(confirmed.pending?.dateTime, null, label);
        assert.ok(reads > readsBefore, label);
        if (scenario !== 'stale-duration') assert.ok(!confirmed.pending?.ownedOfferedSlots.some((slot: any) => slot.start === start), label);
      }
    }
  }
  log('selected slot completion availability regressions passed (44 engine scenarios)');
} finally { boundary.reset(); console.log = log; }
