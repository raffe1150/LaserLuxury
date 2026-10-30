import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRequestedFacets, FOREGROUND_UNIT_VERIFICATION_INSTRUCTION, UNIT_VERIFICATION_INSTRUCTION } from './business-information-answer-plan';
import { knowledgeStructuredOutput, selectKnowledgeVerificationProtocol } from './knowledge-answer-protocol';
import { assessCoverageWitnesses, parseCoverageWitnessResponse, coverageWitnessInstruction, COVERAGE_WITNESS_INSTRUCTION } from './knowledge-coverage-witness';
import { acceptanceQuestions, acceptanceLanguages } from '../../tests/fixtures/multilingual-knowledge-acceptance';

const capture = JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/asv-direct-acceptance-20261025/A-sv.result.json', 'utf8'));
const call = capture.state.calls.find((c: any) => c.stage === 'verification');
const input = JSON.parse(call.request.input[0].content), verdict = JSON.parse(call.outputText);
const facets = parseRequestedFacets(input.facets).facets;
const witness = (quote = 'om jag har fått dem') => ({ facetId: 'f1', obligationId: 'f1.o1', reason: 'MISSING_CONDITION', location: { kind: 'QUESTION_SPAN', quote } });
const valid = () => ({ ...structuredClone(verdict), coverageWitnesses: [witness()] });
const assess = (raw: any) => assessCoverageWitnesses(raw, input.question, facets, input.units);
function configure(t: any, protocol?: string, compact?: string) {
  for (const [key, value] of Object.entries({ ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL: protocol, ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION: compact })) {
    const old = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

test('default v2 schema and prompt remain exactly equal to immutable real capture', t => {
  configure(t); assert.equal(selectKnowledgeVerificationProtocol(), 'v2');
  assert.deepEqual({ type: 'json_schema', ...knowledgeStructuredOutput('verification') }, call.request.text.format);
  assert.equal(FOREGROUND_UNIT_VERIFICATION_INSTRUCTION, call.request.instructions);
});
test('explicit witness selection changes only verification schema, not legacy fields or other stages', t => {
  configure(t, 'coverage-witness-v1'); assert.equal(selectKnowledgeVerificationProtocol(), 'coverage-witness-v1');
  const v2: any = knowledgeStructuredOutput('verification', false, undefined, 6, 'v2');
  const next: any = knowledgeStructuredOutput('verification');
  assert.equal(next.name, 'odinlink_knowledge_verification_witness_v1');
  assert.deepEqual(next.schema.properties.decisions, v2.schema.properties.decisions);
  assert.deepEqual(next.schema.properties.coverage, v2.schema.properties.coverage);
  assert.equal(next.schema.properties.coverageWitnesses.maxItems, 8);
  assert.equal(knowledgeStructuredOutput('extraction').name, 'odinlink_knowledge_extraction_v2');
  assert.deepEqual({ type: 'json_schema', ...v2 }, call.request.text.format);
  const walk = (s: any) => {
    if (s.type === 'object') { assert.deepEqual(s.required, Object.keys(s.properties)); assert.equal(s.additionalProperties, false); Object.values(s.properties).forEach(walk); }
    if (s.items) walk(s.items); if (s.anyOf) s.anyOf.forEach(walk);
  }; walk(next.schema);
});
test('existing compact opt-in remains supported as a separately captured protocol', t => {
  configure(t, undefined, 'true'); assert.equal(selectKnowledgeVerificationProtocol(), 'compact-v1');
  assert.equal(knowledgeStructuredOutput('verification').name, 'odinlink_knowledge_verification_compact_v1');
});
for (const protocol of ['', 'V2', 'compact-v1', 'unknown']) test(`unsupported backend protocol rejects: ${protocol}`, t => {
  configure(t, protocol); assert.throws(() => selectKnowledgeVerificationProtocol(), /unsupported/);
});
for (const protocol of ['v2','coverage-witness-v1']) test(`conflicting compact flag and explicit ${protocol} reject`, t => {
  configure(t, protocol, 'true'); assert.throws(() => selectKnowledgeVerificationProtocol(), /conflicting/);
});
test('captured schema selection cannot change after environment mutation', t => {
  configure(t, 'coverage-witness-v1'); const protocol = selectKnowledgeVerificationProtocol();
  process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL = 'v2'; process.env.ODINLINK_KNOWLEDGE_COMPACT_VERIFICATION = 'true';
  assert.equal(knowledgeStructuredOutput('verification', false, undefined, 6, protocol).name, 'odinlink_knowledge_verification_witness_v1');
  assert.throws(() => knowledgeStructuredOutput('verification', false, undefined, 6, 'unknown' as any));
});
for (const legacy of [FOREGROUND_UNIT_VERIFICATION_INSTRUCTION, UNIT_VERIFICATION_INSTRUCTION]) test('witness prompt preserves every existing semantic instruction', () => {
  const footer = 'Return JSON only: {"decisions":[],"coverage":[]}.';
  const next = coverageWitnessInstruction(legacy);
  assert.ok(next.startsWith(legacy.slice(0, -footer.length))); assert.ok(next.includes(COVERAGE_WITNESS_INSTRUCTION));
  assert.ok(next.endsWith('Return JSON only: {"decisions":[],"coverage":[],"coverageWitnesses":[]}.'));
  assert.throws(() => coverageWitnessInstruction('Unrelated prompt'));
});
test('valid literal witness yields frozen offsets and unconfirmed diagnostic metadata only', () => {
  const raw = valid(), before = JSON.stringify(raw), a = assess(raw);
  assert.equal(a.state, 'VALID'); assert.equal(JSON.stringify(raw), before);
  assert.equal(input.question.slice(a.claimedMissing[0].start, a.claimedMissing[0].end), 'om jag har fått dem');
  assert.equal(a.claimedMissing[0].semanticTruth, 'UNCONFIRMED_MODEL_CLAIM');
  assert.equal(raw.coverage[0].obligations[0].status, 'UNRESOLVED');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.claimedMissing) && Object.isFrozen(a.claimedMissing[0]));
  assert.doesNotMatch(JSON.stringify(a), /quote|förberedelse|fullQuestion|covered|publicationAllowed/u);
});
const changes: Record<string, (x: any) => void> = {
  absent: x => { delete x.coverageWitnesses; }, empty: x => { x.coverageWitnesses = []; },
  invented: x => { x.coverageWitnesses[0].location.quote = 'A newly invented allergy restriction'; },
  duplicate: x => { x.coverageWitnesses.push(witness()); }, wrongFacet: x => { x.coverageWitnesses[0].facetId = 'f2'; },
  wrongObligation: x => { x.coverageWitnesses[0].obligationId = 'f1.o2'; },
  coercedFacet: x => { x.coverageWitnesses[0].facetId = ['f1']; },
  coercedObligation: x => { x.coverageWitnesses[0].obligationId = ['f1.o1']; },
  wrongReason: x => { x.coverageWitnesses[0].reason = 'MISSING_RECOMMENDATION'; },
  arbitraryNarrative: x => { x.coverageWitnesses[0].explanation = 'The source requires more.'; },
  suppliedOffsets: x => { x.coverageWitnesses[0].location.start = 57; },
  override: x => { x.coverageWitnesses[0].covered = true; },
  malformedQuote: x => { x.coverageWitnesses[0].location.quote = 123; },
  whitespace: x => { x.coverageWitnesses[0].location.quote = ' '; },
  splitToken: x => { x.coverageWitnesses[0].location.quote = 'm jag har fått dem'; },
  splitCompound: x => { x.coverageWitnesses[0].location.quote = 'behandlings'; },
  tooLong: x => { x.coverageWitnesses[0].location.quote = 'x'.repeat(241); },
  completePlusWitness: x => { x.coverage[0].materialFactsComplete = true; x.coverage[0].incompletenessReason = 'NONE'; x.coverage[0].obligations[0].status = 'COVERED'; },
  completeMissingReason: x => { x.coverage[0].materialFactsComplete = true; },
  incompleteCovered: x => { x.coverage[0].obligations[0].status = 'COVERED'; },
  incompleteNone: x => { x.coverage[0].incompletenessReason = 'NONE'; },
  foreignUnit: x => { x.coverage[0].materialUnitIds = ['u99']; },
  malformedUnitIds: x => { x.coverage[0].obligations[0].unitIds = null; },
  duplicateDecision: x => { x.decisions[1] = structuredClone(x.decisions[0]); },
  wrongDecisionFlags: x => { x.decisions[0].meaningPreserved = 'true'; },
  wrongRelation: x => { x.decisions[0].relation = 'ACCEPTED'; },
  extraDecision: x => { x.decisions[0].witnessOverride = true; },
  unknownCoverageField: x => { x.coverage[0].witnessOverride = true; },
};
for (const [name, mutate] of Object.entries(changes)) test(`invalid witness/envelope is rejected without rewriting judgments: ${name}`, () => {
  const raw = valid(); mutate(raw); const before = JSON.stringify(raw);
  assert.equal(assess(raw).state, 'INVALID'); assert.equal(JSON.stringify(raw), before);
});
test('honest unlocated witness and nonliteral obligation remain UNKNOWN', () => {
  const raw = valid(); raw.coverageWitnesses[0].location = { kind: 'UNLOCATED', reason: 'NO_RELIABLE_REQUEST_SPAN' } as any;
  assert.equal(assess(raw).state, 'UNKNOWN');
  assert.equal(assessCoverageWitnesses(valid(), input.question, [{ ...facets[0], obligations: [{ ...facets[0].obligations[0], description: 'A translated summary' }] }], input.units).state, 'UNKNOWN');
});
test('valid COMPLETE requires empty witnesses but produces no publication permission', () => {
  const raw = valid(); raw.coverage[0].materialFactsComplete = true; raw.coverage[0].incompletenessReason = 'NONE';
  raw.coverage[0].obligations[0].status = 'COVERED'; raw.coverageWitnesses = [];
  const a = assess(raw); assert.equal(a.state, 'VALID'); assert.deepEqual(a.claimedMissing, []); assert.equal('allowed' in a, false);
});
for (const lang of acceptanceLanguages) test(`${lang}: literal Unicode question reference derives exact backend offsets`, () => {
  const question = acceptanceQuestions.A[lang], fs = parseRequestedFacets([{ subject: 'request', attribute: question, questionType: 'description' }]).facets;
  const raw = valid(); raw.coverageWitnesses = [witness(question)];
  const a = assessCoverageWitnesses(raw, question, fs, input.units); assert.equal(a.state, 'VALID');
  assert.equal(question.slice(a.claimedMissing[0].start, a.claimedMissing[0].end), question);
});
test('repeated anchors remain UNKNOWN and wrong-obligation span is rejected', () => {
  const q = 'If received? If received?', fs = parseRequestedFacets([{ subject: 'request', attribute: q, questionType: 'description' }]).facets;
  const raw = valid(); raw.coverageWitnesses = [witness('If received?')];
  assert.equal(assessCoverageWitnesses(raw, q, fs, input.units).state, 'UNKNOWN');
  const q2 = 'First condition? Second condition?', fs2 = parseRequestedFacets([{ subject: 'request', attribute: q2, questionType: 'description', obligations: [
    { description: 'First condition?', questionType: 'description' }, { description: 'Second condition?', questionType: 'description' },
  ] }]).facets;
  raw.coverage[0].obligations.push({ obligationId: 'f1.o2', status: 'COVERED', unitIds: ['u1'] });
  raw.coverageWitnesses = [witness('Second condition?')];
  assert.equal(assessCoverageWitnesses(raw, q2, fs2, input.units).state, 'INVALID');
});
test('multiple unresolved obligations require separate exact witnesses; no omitted or cross-bound claim', () => {
  const q = 'First condition? Second condition?', fs = parseRequestedFacets([{ subject: 'request', attribute: q, questionType: 'description', obligations: [
    { description: 'First condition?', questionType: 'description' }, { description: 'Second condition?', questionType: 'description' },
  ] }]).facets;
  const raw = valid(); raw.coverage[0].obligations.push({ obligationId: 'f1.o2', status: 'UNRESOLVED', unitIds: [] });
  raw.coverageWitnesses = [witness('First condition?'), { ...witness('Second condition?'), obligationId: 'f1.o2' }];
  assert.equal(assessCoverageWitnesses(raw, q, fs, input.units).state, 'VALID');
  raw.coverageWitnesses.pop(); assert.equal(assessCoverageWitnesses(raw, q, fs, input.units).state, 'INVALID');
});
test('UTF-16 surrogate cuts and oversized original requests fail closed without truncation', () => {
  const question = 'Before 🧪, if instructions were received?', fs = parseRequestedFacets([{ subject: 'request', attribute: question, questionType: 'description' }]).facets;
  const raw = valid(); raw.coverageWitnesses = [witness('🧪')];
  assert.equal(assessCoverageWitnesses(raw, question, fs, input.units).state, 'VALID');
  raw.coverageWitnesses = [witness('🧪'[0])]; assert.equal(assessCoverageWitnesses(raw, question, fs, input.units).state, 'INVALID');
  assert.equal(assessCoverageWitnesses(valid(), 'x'.repeat(8193), facets, input.units).state, 'INVALID');
});
test('normalization differences are not silently repaired in a literal diagnostic reference', () => {
  const question = 'آیا مجاز است?', fs = parseRequestedFacets([{ subject: 'request', attribute: question, questionType: 'description' }]).facets;
  const raw = valid(); raw.coverageWitnesses = [witness('آیا مجاز است؟')];
  assert.equal(assessCoverageWitnesses(raw, question, fs, input.units).state, 'INVALID');
});
test('exact JSON decoding rejects duplicate/escaped keys, fences, size and depth violations', () => {
  const text = JSON.stringify(valid()); assert.deepEqual(parseCoverageWitnessResponse(text), valid());
  for (const bad of ['{', '```json\n' + text + '\n```', '{"decisions":[],"decisions":[]}', '{"decisions":[],"deci\\u0073ions":[]}',
    ' '.repeat(32769), '['.repeat(13) + '0' + ']'.repeat(13)]) assert.equal(parseCoverageWitnessResponse(bad), null);
});
