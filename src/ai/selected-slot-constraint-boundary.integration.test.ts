import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { normalizeBookingRequest, type SupportedLanguage } from './booking-intelligence';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['whatsapp', 'telegram', 'instagram', 'messenger'] as const;
const now = new Date('2026-08-10T10:00:00+02:00');
const business = {
  id: 'rc03a-clinic', businessRecordId: 'rc03a-clinic', businessName: 'Synthetic Clinic',
  timezone: 'Europe/Stockholm', language: 'en', calendarProvider: 'custom',
  defaultBookingService: 'Consultation', googleCalendarId: 'synthetic-calendar',
  services: [{ name: 'Consultation', durationMinutes: 60 }],
  workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    .map(day => [day, [{ start: '09:00', end: '20:00' }]])),
};
function fixture(t: TestContext, channel: Channel, language: SupportedLanguage,
  start = '2026-08-13T09:00:00+02:00', status = 'awaiting_confirmation') {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => {});
  boundary.reset();
  t.after(() => boundary.reset());
  const count = { reads: 0, writes: 0, databaseWrites: 0 };
  boundary.configure({ calendarAdapter: {
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
  const end = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
  const selectedDate = start.slice(0, 10);
  const slot = { start, end, durationMinutes: 60, service: 'Consultation',
    businessId: config.id, platform: channel, userId: recipient, generatedAt: Date.now(),
    searchStartDate: selectedDate, searchEndDate: selectedDate };
  boundary.seedFlowLanguage(session, language);
  boundary.seedPending(session, { businessId: config.id, platform: channel, userId: recipient,
    businessConfig: config, bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', status, expectedInput: status === 'awaiting_contact' ? 'contact' : 'confirmation',
    service: 'Consultation', durationMinutes: 60, selectedDate, dateTime: start,
    selectedSlotEnd: end, language, offeredSlots: [], ownedOfferedSlots: [slot],
    createdAt: Date.now(), updatedAt: Date.now(),
    normalizedBookingRequest: { intent: 'new_booking', language, requiresClarification: false,
      date: { kind: 'exact_date', value: selectedDate, confidence: 'high' },
      timeConstraint: { kind: 'exact', startMinutes: Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16)), confidence: 'high' } },
    availabilityConstraint: { startDate: selectedDate, endDate: selectedDate, kind: 'exact_time',
      exactTime: start.slice(11, 16), rejectedTimes: [], timezone: config.timezone },
  });
  async function turn(text: string) {
    const parsed = normalizeBookingRequest({ businessId: config.id, channel, conversationKey: session,
      inputMode: 'text', text, activeLanguage: language, timezone: config.timezone, now });
    const result = await boundary.turn({ sessionId: session, platformName: channel, recipientUserId: recipient,
      text, businessConfig: config, now });
    // Per-turn evidence includes current proof, resulting selection/constraint, reply and all mutations.
    process.stdout.write(`RC03A ${JSON.stringify({ channel, language, businessId: config.id, text,
      before: start, parsed, after: result.pending, replies: result.replies, count })}\n`);
    assert.equal(count.writes, 0, 'No stale/contradictory selection may mutate the calendar');
    assert.equal(count.databaseWrites, 0, 'No appointment row may be created');
    return result;
  }
  return { turn, count, start, end, session, slot, config, recipient };
}
for (const channel of channels) {
  test(`${channel}: Spanish 09:15 cannot authorize an owned 09:00`, async t => {
    const f = fixture(t, channel, 'es');
    const r = await f.turn('Sí, reserva las 09:15.');
    assert.match(r.replies.join(' '), /09:15/);
    assert.doesNotMatch(r.replies.join(' '), /09:00/);
    assert.notEqual(r.pending?.status, 'awaiting_contact');
    assert.notEqual(r.pending?.dateTime, f.start);
    assert.equal(r.pending?.availabilityConstraint?.exactTime, '09:15');
    assert.equal(f.count.reads, 1);
  });
}
const refinements: Array<[SupportedLanguage, Channel, string]> = [
  ['en', 'messenger', 'Friday after 16'],
  ['sv', 'telegram', 'Fredag efter kl 16'],
  ['de', 'instagram', 'Freitag nach 16 Uhr'],
  ['es', 'whatsapp', 'Viernes después de las 16:00'],
  ['fa', 'telegram', 'جمعه بعد از ساعت ۱۶'],
  ['ar', 'messenger', 'الجمعة بعد الساعة ١٦'],
];
for (const [language, channel, text] of refinements) {
  test(`${language}/${channel}: fresh weekday/boundary replaces Thursday 12:30`, async t => {
    const f = fixture(t, channel, language, '2026-08-13T12:30:00+02:00');
    const r = await f.turn(text);
    assert.equal(r.pending?.availabilityConstraint?.startDate, '2026-08-14');
    assert.equal(r.pending?.availabilityConstraint?.timeBoundary?.kind, 'exclusive_lower');
    assert.ok(r.pending?.ownedOfferedSlots?.length > 0);
    for (const slot of r.pending.ownedOfferedSlots) {
      assert.equal(slot.start.slice(0, 10), '2026-08-14');
      assert.ok(slot.start.slice(11, 16) > '16:00');
    }
    assert.notEqual(r.pending?.dateTime, f.start);
    assert.equal(f.count.reads, 1);
  });
}
test('Telegram: repeated Aug 15–21 availability reopens search after selecting Aug 19', async t => {
  const f = fixture(t, 'telegram', 'sv', '2026-08-19T15:00:00+02:00');
  const r = await f.turn('Vilken är den tidigaste lediga tiden mellan 15 och 21 augusti?');
  assert.equal(r.pending?.availabilityConstraint?.startDate, '2026-08-15');
  assert.equal(r.pending?.availabilityConstraint?.endDate, '2026-08-21');
  assert.equal(r.pending?.availabilityConstraint?.selectFirstAvailable, true);
  assert.equal(r.pending?.ownedOfferedSlots?.[0].start.slice(0, 16), '2026-08-17T09:00');
  assert.notEqual(r.pending?.dateTime, f.start);
  assert.equal(f.count.reads, 1);
});
const sameSlot: Array<[SupportedLanguage, Channel, string]> = [
  ['en', 'whatsapp', 'Yes, please'], ['sv', 'telegram', 'Ja, tack'],
  ['de', 'instagram', 'Ja, bitte'], ['es', 'messenger', 'Sí, reserva las 09:00.'],
  ['fa', 'telegram', 'بله، لطفاً'], ['ar', 'whatsapp', 'نعم، من فضلك'],
];
for (const [language, channel, text] of sameSlot) {
  test(`${language}/${channel}: valid same-slot authorization preserves ownership`, async t => {
    const f = fixture(t, channel, language);
    const r = await f.turn(text);
    assert.equal(r.pending?.status, 'awaiting_contact');
    assert.equal(r.pending?.dateTime, f.start);
    assert.equal(r.pending?.selectedSlotEnd, f.end);
    assert.equal(r.pending?.ownedOfferedSlots?.[0].businessId, f.config.id);
    assert.equal(f.count.reads, 1);
  });
}
const incidental: Array<[SupportedLanguage, Channel, string]> = [
  ['en', 'whatsapp', 'My phone number is 0701234567.'],
  ['sv', 'telegram', 'Referens 93414557'],
  ['de', 'instagram', 'Diagnosebericht vom Freitag um 16:00, Referenz 93414557.'],
  ['es', 'messenger', 'Referencia del informe: 2026-08-14 a las 16:00.'],
  ['fa', 'telegram', 'گزارش آزمایش جمعه ساعت ۱۶، کد پیگیری 93414557'],
  ['ar', 'whatsapp', 'رقم المرجع 93414557، تقرير يوم الجمعة الساعة ١٦'],
];
for (const [language, channel, text] of incidental) {
  test(`${language}/${channel}: incidental numbers/dates do not replace selection`, async t => {
    const f = fixture(t, channel, language);
    const r = await f.turn(text);
    assert.equal(r.pending?.dateTime, f.start);
    assert.equal(r.pending?.selectedSlotEnd, f.end);
    assert.equal(f.count.reads, 0);
  });
}
test('Contact diagnostic suffix cannot replace the selected slot', async t => {
  const f = fixture(t, 'instagram', 'en');
  const r = await f.turn('My name is Nora Testfield AIBB 93414557 Friday at 11:00 Laser instagram-en.');
  assert.equal(r.pending?.dateTime, f.start);
  assert.equal(r.pending?.customerName, 'Nora Testfield');
});
test('Unrelated business-information question containing a date preserves selection', async t => {
  const f = fixture(t, 'telegram', 'en');
  const r = await f.turn('What is your address? My reference report is dated 2026-08-14 at 16:00.');
  assert.equal(r.handled, false, 'Continue through existing grounded business-information path');
  assert.equal(r.pending?.dateTime, f.start);
  assert.equal(f.count.reads, 0);
});
for (const status of ['awaiting_confirmation', 'awaiting_contact', 'failed_recoverable']) {
  test(`${status}: entity-bearing confirmation cannot authorize a different minute`, async t => {
    const f = fixture(t, 'messenger', 'en', '2026-08-13T09:00:00+02:00', status);
    const r = await f.turn('Yes, please book it at 09:15.');
    assert.notEqual(r.pending?.dateTime, f.start);
    // Existing entity-bearing authorization may proceed for the newly validated
    // 09:15 selection; it must never authorize the old 09:00 slot.
    assert.equal(r.pending?.dateTime?.slice(11, 16), '09:15');
    assert.equal(r.pending?.ownedOfferedSlots?.[0].start, r.pending?.dateTime);
    assert.equal(r.pending?.availabilityConstraint?.exactTime, '09:15');
    assert.equal(f.count.reads, 1);
  });
}
test('Spanish alternate authorization still preserves contradictory minute proof', async t => {
  const f = fixture(t, 'instagram', 'es');
  const r = await f.turn('Sí, quiero reservarla a las 09:15.');
  assert.notEqual(r.pending?.dateTime, f.start);
  assert.notEqual(r.pending?.status, 'awaiting_contact');
  assert.equal(r.pending?.availabilityConstraint?.exactTime, '09:15');
});
test('Quoted booking text inside a report is not current scheduling intent', async t => {
  const f = fixture(t, 'messenger', 'en');
  const r = await f.turn('The report quotes "book Friday at 16:00" under reference 93414557.');
  assert.equal(r.pending?.dateTime, f.start);
  assert.equal(f.count.reads, 0);
});
test('Bare new weekday is an authoritative date-only refinement', async t => {
  const f = fixture(t, 'telegram', 'en', '2026-08-13T12:30:00+02:00');
  const r = await f.turn('Friday');
  assert.equal(r.pending?.availabilityConstraint?.startDate, '2026-08-14');
  assert.equal(r.pending?.availabilityConstraint?.kind, 'whole_day');
  assert.equal(r.pending?.dateTime, null);
  assert.equal(f.count.reads, 1);
});
for (const sameBusiness of [true, false]) {
  test(`Reopened range respects pending holds only in its business (${sameBusiness})`, async t => {
    const f = fixture(t, 'telegram', 'sv', '2026-08-19T15:00:00+02:00');
    const holder = '46700000002';
    const holderBusiness = sameBusiness ? f.config : { ...f.config, id: 'rc03a-other', businessRecordId: 'rc03a-other' };
    const start = '2026-08-17T09:00:00+02:00';
    const end = '2026-08-17T08:00:00.000Z';
    const held = { ...f.slot, start, end, businessId: holderBusiness.id, userId: holder };
    boundary.seedPending(fixtureChannelSessionId(boundary, 'telegram', holder, holderBusiness), {
      businessId: holderBusiness.id, businessConfig: holderBusiness, platform: 'telegram', userId: holder,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status: 'awaiting_contact',
      service: 'Consultation', selectedDate: '2026-08-17', dateTime: start, selectedSlotEnd: end,
      durationMinutes: 60, ownedOfferedSlots: [held], createdAt: Date.now(), updatedAt: Date.now(),
    });
    const r = await f.turn('Vilken är den tidigaste lediga tiden mellan 15 och 21 augusti?');
    assert.equal(r.pending?.ownedOfferedSlots?.[0].start.slice(0, 16),
      sameBusiness ? '2026-08-17T10:00' : '2026-08-17T09:00');
    assert.equal(r.pending?.ownedOfferedSlots?.[0].businessId, f.config.id);
    assert.equal(r.pending?.ownedOfferedSlots?.[0].userId, f.recipient);
    assert.equal(f.count.reads, 1);
  });
}
test('A prior business selection cannot authorize under business B', async t => {
  const f = fixture(t, 'messenger', 'en');
  const configB = { ...f.config, id: 'rc03a-business-b', businessRecordId: 'rc03a-business-b' };
  const r = await boundary.turn({ sessionId: f.session, platformName: 'messenger', recipientUserId: f.recipient,
    text: 'Book Consultation Friday after 16', businessConfig: configB, now });
  assert.notEqual(r.pending?.dateTime, f.start);
  assert.equal(r.pending?.businessId, configB.id);
  for (const slot of r.pending.ownedOfferedSlots) assert.equal(slot.businessId, configB.id);
  assert.equal(f.count.writes, 0);
  assert.equal(f.count.databaseWrites, 0);
});
test('A scheduling-only date range reopens availability without an extra booking verb', async t => {
  const f = fixture(t, 'telegram', 'sv', '2026-08-19T15:00:00+02:00');
  const r = await f.turn('Mellan 15 och 21 augusti');
  assert.equal(r.pending?.availabilityConstraint?.startDate, '2026-08-15');
  assert.equal(r.pending?.availabilityConstraint?.endDate, '2026-08-21');
  assert.equal(r.pending?.dateTime, null);
  assert.equal(f.count.reads, 1);
});
test('A conflicting explicit date cannot authorize the selected time on the old date', async t => {
  const f = fixture(t, 'messenger', 'en');
  const r = await f.turn('Yes, please book it on 2026-08-14 at 09:00.');
  assert.notEqual(r.pending?.dateTime, f.start);
  assert.equal(r.pending?.selectedDate, '2026-08-14');
  assert.equal(r.pending?.availabilityConstraint?.startDate, '2026-08-14');
  assert.equal(f.count.reads, 1);
});
test('Explicit correction with contact details cannot bypass fresh scheduling constraints', async t => {
  const f = fixture(t, 'messenger', 'en');
  const r = await f.turn('My name is Ada Lovelace, 0701234567. Instead Friday after 16.');
  assert.notEqual(r.pending?.dateTime, f.start);
  assert.equal(r.pending?.availabilityConstraint?.startDate, '2026-08-14');
  assert.equal(r.pending?.availabilityConstraint?.timeBoundary?.kind, 'exclusive_lower');
  assert.equal(f.count.reads, 1);
});
