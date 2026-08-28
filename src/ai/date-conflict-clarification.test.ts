import assert from 'node:assert/strict';
import {
  getBookingWeekdayReference,
  normalizeBookingRequest,
} from './booking-intelligence';
import {
  advanceUnresolvedDateConflictClarification,
  beginOrAdvanceDateConflictClarification,
  formatDateConflictClarification,
  resolveDateConflictClarification,
} from './date-conflict-clarification';

const now = new Date('2026-08-25T12:00:00+02:00');
const normalize = (text: string, activeLanguage: any = 'en') => normalizeBookingRequest({
  businessId: 'date-conflict-unit',
  channel: 'telegram',
  conversationKey: 'date-conflict-unit',
  inputMode: 'text',
  text,
  activeLanguage,
  timezone: 'Europe/Stockholm',
  now,
});

for (const [text, weekday] of [
  ['الأحد', 0], ['الاحد', 0],
  ['الإثنين', 1], ['الاثنين', 1], ['الإثنان', 1], ['الاثنان', 1],
  ['الثلاثاء', 2],
  ['الأربعاء', 3], ['الاربعاء', 3],
  ['الخميس', 4],
  ['الجمعة', 5],
  ['السبت', 6],
] as const) {
  assert.equal(getBookingWeekdayReference(text)?.weekday, weekday, text);
}

const conflictRequest = normalize('I want to book Tuesday 15 October 2026 at 14:00');
assert.ok(conflictRequest.dateConflict);
const first = beginOrAdvanceDateConflictClarification({
  conflict: conflictRequest.dateConflict!,
  input: conflictRequest.normalizedText,
  ownsPendingShell: true,
  proposedTimeConstraint: conflictRequest.timeConstraint,
});
assert.equal(first.stage, 'initial');
assert.equal(first.state.candidate1, '2026-10-15');
assert.equal(first.state.candidate2, '2026-10-13');
assert.equal(first.state.proposedTimeConstraint?.startMinutes, 14 * 60);

const second = beginOrAdvanceDateConflictClarification({
  existing: first.state,
  conflict: conflictRequest.dateConflict!,
  input: conflictRequest.normalizedText,
  ownsPendingShell: false,
});
assert.equal(second.stage, 'explicit_choice');
const third = advanceUnresolvedDateConflictClarification(second.state, conflictRequest.normalizedText);
assert.equal(third.stage, 'bounded_recovery');
const fourth = advanceUnresolvedDateConflictClarification(third.state, conflictRequest.normalizedText);
assert.equal(fourth.stage, 'terminal_recovery');
const fifth = advanceUnresolvedDateConflictClarification(fourth.state, conflictRequest.normalizedText);
assert.equal(fifth.stage, 'suppressed_duplicate');
assert.equal(fifth.state.attemptCount, 4, 'the retry counter is bounded');

for (const language of ['en', 'sv', 'es', 'de', 'fa', 'ar']) {
  const outputs = [
    formatDateConflictClarification(first.state, language, 'initial'),
    formatDateConflictClarification(second.state, language, 'explicit_choice'),
    formatDateConflictClarification(third.state, language, 'bounded_recovery'),
    formatDateConflictClarification(fourth.state, language, 'terminal_recovery'),
  ];
  assert.equal(new Set(outputs).size, 4, `${language} progression must not repeat byte-identical copy`);
  if (language === 'fa' || language === 'ar') {
    assert.match(outputs.join(' '), /[\u0600-\u06ff]/u, `${language} must use native script`);
  }
}

assert.deepEqual(resolveDateConflictClarification({
  state: first.state,
  input: '1',
  normalizedRequest: normalize('1'),
}), { date: '2026-10-15', source: 'candidate_1' });
assert.deepEqual(resolveDateConflictClarification({
  state: first.state,
  input: 'الخيار ٢',
  normalizedRequest: normalize('الخيار ٢', 'ar'),
}), { date: '2026-10-13', source: 'candidate_2' });
assert.deepEqual(resolveDateConflictClarification({
  state: first.state,
  input: '2026-10-20',
  normalizedRequest: normalize('2026-10-20'),
}), { date: '2026-10-20', source: 'unambiguous_date' });

assert.equal(normalize('1').date, undefined, 'bare 1 is not globally a date');
assert.equal(normalize('2').date, undefined, 'bare 2 is not globally a date');

console.log('date conflict clarification state, localization, choice, and Arabic weekday tests passed');
