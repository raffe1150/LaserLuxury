import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const configuredServices = [
  { name: 'Video Consultation', duration: 30 },
  { name: 'Strategy Session', duration: 45 },
];
const cases = [
  {
    language: 'de',
    text: 'Ich möchte eine Haarbehandlung um 16:00 Uhr buchen.',
    requestedService: 'Haarbehandlung',
    responseMarker: /keiner.*zuordnen|nicht.*angebot/iu,
  },
  {
    language: 'en',
    text: 'I want to book a Hair Treatment at 16:00.',
    requestedService: 'Hair Treatment',
    responseMarker: /cannot.*match|not.*offered/iu,
  },
] as const;

try {
  for (const scenario of cases) {
    boundary.reset();
    let calendarReads = 0;
    boundary.configure({
      calendarAdapter: {
        getEvents: async () => {
          calendarReads += 1;
          return [];
        },
        checkSlots: () => ({ available_slots_string: '' }),
      },
      postProcess: async () => undefined,
      incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    } as any);

    const businessConfig = {
      id: `unsupported-service-${scenario.language}`,
      businessRecordId: `unsupported-service-${scenario.language}`,
      businessName: 'Configured Services Clinic',
      language: scenario.language,
      timezone: 'Europe/Stockholm',
      calendarProvider: 'custom',
      defaultBookingService: 'Video Consultation',
      services: configuredServices,
    };
    const sessionId = `unsupported-service-${scenario.language}`;
    const result = await boundary.turn({
      sessionId,
      platformName: 'messenger',
      recipientUserId: `user-${scenario.language}`,
      text: scenario.text,
      businessConfig,
      now: new Date('2026-08-27T09:00:00+02:00'),
    });

    assert.equal(result.handled, true, `${scenario.language}: unsupported service stays in the shared booking engine`);
    assert.equal(result.pending?.status, 'awaiting_service', `${scenario.language}: booking remains in service resolution`);
    assert.equal(result.pending?.operation, 'new_booking');
    assert.equal(result.pending?.language, scenario.language);
    assert.equal(result.pending?.requestedService, scenario.requestedService);
    assert.equal(result.pending?.requestedTime, '16:00');
    assert.equal(result.pending?.service, 'Bokning', `${scenario.language}: unsupported service is not silently mapped`);
    assert.deepEqual(result.pending?.offeredSlots, []);
    assert.equal(calendarReads, 0, `${scenario.language}: availability is not queried for an unsupported service`);
    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0], scenario.responseMarker);
    assert.match(result.replies[0], /Video Consultation/u);
    assert.match(result.replies[0], /Strategy Session/u);
    assert.doesNotMatch(result.replies[0], /duration|Dauer.*mitteilen|Was möchten Sie wissen/iu);

    if (scenario.language === 'de') {
      const resumed = await boundary.turn({
        sessionId,
        platformName: 'messenger',
        recipientUserId: 'user-de',
        text: 'Dann nehme ich Video Consultation.',
        businessConfig,
        now: new Date('2026-08-27T09:00:00+02:00'),
      });
      assert.equal(resumed.handled, true);
      assert.equal(resumed.pending?.status, 'awaiting_date_or_time');
      assert.equal(resumed.pending?.service, 'Video Consultation');
      assert.equal(resumed.pending?.requestedTime, '16:00', 'the requested time survives service resolution');
      assert.match(resumed.replies[0], /welches Datum/iu);
      assert.match(resumed.replies[0], /16:00/u);
      assert.equal(calendarReads, 0, 'service resolution does not fabricate availability');
    }
  }

  originalLog('unsupported-service booking regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
