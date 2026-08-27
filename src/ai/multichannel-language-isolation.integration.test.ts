import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const originalLog = console.log;
const originalError = console.error;
console.log = () => undefined;
console.error = () => undefined;
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-27T09:00:00+02:00');
const platforms = ['telegram', 'instagram', 'whatsapp', 'messenger'] as const;
let eventSequence = 0;
const business = (id: string, language = 'fa') => ({
  id,
  businessRecordId: id,
  businessName: `Clinic ${id}`,
  language,
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Consultation',
  calendarProvider: 'custom',
});

const configure = (getEvents: () => Promise<any[]> = async () => []) => {
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getEvents,
      checkSlots: () => ({ available_slots_string: '' }),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
};

const turn = (platformName: typeof platforms[number], sessionId: string, text: string, businessConfig: any) =>
  boundary.inboundTurn({
    eventId: `${sessionId}:${++eventSequence}`,
    sessionId,
    platformName,
    recipientUserId: `user-${sessionId}`,
    text,
    businessConfig,
    now,
  });

try {
  configure();
  for (const platform of ['instagram', 'whatsapp', 'messenger'] as const) {
    const first = boundary.channelSessionId(platform, 'same-user', business(`${platform}-a`), 'tenant-a');
    const second = boundary.channelSessionId(platform, 'same-user', business(`${platform}-b`), 'tenant-b');
    assert.notEqual(first, second, `${platform}: session identity includes business scope`);
  }

  for (const platform of platforms) {
    configure();
    const config = business(`fresh-${platform}`);
    const result = await turn(platform, `${platform}-fresh-sv`, 'Hej, jag vill boka en tid till i morgon.', config);
    assert.equal(result.handled, true, `${platform}: Swedish booking is handled`);
    assert.equal(result.pending?.language, 'sv', `${platform}: current Swedish overrides Persian business default`);
    assert.match(result.replies[0], /Jag hittade(?: tyvärr inga)? lediga tider|Vilken/u);
    assert.doesNotMatch(result.replies[0], /این زمان‌ها|کدام|I found these available times/iu);
  }

  for (const platform of platforms) {
    let releaseOlderRead!: () => void;
    let markOlderReadStarted!: () => void;
    const olderReadStarted = new Promise<void>((resolve) => { markOlderReadStarted = resolve; });
    const olderReadBlocked = new Promise<void>((resolve) => { releaseOlderRead = resolve; });
    let reads = 0;
    configure(async () => {
      reads += 1;
      if (reads === 1) {
        markOlderReadStarted();
        await olderReadBlocked;
      }
      return [];
    });
    const config = business(`overlap-${platform}`);
    const sessionId = `${platform}-overlap`;
    const older = turn(platform, sessionId, 'سلام، برای فردا وقت مشاوره می‌خوام.', config);
    await olderReadStarted;
    const newer = turn(platform, sessionId, 'Hej, jag vill boka en tid till i morgon.', config);
    releaseOlderRead();
    const [olderResult, newerResult] = await Promise.all([older, newer]);
    assert.deepEqual(olderResult.replies, [], `${platform}: superseded reply is suppressed`);
    assert.equal(newerResult.pending?.language, 'sv', `${platform}: newer Swedish turn owns state`);
    assert.equal(boundary.conversationState(sessionId).language, 'sv');
    assert.match(newerResult.replies[0], /Jag hittade(?: tyvärr inga)? lediga tider|Vilken/u);
  }

  configure();
  const restoredConfig = business('restored-pending', 'en');
  const restoredSession = 'instagram-restored-pending';
  boundary.seedPending(restoredSession, {
    businessConfig: restoredConfig,
    businessId: restoredConfig.id,
    platform: 'instagram',
    userId: restoredSession,
    sessionId: restoredSession,
    operation: 'new_booking',
    status: 'awaiting_time_selection',
    expectedInput: 'slot_selection',
    service: 'Consultation',
    language: 'en',
    selectedDate: '2026-08-28',
    durationMinutes: 60,
    offeredSlots: [],
    ownedOfferedSlots: [],
  });
  boundary.seedFlowLanguage(restoredSession, 'en', 'availability');
  const restored = await turn('instagram', restoredSession, 'Hej, jag vill boka en ny tid till i morgon.', restoredConfig);
  assert.equal(restored.pending?.language, 'sv', 'current Swedish replaces restored English pending language');
  assert.equal(boundary.conversationState(restoredSession).language, 'sv');
  assert.match(restored.replies[0], /Jag hittade(?: tyvärr inga)? lediga tider|Vilken/u);

  originalLog('multichannel language isolation regressions passed');
} finally {
  boundary.reset();
  console.log = originalLog;
  console.error = originalError;
}
