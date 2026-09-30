import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Models } from '@google/genai';
import { buildConfiguredServiceCatalogPlan, formatConfiguredServiceCatalogPlan } from './business-information';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/business-information-tenant3.json', import.meta.url), 'utf8'));
const fact = fixture.sources[0].content;
const address = /kundentrén ligger på (.+)\.$/u.exec(fact)![1];
const question = 'Hallo! Welche Dienstleistungen bieten Sie an und wo befinden Sie sich?';
const catalog = formatConfiguredServiceCatalogPlan(buildConfiguredServiceCatalogPlan(fixture.business.services), 'de');
const location = `Unser Kundeneingang befindet sich in ${address}.`;
const candidate = `${catalog}\n${location}`;
const assessment = { hasBusinessFactualClaims: true, allBusinessClaimsSupported: true, claims: [
  { claim: catalog, candidateQuote: catalog, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
    evidence: [{ source: 'structured_business_config', quote: '"name": "Video Consultation"' }] },
  { claim: location, candidateQuote: location, claimKind: 'OTHER', requiresBusinessEvidence: true, supported: true,
    evidence: [{ source: 'retrieved_knowledge', quote: fact }] },
] };
const sdkResponse = (value: unknown) => JSON.stringify({ id: 'resp_offline', object: 'response', status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }] });
const baseline = process.env.EXTRACTION_CANCELLATION_BASELINE === '1';
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-offline-cancel', AI_PROVIDER_TIMEOUT_MS: '1000' });
  // Preserve the model resolution code; the offline test supplies its established model.
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';
  b.reset();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv); b.reset();
});
function seed(id: string) {
  b.businessInformationState(id, fixture.business, question, 'de', `source_id: ${fixture.sources[0].id}\n${fact}`);
}
function capture(t: any) {
  const diagnostics: any[] = [], failures: any[] = [];
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', (label: string, event: any) => { if (label === '[OpenAIProviderFailure]') failures.push(event); });
  t.mock.method(Models.prototype as any, 'generateContentInternal', async () => { throw new Error('Gemini must never run'); });
  b.configure({ businessGroundingDiagnostic: event => diagnostics.push(event) });
  return { diagnostics, failures };
}

// Run the installed Responses SDK and its real AbortController bridge. Only
// the HTTP transport is replaced; application queue, adapter and parsers run.
function transport(t: any, latency: number, headersEarly = false) {
  const requests: any[] = [];
  const parsedText = JSON.stringify(assessment);
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, ...rest: any[]) => {
    const result = parse(text, ...rest);
    if (text === parsedText) {
      const current = requests.find(r => r.extraction && r.parseCompleteMs === null);
      if (current) current.parseCompleteMs = performance.now() - current.start;
    }
    return result;
  });
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    const params = parse(String(init.body));
    const extraction = params.instructions?.includes('strict business-response claim and citation extractor');
    assert.equal(params.model, 'gpt-5.6-luna');
    assert.equal(params.stream, undefined);
    assert.equal(params.max_output_tokens, undefined);
    assert.equal(params.reasoning, undefined);
    assert.equal(params.text, undefined, 'JSON shape is prompt-enforced, not API structured output');
    const body = parse(params.input[0].content);
    const event = { start: performance.now(), extraction, aborted: false, headersMs: null as number | null,
      firstByteMs: null as number | null, providerCompleteMs: null as number | null, parseCompleteMs: null as number | null,
      instructionsLength: params.instructions.length, userLength: params.input[0].content.length,
      candidateLength: body.candidateReply?.length ?? null, evidenceLength: body.groundingEvidence?.length ?? null,
      sources: extraction ? Object.fromEntries(body.groundingEvidence.split(/\n\n(?=SOURCE )/).map((section: string) => {
        const newline = section.indexOf('\n'); return [section.slice(7, newline - 1), section.slice(newline + 1).length];
      })) : undefined };
    requests.push(event);
    const value = extraction ? assessment : { relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false };
    const payload = new TextEncoder().encode(sdkResponse(value));
    const responseDelay = extraction ? latency : 10;
    if (!headersEarly) {
      try { await delay(responseDelay, undefined, { signal: init.signal }); }
      catch (error) { event.aborted = init.signal.aborted; throw error; }
      event.headersMs = event.firstByteMs = event.providerCompleteMs = performance.now() - event.start;
      return new Response(payload, { headers: { 'content-type': 'application/json' } });
    }
    event.headersMs = performance.now() - event.start;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => { clearTimeout(timer); event.aborted = true; controller.error(new DOMException('Aborted', 'AbortError')); };
      init.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        init.signal.removeEventListener('abort', abort);
        event.firstByteMs = event.providerCompleteMs = performance.now() - event.start;
        controller.enqueue(payload); controller.close();
      }, responseDelay);
    } });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  });
  return requests;
}

test('installed OpenAI SDK aborts timed-out extraction transport and releases all occupied slots', async t => {
  const h = capture(t), requests = transport(t, 1300);
  const ids = ['cancel-a', 'cancel-b', 'cancel-c']; ids.forEach(seed);
  const replies = await Promise.all(ids.map(id => b.businessSupportGrounding(id, question, candidate, 'de')));
  for (const reply of replies) { assert.ok(reply.includes('Video Consultation')); assert.equal(reply.includes(address), false); }
  assert.ok(h.diagnostics.every(d => !d.verifierReturnedAssessment && !d.claimsEntailed));
  await delay(0); // allow SDK rejection and queue finally blocks to drain
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.aborted && r.providerCompleteMs === null && r.parseCompleteMs === null));
  const result = await b.promptAuditGenerate(null, { messages: [{ role: 'user', content: JSON.stringify({ atomicClaim: 'offline follow-up' }) }], systemInstruction: 'offline follow-up' });
  assert.ok(result.text.includes('ENTAILED'));
  assert.equal(requests.length, 4);
  assert.equal(h.failures.length, 3);
  const diagnosticText = JSON.stringify(h.failures);
  for (const secret of [question, candidate, fact, address, 'sk-offline-cancel']) assert.equal(diagnosticText.includes(secret), false);
});

test('abort remains effective after response headers, during unfinished SDK JSON body consumption', async t => {
  const h = capture(t), requests = transport(t, 1300, true); seed('body-abort');
  const reply = await b.businessSupportGrounding('body-abort', question, candidate, 'de');
  await delay(0);
  assert.equal(reply.includes(address), false);
  assert.equal(h.diagnostics[0].verifierReturnedAssessment, false);
  assert.ok(requests[0].headersMs !== null && requests[0].headersMs < 1000);
  assert.equal(requests[0].aborted, true);
  assert.equal(requests[0].firstByteMs, null);
  assert.equal(requests[0].parseCompleteMs, null);
});

test('six repeated production-shaped path runs record variance and deadline outcomes without changing prompt or safety', async t => {
  capture(t);
  const rows: any[] = [];
  // 1/20 scale: original 16–21.422 second latency, original 20 second
  // application deadline. This proves plumbing; it is not live model latency.
  for (const modeledMs of [16000, 18000, 19000, 19500, 20500, 21422]) {
    const requests = transport(t, modeledMs / 20);
    const id = `distribution-${modeledMs}`; seed(id);
    const started = performance.now();
    const reply = await b.businessSupportGrounding(id, question, candidate, 'de');
    const groundingMs = Math.round(performance.now() - started);
    const extraction = requests[0];
    const success = reply.includes(address);
    assert.equal(success, modeledMs < 20000);
    assert.equal(requests.length, success ? 3 : 1, 'successful extraction still requires two independent entailment calls');
    if (modeledMs > 20000) {
      await delay(modeledMs / 20 - 1000 + 40);
      assert.equal(extraction.aborted, !baseline);
      assert.equal(extraction.parseCompleteMs, null, 'late extraction never reaches grounding parser');
      assert.equal(reply.includes(address), false);
    }
    rows.push({ modeledProviderMs: modeledMs, extractionCompletionMs: extraction.providerCompleteMs === null ? null : Math.round(extraction.providerCompleteMs),
      firstResponseMs: extraction.headersMs === null ? null : Math.round(extraction.headersMs),
      firstByteMs: extraction.firstByteMs === null ? null : Math.round(extraction.firstByteMs),
      parseCompletionMs: extraction.parseCompleteMs === null ? null : Math.round(extraction.parseCompleteMs),
      groundingMs, totalVerifierCalls: requests.length, success, aborted: extraction.aborted,
      instructionsLength: extraction.instructionsLength, userLength: extraction.userLength,
      totalInputCharacters: extraction.instructionsLength + extraction.userLength,
      candidateLength: extraction.candidateLength, evidenceLength: extraction.evidenceLength, sources: extraction.sources });
    t.mock.restoreAll(); capture(t);
  }
  t.diagnostic(JSON.stringify({ scenario: 'extraction-distribution', mode: baseline ? 'before' : 'after', scale: 20, rows }));
});
