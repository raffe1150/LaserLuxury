/** Offline-only in-memory Tier B budget for tests. It mirrors the guarantees a
 * real ledger must give (per-request ceiling, cumulative ceiling including
 * historical and unknown-retained exposure, duplicate refusal) and logs every
 * operation in order so tests can prove reserve-before-dispatch. Never used by
 * production code. */
import { NATURAL_COMPOSER_BUDGET_LIMITS, NATURAL_COMPOSER_RATE_CARDS, type NaturalComposerBudget, type NaturalQuote } from '../../src/ai/natural-composer-budget';

export type BudgetLogEntry = { op: 'reserve' | 'deny' | 'settle' | 'unknown'; requestId: string; model: string; stage: string; nano: number; reason?: string };
export function recordingNaturalBudget(log: BudgetLogEntry[], opts: { historicalNanoUsd?: number; deny?: (q: NaturalQuote) => boolean;
  throwOn?: (q: NaturalQuote) => boolean; approvedRateVersions?: string[] } = {}): NaturalComposerBudget & { exposureNanoUsd(): number } {
  const held = new Map<string, number>(), seen = new Set<string>();
  let known = opts.historicalNanoUsd ?? 0, unknown = 0;
  const exposure = () => known + unknown + [...held.values()].reduce((a, b) => a + b, 0);
  return {
    id: 'test-recording-budget', accounting: 'test',
    approvedRateVersions: opts.approvedRateVersions ?? [...new Set(Object.values(NATURAL_COMPOSER_RATE_CARDS).map(c => c.version))],
    exposureNanoUsd: exposure,
    async reserve(q) {
      if (opts.throwOn?.(q)) throw new Error('LEDGER_STATE_UNKNOWN');
      if (opts.deny?.(q) || seen.has(q.requestId) || q.ceilingNanoUsd > NATURAL_COMPOSER_BUDGET_LIMITS.perRequestNanoUsd ||
          exposure() + q.ceilingNanoUsd > NATURAL_COMPOSER_BUDGET_LIMITS.cumulativeNanoUsd) {
        log.push({ op: 'deny', requestId: q.requestId, model: q.model, stage: q.stage, nano: q.ceilingNanoUsd }); return null;
      }
      seen.add(q.requestId); held.set(q.requestId, q.ceilingNanoUsd);
      log.push({ op: 'reserve', requestId: q.requestId, model: q.model, stage: q.stage, nano: q.ceilingNanoUsd });
      return { reservationId: q.requestId };
    },
    async settle(id, q, actual) {
      if (!held.has(id) || actual > held.get(id)!) throw new Error('SETTLEMENT_OUTSIDE_RESERVATION');
      held.delete(id); known += actual; log.push({ op: 'settle', requestId: id, model: q.model, stage: q.stage, nano: actual });
    },
    async retainUnknown(id, q, reason) {
      const amount = held.get(id) ?? q.ceilingNanoUsd; held.delete(id); unknown += amount;
      log.push({ op: 'unknown', requestId: id, model: q.model, stage: q.stage, nano: amount, reason });
    },
  };
}
