/** Mock SDK/owner protocol controls only;not real model or durable accounting proof. */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateWithOpenAi } from './openai';
import { knowledgeStructuredOutput } from '../knowledge-answer-protocol';
import { captureKnowledgeModelProfile, configureKnowledgeBudgetOwner, knowledgeStageOptions, executeKnowledgeGeneration } from '../knowledge-model-policy';
import type { UnifiedAiGenerationRequest } from './provider';
import { ScriptedKnowledgeBudgetOwner } from '../../../tests/helpers/knowledge-budget-owner';

const binding = { businessId: 77, turnId: 'wire-turn', requestKey: 'a'.repeat(64) };
const env = { ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'sol-low-v1', ODINLINK_KNOWLEDGE_SOL_TENANT_IDS: '77' };
const context = { ...binding, provider: 'openai', nativeForeground: true, natural: false, durable: false,
  extractionProtocol: 'v2', verificationProtocol: 'v2', documentary: true, operational: false, current: async () => true };
let owner: ScriptedKnowledgeBudgetOwner;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => { savedEnv = { ...process.env }; process.env.OPENAI_API_KEY = 'synthetic-offline-only'; delete process.env.OPENAI_BASE_URL;
  owner = new ScriptedKnowledgeBudgetOwner(); configureKnowledgeBudgetOwner(owner); });
afterEach(() => { configureKnowledgeBudgetOwner(); for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });
function request(stage: 'extraction' | 'verification' = 'extraction', deadlineAt = Date.now() + 19000): UnifiedAiGenerationRequest {
  const profile = captureKnowledgeModelProfile(context, env);
  return { ...knowledgeStageOptions(profile, stage, binding, deadlineAt), signal: new AbortController().signal,
    systemInstruction: stage === 'extraction' ? 'OdinLink UNIT EXTRACTION' : 'OdinLink BATCH ENTAILMENT',
    messages: [{ role: 'user', content: JSON.stringify({ question: 'Original question', requestedLanguage: 'sv', evidence: [{ id: 'e1', businessId: 77, text: 'Original full source text.' }] }) }],
    structuredOutput: knowledgeStructuredOutput(stage, false, stage === 'extraction' ? ['f1'] : undefined, 6, 'v2') };
}
function raw() { return { object: 'response', model: 'gpt-6.1-sol', status: 'completed', service_tier: 'default', reasoning: { effort: 'low' },
  prompt_cache_options: { mode: 'implicit', ttl: '30m' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"fixture":"unchanged"}' }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 }, output_tokens_details: { reasoning_tokens: 5 } } }; }
for (const stage of ['extraction', 'verification'] as const) test(`exact ${stage}SDK envelope;full advance reservation precedes dispatch andactualusage settles`, async t => {
  const r = request(stage); let count = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => { count++; assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.ok(owner.events.includes('reserve')); assert.equal(owner.reservations.size, 1); assert.ok(init?.signal);
    const wire = JSON.parse(String(init?.body)); assert.equal(wire.model, 'gpt-6.1-sol'); assert.deepEqual(wire.reasoning, { effort: 'low' });
    assert.equal(wire.max_output_tokens, 8192); assert.equal(wire.service_tier, 'default'); assert.deepEqual(wire.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
    assert.deepEqual(wire.text.format, { type: 'json_schema', ...r.structuredOutput }); assert.equal(wire.input[0].content, r.messages[0].content);
    const q = [...owner.reservations.values()][0].quote; assert.equal(q.inputTokenProxy, Buffer.byteLength(JSON.stringify(wire)) + 2048);
    assert.equal(q.maximumNanoUsd, q.inputTokenProxy * 2500 + 8192 * 10000);
    return new Response(JSON.stringify(raw()), { headers: { 'Content-Type': 'application/json' } }); });
  const result = await generateWithOpenAi(r); assert.equal(count, 1); assert.deepEqual(owner.events, ['reserve', 'settle']);
  assert.equal(result.text, '{"fixture":"unchanged"}'); assert.equal(result.knowledgeUsage?.estimatedNanoUsd, 40 * 2000 + 10 * 100 + 50 * 2500 + 20 * 10000);
  assert.equal(result.knowledgeUsage?.reasoningTokens, 5); assert.equal(result.knowledgeUsage?.ownerId, owner.id);
});
for (const mode of ['deny', 'reserve-error', 'receipt-mismatch'] as const) test(`reservation:${mode} permitszero networkcalls`, async t => {
  owner.mode = mode; let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('FORBIDDEN'); });
  await assert.rejects(generateWithOpenAi(request())); assert.equal(calls, 0); assert.equal(owner.events.includes('settle'), false);
});
test('requestbudget exhaustion ischecked beforeatomicreservation ornetwork', async t => {
  owner.maximumRequestNanoUsd = 1; configureKnowledgeBudgetOwner(owner); let n = 0;
  t.mock.method(globalThis, 'fetch', async () => { n++; throw Error('FORBIDDEN'); });
  await assert.rejects(generateWithOpenAi(request()), /request_budget/u); assert.equal(n, 0); assert.deepEqual(owner.events, []);
});
test('concurrent duplicate turns cannot dispatch twice througha scriptedatomicowner', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(raw()), { headers: { 'Content-Type': 'application/json' } }); });
  const results = await Promise.allSettled([generateWithOpenAi(request()), generateWithOpenAi(request())]);
  assert.equal(calls, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(owner.reservations.size, 1);
});
for (const kind of ['model', 'tier', 'cache', 'effort', 'input', 'output', 'reasoning', 'ttl', 'usage', 'cache-read-missing', 'cache-write-missing'] as const) test(`mismatched ${kind}receipt retainsfull reserve andfailsclosed`, async t => {
  const receipt = raw();
  if (kind === 'model') receipt.model = 'gpt-5.6-luna'; if (kind === 'tier') receipt.service_tier = 'priority';
  if (kind === 'cache') receipt.prompt_cache_options.ttl = '12h'; if (kind === 'effort') receipt.reasoning.effort = 'high';
  if (kind === 'input') receipt.usage.input_tokens = 1_000_000; if (kind === 'output') receipt.usage.output_tokens = 8193;
  if (kind === 'reasoning') receipt.usage.output_tokens_details.reasoning_tokens = 21;
  if (kind === 'ttl') Reflect.set(receipt.usage.input_tokens_details, 'cache_write_tokens_details', { ttl_12h_tokens: 5 });
  if (kind === 'usage') Reflect.deleteProperty(receipt, 'usage');
  if (kind === 'cache-read-missing') Reflect.deleteProperty(receipt.usage.input_tokens_details, 'cached_tokens');
  if (kind === 'cache-write-missing') Reflect.deleteProperty(receipt.usage.input_tokens_details, 'cache_write_tokens');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(generateWithOpenAi(request())); assert.ok(owner.events.includes('retainUnknown')); assert.ok([...owner.reservations.values()].every(r => r.unknown && r.cost === undefined));
});
test('settlement failure cannot publish orreleasea possiblyunsettledreservation', async t => {
  owner.mode = 'settle-error'; t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(raw()), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(generateWithOpenAi(request())); assert.deepEqual(owner.events, ['reserve', 'settle', 'retainUnknown']);
});
test('providererror:noSDK retry,no alternate model,full unknownreserve kept', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ error: { message: 'scripted unavailable' } }), { status: 500 }); });
  await assert.rejects(generateWithOpenAi(request())); assert.equal(calls, 1); assert.ok(owner.events.includes('retainUnknown'));
});
test('pre-cancellation andinsufficient verifierallowance dispatchnothing', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('FORBIDDEN'); });
  const r = request(); const c = new AbortController(); c.abort(); r.signal = c.signal;
  await assert.rejects(generateWithOpenAi(r)); await assert.rejects(generateWithOpenAi(request('verification', Date.now() + 9000)), /dispatch_allowance/u);
  assert.equal(calls, 0); assert.equal(owner.reservations.size, 0);
});
test('deadline cancellation retains unknown usage anddoesnotretry', async t => {
  let calls = 0; const r = request('extraction', Date.now() + 300);
  t.mock.method(globalThis, 'fetch', async (_url, init) => { calls++; return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }); }); });
  await assert.rejects(generateWithOpenAi(r)); assert.equal(calls, 1); assert.ok(owner.events.includes('retainUnknown'));
});
test('foreign evidence,wrong schema,missing signal andunownedpermit fail before network', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('FORBIDDEN'); });
  const foreign = request(); foreign.messages[0].content = JSON.stringify({ evidence: [{ businessId: 88 }] }); await assert.rejects(generateWithOpenAi(foreign), /evidence_tenant/u);
  const wrong = request(); wrong.structuredOutput = knowledgeStructuredOutput('planning'); await assert.rejects(generateWithOpenAi(wrong), /strict_schema|bounded_extraction/u);
  const missing = request(); delete missing.signal; await assert.rejects(generateWithOpenAi(missing), /cancellation/u);
  const forged = request(); forged.knowledgeExecution = { profile: 'sol-low-v1', stage: 'extraction' }; await assert.rejects(generateWithOpenAi(forged), /unowned/u);
  assert.equal(calls, 0);
});
test('customendpoint isnot silently accepted byselectedprofile', async t => {
  process.env.OPENAI_BASE_URL = 'https://example.invalid/v1'; let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('FORBIDDEN'); });
  await assert.rejects(generateWithOpenAi(request()), /endpoint_mismatch/u); assert.equal(calls, 0);
});
test('wire billing mismatch isrejected,not silentlyrepaired', async () => {
  const r = request(); await assert.rejects(executeKnowledgeGeneration(r, { model: r.model, max_output_tokens: 1, service_tier: 'priority' }, async () => raw()), /wire_billing/u);
  assert.equal(owner.reservations.size, 0);
});
test('late atomic reservation cannot extend deadline or dispatch;possible hold stays unknown', async t => {
  const original = owner.reserve.bind(owner);
  t.mock.method(owner, 'reserve', async (q, signal) => { await new Promise(resolve => setTimeout(resolve, 60)); return original(q, signal); });
  configureKnowledgeBudgetOwner(owner); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('FORBIDDEN'); });
  await assert.rejects(generateWithOpenAi(request('extraction', Date.now() + 20)));
  assert.equal(calls, 0); assert.ok(owner.events.includes('retainUnknown'));
  await new Promise(resolve => setTimeout(resolve, 65));
});
test('stage-specific failure closes capturedprofile;no Luna retry orpaidverification rescue', async t => {
  const profile = captureKnowledgeModelProfile(context, env),r = request();
  Object.assign(r, knowledgeStageOptions(profile, 'extraction', binding, Date.now() + 19000));
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('SCRIPTED_NETWORK_FAILURE'); });
  await assert.rejects(generateWithOpenAi(r));
  assert.throws(() => knowledgeStageOptions(profile, 'verification', binding, Date.now() + 19000), /stage_already_closed/u); assert.equal(calls, 1);
});
test('immutable owner approval/limits andstable message reservationkey reach atomic owner', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(raw()), { headers: { 'Content-Type': 'application/json' } }));
  const r = request(); await generateWithOpenAi(r); const q = [...owner.reservations.values()][0].quote;
  assert.equal(q.ownerId, owner.id); assert.equal(q.approvalReference, owner.approvalReference);
  assert.equal(q.maximumRequestNanoUsd, 200_000_000); assert.equal(q.maximumTurnNanoUsd, 500_000_000);
  const other = captureKnowledgeModelProfile({ ...context, turnId: 'another-worker-turn' }, env);
  const repeat = request(); Object.assign(repeat, knowledgeStageOptions(other, 'extraction', { ...binding, turnId: 'another-worker-turn' }, Date.now() + 19000));
  await assert.rejects(generateWithOpenAi(repeat), /reservation_denied/u);
});
test('atomic pending turncapacity cannot fund concurrentExtraction andVerification', async t => {
  owner.maximumRequestNanoUsd = 110_000_000; owner.maximumTurnNanoUsd = 110_000_000; configureKnowledgeBudgetOwner(owner);
  let entered!: () => void, finish!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { calls++; entered(); await gate; return new Response(JSON.stringify(raw()), { headers: { 'Content-Type': 'application/json' } }); });
  const first = generateWithOpenAi(request()); await started;
  await assert.rejects(generateWithOpenAi(request('verification')), /reservation_denied/u);
  assert.equal(calls, 1); finish(); await first;
});
test('revocation during monetary reservation isrechecked beforeSDK;no stale source dispatch', async t => {
  const profile = captureKnowledgeModelProfile({ ...context, current: async () => false }, env),r = request();
  Object.assign(r, knowledgeStageOptions(profile, 'extraction', binding, Date.now() + 19000));
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('FORBIDDEN'); });
  await assert.rejects(generateWithOpenAi(r), /source_or_turn_changed/u);
  assert.equal(calls, 0); assert.deepEqual(owner.events, ['reserve', 'retainUnknown']);
});
