import assert from 'node:assert/strict';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-25T12:00:00+02:00');
const platforms = ['telegram', 'whatsapp', 'messenger', 'instagram'] as const;
const toneConfig = {
  tonePreset: 'professional', responseLength: 'balanced', formality: 'formal',
  emojiUsage: 'none', customToneInstructions: '',
};
const business = (id: string) => ({
  id, businessRecordId: id, business_id: id, businessName: `Clinic ${id}`,
  timezone: 'Europe/Stockholm', calendarProvider: 'custom',
  defaultBookingService: 'Consultation', toneConfig,
});

const localized = {
  en: { selection: '13:00', confirmation: 'Yes, please book it.', marker: /\b(?:Yes|available|booking|booked|appointment|name|mobile)\b/iu },
  sv: { selection: '13:00', confirmation: 'Ja tack, boka den.', marker: /\b(?:Ja|ledig|boka|bokningen|namn|mobilnummer)\b/iu },
  es: { selection: '13:00', confirmation: 'Sí, por favor reserva esa hora.', marker: /(?:Sí|libre|reserv|nombre|móvil)/iu },
  de: { selection: '13:00 Uhr', confirmation: 'Ja, bitte buchen Sie diese Zeit.', marker: /\b(?:Meinen|antworten|Ja|verfügbar|Termin|Buchung|Namen|Mobilnummer)\b/iu },
  fa: { selection: 'ساعت 13:00', confirmation: 'بله، لطفاً همان ساعت را رزرو کنید.', marker: /(?:بله|خالی|رزرو|نام|شماره)/u },
  ar: { selection: 'الساعة 14:00', confirmation: 'نعم، احجز ذلك الموعد من فضلك.', marker: /(?:نعم|متاح|مواعيد|احجز|حجز|موعدك|الاسم|رقم)/u },
} as const;
const contradictoryDate = {
  en: 'I want to book Tuesday 15 October 2026 at 14:00',
  sv: 'Jag vill boka tisdag den 15 oktober 2026 klockan 14:00',
  es: 'Quiero reservar el martes 15 de octubre de 2026 a las 14:00',
  de: 'Ich möchte Dienstag den 15. Oktober 2026 um 14:00 buchen',
  fa: 'می خواهم سه شنبه 15 اکتبر 2026 ساعت 14:00 رزرو کنم',
  ar: 'أريد حجز يوم الثلاثاء 15 أكتوبر 2026 الساعة 14:00',
} as const;

let availabilityReads = 0;
let calendarWrites = 0;
let databaseWrites = 0;
const events = new Map<string, any>();
type LeadRow = { user_id: string; platform: string; ai_summary: string | null };
class LeadQuery {
  private filters: Array<(row: LeadRow) => boolean> = [];
  private columns = '*';
  constructor(private rows: LeadRow[], private values?: Partial<LeadRow>) {}
  eq(column: keyof LeadRow, value: unknown) { this.filters.push(row => row[column] === value); return this; }
  select(columns: string) { this.columns = columns; return this; }
  private execute() {
    const row = this.rows.find(item => this.filters.every(filter => filter(item))) || null;
    if (row && this.values) Object.assign(row, this.values);
    if (!row) return { data: null, error: null };
    if (this.columns === 'user_id') return { data: { user_id: row.user_id }, error: null };
    if (this.columns === 'ai_summary') return { data: { ai_summary: row.ai_summary }, error: null };
    return { data: structuredClone(row), error: null };
  }
  async maybeSingle() { return this.execute(); }
  then(resolve: (value: any) => unknown, reject: (reason?: unknown) => unknown) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}
class FakePendingStore {
  rows: LeadRow[] = [];
  from(table: string) {
    assert.equal(table, 'appointments_leads');
    return {
      select: (columns: string) => new LeadQuery(this.rows).select(columns),
      update: (values: Partial<LeadRow>) => new LeadQuery(this.rows, values),
      insert: async (values: Array<Partial<LeadRow>>) => {
        for (const value of values) this.rows.push({
          user_id: String(value.user_id || ''), platform: String(value.platform || 'telegram'),
          ai_summary: value.ai_summary == null ? null : String(value.ai_summary),
        });
        return { data: null, error: null };
      },
    };
  }
}

const configure = (extra: Record<string, unknown> = {}) => {
  boundary.reset();
  events.clear();
  availabilityReads = 0;
  calendarWrites = 0;
  databaseWrites = 0;
  boundary.configure({
    calendarAdapter: {
      getEvents: async () => { availabilityReads += 1; return [...events.values()]; },
      checkSlots: () => ({ available_slots_string: '' }),
      insertAppointment: async (_name: string, _phone: string, _service: string, start: string, duration = 60, marker = '') => {
        calendarWrites += 1;
        const event = {
          id: `event-${calendarWrites}`,
          status: 'confirmed',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          extendedProperties: { private: { platform: 'telegram', userId: marker } },
        };
        events.set(event.id, event);
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
    recordAppointment: async (params: any) => ({
      id: ++databaseWrites,
      business_id: String(params.businessConfig?.id || params.businessId || ''),
      platform: params.platform,
      user_id: String(params.userId),
      service: params.service,
      start_time: new Date(params.dateTime).toISOString(),
      end_time: new Date(new Date(params.dateTime).getTime() + Number(params.durationMinutes) * 60_000).toISOString(),
      status: 'booked',
    }),
    ...extra,
  } as any);
};

const seedSelection = (sessionId: string, platform: typeof platforms[number], language: keyof typeof localized, config: any) => {
  const start = '2026-10-13T13:00:00+02:00';
  const end = '2026-10-13T14:00:00+02:00';
  boundary.seedPending(sessionId, {
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessConfig: config, businessId: config.id, platform, userId: sessionId, sessionId,
    operation: 'new_booking', status: 'awaiting_time_selection', expectedInput: 'slot_selection',
    service: 'Consultation', language, selectedDate: '2026-10-13', durationMinutes: 60,
    normalizedBookingRequest: {
      intent: 'new_booking', language, sourceMode: 'text', requiresClarification: false,
      date: { kind: 'exact_date', value: '2026-10-13', confidence: 'high' },
    },
    availabilityConstraint: { startDate: '2026-10-13', endDate: '2026-10-13', kind: 'day', rejectedTimes: [] },
    offeredSlots: [`Tuesday at 13:00 (ISO: ${start})`],
    ownedOfferedSlots: [{
      start, end, durationMinutes: 60, service: 'Consultation', businessId: config.id,
      platform, userId: sessionId, generatedAt: Date.now(),
      searchStartDate: '2026-10-13', searchEndDate: '2026-10-13',
    }],
    dateTime: null, selectedSlotEnd: null,
  });
};

const turn = (sessionId: string, platformName: typeof platforms[number], text: string, config: any) => boundary.turn({
  sessionId, platformName, recipientUserId: sessionId, text, businessConfig: config, now,
});

try {
  // Durable regression for the confirmed live path. The English setup represents an
  // older clarification shell; the visible German turn must persist its language before
  // another process handles the numeric choice.
  const durableStore = new FakePendingStore();
  const durableTrace: any[] = [];
  configure({
    supabaseClient: durableStore as any,
    bookingLanguageTrace: (event: any) => durableTrace.push(event),
  });
  events.set('blocked-14', {
    id: 'blocked-14', status: 'confirmed',
    start: { dateTime: '2026-10-13T13:00:00+02:00' },
    end: { dateTime: '2026-10-13T15:00:00+02:00' },
  });
  const durableConfig = business('durable-german-live');
  const durableSession = 'durable-german-live';
  await turn(
    durableSession, 'telegram',
    'I want to book Tuesday 15 October 2026 at 14:00',
    durableConfig,
  );
  durableTrace.length = 0;
  const germanClarification = await turn(
    durableSession, 'telegram',
    'Ich möchte am Dienstag, den 15. Oktober 2026 um 14:00 Uhr eine Beratung buchen.',
    durableConfig,
  );
  assert.match(germanClarification.replies[0], /Bitte antworten Sie/u);
  assert.equal(germanClarification.pending?.language, 'de');
  assert.equal(JSON.parse(durableStore.rows[0].ai_summary || '{}').language, 'de',
    'the German switch must be durable before clarification delivery returns');

  boundary.dropBookingSessionMemory(durableSession);
  const alternatives = await turn(durableSession, 'telegram', '2', durableConfig);
  assert.equal(alternatives.pending?.language, 'de');
  assert.match(alternatives.replies[0], /Leider ist 14:00 Uhr nicht verfügbar/u);
  assert.doesNotMatch(alternatives.replies[0], /\bSorry\b|Which one suits/iu);

  const selectedAlternative = await turn(durableSession, 'telegram', '12:00 Uhr passt gut.', durableConfig);
  assert.equal(selectedAlternative.pending?.language, 'de');
  assert.doesNotMatch(selectedAlternative.replies[0], /\b(?:Yes|Of course|Would you like)\b/iu);
  if (selectedAlternative.pending?.status !== 'awaiting_contact') {
    const authorized = await turn(durableSession, 'telegram', 'Ja, bitte buchen Sie diesen Termin.', durableConfig);
    assert.equal(authorized.pending?.language, 'de');
    assert.equal(authorized.pending?.status, 'awaiting_contact');
    assert.match(authorized.replies[0], /Namen|Mobilnummer/u);
  }
  const durableCompleted = await turn(durableSession, 'telegram', 'Alex Testsson, 0701234567', durableConfig);
  assert.equal(durableCompleted.pending, null);
  assert.match(durableCompleted.replies[0], /Termin|gebucht/u);
  assert.doesNotMatch(durableCompleted.replies[0], /\b(?:appointment|booked|Perfect)\b/iu);

  const requiredTraceStages = [
    'date_conflict_persisted', 'date_conflict_resolved', 'availability_resumed',
    'availability_presentation', 'slot_selected', 'missing_details_presentation',
    'verified_confirmation_presentation', 'final_reply_guard',
  ];
  for (const stage of requiredTraceStages) {
    const matching = durableTrace.filter(event => event.stage === stage);
    assert.ok(matching.length > 0, `language trace includes ${stage}; got ${JSON.stringify(durableTrace)}`);
    for (const event of matching) {
      assert.equal(event.pendingLanguage ?? 'de', 'de', `${stage}: pending language`);
      assert.equal(event.presentationLanguage ?? 'de', 'de', `${stage}: presentation language`);
      assert.notEqual(event.currentLanguage, 'en', `${stage}: no English fallback`);
    }
  }

  // The same durable transition is structural across every supported language and
  // cannot inherit the preceding conversation language after instance turnover.
  const sequentialPairs = [
    ['ar', 'sv'], ['en', 'de'], ['fa', 'es'],
    ['de', 'ar'], ['sv', 'en'], ['es', 'fa'],
  ] as const;
  for (const [previousLanguage, activeLanguage] of sequentialPairs) {
    const store = new FakePendingStore();
    configure({ supabaseClient: store as any });
    events.set(`blocked-${previousLanguage}-${activeLanguage}`, {
      id: `blocked-${previousLanguage}-${activeLanguage}`, status: 'confirmed',
      start: { dateTime: '2026-10-13T13:00:00+02:00' },
      end: { dateTime: '2026-10-13T15:00:00+02:00' },
    });
    const config = business(`durable-${previousLanguage}-${activeLanguage}`);
    const sessionId = `durable-${previousLanguage}-${activeLanguage}`;
    await turn(sessionId, 'telegram', contradictoryDate[previousLanguage], config);
    const switchedConflict = await turn(sessionId, 'telegram', contradictoryDate[activeLanguage], config);
    assert.equal(switchedConflict.pending?.language, activeLanguage);
    assert.equal(JSON.parse(store.rows[0].ai_summary || '{}').language, activeLanguage,
      `${previousLanguage}->${activeLanguage}: switched language persisted`);
    boundary.dropBookingSessionMemory(sessionId);
    const resumed = await turn(sessionId, 'telegram', '2', config);
    assert.equal(resumed.pending?.language, activeLanguage,
      `${previousLanguage}->${activeLanguage}: choice inherits durable language`);
    assert.match(resumed.replies[0], localized[activeLanguage].marker);
  }

  // Exact production regression: the date-conflict sub-state and numeric choice must
  // preserve German into the later exact-slot acknowledgement.
  configure();
  const germanConfig = business('german-real-repro');
  const germanSession = 'german-real-repro';
  const germanTurns = [
    'Ich möchte Dienstag den 15. Oktober 2026 um 14:00 buchen',
    'Ich meinte Dienstag den 15. Oktober 2026',
    '2',
    '13:00 Uhr',
    'Ja, bitte buchen Sie diese Zeit.',
  ];
  const germanResults = [];
  for (const message of germanTurns) germanResults.push(await turn(germanSession, 'telegram', message, germanConfig));
  for (const result of germanResults) {
    assert.equal(result.pending?.language, 'de');
    assert.match(result.replies[0], localized.de.marker);
    assert.doesNotMatch(result.replies[0], /\b(?:Yes|available|Would you like|mobile number)\b/iu);
  }
  assert.match(germanResults[3].replies[0], /13:00 Uhr/u);
  assert.equal(germanResults[3].pending?.dateTime, '2026-10-13T13:00:00+02:00');
  assert.equal(germanResults[4].pending?.status, 'awaiting_contact');
  assert.equal(calendarWrites, 0);
  assert.equal(databaseWrites, 0);
  const germanCompleted = await turn(
    germanSession,
    'telegram',
    'Mein Name ist Alex Test und meine Nummer ist 0701234567.',
    germanConfig,
  );
  assert.equal(germanCompleted.pending, null);
  assert.match(germanCompleted.replies[0], localized.de.marker);
  assert.doesNotMatch(germanCompleted.replies[0], /\b(?:Perfect|booked|appointment)\b/iu);
  assert.equal(calendarWrites, 1, 'verified booking performs exactly one calendar write');
  assert.equal(databaseWrites, 1, 'verified booking performs exactly one database write');

  // Recreate the underlying contamination directly. The active pending booking is
  // authoritative; an older flow lock must be replaced before deterministic rendering.
  for (const [language, copy] of Object.entries(localized) as Array<[keyof typeof localized, typeof localized[keyof typeof localized]]>) {
    configure();
    const config = business(`stale-lock-${language}`);
    const sessionId = `stale-lock-${language}`;
    seedSelection(sessionId, 'telegram', language, config);
    boundary.seedFlowLanguage(sessionId, language === 'en' ? 'sv' : 'en');
    const selected = await turn(sessionId, 'telegram', copy.selection, config);
    assert.equal(selected.pending?.language, language, `${language}: active booking language wins`);
    assert.equal(boundary.conversationState(sessionId).language, language, `${language}: canonical lock repaired`);
    assert.match(selected.replies[0], copy.marker, `${language}: selected-slot acknowledgement localized`);
    assert.equal(selected.pending?.selectedDate, '2026-10-13');
    assert.match(selected.pending?.dateTime || '', language === 'ar' ? /T14:00:00/ : /T13:00:00/);
    assert.equal(selected.replies[0].includes('😊'), false, `${language}: Tone emoji=none remains enforced`);

    const missing = await turn(sessionId, 'telegram', copy.confirmation, config);
    assert.equal(missing.pending?.language, language);
    assert.equal(missing.pending?.status, 'awaiting_contact');
    assert.match(missing.replies[0], copy.marker, `${language}: missing-details request localized`);
    assert.equal(calendarWrites, 0, `${language}: confirmation without contact cannot write calendar`);
    assert.equal(databaseWrites, 0, `${language}: confirmation without contact cannot write database`);

    const completed = await turn(
      sessionId,
      'telegram',
      'Alex Test 0701234567',
      config,
    );
    assert.equal(completed.pending, null, `${language}: verified booking completes`);
    assert.match(completed.replies[0], copy.marker, `${language}: verified confirmation localized`);
    assert.equal(calendarWrites, 1, `${language}: exactly one authorized calendar write`);
    assert.equal(databaseWrites, 1, `${language}: exactly one verified database write`);
  }

  // The shared engine, not a Telegram wrapper, owns this behavior.
  for (const platform of platforms) {
    configure();
    const config = business(`channel-${platform}`);
    const sessionId = `channel-${platform}`;
    seedSelection(sessionId, platform, 'de', config);
    boundary.seedFlowLanguage(sessionId, 'en');
    const selected = await turn(sessionId, platform, '13:00 Uhr', config);
    assert.equal(selected.pending?.language, 'de', platform);
    assert.match(selected.replies[0], localized.de.marker, platform);
    assert.doesNotMatch(selected.replies[0], /\bYes\b|Would you like/iu, platform);
  }

  // A completed booking is historical context, not the language authority for the
  // next logical booking in the same physical channel conversation. The temporary
  // date-conflict shell is cleared before availability resumes, so this specifically
  // guards against the completed language resurfacing during that transition.
  configure();
  const sequentialConversationConfig = business('same-chat-de-then-sv');
  const sequentialConversationSession = 'same-chat-de-then-sv';
  seedSelection(sequentialConversationSession, 'telegram', 'de', sequentialConversationConfig);
  await turn(sequentialConversationSession, 'telegram', localized.de.selection, sequentialConversationConfig);
  await turn(sequentialConversationSession, 'telegram', localized.de.confirmation, sequentialConversationConfig);
  const firstConversationCompleted = await turn(
    sequentialConversationSession, 'telegram', 'Alex Test 0701234567', sequentialConversationConfig,
  );
  assert.equal(firstConversationCompleted.pending, null);
  assert.match(firstConversationCompleted.replies[0], localized.de.marker);

  const swedishConflict = await turn(
    sequentialConversationSession, 'telegram', contradictoryDate.sv, sequentialConversationConfig,
  );
  assert.match(swedishConflict.replies[0], /Menar du/u);
  const repeatedSwedishConflict = await turn(
    sequentialConversationSession, 'telegram', contradictoryDate.sv, sequentialConversationConfig,
  );
  assert.match(repeatedSwedishConflict.replies[0], /Svara 1/u);
  const swedishAvailabilityAfterGermanCompletion = await turn(
    sequentialConversationSession, 'telegram', '2', sequentialConversationConfig,
  );
  assert.equal(swedishAvailabilityAfterGermanCompletion.pending?.language, 'sv');
  assert.match(swedishAvailabilityAfterGermanCompletion.replies[0], localized.sv.marker);
  assert.doesNotMatch(
    swedishAvailabilityAfterGermanCompletion.replies[0],
    /\b(?:Leider|verfügbar|Termin|Buchung|Namen|Mobilnummer)\b/iu,
  );

  // A real customer language change is still allowed; only state transitions are
  // forbidden from changing language independently.
  configure();
  const switchConfig = business('legitimate-switch');
  seedSelection('legitimate-switch', 'telegram', 'de', switchConfig);
  const switched = await turn(
    'legitimate-switch', 'telegram',
    'Hola, quiero reservar una cita el martes 13 de octubre a las 13:00.',
    switchConfig,
  );
  assert.equal(switched.pending?.language, 'es');
  assert.match(switched.replies[0], localized.es.marker);
  assert.doesNotMatch(switched.replies[0], localized.de.marker);

  // Independent session/tenant keys never share the previous conversation's lock.
  configure();
  const englishConfig = business('tenant-english');
  seedSelection('tenant-english', 'telegram', 'en', englishConfig);
  await turn('tenant-english', 'telegram', '13:00', englishConfig);
  const secondConfig = business('tenant-german');
  seedSelection('tenant-german', 'telegram', 'de', secondConfig);
  const independentGerman = await turn('tenant-german', 'telegram', '13:00 Uhr', secondConfig);
  assert.equal(independentGerman.pending?.language, 'de');
  assert.doesNotMatch(independentGerman.replies[0], /\bYes\b|Would you like/iu);

  const swedishConfig = business('tenant-swedish');
  seedSelection('tenant-swedish', 'telegram', 'sv', swedishConfig);
  await turn('tenant-swedish', 'telegram', '13:00', swedishConfig);
  const spanishConfig = business('tenant-spanish');
  seedSelection('tenant-spanish', 'telegram', 'es', spanishConfig);
  const independentSpanish = await turn('tenant-spanish', 'telegram', '13:00', spanishConfig);
  assert.equal(independentSpanish.pending?.language, 'es');
  assert.match(independentSpanish.replies[0], localized.es.marker);

  // Remote regression: pending booking language remains authoritative even when
  // the older flow-language shell is stale and still points to English.
  const staleFlowCases = [
    {
      language: 'sv',
      text: 'Då bokar jag in mig på 13:00 den 13 oktober.',
      marker: /(?:boka|bokningen|namn|mobilnummer|bekräfta)/iu,
    },
    {
      language: 'de',
      text: 'Dann buche ich den Termin am 13. Oktober um 13:00 Uhr.',
      marker: /(?:buchen|Buchung|Namen|Mobilnummer|bestätigen)/iu,
    },
  ] as const;

  for (const platform of platforms) {
    for (const scenario of staleFlowCases) {
      configure();

      const config = business(`stale-flow-${platform}-${scenario.language}`);
      const sessionId = `stale-flow-${platform}-${scenario.language}`;

      seedSelection(sessionId, platform, scenario.language, config);

      boundary.seedFlowLanguage(sessionId, 'en', 'availability');

      const result = await turn(
        sessionId,
        platform,
        scenario.text,
        config,
      );

      assert.equal(
        result.handled,
        true,
        `${platform}/${scenario.language}: selection is handled`,
      );

      assert.equal(
        result.pending?.language,
        scenario.language,
        `${platform}/${scenario.language}: pending language remains authoritative`,
      );

      assert.notEqual(
        result.pending?.status,
        'awaiting_time_selection',
        `${platform}/${scenario.language}: owned slot selection advances`,
      );

      assert.equal(
        boundary.conversationState(sessionId).language,
        scenario.language,
        `${platform}/${scenario.language}: stale flow language is repaired`,
      );

      assert.match(
        result.replies[0],
        scenario.marker,
        `${platform}/${scenario.language}: reply stays localized`,
      );

      assert.doesNotMatch(
        result.replies[0],
        /Which proposed time|Which one suits you|I found these available times/iu,
      );
    }
  }

} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}

console.log('booking language continuity integration regressions passed');
