import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

type Language = 'sv' | 'de' | 'es' | 'ar' | 'en';

function businessConfig(language: Language, service: string) {
  return {
    id: `initial-mixed-${language}`,
    businessRecordId: `initial-mixed-${language}`,
    businessName: 'Initial Mixed Entity Clinic',
    language,
    timezone: 'Europe/Stockholm',
    services: [{ name: service, duration: 30 }],
  };
}

try {
  const englishEntity = 'Video Consultation';
  const initialTurns = [
    {
      language: 'es',
      text: `Quiero reservar ${englishEntity} mañana a las 16:00.`,
      config: businessConfig('en', englishEntity),
    },
    {
      language: 'de',
      text: `Ich möchte ${englishEntity} morgen um 16 Uhr buchen.`,
      config: businessConfig('en', englishEntity),
    },
    {
      language: 'sv',
      text: `Jag vill boka ${englishEntity} imorgon klockan 16:00.`,
      config: businessConfig('en', englishEntity),
    },
    {
      language: 'ar',
      text: `أريد حجز ${englishEntity} غدًا الساعة 16:00.`,
      config: businessConfig('en', englishEntity),
    },
    {
      language: 'en',
      text: 'I want to book Beratung Premium tomorrow at 16:00.',
      config: businessConfig('de', 'Beratung Premium'),
    },
  ] as const;

  for (const scenario of initialTurns) {
    boundary.reset();
    const resolved = boundary.resolveConversationLanguage(
      `initial-${scenario.language}`,
      scenario.text,
      scenario.config,
    );
    assert.equal(
      resolved,
      scenario.language,
      `${scenario.language}: natural-language evidence outranks the configured entity`,
    );
  }

  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getEvents: async () => [],
      checkSlots: () => ({ available_slots_string: '' }),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  const spanishConfig = {
    ...businessConfig('en', englishEntity),
    calendarProvider: 'custom',
    defaultBookingService: englishEntity,
  };
  const spanishAvailability = await boundary.turn({
    sessionId: 'initial-spanish-availability',
    platformName: 'messenger',
    recipientUserId: 'initial-spanish-user',
    text: `Quiero reservar ${englishEntity} mañana a las 16:00.`,
    businessConfig: spanishConfig,
  });
  assert.equal(spanishAvailability.handled, true);
  assert.equal(spanishAvailability.pending?.language, 'es');
  assert.equal(boundary.conversationState('initial-spanish-availability').availability?.language, 'es');
  assert.match(spanishAvailability.replies[0], /(?:Sí|Lo siento|Tengo estas horas)/u);
  assert.doesNotMatch(spanishAvailability.replies[0], /(?:Yes|Sorry|I found these times)/u);

  boundary.reset();
  const entityOnlyConfig = businessConfig('de', englishEntity);
  assert.equal(
    boundary.detectStrongLanguage(englishEntity, entityOnlyConfig),
    null,
    'an entity-only initial turn does not invent strong grammatical confidence',
  );
  assert.equal(
    boundary.resolveConversationLanguage('entity-only', englishEntity, entityOnlyConfig),
    'en',
    'an entity-only initial turn preserves the existing safe fallback',
  );

  boundary.reset();
  const switchConfig = businessConfig('de', englishEntity);
  boundary.seedFlowLanguage('explicit-switch', 'de', 'booking');
  assert.equal(
    boundary.resolveConversationLanguage(
      'explicit-switch',
      `Please continue this booking for ${englishEntity} in English.`,
      switchConfig,
    ),
    'en',
    'a genuine explicit language switch remains authoritative',
  );

  originalLog('initial-turn mixed-entity language regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
