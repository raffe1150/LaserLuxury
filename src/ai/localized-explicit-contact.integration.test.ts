import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
import { resolveAuthoritativeContact } from './channel-contact';
import { fixtureChannelSessionId } from '../../tests/fixtures/channel-session';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
type Channel = Parameters<typeof boundary.turn>[0]['platformName'];
const channels = ['instagram', 'messenger', 'telegram', 'whatsapp'] as const;
const phone = '0700001102';
const now = new Date('2027-05-20T12:00:00+02:00');
const start = '2027-05-21T15:30:00+02:00';
const end = '2027-05-21T14:00:00.000Z';
const baseBusiness = { id: '7', businessName: 'Synthetic Contact Clinic', timezone: 'Europe/Stockholm',
  defaultBookingService: 'Video Consultation', calendarProvider: 'custom', googleCalendarId: 'cal-7' };
function contact(text: string, channel: Channel, senderPhone?: string) {
  const parts = boundary.extractBookingContactParts(text);
  return { parts, resolved: resolveAuthoritativeContact({ channel,
    currentName: parts.combined?.name || parts.nameOnly,
    currentPhone: parts.combined?.phone || parts.phoneOnly, senderPhone }) };
}
const valid = [
  ['sv', 'Ja, jag heter Elin Testlund och mitt telefonnummer är 0700001102.', 'Elin Testlund'],
  ['de', 'Ja, mein Name ist Elin Testlund und meine Telefonnummer ist 0700001102.', 'Elin Testlund'],
  ['es', 'Sí, mi nombre es Elin Testlund y mi número de teléfono es 0700001102.', 'Elin Testlund'],
  ['sv', 'Ja jag heter Elin Anna Testlund och mitt telefonnummer är 0700001102.', 'Elin Anna Testlund'],
  ['de', 'Ja mein Name ist Elin Anna Testlund und meine Telefonnummer ist 0700001102.', 'Elin Anna Testlund'],
  ['es', 'Sí mi nombre es María del Carmen y mi número de teléfono es 0700001102.', 'María del Carmen'],
  ['sv', 'Ja, mitt namn är Elin Testlund och mitt mobilnummer är 0700001102.', 'Elin Testlund'],
  ['de', 'Ja, ich heiße Elin Testlund und meine Telefonnummer ist 0700001102.', 'Elin Testlund'],
  ['es', 'Sí, me llamo Elin Testlund y mi teléfono es 0700001102.', 'Elin Testlund'],
] as const;
for (const [language, text, name] of valid) test(`${language}: explicit self-contact boundary: ${text}`, () => {
  for (const channel of channels) {
    const { parts, resolved } = contact(text, channel, '+46700000001');
    process.stdout.write(`RC03D_PARSE ${JSON.stringify({ text, language, channel, parts, resolved })}\n`);
    assert.deepEqual(parts.combined, { name, phone });
    assert.equal(parts.nameOnly, name);
    assert.equal(parts.phoneOnly, phone);
    assert.equal(resolved.name, name); assert.equal(resolved.phone, phone);
    assert.equal(resolved.phoneSource, 'explicit_customer_message');
  }
});
const invalid = [
  'Ja, Alex Testsson, 0701234567.',
  'Ja, någon säger "jag heter Elin Testlund" och mitt telefonnummer är 0700001102.',
  'Ja, jag heter "Elin Testlund" och mitt telefonnummer är 0700001102.',
  'Ja, mein Name ist "Elin Testlund" und meine Telefonnummer ist 0700001102.',
  'Sí, mi nombre es "Elin Testlund" y mi número de teléfono es 0700001102.',
  'Ja, mein Freund heißt Elin Testlund und meine Telefonnummer ist 0700001102.',
  'Sí, mi amiga se llama Elin Testlund y mi número de teléfono es 0700001102.',
  'Ja, referens Elin Testlund 0700001102.',
  'Ja, beställningsnummer 0700001102.',
  'Ja, diagnostic ID Elin Testlund 0700001102.',
  'Ja, AIBB 0700001102 whatsapp-sv.',
  'Ja, jag heter AIBB 0700001102 whatsapp-sv.',
  'Ja, vi pratade om Elin Testlund och mitt telefonnummer är 0700001102.',
  'Ja, jag heter Elin eller Mira och mitt telefonnummer är 0700001102.',
  'Ja, mein Name ist Elin oder Mira und meine Telefonnummer ist 0700001102.',
  'Sí, mi nombre es Elin o Mira y mi número de teléfono es 0700001102.',
  'Ja, mein Name ist Bitte Buchen und meine Telefonnummer ist 0700001102.',
  'Sí, mi nombre es Quiero Reservar y mi número de teléfono es 0700001102.',
  'Ja, jag heter Elin Testlund och ordernummer är 0700001102.',
  'Ja, jag heter Elin Testlund och mitt telefonnummer är 123.',
  'Ja, jag heter Elin Testlund och mitt telefonnummer är 0700001102 eller 0700002202.',
  'Ja, jag heter Elin Testlund och mitt telefonnummer är 0700001102, eller mitt namn är Mira.',
] as const;
for (const text of invalid) test(`unsafe confirmation does not donate name: ${text}`, () => {
  const parts = boundary.extractBookingContactParts(text);
  assert.equal(parts.nameOnly, null); assert.equal(parts.combined, null);
});
for (const [language, text] of [
  ['sv', 'Ja, mitt telefonnummer är 0700001102.'],
  ['de', 'Ja, meine Telefonnummer ist 0700001102.'],
  ['es', 'Sí, mi número de teléfono es 0700001102.'],
] as const) test(`${language}: explicit phone-only cannot fabricate a name`, () => {
  const parts = boundary.extractBookingContactParts(text);
  assert.equal(parts.nameOnly, null); assert.equal(parts.combined, null); assert.equal(parts.phoneOnly, phone);
});
for (const [text, name] of [
  ['Ja, jag heter Elin Testlund.', 'Elin Testlund'], ['Jag heter Elin Testlund.', 'Elin Testlund'],
  ['Ja, mein Name ist Elin Testlund.', 'Elin Testlund'], ['Mein Name ist Elin Testlund.', 'Elin Testlund'],
  ['Sí, mi nombre es Elin Testlund.', 'Elin Testlund'], ['Mi nombre es Elin Testlund.', 'Elin Testlund'],
] as const) test(`existing explicit name-only remains valid: ${text}`, () => {
  assert.equal(boundary.extractBookingContactParts(text).nameOnly, name);
  assert.equal(boundary.extractBookingContactParts(text).phoneOnly, null);
});
type Event = { id: string; status: string; summary: string; description: string;
  start: { dateTime: string }; end: { dateTime: string };
  extendedProperties: { private: { businessId: string; platform: Channel; userId: string } } };
function fixture(t: TestContext, channel: Channel, language: string, status = 'awaiting_confirmation') {
  const business = { ...baseBusiness, language };
  const withSender = false;
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
    boundary.seedFlowLanguage(session, language);
    boundary.seedPending(session, { businessId: config.id, platform: channel, userId: recipient, businessConfig: config,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', status,
      expectedInput: status === 'awaiting_confirmation' ? 'confirmation' : 'contact', service: 'Video Consultation', durationMinutes: 30, language,
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
    process.stdout.write(`RC03D ${JSON.stringify({ text, channel, businessId: config.id, parsed, pending: result.pending,
      operation: result.operation, replies: result.replies, count, created, recorded })}\n`);
    return result;
  }
  return { turn, seed, count, created, recorded, session, recipient };
}
for (const channel of channels) for (const [language, text, name] of valid.slice(0, 6))
  for (const status of ['awaiting_confirmation', 'awaiting_contact'])
    test(`${channel}/${language}/${status}: complete valid contact exactly once: ${name}`, async t => {
      const f = fixture(t, channel, language, status);
      assert.equal(f.count.calendarWrites, 0); assert.equal(f.count.bookingWrites, 0);
      const result = await f.turn(text);
      assert.equal(result.pending, null);
      assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
      assert.equal(f.created[0].name, name); assert.equal(f.created[0].phone, phone);
      assert.equal(f.created[0].service, 'Video Consultation'); assert.equal(f.created[0].dateTime, start);
      assert.equal(f.created[0].duration, 30); assert.equal(f.recorded[0].businessId, '7');
      assert.equal(f.recorded[0].platform, channel); assert.equal(f.recorded[0].userId, f.recipient);
      await f.turn(text);
      assert.equal(f.count.calendarWrites, 1); assert.equal(f.count.bookingWrites, 1);
    });
for (const text of invalid) test(`invalid/incomplete contact causes zero booking writes: ${text}`, async t => {
  const f = fixture(t, 'instagram', 'sv'); const result = await f.turn(text);
  assert.equal(result.pending?.customerName ?? null, null);
  assert.equal(f.count.calendarWrites, 0); assert.equal(f.count.bookingWrites, 0);
  assert.ok(result.pending); assert.equal(result.pending?.dateTime, start);
});
test('a valid name-only retains existing name-first then phone-only contact flow', async t => {
  const f = fixture(t, 'messenger', 'de');
  const result = await f.turn('Ja, mein Name ist Elin Testlund.');
  assert.equal(result.pending?.customerName, 'Elin Testlund'); assert.equal(f.count.bookingWrites, 0);
  const done = await f.turn('Meine Telefonnummer ist 0700001102.');
  assert.equal(done.pending, null); assert.equal(f.created[0].name, 'Elin Testlund');
  assert.equal(f.created[0].phone, phone); assert.equal(f.count.bookingWrites, 1);
});
test('business switch cannot donate A contact to B; B uses its own explicit contact', async t => {
  const f = fixture(t, 'messenger', 'es');
  const stored = await f.turn('Sí, mi nombre es Elin Testlund.');
  assert.equal(stored.pending?.customerName, 'Elin Testlund'); assert.equal(f.count.bookingWrites, 0);
  const configB = { ...baseBusiness, id: '8', language: 'es' };
  const switched = await f.turn('Sí', configB);
  assert.notEqual(switched.pending?.customerName, 'Elin Testlund'); assert.equal(f.count.bookingWrites, 0);
  f.seed(configB);
  const done = await f.turn('Sí, mi nombre es María del Carmen y mi número de teléfono es 0700002202.', configB);
  assert.equal(done.pending, null); assert.equal(f.count.bookingWrites, 1);
  assert.equal(f.created[0].name, 'María del Carmen'); assert.equal(f.created[0].phone, '0700002202');
  assert.equal(f.recorded[0].businessId, '8');
});
