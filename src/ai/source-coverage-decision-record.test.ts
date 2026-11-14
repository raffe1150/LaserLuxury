/** Phase 1 (Unified Brain V2): coverage decision observability. Offline and
 * deterministic: genuine captured verdicts plus SCRIPTED mutations; no
 * provider, network, database or messaging access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessSourceCoverage, SOURCE_COVERAGE_STATES, SOURCE_EXHAUSTIVE_PROTOCOL, SOURCE_EXHAUSTIVE_V2_PROTOCOL } from './source-exhaustive-coverage';
import { buildEvidenceFirstAnswer, InformationBudget, parseAnswerUnits, parseRequestedFacets, type Evidence } from './business-information-answer-plan';
import { MODALITIES, QUESTION_TYPES, RELATIONS, knowledgeDiagnosticFailure } from './knowledge-answer-protocol';
import { runAccuracyFirstNative, nativeKnowledgeTiming } from './knowledge-timing-policy';
import {
  assessSourceCoverageDetailed, boundSourceCoverageRecord, describeSourceCoverageDecision, describeSourceCoveragePrecondition, emitSourceCoverageAccepted,
  sourceCoverageField, GUARD_04_CHECKS, RECORD_INCOMPLETENESS, RECORD_MODALITIES, RECORD_QUESTION_TYPES, RECORD_RELATIONS, SOURCE_COVERAGE_CHECKS,
  SOURCE_COVERAGE_DECISION_MAX_BYTES, SOURCE_COVERAGE_DECISION_SCHEMA, SOURCE_COVERAGE_GUARDS, type SourceCoverageDecisionRecord,
} from './source-coverage-decision-record';

const capture = JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', import.meta.url), 'utf8'));
type Ctx = { facets: any[]; evidence: any[]; units: any[]; raw: any; protocol: any };

/** SCOPED_PARTIAL context: genuine captured facets/units/decisions plus a TEST-ONLY certificate. */
function partial(): Ctx {
  const facets = parseRequestedFacets(capture.verification.input.facets).facets;
  const evidence = structuredClone([...capture.frozen.evidence, capture.frozen.configurationEvidence]);
  const units = parseAnswerUnits({ units: capture.verification.input.units }, facets, evidence, 'en').units.map(u => ({ ...u }));
  const raw = { ...structuredClone(JSON.parse(capture.verification.outputText)), sourceCoverage: {
    protocol: SOURCE_EXHAUSTIVE_PROTOCOL, requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true, conflictsAbsent: true,
    evidenceIdsReviewed: evidence.map(e => e.id), acceptedUnitIdsReviewed: units.map(u => u.id),
    obligations: facets.flatMap(f => f.obligations.map(o => ({ facetId: f.id, obligationId: o.id,
      state: o.questionType === 'requirement' ? 'UNRESOLVED_REQUIREMENT' : 'REQUESTED_INFORMATION_NOT_VERIFIED' }))) } };
  return { facets: [...facets], evidence, units, raw, protocol: SOURCE_EXHAUSTIVE_PROTOCOL };
}
/** COMPLETE context: the descriptive facet only, fully covered (TEST-ONLY verdict). */
function complete(): Ctx {
  const c = partial(), f = c.facets[0], ids = c.units.map(u => u.id);
  c.facets = [f];
  c.raw.coverage = [{ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE', materialUnitIds: [...ids],
    obligations: [{ obligationId: f.obligations[0].id, status: 'COVERED', unitIds: [...ids] }] }];
  c.raw.sourceCoverage.obligations = [{ facetId: f.id, obligationId: f.obligations[0].id, state: 'COMPLETE' }];
  return c;
}
const original = (c: Ctx) => assessSourceCoverage(c.raw, c.facets, c.units, c.evidence, 77, c.protocol);
const detailed = (c: Ctx) => assessSourceCoverageDetailed(c.raw, c.facets, c.units, c.evidence, 77, c.protocol);

/** The original function's own guard label, via its pre-existing optional diagnostic. */
function legacyGuard(t: any, c: Ctx): string | null {
  const saved = process.env.ODINLINK_KNOWLEDGE_COVERAGE_DIAGNOSTICS; process.env.ODINLINK_KNOWLEDGE_COVERAGE_DIAGNOSTICS = '1';
  const seen: string[] = [];
  const mock = t.mock.method(console, 'warn', (label: string, payload: string) => { if (label === '[SourceCoverageDenied]') seen.push(JSON.parse(payload).guard); });
  try { original(c); } finally { mock.mock.restore(); if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_COVERAGE_DIAGNOSTICS; else process.env.ODINLINK_KNOWLEDGE_COVERAGE_DIAGNOSTICS = saved; }
  assert.ok(seen.length <= 1);
  return seen[0] ?? null;
}

// Every string value a record may contain. Anything else would be content.
const ALLOWED = new Set<string>([SOURCE_COVERAGE_DECISION_SCHEMA, SOURCE_EXHAUSTIVE_PROTOCOL, SOURCE_EXHAUSTIVE_V2_PROTOCOL, 'unsupported',
  'COMPLETE', 'SCOPED_PARTIAL', 'DENIED', ...SOURCE_COVERAGE_GUARDS, ...SOURCE_COVERAGE_CHECKS, ...SOURCE_COVERAGE_STATES,
  ...RECORD_QUESTION_TYPES, 'other', 'COVERED', 'UNRESOLVED', ...RECORD_INCOMPLETENESS, 'ABSENT', 'DUPLICATE', 'INVALID', 'PRESENT',
  'BLOCKED', 'PASSED', 'NOT_REACHED', 'OWNER_PROPOSAL_REQUIRES_COMPLETE']);
function assertPrivate(record: SourceCoverageDecisionRecord, forbidden: readonly string[] = []) {
  const json = JSON.stringify(record);
  assert.ok(Buffer.byteLength(json, 'utf8') <= SOURCE_COVERAGE_DECISION_MAX_BYTES, `record ${json.length} bytes`);
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') assert.ok(ALLOWED.has(v), `non-enum string at ${path}`);
    else if (typeof v === 'number') assert.ok(Number.isInteger(v) && v >= 0 && v <= 99, `unbounded number at ${path}`);
    else if (Array.isArray(v)) { assert.ok(v.length <= 32, `unbounded array at ${path}`); v.forEach((x, i) => walk(x, `${path}[${i}]`)); }
    else if (v && typeof v === 'object') { assert.ok(!('businessId' in v)); for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`); }
    else assert.ok(v === null || typeof v === 'boolean' || v === undefined, `unexpected ${typeof v} at ${path}`);
  };
  walk(record, '$');
  for (const text of forbidden) if (text.length >= 8) assert.ok(!json.includes(text), 'record contains source or unit content');
}
const contentOf = (c: Ctx) => [...c.evidence.flatMap(e => [e.text, e.sourceId, e.version]), ...c.units.flatMap(u => [u.text, u.value, u.subject])];

test('local enum copies match the protocol definitions', () => {
  assert.deepEqual([...RECORD_QUESTION_TYPES], [...QUESTION_TYPES]);
  assert.deepEqual([...RECORD_MODALITIES], [...MODALITIES]);
  assert.deepEqual([...RECORD_RELATIONS], [...RELATIONS]);
});

test('valid answers keep their exact assessment and are labelled NONE', () => {
  for (const [c, state] of [[partial(), 'SCOPED_PARTIAL'], [complete(), 'COMPLETE']] as const) {
    const d = detailed(c);
    assert.deepEqual(d.assessment, original(c));
    assert.equal(d.assessment.state, state);
    assert.equal(d.record.state, state); assert.equal(d.record.guard, 'NONE'); assert.deepEqual(d.record.failedChecks, []);
    assert.equal(d.record.consistent, true); assert.equal(d.record.guard12, 'PASSED'); assert.equal(d.record.truncated, false);
    assert.equal(d.record.counts.unavailable, d.assessment.unavailable.length);
    assertPrivate(d.record, contentOf(c));
  }
});

const g04: Record<string, [(c: Ctx) => void, readonly string[]]> = {
  'assessment shape (missing obligations key)': [c => { delete c.raw.sourceCoverage.obligations; }, ['ASSESSMENT_SHAPE_INVALID']],
  'assessment absent': [c => { c.raw.sourceCoverage = null; }, ['ASSESSMENT_SHAPE_INVALID']],
  'assessment protocol mismatch': [c => { c.raw.sourceCoverage.protocol = SOURCE_EXHAUSTIVE_V2_PROTOCOL; }, ['ASSESSMENT_PROTOCOL_MISMATCH']],
  'request not aligned': [c => { c.raw.sourceCoverage.requestAligned = false; }, ['REQUEST_NOT_ALIGNED']],
  'available facts incomplete': [c => { c.raw.sourceCoverage.availableMaterialFactsComplete = false; }, ['AVAILABLE_FACTS_INCOMPLETE']],
  'conditions not preserved': [c => { c.raw.sourceCoverage.conditionsPreserved = false; }, ['CONDITIONS_NOT_PRESERVED']],
  'conflicts present': [c => { c.raw.sourceCoverage.conflictsAbsent = false; }, ['CONFLICTS_PRESENT']],
  'evidence inventory omission': [c => { c.raw.sourceCoverage.evidenceIdsReviewed.pop(); }, ['EVIDENCE_INVENTORY_MISMATCH']],
  'evidence inventory duplicate': [c => { c.raw.sourceCoverage.evidenceIdsReviewed.push(c.evidence[0].id); }, ['EVIDENCE_INVENTORY_MISMATCH']],
  'unit inventory omission': [c => { c.raw.sourceCoverage.acceptedUnitIdsReviewed.pop(); }, ['UNIT_INVENTORY_MISMATCH']],
  'non-boolean attestation': [c => { c.raw.sourceCoverage.requestAligned = 'true'; }, ['REQUEST_NOT_ALIGNED']],
  'several at once': [c => { c.raw.sourceCoverage.conditionsPreserved = false; c.raw.sourceCoverage.availableMaterialFactsComplete = false;
    c.raw.sourceCoverage.acceptedUnitIdsReviewed = []; }, ['AVAILABLE_FACTS_INCOMPLETE', 'CONDITIONS_NOT_PRESERVED', 'UNIT_INVENTORY_MISMATCH']],
};
for (const [name, [change, expected]] of Object.entries(g04)) test(`GUARD_04 sub-check is distinguished: ${name}`, t => {
  const c = partial(); change(c);
  const d = detailed(c);
  assert.equal(d.assessment.state, 'DENIED'); assert.deepEqual(d.assessment, original(c));
  assert.equal(legacyGuard(t, c), 'GUARD_04');
  assert.equal(d.record.guard, 'GUARD_04'); assert.equal(d.record.consistent, true);
  assert.deepEqual(d.record.failedChecks, expected);
  assertPrivate(d.record, contentOf(c));
});

test('every GUARD_04 sub-check category is reachable', () => {
  const seen = new Set(Object.values(g04).flatMap(([, e]) => e));
  assert.deepEqual([...GUARD_04_CHECKS].filter(k => !seen.has(k)), []);
});

test('inventory mismatch is counted, never listed', () => {
  const c = partial(); c.raw.sourceCoverage.evidenceIdsReviewed = [c.evidence[0].id, c.evidence[0].id, 'invented-id', 7];
  const r = detailed(c).record;
  assert.deepEqual(r.evidenceInventory, { expected: c.evidence.length, reviewed: 4, missing: c.evidence.length - 1, unexpected: 2, duplicate: 1 });
  assert.ok(!JSON.stringify(r).includes('invented-id'));
});

test('a German-shaped denial is recorded as reported, without inventing a cause', () => {
  // recommendation + requirement units, verifier reports a lost condition (SCRIPTED).
  const c = partial();
  c.units[0] = { ...c.units[0], modality: 'recommended' };
  c.raw.sourceCoverage.conditionsPreserved = false; c.raw.sourceCoverage.obligations[0].state = 'MISSING_CONDITION';
  const r = detailed(c).record;
  assert.equal(r.state, 'DENIED'); assert.equal(r.guard, 'GUARD_04'); assert.deepEqual(r.failedChecks, ['CONDITIONS_NOT_PRESERVED']);
  assert.deepEqual(r.obligations.map(o => [o.questionType, o.sourceState]), [['description', 'MISSING_CONDITION'], ['requirement', 'UNRESOLVED_REQUIREMENT']]);
  assert.equal(r.guard12, 'NOT_REACHED'); assert.equal(r.guard12Latent, true);
  assert.equal(r.unitModalities.recommended, 1);
});

test('partial-answer guards are unchanged and labelled (GUARD_11, GUARD_12)', t => {
  const g12 = partial(); g12.units[0] = { ...g12.units[0], modality: 'recommended' };
  const d12 = detailed(g12);
  assert.deepEqual(d12.assessment, original(g12)); assert.equal(d12.assessment.state, 'DENIED');
  assert.equal(legacyGuard(t, g12), 'GUARD_12');
  assert.equal(d12.record.guard, 'GUARD_12'); assert.equal(d12.record.guard12, 'BLOCKED'); assert.equal(d12.record.guard12Latent, true);
  const g11 = partial(); g11.raw.sourceCoverage.obligations[1].state = 'REQUESTED_INFORMATION_NOT_VERIFIED';
  const d11 = detailed(g11);
  assert.equal(d11.assessment.state, 'DENIED'); assert.equal(legacyGuard(t, g11), 'GUARD_11');
  assert.equal(d11.record.guard, 'GUARD_11'); assert.deepEqual(d11.record.failedChecks, ['UNAVAILABLE_STATE_NOT_PERMITTED']);
});

test('tenant isolation: foreign evidence stays denied and the record carries no tenant identifier', t => {
  const c = partial(); c.evidence[0].businessId = 99;
  const d = detailed(c);
  assert.equal(d.assessment.state, 'DENIED'); assert.equal(legacyGuard(t, c), 'GUARD_02');
  assert.equal(d.record.guard, 'GUARD_02'); assert.deepEqual(d.record.failedChecks, ['INPUT_CONTRACT_INVALID']);
  assertPrivate(d.record, contentOf(c));
  const other = partial(); other.evidence = other.evidence.map(e => ({ ...e, businessId: 4382 }));
  assert.equal(assessSourceCoverageDetailed(other.raw, other.facets, other.units, other.evidence, 4382).assessment.state, 'SCOPED_PARTIAL');
});

// Seeded differential fuzz: the record must reproduce the authoritative state
// and the original function's own guard label on every mutated verdict.
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; }
const pick = (list: any, r: () => number) => Array.isArray(list) && list.length ? list[Math.floor(r() * list.length)] : undefined;
const MUTATIONS: ((c: Ctx, r: () => number) => void)[] = [
  (c, r) => { const k = ['requestAligned', 'availableMaterialFactsComplete', 'conditionsPreserved', 'conflictsAbsent'][Math.floor(r() * 4)];
    if (c.raw.sourceCoverage) c.raw.sourceCoverage[k] = [false, null, 'yes', true][Math.floor(r() * 4)]; },
  c => { c.raw.sourceCoverage?.evidenceIdsReviewed?.pop(); },
  c => { c.raw.sourceCoverage?.acceptedUnitIdsReviewed?.push('u9'); },
  (c, r) => { const o = pick(c.raw.sourceCoverage?.obligations, r); if (o) o.state = [...SOURCE_COVERAGE_STATES, 'BOGUS'][Math.floor(r() * 7)]; },
  (c, r) => { const o = pick(c.raw.sourceCoverage?.obligations, r); if (o) o.facetId = 'f9'; },
  (c, r) => { const x = pick(c.raw.coverage, r); if (x) x.incompletenessReason = [...RECORD_INCOMPLETENESS, 'BOGUS'][Math.floor(r() * 6)]; },
  (c, r) => { const x = pick(c.raw.coverage, r); if (x) x.materialFactsComplete = !x.materialFactsComplete; },
  (c, r) => { const x = pick(pick(c.raw.coverage, r)?.obligations, r); if (x) x.status = ['COVERED', 'UNRESOLVED', 'X'][Math.floor(r() * 3)]; },
  (c, r) => { const x = pick(pick(c.raw.coverage, r)?.obligations, r); if (x) x.unitIds = r() < 0.5 ? [] : [c.units[0].id]; },
  (c, r) => { const d = pick(c.raw.decisions, r); if (d) d.relation = [...RECORD_RELATIONS, 'X'][Math.floor(r() * 5)]; },
  (c, r) => { const d = pick(c.raw.decisions, r); if (d) d.qualifiersPreserved = false; },
  (c, r) => { const i = Math.floor(r() * c.units.length); c.units[i] = { ...c.units[i], modality: RECORD_MODALITIES[Math.floor(r() * 5)] }; },
  (c, r) => { const k = pick(Object.keys(c.raw.sourceCoverage ?? {}), r); if (k) delete c.raw.sourceCoverage[k]; },
  c => { if (c.raw.sourceCoverage) c.raw.sourceCoverage.protocol = SOURCE_EXHAUSTIVE_V2_PROTOCOL; },
  c => { c.evidence[0].businessId = 99; },
  c => { c.raw.extra = 1; },
  c => { c.raw.decisions.pop(); },
  c => { c.raw.coverage.pop(); },
  c => { c.raw.sourceCoverage?.obligations?.pop?.(); },
];
test('differential fuzz: record state and guard match the original on 600 mutated verdicts', t => {
  const r = lcg(20261114), guards = new Map<string, number>();
  for (let i = 0; i < 600; i++) {
    const c = r() < 0.5 ? partial() : complete();
    for (let m = 1 + Math.floor(r() * 3); m > 0; m--) MUTATIONS[Math.floor(r() * MUTATIONS.length)](c, r);
    const expected = original(c), d = detailed(c);
    assert.deepEqual(d.assessment, expected, `case ${i}`);
    assert.equal(d.record.state, expected.state, `case ${i}`);
    assert.equal(d.record.consistent, true, `case ${i}`);
    assert.equal(d.record.guard, legacyGuard(t, c) ?? 'NONE', `case ${i}`);
    assertPrivate(d.record, contentOf(c));
    guards.set(d.record.guard, (guards.get(d.record.guard) ?? 0) + 1);
  }
  for (const g of ['NONE', 'GUARD_02', 'GUARD_03', 'GUARD_04', 'GUARD_05', 'GUARD_06', 'GUARD_07', 'GUARD_08', 'GUARD_09', 'GUARD_10', 'GUARD_11', 'GUARD_12'])
    assert.ok(guards.has(g), `fuzz never reached ${g}: ${JSON.stringify([...guards])}`);
});

test('size cap: realistic worst case fits; oversized detail is truncated, never the summary', () => {
  const c = partial();
  c.raw.sourceCoverage.conditionsPreserved = false; c.raw.sourceCoverage.requestAligned = false; c.raw.sourceCoverage.availableMaterialFactsComplete = false;
  c.raw.sourceCoverage.conflictsAbsent = false; c.raw.sourceCoverage.protocol = 'x'; c.raw.sourceCoverage.evidenceIdsReviewed = []; c.raw.sourceCoverage.acceptedUnitIdsReviewed = [];
  c.facets = [0, 1, 2, 3].map(i => ({ ...c.facets[i % 2], id: `f${i + 1}`, obligations: [0, 1].map(j => ({ ...c.facets[i % 2].obligations[0], id: `f${i + 1}.o${j + 1}` })) }));
  const worst = describeSourceCoverageDecision({ state: 'DENIED', unavailable: [] }, c.raw, c.facets, c.units, c.evidence, 77);
  assert.equal(worst.truncated, false); assert.equal(worst.obligations.length, 8); assertPrivate(worst);
  const huge = boundSourceCoverageRecord({ ...worst, obligations: Array(64).fill(worst.obligations[0]), legacyCoverage: Array(64).fill(worst.legacyCoverage[0]) });
  assert.equal(huge.truncated, true); assert.equal(huge.guard, 'GUARD_04'); assert.deepEqual(huge.failedChecks, worst.failedChecks);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= SOURCE_COVERAGE_DECISION_MAX_BYTES);
});

test('observability failures cannot throw into the decision path', () => {
  const hostile = new Proxy({}, { get() { throw Error('hostile'); }, ownKeys() { throw Error('hostile'); } });
  const c = partial();
  const r = describeSourceCoverageDecision({ state: 'DENIED', unavailable: [] }, hostile, c.facets, c.units, c.evidence, 77);
  assert.equal(r.state, 'DENIED'); assert.notEqual(r.guard, 'NONE');
  assert.deepEqual(sourceCoverageField(() => { throw Error('builder'); }), {});
  assert.doesNotThrow(() => emitSourceCoverageAccepted(() => { throw Error('sink'); }, detailed(c).record));
  const pre = describeSourceCoveragePrecondition({ kind: 'PRECONDITION', protocol: SOURCE_EXHAUSTIVE_PROTOCOL, raw: hostile, facets: c.facets, units: c.units,
    evidence: c.evidence, proposalParseComplete: true, extractionIncomplete: false, conflicts: 1, catalogComplete: true, verified: c.units.length });
  assert.equal(pre.state, 'DENIED');
});

test('the new accepted reason is diagnostic-only; denials keep their failure kind', () => {
  assert.equal(knowledgeDiagnosticFailure({ stage: 'verification', reason: 'SOURCE_COVERAGE_ACCEPTED' }), 'none');
  assert.equal(knowledgeDiagnosticFailure({ stage: 'verification', reason: 'INVALID_COVERAGE' }), 'incomplete_coverage');
});

// ---- End-to-end through the real shared pipeline (scripted provider). ----
const arrival = 'First-time visitors are recommended to arrive about 10 minutes before their booked time.';
const confirmation = 'Please bring your booking confirmation.';
const evidence: Evidence[] = [
  { id: 'e1', businessId: 3, sourceId: 's1', chunkId: 'c1', version: 'r1', text: arrival },
  { id: 'e2', businessId: 3, sourceId: 's2', chunkId: 'c2', version: 'r1', text: confirmation },
];
const unit = (text: string, evidenceId: string, exactQuote: string) => ({ facetIds: ['f1'], subject: 'first visit', predicate: 'preparation',
  value: text, text, scope: 'first-time visitors', qualifiers: [], negation: false, modality: 'recommended', language: 'en', evidenceRefs: [{ evidenceId, exactQuote }] });
const goodUnits = [unit('Arrive about 10 minutes early.', 'e1', arrival), unit('Bring your booking confirmation.', 'e2', confirmation)];
const verdict = (data: any, edit: (v: any) => void = () => {}) => { const v = {
  decisions: data.units.map((u: any) => ({ unitId: u.id, facetIds: u.facetIds, relation: 'ENTAILED', meaningPreserved: true, modalityPreserved: true,
    qualifiersPreserved: true, relevant: true, languageCorrect: true, negativeAbsence: false, explicitAbsenceEvidence: false })),
  coverage: data.facets.map((f: any) => ({ facetId: f.id, requestAligned: true, materialFactsComplete: true, incompletenessReason: 'NONE',
    materialUnitIds: data.units.map((u: any) => u.id),
    obligations: f.obligations.map((o: any) => ({ obligationId: o.id, status: 'COVERED', unitIds: data.units.map((u: any) => u.id) })) })),
  sourceCoverage: { protocol: 'source-exhaustive-v2', requestAligned: true, availableMaterialFactsComplete: true, conditionsPreserved: true,
    conflictsAbsent: true, evidenceIdsReviewed: data.evidence.map((e: any) => e.id), acceptedUnitIdsReviewed: data.units.map((u: any) => u.id),
    obligations: data.facets.flatMap((f: any) => f.obligations.map((o: any) => ({ facetId: f.id, obligationId: o.id, state: 'COMPLETE' }))) } };
  edit(v); return JSON.stringify(v); };

async function run(t: any, o: { units: unknown[]; protocol?: 'source-exhaustive-v2'; edit?: (v: any) => void; sink?: (e: any) => void }) {
  const saved = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'off';
  t.after(() => { if (saved === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = saved; });
  const stages: string[] = [], events: any[] = [];
  let manifest: any, budget: InformationBudget | undefined;
  const facets = parseRequestedFacets([{ subject: 'first visit', attribute: 'preparation before the first visit', questionType: 'description' }]).facets;
  await runAccuracyFirstNative(async () => {
    budget = new InformationBudget(undefined, nativeKnowledgeTiming());
    manifest = await buildEvidenceFirstAnswer({ businessId: 3, question: 'What should I know before my first visit to the studio?', language: 'en',
      facets, evidence, foreground: true, extractionProtocol: 'v2', ...(o.protocol ? { verificationProtocol: o.protocol } : {}),
      authoritativeEvidence: '{}', businessTone: {}, history: [], budget, current: async () => true, revalidateEvidence: async () => evidence,
      diagnostic: e => { events.push(e); o.sink?.(e); },
      generate: async (stage, _i, data: any) => { stages.push(stage);
        return { text: stage === 'extraction' ? JSON.stringify({ oversized: false, units: o.units }) : verdict(data, o.edit) }; } } as any);
  }, async () => assert.fail('unexpected native timeout'));
  const recorded = events.filter(e => e.sourceCoverage !== undefined);
  return { stages, events, recorded, manifest, attempts: budget!.attempts };
}
const publicView = (m: any) => JSON.stringify({ text: m.text, units: m.units, outcomes: m.outcomes, fallbackReason: m.fallbackReason, presentationPath: m.presentationPath });

test('pipeline: an accepted decision emits exactly one SOURCE_COVERAGE_ACCEPTED record and publishes as before', async t => {
  const r = await run(t, { protocol: 'source-exhaustive-v2', units: goodUnits });
  assert.deepEqual(r.stages, ['extraction', 'verification']);
  assert.equal(r.recorded.length, 1);
  assert.equal(r.recorded[0].reason, 'SOURCE_COVERAGE_ACCEPTED'); assert.equal(r.recorded[0].sourceCoverage.state, 'COMPLETE');
  assert.equal(r.recorded[0].sourceCoverage.guard, 'NONE');
  assert.ok(!r.events.some(e => e.reason === 'INVALID_COVERAGE'));
  assert.equal(r.manifest.units.length, 2);
  assertPrivate(r.recorded[0].sourceCoverage, [arrival, confirmation]);
});

test('pipeline: a GUARD_04 denial enriches the existing single INVALID_COVERAGE event', async t => {
  const r = await run(t, { protocol: 'source-exhaustive-v2', units: goodUnits, edit: v => { v.sourceCoverage.conditionsPreserved = false; } });
  assert.deepEqual(r.stages, ['extraction', 'verification']);
  assert.equal(r.events.filter(e => e.reason === 'INVALID_COVERAGE').length, 1);
  assert.equal(r.recorded.length, 1); assert.equal(r.recorded[0].reason, 'INVALID_COVERAGE');
  assert.equal(r.recorded[0].sourceCoverage.guard, 'GUARD_04'); assert.deepEqual(r.recorded[0].sourceCoverage.failedChecks, ['CONDITIONS_NOT_PRESERVED']);
  assert.equal(r.manifest.fallbackReason, 'INVALID_COVERAGE'); assert.equal(r.manifest.units.length, 0);
});

test('pipeline: the early stop and other protocols are unchanged; early stop is labelled', async t => {
  const early = await run(t, { protocol: 'source-exhaustive-v2', units: [goodUnits[0], unit('Bring your passport.', 'e2', 'Please bring your passport.')] });
  assert.deepEqual(early.stages, ['extraction']);
  assert.equal(early.recorded.length, 1); assert.equal(early.recorded[0].reason, 'INVALID_COVERAGE');
  assert.equal(early.recorded[0].sourceCoverage.guard, 'EARLY_STOP'); assert.ok(early.recorded[0].sourceCoverage.failedChecks.length > 0);
  const other = await run(t, { units: goodUnits });
  assert.equal(other.recorded.length, 0, 'non-source-exhaustive protocols emit no coverage record');
});

test('pipeline: a failing diagnostic sink for the new record cannot change the answer, calls or budget', async t => {
  const baseline = await run(t, { protocol: 'source-exhaustive-v2', units: goodUnits });
  const failing = await run(t, { protocol: 'source-exhaustive-v2', units: goodUnits,
    sink: e => { if (e.reason === 'SOURCE_COVERAGE_ACCEPTED') throw Error('telemetry sink down'); } });
  assert.equal(publicView(failing.manifest), publicView(baseline.manifest));
  assert.deepEqual(failing.stages, baseline.stages); assert.equal(failing.attempts, baseline.attempts);
});
