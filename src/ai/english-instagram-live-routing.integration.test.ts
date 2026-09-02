import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-01T12:00:00+02:00');
const businessConfig = {
  id: 'english-instagram-live-routing-business',
  businessRecordId: 'english-instagram-live-routing-business',
  businessName: 'English Instagram Clinic',
  language: 'en',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'english-instagram-live-routing-calendar',
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
    assessBusinessSupportGrounding: ({ candidateReply }: any) => {
      calls.groundingVerifier += 1;
      return {
        hasBusinessFactualClaims: true,
        claims: [{
          claim: candidateReply,
          candidateQuote: candidateReply,
          claimKind: 'OTHER',
          requiresBusinessEvidence: true,
          supported: true,
          evidence: [{
            source: 'business_system_prompt',
            quote: 'Customers should bring photo ID for a Video Consultation.',
          }],
        }],
        allBusinessClaimsSupported: true,
      };
    },
    assessBusinessClaimEntailment: () => {
      calls.entailment += 1;
      return {
        relation: 'ENTAILED',
        claimKind: 'OTHER',
        explicitAbsenceEvidence: false,
      };
    },
  } as any);
};

const completedOperation = (sessionId: string) => ({
  ok: true as const,
  bookingId: `booking-${sessionId}`,
  businessId: businessConfig.id,
  serviceName: 'Video Consultation',
  startTime: '2026-09-02T14:00:00+02:00',
  customerName: 'Alex Testsson',
  customerPhone: '0701234567',
  sourceChannel: 'instagram',
});

const turn = (sessionId: string, senderId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'instagram',
  recipientUserId: senderId,
  text,
  inputMode: 'text',
  businessConfig,
  now,
});

const liveTurn1 = "Hello, I'd like to book an appointment for tomorrow.";
const liveTurn2 = "I see. Could you please confirm if video consultations are available for booking tomorrow? I'd like to schedule one.";

try {
  for (const text of [
    "I'd like to book a booking for tomorrow.",
    "I'd like to book an appointment for tomorrow.",
    "I'd like to make a booking for tomorrow.",
    "I'd like to make an appointment for tomorrow.",
    'I’d like to book a booking for tomorrow.',
    'I’d like to book an appointment for tomorrow.',
    'I’d like to make a booking for tomorrow.',
    'I’d like to make an appointment for tomorrow.',
  ]) {
    assert.equal(boundary.isExplicitNewBookingPivot(text), true, text);
  }

  for (const text of [
    'schedule one', 'schedule it', 'schedule that', 'schedule this',
    'book one', 'book it', 'book that', 'book this',
    'reserve one', 'reserve it',
    'Schedule One.', 'BOOK IT!', 'Reserve That.',
  ]) {
    assert.equal(boundary.extractConcreteRequestedService(text), null, text);
  }
  assert.equal(
    boundary.extractConcreteRequestedService('Please book Deep Tissue Massage.'),
    'Deep Tissue Massage',
  );

  configure();
  const freshSession = boundary.channelSessionId(
    'instagram',
    'fresh-sender',
    businessConfig,
    'instagram-recipient',
  );
  const fresh = await turn(freshSession, 'fresh-sender', liveTurn1);
  assert.equal(fresh.handled, true);
  assert.equal(fresh.pending?.selectedDate, '2026-09-02');
  assert.notEqual(fresh.pending?.status, 'awaiting_service');
  assert.equal(boundary.recentCompletionState(freshSession).support, null);
  assert.ok(calls.calendarReads > 0);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  configure();
  const sameSenderSession = boundary.channelSessionId(
    'instagram',
    'same-sender',
    businessConfig,
    'instagram-recipient',
  );
  const differentSenderSession = boundary.channelSessionId(
    'instagram',
    'different-sender',
    businessConfig,
    'instagram-recipient',
  );
  assert.notEqual(sameSenderSession, differentSenderSession);
  boundary.seedRecentCompletedBooking(
    sameSenderSession,
    'en',
    completedOperation(sameSenderSession),
    30,
  );
  assert.equal(boundary.recentCompletionState(differentSenderSession).completed, null);
  assert.equal(
    boundary.recentCompletionClassification(sameSenderSession, liveTurn1, businessConfig, now)?.category,
    'new_booking',
  );
  const pivoted = await turn(sameSenderSession, 'same-sender', liveTurn1);
  assert.equal(pivoted.handled, true);
  assert.equal(pivoted.pending?.selectedDate, '2026-09-02');
  assert.equal(boundary.recentCompletionState(sameSenderSession).support, null);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);

  configure();
  const unusualSession = 'english-new-booking-invariant';
  boundary.seedRecentCompletedBooking(
    unusualSession,
    'en',
    completedOperation(unusualSession),
    30,
  );
  const unusual = boundary.recentCompletionClassification(
    unusualSession,
    'Could I schedule an appointment next Monday?',
    businessConfig,
    now,
  );
  assert.equal(unusual?.normalizedRequest.intent, 'new_booking');
  assert.equal(boundary.isExplicitNewBookingPivot('Could I schedule an appointment next Monday?'), false);
  assert.equal(unusual?.category, 'new_booking');

  configure();
  const exactTurn2 = await turn('english-instagram-live-turn-2', 'turn-2-sender', liveTurn2);
  assert.equal(exactTurn2.handled, true);
  assert.notEqual(exactTurn2.pending?.status, 'awaiting_service');
  assert.equal(exactTurn2.pending?.service, 'Video Consultation');
  assert.notEqual(exactTurn2.pending?.requestedService, 'one');
  assert.doesNotMatch(exactTurn2.replies.join(' '), /cannot match\s+[“"]?one|match [“"]one/iu);

  configure();
  const unsupported = await turn(
    'english-instagram-real-unsupported-service',
    'unsupported-sender',
    'Please book Deep Tissue Massage.',
  );
  assert.equal(unsupported.handled, true);
  assert.equal(unsupported.pending?.status, 'awaiting_service');
  assert.equal(unsupported.pending?.requestedService, 'Deep Tissue Massage');
  assert.match(unsupported.replies.join(' '), /Deep Tissue Massage/u);

  configure();
  const supportSession = 'english-instagram-genuine-business-support';
  boundary.seedRecentCompletedBooking(
    supportSession,
    'en',
    completedOperation(supportSession),
    30,
  );
  const supportTurn = await turn(
    supportSession,
    'support-sender',
    'What should I bring for the consultation?',
  );
  assert.equal(supportTurn.handled, false);
  assert.ok(boundary.recentCompletionState(supportSession).support);
  assert.equal(calls.groundingVerifier, 0);
  assert.equal(calls.entailment, 0);
  const grounded = await boundary.finalizeGeneralAiReply(
    supportSession,
    'What should I bring for the consultation?',
    'Customers should bring photo ID for a Video Consultation.',
    'en',
  );
  assert.equal(grounded, 'Customers should bring photo ID for a Video Consultation.');
  assert.equal(calls.groundingVerifier, 1);
  assert.equal(calls.entailment, 1);

  originalLog('English Instagram live-routing regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
