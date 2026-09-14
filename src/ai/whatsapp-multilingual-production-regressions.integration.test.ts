import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-14T12:00:00+02:00');
const businessConfig = {
  id: 'whatsapp-multilingual-production-regressions',
  businessName: 'Matrix Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'matrix-calendar',
  defaultBookingService: 'Video Consultation',
  services: [{ id: 'video-consultation', name: 'Video Consultation', durationMinutes: 30 }],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((day) => [day, [{ start: '09:00', end: '18:00' }]]),
  ),
};

const calls = { availability: 0, calendarCreate: 0, databaseInsert: 0 };
const calendarEvents = new Map<string, any>();
let recordedService: string | null = null;

function configure() {
  boundary.reset();
  calls.availability = 0;
  calls.calendarCreate = 0;
  calls.databaseInsert = 0;
  calendarEvents.clear();
  recordedService = null;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'matrix-calendar',
      getEvents: async () => {
        calls.availability += 1;
        return [...calendarEvents.values()];
      },
      checkSlots: async () => ({ available_slots_string: '' }),
      insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 30, marker = '') => {
        calls.calendarCreate += 1;
        const event = {
          id: `event-${calls.calendarCreate}`,
          status: 'confirmed',
          summary: `${service}: ${name} - ${phone}`,
          description: `BusinessId: ${businessConfig.id}\nPlatform: whatsapp\nUserId: ${marker}`,
          start: { dateTime: new Date(dateTime).toISOString() },
          end: { dateTime: new Date(new Date(dateTime).getTime() + duration * 60_000).toISOString() },
          extendedProperties: {
            private: { businessId: businessConfig.id, platform: 'whatsapp', userId: marker },
          },
        };
        calendarEvents.set(event.id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => calendarEvents.get(id) || null,
      cancelAppointment: async (id: string) => {
        calendarEvents.delete(id);
        return { success: true };
      },
      verifyEventDeleted: async (id: string) => !calendarEvents.has(id),
    },
    recordAppointment: async (params: any) => {
      calls.databaseInsert += 1;
      recordedService = params.service;
      return {
        id: calls.databaseInsert,
        business_id: businessConfig.id,
        platform: params.platform,
        user_id: String(params.userId),
        service: params.service,
        start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + params.durationMinutes * 60_000).toISOString(),
        status: 'booked',
      };
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    claimOperation: async (params: any) => ({
      claimed: true,
      keyHash: params.exactId,
      storageId: params.exactId,
      storagePlatform: 'idempotency:whatsapp',
      state: { type: params.type, status: 'processing', attempts: 1, claimedAt: Date.now(), updatedAt: Date.now() },
    }),
    settleOperation: async () => true,
  });
}

function seedCompleted(sessionId: string, language: string) {
  boundary.seedRecentCompletedBooking(sessionId, language, {
    ok: true,
    bookingId: `old-${sessionId}`,
    businessId: businessConfig.id,
    serviceName: 'Video Consultation',
    startTime: '2026-09-15T14:00:00+02:00',
    customerName: 'Old Customer',
    customerPhone: '0700000000',
    sourceChannel: 'whatsapp',
  }, 30);
}

const turn = (sessionId: string, text: string, recipientUserId = sessionId) => boundary.turn({
  sessionId,
  platformName: 'whatsapp',
  recipientUserId,
  text,
  inputMode: 'text',
  businessConfig,
  now,
});

try {
  const freshBookingCases = [
    {
      language: 'de',
      text: 'Wir beginnen eine neue Buchung. Bitte weiterhin auf Deutsch. Ich möchte eine Video Consultation buchen. Zeigen Sie mir die nächsten verfügbaren Termine.',
      staleReply: /Buchung ist bestätigt|Unternehmensinformationen/u,
    },
    {
      language: 'ar',
      text: 'لنبدأ حجزًا جديدًا. يرجى الاستمرار باللغة العربية. أريد حجز Video Consultation. اعرض لي أقرب المواعيد المتاحة.',
      staleReply: /الحجز مؤكد/u,
    },
    {
      language: 'en',
      text: 'Let us start a new booking. I want to book Video Consultation. Show me the next available appointments.',
      staleReply: /booking is verified|booking is confirmed/u,
    },
  ] as const;

  for (const testCase of freshBookingCases) {
    configure();
    const sessionId = `fresh-after-completion-${testCase.language}`;
    seedCompleted(sessionId, testCase.language);
    assert.equal(boundary.isExplicitNewBookingPivot(testCase.text), true, testCase.language);
    assert.equal(
      boundary.recentCompletionClassification(sessionId, testCase.text, businessConfig, now)?.category,
      'new_booking',
      testCase.language,
    );

    const result = await turn(sessionId, testCase.text);
    assert.equal(result.handled, true, testCase.language);
    assert.equal(result.pending?.operation, 'new_booking', testCase.language);
    assert.equal(result.pending?.service, 'Video Consultation', testCase.language);
    assert.ok(calls.availability > 0, `${testCase.language}: availability must run`);
    assert.doesNotMatch(result.replies.join(' '), testCase.staleReply, testCase.language);
    assert.equal(boundary.recentCompletionClassification(sessionId, testCase.text, businessConfig, now), null);
  }

  configure();
  const arabicLiveSession = 'arabic-live-owned-slot-continuation';
  const arabicLiveBusinessConfig = {
    ...businessConfig,
    workingHours: Object.fromEntries(
      ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        .map((day) => [day, [{ start: '10:15', end: '11:15' }]]),
    ),
  };
  const arabicLiveNow = new Date('2026-09-14T10:00:00+02:00');
  const arabicLiveTurn = (text: string) => boundary.turn({
    sessionId: arabicLiveSession,
    platformName: 'whatsapp',
    recipientUserId: arabicLiveSession,
    text,
    inputMode: 'text',
    businessConfig: arabicLiveBusinessConfig,
    now: arabicLiveNow,
  });
  const arabicStart = await arabicLiveTurn(
    'لنبدأ حجزًا جديدًا. يرجى الاستمرار باللغة العربية. أريد حجز Video Consultation. اعرض لي أقرب المواعيد المتاحة.',
  );
  assert.equal(arabicStart.pending?.operation, 'new_booking');
  assert.equal(arabicStart.pending?.status, 'awaiting_time_selection');
  assert.match(arabicStart.replies.join(' '), /10:15.*10:30.*10:45/su);

  const arabicSelection = 'أريد موعد الساعة 10:15. كلمة "hej" كانت مجرد مثال؛ يرجى الاستمرار باللغة العربية.';
  assert.deepEqual(boundary.whatsappPreDispatchDecision(arabicLiveSession, arabicSelection), {
    intent: 'ambiguous',
    returnsAmbiguousClarification: false,
    dispatchesUnifiedBooking: true,
  });
  const arabicSelected = await arabicLiveTurn(arabicSelection);
  assert.equal(arabicSelected.pending?.operation, 'new_booking');
  assert.equal(arabicSelected.pending?.status, 'awaiting_confirmation');
  assert.match(arabicSelected.pending?.dateTime || '', /T10:15:00/);
  assert.equal(arabicSelected.pending?.language, 'ar');

  const arabicConfirmation = 'نعم، يرجى حجز هذا الموعد.';
  assert.equal(
    boundary.whatsappPreDispatchDecision(arabicLiveSession, arabicConfirmation).returnsAmbiguousClarification,
    false,
  );
  const arabicConfirmed = await arabicLiveTurn(arabicConfirmation);
  assert.equal(arabicConfirmed.pending?.operation, 'new_booking');
  assert.equal(arabicConfirmed.pending?.status, 'awaiting_contact');
  assert.match(arabicConfirmed.pending?.dateTime || '', /T10:15:00/);

  const arabicContact = 'اسمي Alex Testsson ورقم هاتفي المحمول هو 0701234567.';
  assert.equal(
    boundary.whatsappPreDispatchDecision(arabicLiveSession, arabicContact).returnsAmbiguousClarification,
    false,
  );
  const arabicCompleted = await arabicLiveTurn(arabicContact);
  assert.equal(arabicCompleted.pending, null);
  assert.equal(calls.calendarCreate, 1);
  assert.equal(calls.databaseInsert, 1);
  assert.equal(recordedService, 'Video Consultation');
  assert.match(arabicCompleted.replies.join(' '), /الخدمة:\s*Video Consultation/u);
  assert.match(arabicCompleted.replies.join(' '), /الاسم:\s*Alex Testsson/u);

  const persianContact = 'نام من Alex Testsson است و شماره موبایلم 0701234567 است.';
  const extracted = boundary.extractBookingContactParts(persianContact);
  assert.equal(extracted.combined?.name, 'Alex Testsson');
  assert.equal(extracted.nameOnly, 'Alex Testsson');
  assert.equal(extracted.combined?.phone, '0701234567');
  assert.notEqual(extracted.combined?.name, 'من');

  for (const language of ['en', 'sv', 'es', 'de', 'ar', 'fa']) {
    assert.match(
      boundary.formatBookingConfirmation(
        language,
        'Alex Testsson',
        'Video Consultation',
        '2026-09-15T14:00:00+02:00',
        '0701234567',
      ),
      /Video Consultation/u,
      `${language}: configured service identity is unchanged in the final card`,
    );
  }

  configure();
  const completionUser = '0701234567';
  const completionSession = `wa_${businessConfig.id}:${completionUser}`;
  const selectedStart = '2026-09-15T14:00:00+02:00';
  const selectedEnd = '2026-09-15T12:30:00.000Z';
  boundary.seedPending(completionSession, {
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessId: businessConfig.id,
    businessConfig,
    platform: 'whatsapp',
    userId: completionSession.replace(/\D/g, ''),
    sessionId: completionSession,
    operation: 'new_booking',
    status: 'awaiting_contact',
    expectedInput: 'contact',
    service: 'Video Consultation',
    serviceId: 'video-consultation',
    serviceResolution: 'authoritative',
    durationMinutes: 30,
    selectedDate: '2026-09-15',
    dateTime: selectedStart,
    selectedSlotEnd: selectedEnd,
    language: 'fa',
    offeredSlots: [`Tuesday at 14:00 (ISO: ${selectedStart})`],
    ownedOfferedSlots: [{
      start: selectedStart,
      end: selectedEnd,
      durationMinutes: 30,
      service: 'Video Consultation',
      businessId: businessConfig.id,
      platform: 'whatsapp',
      userId: completionUser,
      generatedAt: Date.now(),
      searchStartDate: '2026-09-15',
      searchEndDate: '2026-09-15',
    }],
  });
  boundary.seedFlowLanguage(completionSession, 'fa');

  const completed = await turn(completionSession, persianContact, completionUser);
  assert.equal(completed.pending, null);
  assert.equal(calls.calendarCreate, 1);
  assert.equal(calls.databaseInsert, 1);
  assert.equal(recordedService, 'Video Consultation');
  assert.match(completed.replies.join(' '), /خدمت:\s*Video Consultation/u);
  assert.match(completed.replies.join(' '), /نام:\s*Alex Testsson/u);
  assert.doesNotMatch(completed.replies.join(' '), /خدمت:\s*مشاوره/u);
} finally {
  boundary.reset();
}

console.log('WhatsApp multilingual production regressions passed');
