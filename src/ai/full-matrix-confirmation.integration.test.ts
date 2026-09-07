import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const businessConfig = {
  id: '7',
  businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Video Consultation',
  calendarProvider: 'custom',
  googleCalendarId: 'cal-7',
};

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
          description: `BusinessId: 7\nPlatform: telegram\nUserId: ${marker}`,
          start: { dateTime: start },
          end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { businessId: '7', platform: 'telegram', userId: marker } },
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

const selectedStart = '2027-05-21T15:30:00+02:00';
const selectedEnd = '2027-05-21T14:00:00.000Z';
const now = new Date('2027-05-20T12:00:00+02:00');

function seedCanonicalAlternatives(sessionId: string) {
  const pending: any = {
    businessId: '7', platform: 'telegram', userId: sessionId, businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', service: 'Video Consultation', status: 'awaiting_time_selection',
    selectedDate: '2027-05-21', durationMinutes: 30,
    normalizedBookingRequest: {
      intent: 'new_booking', language: 'en',
      service: { raw: 'Video Consultation', normalized: 'Konsultation', confidence: 'high' },
      date: { kind: 'weekday', value: '2027-05-21', weekday: 5, confidence: 'high' },
      timeConstraint: { kind: 'exact', startMinutes: 990, startInclusive: true, endInclusive: true, confidence: 'high' },
      sourceMode: 'text', normalizedText: 'Video Consultation Friday at unavailable 16:30', requiresClarification: false,
    },
    availabilityConstraint: { startDate: '2027-05-21', endDate: '2027-05-21', kind: 'exact_time', exactTime: '16:30', rejectedTimes: [] },
    offeredSlots: [`Friday at 15:30 (ISO: ${selectedStart})`],
    ownedOfferedSlots: [{
      start: selectedStart, end: selectedEnd, durationMinutes: 30, service: 'Video Consultation',
      businessId: '7', platform: 'telegram', userId: sessionId, generatedAt: Date.now(),
      searchStartDate: '2027-05-21', searchEndDate: '2027-05-21',
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

// Latest full-booking matrix confirmations, through the shared production boundary.
const matrixConfirmations = {
  en: 'Yes, please complete the booking.', sv: 'Ja, slutför bokningen tack.',
  es: 'Sí, complete la reserva, por favor.', de: 'Ja, bitte schließen Sie die Buchung ab.',
  fa: 'بله، لطفاً رزرو را نهایی کنید.', ar: 'نعم، يرجى إتمام الحجز.',
};
for (const platformName of ['instagram', 'whatsapp', 'messenger', 'telegram']) {
  for (const [language, text] of Object.entries(matrixConfirmations)) {
    const counts = fixture();
    const sessionId = `matrix-confirm-${platformName}-${language}`;
    const pending = seedCanonicalAlternatives(sessionId);
    pending.platform = platformName;
    pending.language = language;
    pending.normalizedBookingRequest.language = language;
    pending.ownedOfferedSlots[0].platform = platformName;
    boundary.seedPending(sessionId, pending);
    const selection = await boundary.turn({ sessionId, platformName, recipientUserId: sessionId,
      text: '15:30 works for me. Please use that time.', businessConfig, now });
    assert.equal(selection.pending?.status, 'awaiting_confirmation');
    const result = await boundary.turn({ sessionId, platformName, recipientUserId: sessionId, text, businessConfig, now });
    assert.equal(result.pending?.status, 'awaiting_contact', `${platformName}/${language}: confirmation must advance`);
    assert.equal(result.pending?.dateTime, selectedStart);
    assert.equal(result.pending?.selectedSlotEnd, selectedEnd);
    assert.equal(counts.calendarCreate, 0, 'missing contact cannot create a booking');
    assert.equal(counts.databaseInsert, 0);
  }
}
console.log('24 channel/language confirmation regressions passed');
