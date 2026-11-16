// Exact Persian incident on the current read-only inventory, shared by the
// re-extraction tests and the dry-run CLI. Offline: scripted model outputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseRequestedFacets, type Evidence } from '../../src/ai/business-information-answer-plan';
import { admitted, readySources, sentence, TENANT } from './admotion-current-inventory';
import { recoverByReextraction, type Responder } from './reextraction-recovery';

export const INCIDENT_QUESTION = 'من اولین باره می‌خوام بیام استودیو. بهتره چقدر زودتر از نوبتم اونجا باشم؟';
export const FACETS = parseRequestedFacets([{ subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' }]).facets;
// Persian answer parts. Labels describe meaning, never parser behaviour.
export const REC = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند، برای اینکه با آرامش آماده شوند.';
export const QUAL = 'این فقط یک توصیه است، نه الزام یا آخرین زمان ورود.';
export const COND = 'اگر دستورالعمل آمادگی ویژه‌ای دریافت کرده‌اید، باید آن را رعایت کنید.';
// The 2026-11 incident wording. Since 61cc44f the closed Persian purpose grammar
// reads «برسند تا با آرامش آماده شوند» as purpose, so it now parses.
export const INCIDENT_PURPOSE_TA = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با آرامش آماده شوند.';
// A faithful phrasing that 61cc44f explicitly keeps outside the closed grammar
// (semantic-recovery-eval fa-purpose-8): still a conservative «تا» bound, so it
// exercises the production re-extraction path on a genuinely ambiguous connective.
export const TA = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با خیال راحت آماده شوند.';

// Acceptance criteria for the exact first-visit question (owner-approved
// 2026-11-12). Labels are human judgements of what a unit STATES; they are
// never derived from the parser or from pattern matching.
export const ACCEPTANCE = Object.freeze({
  required: ['APPROX_10_MIN_BEFORE_APPOINTMENT', 'FIRST_TIME_VISITORS', 'RECOMMENDATION_NOT_MANDATORY'] as const,
  /** Violations: any of these makes the answer unacceptable. */
  forbidden: ['FALSE_LATEST_ARRIVAL_CONSTRAINT', 'UNSUPPORTED_CLAIM', 'WRONG_QUANTITY_OR_ANCHOR', 'OBLIGATION_INSTEAD_OF_RECOMMENDATION'] as const,
  helpful: ['PREPARATION_PURPOSE', 'EXPLICITLY_NOT_MANDATORY_OR_DEADLINE'] as const,
  unrelated: ['PDF_SPECIAL_INSTRUCTIONS_CONDITION', 'BRING_BOOKING_CONFIRMATION', 'DIRECTIONS', 'PARKING', 'LATE_ARRIVAL_POLICY'] as const,
});
export type Fact = typeof ACCEPTANCE[keyof typeof ACCEPTANCE][number];
/** Human labels for scripted unit texts. */
export const LABELS = new Map<string, readonly Fact[]>([
  [REC, ['APPROX_10_MIN_BEFORE_APPOINTMENT', 'FIRST_TIME_VISITORS', 'RECOMMENDATION_NOT_MANDATORY', 'PREPARATION_PURPOSE']],
  [QUAL, ['RECOMMENDATION_NOT_MANDATORY', 'EXPLICITLY_NOT_MANDATORY_OR_DEADLINE']],
  [COND, ['PDF_SPECIAL_INSTRUCTIONS_CONDITION']],
]);
export function acceptable(facts: readonly Fact[]) {
  return ACCEPTANCE.required.every(f => facts.includes(f)) && !ACCEPTANCE.forbidden.some(f => facts.includes(f));
}
/** Backwards name: texts a correct reviewer treats as faithful (no violation). */
export const FAITHFUL = new Set([...LABELS].filter(([, facts]) => !ACCEPTANCE.forbidden.some(f => facts.includes(f))).map(([text]) => text));

export type Key = 'recommendation' | 'qualification' | 'condition' | 'parking';
export type Incident = { evidence: Evidence[]; quotes: Record<Key, string>; ids: Record<Key, string> };
// Every recorded 2026-11-12 request carries this one evidence order, and the
// recorded outputs cite its position-bound IDs. Since a99cce7 the exhaustive
// inventory admits this mixed PDF+text corpus in source order instead.
const RECORDED_ORDER = ['e16cc64226ea', 'b5c1c08fe665', '061124e5236c', '81518891ba3f', '1f70f14a9477'];
const textSha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
export async function loadIncident(): Promise<Incident> {
  const current = await admitted(readySources());
  // Restore the recorded wire order by exact content; no text, tenant, source
  // or revision changes, only the positional IDs the recorded outputs cite.
  const ordered = RECORDED_ORDER.map((digest, index) => {
    const same = current.evidence.filter(item => textSha(item.text) === digest && item.businessId === TENANT);
    assert.equal(same.length, 1, `recorded evidence ${digest} has no unique content-identical current item`);
    return Object.freeze({ ...same[0], id: `e${index + 1}` });
  });
  assert.equal(ordered.length, current.evidence.length, 'recorded and current inventories differ in size');
  const admission = { ...current, evidence: ordered };
  assert.equal(new Set(admission.evidence.map(item => item.sourceId)).size, 3, 'current inventory must admit all three sources');
  const quotes = {} as Record<Key, string>, ids = {} as Record<Key, string>;
  const find = (key: Key, start: RegExp, end: RegExp) => {
    for (const item of admission.evidence) { const q = sentence(item.text, start, end); if (q) { quotes[key] = q; ids[key] = item.id; return; } }
    assert.fail(`current inventory no longer contains the ${key} sentence`);
  };
  find('recommendation', /Kunder som besöker AdMotion Studio för första gången/u, /lugn och ro\./u); // manual source
  find('qualification', /Detta är en rekommendation/u, /ankomsttid\./u);                           // manual source
  find('condition', /Om du har fått särskilda/u, /följa\s+dessa\./u);                               // PDF
  find('parking', /Från garaget tar det ungefär/u, /entré\./u);                                     // PDF, unrelated
  return { evidence: admission.evidence, quotes, ids };
}

export type Unit = { text: string; modality?: string; cite: Key[]; evidenceId?: string; quote?: string };
export const faithfulUnits: Unit[] = [{ text: REC, cite: ['recommendation'] }, { text: QUAL, cite: ['qualification'] },
  { text: COND, modality: 'required', cite: ['condition'] }];
export const originalUnits: Unit[] = [{ text: TA, cite: ['recommendation'] }, ...faithfulUnits.slice(1)];

/** lenient: approves everything (isolates deterministic vetoes). labelled: correct reviewer. */
export const verifier = (mode: 'lenient' | 'labelled'): Responder => (_stage, data) => {
  const ok = (text: string) => mode === 'lenient' || FAITHFUL.has(text);
  // A correct reviewer applies the question's acceptance criteria: the union of
  // what the accepted units state must cover every REQUIRED fact, no violation.
  const facts = data.units.flatMap((u: any) => LABELS.get(u.text) ?? ['UNSUPPORTED_CLAIM']);
  const all = data.units.every((u: any) => ok(u.text)) && (mode === 'lenient' || data.requestedLanguage !== 'fa' || acceptable(facts));
  const unitIds = data.units.map((u: any) => u.id);
  return { decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: ok(u.text) ? 'ENTAILED' : 'CONTRADICTED',
      meaningPreserved: ok(u.text), modalityPreserved: ok(u.text), qualifiersPreserved: ok(u.text), relevant: true, languageCorrect: true,
      negativeAbsence: false, explicitAbsenceEvidence: false })),
    coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: all, incompletenessReason: all ? 'NONE' : 'MISSING_RELEVANT_FACT',
      materialUnitIds: all ? unitIds : [], obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: all ? 'COVERED' : 'UNRESOLVED', unitIds: all ? unitIds : [] })) })),
    sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: all, conditionsPreserved: all, conflictsAbsent: true,
      evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: all ? unitIds : [],
      obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id, state: all ? 'COMPLETE' : 'UNRESOLVED' }))) } };
};
export const responder = (incident: Incident, units: Unit[], mode: 'lenient' | 'labelled', language = 'fa'): Responder =>
  (stage, data) => stage !== 'extraction' ? verifier(mode)(stage, data) : { oversized: false, units: units.map(u => ({
    subject: 'first-time visitors', predicate: 'arrival timing', value: 'arrival time relative to the booked appointment',
    modality: u.modality ?? 'recommended', negation: false, scope: 'first visit', qualifiers: [], language, text: u.text,
    facetIds: [data.facets[0].id], evidenceRefs: u.cite.map(key => ({ evidenceId: u.evidenceId ?? incident.ids[key], exactQuote: u.quote ?? incident.quotes[key] })) })) };

/** Every request a controlled provider validation of the incident could make. */
export async function incidentPlan() {
  const incident = await loadIncident();
  const run = await recoverByReextraction({ question: INCIDENT_QUESTION, language: 'fa', facets: FACETS, businessId: TENANT,
    evidence: async () => incident.evidence, original: responder(incident, originalUnits, 'labelled'),
    reextraction: responder(incident, faithfulUnits, 'labelled') });
  assert.equal(run.publishable, true);
  return [...run.original.wires.map(w => ({ run: 'original', ...w })), ...run.replacement!.wires.map(w => ({ run: 'replacement', ...w }))];
}

// ---------------------------------------------------------------------------
// Controlled Luna vs Sol comparison (dry-run planning only; nothing dispatches).
// Source-exhaustive verification is refused by production code under any
// managed profile, so Sol is compared on EXTRACTION only, with byte-identical
// instructions, input and schema. Every model's replacement output is judged
// by the same production (default-profile) verifier.
export type ExperimentModel = 'luna' | 'sol';
const ROUTING: Record<ExperimentModel, Record<string, unknown>> = {
  // max_output_tokens is added to Luna ONLY so the conservative ceiling is a real
  // bound (production Luna requests are uncapped): disclosed experiment difference.
  luna: { model: 'gpt-5.6-luna', max_output_tokens: 8192 },
  // Mirrors the production Sol wire (src/ai/providers/knowledge-sol-profile.test.ts).
  sol: { model: 'gpt-6.1-sol', max_output_tokens: 8192, service_tier: 'default', prompt_cache_options: { mode: 'implicit', ttl: '30m' } },
};
export const ROUTING_FIELDS = ['model', 'max_output_tokens', 'service_tier', 'prompt_cache_options'] as const;
export function experimentRequest(body: Record<string, unknown>, model: ExperimentModel) {
  const routed: Record<string, unknown> = { ...body, ...ROUTING[model] };
  const text = JSON.stringify(routed);
  const bytes = Buffer.byteLength(text, 'utf8');
  // Luna: requestCeiling() formula. Sol: knowledge budget owner quote formula.
  const ceilingUsd = model === 'luna' ? ((bytes + 2048) * 0.25 + 8192 * 1.2) / 1e6 : ((bytes + 2048) * 2500 + 8192 * 10000) / 1e9;
  return { body: routed, bytes, requestSha256: createHash('sha256').update(text).digest('hex'), ceilingUsd };
}

/** Six requests: per model, original + re-extraction (extraction stage); then
 * the SAME default-profile verifier for each model's replacement output. The
 * original run's verification is skipped: a rejected unit already guarantees
 * INVALID_COVERAGE, so the trigger is decided from extraction diagnostics. */
export async function comparisonPlan() {
  const wires = await incidentPlan();
  const pick = (run: string, stage: string) => wires.find(w => w.run === run && w.stage === stage)!.body;
  const rows: { id: string; model: ExperimentModel; stage: string; body: Record<string, unknown>; bytes: number; requestSha256: string; ceilingUsd: number }[] = [];
  for (const model of ['luna', 'sol'] as const) for (const run of ['original', 'replacement'])
    rows.push({ id: `${model}:${run}:extraction`, model, stage: 'extraction', ...experimentRequest(pick(run, 'extraction'), model) });
  // Verification input embeds the extracted units; size it with a 10% byte margin.
  for (const model of ['luna', 'sol'] as const) {
    const request = experimentRequest(pick('replacement', 'verification'), 'luna');
    const bytes = Math.ceil(request.bytes * 1.1);
    rows.push({ id: `verify-${model}-output:replacement:verification`, model: 'luna', stage: 'verification', ...request, bytes,
      ceilingUsd: ((bytes + 2048) * 0.25 + 8192 * 1.2) / 1e6 });
  }
  return rows;
}
