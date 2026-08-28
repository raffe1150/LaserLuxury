import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

let availabilityReads = 0;
let calendarMutations = 0;
const adapter = {
  getEvents: async () => {
    availabilityReads += 1;
    return [];
  },
  checkSlots: () => ({ available_slots_string: '' }),
  insertAppointment: () => { calendarMutations += 1; return { success: true }; },
  updateAppointment: () => { calendarMutations += 1; return { success: true }; },
  cancelAppointment: () => { calendarMutations += 1; return { success: true }; },
};

const businessConfig = {
  id: 'ambiguous-date-business',
  businessRecordId: 'ambiguous-date-business',
  business_id: 'ambiguous-date-business',
  businessName: 'Test Clinic',
  timezone: 'Europe/Stockholm',
  calendarProvider: 'custom',
  defaultBookingService: 'Konsultation',
};
const now = new Date('2026-08-01T12:00:00+02:00');

boundary.reset();
boundary.configure({
  calendarAdapter: adapter,
  postProcess: async () => undefined,
});

try {
  const secondLiveSession = 'tg_ambiguous-second-live-user';
  const secondLiveSentence = 'Hej, jag vill boka en tid tisdag den 21 september 2026 klockan 09:00.';
  const secondLiveResult = await boundary.inboundTurn({
    eventId: 'telegram-update-ambiguous-date-21',
    sessionId: secondLiveSession,
    platformName: 'telegram',
    recipientUserId: 'ambiguous-second-live-user',
    text: secondLiveSentence,
    businessConfig,
    now,
  });
  assert.equal(secondLiveResult.handled, true);
  assert.equal(secondLiveResult.replies.length, 1);
  assert.match(secondLiveResult.replies[0], /måndag\s+21\s+september\s+2026/iu);
  assert.match(secondLiveResult.replies[0], /tisdag\s+22\s+september\s+2026/iu);
  assert.equal(availabilityReads, 0, 'the exact second live sentence must stop before availability');
  assert.equal(secondLiveResult.pending?.status, 'awaiting_date_or_time', 'the conflict stores only a date-clarification shell');
  assert.equal(secondLiveResult.pending?.dateTime, null, 'clarification must not select or hold a slot');
  assert.equal(secondLiveResult.pending?.dateConflictClarification?.attemptCount, 1);
  assert.equal(boundary.conversationState(secondLiveSession).availability, null);

  const sessionId = 'tg_ambiguous-live-user';
  const liveSentence = 'Hej, jag vill boka en tid fredag den 10 september 2026 klockan 09:00.';
  const ambiguous = await boundary.turn({
    sessionId,
    platformName: 'telegram',
    recipientUserId: 'ambiguous-live-user',
    text: liveSentence,
    businessConfig,
    now,
  });

  assert.equal(ambiguous.handled, true);
  assert.equal(ambiguous.replies.length, 1);
  assert.match(ambiguous.replies[0], /torsdag\s+10\s+september\s+2026/iu);
  assert.match(ambiguous.replies[0], /fredag\s+11\s+september\s+2026/iu);
  assert.equal(availabilityReads, 0, 'contradiction must stop before canonical availability');
  assert.equal(ambiguous.pending?.status, 'awaiting_date_or_time');
  assert.equal(ambiguous.pending?.dateTime, null, 'contradiction must not create a slot hold');
  assert.equal(ambiguous.pending?.dateConflictClarification?.attemptCount, 1);
  assert.equal(boundary.conversationState(sessionId).availability, null);
  assert.equal(calendarMutations, 0);

  const clarifiedThursday = await boundary.turn({
    sessionId,
    platformName: 'telegram',
    recipientUserId: 'ambiguous-live-user',
    text: 'Jag menar torsdag den 10 september 2026 klockan 09:00.',
    businessConfig,
    now,
  });
  assert.equal(availabilityReads, 1, 'clarified date resumes canonical availability exactly once');
  assert.equal(clarifiedThursday.pending?.selectedDate, '2026-09-10');
  assert.match(String(clarifiedThursday.pending?.dateTime || ''), /^2026-09-10T09:00:00/);
  assert.equal(clarifiedThursday.pending?.status, 'awaiting_confirmation');

  boundary.reset();
  boundary.configure({ calendarAdapter: adapter, postProcess: async () => undefined });
  availabilityReads = 0;
  const fridaySession = 'tg_ambiguous-friday-user';
  await boundary.turn({
    sessionId: fridaySession,
    platformName: 'telegram',
    recipientUserId: 'ambiguous-friday-user',
    text: liveSentence,
    businessConfig,
    now,
  });
  const clarifiedFriday = await boundary.turn({
    sessionId: fridaySession,
    platformName: 'telegram',
    recipientUserId: 'ambiguous-friday-user',
    text: 'Jag menar fredag den 11 september 2026 klockan 09:00.',
    businessConfig,
    now,
  });
  assert.equal(availabilityReads, 1);
  assert.equal(clarifiedFriday.pending?.selectedDate, '2026-09-11');
  assert.match(String(clarifiedFriday.pending?.dateTime || ''), /^2026-09-11T09:00:00/);
  assert.equal(calendarMutations, 0);
} finally {
  boundary.reset();
}

console.log('ambiguous weekday and explicit date integration tests passed');
