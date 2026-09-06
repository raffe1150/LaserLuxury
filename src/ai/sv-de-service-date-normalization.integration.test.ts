import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

try {
  for (const scenario of [
    { language: 'sv', text: 'Jag vill boka bröllopsfotografering till imorgon.', service: 'bröllopsfotografering' },
    { language: 'de', text: 'Ich möchte für morgen Hochzeitsfotografie buchen.', service: 'Hochzeitsfotografie' },
    { language: 'sv', text: 'Jag vill boka bröllopsfotografering till i morgon.', service: 'bröllopsfotografering' },
    { language: 'de', text: 'Ich möchte fuer morgen Hochzeitsfotografie buchen.', service: 'Hochzeitsfotografie' },
    { language: 'es', text: 'Quiero reservar fotografía de bodas para mañana.', service: 'fotografía de bodas' },
  ]) {
    boundary.reset();
    let calendarReads = 0;
    boundary.configure({
      calendarAdapter: {
        getCalendarId: () => 'service-date-calendar',
        getEvents: async () => { calendarReads += 1; return []; },
        checkSlots: async () => { throw new Error('availability must wait for service resolution'); },
      },
      postProcess: async () => undefined,
      incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    } as any);
    const businessConfig = {
      id: 'service-date', businessName: 'Service Date Clinic', language: scenario.language,
      timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'service-date-calendar',
      services: [{ name: 'Video Consultation', duration: 30 }],
    };
    const turn = (text: string) => boundary.turn({
      sessionId: 'service-date', platformName: 'messenger', recipientUserId: 'service-date-user',
      text, businessConfig, now: new Date('2026-09-01T12:00:00+02:00'),
    });
    const result = await turn(scenario.text);
    assert.equal(result.pending?.selectedDate, '2026-09-02', scenario.text);
    assert.equal(result.pending?.normalizedBookingRequest?.date?.value, '2026-09-02', scenario.text);
    assert.equal(result.pending?.status, 'awaiting_service', scenario.text);
    assert.equal(result.pending?.service, 'Bokning', scenario.text);
    assert.equal(calendarReads, 0, scenario.text);
    assert.equal(result.pending?.requestedService, scenario.service, scenario.text);
    assert.equal(boundary.extractConcreteRequestedService(scenario.text), scenario.service, scenario.text);
    assert.ok(result.replies.join(' ').includes(scenario.service));
    const resumed = await turn('Video Consultation');
    assert.equal(resumed.pending?.service, 'Video Consultation');
    assert.equal(resumed.pending?.selectedDate, '2026-09-02');
    assert.equal(resumed.pending?.normalizedBookingRequest?.date?.value, '2026-09-02');
  }

  for (const [text, expected] of [
    ['Jag vill boka bröllopsfotografering på måndag.', 'bröllopsfotografering'],
    ['Jag vill boka bröllopsfotografering till övermorgon.', 'bröllopsfotografering'],
    ['Jag vill boka fotografering för företag.', 'fotografering för företag'],
    ['Jag vill boka fotografering till minne.', 'fotografering till minne'],
    ['Jag vill boka Morgon Porträtt.', 'Morgon Porträtt'],
    ['Ich möchte für übermorgen Hochzeitsfotografie buchen.', 'Hochzeitsfotografie'],
    ['Ich möchte am Montag Hochzeitsfotografie buchen.', 'Hochzeitsfotografie'],
    ['Ich möchte für Firmen Hochzeitsfotografie buchen.', 'für Firmen Hochzeitsfotografie'],
    ['Ich möchte Morgen Porträts buchen.', 'Morgen Porträts'],
    ['Ich möchte für morgen einen Termin buchen.', null],
  ] as const) {
    assert.equal(boundary.extractConcreteRequestedService(text), expected, text);
  }
  originalLog('SV/DE service/date normalization regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
