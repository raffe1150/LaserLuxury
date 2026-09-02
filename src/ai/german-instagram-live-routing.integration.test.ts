import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-02T12:00:00+02:00');
const businessConfig = {
  id: 'german-instagram-live-routing-business',
  businessRecordId: 'german-instagram-live-routing-business',
  businessName: 'German Instagram Clinic',
  language: 'de',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'german-instagram-live-routing-calendar',
  defaultBookingService: 'Video Consultation',
  systemPrompt: 'Customers should bring photo ID for a Video Consultation.',
  services: [{ name: 'Video Consultation', duration: 30 }],
};

const calls = {
  calendarReads: 0,
  groundingVerifier: 0,
  entailment: 0,
};

const configure = () => {
  boundary.reset();
  calls.calendarReads = 0;
  calls.groundingVerifier = 0;
  calls.entailment = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => businessConfig.googleCalendarId,
      getEvents: async () => { calls.calendarReads += 1; return []; },
      checkSlots: async () => { throw new Error('legacy availability must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    assessBusinessSupportGrounding: () => {
      calls.groundingVerifier += 1;
      return { hasBusinessFactualClaims: false, claims: [], allBusinessClaimsSupported: true };
    },
    assessBusinessClaimEntailment: () => {
      calls.entailment += 1;
      return { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false };
    },
  } as any);
};

const seedCompleted = (
  sessionId: string,
  startTime = '2026-09-02T14:00:00+02:00',
) => boundary.seedRecentCompletedBooking(sessionId, 'de', {
  ok: true as const,
  bookingId: `booking-${sessionId}`,
  businessId: businessConfig.id,
  serviceName: 'Video Consultation',
  startTime,
  customerName: 'Alex Testsson',
  customerPhone: '0701234567',
  sourceChannel: 'instagram',
}, 30);

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'instagram',
  recipientUserId: sessionId,
  text,
  inputMode: 'text',
  businessConfig,
  now,
});

const liveTurn1 = 'Hallo, ich möchte einen Termin am Mittwoch, den 30. September 2026 buchen.';
const liveTurn2 = 'Gut, dann buche ich den Termin für den 30. September 2026. Könnten Sie mir bitte die genaue Uhrzeit und den Namen sowie die Telefonnummer für die Bestätigung nennen?';

try {
  const variants = [
    liveTurn1,
    'Ich möchte am Mittwoch, den 30. September 2026 einen Termin buchen.',
    'Ich möchte einen Termin für den 30. September 2026 buchen.',
    'Dann buche ich den Termin für den 30. September 2026.',
  ];
  for (const text of variants) {
    assert.equal(
      boundary.isExplicitDatedBookingCreation(text, businessConfig, now),
      true,
      text,
    );
  }
  assert.equal(
    boundary.isExplicitDatedBookingCreation(liveTurn2, businessConfig, now),
    true,
  );

  configure();
  const fresh = await turn('german-instagram-live-fresh', liveTurn1);
  assert.equal(fresh.handled, true);
  assert.equal(fresh.pending?.selectedDate, '2026-09-30');
  assert.equal(fresh.pending?.status, 'awaiting_time_selection');
  assert.ok(calls.calendarReads > 0);

  configure();
  const completedSession = 'german-instagram-live-recent-completion';
  seedCompleted(completedSession);
  assert.equal(
    boundary.recentCompletionClassification(completedSession, liveTurn1, businessConfig, now)?.category,
    'new_booking',
  );
  const completedPivot = await turn(completedSession, liveTurn1);
  assert.equal(completedPivot.handled, true);
  assert.equal(completedPivot.pending?.selectedDate, '2026-09-30');
  assert.equal(boundary.recentCompletionState(completedSession).support, null);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);
  assert.ok(calls.calendarReads > 0);

  configure();
  const isolatedTurn2Session = 'german-instagram-live-turn-2-isolated';
  seedCompleted(isolatedTurn2Session);
  assert.equal(
    boundary.recentCompletionClassification(isolatedTurn2Session, liveTurn2, businessConfig, now)?.category,
    'another_booking_lookup',
  );
  const isolatedTurn2 = await turn(isolatedTurn2Session, liveTurn2);
  assert.equal(isolatedTurn2.handled, true);
  assert.equal(isolatedTurn2.pending?.selectedDate, '2026-09-30');
  assert.equal(isolatedTurn2.pending?.status, 'awaiting_time_selection');
  assert.equal(isolatedTurn2.pending?.service, 'Video Consultation');
  assert.equal(boundary.recentCompletionState(isolatedTurn2Session).support, null);
  assert.ok(calls.calendarReads > 0);

  configure();
  const sequentialSession = 'german-instagram-live-sequential';
  seedCompleted(sequentialSession);
  const sequentialTurn1 = await turn(sequentialSession, liveTurn1);
  assert.equal(sequentialTurn1.handled, true);
  assert.equal(sequentialTurn1.pending?.selectedDate, '2026-09-30');
  assert.doesNotMatch(sequentialTurn1.replies.join(' '), /Unternehmensinformationen/iu);
  assert.equal(boundary.recentCompletionState(sequentialSession).support, null);
  const sequentialTurn2 = await turn(sequentialSession, liveTurn2);
  assert.equal(sequentialTurn2.handled, true);
  assert.equal(sequentialTurn2.pending?.selectedDate, '2026-09-30');
  assert.equal(sequentialTurn2.pending?.status, 'awaiting_time_selection');
  assert.doesNotMatch(sequentialTurn2.replies.join(' '), /Unternehmensinformationen/iu);
  assert.equal(boundary.recentCompletionState(sequentialSession).support, null);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  configure();
  for (const [index, text] of variants.entries()) {
    const sessionId = `german-date-word-order-${index}`;
    seedCompleted(sessionId);
    const result = await turn(sessionId, text);
    assert.equal(result.handled, true, text);
    assert.equal(result.pending?.selectedDate, '2026-09-30', text);
    assert.equal(boundary.recentCompletionState(sessionId).support, null, text);
  }

  configure();
  const supportSession = 'german-date-business-support';
  seedCompleted(supportSession);
  const supportText = 'Muss ich für den Termin am 30. September 2026 etwas vorbereiten?';
  assert.equal(
    boundary.recentCompletionClassification(supportSession, supportText, businessConfig, now)?.category,
    'business_support',
  );
  const support = await turn(supportSession, supportText);
  assert.equal(support.handled, false);
  assert.ok(boundary.recentCompletionState(supportSession).support);

  const requirementsSession = 'german-date-requirements';
  seedCompleted(requirementsSession);
  const requirementsText = 'Muss ich für den Termin am 30. September 2026 noch etwas bestätigen?';
  assert.equal(
    boundary.recentCompletionClassification(requirementsSession, requirementsText, businessConfig, now)?.category,
    'completion_requirements',
  );

  const statusSession = 'german-date-current-status';
  seedCompleted(statusSession, '2026-09-30T14:00:00+02:00');
  const statusText = 'Ist meine Buchung am 30. September 2026 bestätigt?';
  assert.equal(
    boundary.recentCompletionClassification(statusSession, statusText, businessConfig, now)?.category,
    'current_booking_status',
  );

  const anotherSession = 'german-date-another-booking';
  seedCompleted(anotherSession);
  const anotherText = 'Auf welchen Namen läuft der Termin am 30. September 2026?';
  assert.equal(
    boundary.recentCompletionClassification(anotherSession, anotherText, businessConfig, now)?.category,
    'another_booking_lookup',
  );

  const rescheduleSession = 'german-date-reschedule';
  seedCompleted(rescheduleSession);
  assert.equal(
    boundary.recentCompletionClassification(
      rescheduleSession,
      'Ich möchte meinen Termin am 30. September 2026 verschieben.',
      businessConfig,
      now,
    )?.category,
    'reschedule',
  );

  const cancellationSession = 'german-date-cancellation';
  seedCompleted(cancellationSession);
  assert.equal(
    boundary.recentCompletionClassification(
      cancellationSession,
      'I want to cancel my appointment on September 30, 2026.',
      businessConfig,
      now,
    )?.category,
    'cancellation',
  );

  const unsupported = await turn(
    'german-date-unsupported-service',
    'Please book Deep Tissue Massage.',
  );
  assert.equal(unsupported.handled, true);
  assert.equal(unsupported.pending?.status, 'awaiting_service');
  assert.equal(unsupported.pending?.requestedService, 'Deep Tissue Massage');

  originalLog('German Instagram live-routing regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
