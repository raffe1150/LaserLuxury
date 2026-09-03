import assert from 'node:assert/strict';
import type { CanonicalStructuredUnderstanding } from './understanding/types';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-22T12:00:00+02:00');
const expectedDate = '2026-08-23';
const businessConfig = {
  id: '7',
  businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Video Consultation',
  defaultBookingDurationMinutes: 30,
  calendarProvider: 'custom',
  googleCalendarId: 'cal-7',
  workingHours: {
    sunday: [{ start: '09:00', end: '20:00' }],
  },
};

function providerUnderstanding(includeContact = true): CanonicalStructuredUnderstanding {
  return {
    schemaVersion: 1,
    language: { primary: { value: 'de', confidence: 1 }, codeSwitches: [] },
    intents: [{ value: 'new_booking', confidence: 1 }],
    acts: { bookingRequest: { value: true, confidence: 1 } },
    entities: {
      date: { value: { kind: 'relative', relativeExpression: 'tomorrow' }, confidence: 1 },
      time: { value: { kind: 'exact', start: '14:00' }, confidence: 1 },
      ...(includeContact ? {
        name: { value: 'Alex Testsson', confidence: 1 },
        phone: { value: '0701234567', confidence: 1 },
      } : {}),
    },
    ambiguities: [],
  };
}

function fixture(providerOutput = providerUnderstanding()) {
  let availabilityReads = 0;
  const adoptionDecisions: any[] = [];
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      checkSlots: async () => ({ available_slots_string: '' }),
      getEvents: async () => { availabilityReads += 1; return []; },
      insertAppointment: async () => { throw new Error('booking must await confirmation'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    structuredUnderstandingAdoptionRuntime: {
      async evaluate() { return providerOutput; },
      emitDecisions(_correlationId: string, decisions: readonly any[]) {
        adoptionDecisions.push(...decisions);
      },
    },
  });
  return {
    get availabilityReads() { return availabilityReads; },
    adoptionDecisions,
  };
}

async function run(sessionId: string, text: string) {
  return boundary.turn({
    sessionId,
    platformName: 'telegram',
    recipientUserId: sessionId,
    text,
    businessConfig,
    now,
    shadowEligibleCustomerTurn: true,
  });
}

for (const [sessionId, text, expectedNameDecision] of [
  [
    'german-multifact-explicit-contact',
    'Ich möchte morgen um 14 Uhr einen Termin buchen. Mein Name ist Alex Testsson und meine Handynummer ist 0701234567.',
    'legacy_preserved',
  ],
  [
    'german-multifact-compact-contact',
    '14 Uhr morgen passt. Alex Testsson hier, 0701234567. Bitte buchen.',
    'provider_adopted',
  ],
] as const) {
  const state = fixture();
  const result = await run(sessionId, text);
  assert.equal(result.handled, true);
  assert.equal(result.operation.operation, 'new_booking');
  assert.equal(result.pending?.operation, 'new_booking');
  assert.equal(result.pending?.selectedDate, expectedDate);
  assert.equal(result.pending?.availabilityConstraint?.exactTime, '14:00');
  assert.equal(result.pending?.dateTime, `${expectedDate}T14:00:00+02:00`);
  assert.equal(result.pending?.customerName, 'Alex Testsson');
  assert.equal(result.pending?.customerPhone, '0701234567');
  assert.equal(result.pending?.status, 'awaiting_confirmation');
  assert.ok(state.availabilityReads > 0);
  assert.ok(result.pending?.ownedOfferedSlots?.length > 0);
  assert.doesNotMatch(result.replies.join(' '), /Hallo\s*😊\s*Wie kann ich Ihnen helfen/iu);
  assert.doesNotMatch(result.replies.join(' '), /Namen|Mobilnummer|Handynummer/iu);
  assert.equal(
    state.adoptionDecisions.find((decision) => decision.field === 'time')?.disposition,
    'provider_rejected_validation',
  );
  assert.equal(
    state.adoptionDecisions.find((decision) => decision.field === 'name')?.disposition,
    expectedNameDecision,
  );
  assert.equal(
    state.adoptionDecisions.find((decision) => decision.field === 'phone')?.disposition,
    'legacy_preserved',
  );
}

for (const [sessionId, text, expectedDateDisposition] of [
  ['provider-date-persian', 'برای فردا ساعت 14 یک نوبت می‌خواهم.', 'legacy_preserved'],
  ['provider-date-arabic', 'أرغب في موعد غدًا الساعة 14.', 'legacy_preserved'],
  ['provider-date-spanish', 'Quisiera una cita mañana a las 14.', 'legacy_preserved'],
] as const) {
  const state = fixture(providerUnderstanding(false));
  const result = await run(sessionId, text);
  assert.equal(result.handled, true);
  assert.equal(result.operation.operation, 'new_booking');
  assert.equal(result.pending?.selectedDate, expectedDate);
  assert.ok(state.availabilityReads > 0);
  assert.ok(['awaiting_confirmation', 'awaiting_time_selection'].includes(result.pending?.status));
  assert.equal(result.pending?.customerName ?? null, null);
  assert.equal(result.pending?.customerPhone ?? null, null);
  assert.equal(
    state.adoptionDecisions.find((decision) => decision.field === 'booking_intent')?.disposition,
    'provider_adopted',
  );
  assert.equal(
    state.adoptionDecisions.find((decision) => decision.field === 'relative_date')?.disposition,
    expectedDateDisposition,
  );
}

boundary.reset();
console.log('German multi-fact first-turn booking regression tests passed');
