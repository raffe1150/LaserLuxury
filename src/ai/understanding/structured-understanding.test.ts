import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeBookingRequest, type ConversationInput } from '../booking-intelligence';
import type {
  UnderstandingProvider,
  UnderstandingProviderCallOptions,
  UnderstandingProviderInput,
} from './provider';
import { understandBookingTurn } from './understand-booking-turn';
import { decodeCanonicalStructuredUnderstanding } from './validation';

const now = new Date('2026-08-21T10:00:00Z');
const input = (text: string): ConversationInput => ({
  businessId: 7,
  channel: 'telegram',
  conversationKey: 'structured-understanding-contract',
  inputMode: 'text',
  text,
  activeLanguage: 'en',
  timezone: 'Europe/Stockholm',
  now,
});

// Phase 1 parity is deliberate, including any existing multilingual limitations.
for (const message of [
  'I want to book a consultation next Monday after 15:00.',
  'Jag vill boka konsultation nästa måndag efter klockan 15.',
  'برای دوشنبه بعد از ساعت ۱۵ وقت مشاوره می‌خوام',
  'Quiero reservar una consulta el lunes después de las 15:00.',
  'أريد حجز استشارة يوم الاثنين بعد الساعة 15:00.',
  'Ich möchte am Montag nach 15 Uhr eine Beratung buchen.',
]) {
  assert.deepEqual(understandBookingTurn(input(message)), normalizeBookingRequest(input(message)));
}

const multiFact = {
  schemaVersion: 1,
  language: {
    primary: { value: 'en', confidence: 0.99, evidence: [{ start: 0, end: 3, explicit: true }] },
    codeSwitches: [],
  },
  intents: [{ value: 'new_booking', confidence: 0.98 }],
  acts: {
    bookingRequest: { value: true, confidence: 0.99 },
    bookingConfirmation: { value: 'affirmed', confidence: 0.99 },
  },
  entities: {
    time: { value: { kind: 'exact', start: '10:15' }, confidence: 0.99 },
    name: { value: 'Alex Testsson', confidence: 0.98, evidence: [{ start: 50, end: 63, explicit: true }] },
    phone: { value: '0701234567', confidence: 0.99, evidence: [{ start: 87, end: 97, explicit: true }] },
    slotReference: { value: { kind: 'time', time: '10:15' }, confidence: 0.99 },
  },
  ambiguities: [],
};

const decodedMultiFact = decodeCanonicalStructuredUnderstanding(multiFact);
assert.equal(decodedMultiFact.ok, true);
if (decodedMultiFact.ok) {
  assert.equal(decodedMultiFact.value.acts.bookingConfirmation?.value, 'affirmed');
  assert.equal(decodedMultiFact.value.entities.name?.value, 'Alex Testsson');
  assert.equal(decodedMultiFact.value.entities.phone?.value, '0701234567');
  assert.equal(decodedMultiFact.value.entities.slotReference?.value.time, '10:15');
}

const rejected = (mutate: (candidate: any) => void) => {
  const candidate = structuredClone(multiFact);
  mutate(candidate);
  const result = decodeCanonicalStructuredUnderstanding(candidate);
  assert.equal(result.ok, false);
  return result;
};

rejected((candidate) => { candidate.language.primary.confidence = 1.01; });
rejected((candidate) => { candidate.intents[0].value = 'execute_booking'; });
rejected((candidate) => { candidate.schemaVersion = 2; });
rejected((candidate) => { candidate.entities.name.evidence[0] = { start: 20, end: 10, explicit: true }; });
rejected((candidate) => { candidate.unexpected = true; });
rejected((candidate) => { candidate.entities.phone.unexpected = true; });
rejected((candidate) => { candidate.entities.name.value = 'x'.repeat(161); });

// Transactional instructions are outside the semantic schema and fail decoding.
const authorityAttempt = structuredClone(multiFact) as any;
authorityAttempt.action = 'CREATE_BOOKING';
assert.equal(decodeCanonicalStructuredUnderstanding(authorityAttempt).ok, false);

const providerInput: UnderstandingProviderInput = {
  message: 'current customer turn',
  inputMode: 'text',
  activeLanguage: 'en',
  timezone: 'Europe/Stockholm',
  currentTimeIso: now.toISOString(),
  configuredServices: ['Consultation'],
  context: {
    bookingPhase: 'awaiting_slot_selection',
    offeredSlotCount: 2,
    selectedSlotPresent: false,
    knownFields: ['service', 'date'],
  },
};
for (const forbidden of ['calendar', 'supabase', 'credentials', 'ownershipToken', 'idempotency', 'tools', 'mutation']) {
  assert.equal(Object.prototype.hasOwnProperty.call(providerInput, forbidden), false);
}

let providerCalls = 0;
const unusedProvider: UnderstandingProvider = {
  providerId: 'contract-test',
  async interpret(_input: UnderstandingProviderInput, options: UnderstandingProviderCallOptions) {
    assert.equal(typeof options.signal.addEventListener, 'function');
    providerCalls += 1;
    return multiFact;
  },
};
void unusedProvider;
const facadeResult = understandBookingTurn(input('Book a consultation on Monday at 10:15.'));
assert.equal(typeof (facadeResult as any)?.then, 'undefined');
assert.equal(providerCalls, 0);

const directory = fileURLToPath(new URL('.', import.meta.url));
const foundationSource = [
  'types.ts',
  'provider.ts',
  'understand-booking-turn.ts',
  'validation.ts',
].map((file) => readFileSync(`${directory}/${file}`, 'utf8')).join('\n');
assert.doesNotMatch(foundationSource, /@google\/genai|GoogleGenAI|from ['"]openai|from ['"]anthropic|\bfetch\s*\(/);

const facadeSource = readFileSync(`${directory}/understand-booking-turn.ts`, 'utf8');
assert.match(facadeSource, /return normalizeBookingRequest\(input\)/);
assert.doesNotMatch(facadeSource, /UnderstandingProvider|interpret\s*\(|AbortSignal/);

console.log('structured understanding Phase 1 contract tests passed');
