import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { answerEvidence, buildEvidenceFirstAnswer, InformationBudget, parseRequestedFacets, UNIT_VERIFICATION_INSTRUCTION } from './business-information-answer-plan';
import { knowledgeStructuredOutput } from './knowledge-answer-protocol';
import { COMPACT_VERIFICATION_FLAG, COMPACT_VERIFICATION_NAME, compactVerificationEnabled, compactVerificationInstruction,
  decodeCompactVerification, DECISION_FIELDS, COVERAGE_FIELDS, OBLIGATION_FIELDS } from './knowledge-compact-verification';
import { compactFixture, coverageFixture, verdictFixture } from '../../tests/fixtures/knowledge-verification-protocol';

function flag(t: any, value?: string) {
  const old = process.env[COMPACT_VERIFICATION_FLAG];
  if (value === undefined) delete process.env[COMPACT_VERIFICATION_FLAG]; else process.env[COMPACT_VERIFICATION_FLAG] = value;
  t.after(() => { if (old === undefined) delete process.env[COMPACT_VERIFICATION_FLAG]; else process.env[COMPACT_VERIFICATION_FLAG] = old; });
}
const facets = parseRequestedFacets([{ subject: 'studio', attribute: 'parking', questionType: 'description' }]).facets;
const units = [1, 2, 3].map(i => ({ id: `u${i}`, facetIds: ['f1'] }));
const canonical = () => ({ decisions: units.map(verdictFixture), coverage: coverageFixture(facets, units) });
const decode = (raw: any) => decodeCompactVerification(typeof raw === 'string' ? raw : JSON.stringify(raw), units, facets);
const valid = () => compactFixture(canonical());

for (const value of [undefined, 'false', 'TRUE', '1', 'true ']) test(`flag ${value}: legacy remains default`, t => {
  flag(t, value); assert.equal(compactVerificationEnabled(), false);
  assert.equal(knowledgeStructuredOutput('verification').name, 'odinlink_knowledge_verification_v2');
});
test('opt-in changes only verification schema and all fields are explicitly required', t => {
  flag(t, 'true'); const request = knowledgeStructuredOutput('verification');
  assert.equal(request.name, COMPACT_VERIFICATION_NAME); assert.equal(request.strict, true);
  assert.equal(knowledgeStructuredOutput('extraction').name, 'odinlink_knowledge_extraction_v2');
  const walk = (schema: any) => { if (schema.type === 'object') {
    assert.deepEqual(schema.required, Object.keys(schema.properties)); assert.equal(schema.additionalProperties, false);
    Object.values(schema.properties).forEach(walk);
  } else if (schema.type === 'array') walk(schema.items); }; walk(request.schema);
  const instruction = compactVerificationInstruction(UNIT_VERIFICATION_INSTRUCTION);
  assert.ok(instruction.startsWith(UNIT_VERIFICATION_INSTRUCTION.replace('Return JSON only: {"decisions":[],"coverage":[]}.', '')));
});
test('valid wire decodes every canonical field losslessly, preserving explicit false values', () => assert.deepEqual(decode(valid()), canonical()));
test('opt-in decoder never accepts an alternate legacy response',()=>assert.equal(decode(canonical()),null));
test('all four relations and 128 explicit boolean combinations decode without promotion', () => {
  const fields=['meaningPreserved','modalityPreserved','qualifiersPreserved','relevant','languageCorrect','explicitAbsenceEvidence','negativeAbsence'];
  for(const relation of ['ENTAILED','UNKNOWN','CONTRADICTED','NOT_APPLICABLE'])for(let bits=0;bits<128;bits++){
    const raw=canonical();raw.decisions[0].relation=relation;
    fields.forEach((field,i)=>(raw.decisions[0] as any)[field]=Boolean(bits&(1<<i)));
    // No claim of coverage for this deliberately variable unit. Supported
    // siblings keep their independent coverage under the canonical gate.
    raw.coverage=coverageFixture(facets,units.slice(1),false);
    assert.deepEqual(decode(compactFixture(raw)),raw);
  }
});
test('all incompleteness reasons remain independent diagnostic judgments',()=>{
  for(const reason of ['MISSING_RELEVANT_FACT','MISSING_CONDITION','MISSING_RECOMMENDATION','UNRESOLVED']){
    const raw=canonical();raw.coverage[0].materialFactsComplete=false;raw.coverage[0].incompletenessReason=reason;
    assert.deepEqual(decode(compactFixture(raw)),raw);
  }
});
test('maximum facets and obligations retain exact cross-facet unit bindings and ordering',()=>{
  const fs=parseRequestedFacets(Array.from({length:4},(_,i)=>({subject:'studio',attribute:`aspect ${i}`,questionType:'description',
    obligations:[{description:'first',questionType:'description'},{description:'second',questionType:'description'}]}))).facets;
  const us=Array.from({length:6},(_,i)=>({id:`u${i+1}`,facetIds:i<4?[fs[i].id]:fs.map(f=>f.id)}));
  const raw={decisions:us.map(verdictFixture).reverse(),coverage:coverageFixture(fs,us).reverse()};
  raw.coverage.forEach(c=>c.obligations.reverse());
  assert.deepEqual(decodeCompactVerification(JSON.stringify(compactFixture(raw)),us,fs),raw);
});

for (const [scope, fields] of [['root', { d: '', c: '' }], ['decision', DECISION_FIELDS], ['coverage', COVERAGE_FIELDS], ['obligation', OBLIGATION_FIELDS]] as const) {
  for (const field of Object.keys(fields)) for (const mutation of ['missing', 'null', 'duplicate'] as const) test(`${scope}.${field}/${mutation} fails closed`, () => {
    const raw: any = valid(); const row = scope === 'root' ? raw : scope === 'decision' ? raw.d[0] : scope === 'coverage' ? raw.c[0] : raw.c[0].o[0];
    let text: string;
    if (mutation === 'duplicate') { const original = JSON.stringify(row); const modified = original.replace('{', `{${JSON.stringify(field)}:${JSON.stringify(row[field])},`);
      text = JSON.stringify(raw).replace(original, modified);
    } else { if (mutation === 'missing') delete row[field]; else row[field] = null; text = JSON.stringify(raw); }
    assert.equal(decode(text), null);
  });
  test(`${scope}/unknown field fails closed`, () => { const raw: any = valid();
    (scope === 'root' ? raw : scope === 'decision' ? raw.d[0] : scope === 'coverage' ? raw.c[0] : raw.c[0].o[0]).extra = true;
    assert.equal(decode(raw), null);
  });
}
for (const [name, mutate] of Object.entries({
  'unknown relation': (r: any) => r.d[0].r = 'VERIFIED', 'unknown facet': (r: any) => r.d[0].f = ['f9'],
  'duplicate facet': (r: any) => r.d[0].f = ['f1', 'f1'], 'missing decision': (r: any) => r.d.pop(),
  'duplicate decision': (r: any) => r.d[1] = r.d[0], 'wrong unit': (r: any) => r.d[0].i = 'u9',
  'missing coverage': (r: any) => r.c = [], 'duplicate coverage': (r: any) => r.c.push(r.c[0]),
  'unknown coverage': (r: any) => r.c[0].i = 'f9', 'wrong boolean type': (r: any) => r.d[0].m = 1,
  'unknown reason': (r: any) => r.c[0].r = 'FINE',
  'unknown obligation': (r: any) => r.c[0].o[0].i = 'f1.o9', 'unknown status': (r: any) => r.c[0].o[0].s = 'VERIFIED',
  'missing obligation': (r: any) => r.c[0].o = [], 'duplicate obligation': (r: any) => r.c[0].o.push(r.c[0].o[0]),
  'covered empty': (r: any) => r.c[0].o[0].u = [], 'complete empty': (r: any) => r.c[0].u = [],
  'unknown material unit': (r: any) => r.c[0].u = ['u9'], 'duplicate material unit': (r: any) => r.c[0].u = ['u1', 'u1'],
  'unknown obligation unit': (r: any) => r.c[0].o[0].u = ['u9'], 'duplicate obligation unit': (r: any) => r.c[0].o[0].u = ['u1', 'u1'],
  'unsupported coverage': (r: any) => r.d[0].r = 'UNKNOWN', 'failed flag coverage': (r: any) => r.d[0].q = false,
})) test(`strict decoding/${name}`, () => { const raw = valid(); mutate(raw); assert.equal(decode(raw), null); });
test('duplicate escaped keys, malformed JSON, oversized text and excessive nesting reject', () => {
  assert.equal(decode('{'), null); assert.equal(decode('```json\n'+JSON.stringify(valid())+'\n```'), null);
  assert.equal(decode(JSON.stringify(valid()).replace('"m":true', '"m":true,"\\u006d":true')), null);
  assert.equal(decode(' '.repeat(32769) + JSON.stringify(valid())), null);
  assert.equal(decode('['.repeat(13) + '0' + ']'.repeat(13)), null);
});
test('limits reject seven units, five facets and three obligations', () => {
  assert.equal(decodeCompactVerification(JSON.stringify(valid()), [...units, ...units, units[0]], facets), null);
  assert.equal(decodeCompactVerification(JSON.stringify(valid()), units, Array(5).fill(facets[0])), null);
  assert.equal(decodeCompactVerification(JSON.stringify(valid()), units, [{ ...facets[0], obligations: Array(3).fill(facets[0].obligations[0]) }]), null);
});

const examples = [
  ['parking-complete', 'Where can I park?', ['Parking is behind the studio.', 'Parking is not free.', 'Contact the studio for alternatives.']],
  ['parking-incomplete', 'Where can I park?', ['Parking is behind the studio.']],
  ['hours', 'When are you open?', ['Opening hours are 09:00–17:00 on Monday.']],
  ['services', 'Which services are available?', ['Video Consultation is available.']],
  ['prices', 'What does a consultation cost?', ['A consultation costs 500 SEK.']],
  ['policy', 'Must I book before visiting?', ['We recommend booking ahead.']],
  ['compound', 'Where can I park, and when are you open?', ['Parking is behind the studio.', 'Opening hours are 09:00–17:00 on Monday.']],
  ['paraphrase', 'Before I visit, could you explain the parking arrangements?', ['Parking is behind the studio.']],
] as const;
const languages = ['en', 'sv', 'de', 'es', 'fa', 'ar'] as const;
const localizedFacts = { en: 'Parking is behind the studio.', sv: 'Parkering finns bakom studion.', de: 'Parkplätze befinden sich hinter dem Studio.',
  es: 'Hay aparcamiento detrás del estudio.', fa: 'پارکینگ پشت استودیو است.', ar: 'موقف السيارات خلف الاستوديو.' };
const measurements: any[] = [];
const representativeOutputs: any[] = [];
async function runFixture(language: string, question: string, texts: readonly string[], mode: string, compact: boolean, adjustVerification?: (raw: any) => void) {
  process.env[COMPACT_VERIFICATION_FLAG] = String(compact);
  const fs = mode === 'compound' ? parseRequestedFacets(texts.map((_, i) => ({ subject: 'studio', attribute: `question ${i + 1}`, questionType: 'description' }))).facets :
    mode === 'policy' ? parseRequestedFacets([{subject:'visits',attribute:'booking policy',questionType:'requirement'}]).facets : facets;
  const evidenceText = [...texts, ...(mode === 'parking-incomplete' ? ['Contact the studio for alternatives.'] : [])].join('\n');
  const ev = answerEvidence(77, [{ businessId: mode === 'tenant' ? 88 : 77, sourceId: 'fixture', text: evidenceText, metadata: { documentRevision: 'v1' } }]);
  const budget = new InformationBudget(); const events: any[] = [], calls: string[] = []; let current = true, fresh = true, returned: any;
  const manifest = await buildEvidenceFirstAnswer({ question, language, facets: fs, evidence: ev, authoritativeEvidence: 'Authoritative conflicts remain visible.',
    businessTone: {}, history: [{ role: 'user', content: 'I am planning a visit.' }], budget,
    current: async () => current, revalidateEvidence: async () => fresh ? ev : [], diagnostic: e => events.push(e),
    generate: async (stage, instruction, data: any) => {
      budget.attempt(); calls.push(stage);
      if (stage === 'extraction') return { text: JSON.stringify({ units: texts.map((text, i) => ({ facetIds: [mode === 'compound' ? fs[i].id : 'f1'],
        subject: 'studio', predicate: 'states', value: text, modality: mode === 'policy' ? 'recommended' : 'descriptive', negation: false, scope: 'this studio', qualifiers: [], language, text,
        evidenceRefs: [{ evidenceId: 'e1', exactQuote: text }] })) }) };
      if (stage === 'verification') {
        assert.equal(data.question, question); assert.equal(data.requestedLanguage, language);
        assert.ok(data.units.every((u: any) => u.evidenceRefs.length)); assert.ok(data.evidence[0].version); assert.ok(data.authoritativeEvidence);
        assert.equal(instruction.includes('Compact wire v1'), compact);
        if (mode === 'timeout') { const e: any = new Error('synthetic'); e.category = 'TIMEOUT'; throw e; }
        if (mode === 'late') { (budget as any).deadlineAt = Date.now() - 1; current = false; }
        if (mode === 'ownership') current = false;
        if (mode === 'revoked') fresh = false;
        const decisions = data.units.map(verdictFixture);
        if (mode === 'unsupported' || mode === 'conflict') decisions[0].relation = mode === 'conflict' ? 'CONTRADICTED' : 'UNKNOWN';
        if (mode === 'negative') { decisions[0].negativeAbsence = true; decisions[0].explicitAbsenceEvidence = false; }
        if (mode === 'flag-false') decisions[0].meaningPreserved = false;
        const supported = data.units.filter((u: any, i: number) => decisions[i].relation === 'ENTAILED' && decisions[i].meaningPreserved && !decisions[i].negativeAbsence);
        returned = { decisions, coverage: coverageFixture(fs, supported, mode !== 'parking-incomplete' && supported.length === data.units.length) };
        if (mode === 'alignment') returned.coverage.forEach((c: any) => c.requestAligned = false);
        adjustVerification?.(returned);
        return { text: JSON.stringify(compact ? compactFixture(returned) : returned) };
      }
      return { text: JSON.stringify({ unitIds: data.units.map((u: any) => u.id), prefix: 'none', addition: false }) };
    } });
  return { manifest, calls, events: events.map(({ remainingMs, startingBudgetMs, ...event }) => event), returned };
}
// The label describes a diagnostic; only the explicit independent judgments
// and their validated bindings can authorize completeness. Preserve both fields.
const compatibilityReasons = ['NONE', 'MISSING_RELEVANT_FACT', 'MISSING_CONDITION', 'MISSING_RECOMMENDATION', 'UNRESOLVED'];
for (const complete of [false, true]) for (const reason of compatibilityReasons) test(`diagnostic compatibility/complete=${complete}/reason=${reason}`, async t => {
  flag(t);
  const raw = canonical(); raw.coverage[0].materialFactsComplete = complete; raw.coverage[0].incompletenessReason = reason;
  assert.deepEqual(decode(compactFixture(raw)), raw, 'decode without changing either independent judgment or diagnostic');
  const adjust = (verdict: any) => { verdict.coverage[0].materialFactsComplete = complete; verdict.coverage[0].incompletenessReason = reason; };
  const legacy = await runFixture('en', 'Where can I park?', [localizedFacts.en], '', false, adjust);
  const compact = await runFixture('en', 'Where can I park?', [localizedFacts.en], '', true, adjust);
  assert.deepEqual(compact, legacy);
  assert.equal(compact.manifest.outcomes[0].status, complete ? 'VERIFIED' : 'PARTIAL');
  assert.equal(compact.manifest.outcomes[0].materialFactsComplete, complete);
  assert.equal(compact.events.find(e => e.facetId === 'f1')?.incompletenessReason, reason);
  assert.equal(compact.manifest.units.length, 1, 'supported units are preserved without upgrading an incomplete answer');
});
for (const reason of compatibilityReasons) test(`diagnostic compatibility/unsafe bindings still reject/reason=${reason}`, () => {
  for (const fault of ['empty-material', 'unknown-material', 'empty-covered', 'unknown-obligation-unit', 'not-entailed', 'failed-flag']) {
    const raw = valid(); raw.c[0].r = reason;
    if (fault === 'empty-material') raw.c[0].u = [];
    if (fault === 'unknown-material') raw.c[0].u = ['u9'];
    if (fault === 'empty-covered') raw.c[0].o[0].u = [];
    if (fault === 'unknown-obligation-unit') raw.c[0].o[0].u = ['u9'];
    if (fault === 'not-entailed') raw.d[0].r = 'UNKNOWN';
    if (fault === 'failed-flag') raw.d[0].q = false;
    assert.equal(decode(raw), null, fault);
  }
});
for (const reason of compatibilityReasons) for (const gate of ['misaligned', 'unresolved', 'modality']) test(`diagnostic compatibility/positive completeness cannot bypass ${gate}/reason=${reason}`, async t => {
  flag(t);
  const adjust = (raw: any) => {
    raw.coverage[0].materialFactsComplete = true; raw.coverage[0].incompletenessReason = reason;
    if (gate === 'misaligned') raw.coverage[0].requestAligned = false;
    if (gate === 'unresolved') { raw.coverage[0].obligations[0].status = 'UNRESOLVED'; raw.coverage[0].obligations[0].unitIds = []; }
  };
  const mode = gate === 'modality' ? 'policy' : '';
  const question = gate === 'modality' ? 'Must I book before visiting?' : 'Where can I park?';
  const texts = [gate === 'modality' ? 'We recommend booking ahead.' : localizedFacts.en];
  const legacy = await runFixture('en', question, texts, mode, false, adjust);
  const compact = await runFixture('en', question, texts, mode, true, adjust);
  assert.deepEqual(compact, legacy); assert.equal(compact.manifest.outcomes[0].status, 'PARTIAL');
});
for (const [name, question, texts] of examples) test(`canonical equivalence/${name}`, async t => {
  flag(t); const legacy = await runFixture('en', question, texts, name, false), compact = await runFixture('en', question, texts, name, true);
  assert.deepEqual(compact, legacy); if (name === 'parking-incomplete' || name === 'policy') assert.equal(compact.manifest.outcomes[0].status, 'PARTIAL');
  const baseline=JSON.stringify(legacy.returned),wire=JSON.stringify(compactFixture(legacy.returned));
  representativeOutputs.push({fixture:name,legacyBytes:Buffer.byteLength(baseline),compactBytes:Buffer.byteLength(wire),
    estimatedLegacyTokens:Math.ceil(baseline.length/4),estimatedCompactTokens:Math.ceil(wire.length/4),status:compact.manifest.outcomes.map(o=>o.status)});
});
for (const language of languages) test(`canonical equivalence/language/${language}`, async t => {
  flag(t); assert.deepEqual(await runFixture(language, 'Synthetic localized request', [localizedFacts[language]], '', true),
    await runFixture(language, 'Synthetic localized request', [localizedFacts[language]], '', false));
});
for (const mode of ['unsupported', 'conflict', 'negative', 'flag-false', 'alignment', 'tenant', 'revoked', 'ownership', 'timeout', 'late']) test(`canonical equivalence/safety/${mode}`, async t => {
  flag(t); const legacy = await runFixture('en', 'Where can I park?', [localizedFacts.en], mode, false), compact = await runFixture('en', 'Where can I park?', [localizedFacts.en], mode, true);
  assert.deepEqual(compact.manifest, legacy.manifest); assert.deepEqual(compact.calls, legacy.calls);
  if (mode !== 'alignment') assert.equal(compact.manifest.units.length, 0); else assert.equal(compact.manifest.outcomes[0].status, 'PARTIAL');
});
test('measured representative fixture output sizes and codec overhead', async t => {
  flag(t);
  for (const n of [1, 2, 3, 4, 6]) {
    const us = Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, facetIds: ['f1'] }));
    const raw = { decisions: us.map(verdictFixture), coverage: coverageFixture(facets, us) }, wire = compactFixture(raw);
    const legacyText = JSON.stringify(raw), compactText = JSON.stringify(wire);
    assert.deepEqual(decodeCompactVerification(compactText, us, facets), raw);
    const samples: number[] = []; let encodingMs = 0, decodingMs = 0, legacyParsingMs = 0;
    for (let warmup = 0; warmup < 100; warmup++) decodeCompactVerification(compactText, us, facets);
    for (let i = 0; i < 1000; i++) { let start = performance.now(); JSON.parse(legacyText); legacyParsingMs += performance.now()-start;
      start = performance.now(); JSON.stringify(compactFixture(raw)); encodingMs += performance.now() - start;
      start = performance.now(); assert.ok(decodeCompactVerification(compactText, us, facets)); const elapsed = performance.now() - start; decodingMs += elapsed; samples.push(elapsed); }
    samples.sort((a, b) => a - b);
    const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
    const row = { units: n, legacyBytes: bytes(legacyText), compactBytes: bytes(compactText), reductionPercent: 100 * (1 - bytes(compactText) / bytes(legacyText)),
      estimatedLegacyTokens: Math.ceil(legacyText.length / 4), estimatedCompactTokens: Math.ceil(compactText.length / 4),
      estimateMethod: 'characters/4 heuristic; not provider tokenization', legacyParseMeanMs:legacyParsingMs/1000,
      fixtureEncodeMeanMs: encodingMs / 1000, decodeMeanMs: decodingMs / 1000, decodeP95Ms: samples[949] };
    assert.ok(row.reductionPercent > 40); measurements.push(row);
  }
  const report = { outputFixtures: measurements, representativeOutputs, legacyInstructionCharacters: UNIT_VERIFICATION_INSTRUCTION.length,
    compactInstructionCharacters: compactVerificationInstruction(UNIT_VERIFICATION_INSTRUCTION).length,
    productionLatencyMeasured: false, mockLatencyReductionAssumed: false };
  t.diagnostic(JSON.stringify(report));
  if (process.env.ODINLINK_WRITE_COMPACT_MEASUREMENTS === 'true') writeFileSync(new URL('../../docs/validation/knowledge-compact-verification-2026-10-18/measurements.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
});
