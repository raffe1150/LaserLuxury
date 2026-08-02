import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

function section(startMarker: string, endMarker: string, source = server): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1);
    assert.ok(current > previous, `expected ordered marker: ${marker}`);
    previous = current;
  }
}

const engine = section(
  'async function handleUnifiedBookingEngine(',
  'async function processTelegramUpdate(',
);
const booking = section(
  'if (["awaiting_contact", "failed_recoverable"].includes(String(pending?.status || "")))',
  'if (pending?.status === "awaiting_time_selection")',
  engine,
);

assertOrdered(booking, [
  'const missing = getMissingBookingContact(pending)',
  'validateCanonicalExactSlot',
  'adapter.insertAppointment',
  'const calendarVerified',
  'recordAppointmentFromBooking',
  'const databaseVerified',
  'const bookingSettlementRecorded = await settleAtomicOperation(',
  'createBookingOperationResult',
  'verifiedBookingReplyAuthorizations[sessionId]',
  'formatBookingSavedMessage(',
]);

for (const failurePath of [
  'calendar_create_failed',
  'calendar_verification_failed',
  'database_insert_failed',
  'database_verification_failed',
  'idempotency_settlement_failed',
]) {
  const failure = booking.indexOf(`"${failurePath}"`);
  const authorization = booking.indexOf('verifiedBookingReplyAuthorizations[sessionId]');
  assert.ok(failure >= 0 && failure < authorization, `${failurePath} must terminate before confirmation authorization`);
}
const settlementFailure = section(
  'if (!bookingSettlementRecorded)',
  'const bookingOperationResult',
  booking,
);
assert.match(settlementFailure, /getErrorMessageByLanguage/);
assert.match(booking, /bookingOperationClaim\.duplicateStatus === "completed"[\s\S]{0,120}clearPendingBooking/);
assert.doesNotMatch(booking, /runAiProviderRequest[\s\S]{0,300}insertAppointment|insertAppointment[\s\S]{0,300}runAiProviderRequest/);

for (const [channel, wrapper] of [
  ['telegram', 'processTelegramUpdate'],
  ['whatsapp', 'processWhatsAppMessage'],
  ['messenger', 'processMessengerUpdate'],
  ['instagram', 'processInstagramUpdate'],
] as const) {
  const source = section(`async function ${wrapper}(`, `async function ${wrapper}Claimed(`);
  assert.match(source, /runWithInboundMessageClaim\(/, `${channel} must claim the inbound event before processing`);
}

for (const channel of ['whatsapp', 'messenger', 'instagram', 'telegram']) {
  assert.match(
    server,
    new RegExp(`handleUnifiedBookingEngine\\([\\s\\S]{0,500}platformName:\\s*["']${channel}["']`),
    `${channel} must call the canonical booking engine`,
  );
}

assert.match(server, /if \(voice && !voiceTranscript\)[\s\S]{0,1200}return;/);
assert.match(server, /audioBuffer\.byteLength !== expectedSize/);
assert.match(server, /Persian\/Farsi \(fa-IR\)/);
assert.match(server, /awaiting_voice_contact_confirmation/);
assert.match(server, /inputMode:\s*voice\s*\?\s*"voice"\s*:\s*"text"/);
assert.match(server, /containsUnverifiedBookingSuccessClaim\(raw\)/);

assert.match(server, /function isCancellationIntent/);
assert.match(server, /const completeCancellation = async/);
assert.match(server, /function formatRescheduleSuccess/);
assert.match(server, /routeRescheduleToolCallThroughUnified/);
assert.match(server, /function setupDailyReminders/);
assert.match(server, /class GoogleCalendarAdapter/);
assert.match(server, /type: "booking_operation_claim"/);

assert.match(server, /vad heter du/);
assert.match(server, /formatLanguageMismatchRecovery/);
assert.doesNotMatch(server, /formatLocalizedFlowFallback/);
assert.doesNotMatch(server, /console\.log\(["']Message:["'],\s*textMessage/);
assert.doesNotMatch(server, /Appointment DB insert attempt:/);
assert.doesNotMatch(server, /API Error in generateContentWithFallback/);

assert.match(server, /catch \{[\s\S]{0,500}\[BookingPostProcess\]/);
assert.match(server, /bookingOutcomeCode:/);
assert.match(server, /correlationId,[\s\S]{0,500}durationMs:/);

console.log('AI staging readiness structural tests passed');
