import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decideTurn, type TurnDecision } from '../decide-turn';
import type { runBaseline } from '../evaluation/baseline';
import { CORPUS, tenantOf } from '../evaluation/corpus';
import { REPO_ROOT, loadSources, source } from '../evaluation/sources';
import { fact } from '../evaluation/facts';
import { deterministicSignals, evaluatePolicyOracle } from '../evaluation/tier1';
import { loadDelivered, loadRecorded } from '../evaluation/tier2';
import { validateCorpus } from '../evaluation/validate';
import type { EvalCase } from '../evaluation/types';
import { negativeControls } from './negative-controls';
import { catalogInput, isAnswer, sourcePayload } from './phase3-input';
import { digest, recordedInput } from './recorded-input';

export const BASELINE_HASH = 'c92b7958b6f1c02bb4b36b9aac8d108f25dbd7db1e157607b86f7e59e676d37a';
const protocols = ['v2', 'source-exhaustive-v2'] as const;

function readBaseline() {
  const bytes = readFileSync(new URL('docs/validation/brain-v2-phase2-baseline-20261114/report.json', REPO_ROOT));
  if (createHash('sha256').update(bytes).digest('hex') !== BASELINE_HASH) throw new Error('Phase 2 report changed');
  const baseline = JSON.parse(bytes.toString('utf8')) as Awaited<ReturnType<typeof runBaseline>>;
  const issues = validateCorpus(CORPUS);
  if (issues.length) throw new Error(JSON.stringify(issues));
  for (const s of loadSources()) {
    const pinned = baseline.corpus.sources.find(p => p.key === s.key);
    if (pinned?.revision !== s.revision || pinned.fileSha256 !== s.provenance.fileSha256 || pinned.status !== s.status)
      throw new Error('Phase 2 source changed: ' + s.key);
  }
  return baseline;
}

function checkCandidate(c: EvalCase, d: TurnDecision) {
  return c.obligations.flatMap((o, i) => {
    const result = d.obligations[i];
    if (result.outcome !== 'ANSWER') return [];
    const ids = result.supportingFacts.map(f => f.id);
    const invalid = !isAnswer(o) || c.evidenceProfile === 'STALE' ||
      ids.length !== o.facts.length || o.facts.some(id => !ids.includes(id)) ||
      result.supportingFacts.some(p => {
        const f = fact(p.id), s = source(f.source);
        return s.tenantId !== tenantOf(c.tenantId) || s.status !== 'CURRENT' ||
          p.citation.tenantId !== s.tenantId || p.citation.sourceId !== s.sourceId || p.citation.revision !== s.revision ||
          p.proposition.payload !== sourcePayload(f) ||
          p.proposition.modality !== f.modality || p.proposition.negated !== f.negation ||
          JSON.stringify(p.proposition.conditions) !== JSON.stringify(f.conditions ?? []) ||
          (c.forbiddenStaleText ?? []).some(t => p.proposition.payload.includes(t));
      }) || Boolean(result.correctPremise) !== (o.expect === 'CORRECT_PREMISE');
    return invalid ? [o.id] : [];
  });
}

const partialOpportunity = (c: EvalCase) => c.obligations.some(isAnswer) && c.obligations.some(o => o.expect === 'DISCLOSE');
const fullPartial = (c: EvalCase, d: TurnDecision) => partialOpportunity(c) && d.safePartial &&
  checkCandidate(c, d).length === 0 && c.obligations.every((o, i) => isAnswer(o) ? d.obligations[i].outcome === 'ANSWER'
    : o.expect !== 'DISCLOSE' || d.obligations[i].disclosureRequired);

export async function compare() {
  const baseline = readBaseline();
  const cases = [];
  for (const c of CORPUS) {
    const candidate = decideTurn(catalogInput(c));
    const signals = deterministicSignals(c);
    const oracle = [];
    for (const protocol of protocols) {
      const metrics = await evaluatePolicyOracle(c, protocol);
      const grades = metrics.map(m => `${m.metric}:${m.grade}:${m.reason}`);
      if (JSON.stringify(grades) !== JSON.stringify(baseline.perCase.oracle[protocol][c.id])) {
        throw new Error(`V1 oracle drift: ${c.id} / ${protocol}`);
      }
      const evidence = metrics.find(m => m.evidence)?.evidence;
      const publishedFacts = (evidence?.publishedFacts ?? []) as string[];
      oracle.push({ protocol, metrics: grades, evidence: evidence ?? null,
        perObligation: c.obligations.map((o, i) => ({
          id: o.id,
          v1: evidence?.publishable === false ? 'TURN_FALLBACK'
            : isAnswer(o) && evidence?.publishable === true && o.facts.every(id => publishedFacts.includes(id))
              ? 'ALL_REQUIRED_FACT_IDS_PRESENT' : 'INDETERMINATE_OBLIGATION',
          v2: candidate.obligations[i].outcome,
        })),
      });
    }
    cases.push({ id: c.id, semanticKey: c.semanticKey, language: c.language, channelLabel: c.channel, family: c.family,
      evidenceProfile: c.evidenceProfile, review: c.provenance.review, v1: {
        deterministic: baseline.perCase.deterministic[c.id],
        perObligation: c.obligations.map((o, i) => ({
          id: o.id,
          v1: o.expect === 'ROUTE' ? (signals.intent === o.route ? 'MATCHING_INTENT'
            : o.route === 'availability' && (signals.availability || signals.intent === 'new_booking')
              ? 'AVAILABILITY_COMPATIBLE_SIGNAL' : 'ROUTE_NOT_ESTABLISHED')
            : o.expect === 'CLARIFY' && signals.clarification ? 'TURN_CLARIFICATION_SIGNAL' : 'INDETERMINATE_OBLIGATION',
          v2: candidate.obligations[i].outcome,
        })), signals: { intent: signals.intent, action: signals.action,
          information: signals.information, availability: signals.availability, clarification: !!signals.clarification },
        oracle,
      }, v2: candidate, partialOpportunity: partialOpportunity(c), fullPartial: fullPartial(c, candidate),
      unsafeObligationIds: checkCandidate(c, candidate),
    });
  }
  // V1 uses the pinned, byte-reproduced Phase 2 replay/delivery outcomes.
  // V2 reads the same recorded outputs and admits only an independently
  // reviewed unit; no ideal output is backfilled into the recorded lane.
  const recordings = loadRecorded().map(r => {
    const c = CORPUS.find(c => c.id === r.caseId)!;
    const replay = baseline.tier2.replays.find(b => b.replayId === r.id)!;
    const { input, checks, independentlyRebound } = recordedInput(c, r);
    const candidate = decideTurn(input);
    return { id: r.id, caseId: c.id, kind: r.kind, artifacts: r.artifacts, timings: r.timings ?? null,
      v1: replay, checks, independentlyRebound, v2: candidate, safePartial: fullPartial(c, candidate),
      unsafeObligationIds: checkCandidate(c, candidate),
      perObligation: candidate.obligations.map(o => ({ id: o.obligationId,
        v1: replay.drift.length || replay.results.some(m => m.grade === 'INDETERMINATE') ? 'INDETERMINATE'
          : replay.publishedUnits === 0 ? 'TURN_FALLBACK' : 'INDETERMINATE_OBLIGATION', v2: o.outcome })),
    };
  });
  const deliveries = loadDelivered().map(d => ({
    id: d.id, artifact: d.artifact, replyDigest: digest(d.text), timings: d.timings ?? null,
    ...baseline.tier2.delivered.find(b => b.deliveredId === d.id)!,
    v2: 'NOT_EVALUATED_DELIVERED_TEXT_IS_NOT_A_VERIFIED_PROPOSAL',
  }));
  const controls = negativeControls().map(({ name, input, blocked, reason, sibling }) => {
    const d = decideTurn(input);
    const row = d.obligations.find(o => o.obligationId === blocked)!;
    return { name, blocked, expectedBlock: reason, sibling, decision: d,
      passed: row.outcome === 'DISCLOSE' && (row.reason === reason || row.checks.some(c => c.status === reason)) &&
        (!sibling || d.obligations.find(o => o.obligationId === sibling)?.outcome === 'ANSWER') };
  });
  const partial = cases.filter(c => c.partialOpportunity);
  const matched = protocols.map((protocol, i) => {
    const rows = partial.flatMap(c => {
      const metric = c.v1.oracle[i].metrics.find(m => /^safe_partial:(PASS|FAIL):/.test(m));
      return metric ? [{ c, v1Pass: metric.startsWith('safe_partial:PASS:') }] : [];
    });
    return { protocol, comparable: rows.length, v1: rows.filter(r => r.v1Pass).length, v2: rows.filter(r => r.c.fullPartial).length,
      newlyPreserved: rows.filter(r => !r.v1Pass && r.c.fullPartial).map(r => r.c.id),
      lost: rows.filter(r => r.v1Pass && !r.c.fullPartial).map(r => r.c.id),
      uniqueScenarios: new Set(rows.map(r => r.c.semanticKey)).size,
      notComparable: partial.filter(c => !rows.some(r => r.c.id === c.id)).map(c => c.id) };
  });
  const summary = {
    cases: cases.length, obligations: cases.reduce((n, c) => n + c.v2.obligations.length, 0),
    byLanguage: baseline.corpus.byLanguage, byChannelLabel: baseline.corpus.byChannel, adaptersExecuted: 0,
    partial: { total: partial.length, v2: partial.filter(c => c.fullPartial).length, matched,
      recordedWithIndependentPartial: recordings.filter(r => r.safePartial).map(r => r.id) },
    safety: { unsafeCatalogObligations: cases.flatMap(c => c.unsafeObligationIds).length,
      unsafeRecordedObligations: recordings.flatMap(r => r.unsafeObligationIds).length,
      injectedControls: controls.length, injectedControlsPassed: controls.filter(c => c.passed).length },
    unresolved: {
      catalog: cases.flatMap(c => c.v2.obligations.filter(o => o.outcome !== 'ANSWER')
        .map(o => ({ caseId: c.id, obligationId: o.obligationId, outcome: o.outcome, reason: o.reason }))),
      recordingsWithoutReboundFacts: recordings.filter(r => !r.independentlyRebound.length).map(r => r.id),
      replayIndeterminate: recordings.filter(r => r.v1.results.some(m => m.grade === 'INDETERMINATE')).map(r => r.id),
    },
    offlineProviderCalls: 0, providerSpendUsd: 0, liveLatency: 'NOT_EVALUATED',
  };
  return { schema: 'odinlink-brain-phase3-offline-v1', baselineSha256: BASELINE_HASH, summary, cases, recordings, deliveries, controls };
}
