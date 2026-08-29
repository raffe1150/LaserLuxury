import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const now = new Date('2026-08-27T09:00:00+02:00');
let reads = 0;
let eventSequence = 0;
boundary.reset();
boundary.configure({
  calendarAdapter: {
    getCalendarId: () => 'language-isolation@example.com',
    getEvents: async () => { reads += 1; return []; },
    checkSlots: async () => { throw new Error('legacy availability path must not run'); },
  },
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
} as any);

const businessConfig = {
  id: 'language-business',
  businessName: 'Language Clinic',
  language: 'fa',
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Konsultation',
  calendarProvider: 'google',
  googleCalendarId: 'language-isolation@example.com',
  workingHours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((day) => [day, [{ start: '09:00', end: '17:00' }]])
  ),
};
const platforms = ['telegram', 'instagram', 'whatsapp', 'messenger'] as const;

function turn(platformName: typeof platforms[number], sessionId: string, text: string, config: any = businessConfig) {
  return boundary.inboundTurn({
    eventId: `${sessionId}:${++eventSequence}`,
    sessionId,
    platformName,
    recipientUserId: `user-${sessionId}`,
    text,
    businessConfig: config,
    now,
  });
}

for (const platform of platforms) {
  const clean = await turn(platform, `${platform}-clean-sv`, 'Hej, jag vill boka en tid till i morgon.');
  assert.equal(clean.handled, true, `${platform}: clean Swedish booking is shared-engine handled`);
  assert.equal(clean.pending?.language, 'sv', `${platform}: business Persian default cannot override Swedish`);
  assert.match(clean.replies[0], /Jag hittade lediga tider|Vilken/u, `${platform}: Swedish localized availability`);
  assert.doesNotMatch(clean.replies[0], /این زمان‌ها|کدام/u);

  const sharedIdentity = `${platform}-same-physical-user`;
  const persian = await turn(platform, sharedIdentity, 'سلام، برای مشاوره وقت می‌خوام.');
  assert.equal(persian.pending?.language, 'fa', `${platform}: Persian remains Persian`);
  assert.match(persian.replies[0], /این زمان‌ها|کدام/u);

  const switchedByMessage = await turn(platform, sharedIdentity, 'Hej, jag vill boka en tid till i morgon.');
  assert.equal(switchedByMessage.pending?.language, 'sv', `${platform}: strong new Swedish message replaces stale Persian flow language`);
  assert.match(switchedByMessage.replies[0], /Jag hittade lediga tider|Vilken/u);
  assert.doesNotMatch(switchedByMessage.replies[0], /این زمان‌ها|کدام/u);

  const followUp = await turn(platform, sharedIdentity, 'Vilken tid är tidigast?');
  assert.equal(followUp.pending?.language, 'sv', `${platform}: Swedish multi-turn lock remains Swedish`);
  assert.doesNotMatch(followUp.replies.join(' '), /این زمان‌ها|کدام/u);

  const explicitPersian = await turn(platform, sharedIdentity, 'لطفاً به فارسی پاسخ بده');
  assert.equal(explicitPersian.pending?.language, 'fa', `${platform}: explicit language switch updates active flow`);
}

for (const platform of ['instagram', 'whatsapp', 'messenger'] as const) {
  const firstBusiness = { ...businessConfig, id: `${platform}-business-a` };
  const secondBusiness = { ...businessConfig, id: `${platform}-business-b` };
  const firstSession = boundary.channelSessionId(platform, 'same-physical-user', firstBusiness, 'tenant-a');
  const secondSession = boundary.channelSessionId(platform, 'same-physical-user', secondBusiness, 'tenant-b');
  assert.notEqual(firstSession, secondSession, `${platform}: session identity includes the business boundary`);
}

for (const platform of platforms) {
  const physicalUser = `${platform}-cross-business-physical-user`;
  const persianBusiness = { ...businessConfig, id: `${platform}-persian-business`, language: 'sv' };
  const englishBusiness = { ...businessConfig, id: `${platform}-english-business`, language: 'fa' };
  const persianSession = platform === 'telegram'
    ? `tg:${persianBusiness.id}:token-a:${physicalUser}`
    : boundary.channelSessionId(platform, physicalUser, persianBusiness, `${platform}-tenant-a`);
  const englishSession = platform === 'telegram'
    ? `tg:${englishBusiness.id}:token-b:${physicalUser}`
    : boundary.channelSessionId(platform, physicalUser, englishBusiness, `${platform}-tenant-b`);

  const persian = await turn(platform, persianSession, 'سلام، برای فردا وقت مشاوره می‌خوام.', persianBusiness);
  assert.equal(persian.pending?.language, 'fa');
  const english = await turn(platform, englishSession, 'Hello, I want to book an appointment for tomorrow.', englishBusiness);
  assert.equal(english.pending?.language, 'en', `${platform}: second business does not inherit Persian`);
  assert.match(english.replies[0], /I found these available times|The following times are available|Current availability includes|Sorry, I couldn’t find/u);
  assert.doesNotMatch(english.replies[0], /این زمان‌ها|متأسفانه/u);
  assert.notEqual(english.pending?.selectedDate, undefined);

  const persianState = boundary.conversationState(persianSession);
  const englishState = boundary.conversationState(englishSession);
  assert.equal(persianState.pending?.language, 'fa', `${platform}: first business retains its independent pending flow`);
  assert.equal(englishState.pending?.language, 'en');
  assert.equal(persianState.availability?.businessId, persianBusiness.id);
  assert.equal(englishState.availability?.businessId, englishBusiness.id);
  assert.notDeepEqual(persianState.pending?.ownedOfferedSlots, englishState.pending?.ownedOfferedSlots, `${platform}: businesses do not share owned slots`);
}

for (const platform of platforms) {
  let releaseOlderRead!: () => void;
  let markOlderReadStarted!: () => void;
  const olderReadStarted = new Promise<void>((resolve) => { markOlderReadStarted = resolve; });
  const olderReadBlocked = new Promise<void>((resolve) => { releaseOlderRead = resolve; });
  let overlappingReads = 0;
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'language-isolation@example.com',
      getEvents: async () => {
        overlappingReads += 1;
        if (overlappingReads === 1) {
          markOlderReadStarted();
          await olderReadBlocked;
        }
        return [];
      },
      checkSlots: async () => { throw new Error('legacy availability path must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);

  const overlappingSession = `${platform}-overlapping-same-physical-user`;
  const olderPersianTurn = turn(platform, overlappingSession, 'سلام، برای مشاوره وقت می‌خوام.');
  await olderReadStarted;
  const newerSwedishTurn = turn(platform, overlappingSession, 'Hej, jag vill boka en tid till i morgon.');
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseOlderRead();
  const [completedOlderTurn, completedNewerTurn] = await Promise.all([olderPersianTurn, newerSwedishTurn]);
  assert.deepEqual(completedOlderTurn.replies, [], `${platform}: reply from superseded Persian turn is suppressed`);
  assert.equal(completedNewerTurn.pending?.language, 'sv', `${platform}: newer Swedish turn owns final flow state`);
  assert.equal(boundary.conversationState(overlappingSession).language, 'sv', `${platform}: newer Swedish turn owns persisted conversation language`);
  assert.match(completedNewerTurn.replies[0], /Jag hittade lediga tider|Vilken/u);

  const weakSwedishFollowUp = await turn(platform, overlappingSession, '09:00');
  assert.equal(weakSwedishFollowUp.pending?.language, 'sv', `${platform}: an older Persian turn cannot overwrite the newer Swedish flow`);
  assert.doesNotMatch(weakSwedishFollowUp.replies.join(' '), /این زمان‌ها|کدام/u);
}

boundary.configure({
  calendarAdapter: {
    getCalendarId: () => 'language-isolation@example.com',
    getEvents: async (startDate: string) => [{
      id: `blocked-${startDate}`,
      start: { dateTime: `${startDate}T00:00:00+02:00` },
      end: { dateTime: `${startDate}T23:59:59+02:00` },
    }],
    checkSlots: async () => { throw new Error('legacy availability path must not run'); },
  },
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
} as any);

const noAvailabilityCases = {
  sv: { text: 'Hej, jag vill boka en tid till i morgon.', expected: /Jag hittade tyvärr inga lediga tider/u, rejected: /متأسفانه|Sorry/u },
  en: { text: 'Hello, I want to book an appointment for tomorrow.', expected: /Sorry, I couldn’t find any available times/u, rejected: /Jag hittade tyvärr|متأسفانه/u },
  fa: { text: 'سلام، می‌خواهم برای فردا وقت رزرو کنم.', expected: /متأسفانه برای این بازه زمان خالی پیدا نکردم/u, rejected: /Jag hittade tyvärr|Sorry/u },
} as const;

for (const platform of platforms) {
  for (const [language, scenario] of Object.entries(noAvailabilityCases)) {
    const config = { ...businessConfig, id: `no-availability-${platform}-${language}`, language: language === 'fa' ? 'sv' : 'fa' };
    const physicalUser = `no-availability-user-${language}`;
    const sessionId = platform === 'telegram'
      ? `tg:${config.id}:test-token:${physicalUser}`
      : boundary.channelSessionId(platform, physicalUser, config, `${platform}-tenant`);
    const result = await turn(platform, sessionId, scenario.text, config);
    assert.equal(result.pending?.language, language, `${platform}/${language}: no-availability state keeps current language`);
    assert.match(result.replies[0], scenario.expected, `${platform}/${language}: no-availability reply is localized`);
    assert.doesNotMatch(result.replies[0], scenario.rejected);
  }
}

// Restart semantics: a same-business English pending booking may be restored from
// persistence after process caches are empty. A clearly Persian new booking starts a
// new logical conversation and must not inherit that pending language or exact time.
for (const platform of platforms) {
  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'language-isolation@example.com',
      getEvents: async () => [],
      checkSlots: async () => { throw new Error('legacy availability path must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  const config = { ...businessConfig, id: `restart-${platform}`, language: 'en' };
  const physicalUser = `${platform}-restart-user`;
  const sessionId = platform === 'telegram'
    ? `tg:${config.id}:restart-token:${physicalUser}`
    : boundary.channelSessionId(platform, physicalUser, config, `${platform}-restart-tenant`);
  const english = await turn(platform, sessionId, 'Hello, I want to book an appointment tomorrow at 14:00.', config);
  assert.equal(english.pending?.language, 'en');
  assert.equal(english.pending?.status, 'awaiting_confirmation');
  const persistedEnglishPending = structuredClone(english.pending);

  boundary.reset();
  boundary.configure({
    calendarAdapter: {
      getCalendarId: () => 'language-isolation@example.com',
      getEvents: async () => [],
      checkSlots: async () => { throw new Error('legacy availability path must not run'); },
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
  } as any);
  boundary.seedPending(sessionId, persistedEnglishPending);
  boundary.seedFlowLanguage(sessionId, 'en', 'availability');
  const persian = await turn(platform, sessionId, 'سلام، می‌خواهم برای فردا وقت رزرو کنم.', config);
  assert.equal(persian.pending?.language, 'fa', `${platform}: restored English pending cannot override current Persian turn`);
  assert.equal(persian.pending?.status, 'awaiting_time_selection');
  assert.match(persian.replies[0], /این زمان‌ها خالی هستند|زمان‌های زیر خالی هستند|در حال حاضر این زمان‌ها خالی هستند/u);
  assert.doesNotMatch(persian.replies[0], /Yes,|I found these available times/u);

  if (platform !== 'telegram') {
    const legacySession = `${platform === 'whatsapp' ? 'wa_' : platform === 'instagram' ? 'ig_' : 'ms_'}${physicalUser}`;
    boundary.reset();
    boundary.configure({
      calendarAdapter: {
        getCalendarId: () => 'language-isolation@example.com',
        getEvents: async () => [],
        checkSlots: async () => { throw new Error('legacy availability path must not run'); },
      },
      postProcess: async () => undefined,
      incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    } as any);
    boundary.seedPending(legacySession, persistedEnglishPending);
    const isolated = await turn(platform, sessionId, 'سلام، می‌خواهم برای فردا وقت رزرو کنم.', config);
    assert.equal(isolated.pending?.language, 'fa', `${platform}: legacy unscoped state is not read through scoped identity`);
  }
}

assert.ok(reads > 0);
console.log('multichannel language isolation regressions passed');
