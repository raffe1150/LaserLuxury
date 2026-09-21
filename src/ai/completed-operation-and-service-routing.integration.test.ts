import assert from 'node:assert/strict';

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
const turn = (sessionId: string, platformName: string, text: string) => boundary.turn({
  sessionId, platformName, recipientUserId: sessionId, text, businessConfig, now,
});

for (const [channel, language, request] of [
  ['instagram', 'ar', 'مرحباً، أريد حجز موعد بتاريخ الأربعاء، 30 سبتمبر 2026.'],
  ['messenger', 'ar', 'مرحباً، أريد حجز موعد بتاريخ الأربعاء، 30 سبتمبر 2026.'],
  ['telegram', 'en', 'I want to book an appointment on September 30, 2026.'],
  ['whatsapp', 'en', 'I want to book an appointment on September 30, 2026.'],
] as const) {
  configure();
  const sessionId = `completed-${channel}-${language}`;
  completed(sessionId, language, channel);
  const result = await turn(sessionId, channel, request);
  assert.equal(result.handled, true, `${channel}/${language}: new operation handled`);
  assert.equal(result.pending?.status, 'awaiting_service', `${channel}/${language}: requests fresh service`);
  assert.equal(result.pending?.selectedDate, '2026-09-30');
  assert.ok(boundary.recentCompletionState(sessionId).completed?.bookingOperation?.ok,
    `${channel}/${language}: previous success remains historical`);
  assert.doesNotMatch(result.replies.join(' '), /already completed|no further action|تم.*بالفعل/iu);
}

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
