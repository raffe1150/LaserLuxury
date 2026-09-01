import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalWarn = console.warn;
console.warn = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const calls = { availability: 0, calendarReads: 0, bookingMutations: 0, databaseMutations: 0 };
let groundingAssessmentOverride: ((request: any) => any) | null = null;
let entailmentAssessmentOverride: ((request: any) => any) | null = null;
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
  groundingAssessmentOverride = null;
  entailmentAssessmentOverride = null;
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
      if (groundingAssessmentOverride) {
        return groundingAssessmentOverride({ candidateReply, evidenceCorpus });
      }
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
            candidateQuote: candidateReply,
            claimKind: /\b(?:no|not|don't|doesn't|isn't|aren't|behöver inte|ingen|inga)\b/iu.test(candidateReply)
              ? 'NEGATIVE_ABSENCE'
              : 'OTHER',
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
          candidateQuote: candidateReply,
          claimKind: /\b(?:no|not|don't|doesn't|isn't|aren't|behöver inte|ingen|inga)\b/iu.test(candidateReply)
            ? 'NEGATIVE_ABSENCE'
            : 'OTHER',
          requiresBusinessEvidence: true,
          supported: false,
          evidence: [],
        }],
        allBusinessClaimsSupported: false,
      };
    },
    assessBusinessClaimEntailment: (request: any) => entailmentAssessmentOverride
      ? entailmentAssessmentOverride(request)
      : ({
          relation: 'ENTAILED',
          claimKind: request.claimKind,
          explicitAbsenceEvidence: request.claimKind === 'NEGATIVE_ABSENCE',
        }),
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
  const nullEvidenceConfig = {
    ...businessConfig,
    services: [{
      name: 'Video Consultation',
      durationMinutes: 30,
      preparation: null,
      requirements: null,
      description: '',
    }],
    workingHours: {},
  };
  const nullEvidenceSession = 'support-response-null-is-unknown-en';
  await enterBusinessSupport(
    nullEvidenceSession,
    'en',
    'instagram',
    englishQuestion,
    nullEvidenceConfig,
  );
  const nullSnapshot = boundary.completedSupportGroundingEvidence(nullEvidenceSession);
  assert.ok(nullSnapshot);
  assert.doesNotMatch(nullSnapshot.sources.structured_business_config, /"preparation"|"requirements"|"description"|"workingHours"/u);
  assert.doesNotMatch(nullSnapshot.sources.structured_business_config, /:\s*null\b/u);
  groundingAssessmentOverride = ({ candidateReply }: any) => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: 'No preparation is required for Video Consultation.',
      candidateQuote: candidateReply,
      claimKind: 'NEGATIVE_ABSENCE',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{ source: 'structured_business_config', quote: '"preparation": null' }],
    }],
    allBusinessClaimsSupported: true,
  });
  const nullRejected = await boundary.finalizeGeneralAiReply(
    nullEvidenceSession,
    englishQuestion,
    'No preparation is required.',
    'en',
  );
  assert.match(nullRejected, /can't find a specific answer/u);

  configure();
  const nullEvidenceSwedishSession = 'support-response-null-is-unknown-sv';
  await enterBusinessSupport(
    nullEvidenceSwedishSession,
    'sv',
    'instagram',
    swedishQuestion,
    nullEvidenceConfig,
  );
  const nullSwedishSnapshot = boundary.completedSupportGroundingEvidence(
    nullEvidenceSwedishSession,
  );
  assert.ok(nullSwedishSnapshot);
  assert.doesNotMatch(
    nullSwedishSnapshot.sources.structured_business_config,
    /"preparation"|"requirements"|:\s*null\b/u,
  );
  const nullSwedishRejected = await boundary.finalizeGeneralAiReply(
    nullEvidenceSwedishSession,
    swedishQuestion,
    'Ingen förberedelse krävs.',
    'sv',
  );
  assert.match(nullSwedishRejected, /ingen specifik uppgift|tillgängliga information/u);

  configure();
  const omittedEvidenceSession = 'support-response-field-omitted-en';
  await enterBusinessSupport(
    omittedEvidenceSession,
    'en',
    'instagram',
    englishQuestion,
  );
  const beforeRejectedSupport = boundary.recentCompletionState(omittedEvidenceSession).completed;
  const omittedRejected = await boundary.finalizeGeneralAiReply(
    omittedEvidenceSession,
    englishQuestion,
    "You don't need to prepare anything.",
    'en',
  );
  assert.match(omittedRejected, /can't find a specific answer/u);
  assert.deepEqual(
    boundary.recentCompletionState(omittedEvidenceSession).completed,
    beforeRejectedSupport,
  );
  assert.equal(boundary.pendingStateSnapshot(omittedEvidenceSession), null);
  for (const deterministicCheck of [
    { text: 'Is my booking confirmed?', expected: /confirmed|verified/iu },
    { text: 'Is my appointment confirmed with my name and phone?', expected: /Alex Testsson.*0701234567|0701234567.*Alex Testsson/iu },
    { text: 'What service did I book?', expected: /Video Consultation/u },
    { text: 'What time did I book?', expected: /14:00/u },
  ]) {
    const deterministic = await boundary.turn({
      sessionId: omittedEvidenceSession,
      platformName: 'instagram',
      recipientUserId: omittedEvidenceSession,
      text: deterministicCheck.text,
      inputMode: 'text',
      businessConfig,
      now: new Date('2026-09-01T12:00:00+02:00'),
    });
    assert.equal(deterministic.handled, true, deterministicCheck.text);
    assert.equal(deterministic.pending, null, deterministicCheck.text);
    assert.match(deterministic.replies.join(' '), deterministicCheck.expected, deterministicCheck.text);
  }

  configure();
  const exactLiveSession = 'support-response-exact-live-compound-en';
  await enterBusinessSupport(exactLiveSession, 'en', 'instagram', englishQuestion, nullEvidenceConfig);
  const exactLiveCandidate = "I'm Emily, AdMotion Studio's AI receptionist. For your video consultation, you don't need to prepare anything specific, but if you have any existing brand details or marketing goals in mind, feel free to have them ready.";
  groundingAssessmentOverride = () => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: "you don't need to prepare anything specific for your video consultation",
      candidateQuote: "For your video consultation, you don't need to prepare anything specific",
      claimKind: 'NEGATIVE_ABSENCE',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'structured_business_config',
        quote: '"name": "Video Consultation"',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  const exactLiveRejected = await boundary.finalizeGeneralAiReply(
    exactLiveSession,
    englishQuestion,
    exactLiveCandidate,
    'en',
  );
  assert.match(exactLiveRejected, /can't find a specific answer/u);
  assert.notEqual(exactLiveRejected, exactLiveCandidate);

  configure();
  const negativeEvidenceGateConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nVideo Consultation is a service offered by the business.`,
  };
  const negativeEvidenceGateSession = 'support-response-negative-explicit-evidence-en';
  await enterBusinessSupport(
    negativeEvidenceGateSession,
    'en',
    'instagram',
    englishQuestion,
    negativeEvidenceGateConfig,
  );
  groundingAssessmentOverride = ({ candidateReply }: any) => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: candidateReply,
      candidateQuote: candidateReply,
      claimKind: 'NEGATIVE_ABSENCE',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'business_system_prompt',
        quote: 'Video Consultation is a service offered by the business.',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  entailmentAssessmentOverride = () => ({
    relation: 'ENTAILED',
    claimKind: 'OTHER',
    explicitAbsenceEvidence: false,
  });
  assert.match(
    await boundary.finalizeGeneralAiReply(
      negativeEvidenceGateSession,
      englishQuestion,
      'No preparation is required.',
      'en',
    ),
    /can't find a specific answer/u,
  );

  configure();
  const explicitNegativeConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nNo preparation is required for Video Consultation.`,
  };
  const explicitNegativeSession = 'support-response-explicit-negative-en';
  await enterBusinessSupport(
    explicitNegativeSession,
    'en',
    'instagram',
    englishQuestion,
    explicitNegativeConfig,
  );
  const explicitNegativeAnswer = "You don't need to prepare anything for your Video Consultation.";
  groundingAssessmentOverride = ({ candidateReply }: any) => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: 'No preparation is required for Video Consultation.',
      candidateQuote: candidateReply,
      claimKind: 'NEGATIVE_ABSENCE',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'business_system_prompt',
        quote: 'No preparation is required for Video Consultation.',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      explicitNegativeSession,
      englishQuestion,
      explicitNegativeAnswer,
      'en',
    ),
    explicitNegativeAnswer,
  );

  configure();
  const explicitNegativeSwedishConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nIngen förberedelse krävs för videokonsultationen.`,
  };
  const explicitNegativeSwedishSession = 'support-response-explicit-negative-sv';
  await enterBusinessSupport(
    explicitNegativeSwedishSession,
    'sv',
    'instagram',
    swedishQuestion,
    explicitNegativeSwedishConfig,
  );
  const explicitNegativeSwedishAnswer = 'Du behöver inte förbereda något inför videokonsultationen.';
  groundingAssessmentOverride = ({ candidateReply }: any) => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: 'Ingen förberedelse krävs för videokonsultationen.',
      candidateQuote: candidateReply,
      claimKind: 'NEGATIVE_ABSENCE',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'business_system_prompt',
        quote: 'Ingen förberedelse krävs för videokonsultationen.',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      explicitNegativeSwedishSession,
      swedishQuestion,
      explicitNegativeSwedishAnswer,
      'sv',
    ),
    explicitNegativeSwedishAnswer,
  );

  configure();
  const partialCoverageSession = 'support-response-partial-coverage-en';
  const multiFactConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nParking is available behind the studio.`,
  };
  const multiFactQuestion = 'Is parking available and can I pay by card?';
  await enterBusinessSupport(
    partialCoverageSession,
    'en',
    'instagram',
    multiFactQuestion,
    multiFactConfig,
  );
  groundingAssessmentOverride = () => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: 'Parking is available behind the studio.',
      candidateQuote: 'Parking is available behind the studio',
      claimKind: 'OTHER',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'business_system_prompt',
        quote: 'Parking is available behind the studio.',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  const partialCoverageRejected = await boundary.finalizeGeneralAiReply(
    partialCoverageSession,
    multiFactQuestion,
    'Parking is available behind the studio, and we accept card payments.',
    'en',
  );
  assert.match(partialCoverageRejected, /can't find a specific answer/u);

  configure();
  const wrongWorkflowConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nTo begin the FREE SAMPLE workflow, send brand details and marketing goals.`,
  };
  const wrongWorkflowSession = 'support-response-wrong-workflow-en';
  await enterBusinessSupport(
    wrongWorkflowSession,
    'en',
    'instagram',
    englishQuestion,
    wrongWorkflowConfig,
  );
  const wrongWorkflowCandidate = 'For your Video Consultation, prepare your brand details and marketing goals.';
  groundingAssessmentOverride = ({ candidateReply }: any) => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: candidateReply,
      candidateQuote: candidateReply,
      claimKind: 'OTHER',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'business_system_prompt',
        quote: 'To begin the FREE SAMPLE workflow, send brand details and marketing goals.',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  entailmentAssessmentOverride = () => ({
    relation: 'NOT_APPLICABLE',
    claimKind: 'OTHER',
    explicitAbsenceEvidence: false,
  });
  assert.match(
    await boundary.finalizeGeneralAiReply(
      wrongWorkflowSession,
      englishQuestion,
      wrongWorkflowCandidate,
      'en',
    ),
    /can't find a specific answer/u,
  );

  configure();
  const wrongServiceConfig = {
    ...businessConfig,
    systemPrompt: `${businessConfig.systemPrompt}\nFor In-Person Audit, bring photo ID.`,
    services: [
      ...businessConfig.services,
      { name: 'In-Person Audit', durationMinutes: 45 },
    ],
  };
  const wrongServiceSession = 'support-response-wrong-service-en';
  await enterBusinessSupport(
    wrongServiceSession,
    'en',
    'instagram',
    englishQuestion,
    wrongServiceConfig,
  );
  const wrongServiceCandidate = 'For your Video Consultation, bring photo ID.';
  groundingAssessmentOverride = ({ candidateReply }: any) => ({
    hasBusinessFactualClaims: true,
    claims: [{
      claim: candidateReply,
      candidateQuote: candidateReply,
      claimKind: 'OTHER',
      requiresBusinessEvidence: true,
      supported: true,
      evidence: [{
        source: 'business_system_prompt',
        quote: 'For In-Person Audit, bring photo ID.',
      }],
    }],
    allBusinessClaimsSupported: true,
  });
  entailmentAssessmentOverride = () => ({
    relation: 'NOT_APPLICABLE',
    claimKind: 'OTHER',
    explicitAbsenceEvidence: false,
  });
  assert.match(
    await boundary.finalizeGeneralAiReply(
      wrongServiceSession,
      englishQuestion,
      wrongServiceCandidate,
      'en',
    ),
    /can't find a specific answer/u,
  );

  configure();
  const otherDomainsSession = 'support-response-other-domains-en';
  await enterBusinessSupport(
    otherDomainsSession,
    'en',
    'instagram',
    'What should I know before the consultation?',
  );
  for (const unsupported of [
    'Parking is not required.',
    'We do not charge a cancellation fee.',
    'You can pay by card.',
    'You do not need to bring documents.',
  ]) {
    const rejected = await boundary.finalizeGeneralAiReply(
      otherDomainsSession,
      'What should I know before the consultation?',
      unsupported,
      'en',
    );
    assert.match(rejected, /can't find a specific answer/u, unsupported);
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

  groundingAssessmentOverride = ({ candidateReply }: any) => ({
      hasBusinessFactualClaims: true,
      claims: [{
        claim: candidateReply,
        candidateQuote: candidateReply,
        claimKind: 'OTHER',
        requiresBusinessEvidence: true,
        supported: true,
        evidence: [{
          source: 'business_system_prompt',
          quote: 'Parking is available behind the studio.',
        }],
      }],
      allBusinessClaimsSupported: true,
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
  groundingAssessmentOverride = () => ({
    hasBusinessFactualClaims: false,
    claims: [],
    allBusinessClaimsSupported: true,
  });
  assert.equal(
    await boundary.finalizeGeneralAiReply(
      groundedParkingSession,
      'Could we discuss something else?',
      'Certainly, please tell me more.',
      'en',
    ),
    'Certainly, please tell me more.',
  );

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
