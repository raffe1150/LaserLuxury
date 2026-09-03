import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

let availabilityReads = 0;
const adapter = {
  getCalendarId: () => 'admotion.studio1@gmail.com',
  getEvents: async () => { availabilityReads += 1; return []; },
  checkSlots: async () => { throw new Error('legacy checkSlots path must not run'); },
};

boundary.reset();
boundary.configure({
  calendarAdapter: adapter,
  postProcess: async () => undefined,
  incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
} as any);

const businessConfig = {
  id: '3',
  businessName: 'admotion studio',
  timezone: 'Europe/Stockholm',
  defaultBookingService: 'Konsultation',
  calendarProvider: 'google',
  googleCalendarId: 'admotion.studio1@gmail.com',
};
const sessionId = 'tg:3:test-token-fingerprint:900001';
const recipientUserId = '900001';
const turn = (eventId: string, text: string) => boundary.inboundTurn({
  eventId,
  sessionId,
  platformName: 'telegram',
  recipientUserId,
  text,
  businessConfig,
});

const first = await turn('persian-live-1', 'سلام، می‌خوام برای مشاوره امنیتی وقت بگیرم.');
assert.equal(first.handled, true, 'Persian booking request must not fall through to legacy Gemini tools');
assert.equal(availabilityReads, 1, 'one canonical calendar snapshot is loaded');
assert.equal(first.pending?.status, 'awaiting_time_selection');
assert.equal(first.pending?.ownedOfferedSlots.length, 3, 'empty calendar returns canonical top three');
assert.equal(first.replies.length, 1);
assert.match(first.replies[0], /(?:این زمان‌ها|زمان‌های زیر) خالی هستند/u);
assert.doesNotMatch(first.replies[0], /ساعت 11:00 خالی است/u);

const firstFingerprint = first.pending.lastAvailabilityConstraintKey;
const readsBeforeAmbiguousConfirmation = availabilityReads;
const ambiguous = await turn('persian-live-2', 'بله، لطفاً برای همین زمان رزرو کنید.');
assert.equal(ambiguous.pending?.status, 'awaiting_time_selection');
assert.equal(ambiguous.pending?.dateTime, null);
assert.equal(ambiguous.pending?.ownedOfferedSlots.length, 3);
assert.equal(ambiguous.pending?.lastAvailabilityConstraintKey, firstFingerprint);
assert.equal(availabilityReads, readsBeforeAmbiguousConfirmation, 'ambiguous confirmation does not rerun availability');
assert.equal(ambiguous.replies.length, 1);
assert.match(ambiguous.replies[0], /کدام|زمان/u);
assert.doesNotMatch(ambiguous.replies[0], /ساعت 11:00 خالی است/u);

const exactSessionId = 'tg:3:test-token-fingerprint:900002';
const exactTurn = (eventId: string, text: string) => boundary.inboundTurn({
  eventId,
  sessionId: exactSessionId,
  platformName: 'telegram',
  recipientUserId: '900002',
  text,
  businessConfig,
});
const exact = await exactTurn('persian-exact-1', 'سلام، برای مشاوره امنیتی جمعه ساعت 14 وقت می خوام.');
assert.equal(exact.pending?.status, 'awaiting_confirmation');
assert.equal(exact.pending?.ownedOfferedSlots.length, 1);
const selectedStart = exact.pending.dateTime;
const fingerprint = exact.pending.lastAvailabilityConstraintKey;
const readsBeforeConfirmation = availabilityReads;

const confirmed = await exactTurn('persian-exact-2', 'بله، لطفاً برای همین زمان رزرو کنید.');
assert.equal(confirmed.pending?.status, 'awaiting_contact');
assert.equal(confirmed.pending?.dateTime, selectedStart);
assert.equal(confirmed.pending?.ownedOfferedSlots.length, 1);
assert.equal(confirmed.pending?.lastAvailabilityConstraintKey, fingerprint);
assert.equal(availabilityReads, readsBeforeConfirmation + 1, 'confirmation performs exactly one canonical slot revalidation read');
assert.equal(confirmed.replies.length, 1);
assert.match(confirmed.replies[0], /نام/u);
assert.doesNotMatch(confirmed.replies[0], /خالی است|این زمان‌ها خالی هستند/u);

console.log('Telegram Persian live-path booking regression passed');
