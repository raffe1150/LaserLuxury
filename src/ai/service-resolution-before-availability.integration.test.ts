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
const channels = ['instagram', 'messenger', 'telegram', 'whatsapp'] as const;
const services = [
  { id: 'video', name: 'Video Consultation', durationMinutes: 30, active: true },
  { id: 'laser', name: 'Laser Treatment', durationMinutes: 60, active: true },
  { id: 'skin', name: 'Skin Consultation', durationMinutes: 45, active: true },
  { id: 'inactive', name: 'Inactive Service', durationMinutes: 20, active: false },
];

const missingServiceMessages = {
  en: 'I want to book tomorrow.',
  sv: 'Jag vill boka en tid i morgon.',
  es: 'Quiero reservar una cita mañana.',
  de: 'Hallo, ich möchte für morgen einen Termin buchen',
  fa: 'می‌خواهم برای فردا وقت رزرو کنم.',
  ar: 'أريد حجز موعد للغد.',
} as const;

let calendarReads = 0;
function configure() {
  boundary.reset();
  calendarReads = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'service-resolution-calendar',
      getEvents: async () => { calendarReads += 1; return []; },
      checkSlots: async () => { throw new Error('legacy availability must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 1000 }),
  } as any);
}

function businessConfig(id: string, configuredServices = services) {
  return {
    id,
    businessRecordId: id,
    businessName: 'Service Resolution Clinic',
    language: 'en',
    timezone: 'Europe/Stockholm',
    calendarProvider: 'custom',
    googleCalendarId: 'service-resolution-calendar',
    services: configuredServices,
  };
}

async function turn(
  sessionId: string,
  text: string,
  config: ReturnType<typeof businessConfig>,
  platformName: typeof channels[number] = 'instagram',
) {
  return boundary.turn({
    sessionId,
    platformName,
    recipientUserId: `user-${sessionId}`,
    text,
    businessConfig: config,
    now,
  });
}

try {
  configure();
  const oneService = businessConfig('one-service', [services[0]]);
  const automatic = await turn('one-service', missingServiceMessages.en, oneService);
  assert.equal(automatic.pending?.service, 'Video Consultation');
  assert.equal(automatic.pending?.serviceId, 'video');
  assert.equal(automatic.pending?.serviceResolution, 'authoritative');
  assert.notEqual(automatic.pending?.status, 'awaiting_service');
  assert.ok(calendarReads > 0, 'one eligible service continues to availability');

  for (const [language, text] of Object.entries(missingServiceMessages)) {
    configure();
    const config = { ...businessConfig(`multi-${language}`), language };
    const result = await turn(`multi-${language}`, text, config);
    assert.equal(result.pending?.status, 'awaiting_service', language);
    assert.equal(result.pending?.service, 'Bokning', language);
    assert.equal(calendarReads, 0, `${language}: unresolved service blocks availability`);
    assert.equal(result.replies.length, 1, language);
  }

  configure();
  const multiWithDefaultConfig = {
    ...businessConfig('multi-with-default'),
    defaultBookingService: 'Video Consultation',
  };

  const multiWithDefault = await turn(
    'multi-with-default',
    missingServiceMessages.en,
    multiWithDefaultConfig,
  );

  assert.equal(multiWithDefault.pending?.status, 'awaiting_service');
  assert.equal(multiWithDefault.pending?.service, 'Bokning');
  assert.equal(
    calendarReads,
    0,
    'multiple services must not auto-select defaultBookingService',
  );

  for (const channel of channels) {
    configure();
    const result = await turn(
      `channel-${channel}`,
      missingServiceMessages.en,
      businessConfig(`channel-${channel}`),
      channel,
    );
    assert.equal(result.pending?.status, 'awaiting_service', channel);
    assert.equal(calendarReads, 0, `${channel}: shared gate blocks availability`);
  }

  configure();
  const exact = await turn(
    'exact-service',
    'I want to book Laser Treatment tomorrow.',
    businessConfig('exact-service'),
  );
  assert.equal(exact.pending?.service, 'Laser Treatment');
  assert.equal(exact.pending?.serviceId, 'laser');
  assert.equal(exact.pending?.durationMinutes, 60);
  assert.notEqual(exact.pending?.status, 'awaiting_service');
  assert.ok(calendarReads > 0);

  configure();
  const laserServices = [
    { id: 'face', name: 'Laser Face', durationMinutes: 30 },
    { id: 'legs', name: 'Laser Legs', durationMinutes: 60 },
    { id: 'consult', name: 'Laser Consultation', durationMinutes: 45 },
    { id: 'other', name: 'Unrelated Facial', durationMinutes: 40 },
  ];
  const ambiguous = await turn(
    'ambiguous-service',
    'I want laser tomorrow.',
    businessConfig('ambiguous-service', laserServices),
  );
  assert.equal(ambiguous.pending?.status, 'awaiting_service');
  assert.equal(calendarReads, 0);
  assert.match(ambiguous.replies[0], /Laser Face/u);
  assert.match(ambiguous.replies[0], /Laser Legs/u);
  assert.doesNotMatch(ambiguous.replies[0], /Unrelated Facial/u);

  configure();
  const unsupported = await turn(
    'unsupported-service-new-matrix',
    'I want to book Hair Styling tomorrow.',
    businessConfig('unsupported-service-new-matrix'),
  );
  assert.equal(unsupported.pending?.status, 'awaiting_service');
  assert.equal(unsupported.pending?.service, 'Bokning');
  assert.equal(calendarReads, 0);
  assert.match(unsupported.replies[0], /cannot match/iu);

  configure();
  const unsupportedSpanish = await turn(
    'unsupported-service-spanish-live',
    'Quiero reservar fotografía de bodas para mañana',
    {
      ...businessConfig('unsupported-service-spanish-live'),
      language: 'es',
    },
    'messenger',
  );

  assert.equal(unsupportedSpanish.pending?.status, 'awaiting_service');
  assert.equal(unsupportedSpanish.pending?.service, 'Bokning');
  assert.equal(
    unsupportedSpanish.pending?.requestedService,
    'fotografía de bodas',
  );
  assert.equal(unsupportedSpanish.pending?.selectedDate, '2026-09-03');
  assert.equal(
    calendarReads,
    0,
    'Spanish unsupported service must block availability while preserving date',
  );
  assert.match(unsupportedSpanish.replies[0], /fotografía de bodas/iu);

  configure();

  const unsupportedPersian = await turn(
    'unsupported-service-persian-native',
    'می‌خوام برای فردا عکاسی عروسی رزرو کنم.',
    businessConfig('unsupported-service-persian-native'),
  );
  assert.equal(unsupportedPersian.pending?.status, 'awaiting_service');
  assert.equal(unsupportedPersian.pending?.service, 'Bokning');
  assert.equal(unsupportedPersian.pending?.requestedService, 'عکاسی عروسی');
  assert.equal(calendarReads, 0);
  assert.match(unsupportedPersian.replies[0], /عکاسی عروسی/u);

  assert.equal(
    boundary.extractConcreteRequestedService('می‌خوام برای فردا وقت رزرو کنم.'),
    null,
  );

  assert.equal(
    boundary.extractConcreteRequestedService('می‌خوام برای فردا نوبت رزرو کنم.'),
    null,
  );

  configure();
  const unsupportedArabic = await turn(
    'unsupported-service-arabic-native',
    'أريد حجز تصوير زفاف للغد.',
    businessConfig('unsupported-service-arabic-native'),
  );
  assert.equal(unsupportedArabic.pending?.status, 'awaiting_service');
  assert.equal(unsupportedArabic.pending?.service, 'Bokning');
  assert.equal(unsupportedArabic.pending?.requestedService, 'تصوير زفاف');
  assert.equal(calendarReads, 0);
  assert.match(unsupportedArabic.replies[0], /تصوير زفاف/u);

  assert.equal(
    boundary.extractConcreteRequestedService('أريد أن أحجز موعد غدًا.'),
    null,
  );

  assert.equal(
    boundary.extractConcreteRequestedService('أريد أن أحجز خدمة غدًا.'),
    null,
  );

  // Large catalogs must never be dumped into clarification replies,
  // regardless of supported conversation language.
  const largeCatalogServices = Array.from({ length: 500 }, (_, index) => ({
    id: `service-${index + 1}`,
    name: `Catalog Service ${String(index + 1).padStart(4, '0')} END`,
    durationMinutes: 30,
    active: true,
  }));

  const largeCatalogCases = [
    {
      language: 'en',
      text: 'I want to book Wedding Photography.',
      requestedService: 'Wedding Photography',
    },
    {
      language: 'sv',
      text: 'Jag vill boka Bröllopsfotografering.',
      requestedService: 'Bröllopsfotografering',
    },
    {
      language: 'es',
      text: 'Quiero reservar Fotografía de boda.',
      requestedService: 'Fotografía de boda',
    },
    {
      language: 'de',
      text: 'Ich möchte Hochzeitsfotografie buchen.',
      requestedService: 'Hochzeitsfotografie',
    },
    {
      language: 'fa',
      text: 'می‌خوام عکاسی عروسی رزرو کنم.',
      requestedService: 'عکاسی عروسی',
    },
    {
      language: 'ar',
      text: 'أريد أن أحجز تصوير زفاف.',
      requestedService: 'تصوير زفاف',
    },
  ] as const;

  for (const testCase of largeCatalogCases) {
    configure();

    const result = await turn(
      `unsupported-large-service-catalog-${testCase.language}`,
      testCase.text,
      {
        ...businessConfig(
          `unsupported-large-service-catalog-${testCase.language}`,
        ),
        services: largeCatalogServices,
      },
    );

    assert.equal(
      result.pending?.status,
      'awaiting_service',
      `${testCase.language}: unsupported service must await service clarification`,
    );

    assert.equal(
      result.pending?.requestedService,
      testCase.requestedService,
      `${testCase.language}: requested service must be preserved`,
    );

    assert.equal(
      calendarReads,
      0,
      `${testCase.language}: unresolved service must not read calendar`,
    );

    const reply = result.replies[0] || '';

    const displayedServices = largeCatalogServices.filter((service) =>
      reply.includes(service.name),
    );

    assert.ok(
      displayedServices.length <= 5,
      `${testCase.language}: large-catalog clarification exposed ${displayedServices.length} services; expected at most 5`,
    );

    assert.ok(
      !reply.includes('Catalog Service 0500 END'),
      `${testCase.language}: large-catalog clarification must not dump the full catalog`,
    );
  }


  configure();
  const largeCatalogUnsupportedPersian = await turn(
    'unsupported-large-service-catalog-persian',
    'می‌خوام عکاسی عروسی رزرو کنم.',
    {
      ...businessConfig('unsupported-large-service-catalog-persian'),
      services: largeCatalogServices,
    },
  );

  assert.equal(
    largeCatalogUnsupportedPersian.pending?.status,
    'awaiting_service',
  );
  assert.equal(
    largeCatalogUnsupportedPersian.pending?.requestedService,
    'عکاسی عروسی',
  );
  assert.equal(calendarReads, 0);

  const largeCatalogPersianReply =
    largeCatalogUnsupportedPersian.replies[0] || '';

  const displayedPersianCatalogServices = largeCatalogServices.filter(
    (service) => largeCatalogPersianReply.includes(service.name),
  );

  assert.ok(
    displayedPersianCatalogServices.length <= 5,
    `Persian large-catalog clarification exposed ${displayedPersianCatalogServices.length} services; expected at most 5`,
  );
  assert.ok(
    !largeCatalogPersianReply.includes('Catalog Service 0500 END'),
    'Persian large-catalog clarification must not dump the full service catalog',
  );

  configure();
  const dateFirstConfig = businessConfig('date-first');
  const dateFirst = await turn('date-first', missingServiceMessages.en, dateFirstConfig);
  assert.equal(dateFirst.pending?.selectedDate, '2026-09-03');
  const dateThenService = await turn('date-first', 'For Laser Treatment.', dateFirstConfig);
  assert.equal(dateThenService.pending?.service, 'Laser Treatment');
  assert.equal(dateThenService.pending?.selectedDate, '2026-09-03');
  assert.notEqual(dateThenService.pending?.status, 'awaiting_service');
  assert.ok(calendarReads > 0);

  configure();
  const serviceFirstConfig = businessConfig('service-first');
  const serviceFirst = await turn('service-first', 'Laser Treatment.', serviceFirstConfig);
  assert.equal(serviceFirst.pending?.service, 'Laser Treatment');
  assert.equal(serviceFirst.pending?.status, 'awaiting_date_or_time');
  assert.equal(calendarReads, 0);
  const serviceThenDate = await turn('service-first', 'Tomorrow.', serviceFirstConfig);
  assert.equal(serviceThenDate.pending?.service, 'Laser Treatment');
  assert.equal(serviceThenDate.pending?.selectedDate, '2026-09-03');
  assert.ok(calendarReads > 0);

  configure();
  const staleServiceConfig = businessConfig('unsupported-overrides-stale-service');
  const staleServiceInitial = await turn(
    'unsupported-overrides-stale-service',
    'I want to book Video Consultation tomorrow.',
    staleServiceConfig,
    'whatsapp',
  );
  assert.equal(staleServiceInitial.pending?.service, 'Video Consultation');
  assert.ok(staleServiceInitial.pending?.ownedOfferedSlots?.length > 0);
  const readsBeforeUnsupportedChange = calendarReads;

  const unsupportedAfterResolvedService = await turn(
    'unsupported-overrides-stale-service',
    "I'd like to book wedding photography for tomorrow.",
    staleServiceConfig,
    'whatsapp',
  );
  assert.equal(unsupportedAfterResolvedService.pending?.status, 'awaiting_service');
  assert.equal(unsupportedAfterResolvedService.pending?.service, 'Bokning');
  assert.equal(
    unsupportedAfterResolvedService.pending?.requestedService,
    'wedding photography',
  );
  assert.equal(
    calendarReads,
    readsBeforeUnsupportedChange,
    'unsupported current-turn service must block availability instead of reusing stale service',
  );
  assert.equal(
    unsupportedAfterResolvedService.pending?.selectedDate,
    '2026-09-03',
    'known date must survive unsupported service clarification',
  );

  configure();
  const changeConfig = businessConfig('service-change');
  const initiallyVideo = await turn(
    'service-change',
    'I want to book Video Consultation tomorrow.',
    changeConfig,
  );
  assert.equal(initiallyVideo.pending?.service, 'Video Consultation');
  assert.ok(initiallyVideo.pending?.ownedOfferedSlots?.length > 0);
  const readsBeforeChange = calendarReads;
  const changed = await turn('service-change', 'Actually, Laser Treatment.', changeConfig);
  assert.equal(changed.pending?.service, 'Laser Treatment');
  assert.equal(changed.pending?.serviceId, 'laser');
  assert.equal(changed.pending?.durationMinutes, 60);
  assert.equal(changed.pending?.dateTime, null);
  assert.ok(changed.pending?.ownedOfferedSlots?.length > 0);
  assert.ok(calendarReads > readsBeforeChange, 'service change performs a fresh availability read');
  assert.ok(changed.pending.ownedOfferedSlots.every((slot: any) =>
    slot.service === 'Laser Treatment' && slot.durationMinutes === 60
  ));

  originalLog('service resolution before availability integration tests passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
