import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-01T12:00:00+02:00');
const businessConfig = {
  id: 'whatsapp-recent-boundary-business',
  businessName: 'WhatsApp Boundary Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'whatsapp-recent-boundary-calendar',
  services: [{ name: 'Video Consultation', durationMinutes: 30 }],
};
const calls = { availability: 0, bookingMutations: 0, databaseMutations: 0 };

const configure = () => {
  boundary.reset();
  calls.availability = 0;
  calls.bookingMutations = 0;
  calls.databaseMutations = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'whatsapp-recent-boundary-calendar',
      checkSlots: async () => { calls.availability += 1; return { available_slots_string: '' }; },
      getEvents: async () => { calls.availability += 1; return []; },
      insertAppointment: async () => { calls.bookingMutations += 1; return { success: false }; },
    },
    recordAppointment: async () => { calls.databaseMutations += 1; return null; },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  });
};

const seedCompleted = (sessionId: string) => boundary.seedRecentCompletedBooking(sessionId, 'sv', {
  ok: true,
  bookingId: `booking-${sessionId}`,
  businessId: businessConfig.id,
  serviceName: 'Video Consultation',
  startTime: '2026-09-02T14:00:00+02:00',
  customerName: 'Alex Testsson',
  customerPhone: '0701234567',
  sourceChannel: 'whatsapp',
}, 30);

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'whatsapp',
  recipientUserId: '0701234567',
  text,
  inputMode: 'text',
  businessConfig,
  now,
});

try {
  configure();
  assert.deepEqual(
    boundary.whatsappPreDispatchDecision('whatsapp-no-recent-completion', 'Jag har en fråga om min bokning.'),
    {
      intent: 'ambiguous',
      returnsAmbiguousClarification: true,
      dispatchesUnifiedBooking: false,
    },
  );

  configure();
  const turnCSession = 'whatsapp-live-turn-c';
  const turnCText = 'Min bokning är redan bekräftad med mitt namn och telefonnummer, eller hur?';
  seedCompleted(turnCSession);
  assert.deepEqual(boundary.whatsappPreDispatchDecision(turnCSession, turnCText), {
    intent: 'ambiguous',
    returnsAmbiguousClarification: false,
    dispatchesUnifiedBooking: true,
  });
  const turnC = await turn(turnCSession, turnCText);
  assert.equal(turnC.handled, true);
  assert.match(turnC.replies[0], /verifierad/u);
  assert.match(turnC.replies[0], /Alex Testsson/u);
  assert.match(turnC.replies[0], /0701234567/u);
  assert.doesNotMatch(turnC.replies[0], /ny bokning, ombokning, avbokning/u);
  assert.equal(turnC.pending, null);
  assert.deepEqual(calls, { availability: 0, bookingMutations: 0, databaseMutations: 0 });

  configure();
  const turn9Session = 'whatsapp-live-turn-9';
  const turn9Text = 'Ja, precis. Min bokning är bokad med mitt namn Alex Testsson och telefonnummer 0701234567 för onsdag 2 september klockan 14:00.';
  seedCompleted(turn9Session);
  assert.deepEqual(boundary.whatsappPreDispatchDecision(turn9Session, turn9Text), {
    intent: 'new_booking',
    returnsAmbiguousClarification: false,
    dispatchesUnifiedBooking: true,
  });
  const turn9Classification = boundary.recentCompletionClassification(
    turn9Session,
    turn9Text,
    businessConfig,
    now,
  );
  assert.equal(turn9Classification?.factsMatch, true);
  assert.equal(turn9Classification?.category, 'current_booking_status');
  const turn9 = await turn(turn9Session, turn9Text);
  assert.equal(turn9.handled, true);
  assert.match(turn9.replies[0], /verifierad/u);
  assert.doesNotMatch(turn9.replies[0], /Jag hjälper dig gärna på svenska/u);
  assert.equal(turn9.pending, null);
  assert.deepEqual(calls, { availability: 0, bookingMutations: 0, databaseMutations: 0 });

  configure();
  const newBookingSession = 'whatsapp-real-new-booking-pivot';
  seedCompleted(newBookingSession);
  const newBookingText = 'I want to book another appointment for Video Consultation tomorrow at 14:00.';
  const newBooking = await turn(newBookingSession, newBookingText);
  assert.equal(boundary.whatsappPreDispatchDecision(newBookingSession, newBookingText).dispatchesUnifiedBooking, true);
  assert.ok(calls.availability > 0, 'a true distinct new-booking request reaches availability');
  assert.equal(newBooking.pending?.operation, 'new_booking');
  assert.doesNotMatch(newBooking.replies.join(' '), /booking is verified|Alex Testsson|0701234567/iu);
  assert.equal(calls.bookingMutations, 0);
  assert.equal(calls.databaseMutations, 0);
} finally {
  boundary.reset();
}

console.log('WhatsApp recent-completion boundary regressions passed');
