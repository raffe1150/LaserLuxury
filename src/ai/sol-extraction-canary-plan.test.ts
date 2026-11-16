/** Offline. Shared evidence-first plan with the canary re-extraction hook.
 * Recorded REAL provider outputs (2026-11-12 paid runs) are replayed as
 * scripted transport; synthetic sources cover six languages. No network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEvidenceFirstAnswer, InformationBudget, publishableKnowledgeManifest, parseRequestedFacets,
  REEXTRACTION_CONNECTIVE_GUIDANCE, REEXTRACTION_CITATION_GUIDANCE, type Evidence, type ReExtractionEvent } from './business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
import type { KnowledgeDecision } from './knowledge-answer-protocol';
import { CURRENT_CAPTURE, TENANT } from '../../tests/helpers/admotion-current-inventory';
import { FACETS, INCIDENT_QUESTION, loadIncident, verifier } from '../../tests/helpers/reextraction-plan';

const RUN1 = fileURLToPath(new URL('../../docs/validation/semantic-recovery-luna-sol-20261112', import.meta.url));
const RUN2 = fileURLToPath(new URL('../../docs/validation/semantic-recovery-luna-sol-20261112-repeat', import.meta.url));
const skip = (!existsSync(RUN1) || !existsSync(RUN2) || !existsSync(CURRENT_CAPTURE)) && 'recorded runs or current capture not present';
const recorded = (dir: string, name: string) => JSON.parse(JSON.parse(readFileSync(`${dir}/${name}.receipt.json`, 'utf8')).outputText);

type Stage = 'extraction' | 're_extraction' | 'verification' | 'composition' | 'presentation_verification';
type Script = Partial<Record<Stage, (data: any, instruction: string) => unknown>>;
async function run(input: { question: string; language: string; businessId: number; evidence: Evidence[]; script: Script;
  hook?: boolean; admit?: () => string | null; revalidate?: (call: number) => Evidence[]; facets?: typeof FACETS }) {
  const calls: { stage: Stage; instruction: string; data: any }[] = [];
  const events: KnowledgeDecision[] = [];
  const recordedEvents: ReExtractionEvent[] = [];
  let revalidations = 0;
  const manifest = await runAccuracyFirstNative(() => buildEvidenceFirstAnswer({
    question: input.question, language: input.language, facets: input.facets ?? FACETS, evidence: input.evidence, businessId: input.businessId,
    foreground: true, languageSafe: () => true, verificationProtocol: 'source-exhaustive-v2', extractionProtocol: 'v2', omitModelEvidenceVersions: true,
    authoritativeEvidence: '{}', businessTone: {}, history: [], budget: new InformationBudget(undefined, nativeKnowledgeTiming()),
    current: async () => true,
    revalidateEvidence: async () => input.revalidate ? input.revalidate(++revalidations) : input.evidence,
    diagnostic: e => events.push(e),
    ...(input.hook === false ? {} : { reExtraction: { admit: input.admit ?? (() => null), record: (e: ReExtractionEvent) => recordedEvents.push(e) } }),
    generate: async (stage, instruction, data) => {
      calls.push({ stage: stage as Stage, instruction, data });
      const step = input.script[stage as Stage];
      if (!step) throw new Error('unscripted ' + stage);
      const out = step(data, instruction);
      return { text: typeof out === 'string' ? out : JSON.stringify(out) };
    },
  }), async () => { throw new Error('native timing failed'); });
  assert.ok(manifest);
  return { manifest, calls, events, recorded: recordedEvents, stages: calls.map(c => c.stage),
    publishable: publishableKnowledgeManifest(manifest, input.businessId) };
}
const throws = (message: string) => () => { throw new Error(message); };

// ---------------------------------------------------------------------------
// Recorded real Sol outputs on the current AdMotion inventory (tenant 3).
// Recorded run 2's original «…برسید تا با آرامش آماده شوید» is inside the closed
// Persian purpose grammar since 61cc44f: it parses and needs no recovery.
test('recorded Sol run 2: purpose-clause original parses; re_extraction is never dispatched', { skip }, async () => {
  const incident = await loadIncident();
  const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence, script: {
    extraction: () => recorded(RUN2, '02-sol_original_extraction'), re_extraction: throws('must not dispatch'),
    verification: throws('no recorded verdict for the original') } });
  assert.deepEqual(r.stages, ['extraction', 'verification']);
  assert.equal(r.publishable, false, 'nothing publishes without an independent verdict');
  assert.ok(!r.events.some(e => e.reason === 'NUMERICAL_CONSTRAINT'));
});
for (const [label, dir, names] of [
  ['run 1', RUN1, { first: '04-sol_original_extraction', second: '05-sol_replacement_extraction', verify: '06-verify-sol-output_replacement_verification' }],
  ['run 2', RUN2, { first: '02-sol_original_extraction', second: '03-sol_replacement_extraction', verify: '04-verify-sol-output_replacement_verification' }],
] as const) {
  // Genuine recorded Sol output «…حاضر باشید تا…» (run 1) stays outside the grammar: real recovery.
  if (label === 'run 1') test(`recorded Sol ${label}: one budget-owned re_extraction replaces the تا proposal and publishes`, { skip }, async () => {
    const incident = await loadIncident();
    const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence, script: {
      extraction: () => recorded(dir, names.first), re_extraction: () => recorded(dir, names.second), verification: () => recorded(dir, names.verify) } });
    assert.deepEqual(r.stages, ['extraction', 're_extraction', 'verification']);
    assert.equal(r.publishable, true, JSON.stringify(r.events.map(e => [e.stage, e.reason, e.numericalMismatchReason])));
    assert.equal(r.recorded.length, 1);
    assert.equal(r.recorded[0].trigger, 'ambiguous_connective');
    assert.equal(r.recorded[0].outcome, 'dispatched');
    // Byte-identical request except the appended, validated guidance.
    assert.equal(r.calls[1].instruction, r.calls[0].instruction + '\n' + REEXTRACTION_CONNECTIVE_GUIDANCE);
    assert.deepEqual(r.calls[1].data, r.calls[0].data);
    // The verifier sees ONLY the replacement inventory; no original unit survives.
    const original = recorded(dir, names.first).units.map((u: any) => u.text);
    assert.ok(r.calls[2].data.units.every((u: any) => !original.includes(u.text)));
  });
  test(`recorded Sol ${label}: canary OFF keeps today's fail-closed path (no re_extraction)`, { skip }, async () => {
    const incident = await loadIncident();
    const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence, hook: false, script: {
      extraction: () => recorded(dir, names.first), verification: (d: any) => verifier('labelled')('verification', d) } });
    assert.ok(!r.stages.includes('re_extraction'));
    assert.equal(r.publishable, false);
    assert.equal(r.recorded.length, 0);
  });
}

test('recorded Luna run-2 first pass: its quantity claim is itself ambiguous, so it is NOT a citation trigger', { skip }, async () => {
  // u2 negates a latest-arrival bound; the parser marks the claim ambiguous
  // against the whole admitted inventory (CLAIM_AMBIGUOUS). A re-extraction is
  // not requested for it: no Sol spend, today's fail-closed outcome.
  const incident = await loadIncident();
  const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence, script: {
    extraction: () => recorded(RUN2, '01-luna_original_extraction'), re_extraction: throws('must not dispatch'),
    verification: (d: any) => verifier('labelled')('verification', d) } });
  assert.deepEqual(r.recorded.map(e => [e.trigger, e.outcome]), [['other_rejection', 'not_eligible']]);
  assert.ok(!r.stages.includes('re_extraction'));
  assert.equal(r.publishable, false);
});

// ---------------------------------------------------------------------------
// Fail-closed controls on the exact incident (scripted original/replacement).
const TA_FIRST = (dir = RUN1) => recorded(dir, '04-sol_original_extraction');
const GOOD_SECOND = () => recorded(RUN1, '05-sol_replacement_extraction');
const GOOD_VERIFY = () => recorded(RUN1, '06-verify-sol-output_replacement_verification');

test('admission refusal (permit/budget/deadline/flag) skips re_extraction and fails closed', { skip }, async () => {
  const incident = await loadIncident();
  for (const reason of ['permit_unavailable', 'deadline', 'attempts', 'flag_disabled']) {
    const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence, admit: () => reason,
      script: { extraction: () => TA_FIRST(), verification: (d: any) => verifier('labelled')('verification', d) } });
    assert.ok(!r.stages.includes('re_extraction'));
    assert.deepEqual(r.recorded.map(e => [e.outcome, e.skipReason]), [['skipped', reason]]);
    assert.equal(r.publishable, false);
  }
});

test('source revision or tenant change before dispatch: no re_extraction, SOURCE_INVALID', { skip }, async () => {
  const incident = await loadIncident();
  for (const mutate of [(e: Evidence[]) => e.slice(1), (e: Evidence[]) => e.map((x, i) => i ? x : { ...x, businessId: 4 })]) {
    const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence,
      revalidate: call => call >= 2 ? mutate(incident.evidence) : incident.evidence,
      script: { extraction: () => TA_FIRST(), re_extraction: throws('must not dispatch') } });
    assert.ok(!r.stages.includes('re_extraction'));
    assert.equal(r.recorded[0].outcome, 'source_changed');
    assert.equal(r.manifest.fallbackReason, 'SOURCE_INVALID');
  }
});

test('re_extraction provider failure or malformed output fails closed; the original is never admitted', { skip }, async () => {
  const incident = await loadIncident();
  for (const second of [throws('provider down'), () => 'not-json', () => ({ oversized: false })]) {
    const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence,
      script: { extraction: () => TA_FIRST(), re_extraction: second, verification: throws('no verification') } });
    assert.deepEqual(r.stages, ['extraction', 're_extraction']);
    assert.equal(r.publishable, false);
    assert.ok(['failed', 'dispatched'].includes(r.recorded[0].outcome));
  }
});

test('exactly one re_extraction even when the replacement repeats the trigger', { skip }, async () => {
  const incident = await loadIncident();
  const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence,
    script: { extraction: () => TA_FIRST(), re_extraction: () => TA_FIRST(), verification: (d: any) => verifier('labelled')('verification', d) } });
  assert.equal(r.stages.filter(s => s === 're_extraction').length, 1);
  assert.equal(r.publishable, false);
});

test('replacement cannot import another tenant or an invented citation', { skip }, async () => {
  const incident = await loadIncident();
  const forged = GOOD_SECOND(); forged.units[0].evidenceRefs = [{ evidenceId: 'foreign-tenant-evidence', exactQuote: 'x' }];
  const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence,
    script: { extraction: () => TA_FIRST(), re_extraction: () => forged, verification: throws('no verification') } });
  assert.equal(r.publishable, false);
  assert.ok(r.events.some(e => e.reason === 'INVALID_CITATION'));
});

test('a semantic verifier cannot override the deterministic gates on the replacement', { skip }, async () => {
  const incident = await loadIncident();
  const second = GOOD_SECOND(); second.units[0].text = second.units[0].text.replace('حدود', 'حداکثر');
  const r = await run({ question: INCIDENT_QUESTION, language: 'fa', businessId: TENANT, evidence: incident.evidence,
    script: { extraction: () => TA_FIRST(), re_extraction: () => second, verification: (d: any) => verifier('lenient')('verification', d) } });
  assert.equal(r.publishable, false);
  assert.ok(r.events.some(e => e.reason === 'NUMERICAL_CONSTRAINT'));
});

// ---------------------------------------------------------------------------
// Six languages, synthetic one-tenant sources. Each: (a) the quantity is in
// the source but the unit cites only the neighbouring qualification -> one
// re_extraction; (b) an explicit maximum is NEVER a trigger.
const L = {
  en: { q: 'How early should I arrive for my first visit?', rec: 'First-time visitors are recommended to arrive about 10 minutes before their booked appointment.',
    qual: 'This is a recommendation, not a requirement.', claim: 'First-time visitors should arrive about 10 minutes before the appointment.',
    max: 'First-time visitors should arrive at most 10 minutes before the appointment.' },
  sv: { q: 'Hur tidigt ska jag komma till mitt första besök?', rec: 'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sitt bokade besök.',
    qual: 'Detta är en rekommendation, inte ett krav.', claim: 'Förstagångsbesökare bör komma cirka 10 minuter före besöket.',
    max: 'Förstagångsbesökare bör komma högst 10 minuter före besöket.' },
  de: { q: 'Wie früh sollte ich zu meinem ersten Besuch kommen?', rec: 'Erstbesuchern wird empfohlen, etwa 10 Minuten vor ihrem gebuchten Termin zu kommen.',
    qual: 'Dies ist eine Empfehlung, keine Pflicht.', claim: 'Erstbesucher sollten etwa 10 Minuten vor dem Termin kommen.',
    max: 'Erstbesucher sollten höchstens 10 Minuten vor dem Termin kommen.' },
  es: { q: '¿Con cuánta antelación debo llegar a mi primera visita?', rec: 'Se recomienda a quienes visitan por primera vez llegar unos 10 minutos antes de su cita reservada.',
    qual: 'Es una recomendación, no un requisito.', claim: 'Quienes visitan por primera vez deben llegar unos 10 minutos antes de la cita.',
    max: 'Quienes visitan por primera vez deben llegar como máximo 10 minutos antes de la cita.' },
  fa: { q: 'برای اولین مراجعه چقدر زودتر از نوبتم برسم؟', rec: 'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند.',
    qual: 'این فقط یک توصیه است، نه الزام.', claim: 'مراجعه‌کنندگان بار اول بهتر است حدود ۱۰ دقیقه قبل از نوبت برسند.',
    max: 'مراجعه‌کنندگان بار اول باید حداکثر ۱۰ دقیقه قبل از نوبت برسند.' },
  ar: { q: 'كم يجب أن أصل مبكرًا لزيارتي الأولى؟', rec: 'يُنصح الزوار لأول مرة بالوصول قبل حوالي 10 دقائق من موعدهم المحجوز.',
    qual: 'هذه توصية وليست إلزامًا.', claim: 'يُنصح الزوار لأول مرة بالوصول قبل حوالي 10 دقائق من الموعد.',
    max: 'يجب على الزوار لأول مرة الوصول قبل 10 دقائق على الأكثر من الموعد.' },
} as const;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
function synthetic(language: keyof typeof L, businessId = 77): Evidence[] {
  const s = L[language];
  return [s.rec, s.qual].map((text, i) => ({ id: `e${i + 1}`, businessId, sourceId: `5f0c6c1e-7f3a-4b8a-9c2d-${String(i + 1).padStart(12, '0')}`,
    chunkId: `c${i + 1}`, version: hex(text), text } as Evidence));
}
const unit = (language: string, text: string, quote: string, id: string, data: any) => ({ subject: 'first-time visitors', predicate: 'arrival timing',
  value: 'arrival time', modality: 'recommended', negation: false, scope: 'first visit', qualifiers: [], language, text,
  facetIds: [data.facets[0].id], evidenceRefs: [{ evidenceId: id, exactQuote: quote }] });
for (const language of Object.keys(L) as (keyof typeof L)[]) {
  const s = L[language];
  test(`${language}: quantity cited from the wrong sentence -> one re_extraction -> replacement passes every gate`, async () => {
    const evidence = synthetic(language);
    const r = await run({ question: s.q, language, businessId: 77, evidence, script: {
      extraction: data => ({ oversized: false, units: [unit(language, s.claim, s.qual, 'e2', data)] }),
      re_extraction: data => ({ oversized: false, units: [unit(language, s.claim, s.rec, 'e1', data)] }),
      verification: (d: any) => verifier('lenient')('verification', d) } });
    assert.deepEqual(r.recorded.map(e => [e.trigger, e.outcome]), [['citation_omits_quantity', 'dispatched']],
      JSON.stringify(r.events.filter(e => e.stage === 'extraction').map(e => [e.reason, e.numericalMismatchReason])));
    assert.deepEqual(r.stages, ['extraction', 're_extraction', 'verification']);
    assert.equal(r.publishable, true, JSON.stringify(r.events.map(e => [e.stage, e.reason])));
  });
  test(`${language}: an explicit maximum is never a re_extraction trigger`, async () => {
    const evidence = synthetic(language);
    const r = await run({ question: s.q, language, businessId: 77, evidence, script: {
      extraction: data => ({ oversized: false, units: [unit(language, s.max, s.rec, 'e1', data)] }),
      re_extraction: throws('must not dispatch'), verification: (d: any) => verifier('lenient')('verification', d) } });
    assert.ok(!r.stages.includes('re_extraction'));
    assert.equal(r.recorded[0]?.outcome, 'not_eligible', JSON.stringify(r.events.filter(e => e.stage === 'extraction').map(e => [e.reason, e.numericalMismatchReason])));
    assert.equal(r.publishable, false);
  });
  test(`${language}: a clean first pass needs no re_extraction and equals the OFF manifest`, async () => {
    const evidence = synthetic(language);
    const script: Script = { extraction: data => ({ oversized: false, units: [unit(language, s.claim, s.rec, 'e1', data)] }), verification: (d: any) => verifier('lenient')('verification', d) };
    const on = await run({ question: s.q, language, businessId: 77, evidence, script });
    const off = await run({ question: s.q, language, businessId: 77, evidence, script, hook: false });
    assert.deepEqual(on.recorded.map(e => e.outcome), ['not_needed']);
    assert.deepEqual(on.manifest, off.manifest);
    assert.deepEqual(on.calls, off.calls);
  });
}

test('tenant-mixed admitted evidence is out of scope: no re_extraction', async () => {
  const evidence = [...synthetic('en'), ...synthetic('en', 88).map(e => ({ ...e, id: 'e9' }))];
  const r = await run({ question: L.en.q, language: 'en', businessId: 77, evidence, script: {
    extraction: data => ({ oversized: false, units: [unit('en', L.en.claim, L.en.qual, 'e2', data)] }), re_extraction: throws('must not dispatch'),
    verification: (d: any) => verifier('lenient')('verification', d) } });
  assert.ok(!r.stages.includes('re_extraction'));
  assert.equal(r.recorded[0]?.trigger, 'out_of_scope');
  assert.equal(r.publishable, false);
});

test('unrelated rejection reasons (citation, facet, language, operation claim) never trigger', async () => {
  const evidence = synthetic('en');
  const bad = [(d: any) => ({ ...unit('en', L.en.claim, 'not in source', 'e1', d) }),
    (d: any) => ({ ...unit('en', L.en.claim, L.en.rec, 'e1', d), facetIds: ['zz'] }),
    (d: any) => ({ ...unit('en', L.en.claim, L.en.rec, 'e1', d), language: 'sv' }),
    (d: any) => ({ ...unit('en', 'Your appointment is booked for 10 minutes earlier.', L.en.rec, 'e1', d) })];
  for (const make of bad) {
    const r = await run({ question: L.en.q, language: 'en', businessId: 77, evidence, script: {
      extraction: data => ({ oversized: false, units: [make(data)] }), re_extraction: throws('must not dispatch'), verification: (d: any) => verifier('lenient')('verification', d) } });
    assert.ok(!r.stages.includes('re_extraction'));
    assert.equal(r.publishable, false);
  }
});

void parseRequestedFacets;
