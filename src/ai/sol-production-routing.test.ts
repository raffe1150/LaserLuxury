/** Production-wide Sol routing through the REAL OpenAI adapter and the REAL
 * Knowledge policy, with a mocked SDK transport and the scripted owner
 * (NOT durable accounting proof; see durable-knowledge-budget-owner.test.ts). */
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateWithOpenAi, resolveOpenAiTextModel } from './providers/openai';
import { generateWithConfiguredProvider } from './providers/router';
import { knowledgeStructuredOutput } from './knowledge-answer-protocol';
import { captureKnowledgeModelProfile, configureKnowledgeBudgetOwner, executeKnowledgeGeneration, knowledgeManagedStages, knowledgeReExtractionAvailable,
  knowledgeStageOptions, KNOWLEDGE_SOL_PRODUCTION_PROFILE, type KnowledgeModelProfile } from './knowledge-model-policy';
import { reExtractionAdmission } from './sol-extraction-canary';
import type { UnifiedAiGenerationRequest } from './providers/provider';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';

const SOL = 'gpt-6.1-sol', LUNA = 'gpt-5.6-luna';
const PROD = { ODINLINK_AI_DEFAULT_MODEL: SOL };
const binding = { businessId: 77, turnId: 'production-turn', requestKey: 'c'.repeat(64) };
const context = { ...binding, provider: 'openai', nativeForeground: true, natural: false, durable: false,
  extractionProtocol: 'v2', verificationProtocol: 'source-exhaustive-v2', documentary: true, operational: false, current: async () => true };
const evidence = [{ id: 'e1', businessId: 77, text: 'Source text.' }];
const bookingTools = [{ functionDeclarations: [{ name: 'checkAvailability', description: 'Check slots',
  parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] } }] }];
let owner: ScriptedKnowledgeBudgetOwner;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'ODINLINK_KNOWLEDGE_MODEL_PROFILE', 'ODINLINK_SOL_EXTRACTION_MODE', 'AI_PROVIDER']) delete process.env[key];
  Object.assign(process.env, { OPENAI_API_KEY: 'synthetic-offline-only', ...PROD });
  owner = new ScriptedKnowledgeBudgetOwner(); configureKnowledgeBudgetOwner(owner);
});
afterEach(() => { configureKnowledgeBudgetOwner(); for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });

const raw = (id = 'resp_one', text = '{"units":[]}') => ({ id, object: 'response', model: SOL, status: 'completed', service_tier: 'default', reasoning: { effort: 'low' },
  prompt_cache_options: { mode: 'implicit', ttl: '30m' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 }, output_tokens_details: { reasoning_tokens: 5 } } });
function capture(t: any, wires: any[], fail?: () => Response | never) {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    wires.push(JSON.parse(String(init?.body)));
    if (fail) return fail();
    return new Response(JSON.stringify(raw('resp_' + wires.length)), { headers: { 'Content-Type': 'application/json' } });
  });
}
const quiet = (t: any) => { for (const m of ['warn', 'error'] as const) t.mock.method(console, m, () => {}); };
function knowledge(profile: KnowledgeModelProfile, stage: 'extraction' | 're_extraction' | 'verification',
  over: Partial<UnifiedAiGenerationRequest> = {}, protocol = 'source-exhaustive-v2', turn = binding): UnifiedAiGenerationRequest {
  const schemaStage = stage === 'verification' ? 'verification' : 'extraction';
  return { ...knowledgeStageOptions(profile, stage, turn, Date.now() + 19000), signal: new AbortController().signal,
    routingStage: stage === 'extraction' ? 'knowledge_extraction' : stage === 're_extraction' ? 'knowledge_re_extraction' : 'knowledge_verification',
    systemInstruction: 'OdinLink UNIT ' + stage.toUpperCase(), reasoningEffort: 'low',
    messages: [{ role: 'user', content: JSON.stringify({ question: 'q', requestedLanguage: 'sv', evidence }) }],
    structuredOutput: knowledgeStructuredOutput(schemaStage, false, schemaStage === 'extraction' ? ['f1'] : undefined, 6, protocol as never), ...over };
}

test('conversation + booking tool calling: Sol on the wire with tools, no Luna-only controls, low effort honoured', async t => {
  const wires: any[] = []; capture(t, wires);
  await generateWithConfiguredProvider({ messages: [{ role: 'user', content: 'Kan jag boka på fredag?' }],
    tools: bookingTools, systemInstruction: 'booking assistant', temperature: 0.2 });
  await generateWithConfiguredProvider({ reasoningEffort: 'low', messages: [{ role: 'user', content: 'x' }],
    structuredOutput: { name: 'odinlink_source_query_v1', strict: true, schema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] } } });
  await generateWithConfiguredProvider({ messages: [{ role: 'user', content: 'facts' }] });
  assert.deepEqual(wires.map(w => w.model), [SOL, SOL, SOL]);
  assert.equal(wires[0].tools[0].name, 'checkAvailability');
  assert.equal(wires[0].temperature, undefined, 'Sol never receives an unverified temperature control');
  assert.equal(wires[0].reasoning, undefined);
  assert.deepEqual(wires[1].reasoning, { effort: 'low' });
  assert.equal(wires[1].text.format.name, 'odinlink_source_query_v1');
});

test('provider failure on a Sol conversation is not retried on another model', async t => {
  quiet(t); const wires: any[] = [];
  capture(t, wires, () => new Response(JSON.stringify({ error: { message: 'synthetic', type: 'server_error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(generateWithOpenAi({ routingStage: 'general', messages: [{ role: 'user', content: 'hej' }] }));
  assert.deepEqual(wires.map(w => w.model), [SOL]);
});

test('metered Knowledge stage without a permit: pre-dispatch Luna fallback, logged, never an unmetered Sol request', async t => {
  const warnings: unknown[] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const wires: any[] = []; capture(t, wires);
  for (const routingStage of ['knowledge_extraction', 'knowledge_re_extraction', 'knowledge_verification'] as const)
    await generateWithOpenAi({ routingStage, reasoningEffort: 'low', messages: [{ role: 'user', content: '{}' }],
      structuredOutput: knowledgeStructuredOutput(routingStage === 'knowledge_verification' ? 'verification' : 'extraction', false, undefined, 6, 'source-exhaustive-v2') });
  // Inferred from the contract when the host omits the stage.
  await generateWithOpenAi({ messages: [{ role: 'user', content: '{}' }], structuredOutput: knowledgeStructuredOutput('extraction') });
  assert.deepEqual(wires.map(w => w.model), [LUNA, LUNA, LUNA, LUNA]);
  assert.equal(owner.events.length, 0);
  assert.equal(warnings.length, 4);
  assert.match(JSON.stringify(warnings[0]), /financial_control_unavailable/u);
  assert.ok(!JSON.stringify(warnings).includes('Source text'), 'routing logs are content-free');
});

test('production profile: captured globally (any owner-entitled tenant), all three metered stages managed', () => {
  const profile = captureKnowledgeModelProfile(context, PROD);
  assert.equal(profile.id, KNOWLEDGE_SOL_PRODUCTION_PROFILE);
  assert.deepEqual([...knowledgeManagedStages(profile)].sort(), ['extraction', 're_extraction', 'verification']);
  owner.businessIds = [77, 4, 12]; configureKnowledgeBudgetOwner(owner);
  assert.equal(captureKnowledgeModelProfile({ ...context, businessId: 12, turnId: 'tenant-12' }, PROD).id, KNOWLEDGE_SOL_PRODUCTION_PROFILE);
  for (const stage of ['language', 'planning', 'composition', 'presentation_verification'])
    assert.deepEqual(knowledgeStageOptions(profile, stage, binding, Date.now() + 19000), {});
});

test('source-exhaustive-v2 verifier runs on Sol: exact schema, low effort, reserve -> dispatch -> settle', async t => {
  const wires: any[] = []; capture(t, wires);
  const profile = captureKnowledgeModelProfile(context, PROD);
  await generateWithOpenAi(knowledge(profile, 'extraction'));
  const result = await generateWithOpenAi(knowledge(profile, 'verification'));
  assert.deepEqual(wires.map(w => [w.model, w.reasoning?.effort, w.text.format.name, w.max_output_tokens, w.service_tier]), [
    [SOL, 'low', 'odinlink_knowledge_extraction_v2', 8192, 'default'],
    [SOL, 'low', 'odinlink_knowledge_source_exhaustive_v2', 8192, 'default']]);
  assert.deepEqual(wires[1].text.format, { type: 'json_schema', ...knowledgeStructuredOutput('verification', false, undefined, 6, 'source-exhaustive-v2') });
  assert.deepEqual(owner.events, ['reserve', 'settle', 'reserve', 'settle']);
  assert.deepEqual([...owner.reservations.values()].map(r => r.quote.stage), ['extraction', 'verification']);
  assert.equal(result.knowledgeUsage?.model, SOL);
});

test('incompatibility reproduced: the pre-fix adapter omitted low effort on the source-exhaustive schema -> wire_model, no dispatch', async () => {
  const profile = captureKnowledgeModelProfile(context, PROD);
  const request = knowledge(profile, 'verification');
  // Exactly what the previous adapter built: reasoning was only added for the
  // 'odinlink_knowledge_verification_v2' name, never for source-exhaustive-v2.
  const preFixParams = { model: SOL, instructions: request.systemInstruction, input: [{ role: 'user', content: request.messages[0].content }],
    text: { format: { type: 'json_schema', ...request.structuredOutput } } };
  let sent = 0;
  await assert.rejects(executeKnowledgeGeneration(request, preFixParams, async () => { sent++; return {}; }), /knowledge_sol_wire_model/u);
  assert.equal(sent, 0);
});

test('verifier schema must equal the CAPTURED protocol; no other contract is accepted on Sol', async t => {
  const wires: any[] = []; capture(t, wires);
  let n = 0;
  for (const protocol of ['v2', 'compact-v1', 'coverage-witness-v1']) {
    const turn = { ...binding, turnId: 'p-' + protocol, requestKey: String(++n).repeat(64) };
    const profile = captureKnowledgeModelProfile({ ...context, ...turn }, PROD);
    await generateWithOpenAi(knowledge(profile, 'extraction', {}, 'source-exhaustive-v2', turn));
    await assert.rejects(generateWithOpenAi(knowledge(profile, 'verification', {}, protocol, turn)), /strict_schema/u, protocol);
  }
  assert.deepEqual(wires.map(w => w.text.format.name), Array(3).fill('odinlink_knowledge_extraction_v2'), 'no mismatched verifier reached the network');
  // A captured v2 verifier (legacy contract) remains valid on Sol.
  const turn = { ...binding, turnId: 'v2-turn', requestKey: 'd'.repeat(64) };
  const v2 = captureKnowledgeModelProfile({ ...context, ...turn, verificationProtocol: 'v2' }, PROD);
  await generateWithOpenAi(knowledge(v2, 'extraction', {}, 'v2', turn));
  await generateWithOpenAi(knowledge(v2, 'verification', {}, 'v2', turn));
  assert.deepEqual([wires.at(-1).model, wires.at(-1).text.format.name], [SOL, 'odinlink_knowledge_verification_v2']);
});

test('one-shot re-extraction is preserved with its own permit, reservation and citation-bound schema', async t => {
  const wires: any[] = []; capture(t, wires);
  const profile = captureKnowledgeModelProfile(context, PROD);
  const admission = { profile, businessId: 77, mode: 'production' as const, generationRemainingMs: 30000, attempts: 1, maxAttempts: 4, env: PROD };
  assert.equal(reExtractionAdmission(admission), 'permit_unavailable');
  await generateWithOpenAi(knowledge(profile, 'extraction'));
  assert.equal(knowledgeReExtractionAvailable(profile), true);
  assert.equal(reExtractionAdmission(admission), null);
  assert.equal(reExtractionAdmission({ ...admission, env: { ODINLINK_AI_DEFAULT_MODEL: LUNA } }), 'flag_disabled');
  assert.equal(reExtractionAdmission({ ...admission, attempts: 3 }), 'attempts');
  // Wrong (verification) schema on the re-extraction permit fails closed before reserving.
  await assert.rejects(generateWithOpenAi(knowledge(profile, 're_extraction', { structuredOutput: knowledgeStructuredOutput('verification', false, undefined, 6, 'source-exhaustive-v2') })), /strict_schema|bounded_extraction/u);
  assert.equal(knowledgeReExtractionAvailable(profile), false, 'a failed stage closes the turn; no second attempt');
  const freshBinding = { ...binding, turnId: 'fresh', requestKey: 'e'.repeat(64) };
  const fresh = captureKnowledgeModelProfile({ ...context, ...freshBinding }, PROD);
  await generateWithOpenAi(knowledge(fresh, 'extraction', {}, 'source-exhaustive-v2', freshBinding));
  await generateWithOpenAi(knowledge(fresh, 're_extraction', {}, 'source-exhaustive-v2', freshBinding));
  assert.throws(() => knowledgeStageOptions(fresh, 're_extraction', freshBinding, Date.now() + 19000), /stage_already_closed/u);
  assert.deepEqual([...owner.reservations.values()].filter(r => r.quote.requestKey === freshBinding.requestKey).map(r => r.quote.stage),
    ['extraction', 're_extraction']);
  assert.deepEqual(wires.slice(-2).map(w => [w.model, w.text.format.name]), [[SOL, 'odinlink_knowledge_extraction_v2'], [SOL, 'odinlink_knowledge_extraction_v2']]);
});

test('Sol stage failure fails closed: hold retained, no Luna retry, no verifier rescue', async t => {
  quiet(t); const wires: any[] = [];
  capture(t, wires, () => { throw new Error('synthetic provider outage'); });
  const profile = captureKnowledgeModelProfile(context, PROD);
  await assert.rejects(generateWithOpenAi(knowledge(profile, 'extraction')));
  assert.equal(wires.length, 1);
  assert.ok(owner.events.includes('retainUnknown'));
  assert.throws(() => knowledgeStageOptions(profile, 'verification', binding, Date.now() + 19000), /stage_already_closed/u);
});

test('pre-turn fallback reasons: owner unavailable, tenant not entitled, source check missing, ineligible scope', () => {
  configureKnowledgeBudgetOwner();
  assert.deepEqual(captureKnowledgeModelProfile(context, PROD), { id: 'default', managedFallback: 'budget_owner_unavailable' });
  owner.businessIds = [88]; configureKnowledgeBudgetOwner(owner);
  assert.deepEqual(captureKnowledgeModelProfile(context, PROD), { id: 'default', managedFallback: 'budget_owner_tenant' });
  owner.businessIds = [77]; configureKnowledgeBudgetOwner(owner);
  assert.deepEqual(captureKnowledgeModelProfile({ ...context, current: undefined }, PROD), { id: 'default', managedFallback: 'source_check_unavailable' });
  for (const change of [{ durable: true }, { natural: true }, { nativeForeground: false }, { operational: true }, { documentary: false },
    { extractionProtocol: 'literal-evidence-v1' }, { verificationProtocol: 'compact-v1' }, { verificationProtocol: 'coverage-witness-v1' }, { provider: 'gemini' }])
    assert.deepEqual(captureKnowledgeModelProfile({ ...context, ...change }, PROD), { id: 'default', managedFallback: 'scope_ineligible' }, JSON.stringify(change));
  const fallback = captureKnowledgeModelProfile({ ...context, durable: true }, PROD);
  assert.deepEqual(knowledgeStageOptions(fallback, 'extraction', binding, Date.now() + 19000), {});
  assert.equal(resolveOpenAiTextModel(undefined, { routingStage: 'knowledge_extraction' }), LUNA);
});

test('rollback to Luna through configuration: identical default profile and Luna on every stage', async t => {
  const wires: any[] = []; capture(t, wires);
  const rollback = { ODINLINK_AI_DEFAULT_MODEL: LUNA };
  Object.assign(process.env, rollback);
  const profile = captureKnowledgeModelProfile(context, rollback);
  assert.equal(profile, captureKnowledgeModelProfile(context, {}), 'the same frozen default object as before routing');
  await generateWithConfiguredProvider({ tools: bookingTools, messages: [{ role: 'user', content: 'boka' }] });
  await generateWithOpenAi(knowledge(profile, 'verification'));
  assert.deepEqual(wires.map(w => w.model), [LUNA, LUNA]);
  delete process.env.ODINLINK_AI_DEFAULT_MODEL;
  await generateWithConfiguredProvider({ messages: [{ role: 'user', content: 'boka' }] });
  assert.equal(wires.at(-1).model, LUNA, 'unset = the previous OPENAI_MODEL || Luna resolver');
});

test('a turn captured on Sol drains on Sol after rollback; new turns are Luna', async t => {
  const wires: any[] = []; capture(t, wires);
  const profile = captureKnowledgeModelProfile(context, PROD);
  await generateWithOpenAi(knowledge(profile, 'extraction'));
  process.env.ODINLINK_AI_DEFAULT_MODEL = LUNA;
  await generateWithOpenAi(knowledge(profile, 'verification'));
  assert.equal(captureKnowledgeModelProfile({ ...context, turnId: 'after-rollback' }, { ODINLINK_AI_DEFAULT_MODEL: LUNA }).id, 'default');
  assert.deepEqual(wires.map(w => w.model), [SOL, SOL]);
});
