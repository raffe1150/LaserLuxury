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
    assessBusinessSupportGrounding: ({ candidateReply, evidenceCorpus }: any) => {
      const supportedEvidence = [
        'For Video Consultation, bring photo ID and prepare your campaign goals.',
        'Parking is available behind the studio.',
      ].find((quote) => evidenceCorpus.includes(quote) && (
        candidateReply.includes('photo ID') ||
        candidateReply.includes('legitimation') ||
        candidateReply.toLowerCase().includes('parking is available')
      ));
      if (supportedEvidence) {
        return {
          hasBusinessFactualClaims: true,
          claims: [{
            claim: candidateReply,
            requiresBusinessEvidence: true,
            supported: true,
            evidence: [{ source: 'business_system_prompt', quote: supportedEvidence }],
          }],
          allBusinessClaimsSupported: true,
        };
      }
      if (candidateReply === 'Happy to help.') {
        return {
          hasBusinessFactualClaims: false,
          claims: [],
          allBusinessClaimsSupported: true,
        };
      }
      return {
        hasBusinessFactualClaims: true,
        claims: [{
          claim: candidateReply,
          requiresBusinessEvidence: true,
          supported: false,
          evidence: [],
        }],
        allBusinessClaimsSupported: false,
      };
    },
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
  config: any = businessConfig,
) => {
  seedCompleted(sessionId, language, platformName);
  const result = await boundary.turn({
    sessionId,
    platformName,
    recipientUserId: sessionId,
    text,
    inputMode: 'text',
    businessConfig: config,
    now: new Date('2026-09-01T12:00:00+02:00'),
  });
  assert.equal(result.handled, false);
  assert.equal(result.pending, null);
  assert.ok(boundary.recentCompletionState(sessionId).support);
  assert.deepEqual(boundary.geminiToolNames(sessionId), ['logSystemAnalysis']);
  assert.match(boundary.completedSupportInstruction(sessionId), /READ-ONLY VERIFIED COMPLETION CONTEXT/u);
  assert.match(boundary.completedSupportInstruction(sessionId), /Silence is not evidence/u);
};

try {
  configure();
  const swedishSession = 'support-response-sv';
  const swedishQuestion = 'Behöver jag ta med eller förbereda något särskilt inför konsultationen?';
  await enterBusinessSupport(swedishSession, 'sv', 'whatsapp', swedishQuestion);
  const unsupportedSwedish = 'Du behöver inte förbereda något. Ha bara dina marknadsföringsmål redo.';
  const rejectedSwedish = await boundary.finalizeGeneralAiReply(
    swedishSession,
    swedishQuestion,
    unsupportedSwedish,
    'sv',
  );
  assert.match(rejectedSwedish, /ingen specifik uppgift|tillgängliga information/u);
  assert.doesNotMatch(rejectedSwedish, /behöver inte|marknadsföringsmål/u);

  const swedishGap = await boundary.finalizeGeneralAiReply(
    swedishSession,
    swedishQuestion,
    'Hej 🙂 Hur kan jag hjälpa dig?',
    'sv',
  );
  assert.match(swedishGap, /ingen specifik uppgift|tillgängliga information/u);
  assert.match(swedishGap, /Video Consultation/u);
  assert.doesNotMatch(swedishGap, /ta med|förbereda|marknadsföringsmål/iu);
  assert.doesNotMatch(swedishGap, /Hur kan jag hjälpa dig/u);
  const wrongLanguageGreetingGap = await boundary.finalizeGeneralAiReply(
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
  const englishGap = await boundary.finalizeGeneralAiReply(
    englishSession,
    englishQuestion,
    'Hi, how can I help?',
    'en',
  );
  assert.match(englishGap, /can't find a specific answer/u);
  assert.doesNotMatch(englishGap, /how can I help/iu);

  for (const unsupported of [
    'No preparation is required.',
    "We don't require any documents.",
    "You don't need to bring anything. Just be ready to discuss your needs!",
  ]) {
    const rejected = await boundary.finalizeGeneralAiReply(
      englishSession,
      englishQuestion,
      unsupported,
      'en',
    );
    assert.match(rejected, /can't find a specific answer/u, unsupported);
    assert.notEqual(rejected, unsupported);
  }

  configure();
  const supportedConfig = {
    ...businessConfig,
    systemPrompt: [
      businessConfig.systemPrompt,
      'For Video Consultation, bring photo ID and prepare your campaign goals.',
    ].join('\n'),
  };
  const supportedEnglishSession = 'support-response-grounded-en';
  await enterBusinessSupport(
    supportedEnglishSession,
    'en',
    'instagram',
    englishQuestion,
    supportedConfig,
  );
  const supportedEnglish = 'Please bring photo ID and have your campaign goals ready.';
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      supportedEnglishSession,
      englishQuestion,
      supportedEnglish,
      'en',
    ),
    supportedEnglish,
  );

  configure();
  const supportedSwedishSession = 'support-response-grounded-sv';
  await enterBusinessSupport(
    supportedSwedishSession,
    'sv',
    'instagram',
    swedishQuestion,
    supportedConfig,
  );
  const supportedSwedish = 'Ta med legitimation och ha dina kampanjmål redo.';
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      supportedSwedishSession,
      swedishQuestion,
      supportedSwedish,
      'sv',
    ),
    supportedSwedish,
  );

  configure();
  const parkingQuestion = 'Is parking available at the studio?';
  const parkingSession = 'support-response-parking-absent';
  await enterBusinessSupport(parkingSession, 'en', 'instagram', parkingQuestion);
  const inventedParking = 'Yes, parking is available behind the studio.';
  const rejectedParking = await boundary.finalizeGeneralAiReply(
    parkingSession,
    parkingQuestion,
    inventedParking,
    'en',
  );
  assert.match(rejectedParking, /can't find a specific answer/u);

  boundary.configure({
    assessBusinessSupportGrounding: ({ candidateReply }: any) => ({
      hasBusinessFactualClaims: true,
      claims: [{
        claim: candidateReply,
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{
          source: 'business_system_prompt',
          quote: 'Parking is available behind the studio.',
        }],
      }],
      allBusinessClaimsSupported: true,
    }),
  });
  const rejectedFabricatedCitation = await boundary.finalizeGeneralAiReply(
    parkingSession,
    parkingQuestion,
    inventedParking,
    'en',
  );
  assert.match(rejectedFabricatedCitation, /can't find a specific answer/u);

  configure();
  const parkingConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nParking is available behind the studio.`,
  };
  const groundedParkingSession = 'support-response-parking-present';
  await enterBusinessSupport(
    groundedParkingSession,
    'en',
    'instagram',
    parkingQuestion,
    parkingConfig,
  );
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      groundedParkingSession,
      parkingQuestion,
      inventedParking,
      'en',
    ),
    inventedParking,
  );

  const beforeHarmless = boundary.recentCompletionState(groundedParkingSession).completed;
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      groundedParkingSession,
      'Thank you.',
      'Happy to help.',
      'en',
    ),
    'Happy to help.',
  );
  assert.deepEqual(
    boundary.recentCompletionState(groundedParkingSession).completed,
    beforeHarmless,
  );
  assert.equal(boundary.pendingStateSnapshot(groundedParkingSession), null);

  configure();
  const spanishSession = 'support-response-es';
  const spanishQuestion = '¿Necesito llevar o preparar algo para la consulta?';
  await enterBusinessSupport(spanishSession, 'es', 'instagram', spanishQuestion);
  const spanishGap = await boundary.finalizeGeneralAiReply(
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
  const ordinaryGreeting = await boundary.finalizeGeneralAiReply(
    ordinarySession,
    'Hej',
    'Hej 😊 Hur kan jag hjälpa dig?',
    'sv',
  );
  assert.equal(ordinaryGreeting, 'Hej 😊 Hur kan jag hjälpa dig?');

  const ordinaryAnswer = 'Det här är ett vanligt längre svar som upprepas exakt för att repetitionstestet ska aktiveras.';
  assert.equal(
    await boundary.finalizeGeneralAiReply(ordinarySession, 'Berätta mer.', ordinaryAnswer, 'sv'),
    ordinaryAnswer,
  );
  assert.equal(
    await boundary.finalizeGeneralAiReply(ordinarySession, 'Berätta mer.', ordinaryAnswer, 'sv'),
    'Hej 😊 Hur kan jag hjälpa dig?',
  );
} finally {
  boundary.reset();
  console.warn = originalWarn;
}

console.log('Post-completion business-support response regressions passed');
