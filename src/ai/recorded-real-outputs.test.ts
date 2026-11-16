import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CURRENT_CAPTURE, TENANT } from '../../tests/helpers/admotion-current-inventory';
import { acceptable, FACETS, INCIDENT_QUESTION, loadIncident, type Fact } from '../../tests/helpers/reextraction-plan';
import { extractionTrigger, REEXTRACTION_GUIDANCE, runOnce } from '../../tests/helpers/reextraction-recovery';

// Offline replay of the RECORDED real responses (2026-11-12 run, plan 8ca7cacd)
// through the CURRENT code. No network; outputs are read from receipts.
const RUN = process.env.ODINLINK_RECORDED_RUN ??
  fileURLToPath(new URL('../../docs/validation/semantic-recovery-luna-sol-20261112', import.meta.url));
const skip = (!existsSync(RUN) || !existsSync(CURRENT_CAPTURE)) && 'recorded run or current capture not present';
const output = (name: string) => JSON.parse(readFileSync(`${RUN}/${name}.receipt.json`, 'utf8')).outputText as string;

// Human review of the real replacement units against the acceptance criteria.
const REVIEW: Record<string, readonly Fact[]> = {
  // Sol replacement u1: recommendation ~10 min before booked time, first-time
  // visitors, purpose, explicitly not mandatory / not a latest entry time.
  sol: ['APPROX_10_MIN_BEFORE_APPOINTMENT', 'FIRST_TIME_VISITORS', 'RECOMMENDATION_NOT_MANDATORY', 'PREPARATION_PURPOSE', 'EXPLICITLY_NOT_MANDATORY_OR_DEADLINE'],
  // Luna replacement u2 alone: "not mandatory, ~10 min earlier is not the latest
  // entry time" - never states the recommendation itself or its anchor.
  lunaU2: ['FIRST_TIME_VISITORS', 'RECOMMENDATION_NOT_MANDATORY', 'EXPLICITLY_NOT_MANDATORY_OR_DEADLINE'],
};

// Recorded outputs cite position-bound evidence IDs (e1..eN). Since a99cce7 the
// native exhaustive inventory admits this mixed PDF+text corpus in source order
// instead of the lexical order the providers saw. Replay the exact recorded wire
// order: every recorded item must match exactly one current, content-identical
// tenant item, so no text, tenant, source or revision is invented or altered.
function recordedEvidence(name: string, current: Awaited<ReturnType<typeof loadIncident>>['evidence']) {
  const request = JSON.parse(readFileSync(`${RUN}/${name}.request.json`, 'utf8'));
  const user = request.input.find((item: { role: string }) => item.role === 'user');
  const wire = JSON.parse(typeof user.content === 'string' ? user.content : user.content[0].text).evidence as { id: string; text: string }[];
  assert.equal(wire.length, current.length, 'recorded and current inventories differ in size');
  return wire.map((item, index) => {
    assert.equal(item.id, `e${index + 1}`);
    const same = current.filter(e => e.text === item.text && e.businessId === TENANT);
    assert.equal(same.length, 1, `recorded ${item.id} has no unique content-identical current item`);
    return Object.freeze({ ...same[0], id: item.id });
  });
}

async function replay(prefix: { original: string; replacement: string; verification: string }) {
  const incident = await loadIncident();
  const base = { question: INCIDENT_QUESTION, language: 'fa', facets: FACETS, businessId: TENANT };
  const originalEvidence = recordedEvidence(prefix.original, incident.evidence);
  const replacementEvidence = recordedEvidence(prefix.replacement, incident.evidence);
  const original = await runOnce({ ...base, evidence: async () => originalEvidence, respond: stage => {
    if (stage !== 'extraction') throw new Error('original verification is never dispatched');
    return JSON.parse(output(prefix.original));
  } });
  const replacement = await runOnce({ ...base, evidence: async () => replacementEvidence, guidance: REEXTRACTION_GUIDANCE,
    respond: stage => JSON.parse(output(stage === 'extraction' ? prefix.replacement : prefix.verification)) });
  return { original, replacement, trigger: extractionTrigger(original.events),
    rejections: replacement.events.filter(e => e.reason === 'NUMERICAL_CONSTRAINT').map(e => [e.unitId, e.numericalMismatchReason]) };
}

test('recorded Sol response: still publishes and meets every required fact', { skip }, async () => {
  const run = await replay({ original: '04-sol_original_extraction', replacement: '05-sol_replacement_extraction', verification: '06-verify-sol-output_replacement_verification' });
  assert.deepEqual(run.trigger, { eligible: true, reason: 'ELIGIBLE' });
  assert.equal(run.replacement.publishable, true);
  assert.deepEqual(run.rejections, []);
  assert.equal(run.replacement.manifest.units.length, 1);
  assert.ok(acceptable(REVIEW.sol));
});

// Since 61cc44f the closed Persian purpose grammar reads «حاضر شوند تا (با آرامش) آماده شوند»
// as a purpose clause, not an upper bound. Luna's faithful original unit therefore
// parses and proceeds to independent verification (never recorded, so not replayed);
// re-extraction is not triggered. Sol's «حاضر باشید تا…» stays outside the grammar.
test('recorded Luna responses: purpose-clause original now parses; replacement u2 still stopped by the citation gate', { skip }, async () => {
  const run = await replay({ original: '01-luna_original_extraction', replacement: '02-luna_replacement_extraction', verification: '03-verify-luna-output_replacement_verification' });
  assert.deepEqual(run.trigger, { eligible: false, reason: 'NO_REJECTION' });
  assert.deepEqual(run.original.events.find(e => e.stage === 'extraction' && e.reason === 'ACCEPTED')?.counts,
    { proposed: 1, parsed: 1, verified: 0, rejected: 0 });
  assert.equal(run.original.publishable, false, 'no recorded original verdict, so nothing publishes');
  assert.equal(run.replacement.publishable, false);
  assert.deepEqual(run.rejections, [['u2', 'QUANTITY_NOT_IN_CITATION']]);
  assert.ok(!run.replacement.wires.some(w => w.stage === 'verification'), 'no surviving unit, so no verification request would be sent');
  assert.equal(acceptable(REVIEW.lunaU2), false);
});
