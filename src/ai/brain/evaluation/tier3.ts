/**
 * Tier 3 — authorized real-model evaluation. INTERFACE AND SAFEGUARDS ONLY.
 * Phase 2 never dispatches: `dispatchTier3` always throws. The preflight is a
 * pure function over caller-supplied ledger CONTENTS; nothing is read from or
 * written to disk here, and no provider client is imported.
 *
 * Limits mirror the owner-approved experiment limits in
 * tests/helpers/semantic-recovery-eval.ts (per request $0.15, cumulative $4.00;
 * pinned by a test). The existing append-only ledger format (calls[],
 * estimatedUsd, unmeteredReserveUsd, pinned historical prefix) is reused.
 */
import { createHash } from 'node:crypto';

export const TIER3_LIMITS = Object.freeze({ perRequestUsd: 0.15, cumulativeUsd: 4.0 });

export type Tier3Plan = Readonly<{
  authorizationId: string;
  /** Owner's explicit approval for exactly this plan (sha256 of the canonical plan without this field). */
  approval: Readonly<{ approvedBy: string; approvedAt: string; planSha256: string }>;
  caseIds: readonly string[];
  model: string;
  stagesPerCase: number;
  /** Conservative ceiling per provider request, never above TIER3_LIMITS.perRequestUsd. */
  perRequestCeilingUsd: number;
  /** Hard cap on dispatched provider requests, including retries. */
  maxProviderAttempts: number;
  /** Cumulative ceiling for this run; total reserved + planned must stay under TIER3_LIMITS.cumulativeUsd. */
  runCeilingUsd: number;
  ledger: Readonly<{ path: string; expectedSha256: string; historicalRows: number; historicalPrefixSha256: string }>;
}>;
export type LedgerContents = Readonly<{ bytes: string }>;
export type Tier3Preflight = Readonly<{ ok: boolean; problems: readonly string[]; reservedUsd: number; plannedUsd: number; requests: number }>;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const tier3PlanSha256 = (plan: Omit<Tier3Plan, 'approval'>) => sha256(JSON.stringify(plan));

/** Pure check. Every problem is reported; ok only when there are none. */
export function preflightTier3(plan: Tier3Plan, ledger: LedgerContents | null): Tier3Preflight {
  const problems: string[] = [];
  const { approval, ...unsigned } = plan;
  if (!plan.authorizationId.trim()) problems.push('AUTHORIZATION_ID_MISSING');
  if (!approval?.approvedBy?.trim() || !approval?.approvedAt?.trim()) problems.push('OWNER_APPROVAL_MISSING');
  if (approval?.planSha256 !== tier3PlanSha256(unsigned)) problems.push('APPROVAL_DOES_NOT_MATCH_PLAN');
  if (!plan.caseIds.length || new Set(plan.caseIds).size !== plan.caseIds.length) problems.push('CASE_LIST_INVALID');
  if (!(plan.perRequestCeilingUsd > 0) || plan.perRequestCeilingUsd > TIER3_LIMITS.perRequestUsd) problems.push('PER_REQUEST_CEILING_EXCEEDS_LIMIT');
  const requests = plan.caseIds.length * plan.stagesPerCase;
  if (!Number.isSafeInteger(plan.maxProviderAttempts) || plan.maxProviderAttempts <= 0 || plan.maxProviderAttempts < requests) problems.push('ATTEMPT_LIMIT_INVALID');
  const plannedUsd = Math.max(requests, plan.maxProviderAttempts) * plan.perRequestCeilingUsd;
  if (plannedUsd > plan.runCeilingUsd) problems.push('PLAN_EXCEEDS_RUN_CEILING');
  let reservedUsd = Number.POSITIVE_INFINITY;
  if (!ledger) problems.push('LEDGER_UNAVAILABLE');
  else {
    if (sha256(ledger.bytes) !== plan.ledger.expectedSha256) problems.push('LEDGER_CHANGED_SINCE_PLAN');
    try {
      const parsed = JSON.parse(ledger.bytes);
      if (!Array.isArray(parsed.calls) || parsed.calls.length < plan.ledger.historicalRows ||
        sha256(JSON.stringify(parsed.calls.slice(0, plan.ledger.historicalRows))) !== plan.ledger.historicalPrefixSha256) problems.push('LEDGER_HISTORY_CHANGED');
      if (!(parsed.estimatedUsd >= 0) || !(parsed.unmeteredReserveUsd >= 0)) problems.push('LEDGER_TOTALS_INVALID');
      else reservedUsd = parsed.estimatedUsd + parsed.unmeteredReserveUsd;
    } catch { problems.push('LEDGER_UNREADABLE'); }
  }
  if (reservedUsd + plannedUsd > TIER3_LIMITS.cumulativeUsd) problems.push('CUMULATIVE_LIMIT_WOULD_BE_EXCEEDED');
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems), reservedUsd, plannedUsd, requests });
}

export class Tier3DispatchDisabled extends Error {
  constructor() { super('TIER3_DISPATCH_DISABLED_IN_PHASE_2'); this.name = 'Tier3DispatchDisabled'; }
}
/** Phase 2: never dispatches, whatever the plan or preflight says. */
export function dispatchTier3(_plan: Tier3Plan, _preflight: Tier3Preflight): never {
  throw new Tier3DispatchDisabled();
}
