// OFFLINE Semantic Recovery evaluation (test/shadow only). No network access,
// no provider client, no writes. Builds per-case verifier requests, predicts
// conservative cost, runs a read-only ledger preflight, and scores findings
// (scripted, adversarial, or recorded real receipts) against human labels.
import { createHash } from 'node:crypto';
import { parseRequestedFacets } from '../../src/ai/business-information-answer-plan';
import { assessNumericalConstraint, numericalComparisonShapes } from '../../src/ai/numerical-constraints';
import { decodeExperiment, decodeExperimentResponse, experimentalRequest, semanticFormat } from './semantic-verifier-experiment';

// Owner-approved 2026-11-12: cumulative ceiling raised from $3.00 to $4.00; per-request cap unchanged.
export const LIMITS = Object.freeze({ perRequestUsd: 0.15, cumulativeUsd: 4.0 });
const TENANT = 77;
// Single-line form of the active AdMotion PDF sentence (business test content).
export const SOURCE = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const QUESTIONS: Record<Language, string> = {
  fa: 'من اولین باره می‌خوام بیام استودیو. بهتره چقدر زودتر از نوبتم اونجا باشم؟',
  ar: 'إذا كانت هذه زيارتي الأولى، قبل كم دقيقة من موعدي يُنصح أن أصل؟',
  en: 'How early should I arrive for my first visit?',
  sv: 'Hur tidigt bör jag komma inför mitt första besök?',
  de: 'Wie früh sollte ich zu meinem ersten Besuch kommen?',
  es: '¿Con cuánta antelación debería llegar a mi primera visita?',
};
export type Language = 'fa' | 'ar' | 'en' | 'sv' | 'de' | 'es';
type Role = 'purpose' | 'upper_bound' | 'lower_bound' | 'none' | 'unknown';
type BoundLabel = 'unbounded' | 'maximum' | 'minimum' | 'unknown';
export type Label = { role: Role; bound: BoundLabel; modality: 'recommended' | 'required' | 'unknown';
  anchor: 'before_appointment' | 'after_appointment' | 'unknown'; faithful: boolean };
export type Context = { evidenceBusinessId?: number; evidenceVersion?: string; citedQuote?: string };
export type EvalCase = { id: string; language: Language; category: string; text: string; label: Label; context?: Context };

const ok = (role: Role = 'purpose'): Label => ({ role, bound: 'unbounded', modality: 'recommended', anchor: 'before_appointment', faithful: true });
const bad = (patch: Partial<Label>): Label => ({ ...ok(), ...patch, faithful: false });
const faBase = 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند';
const c = (id: string, language: Language, category: string, text: string, label: Label, context?: Context): EvalCase =>
  ({ id, language, category, text, label, ...(context ? { context } : {}) });

// Human labels describe the sentence, never what the parser recognises.
// Persian purpose variants mirror the 2026-11-12 parser measurement; other
// rows mirror labeledPairs/additionalLabels in semantic-recovery-replay.test.ts.
export const CASES: readonly EvalCase[] = Object.freeze([
  ...[' تا با آرامش آماده شوند.', ' تا بتوانند با آرامش آماده شوند.', '، تا بتوانند با آرامش آماده شوند.', ' تا آماده شوند.',
    ' تا وقت کافی برای آماده شدن داشته باشند.', ' تا فرصت آماده شدن داشته باشند.', ' تا بدون عجله آماده شوند.', ' تا با خیال راحت آماده شوند.',
    ' تا فرصت داشته باشند با آرامش آماده شوند.', ' تا زمان کافی برای آماده‌سازی داشته باشند.', '، برای اینکه با آرامش آماده شوند.',
    ' برای آماده شدن با آرامش.', ' تا بتوانید با آرامش آماده شوید.'].map((tail, i) => c(`fa-purpose-${i + 1}`, 'fa', 'purpose', faBase + tail, ok())),
  c('fa-purpose-14', 'fa', 'purpose', 'به کسانی که اولین بار می‌آیند توصیه می‌شود حدود ۱۰ دقیقه زودتر از نوبت بیایند تا با آرامش آماده شوند.', ok()),
  c('fa-purpose-15', 'fa', 'purpose', 'اگر بار اول است، بهتر است حدود ۱۰ دقیقه قبل از وقت رزرو برسید تا با آرامش آماده شوید.', ok()),
  c('fa-purpose-16', 'fa', 'purpose', 'برای اولین مراجعه، حدود ۱۰ دقیقه زودتر از نوبتتان برسید تا فرصت آماده شدن داشته باشید.', ok()),
  c('fa-max-explicit', 'fa', 'explicit limit', faBase.replace('حدود', 'حداکثر') + '.', bad({ role: 'none', bound: 'maximum' })),
  c('fa-max-ta-prefix', 'fa', 'explicit limit', faBase.replace('حدود ', 'تا ') + '.', bad({ role: 'upper_bound', bound: 'maximum' })),
  c('fa-max-ta-same', 'fa', 'connective limit', faBase.replace('حدود ', '') + '، تا همین میزان زودتر.', bad({ role: 'upper_bound', bound: 'maximum' })),
  c('fa-min-explicit', 'fa', 'explicit limit', faBase.replace('حدود', 'حداقل') + '.', bad({ role: 'none', bound: 'minimum' })),
  c('fa-required', 'fa', 'modality', 'مراجعه‌کنندگان بار اول باید حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با آرامش آماده شوند.', bad({ modality: 'required' })),
  c('fa-negated', 'fa', 'negation', 'توصیه نمی‌شود مراجعه‌کنندگان بار اول حدود ۱۰ دقیقه قبل از نوبت برسند تا آماده شوند.', bad({ modality: 'unknown' })),
  c('fa-after', 'fa', 'anchor', faBase.replace('قبل از', 'بعد از') + ' تا با آرامش آماده شوند.', bad({ anchor: 'after_appointment' })),
  c('fa-wrong-number', 'fa', 'quantity', faBase.replace('۱۰', '۲۰') + ' تا با آرامش آماده شوند.', bad({})),
  c('fa-wrong-unit', 'fa', 'quantity', faBase.replace('دقیقه', 'ساعت') + ' تا با آرامش آماده شوند.', bad({})),
  c('fa-false-purpose', 'fa', 'false purpose', faBase + ' تا فرم‌های پرداخت را تکمیل کنند.', bad({})),
  c('fa-fabricated-fact', 'fa', 'fabricated fact', faBase + ' تا با آرامش آماده شوند؛ پارکینگ هم رایگان است.', bad({})),
  c('fa-audience', 'fa', 'audience', 'به همه مراجعه‌کنندگان توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با آرامش آماده شوند.', bad({})),
  c('fa-deadline', 'fa', 'deadline', 'مهلت لغو: تا ۱۰ دقیقه قبل از نوبت.', bad({ role: 'upper_bound', bound: 'maximum', modality: 'required' })),
  c('fa-ambiguous', 'fa', 'ambiguous connective', faBase + ' تا قبل از شروع نوبت.', bad({ role: 'unknown', bound: 'unknown' })),
  c('fa-tenant', 'fa', 'tenant leakage', faBase + ' تا با آرامش آماده شوند.', bad({}), { evidenceBusinessId: TENANT + 1 }),
  c('fa-stale', 'fa', 'stale source', faBase + ' تا با آرامش آماده شوند.', bad({}), { evidenceVersion: 'superseded' }),
  c('fa-citation', 'fa', 'citation', faBase + ' تا با آرامش آماده شوند.', bad({}), { citedQuote: 'Förstagångsbesökare ska komma 10 minuter före.' }),
  c('ar-purpose-likay', 'ar', 'purpose', 'يُنصح الزوار لأول مرة بالحضور قبل موعدهم بحوالي ١٠ دقائق لكي يستعدوا.', ok()),
  c('ar-purpose-hatta', 'ar', 'purpose', 'يُنصح الزوار لأول مرة بالحضور قبل موعدهم بحوالي ١٠ دقائق حتى يستعدوا بهدوء.', ok()),
  c('ar-max', 'ar', 'explicit limit', 'يُنصح الزوار لأول مرة بألا يحضروا قبل موعدهم بأكثر من ١٠ دقائق.', bad({ role: 'none', bound: 'maximum' })),
  c('ar-min', 'ar', 'explicit limit', 'يُنصح الزوار لأول مرة بالحضور قبل موعدهم بعشر دقائق على الأقل.', bad({ role: 'none', bound: 'minimum' })),
  c('en-purpose', 'en', 'purpose', 'First-time visitors are advised to arrive about 10 minutes before the appointment so they have time to prepare.', ok()),
  c('en-max', 'en', 'explicit limit', 'First-time visitors are advised to arrive no more than 10 minutes before the appointment.', bad({ role: 'none', bound: 'maximum' })),
  c('en-min', 'en', 'explicit limit', 'First-time visitors are advised to arrive at least 10 minutes before the appointment.', bad({ role: 'none', bound: 'minimum' })),
  c('en-required', 'en', 'modality', 'First-time visitors must arrive about 10 minutes before the appointment to prepare.', bad({ modality: 'required' })),
  c('sv-purpose', 'sv', 'purpose', 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig.', ok()),
  c('sv-max', 'sv', 'explicit limit', 'Förstagångsbesökare rekommenderas att komma högst 10 minuter före sin bokade tid.', bad({ role: 'none', bound: 'maximum' })),
  c('sv-min', 'sv', 'explicit limit', 'Förstagångsbesökare rekommenderas att komma minst 10 minuter före sin bokade tid.', bad({ role: 'none', bound: 'minimum' })),
  c('de-purpose', 'de', 'purpose', 'Beim ersten Besuch wird empfohlen, etwa 10 Minuten vor dem Termin zu kommen, um sich vorzubereiten.', ok()),
  c('de-max', 'de', 'explicit limit', 'Beim ersten Besuch wird empfohlen, höchstens 10 Minuten vor dem Termin zu kommen.', bad({ role: 'none', bound: 'maximum' })),
  c('de-min', 'de', 'explicit limit', 'Beim ersten Besuch wird empfohlen, mindestens 10 Minuten vor dem Termin zu kommen.', bad({ role: 'none', bound: 'minimum' })),
  c('es-purpose', 'es', 'purpose', 'Se recomienda llegar unos 10 minutos antes de la primera cita para tener tiempo de prepararse.', ok()),
  c('es-max', 'es', 'explicit limit', 'Se recomienda llegar como máximo 10 minutos antes de la primera cita.', bad({ role: 'none', bound: 'maximum' })),
  c('es-min', 'es', 'explicit limit', 'Se recomienda llegar al menos 10 minutos antes de la primera cita.', bad({ role: 'none', bound: 'minimum' })),
]);

// ---------------------------------------------------------------------------
// Deterministic layer. Only the parser's own outputs are used; no new patterns.
export type Deterministic = { numericalSafe: boolean; reason: string; contextValid: boolean; eligible: boolean; blockedBy: string | null };
export function deterministic(item: EvalCase): Deterministic {
  const ctx = item.context ?? {};
  const contextValid = (ctx.evidenceBusinessId ?? TENANT) === TENANT && (ctx.evidenceVersion ?? 'current') === 'current' &&
    SOURCE.includes(ctx.citedQuote ?? SOURCE);
  const assessment = assessNumericalConstraint(item.text, item.text, [ctx.citedQuote ?? SOURCE]);
  const shapes = numericalComparisonShapes(assessment);
  // Recovery may only reconsider a bound the parser itself attributes to an
  // ambiguous connective after the quantity. Explicit limits, quantity/unit,
  // anchor, cancellation scope and ambiguity mismatches are absolute vetoes.
  const blockedBy = !contextValid ? 'CONTEXT' : assessment.safe ? null :
    assessment.reason !== 'SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH' ? assessment.reason :
    assessment.checks.some(check => check.constraints.length !== 1) ? 'CLAIM_QUANTITY_COUNT' :
    !shapes.length ? 'NO_COMPARABLE_SOURCE_QUANTITY' :
    shapes.some(s => s.boundTriggerCategory !== 'persian_ta' || s.boundTriggerPosition !== 'after_quantity') ? 'EXPLICIT_OR_UNCLASSIFIED_LIMIT' :
    shapes.some(s => s.candidateBound !== 'maximum' || s.sourceBound !== 'unbounded') ? 'BOUND_SHAPE' :
    shapes.some(s => !s.temporalAnchorCompatible || s.candidateAmbiguous || s.sourceAmbiguous ||
      s.candidateCancellationKind !== 'none' || s.sourceCancellationKind !== 'none') ? 'ANCHOR_AMBIGUITY_OR_SCOPE' : null;
  return { numericalSafe: assessment.safe && contextValid, reason: assessment.reason, contextValid,
    eligible: contextValid && !assessment.safe && blockedBy === null, blockedBy };
}

// ---------------------------------------------------------------------------
// Requests, hashes and conservative cost (repository estimator; see test parity).
const facets = parseRequestedFacets([{ subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' }]).facets;
export function requestFor(item: EvalCase) {
  const body = { ...experimentalRequest,
    input: [{ role: 'user', content: JSON.stringify({ question: QUESTIONS[item.language], requestedLanguage: item.language, facets,
      authoritativeEvidence: '{}', evidence: [{ id: 'e1', businessId: TENANT, text: SOURCE }],
      // Neutral structured fields: the verifier must read the candidate text.
      units: [{ id: 'u1', text: item.text, language: item.language, facetIds: [facets[0].id], subject: 'first-time visitors',
        predicate: 'arrival timing', value: 'arrival time relative to the booked appointment', modality: 'recommended', negation: false,
        scope: 'first visit', qualifiers: [], evidenceRefs: [{ evidenceId: 'e1', exactQuote: SOURCE }] }] }) }],
    text: { format: semanticFormat('v2', { u1: ['e1'] }) } };
  return { body, requestSha256: sha256(JSON.stringify(body)), ceilingUsd: ceilingUsd(body) };
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Mirrors requestCeiling() in scripts/knowledge-aen-single-provider.ts. */
export function ceilingUsd(body: { max_output_tokens?: number }) {
  const request = { ...body, max_output_tokens: Math.min(body.max_output_tokens ?? 8192, 8192) };
  return ((Buffer.byteLength(JSON.stringify(request), 'utf8') + 2048) * 0.25 + request.max_output_tokens * 1.2) / 1e6;
}

// ---------------------------------------------------------------------------
// Read-only ledger preflight. Callers pass file CONTENTS; nothing is written.
export type LedgerFile = { name: string; bytes: Buffer; expectedSha256?: string; minRows?: number };
export function ledgerPreflight(ledgers: readonly LedgerFile[], plannedUsd: readonly number[]) {
  const problems: string[] = [];
  let reservedUsd = 0;
  const files = ledgers.map(file => {
    const digest = sha256(file.bytes);
    let parsed: { calls?: unknown[]; estimatedUsd?: number; unmeteredReserveUsd?: number } = {};
    try { parsed = JSON.parse(file.bytes.toString('utf8')); } catch { problems.push(`${file.name}: unreadable`); }
    const rows = Array.isArray(parsed.calls) ? parsed.calls.length : -1;
    if (file.expectedSha256 && digest !== file.expectedSha256) problems.push(`${file.name}: sha256 changed`);
    if (rows < 0 || file.minRows !== undefined && rows < file.minRows) problems.push(`${file.name}: rows ${rows} < ${file.minRows}`);
    if (!Number.isFinite(parsed.estimatedUsd) || !Number.isFinite(parsed.unmeteredReserveUsd) ||
        parsed.estimatedUsd! < 0 || parsed.unmeteredReserveUsd! < 0) problems.push(`${file.name}: totals invalid`);
    else reservedUsd += parsed.estimatedUsd! + parsed.unmeteredReserveUsd!;
    return { name: file.name, sha256: digest, rows, estimatedUsd: parsed.estimatedUsd, unmeteredReserveUsd: parsed.unmeteredReserveUsd };
  });
  const over = plannedUsd.filter(usd => !(usd > 0 && usd <= LIMITS.perRequestUsd)).length;
  if (over) problems.push(`${over} request(s) exceed $${LIMITS.perRequestUsd}`);
  const plannedTotalUsd = plannedUsd.reduce((n, usd) => n + usd, 0);
  const headroomUsd = LIMITS.cumulativeUsd - reservedUsd;
  if (plannedTotalUsd > headroomUsd) problems.push(`planned $${plannedTotalUsd.toFixed(6)} exceeds headroom $${headroomUsd.toFixed(6)}`);
  return { files, reservedUsd, headroomUsd, plannedTotalUsd, ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Scoring. A finding source maps a case to a verifier response text (or null).
export type FindingSource = (item: EvalCase) => string | null;
const positiveVerdict = (entailed: boolean) => ({ unitId: 'u1', facetIds: [facets[0].id], relation: entailed ? 'ENTAILED' : 'CONTRADICTED',
  meaningPreserved: entailed, modalityPreserved: entailed, qualifiersPreserved: entailed, relevant: true, languageCorrect: true,
  explicitAbsenceEvidence: false, negativeAbsence: false });
const coverage = [{ facetId: facets[0].id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
  materialUnitIds: ['u1'], obligations: facets[0].obligations.map(o => ({ obligationId: o.id, status: 'COVERED', unitIds: ['u1'] })) }];
const finding = (label: Pick<Label, 'role' | 'bound' | 'modality' | 'anchor'>) => ({ unitId: 'u1', evidenceId: 'e1', connectiveRole: label.role,
  candidateModality: label.modality, sourceModality: 'recommended', candidateBound: label.bound, sourceBound: 'unbounded',
  candidateAnchor: label.anchor, sourceAnchor: 'before_appointment' });
/** Perfect labeller: upper bound on achievable recall under the deterministic veto. */
export const oracleFindings: FindingSource = item => JSON.stringify({ decisions: [positiveVerdict(item.label.faithful)], coverage,
  findings: [finding(item.label)] });
/** Worst case: always claims a supportive purpose. Measures what determinism alone blocks. */
export const adversarialFindings: FindingSource = () => JSON.stringify({ decisions: [positiveVerdict(true)], coverage,
  findings: [finding(ok())] });
/** Recorded Responses envelopes keyed by case id (real receipts, when they exist). */
export const receiptFindings = (receipts: Record<string, unknown>): FindingSource => item => {
  const decoded = receipts[item.id] === undefined ? null :
    decodeExperimentResponse(receipts[item.id], 'v2', { u1: ['e1'] }, () => {});
  return decoded ? JSON.stringify({ ...decoded.baseline, findings: decoded.findings }) : null;
};

export type Outcome = { id: string; language: Language; category: string; faithful: boolean; accepted: boolean; recovered: boolean;
  blockedBy: string | null; findingStatus: 'NOT_NEEDED' | 'NOT_ELIGIBLE' | 'SUPPORTED' | 'UNSUPPORTED' | 'MISSING' };
export function evaluate(source: FindingSource, cases: readonly EvalCase[] = CASES) {
  const outcomes: Outcome[] = cases.map(item => {
    const d = deterministic(item);
    if (d.numericalSafe) return { id: item.id, language: item.language, category: item.category, faithful: item.label.faithful,
      accepted: true, recovered: false, blockedBy: null, findingStatus: 'NOT_NEEDED' };
    if (!d.eligible) return { id: item.id, language: item.language, category: item.category, faithful: item.label.faithful,
      accepted: false, recovered: false, blockedBy: d.blockedBy, findingStatus: 'NOT_ELIGIBLE' };
    const text = source(item);
    const decoded = text === null ? null : decodeExperiment(text, 'v2', { u1: ['e1'] });
    const supported = !!decoded?.supportedPurposeUnitIds.includes('u1');
    return { id: item.id, language: item.language, category: item.category, faithful: item.label.faithful, accepted: supported,
      recovered: supported, blockedBy: null, findingStatus: text === null || !decoded ? 'MISSING' : supported ? 'SUPPORTED' : 'UNSUPPORTED' };
  });
  const tally = (rows: Outcome[]) => {
    const tp = rows.filter(r => r.faithful && r.accepted).length, fn = rows.filter(r => r.faithful && !r.accepted).length;
    const fp = rows.filter(r => !r.faithful && r.accepted).length, tn = rows.filter(r => !r.faithful && !r.accepted).length;
    return { cases: rows.length, tp, fn, fp, tn, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null,
      falseRecoveries: rows.filter(r => r.recovered && !r.faithful).length, recovered: rows.filter(r => r.recovered).length };
  };
  const languages = [...new Set(outcomes.map(o => o.language))];
  return { outcomes, total: tally(outcomes), byLanguage: Object.fromEntries(languages.map(l => [l, tally(outcomes.filter(o => o.language === l))])) };
}
// ---------------------------------------------------------------------------
// Strategy B (recommended): the deterministic trigger permits ONE complete
// re-extraction under unchanged guidance-free gates. A verifier verdict never
// readmits text; the restated candidate must pass the deterministic gate on its
// own. A restatement source maps a case to the re-extracted unit text (or null).
export type RestatementSource = (item: EvalCase) => { text: string; faithful: boolean } | null;
export function evaluateReextraction(restate: RestatementSource, cases: readonly EvalCase[] = CASES) {
  const outcomes = cases.map(item => {
    const first = deterministic(item);
    if (first.numericalSafe) return { id: item.id, language: item.language, category: item.category, faithful: item.label.faithful, accepted: true, retried: false };
    if (!first.eligible) return { id: item.id, language: item.language, category: item.category, faithful: item.label.faithful, accepted: false, retried: false };
    const restated = restate(item);
    // The retry's text replaces nothing: it is a new, complete run judged alone.
    const second = restated && deterministic({ ...item, text: restated.text });
    return { id: item.id, language: item.language, category: item.category, faithful: !!restated?.faithful,
      accepted: !!second?.numericalSafe, retried: true };
  });
  // Acceptance after a retry IS the unchanged deterministic gate on the new text.
  return { outcomes };
}

/** The deterministic-only production baseline: no finding, so no recovery. */
export const baselineFindings: FindingSource = () => null;
