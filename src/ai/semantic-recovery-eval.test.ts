import assert from 'node:assert/strict';
import test from 'node:test';
import { requestCeiling } from '../../scripts/knowledge-aen-single-provider';
import {
  evaluateReextraction, adversarialFindings, baselineFindings, CASES, ceilingUsd, deterministic, evaluate, ledgerPreflight, LIMITS,
  oracleFindings, receiptFindings, requestFor, sha256,
} from '../../tests/helpers/semantic-recovery-eval';

// Offline only. Scripted findings measure the deterministic boundary and the
// best achievable recall; they say nothing about real model accuracy.
const DETERMINISTIC_VETO = new Set(['explicit limit', 'quantity', 'anchor', 'deadline', 'tenant leakage', 'stale source', 'citation']);

test('cost estimator matches the repository requestCeiling and every request is within limits', () => {
  for (const item of CASES) {
    const { body, requestSha256, ceilingUsd: usd } = requestFor(item);
    assert.equal(usd, requestCeiling(body, '/v1/responses').ceiling, item.id);
    assert.equal(ceilingUsd(body), usd);
    assert.ok(usd > 0 && usd <= LIMITS.perRequestUsd, item.id);
    assert.equal(requestSha256, sha256(JSON.stringify(requestFor(item).body)), 'request hash must be deterministic');
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, []);
    assert.equal(body.text.format.strict, true);
    assert.ok(!JSON.stringify(body).includes(JSON.stringify(item.label)), 'labels never enter a request');
  }
  assert.equal(new Set(CASES.map(item => item.id)).size, CASES.length);
  // Context cases reuse fa-purpose-1 text; they are deterministically blocked and never dispatched.
  const dispatchable = CASES.filter(item => !item.context);
  assert.equal(new Set(dispatchable.map(item => requestFor(item).requestSha256)).size, dispatchable.length);
});

test('a worst-case verifier cannot override any deterministic veto', () => {
  const adversarial = evaluate(adversarialFindings);
  for (const outcome of adversarial.outcomes.filter(o => DETERMINISTIC_VETO.has(o.category)))
    assert.equal(outcome.recovered, false, `${outcome.id} (${outcome.category}) recovered by verifier alone`);
  for (const item of CASES.filter(c => c.context)) assert.equal(deterministic(item).eligible, false, item.id);
  // Explicit-limit wording is never eligible, in any language.
  for (const item of CASES.filter(c => c.category === 'explicit limit')) assert.equal(deterministic(item).eligible, false, item.id);
});

test('rejected design: readmitting the original wording makes the verifier the sole judge inside the connective class', () => {
  const adversarial = evaluate(adversarialFindings);
  const verifierOnly = adversarial.outcomes.filter(o => o.recovered && !o.faithful).map(o => o.id).sort();
  // Pinned so the limitation stays visible: these require semantics alone.
  // Since 61cc44f, fa-audience, fa-fabricated-fact and fa-required use the
  // closed purpose grammar («…برسند تا با آرامش آماده شوند»), so they leave the
  // connective class and are judged like any proposal by the unchanged modality
  // gate and independent verifier, never by a connective recovery.
  assert.deepEqual(verifierOnly, ['fa-ambiguous', 'fa-false-purpose', 'fa-max-ta-same']);
});

test('recommended design: one complete re-extraction is judged only by the unchanged deterministic gate', () => {
  // Test scaffolding that simulates a model restatement; not product logic.
  const unambiguous = (text: string) => text.replace(/(?:،\s*)?\s*تا(?=\s+(?:با|بتوان|آماده|وقت|فرصت|بدون|زمان))/u, '، برای اینکه');
  // Scripted restatements: faithful rewrite for faithful cases; for unfaithful
  // ones the WORST case returns the original ambiguous text unchanged.
  const result = evaluateReextraction(item => item.label.faithful ? { text: unambiguous(item.text), faithful: true } : { text: item.text, faithful: false });
  for (const outcome of result.outcomes.filter(o => o.retried && !o.faithful)) assert.equal(outcome.accepted, false, outcome.id);
  // A restated genuine limit (any wording) is still judged against the unbounded source.
  const bounded = evaluateReextraction(item => ({ text: item.text.replace('حدود', 'حداکثر'), faithful: false }));
  for (const outcome of bounded.outcomes.filter(o => o.retried)) assert.equal(outcome.accepted, false, outcome.id);
});

test('missing, malformed or adverse findings never recover', () => {
  const none = evaluate(baselineFindings);
  assert.equal(none.total.recovered, 0);
  assert.equal(evaluate(() => '{').total.recovered, 0);
  assert.equal(evaluate(() => JSON.stringify({ decisions: [], coverage: [], findings: [] })).total.recovered, 0);
  assert.equal(evaluate(receiptFindings({})).total.recovered, 0);
});

test('ledger preflight is read-only arithmetic and fails closed', () => {
  const ledger = (calls: number, estimatedUsd: number, unmeteredReserveUsd: number) =>
    Buffer.from(JSON.stringify({ calls: Array.from({ length: calls }, () => ({})), estimatedUsd, unmeteredReserveUsd }));
  const main = ledger(406, 0.68, 1.69), other = ledger(163, 0.08, 0.26);
  const passing = ledgerPreflight([{ name: 'main', bytes: main, expectedSha256: sha256(main), minRows: 406 }, { name: 'other', bytes: other }], [0.01, 0.01]);
  assert.equal(passing.ok, true, passing.problems.join());
  assert.ok(Math.abs(passing.headroomUsd - (LIMITS.cumulativeUsd - 2.71)) < 1e-9);
  assert.equal(LIMITS.cumulativeUsd, 4.0);
  assert.equal(LIMITS.perRequestUsd, 0.15);
  assert.match(ledgerPreflight([{ name: 'main', bytes: main, expectedSha256: '0'.repeat(64) }], [0.01]).problems.join(), /sha256 changed/);
  assert.match(ledgerPreflight([{ name: 'main', bytes: ledger(10, 0.1, 0.1), minRows: 406 }], [0.01]).problems.join(), /rows 10/);
  assert.match(ledgerPreflight([{ name: 'main', bytes: main }], [0.2]).problems.join(), /exceed \$0.15/);
  assert.match(ledgerPreflight([{ name: 'main', bytes: main }], Array(Math.round(LIMITS.cumulativeUsd * 100)).fill(0.01)).problems.join(), /exceeds headroom/);
  assert.match(ledgerPreflight([{ name: 'bad', bytes: Buffer.from('{') }], [0.01]).problems.join(), /unreadable/);
});

test('acceptance report: deterministic baseline, best-case recovery and worst-case verifier', t => {
  const reports = { baseline: evaluate(baselineFindings), oracle: evaluate(oracleFindings), adversarial: evaluate(adversarialFindings) };
  // A perfect labeller can never produce a false recovery.
  assert.equal(reports.oracle.total.falseRecoveries, 0);
  // Recovery never removes a baseline acceptance.
  for (const [index, outcome] of reports.baseline.outcomes.entries()) if (outcome.accepted) assert.ok(reports.oracle.outcomes[index].accepted);
  const eligible = CASES.filter(item => deterministic(item).eligible);
  t.diagnostic(JSON.stringify({ cases: CASES.length, eligibleForVerifier: eligible.map(item => item.id),
    eligibleCeilingUsd: +eligible.reduce((n, item) => n + requestFor(item).ceilingUsd, 0).toFixed(6),
    allCasesCeilingUsd: +CASES.reduce((n, item) => n + requestFor(item).ceilingUsd, 0).toFixed(6),
    totals: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, r.total])),
    byLanguage: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, r.byLanguage])),
    verifierDependentFalseRecoveries: reports.adversarial.outcomes.filter(o => o.recovered && !o.faithful).map(o => `${o.id}:${o.category}`),
    unrecoverableFaithful: reports.oracle.outcomes.filter(o => o.faithful && !o.accepted).map(o => `${o.id}:${o.blockedBy}`),
    baselineNumericalLayerAccepts: reports.baseline.outcomes.filter(o => o.accepted && !o.faithful).map(o => `${o.id}:${o.category}`) }));
});
