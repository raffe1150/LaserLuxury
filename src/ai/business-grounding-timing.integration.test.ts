import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Responses } from 'openai/resources/responses';
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
const assessment = {
  hasBusinessFactualClaims: true, allBusinessClaimsSupported: true,
  claims: [
    { claim: catalog, candidateQuote: catalog, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
      evidence: [{ source: 'structured_business_config', quote: '"name": "Video Consultation"' }] },
    { claim: location, candidateQuote: location, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
      evidence: [{ source: 'retrieved_knowledge', quote: fact }] },
  ],
};
const response = (value: unknown) => ({ output_text: JSON.stringify(value), output: [] }) as any;
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-timing-test', OPENAI_MODEL: 'gpt-5.6-luna' });
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  b.reset();
});
function seed() {
  b.businessInformationState('timing-tenant3', snapshot.business, question, 'de', `source_id: ${snapshot.sources[0].id}\n${fact}`);
}
function capture(t: any) {
  const timings: any[] = [], diagnostics: any[] = [];
  t.mock.method(console, 'info', (label: string, event: any) => {
    if (label === '[BusinessSupportVerifierTiming]') timings.push(event);
  });
  b.configure({ businessGroundingDiagnostic: event => diagnostics.push(event) });
  return { timings, diagnostics };
}
function assertSafe(timings: any[]) {
  const allowed = ['stage', 'correlationId', 'businessId', 'elapsedMs', 'queueWaitMs', 'providerExecutionMs', 'attempt', 'candidateLength', 'evidenceLength', 'claimCount', 'timeoutBudgetMs'].sort();
  for (const event of timings) {
    assert.deepEqual(Object.keys(event).sort(), allowed);
    assert.match(event.correlationId, /^[a-f0-9-]{36}$/);
    assert.equal(event.businessId, 3);
  }
  const serialized = JSON.stringify(timings);
  for (const privateText of [question, candidate, fact, address, 'sk-offline-timing-test', 'Video Consultation']) {
    assert.equal(serialized.includes(privateText), false);
  }
}

test('German tenant-3 catalog and location survive bounded latency; independent entailment calls already run in parallel', async t => {
  const { timings, diagnostics } = capture(t);
  let extractionCalls = 0, activeEntailments = 0, maxActiveEntailments = 0;
  const claims: string[] = [];
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    assert.equal(params.model, 'gpt-5.6-luna');
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    assert.equal(params.tools, undefined);
    const body = JSON.parse(params.input[0].content);
    if (params.instructions.includes('strict business-response claim and citation extractor')) {
      extractionCalls++;
      assert.ok(body.groundingEvidence.includes(fact));
      await delay(1200);
      return response(assessment);
    }
    assert.match(params.instructions, /final strict entailment gate/);
    claims.push(body.atomicClaim);
    activeEntailments++;
    maxActiveEntailments = Math.max(maxActiveEntailments, activeEntailments);
    await delay(500);
    activeEntailments--;
    return response({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false });
  });
  seed();
  assert.equal(await b.businessSupportGrounding('timing-tenant3', question, candidate, 'de'), candidate);
  assert.equal(extractionCalls, 1);
  assert.deepEqual(new Set(claims), new Set([catalog, location]));
  assert.equal(claims.length, 2);
  assert.equal(maxActiveEntailments, 2);
  assert.equal(diagnostics[0].claimsEntailed, true);
  assert.ok(timings.every(event => event.timeoutBudgetMs === 20000 && event.attempt === 1));
  assertSafe(timings);
});

test('production 20-second execution deadline fails closed, retains catalog, and reports late provider completion', async t => {
  const { timings, diagnostics } = capture(t);
  const errors = t.mock.method(console, 'error', () => {});
  let calls = 0;
  let providerFinished!: () => void;
  const finished = new Promise<void>(resolve => { providerFinished = resolve; });
  t.mock.method(Responses.prototype, 'create', async () => {
    calls++;
    await delay(20100);
    providerFinished();
    return response(assessment);
  });
  seed();
  const reply = await b.businessSupportGrounding('timing-tenant3', question, candidate, 'de');
  assert.ok(reply.includes('Video Consultation'));
  assert.equal(reply.includes(address), false);
  assert.equal(diagnostics[0].verifierReturnedAssessment, false);
  assert.equal(diagnostics[0].claimsEntailed, false);
  assert.equal(calls, 1, 'timeout is not retried and entailment is never reached');
  const timedOut = timings.find(event => event.stage.endsWith('_attempt_timeout'));
  assert.equal(timedOut.timeoutBudgetMs, 20000);
  assert.ok(timedOut.queueWaitMs < 1000);
  assert.ok(timedOut.providerExecutionMs >= 19000);
  await finished;
  await delay(0);
  assert.ok(timings.some(event => event.stage.endsWith('_provider_complete') && event.elapsedMs > 20000));
  assert.equal(reply.includes(address), false, 'late provider output cannot alter the returned reply');
  assert.equal(errors.mock.callCount(), 1);
  assertSafe(timings);
});

test('queue wait consumes the existing deadline; diagnostics distinguish it and expose late queued execution', async t => {
  process.env.AI_PROVIDER_TIMEOUT_MS = '1000'; // Test-only time scaling; production configuration is unchanged.
  const { timings, diagnostics } = capture(t);
  t.mock.method(console, 'error', () => {});
  const releases: Array<() => void> = [];
  let extractionCalls = 0;
  t.mock.method(Responses.prototype, 'create', async (params: any) => {
    if (params.instructions === 'occupy test queue slot') {
      await new Promise<void>(resolve => releases.push(resolve));
      return { output_text: 'released', output: [] } as any;
    }
    extractionCalls++;
    return response(assessment);
  });
  const blockers = Array.from({ length: 3 }, () => b.promptAuditGenerate(null, {
    messages: [{ role: 'user', content: 'offline queue test' }], systemInstruction: 'occupy test queue slot',
  }).catch(() => null));
  while (releases.length < 3) await delay(0);
  seed();
  const reply = await b.businessSupportGrounding('timing-tenant3', question, candidate, 'de');
  assert.equal(reply.includes(address), false);
  assert.ok(reply.includes('Video Consultation'));
  assert.equal(diagnostics[0].verifierReturnedAssessment, false);
  assert.equal(extractionCalls, 0, 'the assessment can time out before any SDK call starts');
  const timedOut = timings.find(event => event.stage.endsWith('_attempt_timeout'));
  assert.equal(timedOut.providerExecutionMs, null);
  assert.ok(timedOut.queueWaitMs >= 950);
  assert.equal(timedOut.timeoutBudgetMs, 1000);
  releases.forEach(release => release());
  await Promise.all(blockers);
  await delay(0);
  assert.equal(extractionCalls, 1, 'existing queue starts the abandoned job after deadline');
  const lateStart = timings.find(event => event.stage.endsWith('_provider_start'));
  assert.ok(lateStart.queueWaitMs >= 950);
  assert.equal(reply.includes(address), false);
  assertSafe(timings);
});
