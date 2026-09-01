import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => undefined;
console.warn = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const now = new Date("2026-09-01T12:00:00+02:00");
const businessConfig = {
  id: "recent-completion-language-business",
  businessName: "Recent Completion Language Clinic",
  timezone: "Europe/Stockholm",
  systemPrompt: "Customers should bring identification.",
  calendarProvider: "custom",
  googleCalendarId: "recent-completion-language-calendar",
  services: [{ name: "Video Consultation", durationMinutes: 60 }],
};

const calls = {
  availability: 0,
  calendarReads: 0,
  bookingMutations: 0,
  databaseMutations: 0,
};

const configure = () => {
  boundary.reset();
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => "recent-completion-language-calendar",
      checkSlots: async () => { calls.availability += 1; return { available_slots_string: "" }; },
      getEvents: async () => { calls.calendarReads += 1; return []; },
      insertAppointment: async () => { calls.bookingMutations += 1; return { success: false }; },
    },
    recordAppointment: async () => { calls.databaseMutations += 1; return null; },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  });
};

const seedSwedishCompletion = (sessionId: string) => {
  boundary.seedRecentCompletedBooking(sessionId, "sv", {
    ok: true,
    bookingId: `booking-${sessionId}`,
    businessId: businessConfig.id,
    serviceName: "Video Consultation",
    startTime: "2026-09-02T19:30:00+02:00",
    customerName: "Alex Testsson",
    customerPhone: "0701234567",
    sourceChannel: "instagram",
  }, 60);
};

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: "instagram",
  recipientUserId: sessionId,
  text,
  inputMode: "text",
  businessConfig,
  now,
});

const assertReadOnly = () => assert.deepEqual(calls, {
  availability: 0,
  calendarReads: 0,
  bookingMutations: 0,
  databaseMutations: 0,
});

try {
  configure();
  const requirementsSession = "swedish-completion-english-requirements";
  seedSwedishCompletion(requirementsSession);
  const requirements = await turn(
    requirementsSession,
    "Perfect, thanks. Do you need any other information or confirmation from me?",
  );
  assert.equal(requirements.handled, true);
  assert.equal(
    requirements.replies[0],
    "Nothing else is needed for the booking. It is verified and your contact details are recorded.",
  );
  assertReadOnly();

  configure();
  const identitySession = "swedish-completion-english-identity";
  seedSwedishCompletion(identitySession);
  const identity = await turn(
    identitySession,
    "No, I don't think so. My name is Alex Testsson and my phone number is 0701234567.",
  );
  assert.equal(identity.handled, false);
  assert.equal(boundary.conversationState(identitySession).language, "en");
  const identityReply = boundary.finalizeGeneralAiReply(
    identitySession,
    "No, I don't think so. My name is Alex Testsson and my phone number is 0701234567.",
    "Hello, what would you like to know?",
    "en",
  );
  assert.match(identityReply, /I can't find a specific answer/u);
  assert.doesNotMatch(identityReply, /Jag hittar|svenska/u);
  assertReadOnly();

  configure();
  const supportSession = "swedish-completion-english-support";
  seedSwedishCompletion(supportSession);
  const support = await turn(
    supportSession,
    "Do I need to bring or prepare anything specific for the consultation?",
  );
  assert.equal(support.handled, false);
  assert.equal(boundary.conversationState(supportSession).language, "en");
  const supportReply = boundary.finalizeGeneralAiReply(
    supportSession,
    "Do I need to bring or prepare anything specific for the consultation?",
    "Customers should bring identification.",
    "en",
  );
  assert.equal(supportReply, "Customers should bring identification.");
  assertReadOnly();

  configure();
  const statusSession = "swedish-completion-english-status";
  seedSwedishCompletion(statusSession);
  const status = await turn(
    statusSession,
    "Is my appointment confirmed, and what name and phone number is it registered under?",
  );
  assert.equal(status.handled, true);
  assert.match(status.replies[0], /^Yes, the booking is verified\./u);
  assert.match(status.replies[0], /Alex Testsson/u);
  assert.match(status.replies[0], /0701234567/u);
  assert.doesNotMatch(status.replies[0], /Ja, bokningen|Namn:|Telefon:/u);
  const completed = boundary.recentCompletionState(statusSession).completed;
  assert.equal(completed.language, "sv");
  assert.equal(completed.bookingOperation.serviceName, "Video Consultation");
  assert.equal(completed.bookingOperation.startTime, "2026-09-02T19:30:00+02:00");
  assertReadOnly();

  configure();
  const ambiguousSession = "swedish-completion-ambiguous-thanks";
  seedSwedishCompletion(ambiguousSession);
  const ambiguous = await turn(ambiguousSession, "Thanks.");
  assert.equal(ambiguous.handled, true);
  assert.match(ambiguous.replies[0], /^(?:Varsågod|Tack)/u);
  assertReadOnly();

  assert.equal(
    boundary.extractConcreteRequestedService("Hello, I'd like to book an appointment for tomorrow."),
    null,
  );
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
}

console.log("Recent-completion presentation-language regressions passed.");
