import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INCOMING_MESSAGES, KNOWN_OUTGOING_GAPS, LANGUAGE_CASE_BUSINESS_CONFIG, LANGUAGE_SWITCHES, OUTGOING_UNITS,
} from '../../tests/helpers/german-swedish-language-cases';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');
const classify = (text: string, language: string, previous?: string) =>
  boundary.sharedLanguageClassification(text, language, LANGUAGE_CASE_BUSINESS_CONFIG, previous);

for (const [target, text, expected, category] of OUTGOING_UNITS) {
  test(`outgoing ${target} ${category}: local language veto ${expected}s ${text}`, () => {
    const { unit } = classify(text, target);
    assert.equal(unit ? 'reject' : 'accept', expected, JSON.stringify(unit));
  });
}

// Known pre-existing gaps (unchanged since 1db0a6c): reported as TODO with the
// observed verdict, never as an executed assertion. When a gap closes, the TODO
// label says "currently reject" and the case should move to OUTGOING_UNITS.
for (const [target, text, expected, reason] of KNOWN_OUTGOING_GAPS) {
  const observed = classify(text, target).unit ? 'reject' : 'accept';
  test(`known pre-existing gap ${target}: ${text}`, { todo: `${reason}; expected ${expected}, currently ${observed}` });
}

for (const [text, expected, category] of INCOMING_MESSAGES) {
  test(`incoming ${category}: strong deterministic language is ${expected} for ${text}`, () => {
    assert.equal(classify(text, expected ?? 'en').strong, expected);
  });
}

for (const [previous, text, expected] of LANGUAGE_SWITCHES) {
  test(`incoming switch from ${previous}: ${expected ?? 'keeps'} for ${text}`, () => {
    assert.equal(classify(text, previous, previous).switchTo, expected);
  });
}

test('German informal rejection diagnostics would carry only fixed identifiers and bounded scores', () => {
  const { unit } = classify('Det finns lediga tider på fredag.', 'de');
  assert.ok(unit?.classification);
  const serialized = JSON.stringify(unit);
  for (const word of ['finns', 'lediga', 'tider', 'fredag']) assert.doesNotMatch(serialized, new RegExp(word, 'u'));
  assert.equal(unit.classification.branch, 'grammatical');
  assert.ok(Object.values(unit.classification.grammaticalScores).every(score => Number.isInteger(score) && score >= 0 && score <= 99));
});

test('accepted units carry no language diagnostic at all', () => {
  assert.equal(classify('Wenn du möchtest, kannst du die Buchung ändern.', 'de').unit, undefined);
});
