import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalWarn = console.warn;
console.warn = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const calls = { availability: 0, calendarReads: 0, bookingMutations: 0, databaseMutations: 0 };
const businessConfig = {
  id: 'post-completion-support-response-business',
  businessName: 'Support Response Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'post-completion-support-response-calendar',
  systemPrompt: 'Answer business questions using only the configured business information.',
  services: [{ name: 'Video Consultation', durationMinutes: 30 }],
};

const configure = () => {
  boundary.reset();
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'post-completion-support-response-calendar',
      checkSlots: async () => { calls.availability += 1; return { available_slots_string: '' }; },
      getEvents: async () => { calls.calendarReads += 1; return []; },
      insertAppointment: async () => { calls.bookingMutations += 1; return { success: false }; },
    },
    recordAppointment: async () => { calls.databaseMutations += 1; return null; },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  });
};

const seedCompleted = (sessionId: string, language: string, sourceChannel: string) => {
  boundary.seedRecentCompletedBooking(sessionId, language, {
    ok: true,
    bookingId: `booking-${sessionId}`,
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-02T14:00:00+02:00',
    customerName: 'Alex Testsson',
    customerPhone: '0701234567',
    sourceChannel,
  }, 30);
};

const enterBusinessSupport = async (
  sessionId: string,
  language: string,
  platformName: 'whatsapp' | 'instagram' | 'messenger',
  text: string,
) => {
  seedCompleted(sessionId, language, platformName);
  const result = await boundary.turn({
    sessionId,
    platformName,
    recipientUserId: sessionId,
    text,
    inputMode: 'text',
    businessConfig,
    now: new Date('2026-09-01T12:00:00+02:00'),
  });
  assert.equal(result.handled, false);
  assert.equal(result.pending, null);
  assert.ok(boundary.recentCompletionState(sessionId).support);
  assert.deepEqual(boundary.geminiToolNames(sessionId), ['logSystemAnalysis']);
  assert.match(boundary.completedSupportInstruction(sessionId), /READ-ONLY VERIFIED COMPLETION CONTEXT/u);
};

try {
  configure();
  const swedishSession = 'support-response-sv';
  const swedishQuestion = 'Behöver jag ta med eller förbereda något särskilt inför konsultationen?';
  await enterBusinessSupport(swedishSession, 'sv', 'whatsapp', swedishQuestion);
  const relevantSwedish = 'För din Video Consultation kan det vara bra att ha dina frågor om marknadsföringsmål redo.';
  for (let turn = 0; turn < 3; turn += 1) {
    const finalReply = boundary.finalizeGeneralAiReply(
      swedishSession,
      swedishQuestion,
      relevantSwedish,
      'sv',
    );
    assert.equal(finalReply, relevantSwedish);
    assert.doesNotMatch(finalReply, /Hur kan jag hjälpa dig/u);
  }

  const swedishGap = boundary.finalizeGeneralAiReply(
    swedishSession,
    swedishQuestion,
    'Hej 🙂 Hur kan jag hjälpa dig?',
    'sv',
  );
  assert.match(swedishGap, /ingen specifik uppgift|tillgängliga information/u);
  assert.match(swedishGap, /Video Consultation/u);
  assert.doesNotMatch(swedishGap, /ta med|förbereda|marknadsföringsmål/iu);
  assert.doesNotMatch(swedishGap, /Hur kan jag hjälpa dig/u);
  const wrongLanguageGreetingGap = boundary.finalizeGeneralAiReply(
    swedishSession,
    swedishQuestion,
    'Hi, how can I help?',
    'sv',
  );
  assert.match(wrongLanguageGreetingGap, /ingen specifik uppgift|tillgängliga information/u);
  assert.doesNotMatch(wrongLanguageGreetingGap, /Vad vill du veta|Hur kan jag hjälpa dig/u);

  configure();
  const englishSession = 'support-response-en';
  const englishQuestion = 'Do I need to bring or prepare anything for the consultation?';
  await enterBusinessSupport(englishSession, 'en', 'messenger', englishQuestion);
  const englishGap = boundary.finalizeGeneralAiReply(
    englishSession,
    englishQuestion,
    'Hi, how can I help?',
    'en',
  );
  assert.match(englishGap, /can't find a specific answer/u);
  assert.doesNotMatch(englishGap, /how can I help/iu);

  configure();
  const spanishSession = 'support-response-es';
  const spanishQuestion = '¿Necesito llevar o preparar algo para la consulta?';
  await enterBusinessSupport(spanishSession, 'es', 'instagram', spanishQuestion);
  const spanishGap = boundary.finalizeGeneralAiReply(
    spanishSession,
    spanishQuestion,
    'Hola, ¿en qué puedo ayudarte?',
    'es',
  );
  assert.match(spanishGap, /No encuentro información específica/u);
  assert.doesNotMatch(spanishGap, /puedo ayudarte/iu);

  assert.deepEqual(calls, {
    availability: 0,
    calendarReads: 0,
    bookingMutations: 0,
    databaseMutations: 0,
  });

  configure();
  const ordinarySession = 'ordinary-repetition-outside-support';
  const ordinaryGreeting = boundary.finalizeGeneralAiReply(
    ordinarySession,
    'Hej',
    'Hej 😊 Hur kan jag hjälpa dig?',
    'sv',
  );
  assert.equal(ordinaryGreeting, 'Hej 😊 Hur kan jag hjälpa dig?');

  const ordinaryAnswer = 'Det här är ett vanligt längre svar som upprepas exakt för att repetitionstestet ska aktiveras.';
  assert.equal(
    boundary.finalizeGeneralAiReply(ordinarySession, 'Berätta mer.', ordinaryAnswer, 'sv'),
    ordinaryAnswer,
  );
  assert.equal(
    boundary.finalizeGeneralAiReply(ordinarySession, 'Berätta mer.', ordinaryAnswer, 'sv'),
    'Hej 😊 Hur kan jag hjälpa dig?',
  );
} finally {
  boundary.reset();
  console.warn = originalWarn;
}

console.log('Post-completion business-support response regressions passed');
