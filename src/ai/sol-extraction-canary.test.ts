/** Mock SDK + scripted owner protocol controls (NOT durable accounting proof;
 * the real-DB invariants are in re-extraction-stage-migration.test.ts). */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateWithOpenAi } from './providers/openai';
import { knowledgeStructuredOutput } from './knowledge-answer-protocol';
import { captureKnowledgeModelProfile, captureSolExtractionShadow, configureKnowledgeBudgetOwner, knowledgeReExtractionAvailable,
  knowledgeStageOptions, solExtractionMode, solExtractionEligible, KNOWLEDGE_SOL_EXTRACTION_PROFILE, type KnowledgeModelProfile } from './knowledge-model-policy';
import { emitSolCanaryTelemetry, reExtractionAdmission, runSolExtractionShadow, SOL_REEXTRACTION_MIN_MS, type SolCanaryTelemetry } from './sol-extraction-canary';
import type { UnifiedAiGenerationRequest } from './providers/provider';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';
import { parseRequestedFacets, type Evidence } from './business-information-answer-plan';

const binding = { businessId: 77, turnId: 'canary-turn', requestKey: 'b'.repeat(64) };
const ACTIVE = { ODINLINK_SOL_EXTRACTION_MODE: 'active', ODINLINK_SOL_EXTRACTION_TENANT_IDS: '77' };
const context = { ...binding, provider: 'openai', nativeForeground: true, natural: false, durable: false,
  extractionProtocol: 'v2', verificationProtocol: 'source-exhaustive-v2', documentary: true, operational: false, current: async () => true };
let owner: ScriptedKnowledgeBudgetOwner;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => { savedEnv = { ...process.env }; process.env.OPENAI_API_KEY = 'synthetic-offline-only'; delete process.env.OPENAI_BASE_URL;
  delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; owner = new ScriptedKnowledgeBudgetOwner(); configureKnowledgeBudgetOwner(owner); });
afterEach(() => { configureKnowledgeBudgetOwner(); for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });

const evidence = [{ id: 'e1', businessId: 77, text: 'Source text.' }];
function request(profile: KnowledgeModelProfile, stage: 'extraction' | 're_extraction' | 'verification', deadlineAt = Date.now() + 19000,
  over: Partial<UnifiedAiGenerationRequest> = {}): UnifiedAiGenerationRequest {
  const schemaStage = stage === 'verification' ? 'verification' : 'extraction';
  return { ...knowledgeStageOptions(profile, stage, binding, deadlineAt), signal: new AbortController().signal,
    systemInstruction: 'OdinLink UNIT EXTRACTION' + (stage === 're_extraction' ? '\nRE-EXTRACTION' : ''),
    messages: [{ role: 'user', content: JSON.stringify({ question: 'q', requestedLanguage: 'fa', evidence }) }],
    structuredOutput: knowledgeStructuredOutput(schemaStage, false, schemaStage === 'extraction' ? ['f1'] : undefined, 6, 'v2'), ...over };
}
const raw = (id = 'resp_one') => ({ id, object: 'response', model: 'gpt-6.1-sol', status: 'completed', service_tier: 'default', reasoning: { effort: 'low' },
  prompt_cache_options: { mode: 'implicit', ttl: '30m' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"units":[]}' }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 }, output_tokens_details: { reasoning_tokens: 5 } } });
const ok = (t: any, wires: any[] = []) => t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  wires.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(raw('resp_' + wires.length)), { headers: { 'Content-Type': 'application/json' } }); });

test('flags: default OFF; strict tenant allowlist; legacy managed profile always wins', () => {
  assert.equal(solExtractionMode(77, {}), 'off');
  for (const mode of ['on', 'ACTIVE', 'true', '', 'shadow ']) assert.equal(solExtractionMode(77, { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: mode }), 'off');
  for (const ids of ['', '77,', ' x', '077', '-77', '1,2,3,4,5,6,7,8,9,10,77', '9007199254740993']) assert.equal(solExtractionMode(77, { ...ACTIVE, ODINLINK_SOL_EXTRACTION_TENANT_IDS: ids }), 'off', ids);
  assert.equal(solExtractionMode(77, ACTIVE), 'active');
  assert.equal(solExtractionMode(78, ACTIVE), 'off');
  assert.equal(solExtractionMode(77, { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: 'shadow', ODINLINK_SOL_EXTRACTION_TENANT_IDS: '3, 77' }), 'shadow');
  assert.equal(solExtractionMode(77, { ...ACTIVE, ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'sol-low-v1' }), 'off');
  assert.equal(solExtractionMode(77, { ...ACTIVE, ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off' }), 'active');
});

test('OFF and shadow capture the exact unchanged default profile', () => {
  const off = captureKnowledgeModelProfile(context, {});
  assert.deepEqual(off, { id: 'default' });
  assert.equal(off, captureKnowledgeModelProfile({ ...context, verificationProtocol: 'v2' }, {}), 'same frozen default object');
  assert.deepEqual(captureKnowledgeModelProfile(context, { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: 'shadow' }), { id: 'default' });
  assert.deepEqual(knowledgeStageOptions(off, 'extraction', binding, Date.now() + 1000), {});
});

test('eligibility: customer-facing native documentary source-exhaustive turns only', () => {
  assert.equal(solExtractionEligible(context), true);
  for (const change of [{ provider: 'gemini' }, { nativeForeground: false }, { natural: true }, { durable: true }, { documentary: false },
    { operational: true }, { extractionProtocol: 'literal-evidence-v1' }, { verificationProtocol: 'v2' }, { verificationProtocol: 'coverage-witness-v1' }]) {
    assert.equal(solExtractionEligible({ ...context, ...change }), false, JSON.stringify(change));
    assert.deepEqual(captureKnowledgeModelProfile({ ...context, ...change }, ACTIVE), { id: 'default' }, JSON.stringify(change));
  }
});

test('pre-turn Luna fallback when the budget owner is unavailable, foreign or the source check is missing', () => {
  configureKnowledgeBudgetOwner();
  assert.deepEqual(captureKnowledgeModelProfile(context, ACTIVE), { id: 'default', canaryFallback: 'budget_owner_unavailable' });
  owner.businessIds = [88]; configureKnowledgeBudgetOwner(owner);
  assert.deepEqual(captureKnowledgeModelProfile(context, ACTIVE), { id: 'default', canaryFallback: 'budget_owner_tenant' });
  owner.businessIds = [77]; configureKnowledgeBudgetOwner(owner);
  const { current: _current, ...noCurrent } = context;
  assert.deepEqual(captureKnowledgeModelProfile(noCurrent, ACTIVE), { id: 'default', canaryFallback: 'source_check_unavailable' });
  assert.deepEqual(captureKnowledgeModelProfile({ ...context, requestKey: 'short' }, ACTIVE), { id: 'default', canaryFallback: 'turn_binding' });
  assert.equal(captureKnowledgeModelProfile(context, ACTIVE).id, KNOWLEDGE_SOL_EXTRACTION_PROFILE);
});

test('extraction-only profile: verification and composition stay on Luna; Sol permits are stage-bound', () => {
  const profile = captureKnowledgeModelProfile(context, ACTIVE);
  assert.deepEqual(knowledgeStageOptions(profile, 'verification', binding, Date.now() + 1000), {});
  assert.deepEqual(knowledgeStageOptions(profile, 'composition', binding, Date.now() + 1000), {});
  assert.throws(() => knowledgeStageOptions(profile, 're_extraction', binding, Date.now() + 1000), /re_extraction_without_extraction/u);
  assert.throws(() => knowledgeStageOptions(profile, 'extraction', { ...binding, turnId: 'other' }, Date.now() + 1000), /turn_binding/u);
  const options = knowledgeStageOptions(profile, 'extraction', binding, Date.now() + 1000);
  assert.equal(options.model, 'gpt-6.1-sol');
  assert.deepEqual(options.knowledgeExecution, { profile: 'sol-extraction-v1', stage: 'extraction' });
  assert.throws(() => knowledgeStageOptions(profile, 'extraction', binding, Date.now() + 1000), /stage_already_closed/u);
});

test('legacy sol-low-v1 never receives a re_extraction permit', () => {
  const legacy = captureKnowledgeModelProfile({ ...context, verificationProtocol: 'v2' }, { ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'sol-low-v1', ODINLINK_KNOWLEDGE_SOL_TENANT_IDS: '77' });
  assert.equal(legacy.id, 'sol-low-v1');
  assert.throws(() => knowledgeStageOptions(legacy, 're_extraction', binding, Date.now() + 1000), /stage_unsupported/u);
});

test('extraction then exactly one re_extraction: own permits, reservations and settlements', async t => {
  const wires: any[] = []; ok(t, wires);
  const profile = captureKnowledgeModelProfile(context, ACTIVE);
  assert.equal(knowledgeReExtractionAvailable(profile), false);
  await generateWithOpenAi(request(profile, 'extraction'));
  assert.equal(knowledgeReExtractionAvailable(profile), true);
  const result = await generateWithOpenAi(request(profile, 're_extraction'));
  assert.equal(result.knowledgeUsage?.estimatedNanoUsd, 40 * 2000 + 10 * 100 + 50 * 2500 + 20 * 10000);
  assert.deepEqual(owner.events, ['reserve', 'settle', 'reserve', 'settle']);
  const quotes = [...owner.reservations.values()].map(r => r.quote);
  assert.deepEqual(quotes.map(q => q.stage), ['extraction', 're_extraction']);
  assert.equal(new Set(quotes.map(q => q.reservationKey)).size, 2);
  assert.ok(quotes.every(q => q.requestKey === binding.requestKey && q.businessId === 77 && q.turnId === binding.turnId), 'same message: same per-turn cap');
  assert.deepEqual(wires.map(w => [w.model, w.reasoning?.effort, w.text.format.name]), [['gpt-6.1-sol', 'low', 'odinlink_knowledge_extraction_v2'], ['gpt-6.1-sol', 'low', 'odinlink_knowledge_extraction_v2']]);
  assert.equal(knowledgeReExtractionAvailable(profile), false);
  assert.throws(() => knowledgeStageOptions(profile, 're_extraction', binding, Date.now() + 1000), /stage_already_closed/u);
});

test('the per-message turn cap covers extraction + re_extraction (owner denial means no dispatch)', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(raw('resp_' + calls)), { headers: { 'Content-Type': 'application/json' } }); });
  const profile = captureKnowledgeModelProfile(context, ACTIVE);
  await generateWithOpenAi(request(profile, 'extraction'));
  const first = [...owner.reservations.values()][0];
  // The scripted owner re-reads its cap at every reserve, like the durable owner.
  owner.maximumTurnNanoUsd = (first.cost ?? 0) + first.quote.maximumNanoUsd - 1;
  await assert.rejects(generateWithOpenAi(request(profile, 're_extraction')), /reservation_denied/u);
  assert.equal(calls, 1);
});

for (const failure of ['provider', 'receipt', 'source', 'deny'] as const) {
  test(`fail closed after ${failure} failure: hold retained, no re_extraction, no Luna switch`, async t => {
    const profile = captureKnowledgeModelProfile({ ...context, current: async () => failure !== 'source' }, ACTIVE);
    let calls = 0;
    if (failure === 'deny') owner.mode = 'deny';
    t.mock.method(globalThis, 'fetch', async () => { calls++;
      if (failure === 'provider') throw new Error('synthetic provider failure');
      const bad = raw(); if (failure === 'receipt') bad.service_tier = 'priority';
      return new Response(JSON.stringify(bad), { headers: { 'Content-Type': 'application/json' } }); });
    await assert.rejects(generateWithOpenAi(request(profile, 'extraction')));
    assert.equal(calls, failure === 'source' || failure === 'deny' ? 0 : 1);
    if (failure !== 'deny') assert.ok(owner.events.includes('retainUnknown'));
    assert.equal(owner.events.includes('settle'), false);
    assert.equal(knowledgeReExtractionAvailable(profile), false);
    assert.throws(() => knowledgeStageOptions(profile, 're_extraction', binding, Date.now() + 1000), /stage_already_closed|re_extraction_without/u);
    // Verification stays the unchanged default model; it never becomes a Sol fallback.
    assert.deepEqual(knowledgeStageOptions(profile, 'verification', binding, Date.now() + 1000), {});
  });
}

test('re_extraction permit rejects a verification schema, foreign evidence and forged permits', async t => {
  ok(t);
  const profile = captureKnowledgeModelProfile(context, ACTIVE);
  await generateWithOpenAi(request(profile, 'extraction'));
  const wrong = request(profile, 're_extraction', Date.now() + 19000, { structuredOutput: knowledgeStructuredOutput('verification', false, undefined, 6, 'v2') });
  await assert.rejects(generateWithOpenAi(wrong), /strict_schema|bounded_extraction/u);
  const forged = request(captureKnowledgeModelProfile(context, ACTIVE), 'extraction');
  forged.knowledgeExecution = { profile: 'sol-extraction-v1', stage: 're_extraction' };
  await assert.rejects(generateWithOpenAi(forged), /unowned/u);
  const before = owner.events.length;
  const profile2 = captureKnowledgeModelProfile(context, ACTIVE);
  const foreign = { ...request(profile2, 'extraction'), messages: [{ role: 'user' as const, content: JSON.stringify({ evidence: [{ id: 'e1', businessId: 88, text: 'x' }] }) }] };
  await assert.rejects(generateWithOpenAi(foreign), /evidence_tenant/u);
  assert.equal(owner.events.length, before, 'foreign evidence is refused before any reservation');
});

test('host admission: flag flip, missing permit, time window and attempt reserve', () => {
  const profile = captureKnowledgeModelProfile(context, ACTIVE);
  const base = { profile, businessId: 77, mode: 'active' as const, generationRemainingMs: 30000, attempts: 1, maxAttempts: 4, env: ACTIVE };
  assert.equal(reExtractionAdmission(base), 'permit_unavailable');
  assert.equal(reExtractionAdmission({ ...base, env: {} }), 'flag_disabled');
  assert.equal(reExtractionAdmission({ ...base, env: { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: 'shadow' } }), 'flag_disabled');
  assert.ok(SOL_REEXTRACTION_MIN_MS >= 8000);
});

test('telemetry is content-free: closed vocabularies only', () => {
  const lines: string[] = [];
  const secret = 'من اولین باره SECRET-QUOTE 46700000001';
  emitSolCanaryTelemetry({ schema: 'sol-extraction-canary-v1', mode: 'active', businessId: 3, channel: secret, language: secret, profile: 'sol-extraction-v1',
    stages: [{ stage: 'extraction', model: 'sol', durationMs: 1, ok: true, costNanoUsd: 5 }], extractionReasons: { NUMERICAL_CONSTRAINT: 1 },
    publication: 'published', elapsedMs: 2 } as SolCanaryTelemetry, (_label, payload) => lines.push(payload));
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /SECRET|46700000001|اولین/u);
  assert.match(lines[0], /"channel":"other"/u); assert.match(lines[0], /"language":"und"/u);
});

const FACETS = parseRequestedFacets([{ subject: 'first-time visitors', attribute: 'arrival timing', questionType: 'recommendation' }]).facets;
const shadowEvidence: Evidence[] = [{ id: 'e1', businessId: 77, sourceId: 'doc-1', chunkId: 'c1', version: 'v1',
  text: 'First-time visitors are recommended to arrive about 10 minutes before their booked appointment.' } as Evidence];
async function shadow(t: any, env: NodeJS.ProcessEnv, script: (stage: string, data: any) => unknown, over: Record<string, unknown> = {}) {
  const requests: UnifiedAiGenerationRequest[] = [], emitted: SolCanaryTelemetry[] = [];
  const telemetry = await runSolExtractionShadow({ binding, businessId: 77, channel: 'whatsapp', question: 'How early should I arrive for my first visit?',
    language: 'en', facets: FACETS, evidence: shadowEvidence, history: [], businessTone: {}, current: async () => true, provider: 'openai', env,
    emit: e => emitted.push(e),
    generate: async r => { requests.push(r); return generateWithOpenAi(r); }, ...over });
  void t; return { telemetry, requests, emitted };
}
test('shadow: OFF/active never run the shadow; shadow replays extraction on Sol, never verifies or publishes', async t => {
  const wires: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); wires.push(body);
    const data = JSON.parse(body.input[0].content);
    const unit = { subject: 'first-time visitors', predicate: 'arrival timing', value: 'arrival', modality: 'recommended', negation: false, scope: 'first visit',
      qualifiers: [], language: 'en', text: 'First-time visitors should arrive about 10 minutes before the appointment.', facetIds: [data.facets[0].id],
      evidenceRefs: [{ evidenceId: 'e1', exactQuote: shadowEvidence[0].text }] };
    const r = raw('resp_' + wires.length); (r.output[0].content[0] as any).text = JSON.stringify({ oversized: false, units: [unit] });
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } }); });
  assert.equal((await shadow(t, {}, () => null)).telemetry, undefined);
  assert.equal((await shadow(t, ACTIVE, () => null)).telemetry, undefined);
  const s = await shadow(t, { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: 'shadow' }, () => null);
  assert.equal(s.telemetry?.publication, 'never_published');
  assert.equal(s.telemetry?.profile, 'sol-extraction-v1');
  assert.equal(s.telemetry?.shadowReachedVerification, true);
  assert.deepEqual(wires.map(w => w.model), ['gpt-6.1-sol'], 'one Sol extraction; NO verification request');
  assert.deepEqual(owner.events, ['reserve', 'settle']);
  assert.equal([...owner.reservations.values()][0].quote.turnId, binding.turnId);
  assert.equal(s.emitted.length, 1);
});
test('shadow: owner unavailable, foreign or configured evidence -> no Sol request', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('forbidden'); });
  const SHADOW = { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: 'shadow' };
  configureKnowledgeBudgetOwner();
  assert.equal((await shadow(t, SHADOW, () => null)).telemetry?.fallbackReason, 'budget_owner_unavailable');
  configureKnowledgeBudgetOwner(owner);
  assert.equal((await shadow(t, SHADOW, () => null, { evidence: [{ ...shadowEvidence[0], businessId: 88 }] })).telemetry?.fallbackReason, 'shadow_out_of_scope');
  assert.equal((await shadow(t, SHADOW, () => null, { evidence: [{ ...shadowEvidence[0], id: 'configured-services' }] })).telemetry?.fallbackReason, 'shadow_out_of_scope');
  assert.equal(calls, 0);
});
test('shadow: a stale source after reservation sends nothing and keeps the hold', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('forbidden'); });
  let reads = 0;
  const s = await shadow(t, { ...ACTIVE, ODINLINK_SOL_EXTRACTION_MODE: 'shadow' }, () => null, { current: async () => (++reads, !owner.events.includes('reserve')) });
  assert.ok(owner.events.includes('retainUnknown'));
  assert.equal(calls, 0);
  assert.equal(s.telemetry?.publication, 'never_published');
});
