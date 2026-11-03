import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessSourceCoverage, SOURCE_EXHAUSTIVE_PROTOCOL, sourceExhaustiveSchema } from './source-exhaustive-coverage';
import { parseAnswerUnits, parseRequestedFacets } from './business-information-answer-plan';

const capture = JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', import.meta.url), 'utf8'));
const diagnostic = JSON.parse(JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-source-shortfalls-20261102.json', import.meta.url), 'utf8')).outputText);
function context() {
  const facets = parseRequestedFacets(capture.verification.input.facets).facets;
  const evidence = structuredClone([...capture.frozen.evidence, capture.frozen.configurationEvidence]);
  const units = parseAnswerUnits({ units: capture.verification.input.units }, facets, evidence, 'en').units;
  const legacy = JSON.parse(capture.verification.outputText);
  // TEST-ONLY new certificate: the genuine diagnostic did NOT return these
  // affirmative attestations. No production adapter manufactures them.
  const raw = { ...structuredClone(legacy), sourceCoverage: {
    protocol: SOURCE_EXHAUSTIVE_PROTOCOL, requestAligned: true, availableMaterialFactsComplete: true,
    conditionsPreserved: true, conflictsAbsent: true, evidenceIdsReviewed: evidence.map(e => e.id), acceptedUnitIdsReviewed: units.map(u => u.id),
    obligations: facets.flatMap(f => f.obligations.map(o => ({ facetId: f.id, obligationId: o.id,
      state: o.questionType === 'requirement' ? 'UNRESOLVED_REQUIREMENT' : 'REQUESTED_INFORMATION_NOT_VERIFIED' }))),
  } };
  return { facets, evidence, units, raw, legacy };
}
test('proposed contract: captured facts plus a separate explicit certificate can be scoped without promoting the genuine verdict', () => {
  const c = context(), before = JSON.stringify(c.legacy);
  assert.equal(assessSourceCoverage(c.raw, c.facets, c.units, c.evidence, 77).state, 'SCOPED_PARTIAL');
  assert.equal(JSON.stringify({ decisions: c.raw.decisions, coverage: c.raw.coverage }), before);
  assert.ok(c.raw.coverage.every(c => !c.materialFactsComplete && c.obligations.every(o => o.status === 'UNRESOLVED')));
});
test('neither the original genuine verdict nor its non-authorizing diagnostic is a source-exhaustiveness certificate', () => {
  const c = context();
  for (const raw of [c.legacy, diagnostic]) assert.equal(assessSourceCoverage(raw, c.facets, c.units, c.evidence, 77).state, 'DENIED');
});
test('versioned schema retains the old decision and coverage schemas byte-for-byte', () => {
  const base = capture.verification.structuredOutput.schema, extended = sourceExhaustiveSchema(base);
  assert.deepEqual(extended.properties.decisions, base.properties.decisions);
  assert.deepEqual(extended.properties.coverage, base.properties.coverage);
  assert.deepEqual(Object.keys(base.properties), ['decisions', 'coverage']);
});
for (const [name, change] of Object.entries({
  'available source fact omitted': c => { c.evidence.push({ ...c.evidence[0], id: 'e2', sourceId: 'other-policy', text: 'Cancellation requests require a booking reference.' });
    c.raw.sourceCoverage.evidenceIdsReviewed.push('e2'); c.raw.sourceCoverage.availableMaterialFactsComplete = false;
    c.raw.sourceCoverage.obligations[0].state = 'AVAILABLE_SOURCE_FACT_OMITTED'; },
  'omission cannot hide behind an affirmative certificate': c => { c.raw.sourceCoverage.obligations[0].state = 'AVAILABLE_SOURCE_FACT_OMITTED'; },
  'mandatory condition': c => { c.raw.sourceCoverage.conditionsPreserved = false; c.raw.sourceCoverage.obligations[0].state = 'MISSING_CONDITION'; },
  'legacy missing condition vetoes even contradictory positive certificate': c => { c.raw.coverage[0].incompletenessReason = 'MISSING_CONDITION'; },
  'missing recommendation': c => { c.raw.coverage[0].incompletenessReason = 'MISSING_RECOMMENDATION'; },
  'contradiction': c => { c.raw.decisions[0].relation = 'CONTRADICTED'; },
  'source conflict': c => { c.raw.sourceCoverage.conflictsAbsent = false; },
  'rejected deadline or fee claim': c => { c.raw.decisions[0].relation = 'UNKNOWN'; },
  'missing qualifier': c => { c.raw.decisions[0].qualifiersPreserved = false; },
  'unlocated assessment': c => { c.raw.sourceCoverage.obligations[0].state = 'UNLOCATED'; },
  'foreign tenant': c => { c.evidence[0].businessId = 99; },
  'stale revision': c => { c.evidence[1].version += '-changed'; },
  'invalid citation': c => { c.units[0] = { ...c.units[0], evidenceRefs: [{ ...c.units[0].evidenceRefs[0], evidenceId: 'foreign' }] }; },
  'omitted evidence inventory': c => { c.raw.sourceCoverage.evidenceIdsReviewed.pop(); },
  'omitted unit inventory': c => { c.raw.sourceCoverage.acceptedUnitIdsReviewed.pop(); },
  'duplicate evidence IDs': c => { c.raw.sourceCoverage.evidenceIdsReviewed.push(c.evidence[0].id); },
  'incomplete legacy coverage': c => { c.raw.coverage.pop(); },
  'duplicate assessment': c => { c.raw.sourceCoverage.obligations[1] = c.raw.sourceCoverage.obligations[0]; },
  'false covered requirement': c => { c.raw.coverage[1].materialFactsComplete = true; c.raw.coverage[1].incompletenessReason = 'NONE';
    c.raw.coverage[1].obligations[0].status = 'COVERED'; c.raw.coverage[1].obligations[0].unitIds = ['u1']; c.raw.sourceCoverage.obligations[1].state = 'COMPLETE'; },
  'claiming a requirement is unavailable description': c => { c.raw.sourceCoverage.obligations[1].state = 'REQUESTED_INFORMATION_NOT_VERIFIED'; },
  'legacy complete contradicts unavailable assessment': c => { c.raw.coverage[0].materialFactsComplete = true; },
  'extra diagnostic fields are not the new protocol': c => { c.raw.coverageWitnesses = diagnostic.coverageWitnesses; },
} as Record<string, (c: any) => void>)) test(`proposed source-coverage contract rejects ${name}`, () => {
  const c = context(); change(c); assert.equal(assessSourceCoverage(c.raw, c.facets, c.units, c.evidence, 77).state, 'DENIED');
});
test('authority contract has no business, topic or language dependency', () => {
  const c = context();
  const evidence = c.evidence.map(e => ({ ...e, businessId: 4382 }));
  assert.equal(assessSourceCoverage(c.raw, c.facets, c.units, evidence, 4382).state, 'SCOPED_PARTIAL');
  const units = c.units.map(u => ({ ...u, language: 'sv' }));
  assert.equal(assessSourceCoverage(c.raw, c.facets, units, c.evidence, 77).state, 'SCOPED_PARTIAL');
});
