import type { FactProposal, FactReview, ResolvedObligation, TurnInput } from '../decide-turn';
import { CORPUS } from '../evaluation/corpus';
import { catalogInput } from './phase3-input';

// Inject faults into the same Phase 2 source-backed obligations, preserving
// the independent review so tampering cannot update its own expected answer.
export function negativeControls() {
  const input = (id: string) => catalogInput(CORPUS.find(c => c.id === id)!);
  const base = input('cmp-01');
  const first = base.obligations[0];
  const p = base.proposals.find(p => p.id === first.requiredFactIds[0])!;
  const replace = (proposal: FactProposal): TurnInput => ({ ...base, proposals: base.proposals.map(f => f.id === p.id ? proposal : f) });
  const change = (fields: Partial<FactProposal['proposition']>) => replace({ ...p, proposition: { ...p.proposition, ...fields } });
  const obligation = (fields: Partial<ResolvedObligation>): TurnInput =>
    ({ ...base, obligations: [{ ...first, ...fields }, ...base.obligations.slice(1)] });
  const review = (entailment: FactReview['entailment']): TurnInput =>
    ({ ...base, reviews: base.reviews.map(r => r.id === p.id ? { ...r, entailment } : r) });
  const multi = input('cmp-03');
  const rows: { name: string; input: TurnInput; blocked: string; reason: string; sibling?: string }[] = [
    { name: 'missing_first_visit_and_approximation', input: change({ conditions: [] }), blocked: first.id, reason: 'CONDITIONS_DIFFER' },
    { name: 'recommendation_upgraded_to_requirement', input: change({ modality: 'required' }), blocked: first.id, reason: 'MODALITY_DIFFERS' },
    { name: 'unsupported_numeric_value', input: change({ payload: p.proposition.payload.replace('10', '24') }), blocked: first.id, reason: 'PAYLOAD_DIFFERS' },
    { name: 'unsupported_added_claim', input: change({ payload: p.proposition.payload + ' Parking is free.' }), blocked: first.id, reason: 'PAYLOAD_DIFFERS' },
    { name: 'stale_revision', input: replace({ ...p, citation: { ...p.citation, revision: 'superseded' } }), blocked: first.id, reason: 'REVISION_NOT_CURRENT' },
    { name: 'foreign_source', input: replace({ ...p, citation: { ...p.citation, tenantId: 88 } }), blocked: first.id, reason: 'FOREIGN_TENANT' },
    { name: 'model_complete_without_entailment', input: review('UNKNOWN'), blocked: first.id, reason: 'NO_BOUND_ENTAILMENT' },
    { name: 'verifier_contradicted', input: review('REJECTED'), blocked: first.id, reason: 'NO_BOUND_ENTAILMENT' },
    { name: 'unknown_conflict_state', input: obligation({ conflict: 'UNKNOWN' }), blocked: first.id, reason: 'CONFLICT_NOT_CHECKED' },
    { name: 'empty_complete_claim', input: obligation({ requiredFactIds: [] }), blocked: first.id, reason: 'REQUIRED_EVIDENCE_NOT_VERIFIED' },
    { name: 'ambiguous_current_revision', input: { ...base, currentRevisions: [...base.currentRevisions, { ...p.citation, revision: 'another-head' }] }, blocked: first.id, reason: 'REVISION_NOT_CURRENT' },
    { name: 'recommendation_does_not_resolve_requirement', input: base, blocked: base.obligations[1].id, reason: 'COVERAGE_NOT_COMPLETE', sibling: first.id },
    { name: 'missing_fact_in_multi_fact_obligation', input: { ...multi, proposals: multi.proposals.filter(p => p.id !== multi.obligations[1].requiredFactIds[1]) },
      blocked: multi.obligations[1].id, reason: 'MISSING_OR_AMBIGUOUS_PROPOSAL', sibling: multi.obligations[0].id },
  ];
  const neg = input('cmp-06');
  const n = neg.proposals.find(x => x.proposition.negated)!;
  rows.push({ name: 'removed_source_negation', input: { ...neg, proposals: neg.proposals.map(x => x === n ? { ...x, proposition: { ...x.proposition, negated: false } } : x) },
    blocked: neg.obligations.find(o => o.requiredFactIds.includes(n.id))!.id, reason: 'NEGATION_DIFFERS', sibling: neg.obligations[0].id });
  return rows;
}
