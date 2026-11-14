/**
 * Score aggregation. Only PASS and FAIL enter a rate; INDETERMINATE and
 * NOT_EVALUATED are counted and reported, never treated as passes. A rate is
 * withheld (null) when fewer than MIN_SAMPLE graded results exist.
 */
import { GRADES, METRICS, type EvalCase, type Grade, type Metric, type MetricResult, type Tier } from './types';

export const MIN_SAMPLE = 5;
export type CaseResult = Readonly<{ caseId: string; results: readonly MetricResult[] }>;
export type Cell = Readonly<Record<Grade, number> & { graded: number; passRate: number | null }>;

export function cell(grades: readonly Grade[]): Cell {
  const counts = Object.fromEntries(GRADES.map(g => [g, grades.filter(x => x === g).length])) as Record<Grade, number>;
  const graded = counts.PASS + counts.FAIL;
  return Object.freeze({ ...counts, graded, passRate: graded >= MIN_SAMPLE ? Math.round((counts.PASS / graded) * 1000) / 1000 : null });
}

export function aggregate(cases: readonly EvalCase[], results: readonly CaseResult[], tier?: Tier) {
  const byId = new Map(cases.map(c => [c.id, c]));
  const rows = results.flatMap(r => r.results.filter(m => !tier || m.tier === tier).map(m => ({ c: byId.get(r.caseId)!, m })));
  const metric = (k: Metric) => cell(rows.filter(r => r.m.metric === k).map(r => r.m.grade));
  const by = (key: (c: EvalCase) => string) => {
    const out: Record<string, Record<string, Cell>> = {};
    for (const k of METRICS) {
      const relevant = rows.filter(r => r.m.metric === k);
      for (const v of [...new Set(relevant.map(r => key(r.c)))].sort()) (out[v] ??= {})[k] = cell(relevant.filter(r => key(r.c) === v).map(r => r.m.grade));
    }
    return out;
  };
  return {
    overall: Object.fromEntries(METRICS.map(k => [k, metric(k)])) as Record<Metric, Cell>,
    byLanguage: by(c => c.language), byChannel: by(c => c.channel), byTenant: by(c => String(c.tenantId)), byFamily: by(c => c.family),
  };
}

/** Failure reasons with counts, for the weaknesses section of the report. */
export function failureReasons(results: readonly CaseResult[], tier?: Tier) {
  const out: Record<string, { count: number; cases: string[] }> = {};
  for (const r of results) for (const m of r.results) if (m.grade === 'FAIL' && (!tier || m.tier === tier)) {
    const k = `${m.metric}:${m.reason}`;
    (out[k] ??= { count: 0, cases: [] }).count++;
    if (out[k].cases.length < 12) out[k].cases.push(r.caseId);
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].count - a[1].count));
}
