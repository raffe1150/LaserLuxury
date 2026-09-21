import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.STRUCTURED_UNDERSTANDING_ENABLED = 'false';
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-09-06T12:00:00+02:00');
const tomorrow = '2026-09-07';
const businessConfig = {
  id: 'arabic-instagram-routing', businessRecordId: 'arabic-instagram-routing',
  businessName: 'Booking Studio', language: 'sv', timezone: 'Europe/Stockholm',
  calendarProvider: 'custom', googleCalendarId: 'routing-calendar',
  services: [
    { name: 'Video Consultation', duration: 30 },
    { name: 'test', duration: 30 },
    { name: 'video for tiktok', duration: 30 },
  ],
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map(day => [day, [{ start: '09:00', end: '17:00' }]]),
  ),
};

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


const scenarios = [
  { language: 'ar', text: 'مرحباً، أريد حجز موعد للغد.', requested: null, marker: /خدمة/u },
  { language: 'ar', text: 'أريد حجز تصوير زفاف للغد.', requested: 'تصوير زفاف', marker: /لا أستطيع مطابقة/u },
  { language: 'ar', text: 'مرحباً، أريد حجز موعد للغد.', requested: null, marker: /خدمة/u, intermediate: 'أريد حجز تصوير زفاف للغد.' },
  { language: 'fa', text: 'سلام، می‌خواهم برای فردا وقت رزرو کنم.', requested: null, marker: /سرویس/u },
  { language: 'fa', text: 'می‌خواهم برای فردا عکاسی عروسی رزرو کنم.', requested: 'عکاسی عروسی', marker: /نمی‌توانم/u },
  { language: 'en', text: 'Hello, I want to book an appointment for tomorrow.', requested: null, marker: /Which service/u },
  { language: 'en', text: 'I want to book Wedding Photography for tomorrow.', requested: 'Wedding Photography', marker: /cannot match/u },
] as const;

try {
  for (const reload of [false, true]) {
    for (const scenario of scenarios) {
      boundary.reset();
      const store = new FakePendingStore();
      const reads: Array<{ start: string; end: string }> = [];
      boundary.configure({
        supabaseClient: store as any,
        structuredUnderstandingAdoptionRuntime: null,
        calendarAdapter: {
          getCalendarId: () => 'routing-calendar',
          getEvents: async (start: string, end: string) => { reads.push({ start, end }); return []; },
          checkSlots: async () => { throw new Error('legacy availability must not run'); },
        },
        postProcess: async () => undefined,
        incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
      } as any);
      const sessionId = boundary.channelSessionId('instagram', 'routing-user', businessConfig, 'routing-page');
      const turn = async (text: string) => {
        // Match Instagram's pre-dispatch language resolution and final send guard.
        boundary.resolveConversationLanguage(sessionId, text, businessConfig);
        const result = await boundary.turn({
          sessionId, platformName: 'instagram', recipientUserId: 'routing-user',
          text, businessConfig, now, shadowEligibleCustomerTurn: true,
        });
        const outbound = result.replies.map(reply =>
          boundary.instagramOutboundText('routing-user', reply, 'conversation', sessionId),
        );
        assert.deepEqual(outbound, result.replies, 'Instagram must preserve the booking reply');
        assert.doesNotMatch(outbound.join(' '), /ماذا تريد أن تعرف|What would you like to know/u);
        return result;
      };
      const first = await turn(scenario.text);
      assert.equal(first.handled, true, scenario.text);
      assert.equal(first.pending?.status, 'awaiting_service', scenario.text);
      assert.equal(first.pending?.service, 'Bokning');
      assert.equal(first.pending?.requestedService, scenario.requested);
      assert.equal(first.pending?.language, scenario.language);
      assert.equal(first.pending?.selectedDate, tomorrow);
      assert.equal(first.pending?.normalizedBookingRequest?.date?.value, tomorrow);
      assert.equal(first.pending?.normalizedBookingRequest?.date?.relative, 'tomorrow');
      assert.equal(reads.length, 0, 'service resolution must precede availability');
      assert.deepEqual(first.pending?.offeredSlots, []);
      assert.match(first.replies.join(' '), scenario.marker);
      if (scenario.requested) {
        for (const service of businessConfig.services) assert.ok(first.replies.join(' ').includes(service.name));
      }
      if ('intermediate' in scenario) {
        const unsupported = await turn(scenario.intermediate);
        assert.equal(unsupported.pending?.status, 'awaiting_service');
        assert.equal(unsupported.pending?.requestedService, 'تصوير زفاف');
        assert.equal(unsupported.pending?.selectedDate, tomorrow);
        assert.equal(unsupported.pending?.service, 'Bokning');
        assert.match(unsupported.replies.join(' '), /لا أستطيع مطابقة/u);
        assert.equal(reads.length, 0);
      }
      const persisted = JSON.parse(store.rows[0].ai_summary || '{}');
      assert.equal(persisted.status, 'awaiting_service');
      assert.equal(persisted.selectedDate, tomorrow);
      assert.equal(persisted.language, scenario.language);
      if (reload) boundary.dropBookingSessionMemory(sessionId);

      const selected = await turn('test');
      assert.equal(selected.handled, true);
      assert.equal(selected.pending?.service, 'test');
      assert.equal(selected.pending?.serviceResolution, 'authoritative');
      assert.equal(selected.pending?.status, 'awaiting_time_selection');
      assert.equal(selected.pending?.language, scenario.language);
      assert.equal(selected.pending?.selectedDate, tomorrow);
      assert.equal(selected.pending?.normalizedBookingRequest?.date?.value, tomorrow);
      assert.deepEqual(reads, [{ start: tomorrow, end: tomorrow }]);
      assert.ok(selected.pending?.ownedOfferedSlots?.length > 0);
      for (const slot of selected.pending.ownedOfferedSlots) {
        assert.equal(slot.service, 'test');
        assert.equal(slot.platform, 'instagram');
        assert.equal(slot.userId, 'routing-user');
        assert.equal(slot.searchStartDate, tomorrow);
        assert.equal(slot.searchEndDate, tomorrow);
      }
    }
  }

  // Reproduce the production Instagram sequence and its delivery timing. A later
  // accepted customer turn may queue while availability is still being built,
  // but it must not suppress the deterministic reply of the turn ahead of it.
  boundary.reset();
  const liveStore = new FakePendingStore();
  let releaseAvailability!: () => void;
  let markAvailabilityEntered!: () => void;
  const availabilityGate = new Promise<void>(resolve => { releaseAvailability = resolve; });
  const availabilityEntered = new Promise<void>(resolve => { markAvailabilityEntered = resolve; });
  let holdFirstAvailabilityRead = true;
  const liveConfig = {
    ...businessConfig,
    id: '3',
    businessRecordId: '3',
    services: [
      { name: 'test', duration: 15 },
      { name: 'Video Consultation', duration: 30 },
    ],
    workingHours: Object.fromEntries(
      ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        .map(day => [day, [{ start: '15:00', end: '16:00' }]]),
    ),
  };
  boundary.configure({
    supabaseClient: liveStore as any,
    structuredUnderstandingAdoptionRuntime: null,
    calendarAdapter: {
      getCalendarId: () => 'routing-calendar',
      getEvents: async () => {
        if (holdFirstAvailabilityRead) {
          holdFirstAvailabilityRead = false;
          markAvailabilityEntered();
          await availabilityGate;
        }
        return [];
      },
      checkSlots: async () => { throw new Error('legacy availability must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  const liveSessionId = boundary.channelSessionId(
    'instagram', 'live-routing-user', liveConfig, 'live-routing-page',
  );
  const liveTurn = async (text: string) => {
    boundary.resolveConversationLanguage(liveSessionId, text, liveConfig);
    const result = await boundary.turn({
      sessionId: liveSessionId,
      platformName: 'instagram',
      recipientUserId: 'live-routing-user',
      text,
      businessConfig: liveConfig,
      now: new Date('2026-09-21T12:00:00+02:00'),
      shadowEligibleCustomerTurn: true,
    });
    const outbound = result.replies.map(reply =>
      boundary.instagramOutboundText('live-routing-user', reply, 'conversation', liveSessionId),
    );
    assert.deepEqual(outbound, result.replies, 'Instagram must preserve each serialized booking reply');
    return result;
  };

  const initial = await liveTurn('مرحباً، أريد حجز موعد بتاريخ الجمعة، 25 سبتمبر 2026.');
  assert.equal(initial.pending?.status, 'awaiting_service');
  assert.equal(initial.pending?.selectedDate, '2026-09-25');
  assert.match(initial.replies.join(' '), /خدمة/u);

  const unsupported = await liveTurn('أريد حجز تصوير زفاف بتاريخ الجمعة، 25 سبتمبر 2026.');
  assert.equal(unsupported.pending?.status, 'awaiting_service');
  assert.equal(unsupported.pending?.requestedService, 'تصوير زفاف');
  assert.equal(unsupported.pending?.selectedDate, '2026-09-25');
  assert.match(unsupported.replies.join(' '), /لا أستطيع مطابقة/u);
  assert.match(unsupported.replies.join(' '), /test/u);

  // Force durable restoration and queue the exact slot selection while the
  // supported-service turn is still producing its availability response.
  boundary.dropBookingSessionMemory(liveSessionId);
  const supportedPromise = liveTurn('test');
  await Promise.race([
    availabilityEntered,
    supportedPromise.then(result => {
      throw new Error(`supported-service turn skipped availability: ${JSON.stringify(result.pending)}`);
    }),
  ]);
  const slotPromise = liveTurn('الساعة 15:00 تناسبني. يرجى اختيار هذا الوقت. وبالمناسبة، قال لي أحدهم اليوم "hej".');
  releaseAvailability();
  const supported = await supportedPromise;
  const slot = await slotPromise;

  assert.equal(supported.replies.length, 1, 'queued slot selection must not suppress availability delivery');
  assert.match(supported.replies[0], /15:00/u);
  assert.equal(slot.handled, true);
  assert.equal(slot.pending?.status, 'awaiting_confirmation');
  assert.equal(slot.pending?.selectedDate, '2026-09-25');
  assert.match(String(slot.pending?.dateTime), /^2026-09-25T15:00/u);
  assert.equal(slot.pending?.language, 'ar');
  assert.equal(slot.replies.length, 1);
  assert.match(slot.replies[0], /15:00/u);
  assert.doesNotMatch(slot.replies[0], /15:15|15:30/u);

  originalLog('Arabic Instagram routing regressions passed: 14 generic/unsupported flows plus the exact live serialized sequence (AR/FA/EN)');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
