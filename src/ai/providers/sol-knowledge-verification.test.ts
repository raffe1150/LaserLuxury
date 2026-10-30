import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { generateWithOpenAi } from './openai';
import { knowledgeStructuredOutput } from '../knowledge-answer-protocol';
import type { UnifiedAiGenerationRequest } from './provider';

const root = 'docs/validation/shared-core-2026-10-22/frozen-verifier-qualification-20261026';
const plan = JSON.parse(readFileSync(`${root}/finite-provider-plan.json`, 'utf8'));
const capture = JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/p1-en-native-safety-20261026/P1-en.result.json', 'utf8'));
const savedOutput = capture.state.calls.find((call: { stage: string }) => call.stage === 'verification').outputText;
const verification = knowledgeStructuredOutput('verification', false, undefined, 6, 'v2');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
let previousKey: string | undefined;
beforeEach(() => { previousKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-offline-only'; });
afterEach(() => {
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
});

for (const item of plan.requests) test(`Sol verification exact SDK wire: ${item.id}`, async t => {
  const frozen = JSON.parse(readFileSync(`${root}/${item.requestFile}`, 'utf8'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    const wire: unknown = JSON.parse(String(init?.body));
    // The existing guarded acceptance transport owns max_output_tokens. Do not
    // change that contract or pretend this adapter enforces a spending ceiling.
    const { max_output_tokens, ...expected } = frozen;
    assert.equal(max_output_tokens, 8192);
    assert.deepEqual(wire, { ...expected, model: 'gpt-6.1-sol', reasoning: { effort: 'low' } });
    return new Response(JSON.stringify({ object: 'response', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: savedOutput }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await generateWithOpenAi({ model: 'gpt-6.1-sol', reasoningEffort: 'low',
    systemInstruction: frozen.instructions, messages: frozen.input, structuredOutput: verification });
  assert.equal(calls, 1);
  assert.equal(result.text, savedOutput, 'Saved UNKNOWN/UNRESOLVED output is not repaired or upgraded');
  assert.equal(result.structuredFailure, undefined);
});

const defaults: Array<{ name: string; request: Partial<UnifiedAiGenerationRequest>; low: boolean }> = [
  { name: 'Luna existing low without verification schema', request: { model: 'gpt-5.6-luna', reasoningEffort: 'low' }, low: true },
  { name: 'Luna default effort', request: { model: 'gpt-5.6-luna' }, low: false },
  { name: 'Sol ordinary conversation', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low' }, low: false },
  { name: 'explicit Sol strict extraction opt-in', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: knowledgeStructuredOutput('extraction') }, low: true },
  { name: 'Sol extraction without explicit low', request: { model: 'gpt-6.1-sol', structuredOutput: knowledgeStructuredOutput('extraction') }, low: false },
  { name: 'Sol non-strict extraction', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: { ...knowledgeStructuredOutput('extraction'), strict: false } }, low: false },
  { name: 'Sol extraction without strict field', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: { ...knowledgeStructuredOutput('extraction'), strict: undefined } }, low: false },
  { name: 'Sol literal extraction', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: knowledgeStructuredOutput('extraction', false, ['f1'], 6, 'v2', 'literal-evidence-v1') }, low: false },
  { name: 'Sol natural extraction', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: knowledgeStructuredOutput('extraction', true, ['f1']) }, low: false },
  { name: 'Other model strict extraction', request: { model: 'gpt-6-sol', reasoningEffort: 'low', structuredOutput: knowledgeStructuredOutput('extraction') }, low: false },
  { name: 'Sol witness diagnostic', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: knowledgeStructuredOutput('verification', false, undefined, 6, 'coverage-witness-v1') }, low: false },
  { name: 'Sol non-strict schema', request: { model: 'gpt-6.1-sol', reasoningEffort: 'low', structuredOutput: { ...verification, strict: false } }, low: false },
  { name: 'Sol verifier without explicit low', request: { model: 'gpt-6.1-sol', structuredOutput: verification }, low: false },
  { name: 'Other model strict verifier', request: { model: 'gpt-6-sol', reasoningEffort: 'low', structuredOutput: verification }, low: false },
];
for (const fixture of defaults) test(`reasoning scope preserves ${fixture.name}`, async t => {
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const wire: unknown = JSON.parse(String(init?.body));
    assert.ok(object(wire));
    assert.deepEqual(wire.reasoning, fixture.low ? { effort: 'low' } : undefined);
    assert.equal(wire.model, fixture.request.model);
    return new Response(JSON.stringify({ object: 'response', status: 'completed', output: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await generateWithOpenAi({ messages: [{ role: 'user', content: 'Offline scope control' }], ...fixture.request });
});

test('Sol verifier truncated output remains a mandatory failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ object: 'response',
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const result = await generateWithOpenAi({ model: 'gpt-6.1-sol', reasoningEffort: 'low',
    structuredOutput: verification, messages: [{ role: 'user', content: 'Offline truncation control' }] });
  assert.equal(result.structuredFailure, 'TRUNCATED');
});

const cfa = JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/cfa-responsiveness-native-20261027-once/C-fa/result.json', 'utf8'));
const extractionCall = cfa.state.calls.find((call: { stage: string }) => call.stage === 'extraction');
const frozenExtraction = extractionCall.request;

test('Sol extraction exact SDK wire preserves frozen Persian input, evidence and strict bounded schema', async t => {
  assert.equal(frozenExtraction.max_output_tokens, 8192);
  const { type, ...structuredOutput } = frozenExtraction.text.format;
  assert.equal(type, 'json_schema');
  assert.deepEqual(structuredOutput, knowledgeStructuredOutput('extraction', false, ['f1'], 6, 'v2'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    const wire = JSON.parse(String(init?.body));
    const { max_output_tokens, service_tier, prompt_cache_options, ...adapterFields } = frozenExtraction;
    assert.deepEqual(wire, { ...adapterFields, model: 'gpt-6.1-sol', reasoning: { effort: 'low' } });
    // The diagnostic transport retains the complete output/billing envelope.
    assert.deepEqual({ ...wire, max_output_tokens, service_tier, prompt_cache_options },
      { ...frozenExtraction, model: 'gpt-6.1-sol' });
    return new Response(JSON.stringify({ object: 'response', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: extractionCall.outputText }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await generateWithOpenAi({ model: 'gpt-6.1-sol', reasoningEffort: 'low',
    systemInstruction: frozenExtraction.instructions, messages: frozenExtraction.input, structuredOutput });
  assert.equal(calls, 1);
  assert.equal(result.text, extractionCall.outputText, 'Saved unwanted supplement is not locally filtered or repaired');
});

test('inheriting Sol from configuration does not opt extraction into low reasoning', async t => {
  const prior = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = 'gpt-6.1-sol';
  t.after(() => { if (prior === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = prior; });
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    const wire = JSON.parse(String(init?.body));
    assert.equal(wire.model, 'gpt-6.1-sol'); assert.equal(wire.reasoning, undefined);
    return new Response(JSON.stringify({ object: 'response', status: 'completed', output: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await generateWithOpenAi({ messages: [{ role: 'user', content: 'Offline inheritance control' }],
    reasoningEffort: 'low', structuredOutput: knowledgeStructuredOutput('extraction') });
});
