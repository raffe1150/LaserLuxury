import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryDiagnostic, recoveryFailureFields, recoveryOutcome, withRecoveryDiagnostics,
  withRepairDiagnostics, recoveryExtractionStage, RECOVERY_DIAGNOSTIC_ENTRY_LIMIT } from './recovery-diagnostics';

test('diagnostics retain a parser rejection across empty returns and repeated repair skips', async t => {
  const events: any[] = [];
  t.mock.method(console, 'info', (_tag, event) => events.push(JSON.parse(event)));
  await withRecoveryDiagnostics({ businessInfoTurnId: '11111111-1111-4111-8111-111111111111', businessId: 77 }, async () => {
    recoveryDiagnostic('repair_extraction', 'parser_failure');
    recoveryDiagnostic('completeness_repair', 'assessment_missing');
    recoveryDiagnostic('completeness_repair', 'repair_already_attempted');
    recoveryDiagnostic('single_policy', 'no_safe_sentence');
    assert.deepEqual(recoveryFailureFields(), { recoveryStage: 'repair_extraction', recoveryReason: 'parser_failure' });
    recoveryOutcome('fallback');
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].recoveryReason, 'parser_failure');
});

test('accepted recovery has no terminal failure status despite rejected siblings', async t => {
  const events: any[] = [];
  t.mock.method(console, 'info', (_tag, event) => events.push(JSON.parse(event)));
  const reply = await withRecoveryDiagnostics({}, async () => {
    recoveryDiagnostic('single_policy', 'overlapping_quotes');
    recoveryDiagnostic('completeness_repair', 'accepted', { attemptedFacts: 3, acceptedFacts: 2 });
    recoveryOutcome('accepted'); return 'unchanged';
  });
  assert.equal(reply, 'unchanged');
  assert.equal(events[0].outcome, 'accepted');
  assert.equal('recoveryReason' in events[0], false);
});

test('diagnostics aggregate and whitelist metadata without content or unsafe identifiers', async t => {
  const events: any[] = [];
  t.mock.method(console, 'info', (_tag, event) => events.push(JSON.parse(event)));
  await withRecoveryDiagnostics({ businessInfoTurnId: 'customer-phone-secret', businessId: 'private-value' }, async () => {
    for (let i = 0; i < 500; i++) recoveryDiagnostic('completeness_repair', 'claim_count_limit',
      { claimCount: 4, acceptedFacts: -10, candidateLength: Infinity, rawText: 'private-answer' } as any);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].decisions.length, 1);
  assert.ok(events[0].decisions.length <= RECOVERY_DIAGNOSTIC_ENTRY_LIMIT);
  assert.equal(events[0].decisions[0].count, 500);
  assert.deepEqual(events[0].counts.completeness_repair, { claimCount: 4, acceptedFacts: 0 });
  assert.doesNotMatch(JSON.stringify(events), /customer-phone|private-value|private-answer|rawText/u);
});

test('parallel tenants and original/repair phases remain isolated', async t => {
  const events: any[] = [];
  t.mock.method(console, 'info', (_tag, event) => events.push(JSON.parse(event)));
  await Promise.all([77, 88].map(businessId => withRecoveryDiagnostics({ businessId }, async () => {
    assert.equal(recoveryExtractionStage(), 'original_extraction');
    await withRepairDiagnostics(async () => {
      await Promise.resolve(); assert.equal(recoveryExtractionStage(), 'repair_extraction');
      recoveryDiagnostic('repair_extraction', 'accepted', { claimCount: businessId === 77 ? 2 : 3 });
    });
    assert.equal(recoveryExtractionStage(), 'original_extraction');
  })));
  assert.deepEqual(events.map(e => [e.businessId, e.counts.repair_extraction.claimCount]).sort(), [[77, 2], [88, 3]]);
});

test('the decision budget is bounded and omissions are explicit', async t => {
  const events: any[] = [];
  t.mock.method(console, 'info', (_tag, event) => events.push(JSON.parse(event)));
  const stages = ['single_policy', 'repair_seed', 'completeness_repair', 'compound', 'guard', 'coverage'] as const;
  const reasons = ['parser_failure', 'provider_failure', 'assessment_missing', 'quote_missing', 'quote_not_unique',
    'sentence_boundary', 'invalid_citation', 'overlapping_quotes', 'entailment_rejected', 'requested_aspect_rejected',
    'freshness_failure', 'claim_count_limit'] as const;
  await withRecoveryDiagnostics({}, async () => {
    for (const stage of stages) for (const reason of reasons) recoveryDiagnostic(stage, reason);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].decisions.length, RECOVERY_DIAGNOSTIC_ENTRY_LIMIT);
  assert.equal(events[0].omittedDecisionCount, stages.length * reasons.length - RECOVERY_DIAGNOSTIC_ENTRY_LIMIT);
});

test('throwing or rejected logging sinks cannot change return values or exceptions', async t => {
  t.mock.method(console, 'info', () => { throw new Error('sink'); });
  assert.equal(await withRecoveryDiagnostics({}, async () => { recoveryDiagnostic('guard', 'fallback'); return 42; }), 42);
  const error = new Error('business error');
  await assert.rejects(withRecoveryDiagnostics({}, async () => { throw error; }), e => e === error);
  t.mock.method(console, 'info', async () => { throw new Error('async sink'); });
  assert.equal(await withRecoveryDiagnostics({}, async () => 43), 43);
});
