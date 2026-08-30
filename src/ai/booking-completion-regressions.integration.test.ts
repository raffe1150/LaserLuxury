import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

type Channel = 'telegram' | 'instagram' | 'whatsapp' | 'messenger';

const businessConfig = {
  id: '7',
  businessName: 'Test Clinic',
  language: 'sv',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  googleCalendarId: 'cal-7',
  defaultBookingService: 'Konsultation',
  services: [{ name: 'Konsultation', duration: 30 }],
};

const videoConsultationBusinessConfig = {
  ...businessConfig,
  defaultBookingService: 'Video Consultation',
  services: [{ name: 'Video Consultation', duration: 30 }],
};

const selectedStart = '2030-09-04T16:30:00+02:00';
const selectedEnd = '2030-09-04T15:00:00.000Z';
const turnNow = new Date('2030-09-01T12:00:00+02:00');

function productionCalendarOwner(marker: string): { platform: Channel; userId: string } {
  const platform = marker.startsWith('wa_')
    ? 'whatsapp'
    : marker.startsWith('ig_')
      ? 'instagram'
      : marker.startsWith('ms_')
        ? 'messenger'
        : 'telegram';
  const unprefixed = marker.replace(/^(?:wa_|ig_|ms_|tg_)/, '');
  return {
    platform,
    userId: platform === 'whatsapp' ? unprefixed.replace(/\D/g, '') : unprefixed,
  };
}

function fixture() {
  boundary.reset();
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const counters = {
    calendarCreate: 0,
    databaseInsert: 0,
    createdName: '',
    createdPhone: '',
    createdOwner: null as { platform: Channel; userId: string } | null,
  };

  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      getEvents: async () => [...events.values()],
      checkSlots: async () => ({ available_slots_string: '' }),
      insertAppointment: async (
        name: string,
        phone: string,
        _service: string,
        dateTime: string,
        durationMinutes = 30,
        marker = '',
      ) => {
        counters.calendarCreate += 1;
        counters.createdName = name;
        counters.createdPhone = phone;
        counters.createdOwner = productionCalendarOwner(marker);
        const id = `created-${counters.calendarCreate}`;
        const start = new Date(dateTime).toISOString();
        const event = {
          id,
          status: 'confirmed',
          summary: `Bokad: ${name} - ${phone}`,
          start: { dateTime: start },
          end: {
            dateTime: new Date(
              new Date(start).getTime() + durationMinutes * 60_000,
            ).toISOString(),
          },
          extendedProperties: { private: counters.createdOwner },
        };
        events.set(id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => {
        events.delete(id);
        return { success: true };
      },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    postProcess: async () => undefined,
    notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    recordAppointment: async (params: any) => {
      counters.databaseInsert += 1;
      return {
        id: counters.databaseInsert,
        business_id: '7',
        platform: params.platform,
        user_id: String(params.userId),
        service: params.service,
        start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(
          new Date(params.dateTime).getTime() +
            Number(params.durationMinutes) * 60_000,
        ).toISOString(),
        status: 'booked',
        created_at: new Date().toISOString(),
      };
    },
    claimOperation: async (params: any) => {
      const key = `${params.type}|${params.tenantScope}|${params.platform}|${params.exactId}`;
      const existing = claims.get(key);
      if (existing) {
        return { ...existing, claimed: false, duplicateStatus: existing.state.status };
      }
      const handle = {
        claimed: true,
        keyHash: key,
        storageId: key,
        state: {
          type: params.type,
          status: 'processing',
          attempts: 1,
          claimedAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
      claims.set(key, handle);
      return handle;
    },
    settleOperation: async (handle: any, status: 'completed' | 'failed') => {
      handle.state.status = status;
      return true;
    },
  } as any);

  return counters;
}

function seedSelectedSlot(
  sessionId: string,
  platform: Channel,
  userId: string,
  status: 'awaiting_confirmation' | 'awaiting_contact' = 'awaiting_contact',
) {
  const persistedUserId = platform === 'telegram'
    ? userId
    : platform === 'whatsapp'
      ? sessionId.replace(/\D/g, '')
      : sessionId.replace(/^(?:ig_|ms_)/, '');
  boundary.seedPending(sessionId, {
    businessConfig,
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessId: '7',
    platform,
    userId: persistedUserId,
    sessionId,
    operation: 'new_booking',
    status,
    expectedInput: status === 'awaiting_confirmation' ? 'confirmation' : 'contact',
    service: 'Konsultation',
    durationMinutes: 30,
    selectedDate: '2030-09-04',
    dateTime: selectedStart,
    selectedSlotEnd: selectedEnd,
    language: 'sv',
    availabilityConstraint: {
      startDate: '2030-09-04',
      endDate: '2030-09-04',
      kind: 'exact_time',
      exactTime: '16:30',
      rejectedTimes: [],
    },
    offeredSlots: [],
    ownedOfferedSlots: [{
      start: selectedStart,
      end: selectedEnd,
      durationMinutes: 30,
      service: 'Konsultation',
      businessId: '7',
      platform,
      userId,
      generatedAt: Date.now(),
      searchStartDate: '2030-09-04',
      searchEndDate: '2030-09-04',
    }],
  });
  boundary.seedFlowLanguage(sessionId, 'sv');
}

try {
  for (const text of [
    'Alex Testsson.',
    'Alex Testsson',
    'Alex Testsson!',
    'Alex Testsson?',
    'Alex Testsson:',
  ]) {
    const parts = boundary.extractBookingContactParts(text);
    assert.equal(parts.nameOnly, 'Alex Testsson', text);
  }

  const bareNameWithPeriod = boundary.extractBookingContactParts('Alex Testsson.');
  assert.equal(bareNameWithPeriod.combined, null);
  assert.equal(bareNameWithPeriod.phoneOnly, null);

  for (const text of [
    'Alex Testsson Extra.',
    'Jag vill boka.',
    'Ja.',
    'Bokning.',
    'Det här är vanlig konversation.',
  ]) {
    const parts = boundary.extractBookingContactParts(text);
    assert.equal(parts.nameOnly, null, text);
  }

  for (const text of [
    'Alex Testsson och 0701234567',
    'Alex Testsson, och mitt nummer är 0701234567.',
    'Alex Testsson, och mitt mobilnummer är 0701234567.',
    'Alex Testsson, och mitt telefonnummer är 0701234567.',
    'Alex Testsson, och telefonnumret är 0701234567.',
    'Ja, tack. Alex Testsson, 0701234567.',
    'Ja, tack. Kan du boka den på mitt namn och nummer? Alex Testsson, 0701234567.',
    'Ja, tack. Bokningen är klar på mitt namn och nummer: Alex Testsson, 0701234567.',
    'Alex Testsson, 0701234567.',
  ]) {
    const parsed = boundary.resolveBookingContactPhrase({ text });
    assert.equal(parsed.name, 'Alex Testsson', text);
    assert.equal(parsed.phone, '0701234567', text);
  }

  for (const invalid of [
    'Alex Testsson Extra och 0701234567',
    'Jag vill boka konsultation och 0701234567',
    'Boka en tid imorgon och 0701234567',
    'Alex Testsson Extra, och mitt nummer är 0701234567.',
    'Jag vill boka, och mitt nummer är 0701234567.',
    'Boka en tid imorgon, och mitt telefonnummer är 0701234567.',
    'Alex Testsson Extra, och telefonnumret är 0701234567.',
    'Jag vill boka, och telefonnumret är 0701234567.',
    'Ja, tack. Alex Testsson Extra, 0701234567.',
    'Ja, tack. Jag vill boka, 0701234567.',
  ]) {
    const contact = boundary.resolveBookingContactPhrase({ text: invalid });
    assert.equal(contact.name, null, invalid);
  }

  fixture();
  const freshWhatsApp = await boundary.turn({
    sessionId: 'wa_7:46700000099',
    platformName: 'whatsapp',
    recipientUserId: '46700000099',
    text: 'Hej, jag vill boka en tid till i morgon.',
    businessConfig,
    now: turnNow,
  });
  assert.ok(
    ['awaiting_service', 'awaiting_time_selection'].includes(String(freshWhatsApp.pending?.status || '')),
    `fresh WhatsApp booking remains in the booking/time flow: ${freshWhatsApp.pending?.status}`,
  );
  assert.notEqual(freshWhatsApp.pending?.status, 'awaiting_contact');
  assert.doesNotMatch(freshWhatsApp.replies.join(' '), /behöver.*namn|skicka.*namn/iu);

  const cases: Array<{
    channel: Channel;
    sessionId: string;
    userId: string;
    expectedPhone: string;
  }> = [
    { channel: 'telegram', sessionId: 'tg:7:token:1001', userId: '1001', expectedPhone: '0701234567' },
    { channel: 'instagram', sessionId: 'ig_7:2001', userId: '2001', expectedPhone: '0701234567' },
    { channel: 'messenger', sessionId: 'ms_7:3001', userId: '3001', expectedPhone: '0701234567' },
    { channel: 'whatsapp', sessionId: 'wa_7:46700000000', userId: '46700000000', expectedPhone: '+46700000000' },
  ];

  for (const testCase of cases) {
    const counters = fixture();
    seedSelectedSlot(testCase.sessionId, testCase.channel, testCase.userId);
    const contactText = testCase.channel === 'whatsapp'
      ? 'Alex Testsson, och telefonnumret är 0701234567.'
      : 'Alex Testsson och 0701234567';
    const result = await boundary.turn({
      sessionId: testCase.sessionId,
      platformName: testCase.channel,
      recipientUserId: testCase.userId,
      text: contactText,
      businessConfig,
      now: turnNow,
    });

    assert.equal(counters.createdName, 'Alex Testsson', testCase.channel);
    assert.equal(counters.createdPhone, testCase.expectedPhone, testCase.channel);
    assert.equal(counters.calendarCreate, 1, testCase.channel);
    assert.equal(counters.databaseInsert, 1, testCase.channel);
    assert.equal(result.pending, null, testCase.channel);
    assert.equal(counters.createdOwner?.platform, testCase.channel, testCase.channel);
    assert.equal(counters.createdOwner?.userId, testCase.userId, testCase.channel);
    assert.match(result.replies.join(' '), /bok|bekräft/iu, testCase.channel);
    assert.doesNotMatch(result.replies.join(' '), /behöver.*namn|skicka.*namn/iu, testCase.channel);
  }

  const liveWhatsAppCases = [
    {
      label: 'awaiting_confirmation live turn 3',
      status: 'awaiting_confirmation' as const,
      text: 'Ja, tack. Kan du boka den på mitt namn och nummer? Alex Testsson, 0701234567.',
    },
    {
      label: 'awaiting_contact live turn 4',
      status: 'awaiting_contact' as const,
      text: 'Ja, tack. Alex Testsson, 0701234567.',
    },
    {
      label: 'awaiting_contact live turn 5',
      status: 'awaiting_contact' as const,
      text: 'Ja, tack. Bokningen är klar på mitt namn och nummer: Alex Testsson, 0701234567.',
    },
  ];

  for (const liveCase of liveWhatsAppCases) {
    const counters = fixture();
    seedSelectedSlot('wa_7:46700000000', 'whatsapp', '46700000000', liveCase.status);
    const result = await boundary.turn({
      sessionId: 'wa_7:46700000000',
      platformName: 'whatsapp',
      recipientUserId: '46700000000',
      text: liveCase.text,
      businessConfig,
      now: turnNow,
    });

    assert.equal(counters.createdName, 'Alex Testsson', liveCase.label);
    assert.equal(counters.createdPhone, '+46700000000', liveCase.label);
    assert.equal(counters.calendarCreate, 1, liveCase.label);
    assert.equal(counters.databaseInsert, 1, liveCase.label);
    assert.equal(result.pending, null, liveCase.label);
    assert.match(result.replies.join(' '), /bok|bekräft/iu, liveCase.label);
    assert.doesNotMatch(result.replies.join(' '), /behöver.*namn|skicka.*namn/iu, liveCase.label);
  }

  {
    const counters = fixture();
    const sessionId = 'wa_7:46700000000';
    const userId = '46700000000';
    boundary.seedPending(sessionId, {
      businessConfig: videoConsultationBusinessConfig,
      bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
      businessId: '7',
      platform: 'whatsapp',
      userId: sessionId.replace(/\D/g, ''),
      sessionId,
      operation: 'new_booking',
      status: 'awaiting_contact',
      expectedInput: 'contact',
      service: 'Video Consultation',
      durationMinutes: 30,
      selectedDate: '2030-09-04',
      dateTime: selectedStart,
      selectedSlotEnd: selectedEnd,
      language: 'sv',
      customerName: null,
      customerPhone: '+46700000000',
      contactPhoneSource: 'verified_sender_metadata',
      offeredSlots: [],
      ownedOfferedSlots: [{
        start: selectedStart,
        end: selectedEnd,
        durationMinutes: 30,
        service: 'Video Consultation',
        businessId: '7',
        platform: 'whatsapp',
        userId,
        generatedAt: Date.now(),
        searchStartDate: '2030-09-04',
        searchEndDate: '2030-09-04',
      }],
    });
    boundary.seedFlowLanguage(sessionId, 'sv');

    const result = await boundary.turn({
      sessionId,
      platformName: 'whatsapp',
      recipientUserId: userId,
      text: 'Alex Testsson.',
      businessConfig: videoConsultationBusinessConfig,
      now: turnNow,
    });

    assert.equal(counters.createdName, 'Alex Testsson');
    assert.equal(counters.createdPhone, '+46700000000');
    assert.equal(counters.calendarCreate, 1);
    assert.equal(counters.databaseInsert, 1);
    assert.equal(result.pending, null);
    assert.match(result.replies.join(' '), /bok|bekräft/iu);
    assert.doesNotMatch(result.replies.join(' '), /behöver.*namn|skicka.*namn/iu);
  }

  originalLog('booking completion regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
