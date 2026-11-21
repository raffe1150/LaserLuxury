/** P0 2026-11-17: GUARD_12 is scoped to the unavailable facets. Pure, offline,
 * SYNTHETIC verdicts; the decision record must agree with the assessment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSourceCoverage, scopedPartialModalityBlocked, SOURCE_EXHAUSTIVE_V2_PROTOCOL } from './source-exhaustive-coverage';
import { parseRequestedFacets } from './business-information-answer-plan';
import { assessSourceCoverageDetailed } from './source-coverage-decision-record';
import { sourceExhaustiveLimitations } from './knowledge-answer-presentation';

const BUSINESS = 3;
const evidence = [{ id: 'e1', businessId: BUSINESS, sourceId: 's1', chunkId: 'c1', version: 'v1',
  text: 'First-time visitors are recommended to arrive about 10 minutes early. Feel free to bring your booking confirmation. If you received special instructions you must follow them. You may not bring pets.' }];
const quote = (q: string) => [{ evidenceId: 'e1', sourceId: 's1', chunkId: 'c1', version: 'v1', exactQuote: q }];
const facets = parseRequestedFacets([
  { subject: 'first visit', attribute: 'arrival', questionType: 'description', obligations: [{ description: 'How many minutes before should I arrive', questionType: 'description' }] },
  { subject: 'first visit', attribute: 'items', questionType: 'requirement', obligations: [{ description: 'do I need to bring anything?', questionType: 'requirement' }] },
]).facets;
type U = { id: string; facet: 'f1' | 'f2' | 'both'; modality: string; negation?: boolean; q: string };
const ARRIVAL: U = { id: 'u1', facet: 'f1', modality: 'recommended', q: 'First-time visitors are recommended to arrive about 10 minutes early.' };
const CONFIRMATION: U = { id: 'u2', facet: 'f2', modality: 'permitted', q: 'Feel free to bring your booking confirmation.' };
function scenario(units: U[], states: Record<string, 'COMPLETE' | 'UNRESOLVED_REQUIREMENT' | 'REQUESTED_INFORMATION_NOT_VERIFIED'>, f2Type: 'requirement' | 'description' = 'requirement', citeRequirement = false, mutate: Record<string, object> = {}, bindings: Record<string, object> = {}, ev: any[] = evidence) {
  const fs = f2Type === 'requirement' ? facets : parseRequestedFacets([
    { subject: 'first visit', attribute: 'arrival', questionType: 'description', obligations: [{ description: 'How many minutes before should I arrive', questionType: 'description' }] },
    { subject: 'first visit', attribute: 'items', questionType: 'description', obligations: [{ description: 'what should I bring?', questionType: 'description' }] }]).facets;
  const built = units.map(u => ({ id: u.id, facetIds: u.facet === 'both' ? ['f1', 'f2'] : [u.facet], subject: 'x', predicate: 'y', value: u.q, modality: u.modality,
    negation: u.negation ?? false, scope: 'first visit', qualifiers: [], language: 'en', text: u.q, verification: 'ENTAILED', evidenceRefs: [{ ...quote(u.q)[0], ...(bindings[u.id] ?? {}) }] })) as any[];
  const inFacet = (id: string) => built.filter(u => u.facetIds.includes(id)).map(u => u.id);
  const raw = {
    decisions: built.map(u => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true, qualifiersPreserved: true, ...(mutate[u.id] ?? {}),
      relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
    coverage: fs.map(f => { const done = states[f.id] === 'COMPLETE'; return { facetId: f.id, requestAligned: true, materialFactsComplete: done,
      incompletenessReason: done ? 'NONE' : 'UNRESOLVED', materialUnitIds: inFacet(f.id),
      obligations: [{ obligationId: f.obligations[0].id, status: done ? 'COVERED' : 'UNRESOLVED', unitIds: done || citeRequirement || f.obligations[0].questionType !== 'requirement' ? inFacet(f.id) : [] }] }; }),
    sourceCoverage: { protocol: SOURCE_EXHAUSTIVE_V2_PROTOCOL, requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true, conflictsAbsent: true,
      evidenceIdsReviewed: ['e1'], acceptedUnitIdsReviewed: built.map(u => u.id),
      obligations: fs.map(f => ({ facetId: f.id, obligationId: f.obligations[0].id, state: states[f.id] })) },
  };
  const assessment = assessSourceCoverage(raw, fs, built, ev as any, BUSINESS, SOURCE_EXHAUSTIVE_V2_PROTOCOL);
  const detail = assessSourceCoverageDetailed(raw, fs, built, ev as any, BUSINESS, SOURCE_EXHAUSTIVE_V2_PROTOCOL);
  assert.deepEqual(detail.assessment, assessment, 'decision record wraps the unchanged assessment');
  return { assessment, record: detail.record };
}
const GAP = { f1: 'COMPLETE', f2: 'UNRESOLVED_REQUIREMENT' } as const;

test('independently complete recommendation + optional item beside an unresolved requirement: SCOPED_PARTIAL', () => {
  const { assessment, record } = scenario([ARRIVAL, CONFIRMATION], GAP);
  assert.equal(assessment.state, 'SCOPED_PARTIAL');
  assert.deepEqual(assessment.unavailable.map(u => [u.facetId, u.state]), [['f2', 'UNRESOLVED_REQUIREMENT']]);
  assert.equal(record.guard, 'NONE'); assert.equal(record.guard12, 'PASSED');
});
test('a complete facet with a required fact may publish beside an unrelated unresolved requirement', () => {
  assert.equal(scenario([{ ...ARRIVAL, modality: 'required' }], GAP).assessment.state, 'SCOPED_PARTIAL');
});
test('a verified (conditional) requirement may stand beside an unresolved requirement; it never covers it (GUARD_10/11)', () => {
  const INSTRUCTIONS: U = { ...CONFIRMATION, id: 'u3', modality: 'required', q: 'If you received special instructions you must follow them.' };
  assert.equal(scenario([ARRIVAL, CONFIRMATION, INSTRUCTIONS], GAP).assessment.state, 'SCOPED_PARTIAL');
  assert.equal(scenario([ARRIVAL, CONFIRMATION, INSTRUCTIONS], GAP, 'requirement', true).record.guard, 'GUARD_11');
});
for (const [name, unit] of [
  ['negated requirement beside the unresolved requirement', { ...CONFIRMATION, modality: 'required', negation: true, q: 'If you received special instructions you must follow them.' }],
  ['prohibition beside the unresolved requirement', { ...CONFIRMATION, modality: 'prohibited', q: 'You may not bring pets.' }],
  ['negated permission beside the unresolved requirement', { ...CONFIRMATION, negation: true }],
] as const) test(`GUARD_12 still denies: ${name}`, () => {
  const { assessment, record } = scenario([ARRIVAL, unit as U], GAP);
  assert.equal(assessment.state, 'DENIED'); assert.equal(record.guard, 'GUARD_12'); assert.equal(record.guard12, 'BLOCKED');
});
test('GUARD_12 still denies a non-descriptive fact beside an unverified description', () => {
  const r = scenario([ARRIVAL, CONFIRMATION], { f1: 'COMPLETE', f2: 'REQUESTED_INFORMATION_NOT_VERIFIED' }, 'description');
  assert.equal(r.assessment.state, 'DENIED'); assert.equal(r.record.guard, 'GUARD_12');
});
test('a unit shared by a complete facet and the unresolved requirement is judged by the gap rule', () => {
  assert.equal(scenario([{ ...ARRIVAL, facet: 'both' }], GAP).assessment.state, 'SCOPED_PARTIAL');
  assert.equal(scenario([{ ...ARRIVAL, facet: 'both', modality: 'prohibited' }], GAP).assessment.state, 'DENIED');
});
test('an optional item can never complete a requirement (GUARD_10) or be cited as its coverage (GUARD_11)', () => {
  assert.equal(scenario([ARRIVAL, CONFIRMATION], { f1: 'COMPLETE', f2: 'COMPLETE' }).record.guard, 'GUARD_10');
  assert.equal(scenario([ARRIVAL, CONFIRMATION], GAP, 'requirement', true).record.guard, 'GUARD_11');
});
test('descriptive facts are unaffected; with no gap nothing is ever blocked', () => {
  assert.equal(scopedPartialModalityBlocked([{ modality: 'descriptive', facetIds: ['f2'], negation: false } as any], [{ facetId: 'f2', state: 'REQUESTED_INFORMATION_NOT_VERIFIED' }]), false);
  assert.equal(scopedPartialModalityBlocked([{ modality: 'required', facetIds: ['f1'], negation: false } as any], []), false);
  assert.equal(scopedPartialModalityBlocked([{ modality: 'recommended', facetIds: ['f2'], negation: false } as any], [{ facetId: 'f2', state: 'UNRESOLVED_REQUIREMENT' }]), false);
  assert.equal(scopedPartialModalityBlocked([{ modality: 'recommended', facetIds: ['f2'], negation: false } as any],
    [{ facetId: 'f2', state: 'UNRESOLVED_REQUIREMENT' }, { facetId: 'f2', state: 'REQUESTED_INFORMATION_NOT_VERIFIED' }]), true);
});
test('limitation copy: literal user spans are echoed; paraphrased labels get fixed fact-free copy; single-facet behaviour unchanged', () => {
  const q = "I'm coming for the first time. How many minutes before should I arrive, and do I need to bring anything?";
  const span = sourceExhaustiveLimitations(q, 'en', facets, [{ facetId: 'f2', obligationId: 'f2.o1' }]);
  // A single unresolved requirement uses the fixed, question-independent copy (the natural composer must not echo the question).
  assert.deepEqual(span?.map(n => n.text), ['I cannot confirm from the available information what, if anything, is required.']);
  // Two unresolved requirements are never merged into one generic notice: each keeps a distinct literal span or the result fails closed.
  const two = parseRequestedFacets([{ subject: 'x', attribute: 'arrival', questionType: 'requirement', obligations: [{ description: 'How many minutes before should I arrive', questionType: 'requirement' }] },
    { subject: 'x', attribute: 'items', questionType: 'requirement', obligations: [{ description: 'do I need to bring anything?', questionType: 'requirement' }] }]).facets;
  const both = sourceExhaustiveLimitations(q, 'en', two, [{ facetId: 'f1', obligationId: 'f1.o1' }, { facetId: 'f2', obligationId: 'f2.o1' }]);
  assert.ok(both === undefined || both.length === 2 && new Set(both.map(n => n.text)).size === 2 &&
    both.every(n => n.text !== 'I cannot confirm from the available information what, if anything, is required.'), JSON.stringify(both));
  const paraphrased = parseRequestedFacets([facets[0], { subject: 'x', attribute: 'items', questionType: 'requirement', obligations: [{ description: 'whether anything must be brought', questionType: 'requirement' }] }]).facets;
  for (const [language, text] of [['en', 'I cannot confirm from the available information what, if anything, is required.'],
    ['fa', 'بر اساس اطلاعات موجود نمی‌توانم تأیید کنم که آیا چیزی الزامی است یا نه.']] as const)
    assert.deepEqual(sourceExhaustiveLimitations(q, language, paraphrased, [{ facetId: 'f2', obligationId: 'f2.o1' }])?.map(n => n.text), [text]);
  assert.ok(!JSON.stringify(sourceExhaustiveLimitations(q, 'en', paraphrased, [{ facetId: 'f2', obligationId: 'f2.o1' }])).includes('must be brought'));
  const single = parseRequestedFacets([{ subject: 'x', attribute: 'items', questionType: 'requirement', obligations: [{ description: 'whether anything must be brought', questionType: 'requirement' }] }]).facets;
  assert.equal(sourceExhaustiveLimitations(q, 'en', single, [{ facetId: 'f1', obligationId: 'f1.o1' }]), undefined, 'single-facet unsafe label still fails closed');
  const otherType = parseRequestedFacets([facets[0], { subject: 'x', attribute: 'y', questionType: 'permission', obligations: [{ description: 'whether pets are allowed', questionType: 'permission' }] }]).facets;
  assert.equal(sourceExhaustiveLimitations(q, 'en', otherType, [{ facetId: 'f2', obligationId: 'f2.o1' }]), undefined, 'untyped gaps still fail closed');
});

// Cross-facet security for the approved exception (owner decision 2026-11-17).
const COND: U = { ...CONFIRMATION, id: 'u3', modality: 'required', q: 'If you received special instructions you must follow them.' };
for (const [name, mutate, bindings, guard] of [
  ['condition / qualifier dropped', { u3: { qualifiersPreserved: false } }, {}, 'GUARD_06'],
  ['modality changed', { u3: { modalityPreserved: false } }, {}, 'GUARD_06'],
  ['meaning changed', { u3: { meaningPreserved: false } }, {}, 'GUARD_06'],
  ['unsupported (UNKNOWN)', { u3: { relation: 'UNKNOWN' } }, {}, 'GUARD_06'],
  ['contradicted', { u3: { relation: 'CONTRADICTED' } }, {}, 'GUARD_06'],
  ['quote absent from bound source', {}, { u3: { exactQuote: 'You must bring photo ID.' } }, 'GUARD_06'],
  ['stale source revision', {}, { u3: { version: 'v0' } }, 'GUARD_06'],
  ['other source binding', {}, { u3: { sourceId: 's2' } }, 'GUARD_06'],
] as const) test(`exception never admits a beside-gap fact with ${name}`, () => {
  const r = scenario([ARRIVAL, CONFIRMATION, COND], GAP, 'requirement', false, mutate as any, bindings as any);
  assert.equal(r.assessment.state, 'DENIED'); assert.equal(r.record.guard, guard);
});
test('exception never crosses tenants', () => {
  const r = scenario([ARRIVAL, CONFIRMATION], GAP, 'requirement', false, {}, {}, [{ ...evidence[0], businessId: 4 }]);
  assert.equal(r.assessment.state, 'DENIED'); assert.equal(r.record.guard, 'GUARD_02');
});
test('no limitation copy -> no scoped partial (unsupported language fails closed)', () => {
  const q = "I'm coming for the first time. How many minutes before should I arrive, and do I need to bring anything?";
  assert.equal(sourceExhaustiveLimitations(q, 'fr', facets, [{ facetId: 'f2', obligationId: 'f2.o1' }]), undefined);
});
test('fixed limitation copy states uncertainty only, never absence', () => {
  const paraphrased = parseRequestedFacets([facets[0], { subject: 'x', attribute: 'items', questionType: 'requirement', obligations: [{ description: 'whether anything must be brought', questionType: 'requirement' }] }]).facets;
  for (const language of ['en', 'sv', 'de', 'es', 'fa', 'ar']) {
    const [notice] = sourceExhaustiveLimitations('x', language, paraphrased, [{ facetId: 'f2', obligationId: 'f2.o1' }])!;
    assert.doesNotMatch(notice.text, /nothing else|no other|not required|inget annat|krävs inte|nichts anderes|nicht erforderlich|nada más|no se exige|چیز دیگری|لازم نیست|لا شيء آخر|غير مطلوب/iu, language);
    assert.doesNotMatch(notice.text, /\p{N}/u, 'no quantities or facts');
  }
});
test('fa/ar echoed spans keep the Arabic-script question mark (RTL)', () => {
  const q = 'من برای اولین بار می خوام بیام. چند دقیقه قبل از وقت رزرو باید اونجا باشم و آیا لازم هست چیزی با خودم بیارم?';
  const fs = parseRequestedFacets([{ subject: 'x', attribute: 'a', questionType: 'description', obligations: [{ description: 'چند دقیقه قبل از وقت رزرو باید اونجا باشم', questionType: 'description' }] },
    { subject: 'x', attribute: 'b', questionType: 'description', obligations: [{ description: 'آیا لازم هست چیزی با خودم بیارم?', questionType: 'description' }] }]).facets;
  assert.deepEqual(sourceExhaustiveLimitations(q, 'fa', fs, [{ facetId: 'f2', obligationId: 'f2.o1' }])?.map(n => n.text),
    ['پاسخ کامل به «آیا لازم هست چیزی با خودم بیارم؟» را نمی‌توان بر اساس اطلاعات موجود تأیید کرد.']);
});
