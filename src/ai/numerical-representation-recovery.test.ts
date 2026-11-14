import assert from 'node:assert/strict';
import test from 'node:test';
import { assessNumericalConstraint, numericalRepresentationRepair } from './numerical-constraints';
import { NATIVE_V2_PRODUCER_GUIDANCE, parseAnswerUnits, parseRequestedFacets, type Evidence, type ReExtractionTally } from './business-information-answer-plan';
import { ACCEPTANCE_ROWS } from '../../tests/helpers/first-visit-acceptance-cases';

// SYNTHETIC claims; the source sentence follows the public test business wording.
const source = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const assess = (claim: string, sources: string[] = [source]) => assessNumericalConstraint(claim, claim, sources);

for (const row of ACCEPTANCE_ROWS) {
  test(`${row.language}: written numbers and explicit relative anchors match the source; unsafe variants still fail closed`, () => {
    for (const claim of [row.digit, row.written, row.relative, row.denial]) assert.equal(assess(claim).reason, 'CONSTRAINT_MATCH', claim);
    for (const claim of [row.wrong, row.after]) assert.equal(assess(claim).safe, false, claim);
    assert.equal(assess(row.negated).reason, 'CLAIM_AMBIGUOUS');
    assert.equal(assess(row.requiredExact).reason, 'CLAIM_AMBIGUOUS');
  });
  test(`${row.language}: only provable representation failures are recovery-eligible`, () => {
    assert.equal(numericalRepresentationRepair(assess(row.unanchored)), 'anchor_omitted');
    assert.equal(numericalRepresentationRepair(assess(row.redundant)), 'redundant_restatement');
    for (const claim of [row.wrong, row.after, row.negated, row.requiredExact, row.digit, row.confirmation])
      assert.equal(numericalRepresentationRepair(assess(claim)), null, claim);
  });
}

test('written-number normalization never infers anchors or reads articles and ambiguous words', () => {
  assert.equal(assess('Die Behandlung endet etwa 10 Minuten früher.').reason, 'UNBOUNDED_CLAIM_NOT_SUPPORTED', 'früher without an arrival verb');
  for (const claim of ['For a first visit, we recommend arriving about an hour before your appointment.', 'Kom en timme före din tid.',
    'نه دقیقه قبل از نوبت حاضر شوید.']) assert.equal(assess(claim).reason, 'CLAIM_QUANTITY_COUNT', claim);
  assert.equal(assess('Avboka minst 24 timmar tidigare.').safe, false, 'policy wording keeps the conservative path');
  assert.equal(assess('Sie müssen nicht zehn Minuten vor dem Termin ankommen.').reason, 'CLAIM_AMBIGUOUS', 'negation survives normalization');
  assert.equal(assess('يُنصح الزوار بالوصول قبل موعدهم بخمس عشرة دقيقة.').safe, false, 'compound Arabic 15 is not 10');
  assert.equal(assess('احضر قبل الموعد بدقيقتين.').safe, false, 'Arabic dual is 2 minutes');
  assert.equal(assess('Kommen Sie etwa zehn Minuten vor dem Termin.', ['Kommen Sie etwa zehn Minuten vor dem Termin.']).reason, 'CONSTRAINT_MATCH');
});

test('recovery eligibility excludes distinct values, policies, zero quantities, extra sources and other ambiguity', () => {
  const pair = 'Kom 10 minuter före din bokade tid, alltså 15 minuter före.';
  assert.equal(numericalRepresentationRepair(assess(pair)), null, 'independently scoped values are never merged');
  assert.equal(numericalRepresentationRepair(assess('Vid ditt första besök rekommenderas en lugn förberedelse.')), null, 'zero quantities');
  assert.equal(numericalRepresentationRepair(assess(ACCEPTANCE_ROWS[0].unanchored, [source, source])), null, 'more than one cited source');
  assert.equal(numericalRepresentationRepair(assess('Kom 10 minuter före din bokade tid, alltså inte 10 minuter före.')), null, 'negation is not representation');
  const policy = 'Avbokning är kostnadsfri fram till 24 timmar före besöket.';
  assert.equal(numericalRepresentationRepair(assess('Avbokning är kostnadsfri inom 24 timmar.', [policy])), null, 'policy quantities');
  const bounded = 'Förstagångsbesökare bör komma högst 10 minuter före sin bokade tid.';
  assert.equal(numericalRepresentationRepair(assess(ACCEPTANCE_ROWS[0].unanchored, [bounded])), null, 'a bounded source is not an omitted anchor');
  assert.equal(numericalRepresentationRepair(assess(ACCEPTANCE_ROWS[0].unanchored, ['Kom 10 minuter före öppning.'])), null, 'no appointment anchor');
});

const sourceId = '2ac009ba-c913-48bc-b13d-c09adf34c8e0', revision = '4b86e3e3f6b07821689017b9a1d996c7c884ff7a8be96d8607a2a203af2cdaf1';
const evidence: Evidence[] = [{ id: 'e1', sourceId, chunkId: 'c1', version: revision, businessId: 3, text: source }];
const facets = parseRequestedFacets([{ subject: 'first visit', attribute: 'arrival', questionType: 'description' }]).facets;
const unit = (text: string) => ({ facetIds: ['f1'], subject: 'first-time visitors', predicate: 'arrival timing', value: 'approximately 10 minutes before',
  scope: 'first visit', qualifiers: ['approximately'], modality: 'recommended', negation: false, language: 'de', text,
  evidenceRefs: [{ evidenceId: 'e1', exactQuote: source }] });
const tally = (items: Evidence[], text: string) => {
  const t: ReExtractionTally = { ambiguousConnective: 0, citationOmitsQuantity: 0 };
  const result = parseAnswerUnits({ units: [unit(text)] }, facets, items, 'de', () => {}, 'quotation', { businessId: 3, question: 'Q', language: 'de' },
    { businessId: 3, protocol: 'source-exhaustive-v2' }, undefined, t);
  return { t, parsed: result.units.length };
};

test('the parser tallies representation recovery only for same-tenant, revision-pinned single citations, and never admits the unit', () => {
  for (const text of [ACCEPTANCE_ROWS[0].unanchored, ACCEPTANCE_ROWS[0].redundant]) {
    assert.deepEqual(tally(evidence, text), { t: { ambiguousConnective: 0, citationOmitsQuantity: 0, numericalRepresentation: 1 }, parsed: 0 });
    assert.deepEqual(tally([{ ...evidence[0], businessId: 9 }], text), { t: { ambiguousConnective: 0, citationOmitsQuantity: 0 }, parsed: 0 }, 'foreign tenant');
    assert.deepEqual(tally([{ ...evidence[0], version: 'unpinned' }], text), { t: { ambiguousConnective: 0, citationOmitsQuantity: 0 }, parsed: 0 }, 'no revision pin');
  }
  assert.deepEqual(tally(evidence, ACCEPTANCE_ROWS[0].wrong), { t: { ambiguousConnective: 0, citationOmitsQuantity: 0 }, parsed: 0 });
  assert.deepEqual(tally(evidence, ACCEPTANCE_ROWS[0].written), { t: { ambiguousConnective: 0, citationOmitsQuantity: 0 }, parsed: 1 });
});

test('the native producer contract asks for one digit quantity per unit with its explicit event anchor', () => {
  for (const phrase of ['give each independently scoped quantity its own unit and state it once, in digits with its unit',
    'name that event with explicit before/after wording', 'never add an anchor the source does not state',
    'an approximate recommendation is not an exact or mandatory time']) assert.ok(NATIVE_V2_PRODUCER_GUIDANCE.includes(phrase), phrase);
});
