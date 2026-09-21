import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-21T12:00:00+02:00');
const businessConfig = {
  id: '3', businessRecordId: '3', business_id: '3', businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom',
  services: [{ name: 'test', durationMinutes: 15 }],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map(day => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};
const configure = () => {
  boundary.reset();
  boundary.configure({
    calendarAdapter: { getEvents: async () => [], checkSlots: async () => ({ available_slots_string: '' }) },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 15 }),
  } as any);
};
const completed = (sessionId: string, language: string, sourceChannel: string) =>
  boundary.seedRecentCompletedBooking(sessionId, language, {
    ok: true, bookingId: `previous-${sessionId}`, businessId: '3',
    serviceName: 'test', startTime: '2026-09-22T14:00:00+02:00',
    customerName: 'Lina Test', customerPhone: '0701234567', sourceChannel,
  }, 15);
const stalePendingFromCompletedOperation = (
  sessionId: string,
  language: string,
  platform: string,
) => boundary.seedPending(sessionId, {
  bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
  businessConfig,
  businessId: '3',
  platform,
  userId: sessionId,
  sessionId,
  operation: 'new_booking',
  status: 'awaiting_confirmation',
  expectedInput: 'confirmation',
  service: 'test',
  serviceResolution: 'authoritative',
  language,
  selectedDate: '2026-09-22',
  dateTime: '2026-09-22T14:00:00+02:00',
  selectedSlotEnd: '2026-09-22T14:15:00+02:00',
  durationMinutes: 15,
  offeredSlots: [],
  ownedOfferedSlots: [{
    start: '2026-09-22T14:00:00+02:00', end: '2026-09-22T14:15:00+02:00',
    durationMinutes: 15, service: 'test', businessId: '3', platform,
    userId: sessionId, generatedAt: Date.now() - 60_000,
    searchStartDate: '2026-09-22', searchEndDate: '2026-09-22',
  }],
  normalizedBookingRequest: {
    intent: 'new_booking', language, sourceMode: 'text', requiresClarification: false,
    date: { kind: 'exact_date', value: '2026-09-22', confidence: 'high' },
  },
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
});
const activePendingAfterCompletedOperation = (
  sessionId: string,
  platform: string,
) => {
  const createdAt = Date.now();
  return boundary.seedPending(sessionId, {
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessConfig,
    businessId: '3',
    platform,
    userId: sessionId,
    sessionId,
    operation: 'new_booking',
    status: 'awaiting_time_selection',
    expectedInput: 'slot_selection',
    service: 'test',
    serviceResolution: 'authoritative',
    language: 'en',
    selectedDate: '2026-09-30',
    durationMinutes: 15,
    offeredSlots: [],
    ownedOfferedSlots: [],
    dateTime: null,
    selectedSlotEnd: null,
    normalizedBookingRequest: {
      intent: 'new_booking', language: 'en', sourceMode: 'text', requiresClarification: false,
      date: { kind: 'exact_date', value: '2026-09-30', confidence: 'high' },
      service: { raw: 'test', normalized: 'test', confidence: 'high' },
    },
    createdAt,
    updatedAt: createdAt,
  });
};
const turn = (sessionId: string, platformName: string, text: string) => boundary.turn({
  sessionId, platformName, recipientUserId: sessionId, text, businessConfig, now,
});

for (const [channel, language, request] of [
  ['instagram', 'ar', 'مرحباً، أريد حجز موعد بتاريخ الأربعاء، 30 سبتمبر 2026.'],
  ['instagram', 'en', 'Hello, I want to book an appointment on September 30, 2026.'],
  ['messenger', 'ar', 'مرحباً، أريد حجز موعد بتاريخ الأربعاء، 30 سبتمبر 2026.'],
  ['telegram', 'en', 'I want to book an appointment on September 30, 2026.'],
  ['whatsapp', 'en', 'I want to book an appointment on September 30, 2026.'],
] as const) {
  configure();
  const sessionId = `completed-${channel}-${language}`;
  completed(sessionId, language, channel);
  stalePendingFromCompletedOperation(sessionId, language, channel);
  const result = await turn(sessionId, channel, request);
  assert.equal(result.handled, true, `${channel}/${language}: new operation handled`);
  assert.equal(result.pending?.status, 'awaiting_service', `${channel}/${language}: requests fresh service`);
  assert.equal(result.pending?.selectedDate, '2026-09-30');
  assert.equal(result.pending?.dateTime, null, `${channel}/${language}: old selected slot cleared`);
  assert.deepEqual(result.pending?.ownedOfferedSlots, [], `${channel}/${language}: old offers cleared`);
  assert.ok(boundary.recentCompletionState(sessionId).completed?.bookingOperation?.ok,
    `${channel}/${language}: previous success remains historical`);
  assert.doesNotMatch(result.replies.join(' '), /already completed|no further action|تم.*بالفعل/iu);
}

for (const [channel, request] of [
  ['instagram', 'Hello, I want to book an appointment on October 5, 2026.'],
  ['whatsapp', 'Hello, I want to book an appointment on October 5, 2026.'],
] as const) {
  configure();
  const sessionId = `active-after-completion-${channel}`;
  completed(sessionId, 'en', channel);
  boundary.ageRecentCompletedBooking(sessionId, 1_000);
  activePendingAfterCompletedOperation(sessionId, channel);
  const result = await turn(sessionId, channel, request);
  assert.equal(result.pending?.status, 'awaiting_service', `${channel}: a fresh operation cannot inherit service`);
  assert.equal(result.pending?.selectedDate, '2026-10-05');
  assert.equal(result.pending?.serviceResolution, 'unresolved');
  assert.doesNotMatch(result.replies.join(' '), /available|times|slots|14:00/iu);
}

configure();
completed('active-after-completion-supported', 'en', 'instagram');
boundary.ageRecentCompletedBooking('active-after-completion-supported', 1_000);
activePendingAfterCompletedOperation('active-after-completion-supported', 'instagram');
const supportedFreshRequest = await turn(
  'active-after-completion-supported',
  'instagram',
  'Hello, I want to book test on October 5, 2026.',
);
assert.equal(supportedFreshRequest.pending?.service, 'test');
assert.equal(supportedFreshRequest.pending?.serviceResolution, 'authoritative');
assert.equal(supportedFreshRequest.pending?.selectedDate, '2026-10-05');
assert.equal(supportedFreshRequest.pending?.status, 'awaiting_time_selection');

for (const message of ['thanks', 'okay']) {
  configure();
  const sessionId = `completed-${message}`;
  completed(sessionId, 'en', 'instagram');
  await turn(sessionId, 'instagram', message);
  assert.equal(boundary.pendingStateSnapshot(sessionId), null, `${message}: no new operation`);
  assert.ok(boundary.recentCompletionState(sessionId).completed?.bookingOperation?.ok);
}

for (const [message, expected] of [
  ['I want to reschedule my previous booking.', 'reschedule'],
  ['I want to cancel my previous booking.', 'cancellation'],
] as const) {
  configure();
  const sessionId = `completed-${expected}`;
  completed(sessionId, 'en', 'messenger');
  const result = await turn(sessionId, 'messenger', message);
  assert.notEqual(result.pending?.operation, 'new_booking');
  assert.ok(result.handled || result.operation?.operation === expected,
    `${expected}: existing appointment policy owns the request`);
}

for (const channel of ['whatsapp', 'telegram', 'instagram', 'messenger'] as const) {
  configure();
  const sessionId = `unsupported-${channel}`;
  const text = 'Quiero reservar fotografía de bodas';
  if (channel === 'whatsapp') {
    assert.equal(boundary.whatsappPreDispatchDecision(sessionId, text).dispatchesUnifiedBooking, true);
  }
  const result = await turn(sessionId, channel, text);
  assert.equal(result.pending?.status, 'awaiting_service', `${channel}: unsupported service is deterministic`);
  assert.match(result.replies.join(' '), /fotografía de bodas/u);
  assert.match(result.replies.join(' '), /test/u);
  assert.doesNotMatch(result.replies.join(' '), /qué quieres saber/iu);
  const supported = await turn(sessionId, channel, 'test');
  assert.equal(supported.pending?.service, 'test', `${channel}: supported service accepted`);
  assert.notEqual(supported.pending?.status, 'awaiting_service');
}

configure();
const englishUnsupported = await turn('unsupported-en', 'telegram', 'I want to book wedding photography.');
assert.equal(englishUnsupported.pending?.status, 'awaiting_service');
assert.match(englishUnsupported.replies.join(' '), /test/u);

// The same durable identity can start another operation with a service request.
configure();
completed('completed-service-restart', 'es', 'telegram');
const restartedService = await turn('completed-service-restart', 'telegram', 'Quiero reservar fotografía de bodas');
assert.equal(restartedService.pending?.status, 'awaiting_service');
assert.match(restartedService.replies.join(' '), /test/u);

console.log = originalLog;
console.error = originalError;
console.log('Completed-operation and service-routing regressions passed');
