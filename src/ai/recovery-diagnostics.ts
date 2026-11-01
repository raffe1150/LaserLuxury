import { AsyncLocalStorage } from 'node:async_hooks';
import { runOptionalDiagnostic } from './business-information-timing';

export type RecoveryStage = 'original_extraction' | 'candidate_quote_repair' | 'evidence_quote_repair' | 'repair_extraction' | 'original_entailment' | 'repair_entailment' |
  'requested_fact' | 'repair_requested_fact' | 'single_policy' | 'repair_seed' | 'completeness_repair' | 'compound' | 'coverage' | 'guard';
export type RecoveryReason = 'accepted' | 'eligible' | 'malformed_response' | 'parser_failure' | 'provider_failure' | 'provider_timeout' | 'assessment_missing' | 'ineligible' |
  'quote_missing' | 'quote_not_unique' | 'sentence_boundary' | 'invalid_citation' | 'candidate_coverage' |
  'overlapping_quotes' | 'unsafe_quote' | 'entailment_rejected' | 'absence_evidence_missing' | 'numerical_constraint' |
  'requested_aspect_rejected' | 'relevance_limit' | 'no_safe_sentence' | 'no_verified_seed' | 'repair_already_attempted' |
  'topic_limit' | 'evidence_missing' | 'topic_mismatch' | 'empty_candidate' | 'candidate_limit' | 'tool_calls' |
  'cached_verdict_reused' | 'verified_result_reused' | 'verification_limit' | 'no_factual_claims' | 'claim_count_limit' | 'no_accepted_facts' | 'freshness_failure' | 'source_conflict' |
  'verification_unavailable' | 'fallback' | 'exception';
type Counts = Partial<Record<'claimCount' | 'attemptedFacts' | 'acceptedFacts' | 'candidateLength' | 'relevanceChecks', number>>;
type Entry = { stage: RecoveryStage; reason: RecoveryReason; count: number };
type State = { businessInfoTurnId?: string; businessId?: number; entries: Map<string, Entry>; counts: Partial<Record<RecoveryStage, Counts>>;
  omittedDecisionCount: number; failure?: { recoveryStage: RecoveryStage; recoveryReason: RecoveryReason }; outcome: 'unselected' | 'accepted' | 'fallback' | 'rejected' };
const scope = new AsyncLocalStorage<{ state: State; phase?: 'repair' }>();
export const RECOVERY_DIAGNOSTIC_ENTRY_LIMIT = 64;
const failureRank = (stage: RecoveryStage, reason: RecoveryReason) =>
  ({ original_extraction: 10, candidate_quote_repair: 10, evidence_quote_repair: 10, original_entailment: 10, single_policy: 20, repair_seed: 20, compound: 20,
    requested_fact: 40, repair_requested_fact: 50, repair_extraction: 50, completeness_repair: 50, coverage: 60, guard: 70 }[stage]) +
  (reason === 'parser_failure' || reason === 'provider_failure' ? 9 : 0);
const terminalReasons = new Set<RecoveryReason>(['accepted', 'eligible', 'cached_verdict_reused', 'verified_result_reused', 'ineligible', 'repair_already_attempted', 'no_safe_sentence',
  'no_verified_seed', 'no_accepted_facts', 'assessment_missing', 'fallback']);

/** Request-local counters only. No text, citations, sessions, provider payloads or customer identifiers. */
export function recoveryDiagnostic(stage: RecoveryStage, reason: RecoveryReason, counts: Counts = {}): void {
  runOptionalDiagnostic(() => {
    const state = scope.getStore()?.state;
    if (!state) return;
    const key = `${stage}:${reason}`, entry = state.entries.get(key);
    if (entry) entry.count = Math.min(10000, entry.count + 1);
    else if (state.entries.size < RECOVERY_DIAGNOSTIC_ENTRY_LIMIT) state.entries.set(key, { stage, reason, count: 1 });
    else state.omittedDecisionCount = Math.min(1_000_000, state.omittedDecisionCount + 1);
    const safe: Counts = {};
    for (const key of ['claimCount', 'attemptedFacts', 'acceptedFacts', 'candidateLength', 'relevanceChecks'] as const) {
      if (Number.isFinite(counts[key])) safe[key] = Math.min(1_000_000, Math.max(0, Math.round(counts[key]!)));
    }
    state.counts[stage] = { ...state.counts[stage], ...safe };
    // A repeated once-only skip or an outer empty return must not hide the actual repair rejection.
    if ((!terminalReasons.has(reason) || !state.failure && reason !== 'accepted' && reason !== 'eligible' && reason !== 'cached_verdict_reused' && reason !== 'verified_result_reused') &&
        (!state.failure || failureRank(stage, reason) >= failureRank(state.failure.recoveryStage, state.failure.recoveryReason)))
      state.failure = { recoveryStage: stage, recoveryReason: reason };
  });
}
export function recoveryFailureFields() {
  return scope.getStore()?.state.failure || {};
}
export function recoveryOutcome(outcome: State['outcome']): void {
  runOptionalDiagnostic(() => { const state = scope.getStore()?.state; if (state) state.outcome = outcome; });
}
export function recoveryExtractionStage(): 'original_extraction' | 'repair_extraction' {
  return scope.getStore()?.phase === 'repair' ? 'repair_extraction' : 'original_extraction';
}
export function recoveryRequestedFactStage(): 'requested_fact' | 'repair_requested_fact' {
  return scope.getStore()?.phase === 'repair' ? 'repair_requested_fact' : 'requested_fact';
}
export function recoveryEntailmentStage(): 'original_entailment' | 'repair_entailment' {
  return scope.getStore()?.phase === 'repair' ? 'repair_entailment' : 'original_entailment';
}
export function withRepairDiagnostics<T>(work: () => Promise<T>): Promise<T> {
  const current = scope.getStore();
  return current ? scope.run({ ...current, phase: 'repair' }, work) : work();
}
export async function withRecoveryDiagnostics<T>(context: { businessInfoTurnId?: string; businessId?: unknown }, work: () => Promise<T>): Promise<T> {
  const state: State = { entries: new Map(), counts: {}, omittedDecisionCount: 0, outcome: 'unselected',
    ...(/^[a-f0-9-]{36}$/iu.test(context.businessInfoTurnId || '') ? { businessInfoTurnId: context.businessInfoTurnId } : {}),
    ...(Number.isSafeInteger(Number(context.businessId)) && Number(context.businessId) > 0 ? { businessId: Number(context.businessId) } : {}) };
  return scope.run({ state }, async () => {
    try { return await work(); }
    finally {
      runOptionalDiagnostic(() => console.info('[BusinessRecoveryDiagnostic]', JSON.stringify({
        schemaVersion: 'business-recovery-v1', businessInfoTurnId: state.businessInfoTurnId || null, businessId: state.businessId || null,
        outcome: state.outcome,
        ...(state.outcome === 'accepted' ? {} : state.failure),
        decisions: [...state.entries.values()], counts: state.counts, omittedDecisionCount: state.omittedDecisionCount,
      })));
    }
  });
}
