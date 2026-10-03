import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookingContactChannel } from './channel-contact';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const now = new Date('2026-09-30T12:00:00+02:00');
const selectedStart = '2026-10-01T14:15:00+02:00';
const businessConfig = {
  id: '7', businessName: 'Contact Continuation Clinic', language: 'en',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-7',
  defaultBookingService: 'Video Consultation',
  // A contact surname can legitimately match a configured service word.
  services: ['Video Consultation', 'test'].map(name => ({ name, duration: 30 })),
  workingHours: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .map(day => [day, [{ start: '14:00', end: '17:00' }]])),
};

function fixture(
  t: any,
  platformName: BookingContactChannel = 'whatsapp',
  withPhone = true,
  inferredPhone?: string,
  inferredPhoneEvidence?: Array<{ start: number; end: number; explicit: boolean }>,
) {
  boundary.reset();
  t.after(() => boundary.reset());
  const traces: Array<{ label: unknown; detail: any }> = [];
  t.mock.method(console, 'log', (label: unknown, detail: any) => { traces.push({ label, detail }); });
  const events = new Map<string, any>();
  const claims = new Map<string, any>();
  const created: any[] = [];
  const recorded: any[] = [];
  const notifications: any[] = [];
  const adoptionDecisions: any[] = [];
  boundary.configure({
    semanticLanguageResolver: async () => null,
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      getEvents: async () => [...events.values()],
      checkSlots: async () => { throw new Error('Legacy availability must not run'); },
      insertAppointment: async (name: string, phone: string, service: string, dateTime: string, duration = 30, marker = '') => {
        created.push({ name, phone, service, dateTime, duration });
        const id = `created-${created.length}`;
        const start = new Date(dateTime).toISOString();
        const event = {
          id, status: 'confirmed', summary: `${name} - ${phone}`,
          description: `BusinessId: 7\nPlatform: ${platformName}\nUserId: ${marker}`,
          start: { dateTime: start }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { businessId: '7', platform: platformName, userId: marker } },
        };
        events.set(id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    postProcess: async () => undefined,
    notifyBooking: async (params: any) => { notifications.push(params); return true; },
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    validateAppointment: async (appointment: any) => appointment,
    recordAppointment: async (params: any) => {
      recorded.push(params);
      return {
        id: recorded.length, business_id: '7', platform: params.platform, user_id: String(params.userId),
        service: params.service, start_time: new Date(params.dateTime).toISOString(),
        end_time: new Date(new Date(params.dateTime).getTime() + Number(params.durationMinutes) * 60_000).toISOString(), status: 'booked',
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
    settleOperation: async (handle: any, status: string) => { handle.state.status = status; return true; },
    ...(inferredPhone ? { structuredUnderstandingAdoptionRuntime: {
      evaluate: async () => ({ schemaVersion: 1,
        language: { primary: { value: 'en', confidence: 1 }, codeSwitches: [] },
        intents: [], acts: {}, entities: {
          phone: {
            value: inferredPhone,
            confidence: 1,
            ...(inferredPhoneEvidence ? { evidence: inferredPhoneEvidence } : {}),
          },
        }, ambiguities: [],
      }),
      emitDecisions: (_correlationId: string, decisions: readonly any[]) => { adoptionDecisions.push(...decisions); },
    } } : {}),
  });
  const recipientUserId = platformName === 'whatsapp' && withPhone ? '46700000001' : `contact-${platformName}`;
  const sessionId = platformName === 'telegram'
    ? recipientUserId
    : boundary.channelSessionId(platformName, recipientUserId, businessConfig, 'contact-phone-id');
  const turn = (text: string) => boundary.turn({ sessionId, recipientUserId, platformName, text, businessConfig, now,
    shadowEligibleCustomerTurn: Boolean(inferredPhone) });
  return { traces, created, recorded, notifications, adoptionDecisions, turn, events, platformName, withPhone, sessionId };
}

async function select(f: ReturnType<typeof fixture>) {
  const explicitPhone = f.platformName !== 'whatsapp' && f.withPhone ? ' My phone number is 0701234567.' : '';
  const availability = await f.turn(`I'd like to book a Video Consultation. What times are available tomorrow?${explicitPhone}`);
  assert.equal(availability.pending?.status, 'awaiting_time_selection');
  assert.equal(availability.pending?.service, 'Video Consultation');
  assert.equal(availability.pending?.selectedDate, '2026-10-01');
  assert.deepEqual(availability.pending?.ownedOfferedSlots.map((slot: any) => new Date(slot.start).toISOString()), [
    '2026-10-01T12:00:00.000Z', '2026-10-01T12:15:00.000Z', '2026-10-01T12:30:00.000Z',
  ]);
  const selected = await f.turn('14:15 works for me.');
  assert.equal(selected.pending?.status, 'awaiting_confirmation');
  assert.equal(new Date(selected.pending?.dateTime).getTime(), new Date(selectedStart).getTime());
  assert.match(selected.replies.join(' '), /Would you like me to book it/iu);
  assert.equal(f.created.length, 0);
  return selected;
}

async function confirm(f: ReturnType<typeof fixture>) {
  const confirmed = await f.turn('Yes, please book it.');
  assert.equal(confirmed.pending?.status, 'awaiting_contact');
  assert.equal(confirmed.operation.phase, 'awaiting_contact');
  assert.match(confirmed.replies.join(' '), /name/iu);
  if (f.withPhone) {
    assert.ok(confirmed.pending?.customerPhone);
    assert.doesNotMatch(confirmed.replies.join(' '), /mobile number/iu);
    if (f.platformName === 'whatsapp') assert.equal(confirmed.pending?.contactPhoneSource, 'verified_sender_metadata');
  }
  assert.equal(f.created.length, 0);
  return confirmed;
}

for (const platformName of ['whatsapp', 'telegram', 'messenger', 'instagram'] as const) {
  test(`${platformName}: confirmed contact submission preserves 14:15 and proceeds to verified booking`, async (t) => {
    const f = fixture(t, platformName);
    await select(f);
    const confirmed = await confirm(f);
    const selectedOwnedSlot = confirmed.pending.ownedOfferedSlots[0];
    const contactTraceStart = f.traces.length;
    const completed = await f.turn('Raffe Test');
    const contactTraces = f.traces.slice(contactTraceStart);
    const entryContact = contactTraces.find(event => event.label === '[BookingContactPolicy]')?.detail;
    assert.equal(entryContact.contactRequirement, 'complete');
    const transition = contactTraces.find(event => event.label === '[BookingStateTransition]')?.detail;
    assert.equal(transition.eventType, 'contact_submission_to_verified_engine');
    assert.equal(transition.selectedSlotPresent, true);
    assert.equal(transition.previousPhase, 'awaiting_contact');
    assert.equal(transition.nextPhase, 'awaiting_contact', 'contact delegates to guarded finalization instead of mutating early');
    assert.equal(f.created.length, 1, JSON.stringify({
      message: 'completed contact must reach the verified engine instead of rescanning',
      routerPhase: contactTraces.find(event => event.label === '[BookingOperationRouter]')?.detail?.phase,
      finalPendingStatus: completed.pending?.status,
      finalPendingService: completed.pending?.service,
      refinement: contactTraces.filter(event => event.label === '[BookingRefinement]').map(event => ({
        pendingStatusBefore: event.detail?.pendingStatusBefore, cachedOfferCountBefore: event.detail?.cachedOfferCountBefore,
        refinementDetected: event.detail?.refinementDetected, freshScanStarted: event.detail?.freshScanStarted,
      })),
    }));
    assert.equal(f.recorded.length, 1);
    assert.equal(f.created[0].name, 'Raffe Test');
    assert.equal(f.created[0].phone, confirmed.pending.customerPhone);
    assert.equal(f.created[0].service, 'Video Consultation');
    assert.equal(new Date(f.created[0].dateTime).getTime(), new Date(selectedOwnedSlot.start).getTime());
    assert.equal(completed.pending, null);
    assert.equal(contactTraces.some(event => event.label === '[BookingRefinement]' && event.detail?.freshScanStarted), false);
    assert.equal(contactTraces.some(event => event.detail?.nextStateType === 'awaiting_time_selection'), false);
    assert.equal(contactTraces.some(event => event.label === '[FinalBookingValidationTrace]' &&
      event.detail?.ownedSlotFound === true && new Date(event.detail.lockedIso).getTime() === new Date(selectedStart).getTime()), true);
    await f.turn('Raffe Test');
    assert.equal(f.created.length, 1, 'replayed contact must not duplicate the booking');
    assert.equal(f.recorded.length, 1);
  });
}

test('incomplete contact remains awaiting_contact with the same owned selected slot', async (t) => {
  const f = fixture(t, 'telegram', false);
  await select(f);
  const confirmed = await confirm(f);
  const start = f.traces.length;
  const incomplete = await f.turn('Raffe Test');
  assert.equal(incomplete.pending?.status, 'awaiting_contact');
  assert.equal(incomplete.pending?.customerName, 'Raffe Test');
  assert.equal(incomplete.pending?.customerPhone ?? null, null);
  assert.equal(incomplete.pending?.service, 'Video Consultation');
  assert.equal(incomplete.pending?.dateTime, confirmed.pending.dateTime);
  assert.equal(incomplete.pending?.selectedSlotEnd, confirmed.pending.selectedSlotEnd);
  assert.deepEqual(incomplete.pending?.ownedOfferedSlots, confirmed.pending.ownedOfferedSlots);
  assert.match(incomplete.replies.join(' '), /mobile number/iu);
  assert.equal(f.created.length, 0);
  assert.equal(f.traces.slice(start).some(event => event.label === '[BookingRefinement]' && event.detail?.freshScanStarted), false);
});



for (const platformName of ['whatsapp', 'telegram', 'messenger', 'instagram'] as BookingContactChannel[]) {
  test(`${platformName}: fresh booking after business-information guidance does not inherit previous booking contact`, async (t) => {
    const f = fixture(t, platformName, false);

    await select(f);
    await confirm(f);

    const named = await f.turn('Old Customer');
    assert.equal(named.pending?.status, 'awaiting_contact');
    assert.equal(named.pending?.customerName, 'Old Customer');

    boundary.seedPending(f.sessionId, {
      ...named.pending,
      customerPhone: '0709999999',
      contactPhoneSource: 'explicit_customer_input',
    });

    const guidance = await f.turn(
      'نمی‌دانم کدام خدمت برای من مناسب است. پیش از پیشنهاد یک خدمت چه اطلاعاتی نیاز دارید؟',
    );

    assert.equal(guidance.pending?.operation, 'new_booking');
    assert.equal(guidance.pending?.customerName, 'Old Customer');
    assert.equal(guidance.pending?.customerPhone, '0709999999');

    const next = await f.turn(
      'سلام، می‌خواهم برای چهارشنبه ۷ اکتبر ۲۰۲۶ وقت رزرو کنم.',
    );

    assert.equal(next.pending?.operation, 'new_booking');
    assert.equal(
      next.pending?.customerName ?? null,
      null,
      'fresh booking must not inherit the previous booking customer name',
    );
    assert.equal(
      next.pending?.customerPhone ?? null,
      null,
      'fresh booking must not inherit the previous booking customer phone',
    );
    assert.notEqual(
      next.pending?.contactPhoneSource,
      'explicit_customer_input',
      'fresh booking must not inherit the previous booking phone source',
    );
  });
}

test('instagram: explicit new booking does not inherit stale customer name from previous pending booking', async (t) => {
  const f = fixture(t, 'instagram', false);

  await select(f);
  await confirm(f);

  const named = await f.turn('Old Customer');
  assert.equal(named.pending?.status, 'awaiting_contact');
  assert.equal(named.pending?.customerName, 'Old Customer');
  assert.equal(named.pending?.customerPhone ?? null, null);

  const next = await f.turn(
    'سلام، می‌خواهم برای چهارشنبه ۷ اکتبر ۲۰۲۶ وقت رزرو کنم.',
  );

  assert.equal(next.pending?.operation, 'new_booking');
  assert.equal(
    next.pending?.customerName ?? null,
    null,
    'a new booking must not inherit the previous pending customer name',
  );
});

test('instagram: explicit new booking does not inherit stale customer phone from previous pending booking', async (t) => {
  const f = fixture(t, 'instagram', false);

  await select(f);
  const confirmed = await confirm(f);

  boundary.seedPending(f.sessionId, {
    ...confirmed.pending,
    customerName: null,
    customerPhone: '0709999999',
    contactPhoneSource: 'explicit_customer_input',
  });

  const next = await f.turn(
    'سلام، می‌خواهم برای چهارشنبه ۷ اکتبر ۲۰۲۶ وقت رزرو کنم.',
  );

  assert.equal(next.pending?.operation, 'new_booking');
  assert.equal(
    next.pending?.customerPhone ?? null,
    null,
    'a new booking must not inherit the previous pending customer phone',
  );
  assert.notEqual(
    next.pending?.contactPhoneSource,
    'explicit_customer_input',
    'the previous booking phone source must not leak into the new booking',
  );
});

test('name submission with a verified sender phone cannot create a booking without prior confirmation', async (t) => {
  const f = fixture(t);
  await select(f);
  await f.turn('Raffe Test');
  assert.equal(f.created.length, 0);
  assert.equal(f.recorded.length, 0);
});

test('an actual catalog service selection is still honored while contact is incomplete', async (t) => {
  const f = fixture(t);
  await select(f);
  await confirm(f);
  const changed = await f.turn('test');
  assert.equal(changed.pending?.service, 'test');
  assert.equal(changed.pending?.status, 'awaiting_time_selection');
  assert.equal(changed.pending?.dateTime ?? null, null);
  assert.equal(f.created.length, 0);
  assert.equal(f.recorded.length, 0);
});

test('completed contact still fails final validation when the selected slot becomes occupied', async (t) => {
  const f = fixture(t);
  await select(f);
  await confirm(f);
  const start = new Date(selectedStart).toISOString();
  f.events.set('occupied', { id: 'occupied', status: 'confirmed', start: { dateTime: start },
    end: { dateTime: new Date(new Date(start).getTime() + 30 * 60_000).toISOString() } });
  await f.turn('Raffe Test');
  assert.equal(f.created.length, 0);
  assert.equal(f.recorded.length, 0);
  assert.equal(f.traces.some(event => event.label === '[FinalBookingValidationResult]' && event.detail?.free === false), true);
});

const numericNameCases = [
  ['de', 'Mein Name ist Mira Testmann 93414557.', 'Mira Testmann'],
  ['de', 'Mein Name ist Mira Testmann AIBB 93414557 whatsapp-de. Übrigens hat heute jemand "hej" zu mir gesagt.', 'Mira Testmann'],
  ['en', 'My name is Mira Testmann AIBB 93414557 whatsapp-en.', 'Mira Testmann'],
  ['sv', 'Jag heter Mira Testmann AIBB 93414557 whatsapp-sv.', 'Mira Testmann'],
  ['es', 'Me llamo Mira Testmann AIBB 93414557 whatsapp-es.', 'Mira Testmann'],
  ['ar', 'لينا اختبار', 'لينا اختبار'],
  ['ar', 'لينا اختبار AIBB d8f3c129', 'لينا اختبار'],
  ['ar', 'اسمي لينا اختبار', 'لينا اختبار'],
  ['ar', 'اسمي سلمى منصور AIBB cafeaffe channel-test. هذا نص إضافي.', 'سلمى منصور'],
  ['ar', 'اسمي سلمى منصور AIBB ab3e71cf', 'سلمى منصور'],
  ['ar', 'اسمي لينا اختبار AIBB 7a928ba6', 'لينا اختبار'],
  ['ar', 'اسمي لينا اختبار AIBB 7a928ba6 whatsapp-ar', 'لينا اختبار'],
  ['ar', 'اسمي لينا اختبار AIBB 7a928ba6 whatsapp-ar. وبالمناسبة، كان اليوم جميلًا.', 'لينا اختبار'],
  ['ar', 'اسمي لينا اختبار AIBB 7a928ba6 whatsapp-ar. وبالمناسبة، قال لي أحدهم اليوم \"hej\".', 'لينا اختبار'],
  ['ar', 'اسمي لينا اختبار AIBB 93414557 whatsapp-ar. وبالمناسبة، قال لي أحدهم اليوم \"hej\".', 'لينا اختبار'],
  ['ar', 'اسمي لينا اختبار.', 'لينا اختبار'],
  ['fa', 'میرا آزمون', 'میرا آزمون'],
  ['fa', 'نام من میرا آزمون AIBB 7a928ba6 whatsapp-fa. ضمناً امروز کسی به من \"hej\" گفت.', 'میرا آزمون'],
  ['fa', 'نام من میرا آزمون AIBB a11b0099-52ac-4fba-9dde-1f1f414af771 whatsapp-fa.', 'میرا آزمون'],
  ['fa', 'نام من میرا آزمون AIBB ۹۳۴۱۴۵۵۷ whatsapp-fa. ضمناً امروز کسی به من \"hej\" گفت.', 'میرا آزمون'],
  ['fa', 'نام من میرا آزمون است.', 'میرا آزمون'],
  ['ar', 'اسمي ميرا اختبار. AIBB 93414557 whatsapp-ar.', 'ميرا اختبار'],
  ['fa', 'نام من میرا تستمن است. AIBB ۹۳۴۱۴۵۵۷ whatsapp-fa.', 'میرا تستمن'],
] as const;

for (const [language, message, expectedName] of numericNameCases) {
  test(`WhatsApp ${language}: numeric name text preserves sender through state, persistence and confirmation: ${message}`, async (t) => {
    const f = fixture(t);
    await select(f);
    const confirmed = await confirm(f);
    boundary.seedFlowLanguage(f.sessionId, language);
    boundary.seedPending(f.sessionId, { ...confirmed.pending, language });
    assert.equal(await boundary.prepareConversationLanguageForTest(f.sessionId, message, businessConfig), language);
    assert.equal((await boundary.whatsappPreDispatchDecisionAfterStateLoad(f.sessionId, message, businessConfig)).dispatchesUnifiedBooking, true);
    const traceStart = f.traces.length;
    const completed = await f.turn(message);
    const expectedPhone = '+46700000001';
    assert.equal(completed.pending, null);
    assert.equal(f.created.length, 1);
    assert.equal(f.recorded.length, 1);
    assert.equal(f.notifications.length, 1);
    for (const payload of [f.created[0], f.recorded[0], f.notifications[0]]) {
      assert.equal(payload.name, expectedName);
      assert.equal(payload.phone, expectedPhone);
      assert.equal(payload.service, confirmed.pending.service);
      assert.equal(new Date(payload.dateTime).getTime(), new Date(confirmed.pending.dateTime).getTime());
    }
    assert.equal(f.created[0].duration, confirmed.pending.durationMinutes);
    const completion = boundary.recentCompletionState(f.sessionId).completed?.bookingOperation;
    assert.equal(completion?.customerName, expectedName);
    assert.equal(completion?.customerPhone, expectedPhone);
    assert.match([...f.events.values()][0].summary, /\+46700000001/u);
    assert.ok(completed.replies.join(' ').includes(expectedName));
    assert.ok(completed.replies.join(' ').includes(expectedPhone));
    assert.doesNotMatch(completed.replies.join(' '), /أحتاج.*اسمك|نیاز.*نام|فقط.*اسمك/u);
    assert.equal(f.traces.slice(traceStart).some(event => event.label === '[BookingContactPolicy]' &&
      event.detail?.namePresent === true && event.detail?.finalizationAttempted === true), true);
    await f.turn(message);
    assert.equal(f.created.length, 1);
    assert.equal(f.recorded.length, 1);
    assert.equal(f.notifications.length, 1);
    assert.doesNotMatch(completed.replies.join(' '), /93414557|۹۳۴۱۴۵۵۷|AIBB/u);
    const traces = f.traces.slice(traceStart);
    assert.equal(traces.some(event => event.label === '[BookingRefinement]' && event.detail?.freshScanStarted), false);
    assert.equal(traces.some(event => event.detail?.nextStateType === 'awaiting_time_selection'), false);
    assert.equal(traces.some(event => event.label === '[BookingContactPolicy]' && event.detail?.phoneSourceType === 'verified_sender_metadata'), true);
  });
}

for (const channel of ['whatsapp', 'telegram', 'messenger', 'instagram'] as const) {
  test(`${channel}: no channel phone collects explicit phone after numeric name text without resetting selection`, async (t) => {
    const f = fixture(t, channel, false);
    await select(f);
    const confirmed = await confirm(f);
    const named = await f.turn('My name is Mira Testmann AIBB 93414557.');
    assert.equal(named.pending?.status, 'awaiting_contact');
    assert.equal(named.pending?.customerName, 'Mira Testmann');
    assert.equal(named.pending?.customerPhone ?? null, null);
    assert.equal(named.pending?.service, confirmed.pending.service);
    assert.equal(named.pending?.dateTime, confirmed.pending.dateTime);
    assert.equal(named.pending?.selectedSlotEnd, confirmed.pending.selectedSlotEnd);
    assert.deepEqual(named.pending?.ownedOfferedSlots, confirmed.pending.ownedOfferedSlots);
    const completed = await f.turn('0701234567');
    assert.equal(completed.pending, null);
    assert.equal(f.created[0].phone, '0701234567');
    assert.equal(f.recorded[0].phone, '0701234567');
    assert.equal(f.notifications[0].phone, '0701234567');
    assert.match(completed.replies.join(' '), /Mira Testmann/u);
    assert.match(completed.replies.join(' '), /0701234567/u);
  });
}

test('WhatsApp intentional labeled customer phone override remains supported', async (t) => {
  const f = fixture(t);
  await select(f);
  await confirm(f);
  const completed = await f.turn('My name is Mira Testmann. My phone number is 0701234567.');
  assert.equal(completed.pending, null);
  assert.equal(f.created[0].phone, '0701234567');
  assert.equal(f.recorded[0].phone, '0701234567');
  assert.equal(f.notifications[0].phone, '0701234567');
  assert.match(completed.replies.join(' '), /0701234567/u);
});

for (const withPhone of [true, false]) {
  test(`inferred numeric run identifier cannot bypass contact validation (sender present: ${withPhone})`, async (t) => {
    const f = fixture(t, 'whatsapp', withPhone, '93414557');
    await select(f);
    const confirmed = await confirm(f);
    f.adoptionDecisions.length = 0;
    const result = await f.turn('My name is Mira Testmann AIBB 93414557 whatsapp-en.');
    assert.equal(f.adoptionDecisions.some(decision => decision.field === 'phone' &&
      decision.disposition === 'provider_rejected_validation'), true);
    if (withPhone) {
      assert.equal(result.pending, null);
      assert.equal(f.created[0].phone, '+46700000001');
      assert.equal(f.recorded[0].phone, '+46700000001');
    } else {
      assert.equal(result.pending?.status, 'awaiting_contact');
      assert.equal(result.pending?.customerPhone ?? null, null);
      assert.equal(result.pending?.dateTime, confirmed.pending.dateTime);
      assert.equal(f.created.length, 0);
    }
  });
}


test('evidence-grounded Persian phone can be adopted when deterministic parsing misses it', async (t) => {
  const message = 'نام من مینا آزمون و شماره تلفنم 0700001105 است.';
  const evidenceText = 'شماره تلفنم 0700001105';
  const evidenceStart = message.indexOf(evidenceText);

  const f = fixture(
    t,
    'telegram',
    false,
    '0700001105',
    [{
      start: evidenceStart,
      end: evidenceStart + evidenceText.length,
      explicit: true,
    }],
  );

  await select(f);
  await confirm(f);
  f.adoptionDecisions.length = 0;

  const result = await f.turn(message);

  assert.equal(
    f.adoptionDecisions.some((decision) =>
      decision.field === 'phone' &&
      decision.disposition === 'provider_adopted'
    ),
    true,
  );

  assert.equal(result.pending, null);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].name, 'مینا آزمون');
  assert.equal(f.created[0].phone, '0700001105');
  assert.equal(f.recorded[0].phone, '0700001105');
});

test('invalid diagnostic name keeps the owned booking slot until a valid Arabic name completes once', async t => {
  const f = fixture(t);
  await select(f);
  const confirmed = await confirm(f);
  boundary.seedFlowLanguage(f.sessionId, 'ar');
  boundary.seedPending(f.sessionId, { ...confirmed.pending, language: 'ar' });
  for (const message of ['', 'اسمي', 'اسمي AIBB 7a928ba6 whatsapp-ar.', 'اسمي 1234 AIBB 7a928ba6 whatsapp-ar.', 'اسمي AIBB 7a928ba6 whatsapp-ar. وبالمناسبة، كان اليوم جميلًا.']) {
    const incomplete = await f.turn(message);
    assert.equal(incomplete.pending?.status, 'awaiting_contact');
    assert.equal(incomplete.pending?.customerName ?? null, null);
    if (message.trim()) assert.match(incomplete.replies.join(' '), /اسم/u);
    else assert.equal(incomplete.replies.length, 0, 'empty inbound text is ignored while the name prompt remains pending');
    assert.equal(incomplete.pending?.dateTime, confirmed.pending.dateTime);
    assert.equal(incomplete.pending?.selectedSlotEnd, confirmed.pending.selectedSlotEnd);
    assert.deepEqual(incomplete.pending?.ownedOfferedSlots, confirmed.pending.ownedOfferedSlots);
    assert.equal(f.created.length, 0);
  }
  const message = 'اسمي لينا اختبار AIBB 7a928ba6 whatsapp-ar. وبالمناسبة، قال لي أحدهم اليوم "hej".';
  assert.equal((await f.turn(message)).pending, null);
  await f.turn(message);
  assert.equal(f.created.length, 1);
  assert.equal(f.recorded.length, 1);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.created[0].name, 'لينا اختبار');
  assert.equal(f.created[0].phone, '+46700000001');
});

for (const platform of ['telegram', 'messenger', 'instagram'] as const) {
  for (const [language, message, name] of [
    ['ar', 'اسمي لينا اختبار AIBB 7a928ba6 whatsapp-ar. وبالمناسبة، قال لي أحدهم اليوم "hej".', 'لينا اختبار'],
    ['fa', 'نام من میرا آزمون AIBB cafeaffe channel-test. ضمناً امروز کسی به من "hej" گفت.', 'میرا آزمون'],
  ]) {
    test(`${platform}/${language}: native contact name survives marker while missing phone still uses normal collection`, async t => {
      const f = fixture(t, platform, false);
      await select(f);
      const confirmed = await confirm(f);
      boundary.seedFlowLanguage(f.sessionId, language);
      boundary.seedPending(f.sessionId, { ...confirmed.pending, language });
      const named = await f.turn(message);
      assert.equal(named.pending?.status, 'awaiting_contact');
      assert.equal(named.pending?.customerName, name);
      assert.equal(named.pending?.customerPhone ?? null, null);
      assert.equal(named.pending?.dateTime, confirmed.pending.dateTime);
      assert.equal(named.pending?.selectedSlotEnd, confirmed.pending.selectedSlotEnd);
      assert.equal(f.created.length, 0);
      const completed = await f.turn('0701234567');
      assert.equal(completed.pending, null);
      assert.equal(f.created.length, 1);
      assert.equal(f.recorded.length, 1);
      assert.equal(f.notifications.length, 1);
      assert.equal(f.created[0].name, name);
      assert.equal(f.created[0].phone, '0701234567');
      assert.equal(new Date(f.created[0].dateTime).getTime(), new Date(confirmed.pending.dateTime).getTime());
      assert.ok(completed.replies.join(' ').includes(name));
    });
  }
}

test('Arabic explicit phone before diagnostic boundary keeps the existing intentional override behavior', async t => {
  const f = fixture(t);
  await select(f);
  const confirmed = await confirm(f);
  boundary.seedFlowLanguage(f.sessionId, 'ar');
  boundary.seedPending(f.sessionId, { ...confirmed.pending, language: 'ar' });
  const completed = await f.turn('اسمي سلمى منصور ورقم هاتفي 0701234567 AIBB c1ea9b33 channel-test. وبالمناسبة، كان اليوم جميلًا.');
  assert.equal(completed.pending, null);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].name, 'سلمى منصور');
  assert.equal(f.created[0].phone, '0701234567');
  assert.equal(f.recorded[0].phone, '0701234567');
  assert.equal(f.notifications[0].phone, '0701234567');
  assert.equal(new Date(f.created[0].dateTime).getTime(), new Date(confirmed.pending.dateTime).getTime());
});

test('a real slot correction before a diagnostic boundary still reaches the existing booking state logic', async t => {
  const f = fixture(t);
  await select(f);
  await confirm(f);
  const corrected = await f.turn('I want to change the date to 2026-10-02 AIBB c1ea9b33 channel-test.');
  assert.notEqual(corrected.pending?.selectedDate, '2026-10-01');
  assert.equal(f.created.length, 0);
});
