import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => undefined;
console.warn = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-30T12:00:00+02:00');
const businessConfig = {
  id: 'spanish-completed-follow-up-business',
  businessName: 'Spanish Completed Follow-up Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'spanish-completed-follow-up-calendar',
  services: [
    { name: 'Video Consultation', duration: 30 },
    { name: 'Laser Treatment', duration: 30 },
  ],
};

const calls = {
  checkSlots: 0,
  calendarReads: 0,
  bookingMutations: 0,
  databaseMutations: 0,
  operationClaims: 0,
  operationSettlements: 0,
};

const configure = () => {
  boundary.reset();
  calls.checkSlots = 0;
  calls.calendarReads = 0;
  calls.bookingMutations = 0;
  calls.databaseMutations = 0;
  calls.operationClaims = 0;
  calls.operationSettlements = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'spanish-completed-follow-up-calendar',
      checkSlots: async () => {
        calls.checkSlots += 1;
        return { available_slots_string: '' };
      },
      getEvents: async () => {
        calls.calendarReads += 1;
        return [];
      },
      insertAppointment: async () => {
        calls.bookingMutations += 1;
        return { success: false };
      },
    },
    recordAppointment: async () => {
      calls.databaseMutations += 1;
      return null;
    },
    claimOperation: async () => {
      calls.operationClaims += 1;
      return { claimed: false };
    },
    settleOperation: async () => {
      calls.operationSettlements += 1;
      return true;
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  });
};

const seedCompleted = (sessionId: string, language = 'es') => {
  boundary.seedRecentCompletedBooking(sessionId, language, {
    ok: true,
    bookingId: `booking-${sessionId}`,
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-08-31T09:00:00+02:00',
    customerName: 'Alex Testsson',
    customerPhone: '0701234567',
    sourceChannel: 'instagram',
  });
};

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'instagram',
  recipientUserId: sessionId,
  text,
  inputMode: 'text',
  businessConfig,
  now,
});

try {
  const completedFollowUps = [
    'Perfecto, gracias. Quedo a la espera de la confirmación de la reserva.',
    'Perfecto, gracias.',
    'Gracias, ¿está confirmada mi reserva?',
    'Quedo a la espera de la confirmación.',
    'Gracias por confirmar la reserva.',
    '¿Está confirmada mi cita de Video Consultation para las 09:00 del lunes 31 de agosto?',
  ];

  configure();
  for (const [index, text] of completedFollowUps.entries()) {
    const sessionId = `spanish-completed-follow-up-${index}`;
    seedCompleted(sessionId);
    const result = await turn(sessionId, text);

    assert.equal(result.handled, true, text);
    assert.equal(result.replies.length, 1, text);
    assert.ok(result.replies[0].trim().length > 0, text);
    assert.doesNotMatch(result.replies[0], /¿Qué hora quieres elegir\?/u, text);
    assert.equal(result.pending, null, text);
    assert.equal(result.operation.operation, 'none', text);
    assert.equal(result.operation.phase, 'idle', text);
  }
  assert.deepEqual(calls, {
    checkSlots: 0,
    calendarReads: 0,
    bookingMutations: 0,
    databaseMutations: 0,
    operationClaims: 0,
    operationSettlements: 0,
  });

  const mustRouteNormally = [
    '¿Está confirmada mi cita de Video Consultation para las 10:00 del lunes 31 de agosto?',
    '¿Está confirmada mi cita de Video Consultation para las 09:00 del martes 1 de septiembre?',
    '¿Está confirmada mi cita de Laser Treatment para las 09:00 del lunes 31 de agosto?',
    'Quiero reservar una nueva cita.',
    'Quiero cancelar mi reserva.',
    'Quiero cambiar la hora.',
    'Quiero mover mi reserva a las 12:00.',
  ];

  for (const [index, text] of mustRouteNormally.entries()) {
    configure();
    const sessionId = `spanish-completed-non-follow-up-${index}`;
    seedCompleted(sessionId);
    const result = await turn(sessionId, text);
    assert.equal(
      result.replies.some((reply: string) => /Alex Testsson/u.test(reply)),
      false,
      `must not answer from completed context: ${text}`,
    );
  }

  configure();
  seedCompleted('completed-swedish-thanks', 'sv');
  const swedishThanks = await turn('completed-swedish-thanks', 'Tack');
  assert.equal(swedishThanks.handled, true);
  assert.match(swedishThanks.replies.join(' '), /Alex Testsson/u);
  assert.equal(swedishThanks.pending, null);

  configure();
  const expiredSession = 'expired-spanish-completed-follow-up';
  seedCompleted(expiredSession);
  boundary.ageRecentCompletedBooking(expiredSession, 31 * 60_000);
  const expired = await turn(
    expiredSession,
    'Perfecto, gracias. Quedo a la espera de la confirmación de la reserva.',
  );
  assert.equal(expired.replies.some((reply: string) => /Alex Testsson/u.test(reply)), false);
  assert.equal(expired.pending, null);
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
}

console.log('Recent completed-booking Spanish follow-up regression passed.');
