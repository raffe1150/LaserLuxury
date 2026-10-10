import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { normalizeBookingRequest, type SupportedLanguage } from './booking-intelligence';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['whatsapp', 'telegram', 'instagram', 'messenger'] as const;
const now = new Date('2026-10-06T10:00:00+02:00');
const business = {
  id: 'rc03b-clinic', businessRecordId: 'rc03b-clinic', businessName: 'Synthetic Clinic',
  timezone: 'Europe/Stockholm', language: 'en', calendarProvider: 'custom',
  defaultBookingService: 'Consultation', googleCalendarId: 'synthetic-calendar',
  services: [{ name: 'Consultation', durationMinutes: 15 }],
  workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map(day => [day, [{ start: '13:45', end: '16:00' }]])),
};
function fixture(t: TestContext, channel: Channel, language: SupportedLanguage,
  start = '2026-10-12T14:00:00+02:00', status = 'awaiting_confirmation') {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => {});
  boundary.reset();
  t.after(() => boundary.reset());
  const count = { reads: 0, writes: 0, databaseWrites: 0 };
  const diagnostics: Array<{ candidateSlotCount?: number; rejectedByConstraint?: number; freeCandidateCount?: number }> = [];
  boundary.configure({ availabilityDiagnostic: detail => diagnostics.push(detail), calendarAdapter: {
    getCalendarId: () => 'synthetic-calendar',
    getEvents: async () => { count.reads++; return []; },
    checkSlots: () => { throw Error('Legacy availability must not run'); },
    insertAppointment: async () => { count.writes++; throw Error('Unexpected booking write'); },
    updateAppointment: async () => { count.writes++; throw Error('Unexpected update'); },
    cancelAppointment: async () => { count.writes++; throw Error('Unexpected cancellation'); },
  }, recordAppointment: async () => { count.databaseWrites++; throw Error('Unexpected appointment row'); },
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }) });
  const config = { ...business, language };
  const recipient = '46700000001';
  // Direct engine fixtures use the recipient as their Meta/WhatsApp session key;
  // Telegram retains its explicit bot/business/chat representation.
  const session = channel === 'telegram'
    ? fixtureChannelSessionId(boundary, channel, recipient, config) : recipient;
  const end = new Date(new Date(start).getTime() + 15 * 60_000).toISOString();
  const selectedDate = start.slice(0, 10);
  const slot = { start, end, durationMinutes: 15, service: 'Consultation',
    businessId: config.id, platform: channel, userId: recipient, generatedAt: Date.now(),
    searchStartDate: selectedDate, searchEndDate: selectedDate };
  boundary.seedFlowLanguage(session, language);
  boundary.seedPending(session, { businessId: config.id, platform: channel, userId: recipient,
    businessConfig: config, bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', status, expectedInput: status === 'awaiting_contact' ? 'contact' : 'confirmation',
    service: 'Consultation', durationMinutes: 15, selectedDate, dateTime: start,
    selectedSlotEnd: end, language, offeredSlots: [], ownedOfferedSlots: [slot],
    createdAt: Date.now(), updatedAt: Date.now(),
    normalizedBookingRequest: { intent: 'new_booking', language, requiresClarification: false,
      date: { kind: 'exact_date', value: selectedDate, confidence: 'high' },
      timeConstraint: { kind: 'exact', startMinutes: Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16)), confidence: 'high' } },
    availabilityConstraint: { startDate: selectedDate, endDate: selectedDate, kind: 'exact_time',
      exactTime: start.slice(11, 16), rejectedTimes: [], timezone: config.timezone },
  });
  const prior = new Map<string, unknown>([[session, { dateTime: start, selectedDate,
    availabilityConstraint: { startDate: selectedDate, endDate: selectedDate, kind: 'exact_time', rejectedTimes: [] } }]]);
  async function turn(text: string, nextConfig = config, nextRecipient = recipient, nextSession = session, nextChannel: Channel = channel) {
    const before = prior.get(nextSession) ?? null;
    const readsBefore = count.reads;
    diagnostics.length = 0;
    const parsed = normalizeBookingRequest({ businessId: nextConfig.id, channel: nextChannel, conversationKey: nextSession,
      inputMode: 'text', text, activeLanguage: language, timezone: nextConfig.timezone, now });
    const result = await boundary.turn({ sessionId: nextSession, platformName: nextChannel, recipientUserId: nextRecipient,
      text, businessConfig: nextConfig, now });
    // Per-turn evidence includes current proof, resulting selection/constraint, reply and all mutations.
    process.stdout.write(`RC03B ${JSON.stringify({ channel: nextChannel, language, businessId: nextConfig.id, text,
      before, parsed, after: result.pending, replies: result.replies, diagnostics, readsThisTurn: count.reads - readsBefore, count })}\n`);
    assert.ok(count.reads - readsBefore <= 1, 'At most one canonical calendar snapshot per turn');
    assert.equal(count.writes, 0, 'Availability-only turns must not mutate the calendar');
    assert.equal(count.databaseWrites, 0, 'No appointment row may be created');
    prior.set(nextSession, result.pending);
    return result;
  }
  return { turn, count, start, end, session, slot, config, recipient, diagnostics };
}

function assertExcluded(result: Awaited<ReturnType<ReturnType<typeof fixture>['turn']>>, date = '2026-10-12') {
  assert.equal(result.pending?.availabilityConstraint?.startDate, date);
  assert.equal(result.pending?.availabilityConstraint?.endDate, date);
  assert.deepEqual(result.pending?.availabilityConstraint?.rejectedTimes, ['14:00']);
  assert.equal(result.pending?.dateTime, null);
  assert.ok(result.pending?.ownedOfferedSlots.length > 0);
  for (const slot of result.pending.ownedOfferedSlots) {
    assert.equal(slot.start.slice(0, 10), date);
    assert.notEqual(slot.start.slice(11, 16), '14:00');
  }
}
for (const channel of channels) {
  test(`${channel}: reject selected 14:00, then repeated same-day alternatives`, async t => {
    const f = fixture(t, channel, 'en');
    const rejected = await f.turn('No, another time.');
    assertExcluded(rejected);
    const expected = rejected.pending.ownedOfferedSlots.map((s: { start: string }) => s.start);
    for (const text of ['Show me other times the same day.', 'Show me other times.',
      'Is anything else available?', 'More options the same day.', 'Anything else the same day?']) {
      const result = await f.turn(text);
      assertExcluded(result);
      assert.deepEqual(result.pending.ownedOfferedSlots.map((s: { start: string }) => s.start), expected,
        'Same-day widening must preserve the existing alternative ranking');
    }
  });
}
const localized: Array<[SupportedLanguage, Channel, string]> = [
 ['en', 'whatsapp', 'Show me other times the same day.'],
 ['sv', 'telegram', 'Visa andra lediga tider samma dag.'],
 ['de', 'instagram', 'Zeigen Sie andere freie Zeiten am gleichen Tag.'],
 ['es', 'messenger', 'Muéstrame otros horarios el mismo día.'],
 ['fa', 'telegram', 'وقت های دیگر همان روز را نشان دهید.'],
 ['ar', 'whatsapp', 'اعرض أوقات أخرى يوم الاثنين 12 أكتوبر 2026.'],
];
for (const [language, channel, text] of localized) {
 test(`${language}/${channel}: localized same-day alternatives preserve rejection`, async t => {
   const f = fixture(t, channel, language);
   assertExcluded(await f.turn('No, another time.'));
   assertExcluded(await f.turn(text));
 });
}
for (const channel of channels) {
 test(`${channel}: Tuesday starts a new day and may offer Monday's rejected minute`, async t => {
   const f = fixture(t, channel, 'en');
   assertExcluded(await f.turn('No, another time.'));
   const result = await f.turn('Show me available times on Tuesday, 13 October 2026.');
   assert.equal(result.pending?.availabilityConstraint?.startDate, '2026-10-13');
   assert.deepEqual(result.pending?.availabilityConstraint?.rejectedTimes, []);
   assert.ok(result.pending?.ownedOfferedSlots.some((s: { start: string }) => s.start.slice(11, 16) === '14:00'));
 });
}
for (const [text, kind, predicate] of [
 ['Show me other times the same day after 13:30.', 'time_boundary', (time: string) => time > '13:30'],
 ['Show me other times the same day before 15:00.', 'time_boundary', (time: string) => time < '15:00'],
 ['Show me other times the same day between 13:45 and 15:00.', 'time_window', (time: string) => time >= '13:45' && time <= '15:00'],
 ['Any time the same day.', 'whole_day', () => true],
] as const) {
 test(`${kind}: rejection composes with ${text}`, async t => {
   const f = fixture(t, 'messenger', 'en');
   assertExcluded(await f.turn('No, another time.'));
   const result = await f.turn(text);
   assertExcluded(result);
   assert.equal(result.pending.availabilityConstraint.kind, kind);
   assert.ok(result.pending.ownedOfferedSlots.every((s: { start: string }) => predicate(s.start.slice(11, 16))));
 });
}
test('rejection is filtered before top-N; later candidates fill all three offers', async t => {
 const f = fixture(t, 'whatsapp', 'en');
 assertExcluded(await f.turn('No, another time.'));
 const result = await f.turn('Show me other times the same day after 13:59.');
 assertExcluded(result);
 assert.equal(f.diagnostics[0]?.candidateSlotCount, 9);
 assert.equal(f.diagnostics[0]?.rejectedByConstraint, 2);
 assert.equal(f.diagnostics[0]?.freeCandidateCount, 7);
 assert.deepEqual(result.pending.ownedOfferedSlots.map((s: { start: string }) => s.start.slice(11, 16)),
   ['14:15', '14:30', '14:45']);
});
test('same-day explicit date and whole-day broadening retain only rejection, not old exact time', async t => {
 const f = fixture(t, 'instagram', 'en');
 assertExcluded(await f.turn('No, another time.'));
 assertExcluded(await f.turn('Show me other times on Monday, 12 October 2026.'));
});
test('new explicit range resets the previous single-day exclusion', async t => {
 const f = fixture(t, 'telegram', 'en');
 assertExcluded(await f.turn('No, another time.'));
 const result = await f.turn('Show me available times between 13 and 14 October 2026.');
 assert.equal(result.pending?.availabilityConstraint?.startDate, '2026-10-13');
 assert.equal(result.pending?.availabilityConstraint?.endDate, '2026-10-14');
 assert.deepEqual(result.pending?.availabilityConstraint?.rejectedTimes, []);
});
test('business switch on the same session cannot inherit another business rejection', async t => {
 const f = fixture(t, 'whatsapp', 'en');
 assertExcluded(await f.turn('No, another time.'));
 const configB = { ...f.config, id: 'rc03b-business-b', businessRecordId: 'rc03b-business-b' };
 const result = await f.turn('Show me available times on Monday, 12 October 2026.', configB);
 assert.deepEqual(result.pending?.availabilityConstraint?.rejectedTimes, []);
 assert.equal(result.pending?.businessId, configB.id);
 assert.ok(result.pending?.ownedOfferedSlots.some((s: { start: string }) => s.start.slice(11,16) === '14:00'));
 for (const slot of result.pending.ownedOfferedSlots) assert.equal(slot.businessId, configB.id);
});
test('another recipient on the same business/channel has no rejected-time leakage', async t => {
 const f = fixture(t, 'instagram', 'en');
 assertExcluded(await f.turn('No, another time.'));
 const result = await f.turn('Show me available times on Monday, 12 October 2026.', f.config, 'recipient-b', 'recipient-b');
 assert.deepEqual(result.pending?.availabilityConstraint?.rejectedTimes, []);
 assert.ok(result.pending?.ownedOfferedSlots.some((s: { start: string }) => s.start.slice(11,16) === '14:00'));
});

test('original sequence: offer 14:00, select, reject, then same-day follow-up', async t => {
  const f = fixture(t, 'whatsapp', 'en');
  boundary.dropBookingSessionMemory(f.session);
  const recipient = '46700000002';
  const step = (text: string) => f.turn(text, f.config, recipient, recipient);
  const offered = await step('Do you have any available appointments on Monday, 12 October 2026 at 14:00?');
  assert.equal(offered.pending?.ownedOfferedSlots[0].start.slice(11, 16), '14:00');
  const selected = await step('1');
  assert.equal(selected.pending?.status, 'awaiting_confirmation');
  assert.equal(selected.pending?.dateTime.slice(11, 16), '14:00');
  assertExcluded(await step('No, another time.'));
  assertExcluded(await step('Show me other times the same day.'));
});
test('restored pending constraint retains rejection after in-memory search context is dropped', async t => {
  const f = fixture(t, 'telegram', 'en');
  const rejected = await f.turn('No, another time.');
  assertExcluded(rejected);
  boundary.dropBookingSessionMemory(f.session);
  boundary.seedPending(f.session, rejected.pending);
  assertExcluded(await f.turn('Show me other times the same day.'));
});

test('a different channel cannot inherit rejection even if the raw session key is reused', async t => {
  const f = fixture(t, 'whatsapp', 'en');
  assertExcluded(await f.turn('No, another time.'));
  const result = await f.turn('Show me available times on Monday, 12 October 2026.',
    f.config, f.recipient, f.session, 'messenger');
  assert.deepEqual(result.pending?.availabilityConstraint?.rejectedTimes, []);
  assert.equal(result.pending?.platform, 'messenger');
  assert.ok(result.pending?.ownedOfferedSlots.some((s: { start: string }) => s.start.slice(11,16) === '14:00'));
  for (const slot of result.pending.ownedOfferedSlots) assert.equal(slot.platform, 'messenger');
});
