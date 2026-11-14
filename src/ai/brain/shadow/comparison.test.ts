import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideTurn, type TurnInput } from '../decide-turn';
import { CORPUS } from '../evaluation/corpus';
import { EVAL_CHANNELS, EVAL_LANGUAGES } from '../evaluation/types';
import { loadRecorded } from '../evaluation/tier2';
import { compare } from './compare';
import { catalogInput } from './phase3-input';
import { recordedInput } from './recorded-input';

test('offline comparison improves matched partial cases and blocks corpus and injected negatives', async () => {
  const report = await compare();
  assert.deepEqual(Object.keys(report.summary.byLanguage).sort(), [...EVAL_LANGUAGES].sort());
  assert.deepEqual(Object.keys(report.summary.byChannelLabel).sort(), [...EVAL_CHANNELS].sort());
  assert.equal(report.summary.adaptersExecuted, 0);
  assert.equal(report.cases.length, CORPUS.length);
  assert.equal(report.summary.safety.unsafeCatalogObligations, 0);
  assert.equal(report.summary.safety.unsafeRecordedObligations, 0);
  assert.deepEqual(report.controls.filter(c => !c.passed), []);
  assert.ok(report.summary.partial.matched.every(m => m.v2 > m.v1 && !m.lost.length));
  const recorded = report.recordings.filter(r => r.safePartial);
  assert.deepEqual(recorded.map(r => r.id), ['rec-shared-core-de-20261022']);
  assert.deepEqual(recorded[0].perObligation.map(o => o.v1), ['TURN_FALLBACK', 'TURN_FALLBACK']);
  assert.deepEqual(recorded[0].perObligation.map(o => o.v2), ['ANSWER', 'DISCLOSE']);

  for (const [i, c] of CORPUS.entries()) {
    const row = report.cases[i];
    assert.equal(row.v2.publication, 'OFFLINE_ONLY');
    c.obligations.forEach((o, j) => {
      const d = row.v2.obligations[j];
      if (o.expect === 'ROUTE') {
        assert.equal(d.outcome, 'HANDOFF', c.id);
        assert.equal(d.route, o.route);
        assert.deepEqual(d.supportingFacts, []);
      } else if (o.expect === 'CLARIFY') {
        assert.equal(d.outcome, 'CLARIFY', c.id);
        assert.deepEqual(d.supportingFacts, []);
      } else if (o.expect === 'REFUSE_FOREIGN' || o.expect === 'DISCLOSE' || c.evidenceProfile === 'STALE') {
        assert.equal(d.outcome, 'DISCLOSE', c.id);
        assert.deepEqual(d.supportingFacts, []);
      } else {
        assert.equal(d.outcome, 'ANSWER', c.id);
        assert.equal(Boolean(d.correctPremise), o.expect === 'CORRECT_PREMISE');
      }
    });
  }
});

test('recorded evidence review cannot be transferred to altered text or another obligation', () => {
  const recorded = loadRecorded().find(r => r.caseId === 'rep-04')!;
  const c = CORPUS.find(c => c.id === recorded.caseId)!;
  assert.deepEqual(recordedInput(c, recorded).independentlyRebound, ['t3.arrive-10']);
  const extraction = recorded.outputs.extraction!.replace('etwa 10 Minuten', 'genau 10 Minuten');
  assert.notEqual(extraction, recorded.outputs.extraction);
  assert.deepEqual(recordedInput(c, { ...recorded, outputs: { ...recorded.outputs, extraction } }).independentlyRebound, []);
  assert.deepEqual(recordedInput(CORPUS.find(c => c.id === 'rep-02')!, recorded).independentlyRebound, []);
});

test('recovery only reserves bounded time, cost and attempts across siblings', () => {
  const base = catalogInput(CORPUS.find(c => c.id === 'cmp-01')!);
  const request = { ...base.obligations[0], recovery: { estimatedMs: 40, estimatedCostUnits: 2 } };
  const input: TurnInput = { ...base, proposals: [], obligations: [request, { ...request, id: 'other' }] };
  const run = (remainingMs: number, remainingCostUnits: number, remainingAttempts: number) =>
    decideTurn({ ...input, recoveryBudget: { remainingMs, remainingCostUnits, remainingAttempts } }).obligations;
  for (const budgets of [[39, 4, 2], [80, 1, 2], [80, 4, 0], [Infinity, 4, 2]] as const)
    assert.deepEqual(run(budgets[0], budgets[1], budgets[2]).map(o => o.outcome), ['DISCLOSE', 'DISCLOSE']);
  for (const budgets of [[79, 4, 2], [80, 3, 2], [80, 4, 1]] as const) {
    const rows = run(budgets[0], budgets[1], budgets[2]);
    assert.deepEqual(rows.map(o => o.outcome), ['RECOVER', 'DISCLOSE']);
    assert.ok(rows.every(o => o.disclosureRequired && !o.supportingFacts.length));
  }
  assert.deepEqual(run(80, 4, 2).map(o => o.outcome), ['RECOVER', 'RECOVER']);
  assert.deepEqual(run(80, 4, 2), run(80, 4, 2));
});
