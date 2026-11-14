/**
 * Offline baseline orchestration. Deterministic: no timestamps, no randomness,
 * no network, no writes (the caller decides whether to persist the report).
 */
import type { EvalCase, MetricResult } from './types';
import { CORPUS } from './corpus';
import { loadSources } from './sources';
import { FACTS } from './facts';
import { semanticStats, validateCorpus } from './validate';
import { evaluateDeterministic, evaluatePolicyOracle } from './tier1';
import { evaluateServerLanguage } from './tier1-language';
import { evaluateDelivered, evaluateReplay, loadDelivered, loadRecorded } from './tier2';
import { aggregate, failureReasons, type CaseResult } from './scorecard';

export const BASELINE_SCHEMA = 'odinlink-eval-baseline-v1' as const;

const count = <T>(xs: readonly T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

export async function runBaseline(cases: readonly EvalCase[] = CORPUS) {
  const issues = validateCorpus(cases);
  if (issues.length) throw new Error(`corpus invalid: ${JSON.stringify(issues.slice(0, 5))}`);
  const language = process.env.NODE_ENV === 'test' ? await evaluateServerLanguage(cases) : undefined;
  const deterministic: CaseResult[] = cases.map(c => ({ caseId: c.id, results: [...evaluateDeterministic(c), language?.get(c.id) ??
    { metric: 'language' as const, tier: 'T1_DETERMINISTIC' as const, grade: 'NOT_EVALUATED' as const, reason: 'server_language_boundary_requires_NODE_ENV_test' }] }));
  const oracle: Record<'v2' | 'source-exhaustive-v2', CaseResult[]> = { v2: [], 'source-exhaustive-v2': [] };
  for (const protocol of ['v2', 'source-exhaustive-v2'] as const)
    for (const c of cases) oracle[protocol].push({ caseId: c.id, results: await evaluatePolicyOracle(c, protocol) });
  const byId = new Map(cases.map(c => [c.id, c]));
  const replays: (CaseResult & { replayId: string; drift: string[]; stages: string[]; fallbackReason: string | null; publishedUnits: number })[] = [];
  for (const r of loadRecorded()) {
    const c = byId.get(r.caseId);
    if (!c) continue;
    const { run, results } = await evaluateReplay(r, c);
    replays.push({ caseId: c.id, replayId: r.id, results, drift: run.drift, stages: run.stages, fallbackReason: run.fallbackReason, publishedUnits: run.units.length });
  }
  const delivered = loadDelivered().filter(d => byId.has(d.caseId)).map(d => ({ caseId: d.caseId, deliveredId: d.id, origin: d.origin, results: evaluateDelivered(d, byId.get(d.caseId)!) }));
  const strip = (rs: readonly MetricResult[]) => rs.map(({ exercised: _e, substituted: _s, ...m }) => m);
  return {
    schema: BASELINE_SCHEMA,
    corpus: {
      ...semanticStats(cases),
      facts: FACTS.length,
      sources: loadSources().map(s => ({ key: s.key, tenantId: s.tenantId, business: s.businessName, type: s.businessType, title: s.title, status: s.status,
        revision: s.revision, file: s.provenance.file, fileSha256: s.provenance.fileSha256, capturedAt: s.provenance.capturedAt })),
      byLanguage: count(cases, c => c.language), byChannel: count(cases, c => c.channel), byTenant: count(cases, c => String(c.tenantId)),
      byFamily: count(cases, c => c.family), byReview: count(cases, c => c.provenance.review),
      byExpectation: count(cases.flatMap(c => c.obligations), o => o.expect),
    },
    tier1: {
      deterministic: aggregate(cases, deterministic, 'T1_DETERMINISTIC'), deterministicFailures: failureReasons(deterministic),
      /** Degraded mode only: the language V1 falls back to when its semantic resolver yields nothing. Not a grade of normal operation. */
      languageUnderResolverOutage: language ? Object.fromEntries(['sv', 'en', 'de', 'es', 'fa', 'ar'].map(l => {
        const rs = cases.filter(c => c.language === l).map(c => language.get(c.id)!.evidence as any);
        return [l, { cases: rs.length, resolverConsulted: rs.filter(e => e.semanticResolverConsulted).length,
          fallbackCorrect: rs.filter(e => (e.expected as string[]).includes(e.resolved)).length }];
      })) : null,
      oracle: Object.fromEntries((['v2', 'source-exhaustive-v2'] as const).map(p => [p, { scores: aggregate(cases, oracle[p], 'T1_POLICY_ORACLE'), failures: failureReasons(oracle[p]),
        notEvaluated: count(oracle[p].flatMap(r => r.results.filter(m => m.grade === 'NOT_EVALUATED' && m.metric === 'correct_complete')), m => m.reason.split(':')[1]) }])),
    },
    tier2: {
      replays: replays.map(r => ({ replayId: r.replayId, caseId: r.caseId, drift: r.drift, stages: r.stages, fallbackReason: r.fallbackReason, publishedUnits: r.publishedUnits, results: strip(r.results) })),
      delivered: delivered.map(d => ({ deliveredId: d.deliveredId, caseId: d.caseId, origin: d.origin, results: strip(d.results) })),
      scores: aggregate(cases, [...replays, ...delivered]),
    },
    perCase: {
      deterministic: Object.fromEntries(deterministic.map(r => [r.caseId, strip(r.results).map(m => `${m.metric}:${m.grade}:${m.reason}`)])),
      oracle: Object.fromEntries((['v2', 'source-exhaustive-v2'] as const).map(p => [p, Object.fromEntries(oracle[p].map(r => [r.caseId,
        strip(r.results).map(m => `${m.metric}:${m.grade}:${m.reason}`)]))])),
    },
  };
}
