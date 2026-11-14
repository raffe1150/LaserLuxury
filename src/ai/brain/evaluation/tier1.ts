/**
 * Tier 1 — deterministic offline evaluation against real shared-core V1 code.
 *
 * (a) Deterministic signals: language + intent (normalizeBookingRequest),
 *     information/action routing predicates and the deterministic
 *     service-selection clarifier, called unchanged on the customer text.
 * (b) POLICY ORACLE: the real buildEvidenceFirstAnswer + publishableKnowledgeManifest
 *     with ONLY the provider stages substituted by a ground-truth oracle that
 *     proposes exactly the catalogued facts and returns a truthful verdict.
 *     This measures V1's publication policy ceiling ("would V1 publish the
 *     right outcome if the model were perfect?"). It is NOT evidence of live
 *     semantic correctness, and is always reported as T1_POLICY_ORACLE.
 * No network, no provider client, no writes.
 */
import { createHash } from 'node:crypto';
import { normalizeBookingRequest, isReadOnlyAvailabilityInquiry } from '../../booking-intelligence';
import { isBusinessInformationQuestion, isExplicitBusinessActionRequest } from '../../business-information';
import { serviceSelectionClarification } from '../../knowledge-answer-presentation';
import { buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, publishableKnowledgeManifest, type Evidence } from '../../business-information-answer-plan';
import { runAccuracyFirstNative, nativeKnowledgeTiming } from '../../knowledge-timing-policy';
import type { EvalCase, Fact, MetricResult, SourceRecord } from './types';
import { fact as factOf } from './facts';
import { loadSources, source } from './sources';
import { tenantOf } from './corpus';

const ACTION_INTENTS = ['new_booking', 'cancellation', 'reschedule', 'booking_lookup'];
const FIXED_NOW = new Date('2026-11-16T09:00:00+01:00');

export function deterministicSignals(c: EvalCase) {
  const text = c.turns[c.turns.length - 1];
  const normalized = normalizeBookingRequest({ businessId: c.tenantId, channel: c.channel, conversationKey: `eval:${c.id}`, inputMode: 'text', text,
    ...(c.turns.length > 1 ? { activeLanguage: c.language } : {}), timezone: 'Europe/Stockholm', now: FIXED_NOW });
  return { text, language: normalized.language, intent: normalized.intent, information: isBusinessInformationQuestion(text),
    action: isExplicitBusinessActionRequest(text), availability: isReadOnlyAvailabilityInquiry(text),
    clarification: serviceSelectionClarification(text, c.language) ?? null };
}

export function evaluateDeterministic(c: EvalCase): MetricResult[] {
  const s = deterministicSignals(c);
  const exercised = ['booking-intelligence.normalizeBookingRequest', 'business-information.isBusinessInformationQuestion',
    'business-information.isExplicitBusinessActionRequest', 'booking-intelligence.isReadOnlyAvailabilityInquiry', 'knowledge-answer-presentation.serviceSelectionClarification'];
  const evidence = { language: s.language, intent: s.intent, information: s.information, action: s.action, availability: s.availability, clarification: s.clarification };
  const out: MetricResult[] = [];
  // Reply language is graded by tier1-language.ts against the server-side authority; the booking
  // engine's normalized language is recorded here as evidence only.
  const route = c.obligations.find(o => o.expect === 'ROUTE')?.route;
  if (route) {
    const ok = s.intent === route || route === 'availability' && (s.availability || s.intent === 'new_booking');
    out.push({ metric: 'action_routing', tier: 'T1_DETERMINISTIC', exercised, evidence, grade: ok ? 'PASS' : 'FAIL',
      reason: ok ? 'intent_matches_route' : `intent_${s.intent}_expected_${route}` });
  } else {
    const actionLike = s.action || ACTION_INTENTS.includes(s.intent);
    const grade = s.action || (ACTION_INTENTS.includes(s.intent) && !s.information) ? 'FAIL' : s.information && !actionLike ? 'PASS' : 'INDETERMINATE';
    out.push({ metric: 'action_routing', tier: 'T1_DETERMINISTIC', exercised, evidence, grade,
      reason: grade === 'PASS' ? 'information_not_action' : grade === 'FAIL' ? (s.action ? 'explicit_action_detected_on_information_question' : `action_intent_${s.intent}_without_information_signal`)
        : s.information ? `conflicting_signals_information_and_intent_${s.intent}` : 'not_recognized_as_information_deterministically' });
  }
  const wantsClarify = c.obligations.some(o => o.expect === 'CLARIFY');
  if (wantsClarify) out.push({ metric: 'clarification', tier: 'T1_DETERMINISTIC', exercised, evidence,
    grade: s.clarification ? 'PASS' : 'INDETERMINATE', reason: s.clarification ? 'deterministic_clarification' : 'no_deterministic_clarification_model_dependent' });
  else if (s.clarification) out.push({ metric: 'clarification', tier: 'T1_DETERMINISTIC', exercised, evidence, grade: 'FAIL', reason: 'spurious_clarification' });
  return out;
}

// ---------------- policy oracle ----------------
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Deterministic section chunking: numbered headings start a section; packed to <= 2400 characters. */
export function chunks(s: SourceRecord): string[] {
  const lines = s.text.split('\n'), sections: string[] = [];
  let cur: string[] = [];
  for (const l of lines) { if (/^\d+\.\s/.test(l) && cur.length) { sections.push(cur.join('\n')); cur = []; } cur.push(l); }
  if (cur.length) sections.push(cur.join('\n'));
  const out: string[] = [];
  for (const sec of sections) {
    if (out.length && out[out.length - 1].length + 1 + sec.length <= 2400) out[out.length - 1] += '\n' + sec; else out.push(sec);
  }
  return out;
}

export type OracleExpectation = 'ANSWER' | 'PARTIAL' | 'NO_FOREIGN_PUBLICATION' | 'NO_STALE_PUBLICATION';
export function oracleEligibility(c: EvalCase): { eligible: true; expectation: OracleExpectation } | { eligible: false; reason: string } {
  if (['action', 'clarify', 'multiturn'].includes(c.family)) return { eligible: false, reason: `family_${c.family}_not_modelled_by_oracle` };
  if (c.evidenceProfile === 'CONFLICTING') return { eligible: false, reason: 'conflict_uses_configuration_evidence' };
  const os = c.obligations;
  if (os.some(o => !['ANSWER', 'CORRECT_PREMISE', 'DISCLOSE', 'REFUSE_FOREIGN'].includes(o.expect))) return { eligible: false, reason: 'obligation_not_modelled' };
  const facts = os.flatMap(o => [...o.facts, ...(o.foreignFacts ?? [])]).map(factOf);
  if (facts.some(f => f.config)) return { eligible: false, reason: 'configured_service_or_cancellation_path_not_modelled' };
  if (!facts.length) return { eligible: false, reason: 'no_facts_to_propose' };
  if (os.some(o => o.expect === 'REFUSE_FOREIGN')) return { eligible: true, expectation: 'NO_FOREIGN_PUBLICATION' };
  if (c.evidenceProfile === 'STALE') return { eligible: true, expectation: 'NO_STALE_PUBLICATION' };
  if (os.every(o => o.expect !== 'DISCLOSE')) return { eligible: true, expectation: 'ANSWER' };
  return { eligible: true, expectation: 'PARTIAL' };
}

type OracleRun = { stages: string[]; events: any[]; manifest: any; publishable: boolean; publishedFacts: string[]; disclosure: boolean; parseRejected: boolean };

export async function runPolicyOracle(c: EvalCase, protocol: 'v2' | 'source-exhaustive-v2'): Promise<OracleRun> {
  const businessId = tenantOf(c.tenantId);
  const obligations = c.obligations.filter(o => o.expect !== 'ROUTE');
  const facets = parseRequestedFacets(obligations.map(o => ({ subject: `customer request ${c.id}`, attribute: `${o.expect.toLowerCase()} ${o.id}`,
    questionType: o.questionType! }))).facets;
  const evidence: Evidence[] = [], byChunk = new Map<string, string>();
  const proposals: any[] = [], unitFact = new Map<string, Fact>();
  obligations.forEach((o, i) => {
    for (const id of [...o.facts, ...(o.foreignFacts ?? [])]) {
      const f = factOf(id), s = source(f.source), chunk = chunks(s).find(t => t.includes(f.quote!))!;
      const key = `${s.key}:${sha(chunk)}`;
      if (!byChunk.has(key)) {
        byChunk.set(key, `e${evidence.length + 1}`);
        evidence.push(Object.freeze({ id: `e${evidence.length + 1}`, businessId: s.tenantId, sourceId: s.sourceId, chunkId: sha(chunk).slice(0, 32), version: s.revision, text: chunk }));
      }
      proposals.push({ facetIds: [facets[i].id], subject: f.id, predicate: 'states', value: f.gloss, modality: f.modality, negation: f.negation,
        scope: 'source', qualifiers: [], language: c.language, text: f.gloss, evidenceRefs: [{ evidenceId: byChunk.get(key)!, exactQuote: f.quote! }] });
      unitFact.set(f.gloss, f);
    }
  });
  const current = () => evidence.filter(e => loadStatus(e.sourceId) === 'CURRENT');
  const verdict = (data: any) => {
    const facetOf = (fid: string) => obligations[facets.findIndex(f => f.id === fid)];
    const unitsFor = (fid: string) => data.units.filter((u: any) => u.facetIds.includes(fid)).map((u: any) => u.id);
    const answered = (o: any) => o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE';
    return JSON.stringify({
      decisions: data.units.map((u: any) => { const f = unitFact.get(u.text); return { unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true,
        modalityPreserved: true, qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: !!f?.negation, explicitAbsenceEvidence: !!f?.negation }; }),
      coverage: data.facets.map((f: any) => { const o = facetOf(f.id), ok = answered(o);
        return { facetId: f.id, requestAligned: true, materialFactsComplete: ok, incompletenessReason: ok ? 'NONE' : 'UNRESOLVED', materialUnitIds: unitsFor(f.id),
          obligations: f.obligations.map((ob: any) => ({ obligationId: ob.id, status: ok ? 'COVERED' : 'UNRESOLVED', unitIds: ok ? unitsFor(f.id) : [] })) }; }),
      ...(protocol === 'source-exhaustive-v2' ? { sourceCoverage: { protocol, requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true,
        conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: data.units.map((u: any) => u.id),
        obligations: data.facets.flatMap((f: any) => f.obligations.map((ob: any) => { const o = facetOf(f.id);
          return { facetId: f.id, obligationId: ob.id, state: answered(o) ? 'COMPLETE' : ob.questionType === 'description' ? 'REQUESTED_INFORMATION_NOT_VERIFIED'
            : ob.questionType === 'requirement' ? 'UNRESOLVED_REQUIREMENT' : 'UNLOCATED' }; })) } } : {}),
    });
  };
  const stages: string[] = [], events: any[] = [];
  let manifest: any, publishableInTurn = false;
  const saved = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;
  process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'off';
  try {
    await runAccuracyFirstNative(async () => {
      manifest = await buildEvidenceFirstAnswer({ businessId, question: c.turns[c.turns.length - 1], language: c.language, facets, evidence,
        foreground: true, extractionProtocol: 'v2', verificationProtocol: protocol, authoritativeEvidence: '{}', businessTone: {}, history: [],
        budget: new InformationBudget(undefined, nativeKnowledgeTiming()), current: async () => true, revalidateEvidence: async () => current(),
        diagnostic: e => events.push({ stage: e.stage, reason: e.reason, ...(e.sourceCoverage ? { guard: e.sourceCoverage.guard, failedChecks: e.sourceCoverage.failedChecks } : {}) }),
        generate: async (stage: string, _i: string, data: any) => { stages.push(stage);
          // A perfect model answers every model stage: extraction, verification and the
          // presentation-only composer (ordering; it cannot add or change facts).
          if (stage === 'composition') return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
          return { text: stage === 'extraction' || stage === 're_extraction' ? JSON.stringify({ oversized: false, units: proposals }) : verdict(data) }; } } as any);
      // Publication authority (qualified/scoped partial tokens) is bound to the live turn, exactly as at send time.
      publishableInTurn = publishableKnowledgeManifest(manifest, businessId);
    }, async () => { throw new Error('oracle_native_timeout'); });
  } finally { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = saved; }
  const publishable = publishableInTurn && manifest.units.length > 0;
  const publishedFacts = publishable ? manifest.units.map((u: any) => unitFact.get(u.text)?.id ?? `unmatched:${u.id}`) : [];
  const rest = publishable ? manifest.units.reduce((t: string, u: any) => t.replace(u.text, ''), manifest.text).trim() : '';
  const parseRejected = events.some(e => e.stage === 'extraction' && e.reason !== 'ACCEPTED');
  return { stages, events, manifest, publishable, publishedFacts, disclosure: rest.length > 0, parseRejected };
}
const statusCache = new Map<string, string>();
function loadStatus(sourceId: string): string {
  if (!statusCache.size) for (const s of loadSources()) statusCache.set(s.sourceId, s.status);
  return statusCache.get(sourceId) ?? 'UNKNOWN';
}

export async function evaluatePolicyOracle(c: EvalCase, protocol: 'v2' | 'source-exhaustive-v2'): Promise<MetricResult[]> {
  const e = oracleEligibility(c);
  const label = `policy_oracle_${protocol}`;
  if (!('expectation' in e)) return [{ metric: 'correct_complete', tier: 'T1_POLICY_ORACLE', grade: 'NOT_EVALUATED', reason: `${label}:${'reason' in e ? e.reason : 'ineligible'}` }];
  const r = await runPolicyOracle(c, protocol);
  const knowledgeEntry = isBusinessInformationQuestion(c.turns[c.turns.length - 1]);
  const exercised = ['business-information-answer-plan.buildEvidenceFirstAnswer', 'business-information-answer-plan.publishableKnowledgeManifest',
    'source-exhaustive-coverage.assessSourceCoverage (source-exhaustive only)'];
  const substituted = ['extraction (ground-truth oracle proposals)', 'verification (truthful oracle verdict)'];
  const evidence = { protocol, stages: r.stages, publishable: r.publishable, publishedFacts: r.publishedFacts, disclosure: r.disclosure,
    fallbackReason: r.manifest?.fallbackReason ?? null, decisions: r.events.filter(x => x.stage === 'verification' && x.reason !== 'ACCEPTED').slice(-4) };
  const base = { tier: 'T1_POLICY_ORACLE' as const, exercised, substituted, evidence };
  if (!knowledgeEntry && e.expectation !== 'NO_FOREIGN_PUBLICATION' && e.expectation !== 'NO_STALE_PUBLICATION') return [{ ...base, metric: 'correct_complete', grade: 'INDETERMINATE',
    reason: `${label}:question_not_recognized_as_business_information_v1_knowledge_entry_uncertain` }];
  // Mirrors V1's modalityCovers(): if no catalogued fact for an answered obligation has a modality
  // that V1 can count as covering the obligation's question type, success depends on how the
  // planner types the question or the extractor re-encodes the fact — not provable offline.
  const covers = (qt: string, f: Fact) => qt === 'description' || qt === 'recommendation' && f.modality === 'recommended' ||
    qt === 'requirement' && f.modality === 'required' || qt === 'prohibition' && f.modality === 'prohibited' ||
    qt === 'permission' && (f.modality === 'permitted' || f.modality === 'prohibited' && !f.negation);
  const uncoverable = c.obligations.filter(o => (o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE') && !o.facts.some(id => covers(o.questionType!, factOf(id))));
  if (uncoverable.length && e.expectation !== 'NO_FOREIGN_PUBLICATION' && e.expectation !== 'NO_STALE_PUBLICATION') return [{ ...base, metric: 'correct_complete', grade: 'INDETERMINATE',
    reason: `${label}:cross_modality_answer_encoding_dependent:${uncoverable.map(o => `${o.questionType}_answered_by_${o.facts.map(id => factOf(id).modality).join('+')}`).join(',')}`,
    evidence: { ...evidence, v1Outcome: r.publishable ? 'published' : 'fallback' } }];
  if (e.expectation === 'NO_FOREIGN_PUBLICATION' || e.expectation === 'NO_STALE_PUBLICATION') {
    const leaked = r.publishedFacts.filter(id => { const f = id.startsWith('unmatched') ? undefined : factOf(id);
      return !f || f.tenantId !== tenantOf(c.tenantId) || source(f.source).status !== 'CURRENT'; });
    return [{ ...base, metric: 'cost_attempts', grade: 'NOT_EVALUATED', reason: `${label}:provider_stages_${r.stages.length}_no_cost_offline` }, { ...base, metric: 'unsupported_claim', grade: leaked.length ? 'FAIL' : 'PASS',
      reason: `${label}:${leaked.length ? (e.expectation === 'NO_FOREIGN_PUBLICATION' ? 'foreign_fact_published' : 'stale_fact_published') : 'guard_withheld_' + (e.expectation === 'NO_FOREIGN_PUBLICATION' ? 'foreign' : 'stale')}` }];
  }
  if (r.parseRejected && !r.publishable) return [{ ...base, metric: 'correct_complete', grade: 'INDETERMINATE', reason: `${label}:oracle_proposal_rejected_at_parse` }];
  const required = c.obligations.filter(o => o.expect === 'ANSWER' || o.expect === 'CORRECT_PREMISE').flatMap(o => o.facts);
  const out: MetricResult[] = [{ ...base, metric: 'cost_attempts', grade: 'NOT_EVALUATED', reason: `${label}:provider_stages_${r.stages.length}_no_cost_offline` }];
  const missing = required.filter(id => !r.publishedFacts.includes(id));
  out.push({ ...base, metric: 'false_fallback', grade: r.publishable ? 'PASS' : 'FAIL', reason: `${label}:${r.publishable ? 'published' : 'fallback_' + (r.manifest?.fallbackReason ?? 'unpublishable')}` });
  if (e.expectation === 'ANSWER') out.push({ ...base, metric: 'correct_complete', grade: r.publishable && !missing.length ? 'PASS' : 'FAIL',
    reason: `${label}:${!r.publishable ? 'fallback' : missing.length ? 'required_fact_not_published' : 'complete'}` });
  else out.push({ ...base, metric: 'safe_partial', grade: r.publishable && !missing.length && r.disclosure ? 'PASS' : 'FAIL',
    reason: `${label}:${!r.publishable ? 'fallback' : missing.length ? 'required_fact_not_published' : !r.disclosure ? 'published_without_disclosure' : 'partial_with_disclosure'}` });
  return out;
}
