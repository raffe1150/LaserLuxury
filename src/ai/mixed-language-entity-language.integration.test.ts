import assert from 'node:assert/strict';
import { normalizeBookingRequest } from './booking-intelligence';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-27T09:00:00+02:00');
const cases = [
  {
    language: 'sv',
    text: 'Vilka lediga tider finns den 28 augusti för Video Consultation?',
    service: 'Video Consultation',
    replyMarker: /Jag hittade(?: tyvärr inga)? lediga tider|Vilken/u,
  },
  {
    language: 'de',
    text: 'Welche freien Zeiten gibt es am 2026-08-28 für Online Appointment?',
    service: 'Online Appointment',
    replyMarker: /(?:freien Zeiten|Welche passt)/u,
  },
  {
    language: 'es',
    text: '¿Qué horas disponibles hay el 2026-08-28 para Premium Consultation?',
    service: 'Premium Consultation',
    replyMarker: /(?:horas libres|Cuál te va)/u,
  },
  {
    language: 'en',
    text: 'What available times are there on 2026-08-28 for Konsultation Premium?',
    service: 'Konsultation Premium',
    replyMarker: /(?:available times|Which one suits)/u,
  },
] as const;

try {
  for (const scenario of cases) {
    const normalized = normalizeBookingRequest({
      businessId: `mixed-${scenario.language}`,
      channel: 'instagram',
      conversationKey: `normalized-${scenario.language}`,
      inputMode: 'text',
      text: scenario.text,
      timezone: 'Europe/Stockholm',
      now,
    });
    assert.equal(normalized.language, scenario.language, `${scenario.language}: normalized request language follows the customer sentence`);

    boundary.reset();
    boundary.configure({
      calendarAdapter: {
        getEvents: async () => [],
        checkSlots: () => ({ available_slots_string: '' }),
      },
      postProcess: async () => undefined,
      incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    } as any);

    const businessConfig = {
      id: `mixed-${scenario.language}`,
      businessRecordId: `mixed-${scenario.language}`,
      businessName: 'Mixed Language Clinic',
      language: 'en',
      timezone: 'Europe/Stockholm',
      calendarProvider: 'custom',
      defaultBookingService: scenario.service,
      services: [{ name: scenario.service, duration: 30 }],
    };
    const sessionId = `mixed-language-${scenario.language}`;
    const result = await boundary.turn({
      sessionId,
      platformName: 'instagram',
      recipientUserId: `user-${scenario.language}`,
      text: scenario.text,
      businessConfig,
      now,
    });

    assert.equal(result.handled, true, `${scenario.language}: mixed-language availability request is handled`);
    assert.equal(result.pending?.language, scenario.language, `${scenario.language}: pending language follows the customer sentence`);
    assert.equal(boundary.conversationState(sessionId).language, scenario.language, `${scenario.language}: flow language follows the customer sentence`);
    assert.match(result.replies[0], scenario.replyMarker, `${scenario.language}: deterministic reply uses the customer language`);
  }

  originalLog('mixed-language entity language regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
