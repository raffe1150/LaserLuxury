import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const configuredService = 'Premium Consultation';
const businessConfig = {
  id: 'pending-language-entity-selection',
  businessRecordId: 'pending-language-entity-selection',
  businessName: 'Configured Services Clinic',
  language: 'en',
  timezone: 'Europe/Stockholm',
  services: [{ name: configuredService, duration: 30 }],
};

function seedActiveBooking(sessionId: string, language: string) {
  boundary.seedPending(sessionId, {
    businessConfig,
    service: 'Bokning',
    requestedService: 'Unsupported Service',
    requestedTime: '16:00',
    language,
    operation: 'new_booking',
    expectedInput: 'service',
    status: 'awaiting_service',
  });
  boundary.seedFlowLanguage(sessionId, language, 'booking');
}

try {
  const entitySelections = [
    { language: 'de', text: `Dann nehme ich ${configuredService}.` },
    { language: 'sv', text: `Jag väljer ${configuredService}.` },
    { language: 'es', text: `Elijo ${configuredService}.` },
  ] as const;

  for (const { language, text } of entitySelections) {
    boundary.reset();
    const sessionId = `entity-selection-${language}`;
    seedActiveBooking(sessionId, language);

    const resolved = boundary.resolveConversationLanguage(
      sessionId,
      text,
      businessConfig,
    );
    const state = boundary.conversationState(sessionId);

    assert.equal(resolved, language, `${language}: configured entity selection keeps active language`);
    assert.equal(state.language, language, `${language}: flow language is not overwritten`);
    assert.equal(state.pending?.language, language, `${language}: pending language is not overwritten`);
  }

  boundary.reset();
  seedActiveBooking('genuine-switch', 'de');
  const switched = boundary.resolveConversationLanguage(
    'genuine-switch',
    'I would like to continue this booking now, please.',
    businessConfig,
  );
  assert.equal(switched, 'en', 'a clear natural-language switch remains possible');
  assert.equal(boundary.conversationState('genuine-switch').language, 'en');
  assert.equal(boundary.conversationState('genuine-switch').pending?.language, 'en');

  boundary.reset();
  const normalEnglish = boundary.resolveConversationLanguage(
    'normal-english',
    'I would like to book an appointment tomorrow.',
    businessConfig,
  );
  assert.equal(normalEnglish, 'en', 'normal English detection is unchanged without active state');

  originalLog('pending-language entity-selection regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
