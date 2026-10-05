import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAuthoritativeContact } from './channel-contact';
import { PendingLeadStore } from '../../tests/helpers/pending-lead-store';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const now = new Date('2027-10-04T10:00:00Z');
const platforms = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
type Platform = typeof platforms[number];

function fixture(t: any, platform: Platform = 'whatsapp', withSender = true) {
  b.reset();
  t.after(() => b.reset());
  for (const key of ['log', 'info', 'error', 'warn'] as const) t.mock.method(console, key, () => undefined);
  const store = new PendingLeadStore();
  const events = new Map<string, any>();
  const writes = { calendar: 0, database: 0, reads: 0, scans: 0 };
  const config = {
    id: '7', businessRecordId: '7', business_id: '7', businessName: 'Contact Clinic',
    language: 'en', timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-7',
    services: [{ id: 'video', name: 'Video Consultation', duration: 30 }, { id: 'premium', name: 'Premium Consultation', duration: 60 }],
    workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      .map(day => [day, [{ start: '09:00', end: '20:00' }]])),
  };
  const userId = platform === 'whatsapp' && withSender ? '46700000001' : `booking-contact-${platform}`;
  const sessionId = platform === 'telegram' ? userId : b.channelSessionId(platform, userId, config, 'contact-test');
  const created: Array<{ name: string; phone: string; service: string; start: string }> = [];
  const recorded: any[] = [];
  const dependencies = {
    supabaseClient: store as any,
    semanticLanguageResolver: async () => null,
    availabilityDiagnostic: () => { writes.scans++; },
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      getEvents: async () => { writes.reads++; return [...events.values()]; },
      checkSlots: () => { assert.fail('legacy availability must not run'); },
      insertAppointment: async (name: string, phone: string, service: string, start: string, duration: number, marker: string) => {
        writes.calendar++;
        created.push({ name, phone, service, start });
        const event = { id: `event-${writes.calendar}`, status: 'confirmed', summary: `${name} - ${phone}`,
          start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${marker}`,
          extendedProperties: { private: { businessId: '7', platform, userId: marker } } };
        events.set(event.id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    notifyBooking: async () => true,
    validateAppointment: async (appointment: any) => appointment,
    recordAppointment: async (params: any) => {
      recorded.push(params);
      return { id: ++writes.database, business_id: '7', platform, user_id: userId,
        service: params.service, start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + params.durationMinutes * 60_000).toISOString(), status: 'booked' };
    },
  };
  b.configure(dependencies);
  const turn = async (text: string) => {
    await b.prepareConversationLanguage(sessionId, text, config);
    return b.turn({ sessionId, platformName: platform, recipientUserId: userId, text, businessConfig: config, now });
  };
  const reload = async () => { b.dropBookingSessionMemory(sessionId); return b.stateAuditRestore(sessionId, platform, config); };
  return { platform, config, userId, sessionId, store, writes, created, recorded, turn, reload };
}

const productionMessage = 'yes, my name is Maya and my number is 0548339586';
const typedPhone = '0548339586';
const senderPhone = '+46700000001';
async function selectSlot(f: ReturnType<typeof fixture>) {
  const initial = await f.turn('I want to book an appointment');
  assert.equal(initial.pending?.status, 'awaiting_service');
  await f.turn('Video Consultation');
  const offers = await f.turn('tomorrow');
  assert.equal(offers.pending?.status, 'awaiting_time_selection');
  const selected = await f.turn('2');
  assert.equal(selected.pending?.status, 'awaiting_confirmation');
  assert.equal(f.writes.calendar, 0);
  assert.equal(f.writes.database, 0);
  return selected.pending!;
}
async function awaitingContact(f: ReturnType<typeof fixture>) {
  const selected = await selectSlot(f);
  const authorized = await f.turn('yes');
  assert.equal(authorized.pending?.status, 'awaiting_contact');
  assert.equal(authorized.pending?.dateTime, selected.dateTime);
  return authorized.pending!;
}
function assertRetained(pending: any, before: any) {
  for (const field of ['service', 'serviceId', 'selectedDate', 'dateTime', 'selectedSlotEnd', 'language']) {
    assert.equal(pending[field], before[field], field);
  }
  assert.deepEqual(pending.ownedOfferedSlots, before.ownedOfferedSlots);
}
async function assertCompleted(f: ReturnType<typeof fixture>, result: any, phone: string) {
  assert.equal(result.pending, null, JSON.stringify(result));
  assert.equal(f.writes.calendar, 1);
  assert.equal(f.writes.database, 1);
  assert.equal(f.created[0].name, 'Maya');
  assert.equal(f.created[0].phone, phone);
  assert.equal(f.created[0].service, 'Video Consultation');
  assert.equal(f.recorded[0].name, 'Maya');
  assert.equal(f.recorded[0].phone, phone);
  assert.equal(f.recorded[0].userId, f.userId, 'contact phone cannot change channel ownership');
  const reply = result.replies.join('\n');
  assert.ok(reply.includes('Name: Maya'), reply);
  assert.ok(reply.includes(`Mobile: ${phone}`), reply);
  assert.doesNotMatch(reply, /need your name|provide your name|send your name/iu);
  const rows = f.store.rows.filter(row => row.platform === f.platform);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ai_summary, null, 'pending state clears after verified completion');
  await f.turn('yes');
  assert.equal(f.writes.calendar, 1, 'replay cannot create another calendar booking');
  assert.equal(f.writes.database, 1, 'replay cannot insert another booking');
}

test('exact combined production message extracts both explicit fields', () => {
  const parts = b.extractBookingContactParts(productionMessage);
  assert.deepEqual(parts.combined, { name: 'Maya', phone: typedPhone });
  assert.equal(parts.nameOnly, 'Maya');
  assert.equal(parts.phoneOnly, typedPhone);
});

for (const withSender of [true, false]) for (const reload of [true, false]) {
  test(`WhatsApp exact confirmation + contact: sender=${withSender}, reload=${reload}`, async t => {
    const f = fixture(t, 'whatsapp', withSender);
    const selected = await selectSlot(f);
    assert.equal(selected.customerPhone, withSender ? senderPhone : null);
    if (reload) {
      const restored = await f.reload();
      assertRetained(restored, selected);
      assert.equal(restored.expectedInput, 'confirmation');
    }
    const completed = await f.turn(productionMessage);
    // The existing product policy deliberately permits explicit typed overrides.
    // A verified sender is the fallback when no explicit phone was supplied.
    await assertCompleted(f, completed, typedPhone);
  });
}

for (const platform of platforms) for (const message of [
  'my name is Maya', 'I’m Maya', 'Maya is my name', 'yes, my name is Maya',
  productionMessage, 'my name is Maya and my number is 0548339586',
]) {
  test(`${platform}: awaiting-contact reply retains Maya: ${message}`, async t => {
    const f = fixture(t, platform);
    const before = await awaitingContact(f);
    await f.reload();
    const result = await f.turn(message);
    const explicitPhone = message.includes(typedPhone);
    if (platform === 'whatsapp' || explicitPhone) {
      await assertCompleted(f, result, explicitPhone ? typedPhone : senderPhone);
    } else {
      assert.equal(result.pending?.status, 'awaiting_contact');
      assert.equal(result.pending?.customerName, 'Maya');
      assert.equal(result.pending?.customerPhone, null, 'other channels never infer a phone from sender identity');
      assertRetained(result.pending, before);
      assert.equal(f.writes.calendar, 0);
      assert.equal(f.writes.database, 0);
      const restored = await f.reload();
      assert.equal(restored.customerName, 'Maya');
      assert.equal(restored.expectedInput, 'contact');
      await assertCompleted(f, await f.turn(typedPhone), typedPhone);
    }
  });
}

for (const platform of platforms) {
  test(`${platform}: phone-only reply preserves the missing name across reload`, async t => {
    const f = fixture(t, platform);
    const before = await awaitingContact(f);
    const phoneOnly = await f.turn(typedPhone);
    assert.equal(phoneOnly.pending?.customerName, null);
    assert.equal(phoneOnly.pending?.customerPhone, typedPhone);
    assert.equal(phoneOnly.pending?.contactPhoneSource, 'explicit_customer_message');
    assertRetained(phoneOnly.pending, before);
    assert.equal(f.writes.calendar, 0);
    assert.equal(f.writes.database, 0);
    const restored = await f.reload();
    assert.equal(restored.customerPhone, typedPhone);
    assert.equal(restored.contactPhoneSource, 'explicit_customer_message');
    await assertCompleted(f, await f.turn('my name is Maya'), typedPhone);
  });
}

test('WhatsApp without sender metadata retains the name until explicit phone arrives after reload', async t => {
  const f = fixture(t, 'whatsapp', false);
  const before = await awaitingContact(f);
  const named = await f.turn('my name is Maya');
  assert.equal(named.pending?.customerName, 'Maya');
  assert.equal(named.pending?.customerPhone, null);
  assertRetained(named.pending, before);
  const restored = await f.reload();
  assert.equal(restored.customerName, 'Maya');
  assert.equal(restored.contactPhoneSource, 'missing');
  await assertCompleted(f, await f.turn(typedPhone), typedPhone);
});

test('WhatsApp stored verified phone survives reload when current sender metadata is absent', async t => {
  const f = fixture(t, 'whatsapp', false);
  const before = await awaitingContact(f);
  await b.stateAuditPersist(f.sessionId, 'whatsapp', { ...before, customerPhone: senderPhone,
    contactPhoneSource: 'verified_sender_metadata' });
  const restored = await f.reload();
  assert.equal(restored.customerPhone, senderPhone);
  await assertCompleted(f, await f.turn('my name is Maya'), senderPhone);
});

test('WhatsApp self-identification without authorization does not book a selected slot', async t => {
  const f = fixture(t);
  const selected = await selectSlot(f);
  const named = await f.turn('my name is Maya');
  assert.equal(named.pending?.status, 'awaiting_confirmation');
  assert.equal(named.pending?.customerName, 'Maya');
  assertRetained(named.pending, selected);
  assert.equal(f.writes.calendar, 0);
  assert.equal(f.writes.database, 0);
  await assertCompleted(f, await f.turn('yes'), senderPhone);
});

test('existing phone authority order remains explicit current, explicit stored, sender, eligible stored', () => {
  const base = { channel: 'whatsapp' as const, currentName: 'Maya', senderPhone,
    storedPhone: '+46709999999', storedPhoneSource: 'verified_sender_metadata' as const };
  assert.equal(resolveAuthoritativeContact({ ...base, currentPhone: typedPhone }).phone, typedPhone);
  assert.equal(resolveAuthoritativeContact({ ...base, storedPhone: typedPhone, storedPhoneSource: 'explicit_customer_message' }).phone, typedPhone);
  assert.equal(resolveAuthoritativeContact(base).phone, senderPhone);
  assert.equal(resolveAuthoritativeContact({ ...base, senderPhone: null }).phone, base.storedPhone);
  assert.equal(resolveAuthoritativeContact({ ...base, senderPhone: null, storedPhoneSource: 'stored_validated' }).phone, null);
  for (const channel of ['telegram', 'instagram', 'messenger'] as const) {
    assert.equal(resolveAuthoritativeContact({ channel, currentName: 'Maya', senderPhone }).phone, null);
    assert.equal(resolveAuthoritativeContact({ channel, currentName: 'Maya', senderPhone,
      storedPhone: typedPhone, storedPhoneSource: 'stored_validated' }).phone, typedPhone);
  }
});

test('bounded explicit-name parsing does not accept quoted identities, ambiguous names or reference digits', () => {
  for (const message of [
    'yes, someone said "my name is Maya" and my number is 0548339586',
    'yes, my name is Maya or Nora and my number is 0548339586',
    'yes, my name is Maya and my order number is 0548339586',
  ]) {
    assert.equal(b.extractBookingContactParts(message).combined, null, message);
  }
  for (const message of ['Someone said Maya is my name', '"Maya is my name"', 'Maya or Nora is my name']) {
    assert.equal(b.extractPendingBookingCustomerName(message, { operation: 'new_booking', status: 'awaiting_contact',
      expectedInput: 'contact' }), null, message);
  }
});
