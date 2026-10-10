import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeBookingRequest, type ConversationInput } from '../booking-intelligence';
import type {
  UnderstandingProvider,
  UnderstandingProviderCallOptions,
  UnderstandingProviderInput,
} from './provider';
import { StructuredUnderstandingProviderError } from './provider-error';
import {
  createConfiguredUnderstandingShadowRuntime,
  createStructuredUnderstandingShadowObserver,
  type StructuredUnderstandingShadowTelemetry,
} from './shadow';
import { understandBookingTurn } from './understand-booking-turn';
import { decodeCanonicalStructuredUnderstanding } from './validation';

const messages = {
  en: 'Yes, book a consultation on Monday at 10:15.',
  sv: 'Ja, boka en konsultation på måndag klockan 10:15.',
  fa: 'بله، برای دوشنبه ساعت 10:15 وقت مشاوره رزرو کن.',
  es: 'Sí, reserva una consulta el lunes a las 10:15.',
  ar: 'نعم، احجز استشارة يوم الاثنين الساعة 10:15.',
  de: 'Ja, buche eine Beratung am Montag um 10:15.',
} as const;

function conversation(text: string, key = 'shadow-turn'): ConversationInput {
  return {
    businessId: 7,
    channel: 'telegram',
    conversationKey: key,
    inputMode: 'text',
    text,
    timezone: 'Europe/Stockholm',
    now: new Date('2026-08-21T10:00:00.000Z'),
  };
}

function providerInput(message: string): UnderstandingProviderInput {
  return {
    message,
    inputMode: 'text',
    timezone: 'Europe/Stockholm',
    currentTimeIso: '2026-08-21T10:00:00.000Z',
    configuredServices: ['Consultation'],
    context: {
      bookingPhase: 'awaiting_slot_selection',
      offeredSlotCount: 2,
      selectedSlotPresent: false,
      knownFields: ['service', 'date'],
    },
  };
}

function fixture(
  language: string,
  changes: Record<string, unknown> = {},
): any {
  return {
    schemaVersion: 1,
    language: { primary: { value: language, confidence: 0.98 }, codeSwitches: [] },
    intents: [{ value: 'new_booking', confidence: 0.97 }],
    acts: { bookingRequest: { value: true, confidence: 0.96 } },
    entities: {},
    ambiguities: [],
    ...changes,
  };
}

class FakeProvider implements UnderstandingProvider {
  readonly providerId = 'test-provider';
  calls = 0;
  lastSignal: AbortSignal | null = null;

  constructor(private readonly output: unknown | (() => Promise<unknown>)) {}

  async interpret(
    _input: UnderstandingProviderInput,
    options: UnderstandingProviderCallOptions,
  ): Promise<unknown> {
    this.calls += 1;
    this.lastSignal = options.signal;
    return typeof this.output === 'function' ? this.output() : this.output;
  }
}

function createHarness(provider: UnderstandingProvider, timeoutMs = 50) {
  const events: StructuredUnderstandingShadowTelemetry[] = [];
  const observer = createStructuredUnderstandingShadowObserver({
    provider,
    providerName: provider.providerId,
    model: 'test-model',
    timeoutMs,
    maxConcurrency: 2,
    emit: (event) => events.push(event),
  });
  return { observer, events };
}

function shadowOptions(
  observer: ReturnType<typeof createHarness>['observer'],
  message: string,
  correlationId: string,
  legacySignals = {
    confirmation: true,
    rejection: false,
    namePresent: false,
    phonePresent: false,
    slotReferencePresent: true,
  },
) {
  return {
    shadowObserver: observer,
    shadow: {
      correlationId,
      eligible: true,
      providerInput: providerInput(message),
      legacySignals,
    },
  } as const;
}

// A: disabled facade has no provider path and returns exact deterministic output.
const disabledInput = conversation(messages.en, 'disabled');
const disabledLegacy = normalizeBookingRequest(disabledInput);
assert.deepEqual(understandBookingTurn(disabledInput), disabledLegacy);

// B: globally enabled without explicit shadow mode creates no provider.
let configuredProviderCreations = 0;
const configuredButNotShadow = createConfiguredUnderstandingShadowRuntime({
  STRUCTURED_UNDERSTANDING_ENABLED: 'true',
  STRUCTURED_UNDERSTANDING_PROVIDER: 'gemini',
  STRUCTURED_UNDERSTANDING_SHADOW_MODE: 'false',
  GEMINI_API_KEY: 'unused',
}, {
  createGeminiProvider: () => {
    configuredProviderCreations += 1;
    return new FakeProvider(fixture('en'));
  },
});
assert.equal(configuredButNotShadow.status, 'disabled');
assert.equal(configuredButNotShadow.observer, null);
assert.equal(configuredProviderCreations, 0);
assert.deepEqual(understandBookingTurn(disabledInput), disabledLegacy);

// C: successful shadow call runs exactly once and cannot replace the legacy return.
const successProvider = new FakeProvider(fixture('en'));
const success = createHarness(successProvider);
const successResult = understandBookingTurn(disabledInput, shadowOptions(
  success.observer,
  disabledInput.text,
  'turn-success',
));
assert.deepEqual(successResult, disabledLegacy);
await success.observer.waitForIdle();
assert.equal(successProvider.calls, 1);
assert.equal(typeof successProvider.lastSignal?.addEventListener, 'function');
assert.equal(success.events[0]?.outcome, 'success');
assert.equal(success.events[0]?.failureCategory, undefined);

// D: confirmation conflict is telemetry only.
const disagreementProvider = new FakeProvider(fixture('en', {
  acts: {
    bookingRequest: { value: true, confidence: 0.99 },
    bookingConfirmation: { value: 'rejected', confidence: 0.99 },
  },
}));
const disagreement = createHarness(disagreementProvider);
const disagreementResult = understandBookingTurn(disabledInput, shadowOptions(
  disagreement.observer,
  disabledInput.text,
  'turn-disagreement',
));
assert.deepEqual(disagreementResult, disabledLegacy);
await disagreement.observer.waitForIdle();
assert.equal(disagreement.events[0]?.fields.find((field) => field.field === 'confirmation')?.status, 'conflict');

// E/L: provider-only PII presence is visible, but values and raw outputs are not serialized.
const piiMessage = 'Please book for Alex Testsson, phone 0701234567.';
const piiProvider = new FakeProvider(fixture('en', {
  entities: {
    name: { value: 'Alex Testsson', confidence: 0.99 },
    phone: { value: '0701234567', confidence: 0.99 },
  },
}));
const pii = createHarness(piiProvider);
const piiInput = conversation(piiMessage, 'pii');
const piiLegacy = normalizeBookingRequest(piiInput);
const piiResult = understandBookingTurn(piiInput, shadowOptions(
  pii.observer,
  piiMessage,
  'turn-pii',
  { confirmation: true, rejection: false, namePresent: false, phonePresent: false, slotReferencePresent: false },
));
assert.deepEqual(piiResult, piiLegacy);
await pii.observer.waitForIdle();
assert.equal(pii.events[0]?.fields.find((field) => field.field === 'name_presence')?.status, 'provider_only');
assert.equal(pii.events[0]?.fields.find((field) => field.field === 'phone_presence')?.status, 'provider_only');
const serializedPiiTelemetry = JSON.stringify(pii.events);
for (const forbidden of [piiMessage, 'Alex Testsson', '0701234567', JSON.stringify(fixture('en'))]) {
  assert.equal(serializedPiiTelemetry.includes(forbidden), false);
}

// F/G/H: all failures remain detached and leave the deterministic result intact.
for (const [label, output, category] of [
  ['timeout', () => new Promise(() => undefined), 'timeout'],
  ['malformed', 'raw provider response', 'malformed_response'],
  ['exception', async () => { throw new Error('private SDK detail'); }, 'unexpected_error'],
] as const) {
  const provider = new FakeProvider(output);
  const harness = createHarness(provider, 10);
  assert.deepEqual(
    understandBookingTurn(disabledInput, shadowOptions(harness.observer, disabledInput.text, `turn-${label}`)),
    disabledLegacy,
  );
  await harness.observer.waitForIdle();
  assert.equal(harness.events[0]?.failureCategory, category);
}

const schemaFailureProvider = new FakeProvider({});
const schemaFailure = createHarness(schemaFailureProvider);
assert.deepEqual(
  understandBookingTurn(disabledInput, shadowOptions(schemaFailure.observer, disabledInput.text, 'turn-schema')),
  disabledLegacy,
);
await schemaFailure.observer.waitForIdle();
assert.equal(schemaFailure.events[0]?.failureCategory, 'schema_validation_failed');

const explicitFailureProvider = new FakeProvider(async () => {
  throw new StructuredUnderstandingProviderError('provider_error');
});
const explicitFailure = createHarness(explicitFailureProvider);
understandBookingTurn(disabledInput, shadowOptions(explicitFailure.observer, disabledInput.text, 'turn-provider-failure'));
await explicitFailure.observer.waitForIdle();
assert.equal(explicitFailure.events[0]?.failureCategory, 'provider_error');

// I: all six supported language fixtures produce sanitized comparison telemetry.
for (const [language, message] of Object.entries(messages)) {
  const provider = new FakeProvider(fixture(language));
  const harness = createHarness(provider);
  const input = conversation(message, `language-${language}`);
  const result = understandBookingTurn(input, shadowOptions(harness.observer, message, `turn-language-${language}`));
  assert.deepEqual(result, normalizeBookingRequest(input));
  await harness.observer.waitForIdle();
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0]?.fields.some((field) => field.field === 'language'), true);
  assert.equal(JSON.stringify(harness.events[0]).includes(message), false);
}

// J: duplicate observation of one correlation ID invokes the provider once.
const duplicateProvider = new FakeProvider(fixture('en'));
const duplicate = createHarness(duplicateProvider);
const duplicateOptions = shadowOptions(duplicate.observer, disabledInput.text, 'same-turn');
understandBookingTurn(disabledInput, duplicateOptions);
understandBookingTurn(disabledInput, duplicateOptions);
await duplicate.observer.waitForIdle();
assert.equal(duplicateProvider.calls, 1);

// K: explicitly ineligible/internal turns do not invoke the provider.
const internalProvider = new FakeProvider(fixture('en'));
const internal = createHarness(internalProvider);
understandBookingTurn(disabledInput, {
  shadowObserver: internal.observer,
  shadow: {
    ...shadowOptions(internal.observer, disabledInput.text, 'internal').shadow,
    eligible: false,
  },
});
await internal.observer.waitForIdle();
assert.equal(internalProvider.calls, 0);

// M: comparison/core contracts remain provider-neutral.
const directory = fileURLToPath(new URL('.', import.meta.url));
for (const filename of ['comparison.ts', 'shadow.ts', 'understand-booking-turn.ts']) {
  const source = readFileSync(`${directory}/${filename}`, 'utf8');
  assert.doesNotMatch(source, /providers\/gemini|GeminiUnderstanding|GoogleGenAI/);
}

// Decoder branches retain their separate payloads; classification remains
// telemetry-only even when a sink throws or a malformed result is returned.
const decodedSuccess = decodeCanonicalStructuredUnderstanding(fixture('en'));
assert.equal(decodedSuccess.ok, true);
assert.equal('issues' in decodedSuccess, false);
if (decodedSuccess.ok === true) assert.equal(decodedSuccess.value.schemaVersion, 1);

let decoderCase = 0;
for (const [output, issue, category] of [
  [null, { path: '$', code: 'invalid_type' }, 'malformed_response'],
  [[], { path: '$', code: 'invalid_type' }, 'malformed_response'],
  ['invalid output', { path: '$', code: 'invalid_type' }, 'malformed_response'],
  [{}, { path: '$.schemaVersion', code: 'missing_field' }, 'schema_validation_failed'],
  [fixture('en', { schemaVersion: 2 }), { path: '$.schemaVersion', code: 'invalid_value' }, 'schema_validation_failed'],
] as const) {
  const decodedFailure = decodeCanonicalStructuredUnderstanding(output);
  assert.equal(decodedFailure.ok, false);
  assert.equal('value' in decodedFailure, false);
  if (decodedFailure.ok === false) assert.deepEqual(decodedFailure.issues, [issue]);
  const harness = createHarness(new FakeProvider(output));
  const inputBefore = structuredClone(disabledInput);
  const options = shadowOptions(harness.observer, disabledInput.text, `boundary-${decoderCase++}`);
  const liveResult = understandBookingTurn(disabledInput, options);
  assert.deepEqual(liveResult, disabledLegacy);
  await harness.observer.waitForIdle();
  assert.deepEqual(liveResult, disabledLegacy);
  assert.deepEqual(disabledInput, inputBefore);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].outcome, 'failure');
  assert.equal(harness.events[0].failureCategory, category);
  assert.deepEqual(harness.events[0].fields, []);
  assert.equal(harness.events[0].mode, 'shadow_only');
}

const sinkFailure = createStructuredUnderstandingShadowObserver({
  provider: new FakeProvider({}), providerName: 'test-provider', model: 'test-model',
  timeoutMs: 50, maxConcurrency: 1,
  emit: () => { throw new Error('synthetic telemetry failure'); },
});
const sinkFailureResult = understandBookingTurn(disabledInput, shadowOptions(sinkFailure, disabledInput.text, 'boundary-sink-failure'));
await sinkFailure.waitForIdle();
assert.deepEqual(sinkFailureResult, disabledLegacy);

console.log('Structured understanding shadow/comparison tests passed');
