import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import type { Evidence } from './business-information-answer-plan';
import { CURRENT_CAPTURE, TENANT } from '../../tests/helpers/admotion-current-inventory';
import { ceilings, recoverByReextraction, REEXTRACTION_GUIDANCE, type Responder, runOnce } from '../../tests/helpers/reextraction-recovery';
import {
  FACETS as facets, faithfulUnits as faithful, incidentPlan, INCIDENT_QUESTION, loadIncident, originalUnits as original,
  INCIDENT_PURPOSE_TA, originalUnits, REC, responder, TA, type Incident, type Unit,
} from '../../tests/helpers/reextraction-plan';

// Offline only: real current inventory + production contract/adapter/gates;
// model outputs are scripted. Nothing here proves real model behaviour.
const skip = !existsSync(CURRENT_CAPTURE) && 'read-only current production capture not present';
const QUESTIONS = {
  fa: INCIDENT_QUESTION,
  ar: 'إذا كانت هذه زيارتي الأولى، قبل كم دقيقة من موعدي يُنصح أن أصل؟',
  en: 'How early should I arrive for my first visit?', sv: 'Hur tidigt bör jag komma inför mitt första besök?',
  de: 'Wie früh sollte ich zu meinem ersten Besuch kommen?', es: '¿Con cuánta antelación debería llegar a mi primera visita?',
} as const;
type Language = keyof typeof QUESTIONS;
let incident: Incident;
let inventory: Evidence[] = [];
async function load() { if (!inventory.length) { incident = await loadIncident(); inventory = incident.evidence; } }
const current = async () => inventory;
const withVerifier = (units: Unit[], mode: 'lenient' | 'labelled', language = 'fa'): Responder =>
  (stage, data) => responder(incident, units, mode, language)(stage, data);
const replace = (text: string): Unit[] => [{ text, cite: ['recommendation'] }, ...faithful.slice(1)];
// Exact text of Luna's real replacement u2 (recorded 2026-11-12).
const LUNA_U2 = 'این توصیه برای بازدیدکنندگان نخستین‌بار الزامی نیست و حدود ۱۰ دقیقه زودتر، آخرین زمان ورود محسوب نمی‌شود.';

test('2026-11 incident wording now parses as a purpose clause (61cc44f), so no recovery is needed', { skip }, async () => {
  await load();
  const run = await runOnce({ question: QUESTIONS.fa, language: 'fa', facets, businessId: TENANT, evidence: current,
    respond: withVerifier([{ text: INCIDENT_PURPOSE_TA, cite: ['recommendation'] }, ...faithful.slice(1)], 'lenient') });
  assert.ok(!run.events.some(e => e.reason === 'NUMERICAL_CONSTRAINT'), run.events.map(e => `${e.stage}:${e.reason}`).join());
  assert.deepEqual(run.events.find(e => e.stage === 'extraction' && e.reason === 'ACCEPTED')?.counts?.rejected, 0);
});

test('ambiguous-connective incident: original fails closed before paid verification and is classified for one recovery', { skip }, async () => {
  await load();
  const run = await recoverByReextraction({ question: QUESTIONS.fa, language: 'fa', facets, businessId: TENANT, evidence: current,
    original: withVerifier(original, 'labelled'), reextraction: withVerifier(faithful, 'labelled') });
  const reasons = run.original.events.map(e => `${e.stage}:${e.reason}`);
  // Source-exhaustive early stop (61cc44f): a parse-rejected proposal never reaches paid verification.
  assert.ok(reasons.includes('extraction:NUMERICAL_CONSTRAINT'), reasons.join());
  assert.ok(!run.original.wires.some(w => w.stage === 'verification'), 'no original verification request');
  assert.equal(run.original.publishable, false);
  assert.deepEqual(run.trigger, { eligible: true, reason: 'ELIGIBLE' });
  assert.ok(run.replacement);
  assert.equal(run.publishable, true);
  assert.ok(run.manifest.units.every(u => u.text !== TA), 'rejected original wording can never be published');

  // Independence: the replacement re-reads evidence and carries nothing over.
  const origX = run.original.wires.find(w => w.stage === 'extraction')!;
  const [newX, newV] = [run.replacement.wires.find(w => w.stage === 'extraction')!, run.replacement.wires.find(w => w.stage === 'verification')!];
  assert.equal(JSON.stringify(newX.body.input), JSON.stringify(origX.body.input), 'replacement extraction input == original input (no rejected text added)');
  assert.ok(!JSON.stringify(newX.body).includes(TA) && !JSON.stringify(newV.body).includes(TA));
  assert.equal(newX.body.instructions, origX.body.instructions + '\n' + REEXTRACTION_GUIDANCE, 'only one fixed guidance line differs');
  assert.ok(!String(newV.body.instructions).includes(REEXTRACTION_GUIDANCE), 'verification contract carries no re-extraction guidance');
  assert.deepEqual(newX.body.text, origX.body.text, 'extraction schema unchanged');
  assert.equal(run.replacement.wires.length, 2, 'exactly one extraction and one verification');
});

// Replacement outcomes on the real inventory. deterministic: rejected even by a
// lenient verifier. verifier: depends on the existing semantic verifier gate.
const scenarios: { name: string; units: Unit[]; expect: 'publish' | 'deterministic' | 'verifier'; evidence?: () => Promise<Evidence[]> }[] = [
  { name: 'faithful restatement', units: faithful, expect: 'publish' },
  { name: 'repeats ambiguous connective', units: original, expect: 'deterministic' },
  { name: 'explicit maximum', units: replace(REC.replace('حدود', 'حداکثر')), expect: 'deterministic' },
  { name: 'wrong quantity', units: replace(REC.replace('۱۰', '۲۰')), expect: 'deterministic' },
  { name: 'wrong unit', units: replace(REC.replace('دقیقه', 'ساعت')), expect: 'deterministic' },
  { name: 'after instead of before', units: replace(REC.replace('قبل از', 'بعد از')), expect: 'deterministic' },
  { name: 'partial inventory: one unit still ambiguous', units: [...faithful, { text: TA, cite: ['recommendation'] }], expect: 'deterministic' },
  { name: 'foreign evidence id', units: [{ text: REC, cite: ['recommendation'], evidenceId: 'e99' }, ...faithful.slice(1)], expect: 'deterministic' },
  { name: 'quote not in evidence', units: [{ text: REC, cite: ['recommendation'], quote: 'Kunder ska komma exakt 10 minuter före.' }, ...faithful.slice(1)], expect: 'deterministic' },
  { name: 'stale source at revalidation', units: faithful, expect: 'deterministic' },
  { name: 'cross-tenant evidence', units: faithful, expect: 'deterministic' },
  { name: 'required instead of recommended', units: replace('مراجعه‌کنندگان بار اول باید حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند، برای اینکه با آرامش آماده شوند.'), expect: 'verifier' },
  // Corrected criteria: REC alone states every REQUIRED fact; the explicit
  // qualification is helpful and the PDF condition is unrelated to this question.
  { name: 'without explicit not-mandatory sentence (still complete)', units: [faithful[0], faithful[2]], expect: 'publish' },
  { name: 'without PDF special-instructions condition (unrelated)', units: faithful.slice(0, 2), expect: 'publish' },
  { name: 'recommendation only (complete)', units: [faithful[0]], expect: 'publish' },
  // New claim-to-evidence gate: a quantity must appear in the unit's OWN citations.
  { name: 'real Luna u2: quantity cited to a sentence without it', units: [{ text: LUNA_U2, modality: 'descriptive', cite: ['qualification'] }], expect: 'deterministic' },
  { name: 'same text with recommended modality (gate alone)', units: [{ text: LUNA_U2, cite: ['qualification'] }], expect: 'deterministic' },
  { name: 'quantity supported only by a sibling unit', units: [{ text: 'حدود ۱۰ دقیقه برای آماده شدن کافی است.', cite: ['qualification'] }, faithful[0]], expect: 'deterministic' },
  { name: 'misleading citation: unrelated parking sentence', units: [{ text: REC, cite: ['parking'] }], expect: 'deterministic' },
  { name: 'misleading citation: qualification instead of recommendation', units: [{ text: REC, cite: ['qualification'] }], expect: 'deterministic' },
  { name: 'false minimum (at least 10 minutes)', units: replace('مراجعه‌کنندگان بار اول باید دست‌کم ۱۰ دقیقه پیش از نوبت رزروشده برسند.'), expect: 'deterministic' },
  // Known verifier-only gaps, pinned so they stay visible.
  { name: 'GAP incomplete but verifier-approved: qualification only', units: [faithful[1]], expect: 'verifier' },
  { name: 'GAP unsupported qualification (weekdays only)', units: replace(REC + ' این توصیه فقط برای روزهای کاری است.'), expect: 'verifier' },
  { name: 'GAP stated latest arrival time', units: replace('آخرین زمان ورود برای مراجعه‌کنندگان بار اول ۱۰ دقیقه پیش از نوبت رزروشده است.'), expect: 'verifier' },
  { name: 'false purpose', units: replace(REC.replace('با آرامش آماده شوند', 'فرم‌های پرداخت را تکمیل کنند')), expect: 'verifier' },
  { name: 'fabricated fact', units: replace(REC + ' پارکینگ هم رایگان است.'), expect: 'verifier' },
];
const report: Record<string, unknown> = {};
for (const scenario of scenarios) test(`re-extraction: ${scenario.name}`, { skip }, async () => {
  await load();
  const outcome = async (mode: 'lenient' | 'labelled') => {
    // Freshness and tenant scenarios alter only what the REPLACEMENT run re-admits.
    let reads = 0;
    const replacementEvidence = scenario.name === 'stale source at revalidation'
      ? async () => (++reads > 1 ? inventory.map(e => ({ ...e, version: 'superseded' })) : inventory)
      : scenario.name === 'cross-tenant evidence' ? async () => inventory.map((e, i) => i ? e : { ...e, businessId: TENANT + 1 }) : current;
    const run = await recoverByReextraction({ question: QUESTIONS.fa, language: 'fa', facets, businessId: TENANT, evidence: current,
      replacementEvidence, original: withVerifier(original, mode), reextraction: withVerifier(scenario.units, mode) });
    assert.equal(run.trigger.eligible, true);
    assert.ok(run.manifest.units.every(u => u.text !== TA));
    if (scenario.name === 'cross-tenant evidence') assert.equal(run.replacement, null, 'no request may carry another tenant\'s text');
    return { publishable: run.publishable, fallback: run.manifest.fallbackReason, modelCalls: run.replacement?.wires.length ?? 0,
      reasons: run.replacement ? [...new Set(run.replacement.events.filter(e => e.reason !== 'ACCEPTED').map(e => `${e.stage}:${e.reason}`))]
        : ['aborted' in run ? String(run.aborted) : 'NO_REPLACEMENT'] };
  };
  const [lenient, labelled] = [await outcome('lenient'), await outcome('labelled')];
  report[scenario.name] = { lenient: lenient.publishable, labelled: labelled.publishable, modelCalls: lenient.modelCalls,
    reasons: lenient.publishable ? labelled.reasons : lenient.reasons, fallback: lenient.publishable ? labelled.fallback : lenient.fallback };
  if (scenario.expect === 'publish') assert.deepEqual([lenient.publishable, labelled.publishable], [true, true]);
  if (scenario.expect === 'deterministic') assert.deepEqual([lenient.publishable, labelled.publishable], [false, false], JSON.stringify(lenient));
  if (scenario.expect === 'verifier') assert.deepEqual([lenient.publishable, labelled.publishable], [true, false], JSON.stringify({ lenient, labelled }));
});

// The trigger stays narrow: no retry for any other first-pass outcome.
const triggers: { name: string; language: Language; units: Unit[]; reason: string }[] = [
  { name: 'explicit maximum (fa)', language: 'fa', units: replace(REC.replace('حدود', 'حداکثر')), reason: 'NOT_AMBIGUOUS_CONNECTIVE' },
  { name: 'citation failure (fa)', language: 'fa', units: [{ text: TA, cite: ['recommendation'], evidenceId: 'e99' }], reason: 'OTHER_REJECTION' },
  { name: 'Arabic حتى purpose', language: 'ar', units: [{ text: 'يُنصح الزوار لأول مرة بالحضور قبل موعدهم بحوالي ١٠ دقائق حتى يستعدوا بهدوء.', cite: ['recommendation'] }], reason: 'NOT_AMBIGUOUS_CONNECTIVE' },
  { name: 'Arabic purpose', language: 'ar', units: [{ text: 'يُنصح الزوار لأول مرة بالحضور قبل موعدهم بحوالي ١٠ دقائق لكي يستعدوا بهدوء.', cite: ['recommendation'] }], reason: 'PUBLISHABLE' },
  { name: 'English purpose', language: 'en', units: [{ text: 'First-time visitors are recommended to arrive about 10 minutes before the booked time so they can prepare calmly.', cite: ['recommendation'] }], reason: 'PUBLISHABLE' },
  { name: 'Swedish purpose', language: 'sv', units: [{ text: 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.', cite: ['recommendation'] }], reason: 'PUBLISHABLE' },
  { name: 'German purpose', language: 'de', units: [{ text: 'Erstbesuchern wird empfohlen, etwa 10 Minuten vor dem gebuchten Termin zu kommen, um sich in Ruhe vorzubereiten.', cite: ['recommendation'] }], reason: 'PUBLISHABLE' },
  { name: 'Spanish purpose', language: 'es', units: [{ text: 'Se recomienda a quienes vienen por primera vez llegar unos 10 minutos antes de la cita para prepararse con calma.', cite: ['recommendation'] }], reason: 'PUBLISHABLE' },
  { name: 'Arabic «not more than» (known numerical-layer gap)', language: 'ar', units: [{ text: 'يُنصح الزوار لأول مرة بألا يحضروا قبل موعدهم بأكثر من ١٠ دقائق.', cite: ['recommendation'] }], reason: 'PUBLISHABLE' },
];
for (const scenario of triggers) test(`trigger: ${scenario.name}`, { skip }, async () => {
  await load();
  const run = await recoverByReextraction({ question: QUESTIONS[scenario.language], language: scenario.language, facets, businessId: TENANT, evidence: current,
    original: withVerifier(scenario.units, 'lenient', scenario.language), reextraction: () => assert.fail('re-extraction must not run') });
  assert.equal(run.trigger.reason, scenario.reason);
  assert.equal(run.replacement, null);
});

test('dry-run cost of one controlled incident validation (exact production wire bodies)', { skip }, async t => {
  const rows = (await incidentPlan()).map(w => ({ run: w.run, stage: w.stage, model: w.body.model, bytes: w.bytes,
    requestSha256: w.requestSha256, ...ceilings(w), lunaAdmissible: ceilings(w).lunaUsd <= 0.15, solAdmissible: ceilings(w).solUsd <= 0.15 }));
  // The original run stops before paid verification (source-exhaustive early stop, 61cc44f).
  assert.deepEqual(rows.map(r => `${r.run}:${r.stage}`), ['original:extraction', 'replacement:extraction', 'replacement:verification']);
  assert.ok(rows.every(row => row.model === 'gpt-5.6-luna' && row.lunaAdmissible), JSON.stringify(rows));
  t.diagnostic(JSON.stringify({ perIncidentRequests: rows, scenarioReport: report }));
});

test('controlled Luna vs Sol comparison: equivalent requests, per-request cap, and Sol limits made explicit', { skip }, async t => {
  const { comparisonPlan, experimentRequest, incidentPlan: plan, ROUTING_FIELDS } = await import('../../tests/helpers/reextraction-plan');
  const { assertKnowledgeVerificationProtocol } = await import('./knowledge-answer-protocol');
  const { extractionTrigger, ambiguousConnectiveFailure } = await import('../../tests/helpers/reextraction-recovery');
  const rows = await comparisonPlan();
  assert.deepEqual(rows.map(r => r.id), ['luna:original:extraction', 'luna:replacement:extraction', 'sol:original:extraction',
    'sol:replacement:extraction', 'verify-luna-output:replacement:verification', 'verify-sol-output:replacement:verification']);
  for (const row of rows) assert.ok(row.ceilingUsd > 0 && row.ceilingUsd <= 0.15, `${row.id} $${row.ceilingUsd}`);
  // Equivalence: Luna and Sol extraction bodies differ ONLY in routing fields.
  const strip = (body: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !(ROUTING_FIELDS as readonly string[]).includes(k))));
  for (const run of ['original', 'replacement'])
    assert.equal(strip(rows.find(r => r.id === `luna:${run}:extraction`)!.body), strip(rows.find(r => r.id === `sol:${run}:extraction`)!.body));
  for (const row of rows) assert.deepEqual((row.body as any).reasoning, { effort: 'low' });
  // Production refuses source-exhaustive verification under any managed profile.
  const saved = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;
  process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'sol-low-v1';
  try { assert.throws(() => assertKnowledgeVerificationProtocol('source-exhaustive-v2'), /source_exhaustive_managed_profile_unsupported/); }
  finally { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = saved; }
  // And its conservative ceiling would exceed the per-request cap anyway.
  const wires = await plan();
  const solVerification = experimentRequest(wires.find(w => w.run === 'replacement' && w.stage === 'verification')!.body, 'sol');
  assert.ok(solVerification.ceilingUsd > 0.15);
  // The extraction-only trigger agrees with the full-run trigger on the incident.
  await load();
  const original = await runOnce({ question: QUESTIONS.fa, language: 'fa', facets, businessId: TENANT, evidence: current,
    respond: withVerifier(originalUnits, 'labelled') });
  assert.deepEqual(extractionTrigger(original.events), ambiguousConnectiveFailure(original));
  t.diagnostic(JSON.stringify({ comparison: rows.map(r => ({ id: r.id, bytes: r.bytes, ceilingUsd: +r.ceilingUsd.toFixed(8), sha: r.requestSha256.slice(0, 16) })),
    totalUsd: +rows.reduce((n, r) => n + r.ceilingUsd, 0).toFixed(8), solSourceExhaustiveVerificationUsd: +solVerification.ceilingUsd.toFixed(6) }));
});
