/**
 * Tier 2 — recorded provider replay. Genuine model outputs captured by earlier
 * authorized runs are returned byte-for-byte from the recorded artifacts to the
 * CURRENT shared-core pipeline (buildEvidenceFirstAnswer + publishableKnowledgeManifest).
 * Nothing is rewritten. The pipeline's actual request data is compared with the
 * recorded request data; any drift makes the replay INDETERMINATE.
 * Recorded delivered replies (what customers or capture harnesses saw) are graded
 * separately and only deterministically; meaning-level judgments stay pending review.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ANSWER_LIMITS, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, publishableKnowledgeManifest, type Evidence } from '../../business-information-answer-plan';
import { runAccuracyFirstNative, nativeKnowledgeTiming } from '../../knowledge-timing-policy';
import type { EvalCase, Fact, MetricResult } from './types';
import { FACTS, fact as factOf } from './facts';
import { REPO_ROOT } from './sources';
import { tenantOf } from './corpus';
import { TIER3_LIMITS } from './tier3';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const read = (p: string) => readFileSync(new URL(p, REPO_ROOT), 'utf8');
const json = (p: string) => JSON.parse(read(p));

export type Recorded = Readonly<{
  id: string; caseId: string; kind: 'full_turn' | 'verifier_with_reconstructed_extraction';
  artifacts: readonly string[];
  question: string; language: string; businessId: number;
  facets: unknown; evidence: readonly Evidence[];
  extractionProtocol: 'v2' | 'literal-evidence-v1'; verificationProtocol: 'v2' | 'source-exhaustive-v1' | 'source-exhaustive-v2';
  outputs: Readonly<Partial<Record<'extraction' | 're_extraction' | 'verification', string>>>;
  recordedInputs: Readonly<Partial<Record<'extraction' | 're_extraction' | 'verification', any>>>;
  cancellationEvidence?: Evidence;
  timings?: Readonly<{ endToEndMs?: number; stageLatencyMs?: readonly number[]; perRequestUsd?: readonly number[] }>;
  note: string;
}>;
export type Delivered = Readonly<{ id: string; caseId: string; artifact: string; origin: 'capture-run-final' | 'production-delivered' | 'experiment-harness'; text: string;
  timings?: Readonly<{ endToEndMs?: number }> }>;

const ev = (e: any, fallbackSource: string): Evidence => Object.freeze({ id: e.id, businessId: e.businessId, sourceId: e.sourceId ?? fallbackSource,
  chunkId: e.chunkId ?? sha(e.text).slice(0, 32), version: e.version ?? sha(e.text), text: e.text });
const content = (r: any) => JSON.parse(r.input[0].content);
const protocolOf = (name?: string) => name?.includes('source_exhaustive_v2') ? 'source-exhaustive-v2' : name?.includes('source_exhaustive') ? 'source-exhaustive-v1' : 'v2';

export function loadRecorded(): Recorded[] {
  const out: Recorded[] = [];
  // 1. Full genuine Luna turn (cancellation question), 2026-11-02.
  { const p = 'tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', c = json(p);
    out.push({ id: 'rec-cancel-luna-20261102', caseId: 'rep-01', kind: 'full_turn', artifacts: [p], question: c.frozen.question, language: 'en', businessId: 77,
      facets: c.extraction.input.facets, evidence: [...c.frozen.evidence.map((e: any) => ev(e, 'incident-pdf')), ev(c.frozen.configurationEvidence, 'business-cancellation-configuration:77')],
      extractionProtocol: 'literal-evidence-v1', verificationProtocol: protocolOf(c.verification.structuredOutput?.name),
      outputs: { extraction: c.extraction.outputText, verification: c.verification.outputText },
      recordedInputs: { extraction: c.extraction.input, verification: c.verification.input }, cancellationEvidence: ev(c.frozen.configurationEvidence, 'business-cancellation-configuration:77'),
      note: 'Genuine gpt-5.6-luna extraction and verification outputs (response IDs in artifact).' }); }
  // 2-3. Genuine source-exhaustive verifier outputs; extraction reconstructed from the units in the same genuine request.
  for (const [id, p] of [['rec-source-alignment-v1-20261102', 'tests/fixtures/genuine-luna-source-alignment-20261102.json'],
    ['rec-u2-contradiction-v2-20261102', 'tests/fixtures/genuine-luna-u2-contradiction-20261102.json']] as const) {
    const a = json(p), data = JSON.parse(a.request.messages[0].content);
    out.push({ id, caseId: 'rep-01', kind: 'verifier_with_reconstructed_extraction', artifacts: [p], question: data.question, language: data.requestedLanguage, businessId: 77,
      facets: data.facets, evidence: data.evidence.map((e: any) => ev(e, `recorded:${e.id}`)), extractionProtocol: 'v2',
      verificationProtocol: protocolOf(a.request.structuredOutput?.name),
      outputs: { extraction: JSON.stringify({ oversized: false, units: data.units.map(({ id: _id, ...u }: any) => u) }), verification: a.outputText },
      recordedInputs: { verification: data }, note: 'Verifier output genuine; extraction output reconstructed from the genuine request units (same run).' });
  }
  // 4-5. Genuine shared-core run (2026-10-22): EN Video Consultation and DE first-visit questions.
  { const p = 'tests/fixtures/shared-core-verifier-disagreements.json', d = json(p);
    d.cases.forEach((c: any, i: number) => out.push({ id: `rec-shared-core-${c.language}-20261022`, caseId: i === 0 ? 'rep-03' : 'rep-04', kind: 'full_turn', artifacts: [p, d.sourceArtifact],
      question: c.questionFromRunFixture, language: c.language, businessId: 77, facets: c.facetsReconstructed,
      evidence: c.wireDocumentEvidence.map((e: any) => ev(e, `recorded:${e.id}`)), extractionProtocol: 'v2', verificationProtocol: 'v2',
      outputs: { extraction: JSON.stringify(c.extractionOutput), verification: JSON.stringify(c.verifierOutput) },
      recordedInputs: { verification: { units: c.verifierUnits } }, timings: { endToEndMs: c.observedTimings?.endToEndMs },
      note: 'Outputs copied unchanged; facets reconstructed from the run fixture (per artifact provenance note).' })); }
  // 6-8. Authorized semantic-recovery runs (2026-11-12), Persian first-visit question.
  for (const [dir, arm, files] of [
    ['docs/validation/semantic-recovery-luna-sol-20261112', 'luna', ['01-luna_original_extraction', '02-luna_replacement_extraction', '03-verify-luna-output_replacement_verification']],
    ['docs/validation/semantic-recovery-luna-sol-20261112', 'sol', ['04-sol_original_extraction', '05-sol_replacement_extraction', '06-verify-sol-output_replacement_verification']],
    ['docs/validation/semantic-recovery-luna-sol-20261112-repeat', 'sol-repeat', ['02-sol_original_extraction', '03-sol_replacement_extraction', '04-verify-sol-output_replacement_verification']],
  ] as const) {
    const req = files.map(f => json(`${dir}/${f}.request.json`)), rec = files.map(f => json(`${dir}/${f}.receipt.json`)), data = content(req[0]);
    out.push({ id: `rec-semantic-recovery-${arm}-20261112`, caseId: 'rep-02', kind: 'full_turn', artifacts: files.map(f => `${dir}/${f}.receipt.json`),
      question: data.question, language: data.requestedLanguage, businessId: 3, facets: data.facets, evidence: data.evidence.map((e: any) => ev(e, `recorded:${e.sourceGroup ?? e.id}`)),
      extractionProtocol: 'v2', verificationProtocol: protocolOf(req[2].text?.format?.name),
      outputs: { extraction: rec[0].outputText, re_extraction: rec[1].outputText, verification: rec[2].outputText },
      recordedInputs: { extraction: data, re_extraction: content(req[1]), verification: content(req[2]) },
      timings: { stageLatencyMs: rec.map(r => r.latencyMs), perRequestUsd: rec.map(r => r.estimatedUsd) },
      note: 'Authorized experiment receipts; replacement extraction requested under the experiment protocol.' });
  }
  return out;
}

export function loadDelivered(): Delivered[] {
  const c = json('tests/fixtures/genuine-luna-cancellation-coverage-20261102.json'), d = json('tests/fixtures/shared-core-verifier-disagreements.json');
  const s1 = json('docs/validation/semantic-recovery-luna-sol-20261112/summary.json'), s2 = json('docs/validation/semantic-recovery-luna-sol-20261112-repeat/summary.json');
  return [
    { id: 'del-cancel-luna-20261102', caseId: 'rep-01', artifact: 'tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', origin: 'capture-run-final', text: c.finalInterceptedResponse },
    ...d.cases.map((x: any, i: number) => ({ id: `del-shared-core-${x.language}-20261022`, caseId: i === 0 ? 'rep-03' : 'rep-04', artifact: 'tests/fixtures/shared-core-verifier-disagreements.json',
      origin: 'production-delivered' as const, text: x.deliveredReplies[0], timings: { endToEndMs: x.observedTimings?.endToEndMs } })),
    ...(['luna', 'sol'] as const).filter(a => s1.arms[a]?.text).map(a => ({ id: `del-semantic-recovery-${a}-20261112`, caseId: 'rep-02',
      artifact: 'docs/validation/semantic-recovery-luna-sol-20261112/summary.json', origin: 'experiment-harness' as const, text: s1.arms[a].text })),
    ...(s2.arms.sol?.text ? [{ id: 'del-semantic-recovery-sol-repeat-20261112', caseId: 'rep-02', artifact: 'docs/validation/semantic-recovery-luna-sol-20261112-repeat/summary.json',
      origin: 'experiment-harness' as const, text: s2.arms.sol.text }] : []),
  ];
}

// ---------- shared deterministic graders ----------
const norm = (s: string) => s.toLowerCase().replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
  .replace(/[^\p{L}\p{N}]+/gu, '');
const digits = (s: string) => (s.replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
  .match(/\d+/g) ?? []) as string[];
const SCRIPT: Record<string, RegExp> = { fa: /[؀-ۿ]/, ar: /[؀-ۿ]/ };

/** Catalogued facts conveyed by a published unit, from its cited evidence (never from verifier labels).
 * A unit may convey several facts; current revisions are preferred over historical ones. */
export function matchFacts(unit: any, evidence: readonly Evidence[], tenant: number): Fact[] {
  const tenantFacts = FACTS.filter(f => f.tenantId === tenant);
  const found = new Map<string, Fact>();
  for (const ref of unit.evidenceRefs ?? []) {
    if (String(ref.evidenceId).startsWith('configured-cancellation')) {
      const f = tenantFacts.find(f => f.id === (/fee|avgift|gebühr|tarifa|هزینه|رسوم/i.test(unit.text) ? 't3.cancel.fee-disabled' : 't3.cancel.chat-enabled'));
      if (f) found.set(f.id, f); continue;
    }
    if (String(ref.evidenceId).startsWith('configured-services')) {
      for (const f of tenantFacts.filter(f => f.config && f.numbers?.some(n => digits(unit.text).includes(n)))) found.set(f.id, f); continue;
    }
    const quote = norm(ref.exactQuote ?? evidence.find(e => e.id === ref.evidenceId)?.text ?? '');
    const hits = tenantFacts.filter(f => f.quote && quote.length >= 16 && (quote.includes(norm(f.quote)) || norm(f.quote).includes(quote)));
    const current = hits.filter(f => !f.id.startsWith('h.') && !f.id.startsWith('n.'));
    for (const f of current.length ? current : hits) found.set(f.id, f);
  }
  return [...found.values()];
}
const expand = (facts: readonly Fact[]) => [...new Set(facts.flatMap(f => [f.id, ...(f.sameAs ?? [])]))];

export function gradeUnits(c: EvalCase, units: readonly any[], evidence: readonly Evidence[], tier: MetricResult['tier']): MetricResult[] {
  const tenant = tenantOf(c.tenantId), out: MetricResult[] = [];
  const matched = units.map(u => ({ u, fs: matchFacts(u, evidence, tenant) }));
  const unmatched = matched.filter(m => !m.fs.length);
  const allowedNumbers = new Set(matched.flatMap(m => [...m.fs.flatMap(f => f.numbers ?? []), ...(m.u.evidenceRefs ?? []).flatMap((r: any) => digits(r.exactQuote ?? ''))]));
  const badNumbers = matched.flatMap(m => digits(m.u.text).filter(n => !allowedNumbers.has(n)));
  const forbidden = units.flatMap(u => digits(u.text).filter(n => c.forbiddenNumbers?.includes(n)));
  const stale = units.filter(u => c.forbiddenStaleText?.some(t => u.text.includes(t)));
  out.push({ metric: 'unsupported_claim', tier, grade: badNumbers.length || forbidden.length || stale.length ? 'FAIL' : unmatched.length ? 'INDETERMINATE' : 'PASS',
    reason: badNumbers.length ? 'number_not_in_cited_source' : forbidden.length ? 'forbidden_number_asserted' : stale.length ? 'stale_text_published'
      : unmatched.length ? 'unit_not_mapped_to_catalogued_fact' : 'all_units_map_to_catalogued_facts', pendingReview: unmatched.length > 0,
    evidence: { badNumbers, forbidden, unmatched: unmatched.map(m => m.u.text.slice(0, 120)) } });
  // A unit passes when its modality equals that of at least one fact it conveys (configuration facts are descriptive).
  const modalityMismatch = matched.filter(m => m.fs.length && !m.fs.some(f => f.modality === m.u.modality || f.config && m.u.modality === 'descriptive'));
  const negationMismatch = matched.filter(m => m.fs.length && !modalityMismatch.includes(m) &&
    !m.fs.some(f => f.modality === m.u.modality && (f.config || f.negation === !!m.u.negation)));
  out.push({ metric: 'modality_negation', tier, grade: modalityMismatch.length ? 'FAIL' : negationMismatch.length ? 'INDETERMINATE' : matched.some(m => m.fs.length) ? 'PASS' : 'INDETERMINATE',
    reason: modalityMismatch.length ? `modality_${modalityMismatch.map(m => `${m.u.modality}_vs_${m.fs.map(f => f.modality).join('+')}`).join(',')}`
      : negationMismatch.length ? 'negation_flag_differs_pending_review' : matched.some(m => m.fs.length) ? 'modality_matches_source' : 'no_mapped_units',
    pendingReview: negationMismatch.length > 0 });
  const conditional = matched.flatMap(m => m.fs.filter(f => f.conditions?.length));
  out.push({ metric: 'missing_condition', tier, grade: conditional.length ? 'INDETERMINATE' : 'NOT_EVALUATED', pendingReview: conditional.length > 0,
    reason: conditional.length ? 'conditions_require_semantic_review' : 'no_conditional_facts_published',
    evidence: { conditions: conditional.map(f => ({ fact: f.id, conditions: f.conditions })) } });
  const wrongLanguage = units.filter(u => u.language !== c.language || (SCRIPT[c.language] && !SCRIPT[c.language].test(u.text)) || (!SCRIPT[c.language] && /[؀-ۿ]/.test(u.text)));
  out.push({ metric: 'language', tier, grade: wrongLanguage.length ? 'FAIL' : 'PASS', reason: wrongLanguage.length ? 'unit_language_or_script_mismatch' : 'units_in_requested_language' });
  return out;
}

/** Final-outcome grading from published fact IDs against the ground-truth obligations. */
export function gradeOutcome(c: EvalCase, published: boolean, factIds: readonly string[], disclosure: boolean, tier: MetricResult['tier'], label: string): MetricResult[] {
  const required = c.obligations.filter(o => o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE').flatMap(o => o.facts);
  const related = c.obligations.filter(o => o.expect === 'DISCLOSE').flatMap(o => o.facts);
  const partial = c.obligations.some(o => o.expect === 'DISCLOSE');
  const answerable = required.length > 0 || related.length > 0;
  const out: MetricResult[] = [];
  out.push({ metric: 'false_fallback', tier, grade: !answerable ? 'NOT_EVALUATED' : published ? 'PASS' : 'FAIL', reason: `${label}:${!answerable ? 'nothing_answerable' : published ? 'published' : 'fallback_on_answerable_question'}` });
  const missing = required.filter(id => !factIds.includes(id));
  if (!partial) out.push({ metric: 'correct_complete', tier, grade: published && !missing.length ? 'PASS' : 'FAIL',
    reason: `${label}:${!published ? 'fallback' : missing.length ? 'required_fact_missing:' + missing.join(',') : 'complete'}` });
  else out.push({ metric: 'safe_partial', tier, grade: !published ? 'FAIL' : missing.length ? 'FAIL' : disclosure ? 'PASS' : 'FAIL',
    reason: `${label}:${!published ? 'fallback' : missing.length ? 'required_fact_missing:' + missing.join(',') : disclosure ? 'partial_with_disclosure' : 'published_without_disclosure'}` });
  return out;
}

export type ReplayRun = { id: string; drift: string[]; stages: string[]; publishable: boolean; units: any[]; manifestText: string; fallbackReason: string | null; missingOutputs: string[]; substitutedStages: string[] };

export async function replay(r: Recorded): Promise<ReplayRun> {
  const facets = parseRequestedFacets((r.facets as any[]).map(f => ({ subject: f.subject, attribute: f.attribute, questionType: f.questionType,
    ...(f.obligations ? { obligations: f.obligations.map((o: any) => ({ description: o.description, questionType: o.questionType })) } : {}) }))).facets;
  const drift: string[] = [], stages: string[] = [], missingOutputs: string[] = [], substitutedStages: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const check = (stage: string, data: any) => {
    const rec = r.recordedInputs[stage as keyof Recorded['recordedInputs']];
    if (!rec) return;
    if (rec.question !== undefined && rec.question !== data.question) drift.push(`${stage}:question`);
    if (rec.facets !== undefined && !same(rec.facets.map((f: any) => [f.id, f.questionType]), (data.facets ?? []).map((f: any) => [f.id, f.questionType]))) drift.push(`${stage}:facets`);
    if (rec.evidence !== undefined && !same(rec.evidence.map((e: any) => [e.id, e.text]), (data.evidence ?? []).map((e: any) => [e.id, e.text]))) drift.push(`${stage}:evidence`);
    if (rec.units !== undefined && !same(rec.units.map((u: any) => u.text), (data.units ?? []).map((u: any) => u.text))) {
      const now = (data.units ?? []).map((u: any) => u.text), was = rec.units.map((u: any) => u.text);
      drift.push(`${stage}:units(recorded=${was.length},current=${now.length},dropped=${was.filter((t: string) => !now.includes(t)).length},added=${now.filter((t: string) => !was.includes(t)).length})`);
    }
  };
  let manifest: any, publishableInTurn = false;
  const saved = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;
  process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'off';
  try {
    await runAccuracyFirstNative(async () => {
      manifest = await buildEvidenceFirstAnswer({ businessId: r.businessId, question: r.question, language: r.language, facets, evidence: r.evidence,
        foreground: true, extractionProtocol: r.extractionProtocol, verificationProtocol: r.verificationProtocol, authoritativeEvidence: '{}', businessTone: {}, history: [],
        ...(r.cancellationEvidence ? { cancellationEvidence: r.cancellationEvidence } : {}),
        ...(r.outputs.re_extraction ? { reExtraction: { admit: () => null, record: () => {} } } : {}),
        budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true, revalidateEvidence: async () => r.evidence, diagnostic: () => {},
        generate: async (stage: string, _i: string, data: any) => { stages.push(stage); check(stage, data);
          // The composer only orders verified units (it cannot add or change facts) and was not
          // recorded by the captures: substitute an identity order and disclose it.
          if (stage === 'composition') { substitutedStages.push('composition'); return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) }; }
          const text = r.outputs[stage as keyof Recorded['outputs']];
          if (text === undefined) { missingOutputs.push(stage); throw new Error('RECORDED_OUTPUT_MISSING'); }
          return { text }; } } as any);
      publishableInTurn = publishableKnowledgeManifest(manifest, r.businessId);
    }, async () => { throw new Error('replay_native_timeout'); });
  } finally { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = saved; }
  const publishable = publishableInTurn && manifest.units.length > 0;
  return { id: r.id, drift, stages, publishable, units: publishable ? [...manifest.units] : [], manifestText: manifest.text, fallbackReason: manifest.fallbackReason ?? null, missingOutputs, substitutedStages };
}

export async function evaluateReplay(r: Recorded, c: EvalCase): Promise<{ run: ReplayRun; results: MetricResult[] }> {
  const run = await replay(r);
  const exercised = ['business-information-answer-plan.buildEvidenceFirstAnswer', 'business-information-answer-plan.publishableKnowledgeManifest'];
  const substituted = [`provider stages returned verbatim from recorded genuine outputs (${r.kind})`, ...run.substitutedStages.map(s => `${s} (identity order; not recorded)`)];
  const evidence = { replay: r.id, drift: run.drift, stages: run.stages, fallbackReason: run.fallbackReason, missingOutputs: run.missingOutputs, artifacts: r.artifacts };
  const base = { tier: 'T2_RECORDED_REPLAY' as const, exercised, substituted, evidence };
  const results: MetricResult[] = [];
  if (run.drift.length || run.missingOutputs.length) {
    results.push({ ...base, metric: 'correct_complete', grade: 'INDETERMINATE', reason: `replay_not_faithful:${[...run.drift, ...run.missingOutputs.map(s => 'missing_' + s)].join(',')}` });
  } else {
    const ids = expand(run.units.flatMap(u => matchFacts(u, r.evidence, tenantOf(c.tenantId))));
    const rest = run.units.reduce((t: string, u: any) => t.replace(u.text, ''), run.manifestText).trim();
    results.push(...gradeOutcome(c, run.publishable, ids, rest.length > 0, 'T2_RECORDED_REPLAY', r.id).map(m => ({ ...m, exercised, substituted, evidence })));
    if (run.publishable) results.push(...gradeUnits(c, run.units, r.evidence, 'T2_RECORDED_REPLAY').map(m => ({ ...m, exercised, substituted, evidence: { ...evidence, ...(m.evidence ?? {}) } })));
  }
  if (r.timings?.endToEndMs !== undefined || r.timings?.stageLatencyMs) {
    const total = r.timings.endToEndMs ?? r.timings.stageLatencyMs!.reduce((a, b) => a + b, 0);
    results.push({ ...base, metric: 'latency', grade: total <= ANSWER_LIMITS.deadlineMs ? 'PASS' : 'FAIL',
      reason: `${r.timings.endToEndMs !== undefined ? 'recorded_end_to_end' : 'sum_of_recorded_stage_latencies'}_${total}ms_vs_${ANSWER_LIMITS.deadlineMs}ms_deadline` });
  }
  if (r.timings?.perRequestUsd) {
    const max = Math.max(...r.timings.perRequestUsd);
    results.push({ ...base, metric: 'cost_attempts', grade: max <= TIER3_LIMITS.perRequestUsd ? 'PASS' : 'FAIL',
      reason: `max_recorded_request_usd_${max.toFixed(5)}_attempts_${r.timings.perRequestUsd.length}`, evidence: { ...evidence, perRequestUsd: r.timings.perRequestUsd } });
  }
  return { run, results };
}

/** Known generic fallback phrasings observed in recorded artifacts and the V1 unavailable notices. */
const FALLBACK = [/cannot verify an answer/i, /kann .*derzeit nicht .*überprüfen/i, /نمی‌توانم آن بخش را بررسی کنم/, /kan inte bekräfta .*just nu/i];
export function evaluateDelivered(d: Delivered, c: EvalCase): MetricResult[] {
  const base = { tier: 'T2_RECORDED_DELIVERED' as const, exercised: [`recorded ${d.origin} reply`], evidence: { delivered: d.id, artifact: d.artifact, origin: d.origin, text: d.text } };
  const fallback = FALLBACK.some(r => r.test(d.text));
  const answerable = c.obligations.some(o => (o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE') || o.expect === 'DISCLOSE' && o.facts.length);
  const out: MetricResult[] = [{ ...base, metric: 'false_fallback', grade: !answerable ? 'NOT_EVALUATED' : fallback ? 'FAIL' : 'PASS',
    reason: fallback ? 'generic_fallback_on_answerable_question' : 'substantive_reply' }];
  const nums = digits(d.text);
  const allowed = new Set(c.obligations.flatMap(o => o.facts).flatMap(id => factOf(id).numbers ?? []));
  const forbidden = nums.filter(n => c.forbiddenNumbers?.includes(n));
  const unexplained = nums.filter(n => !allowed.has(n));
  out.push({ ...base, metric: 'unsupported_claim', grade: forbidden.length ? 'FAIL' : fallback ? 'NOT_EVALUATED' : 'INDETERMINATE', pendingReview: !fallback && !forbidden.length,
    reason: forbidden.length ? 'forbidden_number_asserted' : fallback ? 'no_claims' : unexplained.length ? `numbers_without_catalogued_fact_${unexplained.join(',')}_pending_review` : 'meaning_requires_semantic_review' });
  if (!fallback) out.push({ ...base, metric: 'correct_complete', grade: 'INDETERMINATE', pendingReview: true, reason: 'delivered_prose_requires_semantic_review' });
  if (d.timings?.endToEndMs !== undefined) out.push({ ...base, metric: 'latency', grade: d.timings.endToEndMs <= ANSWER_LIMITS.deadlineMs ? 'PASS' : 'FAIL',
    reason: `recorded_end_to_end_${d.timings.endToEndMs}ms_vs_${ANSWER_LIMITS.deadlineMs}ms_deadline` });
  return out;
}
