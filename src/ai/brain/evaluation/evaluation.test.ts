/** Knowledge Reliability Evaluation Engine (Brain V2, Phase 2). Offline only: no
 * network, no provider client, no writes. Server-language checks live in
 * evaluation-language.integration.test.ts (they import server.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CORPUS, parseObligations } from './corpus';
import { FACTS, fact } from './facts';
import { loadSources, REPO_ROOT, source } from './sources';
import { semanticStats, validateCase, validateCorpus, validateFacts } from './validate';
import { evaluateDeterministic, evaluatePolicyOracle, oracleEligibility } from './tier1';
import { evaluateReplay, gradeUnits, loadRecorded } from './tier2';
import { dispatchTier3, preflightTier3, tier3PlanSha256, Tier3DispatchDisabled, TIER3_LIMITS, type Tier3Plan } from './tier3';
import { aggregate, cell, MIN_SAMPLE } from './scorecard';
import { runBaseline } from './baseline';
import { LIMITS as EXPERIMENT_LIMITS } from '../../../../tests/helpers/semantic-recovery-eval';
import type { EvalCase } from './types';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const byId = (id: string) => CORPUS.find(c => c.id === id)!;
const quiet = (t: any) => { for (const k of ['log', 'info', 'warn', 'debug']) t.mock.method(console, k, () => {}); };
const mutate = (c: EvalCase, patch: Partial<EvalCase>): EvalCase => ({ ...c, ...patch });

// ---------- schema & ground truth ----------
test('schema: the corpus and every fact validate', () => {
  assert.deepEqual(validateCorpus(CORPUS), []);
  const s = semanticStats(CORPUS);
  assert.ok(s.scenarios >= 300, `scenarios ${s.scenarios}`);
  assert.equal(s.instances, CORPUS.length);
});

test('schema: malformed cases are rejected', () => {
  const c = byId('dir-28');
  const problems = (x: EvalCase) => validateCase(x).map(i => i.problem).join('|');
  assert.match(problems(mutate(c, { language: 'xx' as any })), /language/);
  assert.match(problems(mutate(c, { turns: [] })), /turns/);
  assert.match(problems(mutate(c, { obligations: parseObligations('A:d:does.not.exist') })), /unknown fact/);
  assert.match(problems(mutate(c, { obligations: parseObligations('A:d:') })), /needs facts/);
  assert.match(problems(mutate(c, { obligations: parseObligations('A:q:c.loan-3days') })), /another tenant/);
  assert.match(problems(mutate(c, { obligations: parseObligations('A:d:h.studio1-lost-21') })), /non-current fact/);
  assert.throws(() => parseObligations('Z:d:t3.water'), /bad obligation/);
  const variant = CORPUS.find(x => x.semanticKey !== x.id)!;
  assert.match(validateCorpus([...CORPUS.filter(x => x.id !== variant.id), mutate(variant, { obligations: parseObligations('A:p:t3.water') })]).map(i => i.problem).join('|'),
    /variant changes the semantic obligations/);
});

test('ground-truth independence: corpus, facts and sources import no answering pipeline code', () => {
  for (const f of ['types.ts', 'facts.ts', 'corpus.ts', 'sources.ts', 'validate.ts']) {
    const text = readFileSync(new URL(`src/ai/brain/evaluation/${f}`, REPO_ROOT), 'utf8');
    const imports = [...text.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const i of imports) assert.ok(i.startsWith('./') || i.startsWith('node:') || i.startsWith('../../../../tests/fixtures/'), `${f} imports ${i}`);
  }
  // Expectations reference facts only; nothing is derived from model output.
  for (const c of CORPUS) for (const o of c.obligations) for (const id of [...o.facts, ...(o.foreignFacts ?? [])]) assert.ok(fact(id));
});

test('evidence revision matching: quotes are exact substrings of hashed revisions; a changed text changes the revision', () => {
  assert.deepEqual(validateFacts(), []);
  for (const s of loadSources()) {
    assert.equal(s.revision, sha(s.text));
    assert.equal(s.provenance.fileSha256, sha(readFileSync(new URL(s.provenance.file, REPO_ROOT))));
  }
  const f = fact('t3.lost-21');
  assert.deepEqual(validateFacts([{ ...f, quote: f.quote!.replace('21', '30') }]).map(i => i.problem), ['quote is not an exact substring of its source revision']);
  // The October revision differs from the current one; stale facts are anchored to the old revision only.
  assert.notEqual(source('t3.studio1').revision, source('t3.dge').revision);
  assert.ok(!source('t3.dge').text.includes(fact('h.studio1-no-post').quote!));
});

// ---------- semantic categories ----------
test('tenant isolation: foreign facts never satisfy a case, and the real pipeline withholds them', async t => {
  quiet(t);
  for (const c of CORPUS.filter(c => c.family === 'cross_tenant')) {
    assert.ok(c.obligations.every(o => o.expect === 'REFUSE_FOREIGN'));
    const e = oracleEligibility(c);
    if (!e.eligible) continue;
    for (const p of ['v2', 'source-exhaustive-v2'] as const) {
      const r = (await evaluatePolicyOracle(c, p)).find(m => m.metric === 'unsupported_claim')!;
      assert.equal(r.grade, 'PASS', `${c.id} ${p}: ${r.reason}`);
    }
  }
});

test('missing, stale and conflicting evidence are modelled without inventing answers', async t => {
  quiet(t);
  for (const c of CORPUS.filter(c => c.family === 'unverified')) assert.ok(!c.obligations.some(o => o.expect === 'ANSWER'), c.id);
  for (const c of CORPUS.filter(c => c.evidenceProfile === 'CONFLICTING')) assert.ok(c.obligations.some(o => o.facts.includes('n.chat-cancel-disabled')), c.id);
  for (const c of CORPUS.filter(c => c.evidenceProfile === 'STALE')) {
    const r = (await evaluatePolicyOracle(c, 'v2')).find(m => m.metric === 'unsupported_claim')!;
    assert.equal(r.grade, 'PASS', `${c.id}: ${r.reason}`);
  }
});

test('false premises and compound questions carry their full obligations', async t => {
  quiet(t);
  for (const c of CORPUS.filter(c => c.family === 'premise')) assert.ok(c.obligations.some(o => o.expect === 'CORRECT_PREMISE' && o.facts.length), c.id);
  for (const c of CORPUS.filter(c => c.family === 'compound' && c.semanticKey === c.id && !c.provenance.question.includes('direct-conditional')))
    assert.ok(c.obligations.length >= 2, c.id);
  const premise = (await evaluatePolicyOracle(byId('pre-02'), 'v2')).find(m => m.metric === 'correct_complete')!;
  assert.equal(premise.grade, 'PASS', premise.reason);
  for (const p of ['v2', 'source-exhaustive-v2'] as const) {
    const compound = (await evaluatePolicyOracle(byId('cmp-02'), p)).find(m => m.metric === 'correct_complete')!;
    assert.equal(compound.grade, 'PASS', `${p}: ${compound.reason}`);
  }
});

test('unsupported claims: invented numbers, forbidden numbers and stale text fail deterministically', () => {
  const c = byId('dir-21'), ev = [{ id: 'e1', businessId: 3, sourceId: 's', chunkId: 'c', version: 'v', text: fact('t3.lost-21').quote! }];
  const unit = (text: string, modality = 'descriptive') => ({ text, modality, negation: false, language: c.language, evidenceRefs: [{ evidenceId: 'e1', exactQuote: fact('t3.lost-21').quote! }] });
  const grade = (u: any, cc: EvalCase = c) => gradeUnits(cc, [u], ev as any, 'T2_RECORDED_REPLAY').find(m => m.metric === 'unsupported_claim')!;
  assert.equal(grade(unit('Fundsachen werden normalerweise bis zu 21 Tage aufbewahrt.')).grade, 'PASS');
  assert.equal(grade(unit('Fundsachen werden bis zu 90 Tage aufbewahrt.')).reason, 'number_not_in_cited_source');
  assert.equal(grade(unit('Fundsachen werden 21 Tage aufbewahrt.'), { ...c, forbiddenNumbers: ['21'] }).reason, 'forbidden_number_asserted');
  assert.equal(grade(unit('Sie finden uns in der Aurora Street 21.'), { ...c, forbiddenStaleText: ['Aurora Street'] }).reason, 'stale_text_published');
});

test('missing conditions and modality: wrong modality fails; conditions are never auto-passed', () => {
  const c = byId('dir-03'), q = fact('t3.confirmation').quote!, ev = [{ id: 'e1', businessId: 3, sourceId: 's', chunkId: 'c', version: 'v', text: q }];
  const unit = (modality: string) => ({ text: 'Bringen Sie Ihre Buchungsbestätigung mit.', modality, negation: false, language: 'de', evidenceRefs: [{ evidenceId: 'e1', exactQuote: q }] });
  const m = (mod: string) => gradeUnits(c, [unit(mod)], ev as any, 'T2_RECORDED_REPLAY');
  assert.equal(m('required').find(x => x.metric === 'modality_negation')!.grade, 'FAIL');
  assert.equal(m('recommended').find(x => x.metric === 'modality_negation')!.grade, 'PASS');
  const arrival = fact('t3.arrive-10').quote!, c2 = byId('dir-02');
  const cond = gradeUnits(c2, [{ text: 'Arrive about 10 minutes early.', modality: 'recommended', negation: false, language: 'en', evidenceRefs: [{ evidenceId: 'e1', exactQuote: arrival }] }],
    [{ id: 'e1', businessId: 3, sourceId: 's', chunkId: 'c', version: 'v', text: arrival }] as any, 'T2_RECORDED_REPLAY').find(x => x.metric === 'missing_condition')!;
  assert.equal(cond.grade, 'INDETERMINATE'); assert.equal(cond.pendingReview, true);
});

// ---------- recorded replay ----------
test('recorded replay fidelity: outputs are byte-identical to the authorized artifacts and never rewritten', () => {
  const recs = loadRecorded();
  assert.ok(recs.length >= 8);
  const cancel = JSON.parse(readFileSync(new URL('tests/fixtures/genuine-luna-cancellation-coverage-20261102.json', REPO_ROOT), 'utf8'));
  const r = recs.find(x => x.id === 'rec-cancel-luna-20261102')!;
  assert.equal(sha(r.outputs.extraction!), cancel.extraction.outputSha256);
  assert.equal(sha(r.outputs.verification!), cancel.verification.outputSha256);
  for (const x of recs.filter(x => x.id.startsWith('rec-semantic-recovery'))) for (const [i, stage] of (['extraction', 're_extraction', 'verification'] as const).entries()) {
    const receipt = JSON.parse(readFileSync(new URL(x.artifacts[i], REPO_ROOT), 'utf8'));
    assert.equal(x.outputs[stage], receipt.outputText, `${x.id} ${stage}`);
  }
});

test('recorded replay drift is detected and never graded as PASS/FAIL', async t => {
  quiet(t);
  const r = loadRecorded().find(x => x.id === 'rec-shared-core-de-20261022')!;
  const altered = { ...r, recordedInputs: { ...r.recordedInputs, verification: { units: [{ text: 'a different recorded unit' }] } } };
  const { run, results } = await evaluateReplay(altered, byId('rep-04'));
  assert.ok(run.drift.some(d => d.startsWith('verification:units')));
  assert.ok(results.filter(m => ['correct_complete', 'safe_partial', 'false_fallback'].includes(m.metric)).every(m => m.grade === 'INDETERMINATE'));
});

// ---------- tier 3 safeguards ----------
test('no paid dispatch: Tier 3 never dispatches and its preflight enforces the owner limits', () => {
  assert.deepEqual(TIER3_LIMITS, EXPERIMENT_LIMITS);
  const unsigned = { authorizationId: 'test', caseIds: ['dir-28'], model: 'm', stagesPerCase: 2, perRequestCeilingUsd: 0.05, maxProviderAttempts: 2, runCeilingUsd: 0.1,
    ledger: { path: '/nonexistent', expectedSha256: sha('{"calls":[],"estimatedUsd":3.95,"unmeteredReserveUsd":0}'), historicalRows: 0, historicalPrefixSha256: sha('[]') } };
  const plan: Tier3Plan = { ...unsigned, approval: { approvedBy: 'owner', approvedAt: '2026-11-14', planSha256: tier3PlanSha256(unsigned) } };
  const pf = preflightTier3(plan, { bytes: '{"calls":[],"estimatedUsd":3.95,"unmeteredReserveUsd":0}' });
  assert.ok(pf.problems.includes('CUMULATIVE_LIMIT_WOULD_BE_EXCEEDED'));
  assert.ok(preflightTier3({ ...plan, perRequestCeilingUsd: 0.2 }, null).problems.includes('PER_REQUEST_CEILING_EXCEEDS_LIMIT'));
  assert.ok(preflightTier3({ ...plan, approval: { ...plan.approval, planSha256: 'x' } }, null).problems.includes('APPROVAL_DOES_NOT_MATCH_PLAN'));
  assert.throws(() => dispatchTier3(plan, { ...pf, ok: true }), Tier3DispatchDisabled);
});

test('no paid dispatch and no production mutation during a full offline baseline; results are repeatable', async t => {
  quiet(t);
  const fetchSpy = t.mock.method(globalThis, 'fetch', async () => { throw new Error('NETWORK_FORBIDDEN'); });
  const watched = [...new Set([...loadSources().map(s => s.provenance.file), ...loadRecorded().flatMap(r => r.artifacts.filter(a => !a.endsWith('.json') || !a.startsWith('docs/validation/shared-core')))])];
  const before = watched.map(p => [p, sha(readFileSync(new URL(p, REPO_ROOT))), statSync(new URL(p, REPO_ROOT)).mtimeMs]);
  const corpusBefore = JSON.stringify(CORPUS), factsBefore = JSON.stringify(FACTS);
  const a = await runBaseline(), b = await runBaseline();
  assert.equal(fetchSpy.mock.callCount(), 0);
  assert.deepEqual(watched.map(p => [p, sha(readFileSync(new URL(p, REPO_ROOT))), statSync(new URL(p, REPO_ROOT)).mtimeMs]), before);
  assert.equal(JSON.stringify(CORPUS), corpusBefore); assert.equal(JSON.stringify(FACTS), factsBefore);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic evaluation must be repeatable');
});

// ---------- scoring ----------
test('score aggregation: only PASS/FAIL enter rates; small samples withhold the rate', () => {
  const c = cell(['PASS', 'PASS', 'FAIL', 'INDETERMINATE', 'NOT_EVALUATED', 'NOT_EVALUATED']);
  assert.equal(c.graded, 3); assert.equal(c.passRate, null); assert.equal(c.INDETERMINATE, 1); assert.equal(c.NOT_EVALUATED, 2);
  const big = cell([...Array(MIN_SAMPLE).fill('PASS'), 'FAIL', 'INDETERMINATE']);
  assert.equal(big.passRate, Math.round((MIN_SAMPLE / (MIN_SAMPLE + 1)) * 1000) / 1000);
  const agg = aggregate([byId('dir-28')], [{ caseId: 'dir-28', results: [{ metric: 'language', grade: 'INDETERMINATE', tier: 'T1_DETERMINISTIC', reason: 'x' }] }]);
  assert.equal(agg.overall.language.passRate, null); assert.equal(agg.overall.language.INDETERMINATE, 1);
});

test('deterministic tier: routing signals come from the real shared functions', () => {
  const r = evaluateDeterministic(byId('act-02'));
  const route = r.find(m => m.metric === 'action_routing')!;
  assert.ok(route.exercised!.includes('booking-intelligence.normalizeBookingRequest'));
  assert.ok(['PASS', 'FAIL', 'INDETERMINATE'].includes(route.grade));
  assert.ok(!r.some(m => m.metric === 'language'), 'reply language is graded only against the server-side authority');
});
