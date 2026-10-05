import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingLeadStore } from '../../tests/helpers/pending-lead-store';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const now = new Date('2027-10-04T10:00:00Z');
const tomorrow = '2027-10-05';
const platforms = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
const wording = {
  en: { initial: 'I want to book an appointment', date: 'tomorrow', confirm: 'Yes, please book it.', marker: /available|Which one|times/iu },
  sv: { initial: 'Jag vill boka en tid', date: 'imorgon', confirm: 'Ja tack, boka den.', marker: /ledig|tider|passar/iu },
  de: { initial: 'Ich möchte einen Termin buchen', date: 'morgen', confirm: 'Ja, bitte buchen Sie diese Zeit.', marker: /verfügbar|Zeit|Termin/iu },
  es: { initial: 'Quiero reservar una cita', date: 'mañana', confirm: 'Sí, por favor reserva esa hora.', marker: /hora|libre|reserv/iu },
  fa: { initial: 'سلام، می‌خواهم وقت رزرو کنم', date: 'فردا', confirm: 'بله، لطفاً همان ساعت را رزرو کنید.', marker: /وقت|زمان|رزرو|خالی/u },
  ar: { initial: 'أريد حجز موعد', date: 'غدًا', confirm: 'نعم، احجز ذلك الموعد من فضلك.', marker: /وقت|موعد|متاح|مواعيد/u },
} as const;
type Language = keyof typeof wording;
type Platform = typeof platforms[number];

function fixture(t: any, language: Language = 'en', platform: Platform = 'telegram', extra: any = {}) {
  b.reset();
  t.after(() => b.reset());
  for (const key of ['log', 'info', 'error', 'warn'] as const) t.mock.method(console, key, () => undefined);
  const store = new PendingLeadStore();
  const events = new Map<string, any>();
  const writes = { calendar: 0, database: 0, reads: 0, scans: 0 };
  const config = {
    id: '7', businessRecordId: '7', business_id: '7', businessName: 'Progression Clinic',
    language, timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-7',
    services: [{ id: 'video', name: 'Video Consultation', duration: 30 }, { id: 'premium', name: 'Premium Consultation', duration: 60 }],
    workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      .map(day => [day, [{ start: '09:00', end: '20:00' }]])),
    ...extra.businessConfig,
  };
  const userId = platform === 'whatsapp' ? '46700000001' : `progression-${platform}-${language}`;
  const sessionId = platform === 'telegram' ? userId : b.channelSessionId(platform, userId, config, 'progression-test');
  const dependencies = {
    supabaseClient: store as any,
    semanticLanguageResolver: async () => null,
    availabilityDiagnostic: () => { writes.scans++; },
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      getEvents: async () => { writes.reads++; return [...events.values()]; },
      checkSlots: () => { assert.fail('legacy availability must not run'); },
      insertAppointment: async (name: string, phone: string, service: string, start: string, duration: number, marker: string) => {
        writes.calendar++;
        const event = { id: `event-${writes.calendar}`, status: 'confirmed', summary: `${name} - ${phone}`,
          start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${marker}`,
          extendedProperties: { private: { businessId: '7', platform, userId: marker } } };
        events.set(event.id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    notifyBooking: async () => true,
    validateAppointment: async (appointment: any) => appointment,
    recordAppointment: async (params: any) => ({ id: ++writes.database, business_id: '7', platform, user_id: userId,
      service: params.service, start_time: new Date(params.dateTime).toISOString(),
      end_time: new Date(new Date(params.dateTime).getTime() + params.durationMinutes * 60_000).toISOString(), status: 'booked' }),
    ...extra,
  };
  b.configure(dependencies);
  const turn = async (text: string) => {
    await b.prepareConversationLanguage(sessionId, text, config);
    return b.turn({ sessionId, platformName: platform, recipientUserId: userId, text, businessConfig: config, now: extra.now || now,
      shadowEligibleCustomerTurn: Boolean(dependencies.structuredUnderstandingAdoptionRuntime) });
  };
  const reload = async () => { b.dropBookingSessionMemory(sessionId); return b.stateAuditRestore(sessionId, platform, config); };
  return { config, userId, sessionId, store, writes, turn, reload,
    setSemantic(runtime: any) { dependencies.structuredUnderstandingAdoptionRuntime = runtime; b.configure(dependencies); } };
}

async function selectService(f: ReturnType<typeof fixture>, language: Language) {
  const initial = await f.turn(wording[language].initial);
  assert.equal(initial.pending?.status, 'awaiting_service', JSON.stringify(initial));
  const selected = await f.turn('Video Consultation');
  assert.equal(selected.pending?.service, 'Video Consultation');
  assert.equal(selected.pending?.serviceResolution, 'authoritative');
  assert.equal(selected.pending?.status, 'awaiting_date_or_time');
  return selected;
}

for (const text of ['tommarow i can come', 'tommorow', 'tommarow']) {
  test(`production continuation: ${text} retains the chosen service and progresses`, async t => {
    const f = fixture(t);
    await selectService(f, 'en');
    const result = await f.turn(text);
    assert.equal(result.pending?.service, 'Video Consultation', JSON.stringify(result));
    assert.equal(result.pending?.selectedDate, tomorrow, JSON.stringify(result));
    assert.equal(result.pending?.status, 'awaiting_time_selection');
    assert.doesNotMatch(result.replies.join(' '), /Which service|Which date|what date/iu);
    assert.ok(result.pending?.ownedOfferedSlots?.length > 0);
    await f.reload();
    const selected = await f.turn('2');
    assert.equal(selected.pending?.service, 'Video Consultation');
    await f.turn('Yes, please book it.');
    const completed = await f.turn('Alex Testsson, 0701234567');
    assert.equal(completed.pending, null);
    assert.equal(f.writes.calendar, 1);
    assert.equal(f.writes.database, 1);
    await f.turn('yes');
    assert.equal(f.writes.calendar, 1, 'repeated confirmation must not write another event');
    assert.equal(f.writes.database, 1);
  });
}

for (const platform of platforms) {
  for (const language of Object.keys(wording) as Language[]) {
    test(`${platform}/${language}: service, relative date and slot progress through reload to exactly one booking`, async t => {
      const f = fixture(t, language, platform);
      await selectService(f, language);
      const restored = await f.reload();
      assert.equal(restored.service, 'Video Consultation');
      assert.equal(restored.language, language);
      assert.equal(restored.expectedInput, 'date_or_constraint');
      const offered = await f.turn(wording[language].date);
      assert.equal(offered.pending?.service, 'Video Consultation', JSON.stringify(offered));
      assert.equal(offered.pending?.serviceId, 'video');
      assert.equal(offered.pending?.serviceResolution, 'authoritative');
      assert.equal(offered.pending?.selectedDate, tomorrow);
      assert.equal(offered.pending?.normalizedBookingRequest?.date?.value, tomorrow);
      assert.equal(offered.pending?.language, language);
      assert.equal(offered.pending?.status, 'awaiting_time_selection');
      assert.match(offered.replies.join(' '), wording[language].marker);
      assert.ok(offered.pending?.ownedOfferedSlots?.length > 1);
      const offeredRestored = await f.reload();
      assert.equal(offeredRestored.selectedDate, tomorrow);
      assert.equal(offeredRestored.service, 'Video Consultation');
      assert.equal(offeredRestored.expectedInput, 'slot_selection');
      const selected = await f.turn('2');
      assert.equal(selected.pending?.service, 'Video Consultation');
      assert.equal(selected.pending?.selectedDate, tomorrow);
      assert.equal(selected.pending?.status, 'awaiting_confirmation');
      const selectedIso = selected.pending?.dateTime;
      const scans = f.writes.scans;
      const confirmed = await f.turn(wording[language].confirm);
      assert.equal(confirmed.pending?.status, 'awaiting_contact', JSON.stringify(confirmed));
      assert.equal(confirmed.pending?.dateTime, selectedIso);
      assert.equal(confirmed.pending?.service, 'Video Consultation');
      assert.equal(f.writes.scans, scans, 'confirmation must not rescan availability; exact-slot validation remains required');
      await f.reload();
      const completed = await f.turn('Alex Testsson, 0701234567');
      assert.equal(completed.pending, null, JSON.stringify(completed));
      assert.equal(f.writes.calendar, 1);
      assert.equal(f.writes.database, 1);
      const pendingRows = f.store.rows.filter(row => row.platform === platform);
      assert.equal(pendingRows.length, 1, 'reload must reuse the same pending row');
      assert.equal(pendingRows[0].ai_summary, null, 'pending clears only after verified completion');
    });
  }
}

for (const [language, text] of [['sv', 'imorgn'], ['es', 'manana'], ['fa', 'farda'], ['ar', 'غداً'], ['ar', 'غدا']] as const) {
  test(`${language}: relative-date variant ${text} advances the established booking`, async t => {
    const f = fixture(t, language);
    await selectService(f, language);
    const result = await f.turn(text);
    assert.equal(result.pending?.service, 'Video Consultation');
    assert.equal(result.pending?.selectedDate, tomorrow);
    assert.equal(result.pending?.status, 'awaiting_time_selection');
  });
}

test('generic service mention in a date continuation does not reopen service selection', async t => {
  const f = fixture(t);
  await selectService(f, 'en');
  const result = await f.turn('tomorrow for the consultation');
  assert.equal(result.pending?.service, 'Video Consultation', JSON.stringify(result));
  assert.equal(result.pending?.serviceId, 'video');
  assert.equal(result.pending?.selectedDate, tomorrow);
  assert.equal(result.pending?.status, 'awaiting_time_selection');
  assert.doesNotMatch(result.replies.join(' '), /Which service|Which consultation/iu);
});

const corrections = {
  en: ['actually make it Friday', 'not 18:00, 19:00'],
  sv: ['jag menade fredag', 'inte 18:00, 19:00'],
  de: ['ich meinte Freitag', 'nicht 18:00, 19:00'],
  es: ['me refería al viernes', 'no 18:00, 19:00'],
  fa: ['منظورم جمعه است', 'نه 18:00، 19:00'],
  ar: ['كنت أقصد الجمعة', 'ليس 18:00، 19:00'],
} as const;
for (const language of Object.keys(corrections) as Language[]) {
  for (const kind of ['date', 'time'] as const) {
    test(`${language}: explicit ${kind} correction retains service and invalidates only the old selection`, async t => {
      const f = fixture(t, language);
      await selectService(f, language);
      await f.turn(wording[language].date);
      const selected = await f.turn('2');
      const knownContact = { ...selected.pending, customerName: 'Alex Testsson' };
      await b.stateAuditPersist(f.sessionId, 'telegram', knownContact);
      await f.reload();
      const result = await f.turn(corrections[language][kind === 'date' ? 0 : 1]);
      assert.equal(result.pending?.service, 'Video Consultation', JSON.stringify(result));
      assert.equal(result.pending?.language, language);
      assert.equal(result.pending?.customerName, 'Alex Testsson');
      assert.equal(result.pending?.selectedDate, kind === 'date' ? '2027-10-08' : tomorrow);
      if (kind === 'date') {
        assert.equal(result.pending?.status, 'awaiting_time_selection');
        assert.equal(result.pending?.dateTime, null);
      } else {
        assert.ok(['awaiting_time_selection', 'awaiting_confirmation'].includes(result.pending?.status), JSON.stringify(result));
        assert.equal(result.pending?.availabilityConstraint?.exactTime, '19:00', JSON.stringify(result));
        assert.equal(result.pending?.normalizedBookingRequest?.timeConstraint?.startMinutes, 19 * 60, JSON.stringify(result));
      }
    });
  }
}

test('unusable date answer asks one focused question and retains established facts', async t => {
  const f = fixture(t);
  const selected = await selectService(f, 'en');
  const result = await f.turn('I am not sure yet');
  assert.equal(result.pending?.service, selected.pending?.service);
  assert.equal(result.pending?.serviceId, selected.pending?.serviceId);
  assert.equal(result.pending?.durationMinutes, selected.pending?.durationMinutes);
  assert.equal(result.pending?.language, 'en');
  assert.equal(result.pending?.operation, 'new_booking');
  assert.equal(result.replies.length, 1);
  assert.doesNotMatch(result.replies[0], /Which service/iu);
  assert.equal(result.pending?.status, 'awaiting_date_or_time');
});

for (const language of Object.keys(wording) as Language[]) {
  test(`${language}: explicit configured service correction retains date`, async t => {
    const f = fixture(t, language);
    await selectService(f, language);
    await f.turn(wording[language].date);
    await f.turn('2');
    const cue = { en: 'I meant', sv: 'jag menade', de: 'ich meinte', es: 'me refería a', fa: 'منظورم', ar: 'كنت أقصد' }[language];
    const changed = await f.turn(`${cue} Premium Consultation`);
    assert.equal(changed.pending?.service, 'Premium Consultation', JSON.stringify(changed));
    assert.equal(changed.pending?.serviceId, 'premium');
    assert.equal(changed.pending?.selectedDate, tomorrow);
    assert.equal(changed.pending?.durationMinutes, 60);
    assert.equal(changed.pending?.language, language);
    assert.ok(changed.pending?.ownedOfferedSlots?.every((slot: any) => slot.service === 'Premium Consultation'));
  });
}

function semanticRelativeDate(confidence: number) {
  return {
    async evaluate() { return {
      schemaVersion: 1, language: { primary: { value: 'en', confidence: 1 }, codeSwitches: [] },
      intents: [{ value: 'new_booking', confidence: 1 }], acts: { bookingRequest: { value: true, confidence: 1 } },
      entities: { date: { value: { kind: 'relative', relativeExpression: 'tomorrow' }, confidence } }, ambiguities: [],
    }; }, emitDecisions() {},
  };
}

test('high-confidence semantic typo recovery fills only the missing date after reload', async t => {
  const f = fixture(t, 'en', 'telegram', { structuredUnderstandingAdoptionRuntime: semanticRelativeDate(1) });
  // Enable semantic recovery only after intake; initial booking must still ask service.
  f.setSemantic(null);
  await selectService(f, 'en');
  await f.reload();
  f.setSemantic(semanticRelativeDate(1));
  const result = await f.turn('tmrw would work');
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.serviceId, 'video');
  assert.equal(result.pending?.selectedDate, tomorrow);
  assert.equal(result.pending?.status, 'awaiting_time_selection');
  assert.equal(result.pending?.operation, 'new_booking');
});

test('uncertain semantic date and a provider new-booking intent cannot reset established state', async t => {
  const f = fixture(t, 'en', 'telegram', { structuredUnderstandingAdoptionRuntime: semanticRelativeDate(0.4) });
  f.setSemantic(null);
  await selectService(f, 'en');
  f.setSemantic(semanticRelativeDate(0.4));
  const unclear = await f.turn('maybe later');
  assert.equal(unclear.pending?.service, 'Video Consultation');
  assert.equal(unclear.pending?.selectedDate, null);
  assert.equal(unclear.pending?.status, 'awaiting_date_or_time');
  await f.turn('Friday');
  await f.reload();
  f.setSemantic(semanticRelativeDate(1));
  const retained = await f.turn('ok');
  assert.equal(retained.pending?.service, 'Video Consultation');
  assert.equal(retained.pending?.selectedDate, '2027-10-08');
  assert.equal(retained.pending?.operation, 'new_booking');
});

test('explicit new-booking pivot still releases the previous operation', async t => {
  const f = fixture(t);
  await selectService(f, 'en');
  await f.turn('tomorrow');
  await f.turn('2');
  const result = await f.turn('I want to book a new appointment instead');
  assert.equal(result.pending?.status, 'awaiting_service', JSON.stringify(result));
  assert.equal(result.pending?.dateTime, null);
  assert.equal(result.pending?.ownedOfferedSlots?.length, 0);
});

for (const [timezone, expected] of [['Europe/Stockholm', '2027-10-06'], ['America/Los_Angeles', '2027-10-05']] as const) {
  test(`relative-date typo uses the business timezone at UTC midnight: ${timezone}`, async t => {
    const f = fixture(t, 'en', 'telegram', { businessConfig: { timezone }, now: new Date('2027-10-04T23:30:00Z') });
    await selectService(f, 'en');
    const result = await f.turn('tommorow');
    assert.equal(result.pending?.selectedDate, expected);
    assert.equal(result.pending?.service, 'Video Consultation');
    assert.equal(result.pending?.status, 'awaiting_time_selection');
  });
}

test('day after a misspelled tomorrow remains two days ahead', async t => {
  const f = fixture(t);
  await selectService(f, 'en');
  const result = await f.turn('day after tommorow');
  assert.equal(result.pending?.selectedDate, '2027-10-06');
  assert.equal(result.pending?.service, 'Video Consultation');
});

test('a similar name is not guessed to be a date', async t => {
  const f = fixture(t);
  await selectService(f, 'en');
  const result = await f.turn('Morgan');
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.selectedDate, null);
  assert.equal(result.pending?.status, 'awaiting_date_or_time');
});

for (const language of Object.keys(wording) as Language[]) {
  test(`${language}: date correction with an incidental catalog fragment retains service`, async t => {
    const f = fixture(t, language);
    await selectService(f, language);
    await f.turn(wording[language].date);
    await f.turn('2');
    const result = await f.turn(`${corrections[language][0]} for the consultation`);
    assert.equal(result.pending?.service, 'Video Consultation', JSON.stringify(result));
    assert.equal(result.pending?.selectedDate, '2027-10-08');
    assert.equal(result.pending?.language, language);
    assert.equal(result.pending?.status, 'awaiting_time_selection');
  });
}

for (const platform of platforms) {
  test(`${platform}: separate name and phone submissions resume the selected slot after reload`, async t => {
    const f = fixture(t, 'en', platform);
    await selectService(f, 'en');
    await f.turn('tomorrow');
    const selected = await f.turn('2');
    const scans = f.writes.scans;
    await f.turn('ok');
    const named = await f.turn('My name is Alex Testsson');
    if (named.pending) {
      assert.equal(named.pending.customerName, 'Alex Testsson');
      assert.equal(named.pending.dateTime, selected.pending?.dateTime);
      assert.equal(named.pending.service, 'Video Consultation');
      const restored = await f.reload();
      assert.equal(restored.customerName, 'Alex Testsson');
      assert.equal(restored.dateTime, selected.pending?.dateTime);
      const completed = await f.turn('0701234567');
      assert.equal(completed.pending, null, JSON.stringify(completed));
    }
    assert.equal(f.writes.scans, scans);
    assert.equal(f.writes.calendar, 1);
    assert.equal(f.writes.database, 1);
  });
}

for (const language of Object.keys(wording) as Language[]) {
  test(`${language}: time-only selection retains service/date/ownership without rescanning`, async t => {
    const f = fixture(t, language);
    const service = await selectService(f, language);
    const offered = await f.turn(wording[language].date);
    const slot = offered.pending?.ownedOfferedSlots[1];
    const scans = f.writes.scans;
    const selected = await f.turn(slot.start.slice(11, 16));
    assert.equal(selected.pending?.status, 'awaiting_confirmation');
    assert.equal(new Date(selected.pending?.dateTime).getTime(), new Date(slot.start).getTime());
    assert.equal(selected.pending?.service, 'Video Consultation');
    assert.equal(selected.pending?.selectedDate, tomorrow);
    assert.equal(selected.pending?.businessId, service.pending?.businessId);
    assert.equal(selected.pending?.userId, service.pending?.userId);
    assert.equal(selected.pending?.platform, service.pending?.platform);
    assert.equal(f.writes.scans, scans);
  });
}

test('repeating the exact selected catalog service preserves the owned slot', async t => {
  const f = fixture(t);
  await selectService(f, 'en');
  await f.turn('tomorrow');
  const selected = await f.turn('2');
  const result = await f.turn('Video Consultation');
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.status, 'awaiting_confirmation', JSON.stringify(result));
  assert.equal(result.pending?.dateTime, selected.pending?.dateTime);
});

for (const language of Object.keys(wording) as Language[]) {
  test(`${language}: repeated date with contact details retains those details on the cached-offer path`, async t => {
    const f = fixture(t, language);
    await selectService(f, language);
    await f.turn(wording[language].date);
    const scans = f.writes.scans;
    const result = await f.turn(`${wording[language].date}. My name is Alex Testsson and my phone is 0701234567.`);
    assert.equal(result.pending?.service, 'Video Consultation');
    assert.equal(result.pending?.selectedDate, tomorrow);
    assert.equal(result.pending?.customerName, 'Alex Testsson', JSON.stringify(result));
    assert.equal(result.pending?.customerPhone, '0701234567');
    assert.equal(result.pending?.status, 'awaiting_time_selection');
    assert.equal(f.writes.scans, scans);
    const restored = await f.reload();
    assert.equal(restored.customerName, 'Alex Testsson');
    assert.equal(restored.customerPhone, '0701234567');
  });
}

for (const language of Object.keys(wording) as Language[]) {
  test(`${language}: date/service continuation retains contact belonging to the active operation`, async t => {
    const f = fixture(t, language);
    const service = await selectService(f, language);
    await b.stateAuditPersist(f.sessionId, 'telegram', {
      ...service.pending, customerName: 'Alex Testsson', customerPhone: '0701234567', contactPhoneSource: 'explicit_customer_message',
    });
    await f.reload();
    const result = await f.turn(`${wording[language].date} for the consultation`);
    assert.equal(result.pending?.service, 'Video Consultation');
    assert.equal(result.pending?.selectedDate, tomorrow);
    assert.equal(result.pending?.customerName, 'Alex Testsson');
    assert.equal(result.pending?.customerPhone, '0701234567');
    assert.equal(result.pending?.language, language);
    assert.equal(result.pending?.operation, 'new_booking');
  });
}
