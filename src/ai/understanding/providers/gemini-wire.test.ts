import assert from 'node:assert/strict';
import { decodeCanonicalStructuredUnderstanding } from '../validation';
import {
  GEMINI_STRUCTURED_UNDERSTANDING_WIRE_SCHEMA,
  decodeGeminiWireUnderstanding,
  mapGeminiWireToCanonical,
} from './gemini-wire';

const completeWire = {
  schemaVersion: 1,
  language: 'en',
  confidence: 0.97,
  intents: ['new_booking'],
  bookingRequest: true,
  bookingConfirmation: 'affirmed',
  serviceText: 'Consultation',
  dateKind: 'relative',
  dateRelativeExpression: 'Monday',
  timeKind: 'exact',
  timeStart: '19:30',
  name: 'Alex Testsson',
  phone: '0701234567',
  slotReferenceKind: 'time',
  slotTime: '19:30',
  ambiguityFields: [],
};

const decoded = decodeGeminiWireUnderstanding(completeWire);
assert.equal(decoded.ok, true);
if (!decoded.ok) throw new Error('Expected valid wire fixture');
const canonical = mapGeminiWireToCanonical(decoded.value);
const canonicalDecoded = decodeCanonicalStructuredUnderstanding(canonical);
assert.equal(canonicalDecoded.ok, true);
if (!canonicalDecoded.ok) throw new Error('Expected valid canonical mapping');
assert.equal(canonicalDecoded.value.language.primary.value, 'en');
assert.equal(canonicalDecoded.value.intents[0]?.value, 'new_booking');
assert.equal(canonicalDecoded.value.acts.bookingConfirmation?.value, 'affirmed');
assert.equal(canonicalDecoded.value.entities.name?.value, 'Alex Testsson');
assert.equal(canonicalDecoded.value.entities.phone?.value, '0701234567');
assert.equal(canonicalDecoded.value.entities.time?.value.start, '19:30');

for (const malformed of [
  { ...completeWire, schemaVersion: 2 },
  { ...completeWire, confidence: 1.1 },
  { ...completeWire, unexpected: true },
  { ...completeWire, intents: ['execute_booking'] },
  { ...completeWire, timeStart: '99:30' },
  { ...completeWire, name: 'x'.repeat(161) },
  { ...completeWire, correctionKind: 'replacement', correctionTargets: [] },
]) {
  assert.equal(decodeGeminiWireUnderstanding(malformed).ok, false);
}

const minimalWire = decodeGeminiWireUnderstanding({
  schemaVersion: 1,
  language: 'sv',
  confidence: 0.8,
  intents: [],
  ambiguityFields: [],
});
assert.equal(minimalWire.ok, true);
if (!minimalWire.ok) throw new Error('Expected valid minimal wire fixture');
const minimalCanonical = mapGeminiWireToCanonical(minimalWire.value);
assert.deepEqual(minimalCanonical.acts, {});
assert.deepEqual(minimalCanonical.entities, {});
assert.equal(Object.prototype.hasOwnProperty.call(minimalCanonical, 'correction'), false);

const ambiguousWire = decodeGeminiWireUnderstanding({
  schemaVersion: 1,
  language: 'de',
  confidence: 0.6,
  intents: ['unknown'],
  bookingConfirmation: 'unclear',
  ambiguityFields: ['slotReference'],
});
assert.equal(ambiguousWire.ok, true);
if (!ambiguousWire.ok) throw new Error('Expected valid ambiguity fixture');
const ambiguousCanonical = mapGeminiWireToCanonical(ambiguousWire.value);
assert.equal(ambiguousCanonical.acts.bookingConfirmation?.value, 'unclear');
assert.equal(ambiguousCanonical.ambiguities[0]?.field, 'slotReference');

const schemaProperties = GEMINI_STRUCTURED_UNDERSTANDING_WIRE_SCHEMA.properties;
for (const forbidden of [
  'createBooking', 'executeBooking', 'deleteEvent', 'updateCalendar', 'callTool',
  'mutationAllowed', 'slotIsAvailable', 'bookingSucceeded', 'appointmentExists',
  'ownershipValid', 'authorizationGranted',
]) {
  assert.equal(Object.prototype.hasOwnProperty.call(schemaProperties, forbidden), false);
}

console.log('Gemini structured understanding wire-schema tests passed');
