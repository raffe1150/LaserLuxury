import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: '7',
  businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Video Consultation',
  services: ['Video Consultation', 'test', 'video for tiktok', 'Golden video', 'Reklam'].map(name => ({ name, duration: 30 })),
  calendarProvider: 'custom',
  googleCalendarId: 'cal-7',
};

function fixture(activeChannel = 'telegram', structuredUnderstandingAdoptionRuntime?: any) {
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
        assert.equal(_service, 'Video Consultation');
        assert.equal(new Date(dateTime).getTime(), new Date(selectedStart).getTime());
        assert.equal(duration, 30);
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

const selectedStart = '2026-09-09T14:15:00+02:00';
const selectedEnd = '2026-09-09T12:45:00.000Z';
const now = new Date('2026-09-08T12:00:00+02:00');

function seedCanonicalAlternatives(sessionId: string) {
  const pending: any = {
    businessId: '7', platform: 'telegram', userId: sessionId, businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', service: 'Video Consultation', status: 'awaiting_time_selection',
    selectedDate: '2026-09-09', durationMinutes: 30,
    normalizedBookingRequest: {
      intent: 'new_booking', language: 'en',
      service: { raw: 'Video Consultation', normalized: 'Konsultation', confidence: 'high' },
      date: { kind: 'weekday', value: '2026-09-09', weekday: 5, confidence: 'high' },
      timeConstraint: { kind: 'exact', startMinutes: 990, startInclusive: true, endInclusive: true, confidence: 'high' },
      sourceMode: 'text', normalizedText: 'Video Consultation Friday at unavailable 16:30', requiresClarification: false,
    },
    availabilityConstraint: { startDate: '2026-09-09', endDate: '2026-09-09', kind: 'exact_time', exactTime: '16:30', rejectedTimes: [] },
    offeredSlots: [`Friday at 14:15 (ISO: ${selectedStart})`],
    ownedOfferedSlots: [{
      start: selectedStart, end: selectedEnd, durationMinutes: 30, service: 'Video Consultation',
      businessId: '7', platform: 'telegram', userId: sessionId, generatedAt: Date.now(),
      searchStartDate: '2026-09-09', searchEndDate: '2026-09-09',
    }],
  };
  boundary.seedPending(sessionId, pending);
  return pending;
}

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'telegram',
  recipientUserId: sessionId,
  text,
  businessConfig,
  now,
});

// Whole-token matches remain available, including punctuation and Unicode.
for (const text of ['test', 'Please book test.', 'Bitte test buchen.', 'test!']) {
  assert.equal(boundary.resolveConfiguredService(text, businessConfig), 'test');
}
for (const text of ['Alex Testsson', 'Contest', 'testé', 'testمحمد', 'محمدtest', 'test\u0301']) {
  assert.equal(boundary.resolveConfiguredService(text, businessConfig), null, text);
}
assert.equal(boundary.resolveConfiguredService('Consultation', businessConfig), 'Video Consultation');

// Latest full-booking matrix confirmations, through the shared production boundary.
const matrixConfirmations = {
  en: 'Yes, please complete the booking.', sv: 'Ja, slutför bokningen tack.',
  es: 'Sí, complete la reserva, por favor.', de: 'Ja, bitte schließen Sie die Buchung ab.',
  fa: 'بله، لطفاً رزرو را نهایی کنید.', ar: 'نعم، يرجى إتمام الحجز.',
};
for (const platformName of ['instagram', 'whatsapp', 'messenger', 'telegram']) {
  for (const [language, text] of Object.entries(matrixConfirmations)) {
    const counts = fixture(platformName);
    const sessionId = `matrix-confirm-${platformName}-${language}`;
    const pending = seedCanonicalAlternatives(sessionId);
    pending.platform = platformName;
    pending.language = language;
    pending.normalizedBookingRequest.language = language;
    pending.ownedOfferedSlots[0].platform = platformName;
    boundary.seedPending(sessionId, pending);
    const selection = await boundary.turn({ sessionId, platformName, recipientUserId: sessionId,
      text: '14:15 works for me. Please use that time.', businessConfig, now });
    assert.equal(selection.pending?.status, 'awaiting_confirmation');
    const result = await boundary.turn({ sessionId, platformName, recipientUserId: sessionId, text, businessConfig, now });
    assert.equal(result.pending?.status, 'awaiting_contact', `${platformName}/${language}: confirmation must advance`);
    assert.equal(result.pending?.dateTime, selectedStart);
    assert.equal(result.pending?.selectedSlotEnd, selectedEnd);
    assert.equal(counts.calendarCreate, 0, 'missing contact cannot create a booking');
    assert.equal(counts.databaseInsert, 0);
    const contacts = {
      en: 'My name is Alex Testsson and my phone number is 0701234567.',
      sv: 'Jag heter Alex Testsson och mitt telefonnummer är 0701234567.',
      es: 'Mi nombre es Alex Testsson y mi número de teléfono es 0701234567.',
      de: 'Mein Name ist Alex Testsson und meine Mobilnummer ist 0701234567.',
      fa: 'Alex Testsson, 0701234567',
      ar: 'Alex Testsson, 0701234567',
    };
    let completed = await boundary.turn({ sessionId, platformName, recipientUserId: sessionId,
      text: contacts[language], businessConfig, now });
    assert.equal(completed.pending, null, `${platformName}/${language}: contact completes`);
    assert.equal(counts.calendarCreate, 1);
    assert.equal(counts.databaseInsert, 1);
    assert.equal(counts.createdName, 'Alex Testsson');
    assert.equal(counts.createdPhone, '0701234567');
    assert.match(completed.replies.join(' '), /2026|۲۰۲۶|٢٠٢٦/u);
    assert.doesNotMatch(completed.replies.join(' '), /unchanged|oförändrad|sin cambios|unverändert|بدون تغییر|لم يتغير/iu);
    await boundary.turn({ sessionId, platformName, recipientUserId: sessionId,
      text: contacts[language], businessConfig, now });
    assert.equal(counts.calendarCreate, 1, 'replayed contact cannot duplicate the booking');
    assert.equal(counts.databaseInsert, 1);

  }
}
// A newly occupied selected slot must still fail final validation.
{
  const counts = fixture();
  const sessionId = 'contact-collision-calendar-conflict';
  seedCanonicalAlternatives(sessionId);
  await turn(sessionId, '14:15 works for me.');
  await turn(sessionId, matrixConfirmations.en);
  counts.blockSlot(selectedStart);
  const result = await turn(sessionId, 'My name is Alex Testsson and my phone number is 0701234567.');
  assert.equal(counts.calendarCreate, 0);
  assert.equal(counts.databaseInsert, 0);
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.dateTime, null);
}

// Exact customer turns from BlackBox ec9d648a-2075-4128-b7be-478b8e10e68b,
// starting with empty mocked state; no production conversation reset is used.
{
  const counts = fixture('instagram');
  const sessionId = 'evidence-german-contact-loop';
  const texts = [
    'Hallo, ich möchte für morgen einen Termin buchen.',
    'Ich möchte einen Termin für eine Haarbehandlung buchen.',
    'Ich möchte einen Termin für eine Video Consultation buchen.',
    '14:15 wäre perfekt.',
    'Ja, bitte buche den Termin für Mittwoch, 9. September um 14:15 Uhr.',
    'Mein Name ist Alex Testsson und meine Mobilnummer ist 0701234567.',
  ];
  for (const [index, text] of texts.entries()) {
    const result = await boundary.turn({ sessionId, platformName: 'instagram',
      recipientUserId: sessionId, text, businessConfig, now });
    if (index === 4) {
      assert.equal(result.pending?.status, 'awaiting_contact');
      assert.equal(new Date(result.pending.dateTime).getTime(), new Date(selectedStart).getTime());
      assert.equal(counts.calendarCreate, 0);
    }
    if (index === 5) {
      assert.equal(result.pending, null);
      assert.equal(counts.calendarCreate, 1);
      assert.equal(counts.databaseInsert, 1);
    }
  }
}

boundary.reset();
console.log('24 multilingual contact/service collision regressions passed');
