import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingLeadStore } from '../../tests/helpers/pending-lead-store';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const now = new Date('2026-10-06T10:00:00Z');
const businessConfig = { id: '7', businessName: 'Broadening Clinic', language: 'en',
  timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-7',
  defaultBookingService: 'Video Consultation', services: [{ name: 'Video Consultation', duration: 30 }],
  workingHours: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .map(day => [day, [{ start: '09:00', end: '18:00' }]])),
};
const channels = ['instagram', 'messenger', 'whatsapp', 'telegram'] as const;
const messages = [
  ['en', 'Could you check if you have any available times for me tomorrow?'],
  ['sv', 'Vilka lediga tider har ni i morgon?'],
  ['de', 'Welche freien Termine haben Sie morgen?'],
  ['es', '¿Qué horarios disponibles tienen mañana?'],
  ['fa', 'چه وقت های خالی برای فردا دارید؟'],
  ['ar', 'ما هي الأوقات المتاحة غداً؟'],
] as const;

function fixture(t: any, platformName: typeof channels[number] = 'instagram', store?: PendingLeadStore) {
  boundary.reset();
  t.after(() => boundary.reset());
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const traces: Array<{ label: string; detail: any }> = [];
  t.mock.method(console, 'log', (label: string, detail: any) => traces.push({ label, detail }));
  let blocked = true;
  let alternatives = false;
  let scans = 0;
  let mutations = 0;
  let scanFails = false;
  boundary.configure({ semanticLanguageResolver: async () => null,
    ...(store ? { supabaseClient: store } : {}),
    availabilityDiagnostic: (detail: any) => { traces.push({ label: 'availability-diagnostic', detail }); },
    calendarAdapter: { getCalendarId: () => 'cal-7',
      getEvents: async () => { scans++; if (scanFails) throw new Error('Synthetic calendar read failure'); return alternatives ? [{ summary: 'Busy requested clocks',
        start: { dateTime: '2026-10-07T13:00:00+02:00' }, end: { dateTime: '2026-10-07T14:30:00+02:00' } }] : blocked ? [{ summary: 'Busy',
        start: { dateTime: '2026-10-07T00:00:00+02:00' }, end: { dateTime: '2026-10-08T00:00:00+02:00' } }] : []; },
      checkSlots: async () => { throw new Error('Legacy availability must not run'); },
      insertAppointment: async () => { mutations++; throw new Error('Availability must not mutate'); },
    }, postProcess: async () => undefined, notifyBooking: async () => true,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    recordAppointment: async () => { mutations++; throw new Error('Availability must not mutate'); },
  });
  const recipientUserId = platformName === 'whatsapp' ? '46700000001' : `broadening-${platformName}`;
  const sessionId = platformName === 'telegram' ? recipientUserId
    : boundary.channelSessionId(platformName, recipientUserId, businessConfig, 'broadening-phone-id');
  const turn = (text: string) => boundary.turn({ sessionId, recipientUserId, platformName, text, businessConfig, now });
  const contacts = (pending: any) => boundary.seedPending(sessionId, { ...pending,
    customerName: 'Ada Test', customerPhone: '0701234567', contactPhoneSource: 'explicit_customer_message',
  });
  return { turn, traces, contacts, sessionId, platformName, release: () => { blocked = false; alternatives = false; },
    offerAlternatives: () => { blocked = false; alternatives = true; },
    failScan: () => { scanFails = true; },
    scans: () => scans, mutations: () => mutations };
}

function assertWholeDay(result: any, f: ReturnType<typeof fixture>, scanCount: number, freeCandidateCount = 35) {
  const p = result.pending;
  assert.equal(result.handled, true);
  assert.equal(p?.availabilityConstraint?.kind, 'whole_day', JSON.stringify({ constraint: p?.availabilityConstraint,
    normalized: p?.normalizedBookingRequest, requestedTime: p?.requestedTime, replies: result.replies,
    scansBefore: scanCount, scansAfter: f.scans(), transitions: f.traces.filter(e =>
      ['[BookingNormalizedState]', '[BookingRefinement]', '[CombinedAvailabilityConstraint]'].includes(e.label)) }));
  for (const key of ['exactTime', 'minTime', 'maxTime', 'timeBoundary', 'daypart']) {
    assert.equal(p.availabilityConstraint[key], undefined, key);
  }
  assert.equal(p.requestedTime, null);
  assert.equal(p.availabilityMinTime, null);
  assert.equal(p.availabilityMaxTime, null);
  assert.equal(p.normalizedBookingRequest.timeConstraint.kind, 'none');
  assert.equal(p.normalizedBookingRequest.timeConstraint.startMinutes, undefined);
  assert.equal(p.service, 'Video Consultation');
  assert.equal(p.selectedDate, '2026-10-07');
  assert.equal(p.availabilityStartDate, '2026-10-07');
  assert.equal(p.availabilityEndDate, '2026-10-07');
  assert.equal(p.customerName, 'Ada Test');
  assert.equal(p.customerPhone, '0701234567');
  assert.equal(p.operation, 'new_booking');
  assert.equal(p.platform, f.platformName);
  assert.equal(p.businessId, '7');
  assert.equal(p.sessionId, f.sessionId);
  assert.ok(p.ownedOfferedSlots.every((slot: any) => slot.businessId === '7' && slot.platform === f.platformName));
  assert.ok(p.ownedOfferedSlots.length > 0);
  const diagnostic = f.traces.find(e => e.label === 'availability-diagnostic')?.detail;
  assert.equal(diagnostic?.candidateSlotCount, 35);
  assert.equal(diagnostic?.rejectedByConstraint, 0);
  assert.equal(diagnostic?.freeCandidateCount, freeCandidateCount);
  assert.ok(f.scans() > scanCount, 'fresh calendar scan');
  assert.equal(f.mutations(), 0);
  assert.ok(f.traces.some(e => e.label === '[BookingNormalizedState]' && e.detail.stateReplaced));
  assert.ok(f.traces.some(e => e.label === '[BookingRefinement]' && e.detail.freshScanStarted));
}

for (const channel of channels) {
  for (const [language, message] of messages) {
    test(`${channel}/${language}: 13:00 unavailable, 14:00 unavailable, broaden tomorrow`, async t => {
      const f = fixture(t, channel);
      const first = await f.turn('I want to book a Video Consultation for tomorrow around 13:00.');
      assert.equal(first.pending?.ownedOfferedSlots.length, 0);
      const second = await f.turn('How about 14:00 tomorrow?');
      assert.equal(second.pending?.availabilityConstraint.exactTime, '14:00');
      assert.equal(second.pending?.normalizedBookingRequest.timeConstraint.startMinutes, 840);
      assert.equal(second.pending?.ownedOfferedSlots.length, 0);
      const oldKey = second.pending.lastAvailabilityConstraintKey;
      f.contacts(second.pending);
      const scans = f.scans();
      f.traces.length = 0;
      f.release();
      const third = await f.turn(message);
      assertWholeDay(third, f, scans);
      assert.equal(third.pending.userId, second.pending.userId);
      assert.notEqual(third.pending.lastAvailabilityConstraintKey, oldKey);
    });
  }
}

test('explicit 14:00 then the reported broadening replaces the exact cached failure', async t => {
  const f = fixture(t);
  await f.turn('I want to book a Video Consultation tomorrow at 13:00.');
  const narrow = await f.turn('How about at 14:00 tomorrow?');
  assert.equal(narrow.pending.availabilityConstraint.exactTime, '14:00');
  f.contacts(narrow.pending);
  const scans = f.scans();
  f.traces.length = 0;
  f.release();
  assertWholeDay(await f.turn(messages[0][1]), f, scans);
});

test('broadening retains both endpoints of the active date range', async t => {
  const f = fixture(t);
  f.release();
  const initial = await f.turn('Video Consultation between 7 and 9 October 2026 after 15:00');
  assert.equal(initial.pending.availabilityEndDate, '2026-10-09');
  const broad = await f.turn('Any time.');
  assert.equal(broad.pending.availabilityConstraint.kind, 'date_range');
  assert.equal(broad.pending.availabilityStartDate, '2026-10-07');
  assert.equal(broad.pending.availabilityEndDate, '2026-10-09');
  assert.equal(broad.pending.normalizedBookingRequest.timeConstraint.kind, 'none');
  assert.equal(broad.pending.availabilityConstraint.timeBoundary, undefined);
});

test('a failed widened scan saves the new constraint without a stale requested clock', async t => {
  const f = fixture(t);
  const narrow = await f.turn('Video Consultation tomorrow at 14:00');
  f.contacts(narrow.pending);
  f.failScan();
  const broad = await f.turn('Any time tomorrow.');
  assert.equal(broad.pending.requestedTime, null);
  assert.equal(broad.pending.availabilityConstraint.kind, 'whole_day');
  assert.equal(broad.pending.normalizedBookingRequest.timeConstraint.kind, 'none');
  assert.equal(broad.pending.availabilityConstraint.exactTime, undefined);
  assert.equal(broad.pending.lastAvailabilityConstraintKey, null);
  assert.deepEqual(broad.pending.ownedOfferedSlots, []);
  assert.equal(broad.pending.service, 'Video Consultation');
  assert.equal(broad.pending.customerName, 'Ada Test');
  assert.equal(broad.pending.customerPhone, '0701234567');
});

for (const channel of channels) {
  test(`${channel}: durable restored booking broadens without an in-memory availability context`, async t => {
    const store = new PendingLeadStore();
    const f = fixture(t, channel, store);
    const narrow = await f.turn('Video Consultation tomorrow at 14:00');
    const pending = { ...narrow.pending, customerName: 'Ada Test', customerPhone: '0701234567',
      contactPhoneSource: 'explicit_customer_message' };
    await boundary.stateAuditPersist(f.sessionId, channel, pending);
    boundary.dropBookingSessionMemory(f.sessionId);
    const restored = await boundary.stateAuditRestore(f.sessionId, channel, businessConfig);
    assert.equal(restored.normalizedBookingRequest.timeConstraint.startMinutes, 840);
    assert.equal(restored.customerName, 'Ada Test');
    const scans = f.scans();
    f.traces.length = 0;
    f.release();
    const broad = await f.turn('Any time.');
    assertWholeDay(broad, f, scans);
    assert.equal(broad.pending.userId, pending.userId);
    boundary.dropBookingSessionMemory(f.sessionId);
    const persisted = await boundary.stateAuditRestore(f.sessionId, channel, businessConfig);
    assert.equal(persisted.normalizedBookingRequest.timeConstraint.kind, 'none');
    assert.equal(persisted.requestedTime, null);
    assert.equal(persisted.customerName, 'Ada Test');
    assert.equal(persisted.service, 'Video Consultation');
  });
}

test('whole-day canonical cache with a stale secondary normalized exact time is rescanned', async t => {
  const f = fixture(t);
  const initial = await f.turn('Video Consultation tomorrow at 14:00');
  boundary.dropBookingSessionMemory(f.sessionId);
  boundary.seedPending(f.sessionId, { ...initial.pending, customerName: 'Ada Test', customerPhone: '0701234567',
    contactPhoneSource: 'explicit_customer_message', availabilityConstraint: {
      startDate: '2026-10-07', endDate: '2026-10-07', kind: 'whole_day', rejectedTimes: [],
    } });
  const scans = f.scans();
  f.traces.length = 0;
  f.release();
  assertWholeDay(await f.turn('What times do you have?'), f, scans);
});

for (const restriction of ['tomorrow morning', 'tomorrow after 15:00', 'tomorrow before 12:00',
  'tomorrow between 13:00 and 15:00']) {
  test(`${restriction} unavailable then any time clears all old restrictions`, async t => {
    const f = fixture(t);
    const initial = await f.turn(`I want to book a Video Consultation ${restriction}.`);
    assert.equal(initial.pending?.ownedOfferedSlots.length, 0);
    f.contacts(initial.pending);
    const scans = f.scans();
    f.traces.length = 0;
    f.release();
    assertWholeDay(await f.turn('Any time tomorrow.'), f, scans);
  });
}

for (const [message, kind, value] of [
  ['How about 16:00 tomorrow?', 'exact_time', '16:00'],
  ['Any time after 15:00 tomorrow.', 'time_boundary', '15:00'],
  ['Any time tomorrow afternoon.', 'daypart', 'afternoon'],
  ['Jederzeit morgen Nachmittag.', 'daypart', 'afternoon'],
  ['أي وقت غداً بعد الظهر', 'daypart', 'afternoon'],
] as const) {
  test(`replacement retains new restriction: ${message}`, async t => {
    const f = fixture(t);
    const initial = await f.turn('Video Consultation tomorrow at 14:00');
    f.contacts(initial.pending);
    f.release();
    const result = await f.turn(message);
    const c = result.pending.availabilityConstraint;
    assert.equal(c.kind, kind);
    assert.equal(c.exactTime || c.timeBoundary?.time || c.daypart, value);
    if (kind === 'time_boundary') {
      assert.equal(c.timeBoundary.kind, 'exclusive_lower');
      assert.equal(result.pending.normalizedBookingRequest.timeConstraint.kind, 'after');
    }
    assert.equal(result.pending.service, 'Video Consultation');
    assert.equal(result.pending.selectedDate, '2026-10-07');
    assert.ok(result.pending.ownedOfferedSlots.length > 0);
  });
}

test('cached narrower offers are replaced by a fresh full-day scan', async t => {
  const f = fixture(t);
  f.release();
  const initial = await f.turn('What times are available tomorrow after 15:00 for a Video Consultation?');
  assert.ok(initial.pending?.ownedOfferedSlots.length > 0);
  f.contacts(initial.pending);
  const scans = f.scans();
  f.traces.length = 0;
  const result = await f.turn('What times do you have tomorrow?');
  assertWholeDay(result, f, scans);
  assert.notEqual(result.pending.lastAvailabilityConstraintKey, initial.pending.lastAvailabilityConstraintKey);
  assert.notDeepEqual(result.pending.ownedOfferedSlots, initial.pending.ownedOfferedSlots);
});

test('broad request without a prior constraint scans normally', async t => {
  const f = fixture(t);
  f.release();
  const result = await f.turn('What times are available tomorrow for a Video Consultation?');
  assert.equal(result.pending.availabilityConstraint.kind, 'whole_day');
  assert.equal(result.pending.selectedDate, '2026-10-07');
  assert.ok(result.pending.ownedOfferedSlots.length > 0);
});

test('ambiguous retry preserves exact restriction and cached fingerprint', async t => {
  const f = fixture(t);
  const initial = await f.turn('Video Consultation tomorrow at 14:00');
  const result = await f.turn('Is that available?');
  assert.equal(result.pending.availabilityConstraint.exactTime, '14:00');
  assert.equal(result.pending.normalizedBookingRequest.timeConstraint.kind, 'exact');
  assert.equal(result.pending.lastAvailabilityConstraintKey, initial.pending.lastAvailabilityConstraintKey);
});

test('confirmed selected slot survives unrelated information; explicit broadening changes availability', async t => {
  const f = fixture(t);
  f.release();
  await f.turn('What times are available tomorrow for a Video Consultation?');
  await f.turn('09:15 works for me.');
  const confirmed = await f.turn('Yes, please book it.');
  assert.equal(confirmed.pending.status, 'awaiting_contact');
  const scans = f.scans();
  const general = await f.turn('What are your opening hours tomorrow?');
  assert.equal(general.pending.dateTime, confirmed.pending.dateTime);
  assert.equal(general.pending.selectedSlotEnd, confirmed.pending.selectedSlotEnd);
  assert.equal(f.scans(), scans);
  const contactInfo = await f.turn('Can I contact you any time tomorrow?');
  assert.equal(contactInfo.pending.dateTime, confirmed.pending.dateTime);
  assert.equal(f.scans(), scans);
  f.contacts(contactInfo.pending);
  f.traces.length = 0;
  assertWholeDay(await f.turn('Could you check if you have any available times for me tomorrow?'), f, scans);
});

const alternativeMessages = [
  ['en', 'Do you have any other times available tomorrow?'],
  ['en', 'Do you have any other times tomorrow?'],
  ['en', 'Any other times available tomorrow?'],
  ['en', 'What other times do you have tomorrow?'],
  ['en', 'Are there any other slots tomorrow?'],
  ['en', 'Anything else available tomorrow?'],
  ['en', 'Show me some other times tomorrow.'],
  ['en', 'Do you have another slot tomorrow?'],
  ['en', 'Can you check different times tomorrow?'],
  ['sv', 'Har ni några andra tider i morgon?'],
  ['de', 'Haben Sie andere Termine morgen?'],
  ['es', '¿Tienen otros horarios disponibles mañana?'],
  ['fa', 'آیا وقت دیگری برای فردا دارید؟'],
  ['ar', 'هل لديكم مواعيد أخرى غداً؟'],
] as const;

for (const channel of channels) {
  for (const [language, message] of alternativeMessages) {
    test(`${channel}/${language}: cached alternatives broaden: ${message}`, async t => {
      const f = fixture(t, channel);
      f.offerAlternatives();
      const first = await f.turn('I want to book a Video Consultation for tomorrow around 13:00.');
      assert.equal(first.pending.availabilityConstraint.exactTime, '13:00');
      assert.ok(first.pending.ownedOfferedSlots.length > 0);
      const second = await f.turn('How about 14:00 tomorrow?');
      assert.equal(second.pending.availabilityConstraint.exactTime, '14:00');
      assert.ok(second.pending.ownedOfferedSlots.length > 0);
      const oldKey = second.pending.lastAvailabilityConstraintKey;
      const oldOffers = second.pending.ownedOfferedSlots;
      f.contacts(second.pending);
      const scans = f.scans();
      f.traces.length = 0;
      // The calendar changes after the narrow offers: only a fresh read can
      // offer the newly free 14:00 slot under an unrestricted constraint.
      f.release();
      const result = await f.turn(message);
      assertWholeDay(result, f, scans);
      assert.equal(result.pending.userId, second.pending.userId);
      assert.notEqual(result.pending.lastAvailabilityConstraintKey, oldKey);
      assert.notDeepEqual(result.pending.ownedOfferedSlots, oldOffers);
      assert.ok(result.pending.ownedOfferedSlots.some((slot: any) => new Date(slot.start).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }) === '14:00'),
        JSON.stringify(result.pending.ownedOfferedSlots));
      assert.ok(result.replies.every((reply: string) => !reply.includes('Which proposed time would you like')));
    });
  }
}

for (const channel of channels) {
  for (const message of ['Which one should I choose?', 'Can you show those times again?',
    'Do you have something else tomorrow?', 'Do you have any other payment options?']) {
    test(`${channel}: alternative-enumeration ambiguity preserves offers: ${message}`, async t => {
      const f = fixture(t, channel);
      f.offerAlternatives();
      const initial = await f.turn('Video Consultation tomorrow at 14:00');
      f.contacts(initial.pending);
      const scans = f.scans();
      const result = await f.turn(message);
      assert.equal(result.pending.availabilityConstraint.exactTime, '14:00');
      assert.equal(result.pending.normalizedBookingRequest.timeConstraint.kind, 'exact');
      assert.equal(result.pending.requestedTime, '14:00');
      assert.equal(result.pending.dateTime, initial.pending.dateTime);
      assert.deepEqual(result.pending.ownedOfferedSlots, initial.pending.ownedOfferedSlots);
      assert.equal(result.pending.lastAvailabilityConstraintKey, initial.pending.lastAvailabilityConstraintKey);
      assert.equal(result.pending.service, 'Video Consultation');
      assert.equal(result.pending.customerName, 'Ada Test');
      assert.equal(result.pending.customerPhone, '0701234567');
      // Re-listing may revalidate the same narrow offers on the calendar;
      // it must not widen the constraint or invalidate the offer fingerprint.
      if (!message.includes('show those')) assert.equal(f.scans(), scans);
      assert.equal(f.mutations(), 0);
      if (message.includes('show those')) assert.match(result.replies.join(' '), /14:30|14:45|15:00/);
    });
  }
  test(`${channel}: exact availability question stays narrow after cached alternatives`, async t => {
    const f = fixture(t, channel);
    f.offerAlternatives();
    await f.turn('Video Consultation tomorrow at 14:00');
    const result = await f.turn('Is 18:00 available?');
    assert.equal(result.pending.availabilityConstraint.exactTime, '18:00');
    assert.equal(result.pending.requestedTime, '18:00');
    assert.equal(result.pending.service, 'Video Consultation');
    assert.equal(result.pending.selectedDate, '2026-10-07');
  });
  test(`${channel}: other times with a restated boundary keeps only the new boundary`, async t => {
    const f = fixture(t, channel);
    f.offerAlternatives();
    const initial = await f.turn('Video Consultation tomorrow at 14:00');
    f.contacts(initial.pending);
    const scans = f.scans();
    const result = await f.turn('Do you have any other times after 15:00 tomorrow?');
    assert.equal(result.pending.normalizedBookingRequest.timeConstraint.kind, 'after');
    assert.equal(result.pending.availabilityConstraint.exactTime, undefined);
    assert.equal(result.pending.availabilityConstraint.timeBoundary.time, '15:00');
    assert.equal(result.pending.requestedTime, null);
    assert.equal(result.pending.customerName, 'Ada Test');
    assert.equal(result.pending.service, 'Video Consultation');
    assert.ok(f.scans() > scans);
  });
}

for (const channel of channels) {
  test(`${channel}: fresh other-times scan excludes both still-unavailable requested clocks`, async t => {
    const f = fixture(t, channel);
    f.offerAlternatives();
    await f.turn('I want to book a Video Consultation for tomorrow around 13:00.');
    const narrow = await f.turn('How about 14:00 tomorrow?');
    f.contacts(narrow.pending);
    const scans = f.scans();
    f.traces.length = 0;
    const result = await f.turn('Do you have any other times available tomorrow?');
    assertWholeDay(result, f, scans, 28);
    assert.notEqual(result.pending.lastAvailabilityConstraintKey, narrow.pending.lastAvailabilityConstraintKey);
    for (const slot of result.pending.ownedOfferedSlots) {
      assert.ok(new Date(slot.end).getTime() <= new Date('2026-10-07T13:00:00+02:00').getTime() ||
        new Date(slot.start).getTime() >= new Date('2026-10-07T14:30:00+02:00').getTime());
    }
  });
}
