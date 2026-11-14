import { createHash } from 'node:crypto';
import type { AnswerUnit, Evidence } from '../../business-information-answer-plan';
import type { Binding, QuestionType } from '../semantic/contracts';
import type { FactProposal, FactReview, ResolvedObligation } from '../decide-turn';

export const hashRecord = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const EVIDENCE_LIMITS = Object.freeze({ freshnessMs: 60_000, units: 16, receipts: 6, chunks: 16 });
export type Scope = Readonly<Binding & {
  turn: number;
  obligationId: string;
  requestDigest: string;
  language: string;
  questionType: QuestionType;
}>;
export type Candidate = Readonly<{ obligationId: string; units: readonly AnswerUnit[] }>;
/** Supplied by the independent Knowledge verifier/coverage authority. The
 * offline caller must keep this input separate from the semantic wire and
 * extraction candidates. A digest binds content but authenticates no caller. */
export type Receipt = Readonly<{
  scope: Scope;
  checkedAtMs: number;
  coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  conflict: 'CLEAR' | 'CONFLICTING' | 'UNKNOWN';
  correctPremise: boolean;
  units: readonly Readonly<{
    id: string;
    digest: string;
    relation: 'ENTAILED' | 'CONTRADICTED' | 'UNKNOWN';
    modality: AnswerUnit['modality'];
    negated: boolean;
    conditions: readonly string[];
    citations: readonly Readonly<{ evidenceId: string; digest: string }>[];
  }>[];
}>;
export type Inventory = Readonly<{
  tenantId: number;
  checkedAtMs: number;
  /** Authoritative revisions and chunks read together, never inferred from proposals. */
  revisions: readonly Readonly<{ sourceId: string; revision: string }>[];
  chunks: readonly Evidence[];
}>;
export type BindingResult = Readonly<{
  obligation: ResolvedObligation;
  status: 'BOUND' | 'INDETERMINATE' | 'REJECTED' | 'CONTRADICTORY';
  reason: string;
  proposals: readonly FactProposal[];
  reviews: readonly FactReview[];
}>;

const one = <T>(items: readonly T[]) => items.length === 1 ? items[0] : undefined;
const sameScope = (a: Scope, b: Scope) => a.tenantId === b.tenantId && a.conversationId === b.conversationId &&
  a.turn === b.turn && a.obligationId === b.obligationId && a.requestDigest === b.requestDigest &&
  a.language === b.language && a.questionType === b.questionType;
const fresh = (at: number, now: number) => Number.isSafeInteger(now) && Number.isSafeInteger(at) &&
  at >= 0 && at <= now && now - at <= EVIDENCE_LIMITS.freshnessMs;

function exactQuote(quote: string, source: Evidence) {
  if (!quote.trim()) return false;
  if (!source.citationRanges) return source.text.includes(quote);
  return source.citationRanges.some(({ start, end }) => Number.isInteger(start) && Number.isInteger(end) &&
    start >= 0 && end > start && end <= source.text.length && source.text.slice(start, end).includes(quote));
}

function covers(type: QuestionType, modality: AnswerUnit['modality']) {
  if (type === 'description') return true;
  if (type === 'recommendation') return modality === 'recommended';
  if (type === 'requirement') return modality === 'required';
  if (type === 'prohibition') return modality === 'prohibited';
  return modality === 'permitted' || modality === 'prohibited';
}

export function bindEvidence(scope: Scope, now: number, inventory: Inventory | undefined,
  candidates: readonly Candidate[], receipts: readonly Receipt[]): BindingResult {
  const base: ResolvedObligation = { id: scope.obligationId, resolution: 'KNOWLEDGE', coverage: 'UNKNOWN',
    conflict: 'UNKNOWN', requiredFactIds: [] };
  const fail = (status: BindingResult['status'], reason: string): BindingResult => ({
    status, reason, obligation: { ...base, conflict: status === 'CONTRADICTORY' ? 'CONFLICTING' : 'UNKNOWN' },
    proposals: [], reviews: [],
  });
  if (!inventory || inventory.tenantId !== scope.tenantId || !fresh(inventory.checkedAtMs, now))
    return fail('INDETERMINATE', 'CURRENT_TENANT_INVENTORY_UNAVAILABLE');
  if (inventory.chunks.length > EVIDENCE_LIMITS.chunks || inventory.revisions.length > EVIDENCE_LIMITS.chunks ||
      candidates.length > EVIDENCE_LIMITS.receipts || receipts.length > EVIDENCE_LIMITS.receipts)
    return fail('REJECTED', 'EVIDENCE_LIMIT');
  const candidate = one(candidates.filter(c => c.obligationId === scope.obligationId));
  const receipt = one(receipts.filter(r => sameScope(r.scope, scope)));
  if (!receipt || !fresh(receipt.checkedAtMs, now)) return fail('INDETERMINATE', 'REVIEW_SCOPE_OR_FRESHNESS_UNAVAILABLE');
  if (receipt.conflict === 'CONFLICTING' || receipt.units.some(u => u.relation === 'CONTRADICTED'))
    return fail('CONTRADICTORY', 'SOURCE_OR_UNIT_CONFLICT');
  if (receipt.conflict !== 'CLEAR' || receipt.coverage !== 'COMPLETE')
    return fail('INDETERMINATE', 'COMPLETENESS_OR_CONFLICT_NOT_ESTABLISHED');
  if (!candidate || !candidate.units.length || candidate.units.length > EVIDENCE_LIMITS.units ||
      candidate.units.length !== receipt.units.length || new Set(candidate.units.map(u => u?.id)).size !== candidate.units.length)
    return fail('INDETERMINATE', 'EXACT_UNIT_SET_UNAVAILABLE');
  const proposals: FactProposal[] = [];
  if (candidate.units.some(u => !u || typeof u.id !== 'string' || !u.id.trim()))
    return fail('REJECTED', 'UNIT_ID_UNAVAILABLE');
  for (const [index, unit] of candidate.units.entries()) {
    const row = one(receipt.units.filter(r => r.id === unit.id));
    if (!row || row.relation !== 'ENTAILED' || row.digest !== hashRecord(unit) ||
        unit.language !== scope.language || typeof unit.text !== 'string' || !unit.text.trim() || unit.text.length > 9000 ||
        typeof unit.negation !== 'boolean' || !Array.isArray(unit.qualifiers) ||
        !unit.qualifiers.every(q => typeof q === 'string') ||
        !Array.isArray(unit.evidenceRefs) || !Array.isArray(unit.facetIds) ||
        row.modality !== unit.modality ||
        row.negated !== unit.negation || hashRecord(row.conditions) !== hashRecord(unit.qualifiers) ||
        !unit.evidenceRefs.length || unit.evidenceRefs.length > EVIDENCE_LIMITS.chunks ||
        !unit.facetIds.length || unit.facetIds.some(id => typeof id !== 'string' || !id.trim()) ||
        row.citations.length !== new Set(unit.evidenceRefs.map(ref => ref?.evidenceId)).size)
      return fail('REJECTED', 'UNIT_REVIEW_MISMATCH');
    for (const [citationIndex, ref] of unit.evidenceRefs.entries()) {
      if (!ref || [ref.evidenceId, ref.sourceId, ref.version, ref.chunkId, ref.exactQuote].some(s => typeof s !== 'string'))
        return fail('REJECTED', 'INVALID_CITATION');
      const chunk = one(inventory.chunks.filter(c => c.id === ref.evidenceId));
      const head = one(inventory.revisions.filter(r => r.sourceId === ref.sourceId));
      const reviewed = one(row.citations.filter(c => c.evidenceId === ref.evidenceId));
      if (!chunk || chunk.businessId !== scope.tenantId) return fail('REJECTED', 'CITATION_TENANT_OR_ID');
      if (!ref.sourceId.trim() || !ref.version.trim() || !ref.chunkId.trim() ||
          chunk.sourceId !== ref.sourceId || chunk.chunkId !== ref.chunkId ||
          chunk.version !== ref.version || head?.revision !== ref.version)
        return fail('REJECTED', 'SOURCE_REVISION_OR_CHUNK_MISMATCH');
      if (!reviewed || reviewed.digest !== hashRecord(chunk) || !exactQuote(ref.exactQuote, chunk))
        return fail('REJECTED', 'CITATION_REVIEW_OR_QUOTE_MISMATCH');
      proposals.push({
        id: scope.obligationId + ':' + index + ':' + citationIndex,
        citation: { tenantId: scope.tenantId, sourceId: ref.sourceId, revision: ref.version },
        proposition: { payload: unit.text, modality: unit.modality, negated: unit.negation, conditions: [...unit.qualifiers] },
      });
    }
  }
  if (!candidate.units.some(unit => covers(scope.questionType, unit.modality)))
    return fail('REJECTED', 'QUESTION_MODALITY_NOT_COVERED');
  return {
    status: 'BOUND', reason: 'INDEPENDENT_REVIEW_CURRENT',
    obligation: { ...base, coverage: 'COMPLETE', conflict: 'CLEAR',
      requiredFactIds: proposals.map(p => p.id), correctPremise: receipt.correctPremise },
    proposals, reviews: proposals.map(p => ({ ...p, entailment: 'ENTAILED' })),
  };
}
