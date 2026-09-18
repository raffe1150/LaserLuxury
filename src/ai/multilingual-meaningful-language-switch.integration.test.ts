import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { priority1hUnifiedEngineTestBoundary } = await import('../../server');

const boundary = priority1hUnifiedEngineTestBoundary;

boundary.reset();

const businessConfig = {
  id: 3,
  businessRecordId: 3,
  language: 'en',
  timezone: 'Europe/Stockholm',
  services: [
    { name: 'Video Consultation' },
    { name: 'Reklam' },
  ],
};

const sessionId = 'meaningful-language-switch-sequence';

const sequence = [
  ['What services are available?', 'en'],
  ['Vilka tjänster finns tillgängliga?', 'sv'],
  ['Welche Dienstleistungen sind verfügbar?', 'de'],
  ['¿Qué servicios están disponibles?', 'es'],
  ['چه خدماتی ارائه می‌دهید؟', 'fa'],
  ['ما الخدمات المتاحة؟', 'ar'],
] as const;

for (const [message, expected] of sequence) {
  const actual = boundary.resolveConversationLanguage(
    sessionId,
    message,
    businessConfig,
  );

  assert.equal(
    actual,
    expected,
    `${message} should switch the active conversation language to ${expected}`,
  );
}

assert.equal(
  boundary.resolveConversationLanguage(
    sessionId,
    'ok',
    businessConfig,
  ),
  'ar',
  'ambiguous short replies must preserve the current language',
);

console.log('multilingual meaningful language switch regression: PASS');

boundary.reset();
