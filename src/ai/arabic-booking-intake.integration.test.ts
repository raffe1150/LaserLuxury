import assert from 'node:assert/strict';
import { resolveAuthoritativeContact } from './channel-contact';
import { beginBookingFinalization, getMissingBookingContact } from './booking-state-machine';
process.env.NODE_ENV = 'test';
// No fixture may reach an external persistence or AI endpoint.
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const log = console.log;
console.log = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
let activeChannel: 'instagram' | 'messenger' | 'telegram' | 'whatsapp' = 'instagram';
const now = new Date('2026-09-07T09:00:00+02:00');
const businessConfig = { id: '7', businessName: 'Intake Clinic', language: 'ar', toneConfig: {} as any, timezone: 'Europe/Stockholm',
  calendarProvider: 'custom', googleCalendarId: 'cal-7',
  workingHours: { monday: [{ start: '11:00', end: '17:00' }] }, bookingBufferMinutes: 15,
  services: [{ name: 'test', duration: 30 }, { name: 'Skin Care', duration: 60 }, { name: 'تصوير شخصي', duration: 30 }] };
function fixture(structuredUnderstandingAdoptionRuntime?: any) {
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = {
    calendarCreate: 0,
    databaseInsert: 0,
    createdName: '',
    createdPhone: '',
    createdStart: '',
    createdDuration: 0,
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
        counters.createdStart = dateTime;
        counters.createdDuration = duration;
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
  const combined = 'اسمي لينا اختبار ورقم هاتفي 0700001106.';
  const nameOnly = 'اسمي لينا اختبار.';
  assert.deepEqual(boundary.extractBookingContactParts(combined).combined, { name: 'لينا اختبار', phone: '0700001106' });
  assert.equal(boundary.extractBookingContactParts(nameOnly).nameOnly, 'لينا اختبار');
  for (const text of ['نعم، اسمي لينا اختبار ورقم هاتفي 0700001106.', 'اسمي لينا اختبار، ورقم هاتفي ٠٧٠٠٠٠١١٠٦.']) {
    assert.deepEqual(boundary.extractBookingContactParts(text).combined, { name: 'لينا اختبار', phone: '0700001106' });
  }
  for (const name of ['لينا', 'لينا اختبار', 'محمد عبد الله أحمد', 'لَيْنَا اِخْتِبَار']) {
    assert.equal(boundary.extractBookingContactParts(`اسمي ${name}.`).nameOnly, name);
  }
  assert.equal(resolveAuthoritativeContact({ channel: 'instagram', serviceNames: ['تصوير شخصي'],
    currentName: boundary.extractBookingContactParts('اسمي تصوير شخصي.').nameOnly }).name, null);
  const negatives = ['أريد حجز موعد.', 'رقم هاتفي 0700001106.', 'اسمي أريد حجز موعد.',
    'اسمي لينا اختبار وأريد تغيير الموعد.', 'قالت اسمي لينا اختبار.', 'اسمي 1234.', 'اسمي نعم.', 'اسمي لينا؟'];
  for (const text of negatives) {
    assert.equal(boundary.extractBookingContactParts(text).nameOnly, null, text);
    assert.equal(boundary.extractPendingBookingCustomerName(text, { operation: 'new_booking', status: 'awaiting_contact' }), null, text);
  }
  for (const channel of ['instagram', 'messenger', 'telegram', 'whatsapp'] as const) {
    for (const mode of ['combined', 'name-first', 'phone-first', 'contaminated-service'] as const) {
      activeChannel = channel;
      const counters = fixture();
      const userId = channel === 'whatsapp' ? '46700001106' : 'arabic-intake';
      const sessionId = boundary.channelSessionId(channel, userId, businessConfig);
      const turn = (text: string) => boundary.turn({ sessionId, platformName: channel, recipientUserId: userId, businessConfig, text, now });
      await turn('مرحباً، أريد حجز موعد بتاريخ الاثنين، 14 سبتمبر 2026.');
      await turn('test');
      const selected = await turn('الساعة 11:00 تناسبني. يرجى اختيار هذا الوقت.');
      assert.equal(selected.pending?.status, 'awaiting_confirmation');
      const confirmed = await turn('نعم، يرجى إتمام الحجز.');
      assert.equal(confirmed.pending?.status, 'awaiting_contact');
      const assertRetained = (result: any) => {
        assert.equal(result.pending?.status, 'awaiting_contact');
        assert.equal(result.pending?.dateTime, selected.pending.dateTime);
        assert.equal(result.pending?.selectedSlotEnd, selected.pending.selectedSlotEnd);
        assert.equal(result.pending?.service, 'test');
        assert.equal(counters.calendarCreate, 0);
      };
      for (const text of ['رقم هاتفي غير معروف.', 'اسمي test.']) {
        const result = await turn(text);
        assertRetained(result);
        assert.equal(result.pending?.customerName ?? null, null);
      }
      if (mode === 'contaminated-service') {
        boundary.seedPending(sessionId, { ...confirmed.pending, customerName: 'تصوير شخصي' });
        const result = await turn('رقم هاتفي 0700001106.');
        assertRetained(result);
        assert.equal(result.pending?.customerName ?? null, null);
      }
      if (mode === 'phone-first') {
        const result = await turn('رقم هاتفي 0700001106.');
        assertRetained(result);
        assert.equal(result.pending?.customerName ?? null, null);
      }
      if (mode === 'name-first' && channel !== 'whatsapp') {
        const result = await turn(nameOnly);
        assertRetained(result);
        assert.equal(result.pending.customerName, 'لينا اختبار');
        await turn('رقم هاتفي 0700001106.');
      } else {
        await turn(mode === 'combined' ? combined : nameOnly);
      }
      assert.equal(counters.calendarCreate, 1, `${channel}/${mode}`);
      assert.equal(counters.databaseInsert, 1);
      assert.equal(counters.createdName, 'لينا اختبار');
      assert.equal(new Date(counters.createdStart).getTime(), new Date(selected.pending.dateTime).getTime());
      assert.equal(new Date(counters.createdStart).getTime() + counters.createdDuration * 60000, new Date(selected.pending.selectedSlotEnd).getTime());
      assert.equal(
        counters.createdPhone,
        channel === 'whatsapp' && mode === 'name-first'
          ? '+46700001106'
          : '0700001106'
      );
    }
  }
  log('Arabic extraction and 16 shared contact journeys passed');
} finally { boundary.reset(); console.log = log; }
