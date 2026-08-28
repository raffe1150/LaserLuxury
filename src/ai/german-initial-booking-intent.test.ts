import assert from 'node:assert/strict';
import {
  detectNormalizedIntent,
  normalizeBookingRequest,
} from './booking-intelligence';

process.env.NODE_ENV = 'test';

const now = new Date('2026-08-28T12:00:00Z');
const normalize = (text: string, language?: 'de' | 'en' | 'sv' | 'es') =>
  normalizeBookingRequest({
    businessId: 'german-intent-regression',
    channel: 'messenger',
    conversationKey: 'fresh-german-intent',
    inputMode: 'text',
    text,
    activeLanguage: language,
    timezone: 'Europe/Stockholm',
    now,
  });

const exact = normalize(
  'Ich möchte Video Consultation morgen um 16 Uhr buchen.',
  'de',
);
assert.equal(exact.language, 'de');
assert.equal(exact.intent, 'new_booking');
assert.equal(exact.service?.normalized, 'Konsultation');
assert.equal(exact.date?.value, '2026-08-29');
assert.equal(exact.timeConstraint?.kind, 'exact');
assert.equal(exact.timeConstraint?.startMinutes, 16 * 60);

assert.equal(
  detectNormalizedIntent('Ich möchte einen Termin buchen.'),
  'new_booking',
);
assert.equal(
  detectNormalizedIntent('Ich will einen Termin reservieren.'),
  'new_booking',
);
assert.notEqual(
  detectNormalizedIntent('Wie lange dauert der Termin?'),
  'new_booking',
);
assert.notEqual(
  detectNormalizedIntent('Video Consultation'),
  'new_booking',
);

assert.equal(
  detectNormalizedIntent('I want to book an appointment tomorrow.'),
  'new_booking',
);
assert.equal(
  detectNormalizedIntent('Jag vill boka en tid på fredag.'),
  'new_booking',
);
assert.equal(
  detectNormalizedIntent('Quiero reservar Video Consultation mañana.'),
  'clarification',
);

const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

try {
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getEvents: async () => [],
      checkSlots: () => ({ available_slots_string: '' }),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);

  const freshNow = new Date();
  const expectedFreshDate = normalizeBookingRequest({
    businessId: 'german-fresh-turn',
    channel: 'messenger',
    conversationKey: 'expected-german-fresh-turn',
    inputMode: 'text',
    text: 'Ich möchte Video Consultation morgen um 16 Uhr buchen.',
    activeLanguage: 'de',
    timezone: 'Europe/Stockholm',
    now: freshNow,
  }).date?.value;
  const result = await boundary.turn({
    sessionId: 'german-fresh-turn',
    platformName: 'messenger',
    recipientUserId: 'german-fresh-user',
    text: 'Ich möchte Video Consultation morgen um 16 Uhr buchen.',
    businessConfig: {
      id: 'german-fresh-turn',
      businessRecordId: 'german-fresh-turn',
      businessName: 'German Intent Clinic',
      language: 'en',
      timezone: 'Europe/Stockholm',
      calendarProvider: 'custom',
      defaultBookingService: 'Video Consultation',
      services: [{ name: 'Video Consultation', duration: 30 }],
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.pending?.operation, 'new_booking');
  assert.equal(result.pending?.language, 'de');
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.selectedDate, expectedFreshDate);
  assert.equal(result.pending?.requestedTime, '16:00');
  assert.equal(result.pending?.normalizedBookingRequest?.intent, 'new_booking');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}

console.log('German initial-booking intent regressions passed');
