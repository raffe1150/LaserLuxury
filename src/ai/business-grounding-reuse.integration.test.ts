import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Responses } from 'openai/resources/responses';
import { Models } from '@google/genai';
import { AiReliabilityError } from './reliability';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const snapshot = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const question = 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?';
const fact = snapshot.sources[0].content;
const address = /kundentrén ligger på (.+)\.$/u.exec(fact)![1];
const catalog = formatConfiguredServiceCatalogPlan(buildConfiguredServiceCatalogPlan(snapshot.business.services), 'de');
const location = `Unser Kundeneingang befindet sich in ${address}.`;
const candidate = `${catalog}\n${location}`;
const baseline = process.env.GROUNDING_REUSE_BASELINE === '1';
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-reuse', OPENAI_MODEL: 'gpt-5.6-luna' });
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  b.reset();
});
const claim = (text: string, source: string, quote: string, supported = true) => ({
  claim: text, candidateQuote: text, claimKind: 'OTHER', requiresBusinessEvidence: true, supported,
  evidence: [{ source, quote }],
});
const catalogClaim = () => claim(catalog, 'structured_business_config', '"name": "Video Consultation"');
const locationClaim = () => claim(location, 'retrieved_knowledge', fact);
const assessment = (claims: any[]) => ({ hasBusinessFactualClaims: true, allBusinessClaimsSupported: claims.every(c => c.supported), claims });
const response = (value: unknown) => ({ output_text: JSON.stringify(value), output: [] }) as any;
function seed(id = 'reuse-tenant3', businessId = 3, text = question) {
  b.businessInformationState(id, { ...snapshot.business, id: businessId }, text, 'de', `source_id: ${snapshot.sources[0].id}\n${fact}`);
}
function harness(t: any, claims: any[], verdict: (body: any, call: number) => string = () => 'ENTAILED', latency = false) {
  const events: any[] = [], diagnostics: any[] = [];
  let extraction = 0, repair = 0, entailment = 0, adjudication = 0;
  const perClaim = new Map<string, number>();
  t.mock.method(console, 'info', (label: string, event: any) => {
    if (label === '[BusinessSupportVerifierTiming]') events.push(event);
  });
  t.mock.method(console, 'error', () => {});
  t.mock.method(Models.prototype as any, 'generateContentInternal', async () => { throw new Error('Gemini must not run'); });
  b.configure({ businessGroundingDiagnostic: event => diagnostics.push(event) });
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    assert.equal(params.model, 'gpt-5.6-luna');
    assert.equal(params.tools, undefined);
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    const body = JSON.parse(params.input[0].content);
    if (params.instructions.includes('strict business-response claim and citation extractor')) {
      if (body.previousAssessment) repair++; else extraction++;
      assert.ok(body.groundingEvidence.includes(fact));
      if (latency) await delay(1435);
      return response(assessment(claims));
    }
    const isAdjudication = params.instructions.includes('semantic adjudicator');
    if (isAdjudication) adjudication++; else entailment++;
    const calls = (perClaim.get(body.atomicClaim) || 0) + 1;
    perClaim.set(body.atomicClaim, calls);
    if (latency) await delay(body.atomicClaim === catalog ? 400 : 152);
    const relation = verdict(body, calls);
    if (relation === 'TIMEOUT') throw new AiReliabilityError('TIMEOUT', 'offline injected timeout');
    return response({ relation, claimKind: 'OTHER', explicitAbsenceEvidence: false });
  });
  return { events, diagnostics, perClaim, counts: () => ({ extraction, entailment, repairAdjudication: repair + adjudication, total: extraction + entailment + repair + adjudication }) };
}
async function run() { return b.businessSupportGrounding('reuse-tenant3', question, candidate, 'de'); }

test('tenant-3 German accepted catalog + address: required extraction and parallel entailment remain 3 calls', async t => {
  const h = harness(t, [catalogClaim(), locationClaim()]);
  seed();
  assert.equal(await run(), candidate);
  assert.deepEqual(h.counts(), { extraction: 1, entailment: 2, repairAdjudication: 0, total: 3 });
  assert.equal(h.diagnostics[0].verifiedEvidence, true);
  assert.equal(h.diagnostics[0].claimsEntailed, true);
});

test('German compound recovery reuses exact conclusive catalog and location verdicts; latency benchmark', async t => {
  const h = harness(t, [catalogClaim(), locationClaim()], body => body.atomicClaim === catalog ? 'CONTRADICTED' : 'ENTAILED', true);
  seed();
  const started = performance.now();
  const reply = await run();
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(reply.includes(address));
  for (const service of snapshot.business.services.slice(0, 5)) assert.ok(reply.includes(service.name));
  assert.deepEqual(h.counts(), { extraction: 1, entailment: baseline ? 4 : 2, repairAdjudication: 0, total: baseline ? 5 : 3 });
  assert.equal(h.perClaim.get(location), baseline ? 2 : 1);
  assert.equal(h.perClaim.get(catalog), baseline ? 2 : 1);
  t.diagnostic(JSON.stringify({ mode: baseline ? 'before' : 'after', ...h.counts(), elapsedMs,
    modeledProductionVerifierMs: baseline ? 14353 + 4000 + 4000 + 1515 : 14353 + 4000,
    calls: h.events.filter(e => e.stage.endsWith('_provider_start')).map(e => ({ stage: e.stage, candidateLength: e.candidateLength, evidenceLength: e.evidenceLength })) }));
});

test('production-shaped three-claim UNKNOWN sequence is completed once per phase and reused during recovery', async t => {
  const extra = 'Video Consultation kostet 300 SEK.';
  const expanded = `${catalog}\n${extra}\n${location}`;
  const h = harness(t, [catalogClaim(), claim(extra, 'structured_business_config', '"price": 300'), locationClaim()],
    body => body.atomicClaim === extra ? 'UNKNOWN' : 'ENTAILED');
  // Distinct first/retry/adjudication latency matches the observed recovery
  // pattern at 1/10 scale, without changing any application's timeout budget.
  const create = Responses.prototype.create;
  let extraCalls = 0;
  t.mock.method(Responses.prototype, 'create', async function(this: any, params: any, ...rest: any[]) {
    const body = JSON.parse(params.input[0].content);
    if (body.candidateReply) await delay(1435);
    else if (body.atomicClaim === extra) {
      const phase = extraCalls++ % 3;
      await delay([400, 144, 934][phase]);
    } else await delay(body.atomicClaim === catalog ? 400 : 152);
    return create.call(this, params, ...rest);
  });
  seed();
  const started = performance.now();
  const reply = await b.businessSupportGrounding('reuse-tenant3', question, expanded, 'de');
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(reply.includes(address));
  assert.equal(reply.includes(extra), false, 'inconclusive extra assertion is not emitted');
  assert.equal(h.perClaim.get(extra), baseline ? 6 : 3);
  assert.equal(h.perClaim.get(location), baseline ? 2 : 1);
  assert.deepEqual(h.counts(), { extraction: 1, entailment: baseline ? 8 : 4, repairAdjudication: baseline ? 2 : 1, total: baseline ? 11 : 6 });
  t.diagnostic(JSON.stringify({ scenario: 'three-claim-production-pattern', mode: baseline ? 'before' : 'after', ...h.counts(), elapsedMs }));
});

test('contradicted address remains rejected, including during compound recovery', async t => {
  const h = harness(t, [catalogClaim(), locationClaim()], body => body.atomicClaim === location ? 'CONTRADICTED' : 'ENTAILED');
  seed();
  const reply = await run();
  assert.equal(reply.includes(address), false);
  assert.ok(reply.includes('Video Consultation'));
  assert.equal(h.perClaim.get(location), baseline ? 2 : 1);
});

test('fabricated exact evidence never reaches address entailment and never emits the address', async t => {
  const unsupported = 'Unser Eingang befindet sich in Foreign Road 999.';
  const h = harness(t, [catalogClaim(), claim(unsupported, 'retrieved_knowledge', unsupported)]);
  seed();
  const reply = await b.businessSupportGrounding('reuse-tenant3', question, `${catalog}\n${unsupported}`, 'de');
  assert.equal(reply.includes('Foreign Road'), false);
  assert.equal(h.perClaim.has(unsupported), false);
  assert.equal(h.counts().repairAdjudication, 1, 'evidence quote repair is retained');
});

test('same in-flight claim/quote/evidence deduplicates; different exact evidence requires fresh verification', async t => {
  const shortFact = /kundentrén ligger på .+\.$/u.exec(fact)![0];
  const same = locationClaim();
  const h = harness(t, [catalogClaim(), same, structuredClone(same), claim(location, 'retrieved_knowledge', shortFact)]);
  seed();
  assert.equal(await run(), candidate);
  assert.equal(h.perClaim.get(location), baseline ? 3 : 2);
  assert.equal(h.counts().entailment, baseline ? 4 : 3);
});

test('results never cross turns, sessions or business IDs', async t => {
  const h = harness(t, [catalogClaim(), locationClaim()]);
  seed();
  await run();
  await run();
  seed('second-session', 3);
  await b.businessSupportGrounding('second-session', question, candidate, 'de');
  seed('different-tenant', 99);
  await b.businessSupportGrounding('different-tenant', question, candidate, 'de');
  assert.equal(h.counts().extraction, 4);
  assert.equal(h.perClaim.get(location), 4);
  assert.equal(h.perClaim.get(catalog), 4);
});

test('UNKNOWN/NEUTRAL retry and different adjudication prompt remain real independent calls', async t => {
  const h = harness(t, [catalogClaim(), locationClaim()], (body, count) => body.atomicClaim === location && count < 3 ? 'UNKNOWN' : 'ENTAILED');
  seed();
  assert.equal(await run(), candidate);
  assert.equal(h.perClaim.get(location), 3);
  assert.deepEqual(h.counts(), { extraction: 1, entailment: 3, repairAdjudication: 1, total: 5 });
});

test('timeout results are not reused as verification; repeated failure still emits no unverified address', async t => {
  const h = harness(t, [catalogClaim(), locationClaim()], body => body.atomicClaim.includes(address) ? 'TIMEOUT' : 'ENTAILED');
  seed();
  const reply = await run();
  assert.equal(reply.includes(address), false);
  assert.ok(reply.includes('Video Consultation'));
  assert.equal(h.perClaim.get(location), 2, 'failed transport is not cached as a verdict');
  assert.equal(h.counts().entailment, 4, 'the narrow fallback also fails and cannot authorize the address');
  assert.equal(h.diagnostics[0].claimsEntailed, false);
});

test('recommendation catalog and natural clarification retain exact evidence and a separate entailment call', async t => {
  const recommendation = 'Welche Dienstleistung empfehlen Sie mir?';
  const clarification = 'Welches Ergebnis möchten Sie erreichen?';
  const h = harness(t, [catalogClaim()]);
  seed('reuse-tenant3', 3, recommendation);
  const reply = await b.businessSupportGrounding('reuse-tenant3', recommendation, `${catalog}\n${clarification}`, 'de');
  assert.equal(reply, `${catalog}\n${clarification}`);
  assert.equal(h.perClaim.get(catalog), 1);
  assert.equal(h.diagnostics[0].verifiedEvidence, true);
  assert.equal(h.diagnostics[0].claimsEntailed, true);
});
