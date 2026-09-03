import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const cases = [
  {
    language: 'en',
    requestedService: 'Wedding Photography',
    candidates: ['Video Consultation', 'Laser Treatment'],
    safeReply:
      'I could not match Wedding Photography to a bookable service. Would you prefer Video Consultation or Laser Treatment?',
  },
  {
    language: 'sv',
    requestedService: 'Bröllopsfotografering',
    candidates: ['Video Consultation', 'Laser Treatment'],
    safeReply:
      'Jag hittar inte Bröllopsfotografering bland de bokningsbara tjänsterna. Vill du välja Video Consultation eller Laser Treatment?',
  },
  {
    language: 'es',
    requestedService: 'Fotografía de boda',
    candidates: ['Video Consultation', 'Laser Treatment'],
    safeReply:
      'No encuentro Fotografía de boda entre los servicios reservables. ¿Prefieres Video Consultation o Laser Treatment?',
  },
  {
    language: 'de',
    requestedService: 'Hochzeitsfotografie',
    candidates: ['Video Consultation', 'Laser Treatment'],
    safeReply:
      'Ich finde Hochzeitsfotografie nicht unter den buchbaren Leistungen. Möchten Sie Video Consultation oder Laser Treatment wählen?',
  },
  {
    language: 'fa',
    requestedService: 'عکاسی عروسی',
    candidates: ['Video Consultation', 'Laser Treatment'],
    safeReply:
      'عکاسی عروسی را بین سرویس‌های قابل رزرو پیدا نمی‌کنم. Video Consultation یا Laser Treatment را می‌خواهید؟',
  },
  {
    language: 'ar',
    requestedService: 'تصوير زفاف',
    candidates: ['Video Consultation', 'Laser Treatment'],
    safeReply:
      'لا أجد تصوير زفاف ضمن الخدمات القابلة للحجز. هل تريد Video Consultation أم Laser Treatment؟',
  },
] as const;

try {
  for (const testCase of cases) {
    const input = {
      status: 'unsupported' as const,
      language: testCase.language,
      requestedService: testCase.requestedService,
      candidates: [...testCase.candidates],
      catalogServices: [
        ...testCase.candidates,
        'Skin Consultation',
      ],
    };

    assert.equal(
      boundary.validateServiceClarificationPresentation(
        testCase.safeReply,
        input,
      ),
      true,
      `${testCase.language}: safe presentation should pass`,
    );

    const accepted = await boundary.renderServiceClarificationPresentation(
      input,
      testCase.safeReply,
    );

    assert.equal(
      accepted.source,
      'gemini',
      `${testCase.language}: valid Gemini presentation should be used`,
    );

    assert.equal(accepted.text, testCase.safeReply);

    const unsafeAvailability =
      testCase.language === 'fa'
        ? 'بله، عکاسی عروسی موجود است و فردا ساعت 09:00 وقت داریم.'
        : testCase.language === 'ar'
          ? 'نعم، تصوير زفاف متاح غدًا الساعة 09:00.'
          : `Yes, ${testCase.requestedService} is available tomorrow at 09:00.`;

    assert.equal(
      boundary.validateServiceClarificationPresentation(
        unsafeAvailability,
        input,
      ),
      false,
      `${testCase.language}: availability hallucination must fail`,
    );

    const fallbackFromUnsafe =
      await boundary.renderServiceClarificationPresentation(
        input,
        unsafeAvailability,
      );

    assert.equal(
      fallbackFromUnsafe.source,
      'deterministic',
      `${testCase.language}: unsafe Gemini presentation must fall back`,
    );

    assert.notEqual(
      fallbackFromUnsafe.text,
      unsafeAvailability,
      `${testCase.language}: unsafe text must never reach customer`,
    );

    const unauthorizedServiceReply =
      `I cannot match ${testCase.requestedService}. ` +
      `You can choose Skin Consultation instead.`;

    assert.equal(
      boundary.validateServiceClarificationPresentation(
        unauthorizedServiceReply,
        {
          ...input,
          candidates: ['Video Consultation', 'Laser Treatment'],
        },
      ),
      false,
      `${testCase.language}: configured service outside safe candidates must fail`,
    );
  }

  const ambiguous = {
    status: 'ambiguous' as const,
    language: 'en',
    requestedService: 'Consultation',
    candidates: ['Video Consultation', 'Skin Consultation'],
    catalogServices: [
      'Video Consultation',
      'Skin Consultation',
      'Laser Treatment',
    ],
  };

  assert.equal(
    boundary.validateServiceClarificationPresentation(
      'Consultation could mean Video Consultation or Skin Consultation. Which one would you like?',
      ambiguous,
    ),
    true,
    'ambiguous safe candidate presentation should pass',
  );

  assert.equal(
    boundary.validateServiceClarificationPresentation(
      'Consultation could mean Video Consultation or Laser Treatment. Which one would you like?',
      ambiguous,
    ),
    false,
    'ambiguous presentation must not introduce catalog services outside candidates',
  );

  const missing = {
    status: 'missing' as const,
    language: 'en',
    requestedService: null,
    candidates: [],
    catalogServices: [
      'Video Consultation',
      'Laser Treatment',
      'Skin Consultation',
    ],
  };

  assert.equal(
    boundary.validateServiceClarificationPresentation(
      'Of course. Which service would you like to book?',
      missing,
    ),
    true,
    'missing-service clarification may ask for the service',
  );

  assert.equal(
    boundary.validateServiceClarificationPresentation(
      'Video Consultation is available tomorrow at 10:00.',
      missing,
    ),
    false,
    'missing-service presentation must not invent availability',
  );

  originalLog('service clarification presentation integration tests passed');
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
