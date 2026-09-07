import assert from 'node:assert/strict';
import { beginBookingFinalization, getMissingBookingContact } from './booking-state-machine';
process.env.NODE_ENV = 'test';
// No fixture may reach an external persistence or AI endpoint.
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const log = console.log;
console.log = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
let activeChannel: 'instagram' | 'messenger' | 'telegram' | 'whatsapp' = 'instagram';
const now = new Date('2026-09-07T09:00:00+02:00');
const businessConfig = { id: '7', businessName: 'Intake Clinic', language: 'en', toneConfig: {} as any, timezone: 'Europe/Stockholm',
  calendarProvider: 'custom', googleCalendarId: 'cal-7',
  workingHours: { monday: [{ start: '13:15', end: '17:00' }] }, bookingBufferMinutes: 15,
  services: [{ name: 'test', duration: 30 }, { name: 'Skin Care', duration: 60 }] };
function fixture(structuredUnderstandingAdoptionRuntime?: any) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = {
    calendarCreate: 0,
    databaseInsert: 0,
    createdName: '',
    createdPhone: '',
    blockSlot(start: string, durationMinutes = 30) {
      const startIso = new Date(start).toISOString();
      events.set(`blocked-${startIso}`, {
        id: `blocked-${startIso}`,
        status: 'confirmed',
        start: { dateTime: startIso },
        end: { dateTime: new Date(new Date(startIso).getTime() + durationMinutes * 60_000).toISOString() },
      });
    },
  };
  let sequence = 0;
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      checkSlots: async () => ({ available_slots_string: '' }),
      getEvents: async () => [...events.values()],
      insertAppointment: async (name: string, phone: string, _service: string, dateTime: string, duration = 30, marker = '') => {
        counters.calendarCreate += 1;
        counters.createdName = name;
        counters.createdPhone = phone;
        const id = `created-${++sequence}`;
        const start = new Date(dateTime).toISOString();
        const event = {
          id,
          status: 'confirmed',
          summary: `Booked: ${name} - ${phone}`,
          description: `BusinessId: 7\nPlatform: ${activeChannel}\nUserId: ${marker}`,
          start: { dateTime: start },
          end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { businessId: '7', platform: activeChannel, userId: marker } },
        };
        events.set(id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    recordAppointment: async (params: any) => {
      counters.databaseInsert += 1;
      return {
        id: counters.databaseInsert,
        business_id: '7',
        platform: params.platform,
        user_id: String(params.userId),
        service: params.service,
        start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + Number(params.durationMinutes) * 60_000).toISOString(),
        status: 'booked',
      };
    },
    claimOperation: async (params: any) => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const existing = claims.get(key);
      if (existing) return { ...existing, claimed: false, duplicateStatus: existing.state.status };
      const handle = { claimed: true, keyHash: key, storageId: key, state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() } };
      claims.set(key, handle);
      return handle;
    },
    settleOperation: async (handle: any, status: 'completed' | 'failed') => {
      handle.state.status = status;
      return true;
    },
    ...(structuredUnderstandingAdoptionRuntime ? { structuredUnderstandingAdoptionRuntime } : {}),
  });
  return counters;
}


try {
  for (const customerName of [null, '', 'Test', 'Yes']) {
    const incomplete = { status: 'awaiting_contact', service: 'test', customerName, customerPhone: '0700001101',
      dateTime: '2026-09-14T13:15:00+02:00', selectedSlotEnd: '2026-09-14T11:45:00Z' };
    assert.deepEqual(getMissingBookingContact(incomplete), ['name']);
    assert.equal(beginBookingFinalization(incomplete), false);
    assert.equal(incomplete.status, 'awaiting_contact');
  }
  for (const channel of ['instagram', 'messenger', 'telegram', 'whatsapp'] as const) {
    activeChannel = channel;
    const counters = fixture();
    const userId = channel === 'whatsapp' ? '46700001101' : 'customer-intake-1';
    const sessionId = boundary.channelSessionId(channel, userId, businessConfig);
    const turn = (text: string) => boundary.turn({ sessionId, platformName: channel, recipientUserId: userId, businessConfig, text, now });
    await turn("Hello, I'd like to book an appointment for Monday, 14 September 2026.");
    await turn("I'd like to book wedding photography for Monday, 14 September 2026.");
    const offered = await turn('test');
    assert.equal(offered.pending?.customerName ?? null, null, `${channel}: service selection cannot donate customer name`);
    await turn('13:15 works for me. Please use that time.');
    const confirmed = await turn('Yes, please complete the booking.');
    assert.equal(confirmed.pending?.status, 'awaiting_contact');
    assert.match(confirmed.replies.join(' '), /name/iu);
    if (channel === 'whatsapp') assert.doesNotMatch(confirmed.replies.join(' '), /mobile|phone/iu);
    else assert.match(confirmed.replies.join(' '), /mobile|phone/iu);
    assert.equal(counters.calendarCreate, 0);
    const phoneOnly = await turn('My phone number is 0700001101.');
    assert.equal(phoneOnly.pending?.status, 'awaiting_contact');
    assert.equal(phoneOnly.pending?.customerName ?? null, null);
    assert.match(phoneOnly.replies.join(' '), /name/iu);
    assert.doesNotMatch(phoneOnly.replies.join(' '), /mobile|phone/iu);
    assert.equal(counters.calendarCreate, 0);
    const completed = await turn('My name is Ada Lovelace.');
    assert.equal(counters.calendarCreate, 1, channel);
    assert.equal(counters.databaseInsert, 1, channel);
    assert.equal(counters.createdName, 'Ada Lovelace');
    assert.equal(counters.createdPhone, channel === 'whatsapp' ? '+46700001101' : '0700001101');
    assert.match(completed.replies.join(' '), /Ada Lovelace/);
    assert.match(completed.replies.join(' '), /test/);
    assert.match(completed.replies.join(' '), /14 September.*13:15/);
    await turn('Yes, please complete the booking.');
    assert.equal(counters.calendarCreate, 1, 'Repeated confirmation cannot duplicate a booking');
  }
  for (const channel of ['instagram', 'messenger', 'telegram', 'whatsapp'] as const) {
    for (const known of ['name', 'phone', 'both', 'legacy-service-name', 'other-service-name', 'earlier-text'] as const) {
      activeChannel = channel;
      const counters = fixture();
      const userId = channel === 'whatsapp' ? '46700001101' : 'customer-known-fields';
      const sessionId = boundary.channelSessionId(channel, userId, businessConfig);
      const turn = (text: string) => boundary.turn({ sessionId, platformName: channel, recipientUserId: userId, businessConfig, text, now });
      await turn("I'd like to book an appointment for Monday, 14 September 2026.");
      if (known === 'earlier-text') {
        const unrelated = await turn('Banana spaceship');
        assert.equal(unrelated.pending?.customerName ?? null, null, 'Earlier arbitrary words are not a name');
      }
      if (known === 'name' || known === 'both') await turn('My name is Ada Lovelace.');
      if (known === 'phone' || known === 'both') await turn('My phone number is 0700001101.');
      await turn('test');
      const selected = await turn('13:15 works for me. Please use that time.');
      if (known === 'legacy-service-name' || known === 'other-service-name') {
        boundary.seedPending(sessionId, { ...selected.pending, customerName: known === 'legacy-service-name' ? 'Test' : 'Skin Care' });
      }
      const result = await turn('Yes, please complete the booking.');
      const nameKnown = known === 'name' || known === 'both';
      const phoneKnown = channel === 'whatsapp' || known === 'phone' || known === 'both';
      const label = `${channel}/${known}`;
      assert.equal(counters.calendarCreate, nameKnown && phoneKnown ? 1 : 0, label);
      if (!nameKnown || !phoneKnown) {
        assert.equal(result.pending?.status, 'awaiting_contact', label);
        assert.equal(/name/iu.test(result.replies.join(' ')), !nameKnown, label);
        assert.equal(/mobile|phone/iu.test(result.replies.join(' ')), !phoneKnown, label);
        assert.equal(result.pending?.customerName ?? null, nameKnown ? 'Ada Lovelace' : null, label);
      } else {
        assert.equal(counters.createdName, 'Ada Lovelace', label);
        assert.doesNotMatch(result.replies.join(' '), /provide|send your|need your/iu, label);
      }
    }
  }
  const toneReplies: string[] = [];
  for (const tonePreset of ['professional', 'warm']) {
    activeChannel = 'instagram';
    businessConfig.toneConfig = { tonePreset, responseLength: 'detailed', formality: 'balanced', emojiUsage: 'none' };
    const counters = fixture();
    const sessionId = boundary.channelSessionId('instagram', 'tone-customer', businessConfig);
    const turn = (text: string) => boundary.turn({ sessionId, platformName: 'instagram', recipientUserId: 'tone-customer', businessConfig, text, now });
    await turn("I'd like to book test for Monday, 14 September 2026.");
    await turn('13:15 works for me. Please use that time.');
    const intake = await turn('Yes, please complete the booking.');
    assert.match(intake.replies.join(' '), /name and mobile number/);
    assert.doesNotMatch(intake.replies.join(' '), /safely continue/);
    const booked = await turn('My name is Ada Lovelace and my phone number is 0700001101.');
    assert.equal(counters.calendarCreate, 1);
    for (const fact of ['Ada Lovelace', 'test', '14 September', '13:15']) assert.ok(booked.replies.join(' ').includes(fact), fact);
    toneReplies.push(intake.replies.join(' '));
  }
  assert.notEqual(toneReplies[0], toneReplies[1], 'Dashboard tone affects the actual shared intake reply');
  log('customer intake service isolation regressions passed');
} finally { boundary.reset(); console.log = log; }
