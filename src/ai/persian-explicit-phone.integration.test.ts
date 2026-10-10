import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { resolveAuthoritativeContact } from './channel-contact';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['instagram', 'messenger', 'telegram', 'whatsapp'] as const;
const sentence = 'نام من مینا آزمون و شماره تلفنم 0700001105 است.';
const phone = '0700001105';
const name = 'مینا آزمون';
const now = new Date('2027-05-20T12:00:00+02:00');
const start = '2027-05-21T15:30:00+02:00';
const end = '2027-05-21T14:00:00.000Z';
const business = { id: '7', businessName: 'Synthetic Persian Clinic', language: 'fa',
  timezone: 'Europe/Stockholm', defaultBookingService: 'Video Consultation',
  calendarProvider: 'custom', googleCalendarId: 'cal-7' };
function contact(text: string, channel: Channel, senderPhone?: string) {
  const parts = boundary.extractBookingContactParts(text);
  return { parts, resolved: resolveAuthoritativeContact({ channel,
    currentName: parts.combined?.name || parts.nameOnly,
    currentPhone: parts.combined?.phone || parts.phoneOnly, senderPhone }) };
}
for (const [digits, expected] of [['0700001105', phone], ['۰۷۰۰۰۰۱۱۰۵', phone], ['٠٧٠٠٠٠١١٠٥', phone]] as const) {
  for (const label of ['شماره تلفنم', 'شماره تلفن من', 'شماره موبایلم', 'موبایلم', 'تلفنم']) {
    test(`${label}: explicit phone in ${digits}`, () => {
      assert.equal(boundary.extractBookingContactParts(`${label} ${digits} است.`).phoneOnly, expected);
    });
  }
}
test('exact Mina sentence preserves name, explicit phone and provenance on every channel', () => {
  for (const channel of channels) {
    const { parts, resolved } = contact(sentence, channel, '+46700000001');
    assert.deepEqual(parts.combined, { name, phone });
    assert.equal(parts.nameOnly, name);
    assert.equal(resolved.name, name);
    assert.equal(resolved.phone, phone);
    assert.equal(resolved.phoneSource, 'explicit_customer_message');
  }
});
test('existing Persian phone labels and international formatting remain valid', () => {
  for (const label of ['شماره تلفن', 'شماره موبایل', 'شماره موبایلم', 'موبایلم', 'تلفن']) {
    assert.equal(boundary.extractBookingContactParts(`${label}: 0700001105`).phoneOnly, phone);
  }
  assert.equal(boundary.extractBookingContactParts('شماره تلفنم +46 (70) 000-11-05 است.').phoneOnly, '+46700001105');
});
const negatives = [
  'شماره رزرو 0700001105 است.', 'شماره سفارش 0700001105 است.', 'کد پیگیری 0700001105 است.',
  'شناسه آزمایش ۰۷۰۰۰۰۱۱۰۵ است.', 'شناسه تشخیصی ٠٧٠٠٠٠١١٠٥ است.',
  'تاریخ رزرو 2027-05-21 است.', 'ساعت رزرو 15:30 است.', 'قیمت 0700001105 تومان است.',
  'کد پستی 0700001105 است.', 'مدت خدمت 0700001105 دقیقه است.',
  'شماره تلفنم', 'شماره تلفن من است.', 'تلفنم است.', 'شماره تلفنم: 123',
  'شماره تلفنم در پرونده با شناسه 0700001105 ثبت شده است.',
];
for (const text of negatives) {
  test(`unrelated/invalid number is not explicit phone: ${text}`, () => {
    const parts = boundary.extractBookingContactParts(text);
    assert.equal(parts.phoneOnly, null);
    assert.equal(parts.combined, null);
    for (const channel of channels) {
      const { resolved } = contact(text, channel, '+46700000001');
      assert.equal(resolved.phone, channel === 'whatsapp' ? '+46700000001' : null);
      assert.equal(resolved.phoneSource, channel === 'whatsapp' ? 'verified_sender_metadata' : 'missing');
    }
  });
}
for (const channel of channels) {
  test(`${channel}: explicit phone beats sender metadata; absence preserves original fallback`, () => {
    const supplied = contact(sentence, channel, '+46700000001').resolved;
    assert.equal(supplied.phone, phone);
    assert.equal(supplied.phoneSource, 'explicit_customer_message');
    const absent = resolveAuthoritativeContact({ channel, currentName: name, senderPhone: '+46700000001' });
    assert.equal(absent.phone, channel === 'whatsapp' ? '+46700000001' : null);
    assert.equal(absent.phoneSource, channel === 'whatsapp' ? 'verified_sender_metadata' : 'missing');
    assert.equal(resolveAuthoritativeContact({ channel, currentName: name, currentPhone: '123', senderPhone: '123' }).phone, null);
  });
}
type Event = { id: string; status: string; summary: string; description: string;
  start: { dateTime: string }; end: { dateTime: string };
  extendedProperties: { private: { businessId: string; platform: Channel; userId: string } } };
function fixture(t: TestContext, channel: Channel, withSender = false) {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => {});
  boundary.reset(); t.after(() => boundary.reset());
  const events = new Map<string, Event>();
  const claims = new Map<string, { claimed: boolean; keyHash: string; storageId: string;
    state: { type: string; status: string; attempts: number; claimedAt: number; updatedAt: number } }>();
  const count = { calendarWrites: 0, bookingWrites: 0, calendarReads: 0 };
  const created: Array<{ name: string; phone: string; service: string; dateTime: string; duration: number; marker: string }> = [];
  const recorded: Array<{ businessId: string; platform: Channel; userId: string; name: string; phone: string; service: string; dateTime: string }> = [];
  const recipient = withSender ? '46700000001' : 'synthetic-persian-contact';
  const session = channel === 'telegram' ? fixtureChannelSessionId(boundary, channel, recipient, business) : recipient;
  let active = business;
  const dependencies: Parameters<typeof boundary.configure>[0] = {
    semanticLanguageResolver: async () => null,
    calendarAdapter: {
      getCalendarId: () => 'cal-7', getEvents: async () => { count.calendarReads++; return [...events.values()]; },
      checkSlots: () => { throw Error('Legacy availability must not run'); },
      insertAppointment: async (customerName, customerPhone, service, dateTime, duration = 30, marker = '') => {
        count.calendarWrites++; created.push({ name: customerName, phone: customerPhone, service, dateTime, duration, marker });
        const event = { id: `synthetic-${count.calendarWrites}`, status: 'confirmed',
          summary: `Booked: ${customerName} - ${customerPhone}`,
          description: `BusinessId: ${active.id}\nPlatform: ${channel}\nUserId: ${marker}`,
          start: { dateTime: new Date(dateTime).toISOString() },
          end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { businessId: active.id, platform: channel, userId: marker } } };
        events.set(event.id, event); return { success: true, event };
      },
      getEventById: async id => events.get(id) || null,
      cancelAppointment: async () => { throw Error('No cancellation is authorized'); },
      updateAppointment: async () => { throw Error('No reschedule is authorized'); },
    }, postProcess: async () => undefined, notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    validateAppointment: async appointment => appointment,
    recordAppointment: async params => {
      count.bookingWrites++;
      recorded.push({ businessId: String(params.businessConfig.id), platform: params.platform, userId: String(params.userId),
        name: params.name, phone: params.phone, service: params.service, dateTime: params.dateTime });
      return { id: count.bookingWrites, business_id: String(params.businessConfig.id), platform: params.platform,
        user_id: String(params.userId), service: params.service, start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + Number(params.durationMinutes) * 60_000).toISOString(), status: 'booked' };
    },
    claimOperation: async params => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const previous = claims.get(key);
      if (previous) return { ...previous, claimed: false, duplicateStatus: previous.state.status };
      const handle = { claimed: true, keyHash: key, storageId: key,
        state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } };
      claims.set(key, handle); return handle;
    },
    settleOperation: async (handle, status) => { handle.state.status = status; return true; },
  };
  boundary.configure(dependencies);
  function seed(config = business, customerName?: string) {
    active = config;
    boundary.seedFlowLanguage(session, 'fa');
    boundary.seedPending(session, { businessId: config.id, platform: channel, userId: recipient, businessConfig: config,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status: 'awaiting_contact',
      expectedInput: 'contact', service: 'Video Consultation', durationMinutes: 30, language: 'fa',
      customerName, selectedDate: '2027-05-21', dateTime: start, selectedSlotEnd: end,
      createdAt: Date.now(), updatedAt: Date.now(),
      ownedOfferedSlots: [{ start, end, durationMinutes: 30, service: 'Video Consultation', businessId: config.id,
        platform: channel, userId: recipient, generatedAt: Date.now(), searchStartDate: '2027-05-21', searchEndDate: '2027-05-21' }],
    });
  }
  seed();
  async function turn(text: string, config = business) {
    active = config;
    const parsed = contact(text, channel, withSender ? '+46700000001' : undefined);
    const result = await boundary.turn({ sessionId: session, platformName: channel, recipientUserId: recipient, text, businessConfig: config, now });
    process.stdout.write(`RC03C ${JSON.stringify({ text, channel, businessId: config.id, parsed, pending: result.pending,
      operation: result.operation, replies: result.replies, count, created, recorded })}\n`);
    return result;
  }
  return { turn, seed, count, created, recorded, session, recipient };
}
for (const channel of channels) {
  test(`${channel}: exact Mina contact completes once without changing slot/service/business`, async t => {
    const f = fixture(t, channel);
    const missing = await f.turn('شماره تلفنم');
    assert.equal(missing.pending?.status, 'awaiting_contact');
    assert.equal(f.count.calendarWrites, 0); assert.equal(f.count.bookingWrites, 0);
    const result = await f.turn(sentence);
    assert.equal(result.pending, null);
    assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
    assert.equal(f.created[0].name, name); assert.equal(f.created[0].phone, phone);
    assert.equal(f.created[0].dateTime, start); assert.equal(f.created[0].service, 'Video Consultation');
    assert.equal(f.created[0].duration, 30);
    assert.equal(f.recorded[0].businessId, business.id); assert.equal(f.recorded[0].platform, channel);
    assert.equal(f.recorded[0].userId, f.recipient);
    await f.turn(sentence);
    assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
  });
  test(`${channel}: stored name plus phone-only possessive label completes existing contact flow`, async t => {
    const f = fixture(t, channel); f.seed(business, name);
    const invalid = await f.turn('شماره تلفنم: 123');
    assert.equal(invalid.pending?.status, 'awaiting_contact');
    assert.equal(f.count.calendarWrites, 0); assert.equal(f.count.bookingWrites, 0);
    const result = await f.turn('شماره تلفنم ۰۷۰۰۰۰۱۱۰۵ است.');
    assert.equal(result.pending, null);
    assert.equal(f.created[0].name, name); assert.equal(f.created[0].phone, phone);
    assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
  });
}
test('WhatsApp completion uses explicitly supplied phone over verified sender', async t => {
  const f = fixture(t, 'whatsapp', true);
  const result = await f.turn(sentence);
  assert.equal(result.pending, null);
  assert.equal(f.created[0].phone, phone);
  assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
});
test('cross-business switch cannot carry A explicit phone into B contact completion', async t => {
  const f = fixture(t, 'instagram');
  const first = await f.turn('شماره تلفنم 0700001105 است.');
  assert.equal(first.pending?.contactPhoneSource, 'explicit_customer_message');
  assert.equal(first.pending?.customerPhone, phone);
  assert.equal(f.count.calendarWrites, 0);
  const configB = { ...business, id: '8' };
  const switched = await f.turn('بله', configB);
  assert.notEqual(switched.pending?.customerPhone, phone);
  assert.equal(f.count.calendarWrites, 0);
  f.seed(configB, 'سارا نمونه');
  const empty = await f.turn('شماره تلفنم', configB);
  assert.equal(empty.pending?.status, 'awaiting_contact');
  assert.equal(empty.pending?.customerPhone ?? null, null);
  assert.equal(f.count.calendarWrites, 0);
  const completed = await f.turn('شماره تلفنم 0700002205 است.', configB);
  assert.equal(completed.pending, null);
  assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
  assert.equal(f.created[0].name, 'سارا نمونه'); assert.equal(f.created[0].phone, '0700002205');
  assert.equal(f.recorded[0].businessId, '8');
});
