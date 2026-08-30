import assert from 'node:assert/strict';
import { normalizeBookingRequest } from './booking-intelligence';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-30T10:00:00+02:00');
const selectedDate = '2026-08-31';

const businessConfig = {
  id: '3',
  businessRecordId: '3',
  businessName: 'admotion studio',
  language: 'es',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'cal-3',
  services: [
    { name: 'Video Consultation', duration: 60 },
    { name: 'Laser Treatment', duration: 60 },
  ],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((day) => [day, [{ start: '09:00', end: '17:00' }]]),
  ),
};

let calendarReads = 0;
let calendarWrites = 0;
let databaseWrites = 0;

function configure() {
  boundary.reset();
  calendarReads = 0;
  calendarWrites = 0;
  databaseWrites = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-3',
      getEvents: async () => {
        calendarReads += 1;
        return [];
      },
      checkSlots: async () => {
        throw new Error('legacy availability path must not run');
      },
      insertAppointment: async () => {
        calendarWrites += 1;
        throw new Error('confirmation without contact must not create an appointment');
      },
    },
    recordAppointment: async () => {
      databaseWrites += 1;
      throw new Error('confirmation without contact must not write an appointment row');
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
}

function selectedSlot(time = '09:00', generatedAt = Date.now(), userId = 'ig-user') {
  const start = `${selectedDate}T${time}:00+02:00`;
  const end = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
  return {
    start,
    end,
    durationMinutes: 60,
    service: 'Video Consultation',
    businessId: '3',
    platform: 'instagram',
    userId,
    generatedAt,
    searchStartDate: selectedDate,
    searchEndDate: selectedDate,
  };
}

function seedConfirmation(sessionId: string, options: {
  language?: string;
  time?: string;
  generatedAt?: number;
  ownedSlots?: any[];
  status?: string;
} = {}) {
  const language = options.language || 'es';
  const slot = selectedSlot(options.time || '09:00', options.generatedAt, sessionId);
  boundary.seedPending(sessionId, {
    businessId: '3',
    platform: 'instagram',
    userId: sessionId,
    businessConfig: { ...businessConfig, language },
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    operation: 'new_booking',
    service: 'Video Consultation',
    durationMinutes: 60,
    status: options.status || 'awaiting_confirmation',
    expectedInput: options.status === 'awaiting_time_selection' ? 'slot_selection' : 'confirmation',
    selectedDate,
    dateTime: options.status === 'awaiting_time_selection' ? null : slot.start,
    selectedSlotEnd: options.status === 'awaiting_time_selection' ? null : slot.end,
    language,
    normalizedBookingRequest: {
      intent: 'new_booking',
      language,
      service: { normalized: 'Konsultation', confidence: 'high' },
      date: {
        kind: 'relative_date', value: selectedDate, relative: 'tomorrow', confidence: 'high',
      },
      requiresClarification: false,
    },
    availabilityConstraint: {
      startDate: selectedDate,
      endDate: selectedDate,
      kind: 'exact_time',
      exactTime: options.time || '09:00',
      rejectedTimes: [],
      timezone: 'Europe/Stockholm',
    },
    offeredSlots: [],
    ownedOfferedSlots: options.ownedSlots || [slot],
  });
  return slot;
}

async function turn(sessionId: string, text: string, language = 'es') {
  return boundary.turn({
    sessionId,
    platformName: 'instagram',
    recipientUserId: sessionId,
    text,
    businessConfig: { ...businessConfig, language },
    now,
  });
}

try {
  const genericDateCases = [
    'Hola, quiero reservar una cita para mañana.',
    'Quiero reservar una cita el lunes.',
    'Quiero reservar una reserva para el 31 de agosto.',
  ];
  for (const text of genericDateCases) {
    assert.equal(boundary.extractConcreteRequestedService(text), null, text);
  }
  const normalizedTomorrow = normalizeBookingRequest({
    businessId: '3', channel: 'instagram', conversationKey: 'generic-date',
    inputMode: 'text', text: genericDateCases[0], activeLanguage: 'es',
    timezone: 'Europe/Stockholm', now,
  });
  assert.equal(normalizedTomorrow.date?.value, selectedDate);
  assert.equal(normalizedTomorrow.date?.relative, 'tomorrow');

  configure();
  const unsupportedText = 'Quiero reservar una manicura para mañana.';
  assert.equal(boundary.extractConcreteRequestedService(unsupportedText), 'manicura para mañana');
  const unsupported = await turn('unsupported-spanish-service', unsupportedText);
  assert.equal(unsupported.pending?.status, 'awaiting_service');
  assert.equal(unsupported.pending?.requestedService, 'manicura para mañana');
  assert.equal(calendarReads, 0);

  const confirmations = [
    'Sí, por favor, reserva la Video Consultation para las 09:00 del lunes 31 de agosto.',
    'Sí, por favor, confirma la reserva de la Video Consultation para las 9:00 del lunes 31 de agosto.',
    'Sí, resérvala.',
    'Sí, quiero reservarla.',
    'Confirma la reserva.',
    'Sí, confirma la reserva.',
    'Sí, por favor.',
    'Sí, reserva esa hora.',
  ];
  for (const [index, confirmation] of confirmations.entries()) {
    configure();
    const sessionId = `spanish-confirmation-${index}`;
    const slot = seedConfirmation(sessionId);
    const result = await turn(sessionId, confirmation);
    assert.equal(result.pending?.status, 'awaiting_contact', confirmation);
    assert.equal(result.pending?.dateTime, slot.start, confirmation);
    assert.equal(result.pending?.selectedSlotEnd, slot.end, confirmation);
    assert.equal(result.pending?.ownedOfferedSlots?.length, 1, confirmation);
    assert.match(result.replies.join(' '), /nombre.*m[oó]vil/iu, confirmation);
    assert.equal(calendarReads, 1, `${confirmation}: only canonical selected-slot validation reads the calendar`);
    assert.equal(calendarWrites, 0, confirmation);
    assert.equal(databaseWrites, 0, confirmation);
  }

  const negativeCases = [
    'Sí, reserva las 09:15.',
    'Sí, reserva la Video Consultation para las 09:00 del martes 1 de septiembre.',
    'Sí, reserva Laser Treatment para las 09:00.',
    'No.',
    'Quizás.',
    'Cancela la reserva.',
    'Quiero cambiar la reserva.',
  ];
  for (const [index, text] of negativeCases.entries()) {
    configure();
    const sessionId = `spanish-confirmation-negative-${index}`;
    seedConfirmation(sessionId);
    const result = await turn(sessionId, text);
    assert.notEqual(result.pending?.status, 'awaiting_contact', text);
    assert.equal(calendarWrites, 0, text);
    assert.equal(databaseWrites, 0, text);
  }

  configure();
  const expiredSession = 'spanish-expired-confirmation';
  seedConfirmation(expiredSession, { generatedAt: Date.now() - 46 * 60_000 });
  const expired = await turn(expiredSession, 'Sí, por favor.');
  assert.notEqual(expired.pending?.status, 'awaiting_contact');

  configure();
  const unownedSession = 'spanish-unowned-confirmation';
  seedConfirmation(unownedSession, { ownedSlots: [selectedSlot('09:15')] });
  const unowned = await turn(unownedSession, 'Sí, por favor.');
  assert.notEqual(unowned.pending?.status, 'awaiting_contact');

  configure();
  const multipleSession = 'spanish-multiple-offers';
  const first = selectedSlot('09:00', Date.now(), multipleSession);
  const second = selectedSlot('09:15', Date.now(), multipleSession);
  seedConfirmation(multipleSession, {
    status: 'awaiting_time_selection',
    ownedSlots: [first, second],
  });
  const multiple = await turn(multipleSession, 'Sí.');
  assert.notEqual(multiple.pending?.status, 'awaiting_contact');
  assert.equal(multiple.pending?.dateTime, null);

  const crossLanguageCases = [
    { language: 'sv', time: '13:30', text: 'Ja, boka den klockan 13:30 tack.' },
    { language: 'en', time: '09:00', text: 'Yes, please book it.' },
    { language: 'de', time: '09:00', text: 'Ja, bitte buchen Sie diese Zeit.' },
  ];
  for (const [index, testCase] of crossLanguageCases.entries()) {
    configure();
    const sessionId = `cross-language-confirmation-${index}`;
    const slot = seedConfirmation(sessionId, {
      language: testCase.language,
      time: testCase.time,
    });
    const result = await turn(sessionId, testCase.text, testCase.language);
    assert.equal(result.pending?.status, 'awaiting_contact', testCase.text);
    assert.equal(result.pending?.dateTime, slot.start, testCase.text);
  }

  originalLog('Spanish booking boundary regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
