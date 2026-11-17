/** Tier B model routing, pricing, adapter admission and ledger adapters.
 * Offline only: the OpenAI SDK create() is mocked, ledgers live in a temp dir,
 * no credential is real and nothing is dispatched to a provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Responses } from 'openai/resources/responses';
import { BASELINE_MODEL, routeDefaultModel, routeNaturalComposerModels } from './model-routing';
import { consumeNaturalAdmission, experimentLedgerNaturalBudget, mintNaturalAdmission, NATURAL_COMPOSER_BUDGET_LIMITS, NATURAL_COMPOSER_RATE_CARDS,
  quoteNaturalRequest, serverNaturalComposerBudget, type NaturalQuote } from './natural-composer-budget';
import { generateWithOpenAi } from './providers/openai';
import { ExperimentLedger, pinsFromCurrent } from '../../scripts/experiment-accounting';

const SOL = 'gpt-6.1-sol', LUNA = 'gpt-5.6-luna';

test('routing: Tier B defaults to a Sol composer and a distinct Luna validator; explicit Luna allowed', () => {
  assert.deepEqual(routeNaturalComposerModels({}), { ok: true, composer: SOL, validator: LUNA, provider: 'openai', validatorIndependence: 'distinct_model' });
  assert.deepEqual(routeNaturalComposerModels({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_MODEL: LUNA }),
    { ok: true, composer: LUNA, validator: SOL, provider: 'openai', validatorIndependence: 'distinct_model' });
  assert.deepEqual(routeNaturalComposerModels({ ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_MODEL: ` ${SOL} `, ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_MODEL: LUNA }),
    { ok: true, composer: SOL, validator: LUNA, provider: 'openai', validatorIndependence: 'distinct_model' });
  // Tier B does not follow the conversation default model in either direction.
  for (const def of [SOL, LUNA]) assert.equal((routeNaturalComposerModels({ ODINLINK_AI_DEFAULT_MODEL: def, OPENAI_MODEL: LUNA }) as any).composer, SOL);
});

test('routing: unknown/unsupported models, wrong provider and same-model validation fail closed (no fallback)', () => {
  for (const value of ['', '  ', 'gpt-5.6-terra', 'gemini-2.5-flash', 'gpt-4o-mini', 'GPT-6.1-SOL', 'gpt-6.1-sol;drop'])
    for (const key of ['ODINLINK_KNOWLEDGE_NATURAL_COMPOSER_MODEL', 'ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_MODEL'])
      assert.deepEqual(routeNaturalComposerModels({ [key]: value }), { ok: false, reason: 'MODEL_NOT_APPROVED' }, `${key}=${value}`);
  assert.deepEqual(routeNaturalComposerModels({ AI_PROVIDER: 'gemini' }), { ok: false, reason: 'PROVIDER_UNSUPPORTED' });
  assert.deepEqual(routeNaturalComposerModels({ ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_MODEL: SOL }), { ok: false, reason: 'VALIDATOR_NOT_INDEPENDENT' });
  assert.deepEqual(routeNaturalComposerModels({ ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_MODEL: SOL, ODINLINK_KNOWLEDGE_NATURAL_VALIDATOR_ALLOW_SAME_MODEL: 'yes' }),
    { ok: false, reason: 'VALIDATOR_NOT_INDEPENDENT' });
  for (const stage of ['knowledge_natural_composition', 'knowledge_natural_validation'] as const)
    assert.throws(() => routeDefaultModel(stage, false, { ODINLINK_AI_DEFAULT_MODEL: SOL }), /reserved_stage_requires_explicit_model/u);
});

test('routing: every existing stage is unchanged under the verified Render configuration', () => {
  const env = { ODINLINK_AI_DEFAULT_MODEL: SOL, OPENAI_MODEL: LUNA, AI_PROVIDER: 'openai' };
  assert.deepEqual(routeDefaultModel('general', false, env), { model: SOL, stage: 'general', selected: SOL });
  assert.deepEqual(routeDefaultModel('knowledge_planning', false, env), { model: BASELINE_MODEL, stage: 'knowledge_planning', selected: SOL, fallbackReason: 'latency_budget' });
  for (const stage of ['knowledge_extraction', 'knowledge_re_extraction', 'knowledge_verification'] as const) {
    assert.deepEqual(routeDefaultModel(stage, false, env), { model: BASELINE_MODEL, stage, selected: SOL, fallbackReason: 'financial_control_unavailable' });
    assert.deepEqual(routeDefaultModel(stage, true, env), { model: SOL, stage, selected: SOL });
  }
  assert.deepEqual(routeDefaultModel('general', false, {}), { model: LUNA, stage: 'general', selected: LUNA });
});

const request = (role: 'composer' | 'validator', model: string, bytes = 2000) => ({
  model, tools: [], reasoningEffort: 'low' as const, systemInstruction: 'x'.repeat(bytes), messages: [{ role: 'user', content: '{}' }],
  structuredOutput: { name: role === 'composer' ? 'odinlink_tierb_composer_v1' : 'odinlink_natural_validation_v1', schema: {}, strict: true },
  routingStage: role === 'composer' ? 'knowledge_natural_composition' as const : 'knowledge_natural_validation' as const,
  maxOutputTokens: NATURAL_COMPOSER_BUDGET_LIMITS[role].maxOutputTokens });
const quote = (role: 'composer' | 'validator', model: string, bytes?: number) => {
  const q = quoteNaturalRequest({ request: request(role, model, bytes), role, turnId: 't', businessId: 3 });
  assert.ok(q.ok, JSON.stringify(q)); return (q as any).quote as NaturalQuote;
};

test('pricing: conservative worst case per request, explicit output (incl. reasoning) bound, within USD 0.15', () => {
  const worst: Record<string, number> = {};
  for (const role of ['composer', 'validator'] as const) for (const model of [SOL, LUNA]) {
    const max = NATURAL_COMPOSER_BUDGET_LIMITS[role].maxRequestBytes;
    // Find the largest request that still fits the byte bound.
    let lo = 0, hi = max;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); quoteNaturalRequest({ request: request(role, model, mid), role, turnId: 't', businessId: 3 }).ok ? lo = mid : hi = mid - 1; }
    const q = quote(role, model, lo), card = NATURAL_COMPOSER_RATE_CARDS[model];
    assert.ok(q.requestBytes <= max && q.requestBytes > max - 8);
    assert.equal(q.ceilingNanoUsd, (q.requestBytes + 4096) * Math.max(card.inputNanoPerToken, card.cacheWriteNanoPerToken) + q.maxOutputTokens * card.outputNanoPerToken);
    assert.ok(q.ceilingNanoUsd <= NATURAL_COMPOSER_BUDGET_LIMITS.perRequestNanoUsd);
    worst[`${role}/${model}`] = q.ceilingNanoUsd;
  }
  // Pinned so any change to bounds/rates is a reviewed diff (nanoUSD).
  assert.deepEqual(worst, { [`composer/${SOL}`]: 70_240_000, [`composer/${LUNA}`]: 7_424_000, [`validator/${SOL}`]: 82_240_000, [`validator/${LUNA}`]: 8_464_000 });
  const tooBig = quoteNaturalRequest({ request: request('composer', SOL, 16_001), role: 'composer', turnId: 't', businessId: 3 });
  assert.deepEqual(tooBig, { ok: false, reason: 'REQUEST_TOO_LARGE' });
  assert.deepEqual(quoteNaturalRequest({ request: { ...request('composer', SOL), maxOutputTokens: undefined }, role: 'composer', turnId: 't', businessId: 3 }), { ok: false, reason: 'REQUEST_UNBOUNDED' });
  assert.deepEqual(quoteNaturalRequest({ request: request('composer', 'gpt-5.6-terra'), role: 'composer', turnId: 't', businessId: 3 }), { ok: false, reason: 'RATE_CARD_MISSING' });
});

test('server: no durable cross-instance Tier B account is authorised => no budget (fail closed)', () => {
  assert.deepEqual(serverNaturalComposerBudget(), { reason: 'DURABLE_TIERB_ACCOUNT_UNAVAILABLE' });
});

// --- OpenAI adapter: bound + bypass prevention (SDK create() mocked) -------
const saved = { ...process.env };
test.beforeEach(() => { process.env.OPENAI_API_KEY = 'sk-offline-tierb-test'; process.env.AI_PROVIDER = 'openai'; delete process.env.OPENAI_BASE_URL; });
test.afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
const ok = { output_text: '{}', output: [], usage: { input_tokens: 10, output_tokens: 5 } } as any;

test('adapter: Tier B stage without admission never reaches the SDK', async t => {
  const create = t.mock.method(Responses.prototype, 'create', async () => ok);
  await assert.rejects(generateWithOpenAi(request('composer', SOL) as any), /tierb_unreserved_dispatch/u);
  await assert.rejects(generateWithOpenAi({ ...request('validator', LUNA), naturalComposerAdmission: { kind: 'tierb-admission', requestId: 'forged', reservationId: 'x' } } as any),
    /tierb_unreserved_dispatch/u);
  assert.equal(create.mock.callCount(), 0);
});

test('adapter: admitted request dispatches once with max_output_tokens; reuse, tampering and model swap are refused', async t => {
  const params: any[] = [];
  const create = t.mock.method(Responses.prototype, 'create', async (p: any) => { params.push(p); return ok; });
  const q = quote('composer', SOL), admission = mintNaturalAdmission(q, q.requestId);
  const admitted = { ...request('composer', SOL), naturalComposerAdmission: admission } as any;
  await generateWithOpenAi(admitted);
  assert.equal(params[0].max_output_tokens, 2000);
  assert.equal(params[0].model, SOL);
  await assert.rejects(generateWithOpenAi(admitted), /tierb_admission_reused/u, 'single use: no retry/replay');
  const q2 = quote('composer', SOL);
  await assert.rejects(generateWithOpenAi({ ...request('composer', SOL, 2001), naturalComposerAdmission: mintNaturalAdmission(q2, 'r') } as any), /tierb_admission_mismatch/u);
  const q3 = quote('composer', SOL);
  await assert.rejects(generateWithOpenAi({ ...request('composer', LUNA), naturalComposerAdmission: mintNaturalAdmission(q3, 'r') } as any), /tierb_admission_mismatch/u, 'no silent model swap');
  assert.equal(create.mock.callCount(), 1);
});

test('adapter: requests without maxOutputTokens are unchanged; invalid bounds are refused', async t => {
  const params: any[] = [];
  t.mock.method(Responses.prototype, 'create', async (p: any) => { params.push(p); return ok; });
  await generateWithOpenAi({ model: LUNA, messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(!Object.hasOwn(params[0], 'max_output_tokens'));
  await generateWithOpenAi({ model: LUNA, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 77 });
  assert.equal(params[1].max_output_tokens, 77);
  for (const bad of [0, -1, 1.5, Number.NaN]) await assert.rejects(generateWithOpenAi({ model: LUNA, messages: [], maxOutputTokens: bad }), /invalid_max_output_tokens/u);
  assert.equal(params.length, 2);
});

test('admission: consume binds to the exact priced request', () => {
  const q = quote('validator', LUNA), a = mintNaturalAdmission(q, 'r');
  assert.throws(() => consumeNaturalAdmission({ ...request('validator', LUNA), naturalComposerAdmission: a, tools: [{}] } as any), /tierb_admission_mismatch/u);
  assert.equal(consumeNaturalAdmission({ ...request('validator', LUNA), naturalComposerAdmission: a } as any).requestId, q.requestId);
});

// --- Experimental ledger adapter (offline; real ExperimentLedger, temp files) ---
function tempLedger(historicalCarryUsd = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'tierb-ledger-')), path = join(dir, 'source-aware-usage.json');
  writeFileSync(path, JSON.stringify({ calls: [{ case: 'historical', estimatedUsd: 0.5 }], estimatedUsd: 0.5, unmeteredReserveUsd: 0 }, null, 2));
  const open = (carry = historicalCarryUsd) => new ExperimentLedger(pinsFromCurrent(path, JSON.parse(readFileSync(path, 'utf8')).calls.length, []), 'tierb-offline-test', carry);
  return { path, open };
}
const VERSIONS = [NATURAL_COMPOSER_RATE_CARDS[SOL].version, NATURAL_COMPOSER_RATE_CARDS[LUNA].version];

test('experiment ledger: append-only reserve/settle/unknown; restart sees retained exposure; cumulative includes history', async () => {
  const { path, open } = tempLedger();
  const ledger = open(); ledger.acquire();
  let retained = 0;
  try {
    const budget = experimentLedgerNaturalBudget(ledger, { id: 'tierb-offline-test', approvedRateVersions: VERSIONS });
    const composer = quote('composer', SOL), r = await budget.reserve(composer);
    assert.ok(r);
    await budget.settle(r!.reservationId, composer, 1_000_000);
    const validator = { ...quote('validator', LUNA), requestId: 'tierb:t:validator' };
    retained = validator.ceilingNanoUsd;
    const v = await budget.reserve(validator);
    await budget.retainUnknown(v!.reservationId, validator, 'DISPATCH_OUTCOME_UNKNOWN');
    assert.equal(await budget.reserve(composer), null, 'duplicate request id refused (no replay)');
  } finally { ledger.release(); }
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.calls.slice(1).map((c: any) => c.reservationStatus), ['RESERVED', 'SETTLED', 'RESERVED', 'UNKNOWN_RETAINED']);
  assert.equal(after.calls[0].case, 'historical', 'history preserved');
  // Restart: a fresh writer reads the retained unknown exposure plus history.
  const { reservedUsd } = open(0).read();
  assert.ok(retained > 0 && Math.abs(reservedUsd - (0.5 + 0.001 + retained / 1e9)) < 1e-9, String(reservedUsd));
  // Cumulative ceiling counts carry + ledger history + retained unknown: 3.47 + ~0.504 + ~0.035 > 4.00 => denied before dispatch.
  const late = open(3.47); late.acquire();
  try {
    const budget = experimentLedgerNaturalBudget(late, { id: 'tierb-offline-test', approvedRateVersions: VERSIONS });
    assert.equal(await budget.reserve({ ...quote('composer', SOL), requestId: 'tierb:t2:composer' }), null);
  } finally { late.release(); }
});

test('experiment ledger: second concurrent writer cannot lock; unlocked or unapproved reservations admit nothing', async () => {
  const { open } = tempLedger();
  const a = open(), b = open();
  a.acquire();
  try {
    assert.throws(() => b.acquire(), /EEXIST/u, 'exclusive single-host writer lock');
    const unlocked = experimentLedgerNaturalBudget(b, { id: 'x', approvedRateVersions: VERSIONS });
    await assert.rejects(unlocked.reserve(quote('composer', SOL)), /LEDGER_NOT_LOCKED/u, 'state-unknown => caller dispatches nothing');
    const unapproved = experimentLedgerNaturalBudget(a, { id: 'x', approvedRateVersions: [VERSIONS[1]] });
    assert.equal(await unapproved.reserve(quote('composer', SOL)), null, 'unapproved rate version');
  } finally { a.release(); }
  assert.throws(() => experimentLedgerNaturalBudget(a, { id: ' ', approvedRateVersions: VERSIONS }), /authorization_invalid/u);
});
