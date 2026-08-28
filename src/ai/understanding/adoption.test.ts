import assert from 'node:assert/strict';
import {
  createConfiguredUnderstandingAdoptionRuntime,
  resolveControlledUnderstandingAdoption,
  type StructuredUnderstandingAdoptionTelemetry,
} from './adoption';
import { resolveRelativeBookingDateSemantic } from '../booking-intelligence';
import type {
  UnderstandingProvider,
  UnderstandingProviderCallOptions,
  UnderstandingProviderInput,
} from './provider';
import type { CanonicalStructuredUnderstanding } from './types';

function understanding(fields: {
  confidence?: number;
  time?: string;
  confirmation?: 'affirmed' | 'rejected' | 'unclear';
  name?: string;
  phone?: string;
  relativeDate?: string;
}): CanonicalStructuredUnderstanding {
  const confidence = fields.confidence ?? 0.95;
  return {
    schemaVersion: 1,
    language: { primary: { value: 'de', confidence }, codeSwitches: [] },
    intents: [{ value: 'new_booking', confidence }],
    acts: {
      bookingRequest: { value: true, confidence },
      ...(fields.confirmation ? {
        bookingConfirmation: { value: fields.confirmation, confidence },
      } : {}),
    },
    entities: {
      ...(fields.time ? {
        time: { value: { kind: 'exact', start: fields.time }, confidence },
        slotReference: { value: { kind: 'time', time: fields.time }, confidence },
      } : {}),
      ...(fields.name ? { name: { value: fields.name, confidence } } : {}),
      ...(fields.phone ? { phone: { value: fields.phone, confidence } } : {}),
      ...(fields.relativeDate ? {
        date: { value: { kind: 'relative', relativeExpression: fields.relativeDate }, confidence },
      } : {}),
    },
    ambiguities: [],
  };
}

const ownedTimes = new Set(['14:00', '14:15', '14:30']);
const resolve = (
  provider: CanonicalStructuredUnderstanding,
  legacy: Parameters<typeof resolveControlledUnderstandingAdoption>[0]['legacy'] = {},
) => resolveControlledUnderstandingAdoption({
  provider,
  legacy,
  validateOwnedTime: (value) => ownedTimes.has(value) ? value : null,
  validateName: (value) => /^[A-ZÄÖÜ][\p{L}'-]+(?:\s+[A-ZÄÖÜ][\p{L}'-]+)+$/u.test(value) ? value : null,
  validatePhone: (value) => {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? digits : null;
  },
});

// German: semantic time must still resolve through the deterministic owned set.
const germanSelection = resolve(understanding({ time: '14:00' }));
assert.equal(germanSelection.candidates.time, '14:00');
assert.equal(germanSelection.decisions.find((entry) => entry.field === 'time')?.disposition, 'provider_adopted');

const germanConfirmation = resolve(understanding({ time: '14:00', confirmation: 'affirmed' }));
assert.equal(germanConfirmation.candidates.time, '14:00');
assert.equal(germanConfirmation.candidates.confirmation, true);

const germanContact = resolve(understanding({
  time: '14:00', confirmation: 'affirmed', name: 'Alex Testsson', phone: '0701234567',
}));
assert.deepEqual(germanContact.candidates, {
  bookingIntent: 'new_booking',
  time: '14:00', confirmation: true, name: 'Alex Testsson', phone: '0701234567',
});

// An unowned/hallucinated time never becomes a semantic candidate.
const unowned = resolve(understanding({ time: '13:45', confirmation: 'affirmed' }));
assert.equal(unowned.candidates.time, undefined);
assert.equal(unowned.decisions.find((entry) => entry.field === 'time')?.disposition, 'provider_rejected_validation');

// Low confidence cannot supplement any field.
const lowConfidence = resolve(understanding({
  confidence: 0.79, time: '14:00', confirmation: 'affirmed', name: 'Alex Testsson', phone: '0701234567',
}));
assert.deepEqual(lowConfidence.candidates, {});
assert.equal(lowConfidence.decisions.every((entry) =>
  entry.disposition === 'provider_rejected_low_confidence' || entry.disposition === 'shadow_only'), true);

// Existing deterministic facts win; genuine conflicts are rejected.
const conflict = resolve(
  understanding({ time: '14:15', confirmation: 'affirmed', name: 'Other Person', phone: '0799999999' }),
  { intent: 'new_booking', time: '14:00', confirmation: true, name: 'Alex Testsson', phone: '0701234567' },
);
assert.deepEqual(conflict.candidates, {});
for (const field of ['time', 'name', 'phone'] as const) {
  assert.equal(conflict.decisions.find((entry) => entry.field === field)?.disposition, 'provider_rejected_conflict');
}
assert.equal(conflict.decisions.find((entry) => entry.field === 'confirmation')?.disposition, 'legacy_preserved');

// Explicit deterministic rejection cannot be overridden by provider affirmation.
const rejectedConfirmation = resolve(understanding({ confirmation: 'affirmed' }), { rejection: true });
assert.equal(rejectedConfirmation.candidates.confirmation, undefined);
assert.equal(rejectedConfirmation.decisions.find((entry) => entry.field === 'confirmation')?.disposition, 'provider_rejected_conflict');

// Contact validation remains mandatory; absent/malformed contact never becomes complete.
const invalidContact = resolve(understanding({ name: 'Consultation', phone: '123' }));
assert.equal(invalidContact.candidates.name, undefined);
assert.equal(invalidContact.candidates.phone, undefined);
assert.equal(invalidContact.decisions.find((entry) => entry.field === 'name')?.disposition, 'provider_rejected_validation');
assert.equal(invalidContact.decisions.find((entry) => entry.field === 'phone')?.disposition, 'provider_rejected_validation');

// Provider-neutral intent/date supplementation is limited to missing, generic,
// unknown, or clarification legacy results.
for (const language of ['de', 'fa', 'ar', 'es']) {
  const provider = understanding({ relativeDate: 'tomorrow' });
  provider.language.primary.value = language;
  const supplemented = resolve(provider, { intent: 'clarification' });
  assert.equal(supplemented.candidates.bookingIntent, 'new_booking');
  assert.equal(supplemented.candidates.relativeDate, 'tomorrow');
  assert.equal(supplemented.decisions.find((entry) => entry.field === 'booking_intent')?.disposition, 'provider_adopted');
  assert.equal(supplemented.decisions.find((entry) => entry.field === 'relative_date')?.disposition, 'provider_adopted');
}

for (const intent of ['cancellation', 'reschedule', 'booking_lookup']) {
  const protectedIntent = resolve(understanding({ relativeDate: 'tomorrow' }), { intent });
  assert.equal(protectedIntent.candidates.bookingIntent, undefined);
  assert.equal(protectedIntent.decisions.find((entry) => entry.field === 'booking_intent')?.disposition, 'provider_rejected_conflict');
}
const rejectedIntent = resolve(understanding({ relativeDate: 'tomorrow' }), {
  intent: 'clarification', rejection: true, blocksNewBookingIntent: true,
});
assert.equal(rejectedIntent.candidates.bookingIntent, undefined);
assert.equal(rejectedIntent.decisions.find((entry) => entry.field === 'booking_intent')?.disposition, 'provider_rejected_conflict');

const explicitDateProtected = resolve(understanding({ relativeDate: 'tomorrow' }), {
  intent: 'new_booking', relativeDate: 'exact_date:2026-08-30',
});
assert.equal(explicitDateProtected.candidates.relativeDate, undefined);
assert.equal(explicitDateProtected.decisions.find((entry) => entry.field === 'relative_date')?.disposition, 'provider_rejected_conflict');
const ownedDateProtected = resolve(understanding({ relativeDate: 'tomorrow' }), {
  intent: 'new_booking', blocksRelativeDate: true,
});
assert.equal(ownedDateProtected.candidates.relativeDate, undefined);
assert.equal(ownedDateProtected.decisions.find((entry) => entry.field === 'relative_date')?.disposition, 'provider_rejected_conflict');

const unsupportedRelative = resolve(understanding({ relativeDate: 'next convenient day' }), { intent: 'clarification' });
assert.equal(unsupportedRelative.candidates.relativeDate, undefined);
assert.equal(unsupportedRelative.decisions.find((entry) => entry.field === 'relative_date')?.disposition, 'provider_rejected_validation');
const lowRelative = resolve(understanding({ confidence: 0.79, relativeDate: 'tomorrow' }), { intent: 'clarification' });
assert.equal(lowRelative.candidates.relativeDate, undefined);
assert.equal(lowRelative.candidates.bookingIntent, undefined);
assert.equal(lowRelative.decisions.find((entry) => entry.field === 'relative_date')?.disposition, 'provider_rejected_low_confidence');
assert.equal(lowRelative.decisions.find((entry) => entry.field === 'booking_intent')?.disposition, 'provider_rejected_low_confidence');

assert.equal(
  resolveRelativeBookingDateSemantic('tomorrow', 'Europe/Stockholm', new Date('2026-08-22T22:30:00.000Z'))?.value,
  '2026-08-24',
);
assert.equal(
  resolveRelativeBookingDateSemantic('tomorrow', 'America/Los_Angeles', new Date('2026-08-22T22:30:00.000Z'))?.value,
  '2026-08-23',
);

// Adoption output has no transactional or ownership fields.
for (const forbidden of [
  'selectedOwnedSlotStart', 'slotIsAvailable', 'bookingSucceeded', 'createBooking',
  'calendar', 'supabase', 'idempotency', 'ownershipValid',
]) {
  assert.equal(Object.prototype.hasOwnProperty.call(germanContact.candidates, forbidden), false);
}

class FakeProvider implements UnderstandingProvider {
  readonly providerId = 'test-provider';
  calls = 0;
  constructor(private readonly output: CanonicalStructuredUnderstanding) {}
  async interpret(_input: UnderstandingProviderInput, _options: UnderstandingProviderCallOptions): Promise<unknown> {
    this.calls += 1;
    return this.output;
  }
}

let providerCreations = 0;
const disabled = createConfiguredUnderstandingAdoptionRuntime({
  STRUCTURED_UNDERSTANDING_ENABLED: 'true',
  STRUCTURED_UNDERSTANDING_ADOPTION_ENABLED: 'false',
  GEMINI_API_KEY: 'unused',
}, {
  createGeminiProvider: () => {
    providerCreations += 1;
    return new FakeProvider(understanding({ time: '14:00' }));
  },
});
assert.equal(disabled.status, 'disabled');
assert.equal(providerCreations, 0);

const telemetry: StructuredUnderstandingAdoptionTelemetry[] = [];
const fakeProvider = new FakeProvider(understanding({
  time: '14:00', confirmation: 'affirmed', name: 'Alex Testsson', phone: '0701234567',
}));
const configured = createConfiguredUnderstandingAdoptionRuntime({
  STRUCTURED_UNDERSTANDING_ENABLED: 'true',
  STRUCTURED_UNDERSTANDING_ADOPTION_ENABLED: 'true',
  STRUCTURED_UNDERSTANDING_MODEL: 'test-model',
  GEMINI_API_KEY: 'test-key',
}, {
  createGeminiProvider: () => fakeProvider,
  emitAdoption: (event) => telemetry.push(event),
});
assert.equal(configured.status, 'ready');
const providerInput: UnderstandingProviderInput = {
  message: 'synthetic test turn', inputMode: 'text', timezone: 'Europe/Stockholm',
  currentTimeIso: '2026-08-22T10:00:00.000Z', configuredServices: ['Consultation'],
  context: { bookingPhase: 'awaiting_slot_selection', offeredSlotCount: 3, selectedSlotPresent: false, knownFields: [] },
};
const evaluated = await configured.runtime?.evaluate(providerInput, 'safe-correlation');
assert.equal(fakeProvider.calls, 1);
assert.ok(evaluated);
configured.runtime?.emitDecisions('safe-correlation', germanContact.decisions);
const serializedTelemetry = JSON.stringify(telemetry);
assert.equal(serializedTelemetry.includes('Alex Testsson'), false);
assert.equal(serializedTelemetry.includes('0701234567'), false);
assert.match(serializedTelemetry, /provider_adopted/);

console.log('Structured understanding controlled-adoption tests passed');
