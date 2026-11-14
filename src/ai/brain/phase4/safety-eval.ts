import { scriptedCase, inventory, reviewed, NOW } from './fixtures';
import { shadowTurn, type EvidencePort, type Recovery } from './pipeline';
import type { Candidate, Receipt, Scope, Inventory } from '../evidence/bind';

export async function evaluateSafety() {
  const fixture = scriptedCase('var-cmp-01-sv');
  type Batch = ReturnType<EvidencePort['initial']>;
  const patch = (batch: Batch, change: Partial<Candidate['units'][number]>): Batch =>
    ({ ...batch, candidates: [{ ...batch.candidates[0], units: [{ ...fixture.unit, ...change }] }] });
  const receiptPatch = (batch: Batch, change: Partial<Receipt>): Batch =>
    ({ ...batch, receipts: [{ ...batch.receipts[0], ...change }] });
  const rows: { name: string; expected: string; batch?: (b: Batch, scope: Scope) => Batch; inventory?: Inventory }[] = [
    { name: 'cross_tenant_chunk', expected: 'CITATION_TENANT_OR_ID',
      inventory: { ...inventory, chunks: inventory.chunks.map(c => ({ ...c, businessId: 88 })) } },
    { name: 'stale_revision', expected: 'SOURCE_REVISION_OR_CHUNK_MISMATCH',
      inventory: { ...inventory, revisions: inventory.revisions.map(r => ({ ...r, revision: 'replacement' })) } },
    { name: 'stale_inventory', expected: 'CURRENT_TENANT_INVENTORY_UNAVAILABLE', inventory: { ...inventory, checkedAtMs: NOW - 60_001 } },
    { name: 'forged_citation', expected: 'UNIT_REVIEW_MISMATCH', batch: b => patch(b, { evidenceRefs: [{ ...fixture.unit.evidenceRefs[0], evidenceId: 'forged' }] }) },
    { name: 'altered_text', expected: 'UNIT_REVIEW_MISMATCH', batch: b => patch(b, { text: fixture.unit.text + ' Guaranteed.' }) },
    { name: 'unsupported_number', expected: 'UNIT_REVIEW_MISMATCH', batch: b => patch(b, { text: fixture.unit.text.replace('10', '24') }) },
    { name: 'missing_material_conditions', expected: 'UNIT_REVIEW_MISMATCH', batch: b => patch(b, { qualifiers: [] }) },
    { name: 'reversed_negation', expected: 'UNIT_REVIEW_MISMATCH', batch: b => patch(b, { negation: true }) },
    { name: 'conflicting_evidence', expected: 'SOURCE_OR_UNIT_CONFLICT', batch: b => receiptPatch(b, { conflict: 'CONFLICTING' }) },
    { name: 'missing_completeness', expected: 'COMPLETENESS_OR_CONFLICT_NOT_ESTABLISHED', batch: b => receiptPatch(b, { coverage: 'UNKNOWN' }) },
    { name: 'foreign_conversation_receipt', expected: 'REVIEW_SCOPE_OR_FRESHNESS_UNAVAILABLE',
      batch: (b, s) => receiptPatch(b, { scope: { ...s, conversationId: 'other' } }) },
    { name: 'old_turn_receipt', expected: 'REVIEW_SCOPE_OR_FRESHNESS_UNAVAILABLE', batch: (b, s) => receiptPatch(b, { scope: { ...s, turn: 2 } }) },
    { name: 'request_scope_changed', expected: 'REVIEW_SCOPE_OR_FRESHNESS_UNAVAILABLE',
      batch: (b, s) => receiptPatch(b, { scope: { ...s, requestDigest: 'changed' } }) },
    { name: 'recommendation_as_requirement', expected: 'QUESTION_MODALITY_NOT_COVERED', batch: (_, s) => reviewed(s, fixture.unit) },
    { name: 'unsupported_false_premise', expected: 'REVIEW_SCOPE_OR_FRESHNESS_UNAVAILABLE', batch: () => ({ candidates: [], receipts: [] }) },
  ];
  const results = [];
  for (const row of rows) {
    const mode = row.name === 'recommendation_as_requirement' ? 'requirement' : 'recommendation';
    const text = row.name === 'unsupported_false_premise' ? 'Jag hörde att parkering alltid är gratis. Stämmer det?' : fixture.text;
    const wire = JSON.stringify({ version: 1, readings: [{ intent: 'general_question', span: { start: 0, end: text.length },
      questionType: row.name === 'unsupported_false_premise' ? 'description' : mode,
      ...(row.name === 'unsupported_false_premise' ? { premise: { start: 0, end: text.indexOf('.') } } : {}) }] });
    const r = await shadowTurn({ ...fixture, text, wire, evidence: { inventory: row.inventory ?? inventory,
      initial: ([scope]) => {
        const b = reviewed(scope, fixture.unit);
        return row.batch?.(b, scope) ?? b;
      },
    } });
    const reason = r.bindings[0]?.reason;
    const unsafe = r.decision.obligations.some(o => o.outcome === 'ANSWER');
    results.push({ name: row.name, expected: row.expected, reason, unsafe, passed: !unsafe && reason === row.expected });
  }
  return results;
}

export async function evaluateRecovery() {
  const f = scriptedCase('var-cmp-01-sv');
  const rows = [];
  for (const mode of ['success', 'unresolved', 'conflict', 'attempt_limit', 'cost_limit', 'time_budget', 'timeout', 'wall_timeout', 'overcharge', 'not_eligible'] as const) {
    let elapsed = 0;
    let calls = 0;
    const recovery: Recovery = {
      eligible: mode === 'not_eligible' ? [] : ['t1o1', 't1o2'],
      attempts: mode === 'attempt_limit' ? 0 : 1, budgetMs: mode === 'time_budget' ? 4 : 20, budgetCostUnits: mode === 'cost_limit' ? 1 : 2,
      perAttemptMs: 5, perAttemptCostUnits: 2, now: () => elapsed,
      read: async (scope, _reservation, signal) => {
        calls++;
        if (mode === 'wall_timeout') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        elapsed += mode === 'timeout' ? 5 : 1;
        const r = reviewed(scope, f.unit);
        return { costUnits: mode === 'overcharge' ? 3 : 2,
          batch: mode === 'unresolved' ? { candidates: [], receipts: [] } :
            mode === 'conflict' ? { ...r, receipts: r.receipts.map(r => ({ ...r, conflict: 'CONFLICTING' as const })) } : r };
      },
    };
    const r = await shadowTurn({ ...f, evidence: { inventory,
      initial: ([first]) => mode === 'success' ? { candidates: [], receipts: [] } : reviewed(first, f.unit), recovery } });
    rows.push({ mode, calls, outcomes: r.recoveries, decisions: r.decision.obligations.map(o => o.outcome),
      reservedCostUnits: r.reservedCostUnits, reservedMs: r.reservedMs });
  }
  return rows;
}
