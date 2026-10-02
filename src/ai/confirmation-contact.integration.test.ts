import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';
process.env.NODE_ENV = 'test';
process.env.STRUCTURED_UNDERSTANDING_ENABLED = 'false';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import(process.env.REMAINING_BOOKING_BASELINE === '1' ? '../../.remaining-baseline-server.ts' : '../../server');
const businessConfig = { id: '7', businessName: 'Test Clinic', timezone: 'Europe/Stockholm',
  calendarProvider: 'custom', googleCalendarId: 'cal-7', services: [{ name: 'Video Consultation', durationMinutes: 30 }] };
function fixture(channel: string) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = {
    calendarCreate: 0,
    databaseInsert: 0,
    createdName: '',
    createdPhone: '',
    createdService: '',
    createdStart: '',

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
        counters.createdService = _service;
        counters.createdStart = new Date(dateTime).toISOString();
        const id = `created-${++sequence}`;
        const start = new Date(dateTime).toISOString();
        const event = {
          id,
          status: 'confirmed',
          summary: `Booked: ${name} - ${phone}`,
          description: `BusinessId: 7\nPlatform: ${channel}\nUserId: ${marker}`,
          start: { dateTime: start },
          end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { businessId: '7', platform: channel, userId: marker } },
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
  });
  return counters;
}

const selectedStart = '2027-05-21T15:30:00+02:00';
const selectedEnd = '2027-05-21T14:00:00.000Z';
const sender = '46700000001';
const now = new Date('2027-05-20T12:00:00+02:00');
function seed(id: string, channel: string, language: string, status = 'awaiting_confirmation', name: string | null = null) {
  boundary.seedFlowLanguage(id, language);
  boundary.seedPending(id, { businessId: '7', platform: channel, userId: sender, businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION, operation: 'new_booking', language,
    status, expectedInput: status === 'awaiting_contact' ? 'contact' : 'confirmation',
    service: 'Video Consultation', selectedDate: '2027-05-21', durationMinutes: 30,
    dateTime: selectedStart, selectedSlotEnd: selectedEnd, customerName: name,
    // An untrusted stale number must never override the verified sender.
    customerPhone: channel === 'whatsapp' ? '0709999999' : null,
    ownedOfferedSlots: [{ businessId: '7', platform: channel, userId: sender,
      start: selectedStart, end: selectedEnd, service: 'Video Consultation', durationMinutes: 30, generatedAt: Date.now() }],
  });
}
const turn = (id: string, text: string, channel: any = 'whatsapp') => boundary.turn({
  sessionId: id, platformName: channel, recipientUserId: sender, text, businessConfig, now });
function silence(t: any) {
  for (const method of ['log', 'warn', 'error', 'info'] as const) t.mock.method(console, method, () => {});
  t.after(() => boundary.reset());
}
const examples = [
  ['fa', 'بله، اسم من نادیا است', 'نادیا'],
  ['fa', 'بله اسم من نادیا است', 'نادیا'],
  ['ar', 'نعم، اسمي لينا اختبار', 'لينا اختبار'],
  ['es', 'Sí, me llamo Lucía Prueba', 'Lucía Prueba'],
  ['en', 'Yes, my name is Maya Testwell', 'Maya Testwell'],
  ['sv', 'Ja, jag heter Elin Testlund', 'Elin Testlund'],
  ['de', 'Ja, mein Name ist Mira Testmann', 'Mira Testmann'],
  ['ar', 'نعم، اسمي سلمى منصور AIBB 93414557 whatsapp-ar. قال لي أحدهم "hej".', 'سلمى منصور'],
  ['fa', 'بله اسم من نیلوفر آزمون است AIBB 93414557 whatsapp-fa.', 'نیلوفر آزمون'],
  ['en', 'Yes, my name is Nora Testfield AIBB 93414557 Friday at 11:00 Laser whatsapp-en.', 'Nora Testfield'],
  ['ar', 'نعم، اسمي سلمى منصور. وبالمناسبة، قال لي أحدهم اليوم "hej".', 'سلمى منصور'],
  ['fa', 'بله اسم من نیلوفر آزمون است. ضمناً امروز کسی به من "hej" گفت.', 'نیلوفر آزمون'],
  ['es', 'Sí, me llamo Lucía Prueba. Alguien dijo "hej".', 'Lucía Prueba'],
] as const;
for (const [language, message, name] of examples) test(`confirmation consumes explicit ${language} name: ${message}`, async t => {
  silence(t); const c = fixture('whatsapp'); const id = sender; seed(id, 'whatsapp', language);
  const r = await turn(id, message);
  assert.equal(r.handled, true); assert.equal(c.calendarCreate, 1); assert.equal(c.databaseInsert, 1);
  assert.equal(c.createdName, name); assert.equal(c.createdPhone, `+${sender}`);
  assert.equal(c.createdService, 'Video Consultation'); assert.equal(c.createdStart, new Date(selectedStart).toISOString());
  assert.equal(r.pending, null);
  assert.match(r.replies.join(' '), new RegExp(name));
  await turn(id, message);
  assert.equal(c.calendarCreate, 1, 'repeated confirmation cannot create twice'); assert.equal(c.databaseInsert, 1);
});
for (const [language, message] of [
  ['fa', 'بله'], ['ar', 'نعم'], ['es', 'Sí'], ['en', 'Yes'], ['sv', 'Ja'], ['de', 'Ja'],
  ['en', 'Yes, my name is 1234'], ['ar', 'نعم، اسمي 1234'], ['fa', 'بله اسم من'],
  ['en', 'Yes, my name is AIBB 93414557 whatsapp-en.'],
  ['ar', 'نعم، اسمي AIBB 93414557 whatsapp-ar.'],
  ['en', 'Yes, someone said "my name is Maya Testwell"'],
  ['en', 'Yes, my name is please book'], ['ar', 'نعم، اسمي نعم'],
  ['es', 'Sí, me llamo quiero reservar'], ['de', 'Ja, mein Name ist Bitte Buchen'],
  ['en', 'Yes, my name is Maya Testwell or Nora Other'],
  ['en', 'Yes, my name is Maya Testwell, or Nora Other'],
  ['fa', 'بله اسم من نادیا است یا میرا'],
  ['en', 'Yes, someone said "my name is Maya Testwell" and my phone number is 0701234567'],
  ['en', 'Yes, my name is "Maya Testwell"'],
] as const) test(`confirmation without valid self-identification stays safe: ${message}`, async t => {
  silence(t); const c = fixture('whatsapp'); const id = sender; seed(id, 'whatsapp', language);
  const r = await turn(id, message);
  assert.equal(c.calendarCreate, 0); assert.equal(c.databaseInsert, 0);
  assert.equal(r.pending?.customerName, null); assert.ok(['awaiting_contact', 'awaiting_confirmation'].includes(r.pending?.status), 'invalid/ambiguous input retains a safe incomplete booking');
  assert.equal(r.pending?.service, 'Video Consultation'); assert.equal(r.pending?.selectedDate, '2027-05-21');
  assert.equal(new Date(r.pending?.dateTime).toISOString(), new Date(selectedStart).toISOString());
  assert.equal(r.pending?.customerPhone, message.includes('my phone number is 0701234567') ? '0701234567' : `+${sender}`); assert.ok(r.replies.length > 0);
});
for (const [language, name] of [['fa', 'نادیا'], ['ar', 'لينا اختبار'], ['es', 'Lucía Prueba'], ['en', 'Maya Testwell']] as const)
  test(`standalone ${language} name after confirmation is unchanged`, async t => {
    silence(t); const c = fixture('whatsapp'); const id = sender;
    seed(id, 'whatsapp', language, 'awaiting_contact'); const r = await turn(id, name);
    assert.equal(c.calendarCreate, 1); assert.equal(c.databaseInsert, 1); assert.equal(c.createdPhone, `+${sender}`);
    assert.equal(c.createdName, name); assert.equal(r.pending, null);
  });
for (const [message, name, complete] of [
  ['Yes, my phone number is 0701234567', null, false],
  ['Yes, my phone number is 0701234567', 'Maya Testwell', true],
  ['Yes, my name is Maya Testwell and my phone number is 0701234567', null, true],
  ['نعم، اسمي لينا اختبار ورقم هاتفي 0701234567', null, true],
  ['بله اسم من نادیا است و شماره تلفن 0701234567', null, true],
] as const) test(`confirmation contact phone remains usable: ${message}, stored name ${name}`, async t => {
  silence(t); const c = fixture('telegram'); const id = sender; seed(id, 'telegram', 'en', 'awaiting_confirmation', name);
  const r = await turn(id, message, 'telegram');
  assert.equal(c.calendarCreate, complete ? 1 : 0); assert.equal(c.databaseInsert, complete ? 1 : 0);
  if (complete) assert.equal(c.createdPhone, '0701234567');
  else { assert.equal(r.pending?.customerPhone, '0701234567'); assert.equal(r.pending?.customerName, null); }
});
