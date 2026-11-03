/** Genuine v1 rejection is immutable. Positive v2 decisions are SCRIPTED offline controls. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { assessSourceCoverage, SOURCE_EXHAUSTIVE_PROTOCOL, SOURCE_EXHAUSTIVE_V2_PROTOCOL, SOURCE_EXHAUSTIVE_V2_SCHEMA_NAME,
  SOURCE_EXHAUSTIVE_V2_INSTRUCTION, SOURCE_EXHAUSTIVE_INSTRUCTION } from './source-exhaustive-coverage';
import { parseRequestedFacets, parseAnswerUnits, publishableKnowledgeManifest, completeKnowledgeManifest } from './business-information-answer-plan';
import { knowledgeStructuredOutput, selectKnowledgeVerificationProtocol } from './knowledge-answer-protocol';
import { incidentConfig, incidentFlags } from '../../tests/helpers/p0-incident-knowledge';

const capture = JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', import.meta.url), 'utf8'));
const alignment = JSON.parse(readFileSync(new URL('../../tests/fixtures/genuine-luna-source-alignment-20261102.json', import.meta.url), 'utf8'));
const original = JSON.parse(alignment.outputText);
const evidence = [...capture.frozen.evidence, capture.frozen.configurationEvidence];
const facets = parseRequestedFacets(capture.verification.input.facets).facets;
const units = parseAnswerUnits({ units: capture.verification.input.units }, facets, evidence, 'en').units;
const receipts: any[] = [];
after(() => { if (process.env.ODINLINK_SOURCE_ALIGNMENT_RECEIPT) writeFileSync(process.env.ODINLINK_SOURCE_ALIGNMENT_RECEIPT,
  JSON.stringify({ mode: 'OFFLINE_GENUINE_V1_REJECTION_AND_SCRIPTED_V2_CONTROLS', providerRequests: 0, receipts }, null, 2), { mode: 0o600 }); });
incidentFlags();
Object.assign(process.env, { ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '77',
  ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: SOURCE_EXHAUSTIVE_PROTOCOL, ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL: 'v2' });
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

async function replay(t: any, protocol: string, verdict: any, checkRequest?: (r: any) => void, inspect?: (m: any) => void) {
  for (const m of ['log', 'info', 'warn', 'error']) t.mock.method(console, m, () => {});
  b.reset(); process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = protocol;
  const saved = structuredClone(incidentConfig), row = structuredClone(capture.frozen.rawCancellationSettings);
  const normalized = b.promptAuditNormalize(row), diagnostics: any[] = [], stages: string[] = []; let actions = 0;
  const forbidden = async () => { actions++; throw Error('OFFLINE_ACTION_FORBIDDEN'); };
  try {
    Object.assign(incidentConfig, row, { id: 77, businessId: 77, businessRecordId: 77, business_id: 77, language: 'en',
      cancellationSettingsEvidence: normalized.cancellationSettingsEvidence, allowCancellation: true,
      cancellationDeadlineMinutes: 1440, cancellationFeeEnabled: false, cancellationFeeAmount: 0, cancellationFeeCurrency: 'SEK' });
    b.configure({ offlineAi: true, postProcess: async () => {}, knowledgeCancellationConfig: async (id, signal) => {
      assert.equal(id, 77); signal.throwIfAborted(); return structuredClone(row);
    }, validateKnowledgeMatches: async (id, matches) => { assert.equal(id, 77); return matches; },
    knowledgeServiceCatalog: async () => incidentConfig.services, evidenceFirstDecisionDiagnostic: d => diagnostics.push(d),
    aiGenerate: async r => {
      if (r.systemInstruction.includes('UNIT EXTRACTION')) {
        stages.push('extraction'); assert.deepEqual(JSON.parse(r.messages[0].content), capture.extraction.input);
        return { text: capture.extraction.outputText, functionCalls: [] };
      }
      assert.ok(r.systemInstruction.includes('BATCH ENTAILMENT'), 'No retry or composer'); stages.push('verification');
      assert.deepEqual(JSON.parse(r.messages[0].content), capture.verification.input);
      checkRequest?.(r); return { text: JSON.stringify(verdict), functionCalls: [] };
    }, calendarAdapter: { getCalendarId: () => 'offline', getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden,
      cancelAppointment: forbidden, updateAppointment: forbidden }, recordAppointment: forbidden, cancelAppointmentRow: forbidden, updateAppointmentRow: forbidden });
    let result: any;
    await b.nativeKnowledgeEvidenceRequest({ sessionId: 'alignment-contract-replay', channel: 'telegram', businessConfig: incidentConfig,
      question: capture.frozen.question, language: 'en', facets: capture.verification.input.facets, matches: capture.frozen.matches }, async api => {
      const generated = await api.generate(), manifest = api.manifest()!; inspect?.(manifest);
      result = { allowed: publishableKnowledgeManifest(manifest, 77), complete: completeKnowledgeManifest(manifest),
        manifest, final: await api.publish(generated.text), diagnostics, stages };
    }); assert.equal(actions, 0); assert.deepEqual(stages, ['extraction', 'verification']); return result;
  } finally { for (const k of Object.keys(incidentConfig)) delete (incidentConfig as any)[k]; Object.assign(incidentConfig, saved); b.reset(); }
}

test('exact genuine v1 alignment rejection is DENIED without changing any provider field', () => {
  assert.equal(original.sourceCoverage.requestAligned, false); assert.equal(original.coverage[1].requestAligned, false);
  assert.equal(assessSourceCoverage(original, facets, units, evidence, 77).state, 'DENIED');
  assert.deepEqual(JSON.parse(alignment.outputText), original);
});
test('exact genuine request/schema and rejection replay through native publication remains blocked', async t => {
  const r = await replay(t, SOURCE_EXHAUSTIVE_PROTOCOL, original, request => {
    assert.equal(request.systemInstruction, alignment.request.systemInstruction);
    assert.deepEqual(request.structuredOutput, alignment.request.structuredOutput);
    assert.deepEqual(request.messages, alignment.request.messages);
  });
  assert.equal(r.allowed, false); assert.equal(r.final, capture.finalInterceptedResponse);
  assert.ok(r.diagnostics.some((d: any) => d.reason === 'INVALID_COVERAGE'));
  receipts.push({ kind: 'EXACT_GENUINE_V1_REJECTION', allowed: r.allowed, final: r.final, originalVerdict: original });
});


function scriptedV2() {
  // NOT a repaired provider result. These are explicit test-only expectations
  // for a NEW independent decision under a different producer contract.
  const raw = structuredClone(original);
  raw.sourceCoverage.protocol = SOURCE_EXHAUSTIVE_V2_PROTOCOL;
  raw.sourceCoverage.requestAligned = true;
  raw.coverage[1].requestAligned = true;
  return raw;
}
const assessV2 = (raw: any, es = evidence, us = units) => assessSourceCoverage(raw, facets, us, es, 77, SOURCE_EXHAUSTIVE_V2_PROTOCOL);

test('versioned clarification defines plan alignment independently from relevance, completeness and later disclosure', () => {
  assert.equal(alignment.request.systemInstruction.endsWith(SOURCE_EXHAUSTIVE_INSTRUCTION), true, 'V1 instruction remains byte-for-byte');
  assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION, /BOTH judge the supplied REQUEST PLAN/);
  assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION, /Do not set false solely because/);
  assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION, /decisions\[\]\.relevant/);
  assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION, /Backend limitation disclosures are generated AFTER verification/);
  assert.match(SOURCE_EXHAUSTIVE_V2_INSTRUCTION, /Never force true/);
  assert.doesNotMatch(SOURCE_EXHAUSTIVE_V2_INSTRUCTION, /protocol is source-exhaustive-v1/);
  const oldSchema = alignment.request.structuredOutput.schema;
  const schema: any = knowledgeStructuredOutput('verification', false, undefined, 6, SOURCE_EXHAUSTIVE_V2_PROTOCOL);
  assert.equal(schema.name, SOURCE_EXHAUSTIVE_V2_SCHEMA_NAME); assert.equal(schema.strict, true);
  assert.deepEqual(schema.schema.properties.decisions, oldSchema.properties.decisions);
  const strip = (s: any) => JSON.parse(JSON.stringify(s), (k, v) => k === 'description' ? undefined : v);
  assert.deepEqual(strip(schema.schema.properties.coverage), oldSchema.properties.coverage);
  assert.match(schema.schema.properties.coverage.items.properties.requestAligned.description, /FULL original question/);
  assert.match(schema.schema.properties.sourceCoverage.properties.requestAligned.description, /Not factual answer completeness/);
});

test('old genuine rejection cannot be relabelled, silently upgraded, or used across contract versions', () => {
  assert.equal(assessV2(original).state, 'DENIED');
  const relabelled = structuredClone(original); relabelled.sourceCoverage.protocol = SOURCE_EXHAUSTIVE_V2_PROTOCOL;
  assert.equal(assessV2(relabelled).state, 'DENIED');
  relabelled.sourceCoverage.requestAligned = true; assert.equal(assessV2(relabelled).state, 'DENIED', 'Facet false still vetoes');
  const other = structuredClone(original); other.sourceCoverage.protocol = SOURCE_EXHAUSTIVE_V2_PROTOCOL;
  other.coverage[1].requestAligned = true; assert.equal(assessV2(other).state, 'DENIED', 'Source false still vetoes');
  assert.equal(assessSourceCoverage(scriptedV2(), facets, units, evidence, 77).state, 'DENIED', 'V1 cannot consume V2');
  assert.deepEqual(JSON.parse(alignment.outputText), original);
});

test('SCRIPTED V2 plan-aligned decision permits scoped assessment without resolving either original obligation', () => {
  const raw = scriptedV2(); assert.equal(assessV2(raw).state, 'SCOPED_PARTIAL');
  assert.ok(raw.coverage.every((c: any) => !c.materialFactsComplete && c.obligations.every((o: any) => o.status === 'UNRESOLVED')));
  const undoTestChanges = structuredClone(raw); undoTestChanges.sourceCoverage.protocol = SOURCE_EXHAUSTIVE_PROTOCOL;
  undoTestChanges.sourceCoverage.requestAligned = false; undoTestChanges.coverage[1].requestAligned = false;
  assert.deepEqual(undoTestChanges, original, 'All other genuine fields retained, original itself unchanged');
});

for (const [name, change] of Object.entries({
  'irrelevant but true sourced fact': (c: any) => {
    const text = 'The studio walls are blue.', e = { ...c.es[0], id: 'wall', sourceId: 'wall-guide', text };
    c.es.push(e); c.raw.sourceCoverage.evidenceIdsReviewed.push(e.id);
    c.us[0] = { ...c.us[0], subject: 'studio walls', predicate: 'color', value: 'blue', text,
      evidenceRefs: [{ evidenceId: e.id, sourceId: e.sourceId, chunkId: e.chunkId, version: e.version, exactQuote: text }] };
    c.raw.decisions[0].relevant = false;
  },
  'available material source fact omitted': (c: any) => { c.raw.sourceCoverage.availableMaterialFactsComplete = false; c.raw.sourceCoverage.obligations[0].state = 'AVAILABLE_SOURCE_FACT_OMITTED'; },
  'missing mandatory condition': (c: any) => { c.raw.sourceCoverage.conditionsPreserved = false; c.raw.coverage[0].incompletenessReason = 'MISSING_CONDITION'; },
  'unfaithful original request plan': (c: any) => { c.raw.sourceCoverage.requestAligned = false; c.raw.coverage[1].requestAligned = false; },
  'known rule misclassified as unavailable': (c: any) => {
    c.es.push({ ...c.es[0], id: 'notice', sourceId: 'notice-policy', text: 'Appointments must be cancelled at least 48 hours in advance.' });
    c.raw.sourceCoverage.evidenceIdsReviewed.push('notice'); c.raw.sourceCoverage.availableMaterialFactsComplete = false;
    c.raw.sourceCoverage.obligations[1].state = 'AVAILABLE_SOURCE_FACT_OMITTED';
  },
  'unsupported description of unknown mandatory rule': (c: any) => { c.raw.sourceCoverage.obligations[1].state = 'REQUESTED_INFORMATION_NOT_VERIFIED'; },
  'uncertainty for wrong requested subject': (c: any) => { c.raw.sourceCoverage.obligations[1].facetId = 'f1'; },
  'invented model-authored uncertainty text': (c: any) => { c.raw.sourceCoverage.obligations[1].disclosure = 'No notice or fee applies.'; },
  'unresolved requirement falsely covered': (c: any) => { c.raw.coverage[1].obligations[0].status = 'COVERED'; },
  'fabricated deadline': (c: any) => { c.us[0] = { ...c.us[0], text: 'You must cancel 24 hours in advance.' }; c.raw.decisions[0].relation = 'UNKNOWN'; },
  'universal free cancellation': (c: any) => { c.us[0] = { ...c.us[0], text: 'All cancellations are always free.' }; c.raw.decisions[0].relation = 'UNKNOWN'; },
  'missing necessary source qualification': (c: any) => { c.raw.decisions[0].qualifiersPreserved = false; },
  'invalid citation': (c: any) => { c.us[0] = { ...c.us[0], evidenceRefs: [{ ...c.us[0].evidenceRefs[0], evidenceId: 'foreign' }] }; },
  'stale evidence': (c: any) => { c.es[1].version += '-stale'; },
  'foreign tenant': (c: any) => { c.es[1].businessId = 99; },
  'forged incomplete certificate': (c: any) => { c.raw.sourceCoverage = { protocol: SOURCE_EXHAUSTIVE_V2_PROTOCOL, requestAligned: true }; },
  'conflicting evidence': (c: any) => { c.raw.sourceCoverage.conflictsAbsent = false; },
  'inconsistent completeness': (c: any) => { c.raw.coverage[1].materialFactsComplete = true; },
} as Record<string, (c: any) => void>)) test(`V2 alignment clarification retains veto/${name}`, () => {
  const c = { raw: scriptedV2(), es: structuredClone(evidence), us: structuredClone(units) }; change(c);
  assert.equal(assessV2(c.raw, c.es, c.us).state, 'DENIED');
});

test('SCRIPTED V2 publishes all verified facts with the exact bounded limitations through native authority', async t => {
  const raw = scriptedV2();
  const r = await replay(t, SOURCE_EXHAUSTIVE_V2_PROTOCOL, raw, request => {
    assert.equal(request.systemInstruction, alignment.request.systemInstruction.slice(0, -SOURCE_EXHAUSTIVE_INSTRUCTION.length) + SOURCE_EXHAUSTIVE_V2_INSTRUCTION);
    assert.equal(request.structuredOutput.name, SOURCE_EXHAUSTIVE_V2_SCHEMA_NAME);
  }, manifest => {
    assert.equal(publishableKnowledgeManifest(manifest, 77), true); assert.equal(completeKnowledgeManifest(manifest), false);
    for (const changed of [{ ...manifest, sourceScopedPartial: {} }, { ...manifest, sourceLimitations: [] },
      { ...manifest, text: manifest.units.map((u: any) => u.text).join(' ') },
      { ...manifest, sourceLimitations: manifest.sourceLimitations.map((n: any) => ({ ...n, text: 'No cancellation notice is required.' })) },
      { ...manifest, sourceLimitations: manifest.sourceLimitations.map((n: any) => ({ ...n, text: 'The address cannot be confirmed.' })) },
      JSON.parse(JSON.stringify(manifest))]) assert.equal(publishableKnowledgeManifest(changed, 77), false);
  });
  assert.equal(r.allowed, true); assert.equal(r.complete, false); assert.equal(r.manifest.units.length, 4);
  assert.ok(r.manifest.outcomes.every((o: any) => !o.materialFactsComplete && o.obligations.every((x: any) => x.status === 'UNRESOLVED')));
  assert.ok(r.final.endsWith('The complete cancellation policy and required advance notice cannot be confirmed from the available information.'));
  assert.doesNotMatch(r.final, /cannot verify an answer|24 hours|always free/);
  receipts.push({ kind: 'SCRIPTED_V2_NOT_GENUINE_ACCEPTANCE', allowed: r.allowed, final: r.final, complete: r.complete, verdict: raw });
});
for (const fault of ['source-false', 'facet-false', 'irrelevant', 'missing-fact', 'condition', 'wrong-uncertainty', 'unsupported-claim'])
  test(`native V2 authority denies/${fault}`, async t => {
    const raw = scriptedV2();
    if (fault === 'source-false') raw.sourceCoverage.requestAligned = false;
    if (fault === 'facet-false') raw.coverage[1].requestAligned = false;
    if (fault === 'irrelevant') raw.decisions[0].relevant = false;
    if (fault === 'missing-fact') raw.sourceCoverage.availableMaterialFactsComplete = false;
    if (fault === 'condition') raw.coverage[0].incompletenessReason = 'MISSING_CONDITION';
    if (fault === 'wrong-uncertainty') raw.sourceCoverage.obligations[1].state = 'REQUESTED_INFORMATION_NOT_VERIFIED';
    if (fault === 'unsupported-claim') raw.decisions[0].relation = 'UNKNOWN';
    const r = await replay(t, SOURCE_EXHAUSTIVE_V2_PROTOCOL, raw);
    assert.equal(r.allowed, false); assert.equal(r.final, capture.finalInterceptedResponse);
  });

test('V2 requires explicit backend selection; normal v2 default and managed-profile restrictions remain', () => {
  const old = process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL, profile = process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE;
  try {
    delete process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL; assert.equal(selectKnowledgeVerificationProtocol(), 'v2');
    process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = SOURCE_EXHAUSTIVE_V2_PROTOCOL; assert.equal(selectKnowledgeVerificationProtocol(), SOURCE_EXHAUSTIVE_V2_PROTOCOL);
    process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = 'sol-low-v1'; assert.throws(selectKnowledgeVerificationProtocol, /managed_profile_unsupported/);
  } finally {
    if (old === undefined) delete process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL; else process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = old;
    if (profile === undefined) delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; else process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE = profile;
  }
});
