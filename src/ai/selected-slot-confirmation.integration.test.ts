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
  boundary.seedPending(sessionId, {
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
  });
}

const turn = (sessionId: string, text: string) => boundary.turn({
  sessionId,
  platformName: 'telegram',
  recipientUserId: sessionId,
  text,
  businessConfig,
  now,
});

const counters = fixture();
const authorizedSession = 'confirm-contact-same-turn';
seedCanonicalAlternatives(authorizedSession);
const selected = await turn(
  authorizedSession,
  "I see. Then I'll take the 15:30 slot on Friday the 21st for the Video Consultation.",
);
assert.equal(selected.pending?.status, 'awaiting_confirmation');
assert.match(selected.replies.join(' '), /Would you like me to book it/iu);
assert.equal(counters.calendarCreate, 0);

const confirmed = await turn(
  authorizedSession,
  'Yes, please book the Video Consultation for Friday the 21st at 15:30. My name is Alex Testsson and my phone number is 0701234567.',
);
assert.equal(counters.calendarCreate, 1);
assert.equal(counters.databaseInsert, 1);
assert.equal(counters.createdName, 'Alex Testsson');
assert.equal(counters.createdPhone, '0701234567');
assert.doesNotMatch(confirmed.replies.join(' '), /Would you like me to book it/iu);

// A: explicit confirmation and same-turn contact are consumed before deciding
// whether another confirmation/contact prompt is needed.
const sameTurnCounters = fixture();
const sameTurnSession = 'explicit-confirmation-same-turn-contact';
seedCanonicalAlternatives(sameTurnSession);
await turn(sameTurnSession, 'Friday the 21st at 15:30 for the Video Consultation.');
const sameTurn = await turn(
  sameTurnSession,
  'Yes, please book it for Alex Testsson with the phone number 0701234567.',
);
assert.equal(sameTurnCounters.calendarCreate, 1);
assert.equal(sameTurnCounters.databaseInsert, 1);
assert.equal(sameTurnCounters.createdName, 'Alex Testsson');
assert.equal(sameTurnCounters.createdPhone, '0701234567');
assert.doesNotMatch(sameTurn.replies.join(' '), /Would you like me to book it/iu);

// B: contact already owned by the pending booking survives the confirmation turn.
const storedContactCounters = fixture();
const storedContactSession = 'explicit-confirmation-stored-contact';
seedCanonicalAlternatives(storedContactSession);
const storedContactSelected = await turn(
  storedContactSession,
  'Friday the 21st at 15:30 for the Video Consultation.',
);
boundary.seedPending(storedContactSession, {
  ...storedContactSelected.pending,
  status: 'awaiting_contact',
  customerName: 'Alex Testsson',
  customerPhone: '0701234567',
  contactPhoneSource: 'explicit_customer_message',
});
const storedContactConfirmed = await turn(storedContactSession, 'Yes, please book it.');
assert.equal(storedContactCounters.calendarCreate, 1);
assert.equal(storedContactCounters.databaseInsert, 1);
assert.doesNotMatch(storedContactConfirmed.replies.join(' '), /Would you like me to book it/iu);

// C: confirmation with incomplete contact asks only for the missing field.
const missingContactCounters = fixture();
const missingContactSession = 'explicit-confirmation-missing-phone';
seedCanonicalAlternatives(missingContactSession);
const missingContactSelected = await turn(
  missingContactSession,
  'Friday the 21st at 15:30 for the Video Consultation.',
);
boundary.seedPending(missingContactSession, {
  ...missingContactSelected.pending,
  customerName: 'Alex Testsson',
});
const missingContactConfirmed = await turn(missingContactSession, 'Yes, please book it.');
assert.equal(missingContactCounters.calendarCreate, 0);
assert.equal(missingContactConfirmed.pending?.customerName, 'Alex Testsson');
assert.match(missingContactConfirmed.replies.join(' '), /mobile number/iu);
assert.doesNotMatch(missingContactConfirmed.replies.join(' '), /Would you like me to book it/iu);

// D: selecting a slot without explicit confirmation still requires confirmation.
const selectionOnlyCounters = fixture();
const selectionOnlySession = 'selection-without-authorization';
seedCanonicalAlternatives(selectionOnlySession);
const selectionOnly = await turn(
  selectionOnlySession,
  'Friday the 21st at 15:30 for the Video Consultation.',
);
assert.equal(selectionOnly.pending?.status, 'awaiting_confirmation');
assert.match(selectionOnly.replies.join(' '), /Would you like me to book it/iu);
assert.equal(selectionOnlyCounters.calendarCreate, 0);
assert.equal(selectionOnlyCounters.databaseInsert, 0);

const liveStart = '2026-08-24T10:15:00+02:00';
const liveEnd = '2026-08-24T08:45:00.000Z';
const liveNow = new Date('2026-08-21T12:00:00+02:00');

function seedLiveSlot(sessionId: string, contact: Record<string, any> = {}) {
  boundary.seedPending(sessionId, {
    businessId: '7', platform: 'telegram', userId: sessionId, businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', service: 'Video Consultation', status: 'awaiting_time_selection',
    selectedDate: '2026-08-24', durationMinutes: 30,
    normalizedBookingRequest: {
      intent: 'new_booking', language: 'en',
      service: { raw: 'Video Consultation', normalized: 'Konsultation', confidence: 'high' },
      date: { kind: 'explicit', value: '2026-08-24', confidence: 'high' },
      sourceMode: 'text', normalizedText: 'Monday 24 August', requiresClarification: false,
    },
    availabilityConstraint: { startDate: '2026-08-24', endDate: '2026-08-24', kind: 'whole_day', rejectedTimes: [] },
    offeredSlots: [`Monday at 10:15 (ISO: ${liveStart})`],
    ownedOfferedSlots: [{
      start: liveStart, end: liveEnd, durationMinutes: 30, service: 'Video Consultation',
      businessId: '7', platform: 'telegram', userId: sessionId, generatedAt: Date.now(),
      searchStartDate: '2026-08-24', searchEndDate: '2026-08-24',
    }],
    ...contact,
  });
}

const liveTurn = (sessionId: string, text: string) => boundary.turn({
  sessionId, platformName: 'telegram', recipientUserId: sessionId, text, businessConfig, now: liveNow,
});

// A: slot selection, authorization, name, and phone are merged in one turn.
const liveCounters = fixture();
const liveSession = 'live-slot-contact-all';
seedLiveSlot(liveSession);
const liveResult = await liveTurn(
  liveSession,
  '10:15 on Monday 24 August works for me. Can you book that one for Alex Testsson with the phone number 0701234567?',
);
assert.equal(liveCounters.calendarCreate, 1);
assert.equal(liveCounters.databaseInsert, 1);
assert.equal(liveCounters.createdName, 'Alex Testsson');
assert.equal(liveCounters.createdPhone, '0701234567');
assert.doesNotMatch(liveResult.replies.join(' '), /name|phone|mobile number/iu);

// B: name-only slot authorization preserves the name and asks only for phone.
fixture();
const nameOnlySession = 'live-slot-name-only';
seedLiveSlot(nameOnlySession);
const nameOnly = await liveTurn(
  nameOnlySession,
  '10:15 on Monday 24 August works for me. Can you book that one? My name is Alex Testsson.',
);
assert.equal(nameOnly.pending?.customerName, 'Alex Testsson');
assert.equal(nameOnly.pending?.customerPhone ?? null, null);
assert.match(nameOnly.replies.join(' '), /mobile number/iu);
assert.doesNotMatch(nameOnly.replies.join(' '), /your name and/iu);

// C: phone-only slot authorization preserves the phone and asks only for name.
fixture();
const phoneOnlySession = 'live-slot-phone-only';
seedLiveSlot(phoneOnlySession);
const phoneOnly = await liveTurn(
  phoneOnlySession,
  '10:15 on Monday 24 August works for me. Can you book that one with the phone number 0701234567?',
);
assert.equal(phoneOnly.pending?.customerName ?? null, null);
assert.equal(phoneOnly.pending?.customerPhone, '0701234567');
assert.match(phoneOnly.replies.join(' '), /only need your name/iu);

// D: selection without authorization/contact retains the confirmation requirement.
fixture();
const noContactSession = 'live-slot-no-contact';
seedLiveSlot(noContactSession);
const noContact = await liveTurn(noContactSession, '10:15 on Monday 24 August works for me.');
assert.equal(noContact.pending?.status, 'awaiting_confirmation');
assert.match(noContact.replies.join(' '), /Would you like me to book it/iu);

// E: earlier validated contact remains owned when the slot is selected later.
fixture();
const storedEarlierSession = 'live-slot-stored-contact';
seedLiveSlot(storedEarlierSession, {
  customerName: 'Alex Testsson', customerPhone: '0701234567', contactPhoneSource: 'explicit_customer_message',
});
const storedEarlier = await liveTurn(storedEarlierSession, '10:15 on Monday 24 August works for me.');
assert.equal(storedEarlier.pending?.customerName, 'Alex Testsson');
assert.equal(storedEarlier.pending?.customerPhone, '0701234567');

// F: current valid contact corrections win over older stored contact.
const correctionCounters = fixture();
const correctionSession = 'live-slot-contact-correction';
seedLiveSlot(correctionSession, {
  customerName: 'Old Name', customerPhone: '0700000000', contactPhoneSource: 'explicit_customer_message',
});
await liveTurn(
  correctionSession,
  '10:15 on Monday 24 August works for me. Can you book that one for Alex Testsson with the phone number 0701234567?',
);
assert.equal(correctionCounters.createdName, 'Alex Testsson');
assert.equal(correctionCounters.createdPhone, '0701234567');

// G: malformed contact never completes the contact requirement.
fixture();
const malformedSession = 'live-slot-malformed-contact';
seedLiveSlot(malformedSession);
const malformed = await liveTurn(
  malformedSession,
  '10:15 on Monday 24 August works for me. Can you book that one with the phone number 123?',
);
assert.equal(malformed.pending?.customerName ?? null, null);
assert.equal(malformed.pending?.customerPhone ?? null, null);
assert.match(malformed.replies.join(' '), /name and mobile number/iu);

const germanProviderUnderstanding = (text: string): any => {
  const includesConfirmation = /^Ja,/u.test(text);
  const includesContact = /Mein Name ist/u.test(text);
  const includesTime = /14(?::00)?\s*Uhr/u.test(text);
  return {
    schemaVersion: 1,
    language: { primary: { value: 'de', confidence: 0.97 }, codeSwitches: [] },
    intents: [{ value: 'new_booking', confidence: 0.97 }],
    acts: {
      bookingRequest: { value: true, confidence: 0.97 },
      ...(includesConfirmation ? { bookingConfirmation: { value: 'affirmed', confidence: 0.97 } } : {}),
    },
    entities: {
      ...(includesTime ? {
        time: { value: { kind: 'exact', start: '14:00' }, confidence: 0.97 },
        slotReference: { value: { kind: 'time', time: '14:00' }, confidence: 0.97 },
      } : {}),
      ...(includesContact ? {
        name: { value: 'Alex Testsson', confidence: 0.97 },
        phone: { value: '0701234567', confidence: 0.97 },
      } : {}),
    },
    ambiguities: [],
  };
};
const germanAdoptionRuntime = {
  async evaluate(input: any) { return germanProviderUnderstanding(input.message); },
  emitDecisions() {},
};
const germanStarts = [
  '2027-05-21T14:00:00+02:00',
  '2027-05-21T14:15:00+02:00',
  '2027-05-21T14:30:00+02:00',
];
function seedGermanSlots(
  sessionId: string,
  starts = germanStarts,
  selectedDate = '2027-05-21',
) {
  boundary.seedPending(sessionId, {
    businessId: '7', platform: 'telegram', userId: sessionId, businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking', service: 'Video Consultation', status: 'awaiting_time_selection',
    selectedDate, durationMinutes: 30,
    normalizedBookingRequest: {
      intent: 'new_booking', language: 'de', sourceMode: 'text', normalizedText: '',
      timeConstraint: { kind: 'none', confidence: 'high' }, requiresClarification: false,
    },
    availabilityConstraint: { startDate: selectedDate, endDate: selectedDate, kind: 'whole_day', rejectedTimes: [] },
    offeredSlots: starts.map((start) => `Slot at ${new Date(start).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' })} (ISO: ${start})`),
    ownedOfferedSlots: starts.map((start) => ({
      start,
      end: new Date(new Date(start).getTime() + 30 * 60_000).toISOString(),
      durationMinutes: 30, service: 'Video Consultation', businessId: '7',
      platform: 'telegram', userId: sessionId, generatedAt: Date.now(),
      searchStartDate: selectedDate, searchEndDate: selectedDate,
    })),
  });
}
const germanTurn = (sessionId: string, text: string) => boundary.turn({
  sessionId, platformName: 'telegram', recipientUserId: sessionId, text,
  businessConfig, now, shadowEligibleCustomerTurn: true,
});

fixture(germanAdoptionRuntime);
const germanSelectionSession = 'structured-german-selection';
seedGermanSlots(germanSelectionSession);
const germanSelectionResult = await germanTurn(
  germanSelectionSession,
  'Ich hätte gerne den Termin um 14 Uhr, falls das möglich ist.',
);
assert.equal(germanSelectionResult.pending?.status, 'awaiting_confirmation');
assert.equal(germanSelectionResult.pending?.dateTime, germanStarts[0]);

fixture(germanAdoptionRuntime);
const germanConfirmationSession = 'structured-german-confirmation';
seedGermanSlots(germanConfirmationSession);
const germanConfirmationResult = await germanTurn(
  germanConfirmationSession,
  'Ja, der Termin um 14 Uhr wäre perfekt für mich.',
);
assert.equal(germanConfirmationResult.pending?.status, 'awaiting_contact');
assert.match(germanConfirmationResult.replies.join(' '), /Namen.*Mobilnummer/iu);
assert.doesNotMatch(germanConfirmationResult.replies.join(' '), /choose one|select a slot/iu);

const germanCompleteCounters = fixture(germanAdoptionRuntime);
const germanCompleteSession = 'structured-german-complete';
seedGermanSlots(germanCompleteSession);
const germanCompleteResult = await germanTurn(
  germanCompleteSession,
  'Ja, der Termin um 14 Uhr ist für mich in Ordnung. Mein Name ist Alex Testsson und meine Telefonnummer ist 0701234567.',
);
assert.equal(germanCompleteCounters.calendarCreate, 1);
assert.equal(germanCompleteCounters.databaseInsert, 1);
assert.equal(germanCompleteCounters.createdName, 'Alex Testsson');
assert.equal(germanCompleteCounters.createdPhone, '0701234567');
assert.doesNotMatch(germanCompleteResult.replies.join(' '), /name|phone|mobile number|select a slot/iu);

// A controlled-adoption confirmation containing the ordinary booking verb is a
// continuation of the already-owned slot, not a request to replace the operation.
const germanLiveCounters = fixture(germanAdoptionRuntime);
const germanLiveSession = 'structured-german-live-sequence';
const germanLiveStarts = [
  '2026-08-25T14:00:00+02:00',
  '2026-08-25T14:15:00+02:00',
];
seedGermanSlots(germanLiveSession, germanLiveStarts, '2026-08-25');
const germanLiveTurn = (text: string) => boundary.turn({
  sessionId: germanLiveSession,
  platformName: 'telegram',
  recipientUserId: germanLiveSession,
  text,
  businessConfig,
  now: new Date('2026-08-24T12:00:00+02:00'),
  shadowEligibleCustomerTurn: true,
});
const germanLiveSelected = await germanLiveTurn('Ich hätte gerne den Termin um 14 Uhr.');
assert.equal(germanLiveSelected.pending?.status, 'awaiting_confirmation');
assert.equal(germanLiveSelected.pending?.dateTime, germanLiveStarts[0]);

const stalePendingEvents: unknown[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  if (args[0] === '[UnifiedBooking]' && (args[1] as any)?.event === 'stale_pending_cleared') {
    stalePendingEvents.push(args[1]);
  }
};
let germanLiveConfirmed;
try {
  germanLiveConfirmed = await germanLiveTurn(
    'Ja, bitte buchen Sie den Termin für Dienstag, den 25. August um 14:00 Uhr.',
  );
} finally {
  console.log = originalConsoleLog;
}
assert.equal(stalePendingEvents.length, 0);
assert.equal(germanLiveConfirmed.pending?.status, 'awaiting_contact');
assert.equal(germanLiveConfirmed.pending?.dateTime, germanLiveStarts[0]);
assert.equal(germanLiveConfirmed.pending?.service, 'Video Consultation');
assert.equal(germanLiveConfirmed.pending?.durationMinutes, 30);
assert.equal(germanLiveCounters.calendarCreate, 0);
assert.equal(germanLiveCounters.databaseInsert, 0);

const finalValidationEvents: Array<{ label: unknown; detail: any }> = [];
console.log = (...args: unknown[]) => {
  if (args[0] === '[OwnedOfferValidationTrace]' || args[0] === '[FinalBookingValidationResult]') {
    finalValidationEvents.push({ label: args[0], detail: args[1] });
  }
};
let germanLiveCompleted;
try {
  germanLiveCompleted = await germanLiveTurn(
    'Mein Name ist Alex Testsson und meine Handynummer ist 0701234567.',
  );
} finally {
  console.log = originalConsoleLog;
}
assert.equal(germanLiveCounters.calendarCreate, 1);
assert.equal(germanLiveCounters.databaseInsert, 1);
assert.equal(germanLiveCounters.createdName, 'Alex Testsson');
assert.equal(germanLiveCounters.createdPhone, '0701234567');
assert.doesNotMatch(germanLiveCompleted.replies.join(' '), /Namen|Mobilnummer/iu);
assert.equal(finalValidationEvents.some((entry) =>
  entry.label === '[OwnedOfferValidationTrace]' &&
  entry.detail?.ownerMatch === true &&
  entry.detail?.freshnessMatch === true
), true);
assert.equal(finalValidationEvents.some((entry) =>
  entry.label === '[FinalBookingValidationResult]' && entry.detail?.free === true
), true);

await germanLiveTurn(
  'Ja, bitte buchen Sie den Termin für Dienstag, den 25. August um 14:00 Uhr.',
);
assert.equal(germanLiveCounters.calendarCreate, 1);
assert.equal(germanLiveCounters.databaseInsert, 1);

// Existing stale-state safeguards remain fail closed.
const unavailableCounters = fixture(germanAdoptionRuntime);
const unavailableSession = 'structured-german-unavailable-after-selection';
seedGermanSlots(unavailableSession, germanLiveStarts, '2026-08-25');
const unavailableTurn = (text: string) => boundary.turn({
  sessionId: unavailableSession,
  platformName: 'telegram',
  recipientUserId: unavailableSession,
  text,
  businessConfig,
  now: new Date('2026-08-24T12:00:00+02:00'),
  shadowEligibleCustomerTurn: true,
});
await unavailableTurn('Ich hätte gerne den Termin um 14 Uhr.');
await unavailableTurn('Ja, bitte buchen Sie den Termin für Dienstag, den 25. August um 14:00 Uhr.');
unavailableCounters.blockSlot(germanLiveStarts[0]);
await unavailableTurn('Mein Name ist Alex Testsson und meine Handynummer ist 0701234567.');
assert.equal(unavailableCounters.calendarCreate, 0);
assert.equal(unavailableCounters.databaseInsert, 0);

fixture();
const expiredSession = 'expired-owned-pending-still-clears';
seedLiveSlot(expiredSession, {
  status: 'awaiting_contact',
  dateTime: liveStart,
  selectedSlotEnd: liveEnd,
  createdAt: Date.now() - 46 * 60_000,
});
const expiredResult = await liveTurn(
  expiredSession,
  'My name is Alex Testsson and my phone number is 0701234567.',
);
assert.equal(expiredResult.pending ?? null, null);

fixture();
const cancelledSession = 'explicit-cancellation-clears-owned-pending';
seedLiveSlot(cancelledSession, {
  status: 'awaiting_contact',
  dateTime: liveStart,
  selectedSlotEnd: liveEnd,
});
const cancelledResult = await liveTurn(cancelledSession, 'Cancel this booking request.');
assert.equal(cancelledResult.pending ?? null, null);

const hallucinatedAdoptionRuntime = {
  async evaluate() {
    const output = germanProviderUnderstanding(
      'Ja, der Termin um 14 Uhr. Mein Name ist Alex Testsson und meine Telefonnummer ist 0701234567.',
    );
    output.entities.time.value.start = '13:45';
    output.entities.slotReference.value.time = '13:45';
    return output;
  },
  emitDecisions() {},
};
const hallucinatedCounters = fixture(hallucinatedAdoptionRuntime);
const hallucinatedSession = 'structured-unowned-time';
seedGermanSlots(hallucinatedSession);
const hallucinatedResult = await germanTurn(
  hallucinatedSession,
  'Ja, dieser Termin wäre perfekt. Mein Name ist Alex Testsson und meine Telefonnummer ist 0701234567.',
);
assert.equal(hallucinatedCounters.calendarCreate, 0);
assert.equal(hallucinatedCounters.databaseInsert, 0);
assert.equal(hallucinatedResult.pending?.status, 'awaiting_time_selection');
assert.equal(hallucinatedResult.pending?.dateTime ?? null, null);

boundary.reset();
console.log('selected slot confirmation integration tests passed');
