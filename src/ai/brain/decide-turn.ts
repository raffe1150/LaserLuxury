/** Offline policy over resolved obligations and independently checked evidence.
 * Callers supply attestations; this function does not establish their authenticity,
 * infer meaning from natural language, render text, or grant publication authority.
 */
export type Citation = Readonly<{ tenantId: number; sourceId: string; revision: string }>;
export type Proposition = Readonly<{
  // Full exact source excerpt, or canonical structured assertion (path and value).
  payload: string;
  modality: 'descriptive' | 'recommended' | 'required' | 'permitted' | 'prohibited';
  negated: boolean;
  conditions: readonly string[];
}>;
export type FactProposal = Readonly<{
  id: string;
  citation: Citation;
  proposition: Proposition;
}>;
export type FactReview = FactProposal & Readonly<{
  entailment: 'ENTAILED' | 'REJECTED' | 'UNKNOWN';
}>;
export type ResolvedObligation = Readonly<{
  id: string;
  resolution: 'KNOWLEDGE' | 'AMBIGUOUS' | 'BOOKING_ACTION';
  // Independent source-to-obligation review, including scope, relevance and
  // completeness of the entire required set (never a model's coverage flag).
  coverage: 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  conflict: 'CLEAR' | 'CONFLICTING' | 'UNKNOWN';
  requiredFactIds: readonly string[];
  correctPremise?: boolean;
  route?: string;
  recovery?: Readonly<{ estimatedMs: number; estimatedCostUnits: number }>;
}>;
export type TurnInput = Readonly<{
  tenantId: number;
  obligations: readonly ResolvedObligation[];
  currentRevisions: readonly Citation[];
  proposals: readonly FactProposal[];
  reviews: readonly FactReview[];
  recoveryBudget?: Readonly<{ remainingMs: number; remainingCostUnits: number; remainingAttempts: number }>;
}>;
export type Outcome = 'ANSWER' | 'DISCLOSE' | 'RECOVER' | 'CLARIFY' | 'HANDOFF';
export type FactCheck = Readonly<{
  factId: string;
  citation?: Citation;
  status: 'VERIFIED' | 'MISSING_OR_AMBIGUOUS_PROPOSAL' | 'FOREIGN_TENANT' | 'REVISION_NOT_CURRENT' |
    'NO_BOUND_ENTAILMENT' | 'PAYLOAD_DIFFERS' | 'CONDITIONS_DIFFER' | 'MODALITY_DIFFERS' | 'NEGATION_DIFFERS';
}>;
export type ObligationDecision = Readonly<{
  obligationId: string;
  outcome: Outcome;
  reason: string;
  coverage: ResolvedObligation['coverage'];
  conflict: ResolvedObligation['conflict'];
  checks: readonly FactCheck[];
  supportingFacts: readonly FactProposal[];
  correctPremise?: true;
  route?: string;
  disclosureRequired: boolean;
}>;
export type TurnDecision = Readonly<{
  publication: 'OFFLINE_ONLY';
  obligations: readonly ObligationDecision[];
  safePartial: boolean;
}>;

const sameCitation = (a: Citation, b: Citation) =>
  a.tenantId === b.tenantId && a.sourceId === b.sourceId && a.revision === b.revision;
const sameConditions = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((item, i) => item === sorted[i]);
};
const unique = <T>(rows: readonly T[]): T | undefined => rows.length === 1 ? rows[0] : undefined;
const validUnits = (n: number) => Number.isSafeInteger(n) && n >= 0;

export function decideTurn(input: TurnInput): TurnDecision {
  let ms = input.recoveryBudget?.remainingMs ?? 0;
  let cost = input.recoveryBudget?.remainingCostUnits ?? 0;
  let attempts = input.recoveryBudget?.remainingAttempts ?? 0;
  const counts = new Map<string, number>();
  for (const o of input.obligations) counts.set(o.id, (counts.get(o.id) ?? 0) + 1);
  const obligations = input.obligations.map((o): ObligationDecision => {
    const checks: FactCheck[] = [];
    const facts: FactProposal[] = [];
    const result = (outcome: Outcome, reason: string): ObligationDecision => ({
      obligationId: o.id, outcome, reason, coverage: o.coverage, conflict: o.conflict, checks,
      supportingFacts: outcome === 'ANSWER' ? facts : [],
      ...(outcome === 'ANSWER' && o.correctPremise === true ? { correctPremise: true } : {}),
      ...(outcome === 'HANDOFF' && o.route ? { route: o.route } : {}),
      disclosureRequired: outcome === 'DISCLOSE' || outcome === 'RECOVER',
    });
    if (!o.id || counts.get(o.id) !== 1) return result('DISCLOSE', 'INVALID_OBLIGATION_ID');
    if (o.resolution === 'BOOKING_ACTION') return result('HANDOFF', 'BOOKING_AUTHORITY_REQUIRED');
    if (o.resolution === 'AMBIGUOUS') return result('CLARIFY', 'REQUEST_UNRESOLVED');
    if (o.resolution !== 'KNOWLEDGE') return result('DISCLOSE', 'UNRECOGNIZED_OBLIGATION');

    for (const factId of new Set(o.requiredFactIds)) {
      const proposal = unique(input.proposals.filter(f => f.id === factId));
      if (!proposal) { checks.push({ factId, status: 'MISSING_OR_AMBIGUOUS_PROPOSAL' }); continue; }
      const { citation, proposition } = proposal;
      const current = unique(input.currentRevisions.filter(s =>
        s.tenantId === input.tenantId && s.sourceId === citation.sourceId));
      const review = unique(input.reviews.filter(r => r.id === factId && sameCitation(r.citation, citation)));
      const status = citation.tenantId !== input.tenantId ? 'FOREIGN_TENANT'
        : !citation.sourceId || !citation.revision || current?.revision !== citation.revision ? 'REVISION_NOT_CURRENT'
        : review?.entailment !== 'ENTAILED' ? 'NO_BOUND_ENTAILMENT'
        : !proposition.payload.trim() || proposition.payload !== review.proposition.payload ? 'PAYLOAD_DIFFERS'
        : !sameConditions(proposition.conditions, review.proposition.conditions) ? 'CONDITIONS_DIFFER'
        : proposition.modality !== review.proposition.modality ? 'MODALITY_DIFFERS'
        : proposition.negated !== review.proposition.negated ? 'NEGATION_DIFFERS'
        : 'VERIFIED';
      checks.push({ factId, citation, status });
      if (status === 'VERIFIED') facts.push(proposal);
    }
    if (o.conflict !== 'CLEAR') return result('DISCLOSE', o.conflict === 'CONFLICTING' ? 'SOURCE_CONFLICT' : 'CONFLICT_NOT_CHECKED');
    if (o.coverage === 'COMPLETE' && checks.length && checks.every(c => c.status === 'VERIFIED'))
      return result('ANSWER', 'COMPLETE_VERIFIED_OBLIGATION');

    // Only an explicit bounded recovery plan can suggest another read/check.
    // Never auto-retry rejected proposals or override a conflict.
    const r = o.recovery;
    if (r && checks.every(c => c.status === 'VERIFIED' || c.status === 'MISSING_OR_AMBIGUOUS_PROPOSAL') &&
        [r.estimatedMs, r.estimatedCostUnits, ms, cost, attempts].every(validUnits) &&
        r.estimatedMs > 0 && attempts > 0 && r.estimatedMs <= ms && r.estimatedCostUnits <= cost) {
      ms -= r.estimatedMs;
      cost -= r.estimatedCostUnits;
      attempts--;
      return result('RECOVER', 'BOUNDED_RECOVERY_CANDIDATE');
    }
    return result('DISCLOSE', o.coverage !== 'COMPLETE' ? 'COVERAGE_NOT_COMPLETE' : 'REQUIRED_EVIDENCE_NOT_VERIFIED');
  });
  return { publication: 'OFFLINE_ONLY', obligations,
    safePartial: obligations.some(o => o.outcome === 'ANSWER') && obligations.some(o => o.disclosureRequired) };
}
