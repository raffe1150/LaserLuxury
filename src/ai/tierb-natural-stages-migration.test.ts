/** Real owned local PostgreSQL. Synthetic policies only, NOT production approval.
 * Applies the deployed migration chain (owner + controlled trial + re_extraction), then the PREPARED
 * Tier B package (docs/designs/tierb-natural-ai-money-migration-package), and checks every financial
 * invariant it must preserve. The package is outside automatic migration discovery and is never applied
 * to any shared database by this test. */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DisposableSourceIndexDatabase, indexSqlLiteral as literal } from '../../tests/helpers/disposable-source-index-db';
import { KNOWLEDGE_SOL_RATES } from './knowledge-model-policy';

const TRIAL = 'supabase/migrations/20261029082649_controlled_knowledge_trial_safeguards.sql';
const RE_EXTRACTION = 'supabase/migrations/20261112123601_knowledge_re_extraction_stage.sql';
const PACKAGE = 'docs/designs/tierb-natural-ai-money-migration-package/';
const FORWARD = PACKAGE + 'tierb-natural-stages-v1.sql', ROLLBACK = PACKAGE + 'rollback-tierb-natural-stages-v1.sql';
const MANIFEST = JSON.parse(readFileSync(PACKAGE + 'manifest.json', 'utf8'));
const ACCOUNT = 'SHARED_OWNED_TEST_ACCOUNT', APPROVAL = 'SYNTHETIC_NOT_PRODUCTION_APPROVAL', PROJECT = 'proj_owned_test';
const LUNA_RATES = 'openai-luna-standard-2026-07-30';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CORE = `'ai_money.transition_core_v2(text,text,text,jsonb,jsonb)'::regprocedure`;
let db: DisposableSourceIndexDatabase;
let n = 0;

function freshDatabase(applyTierB = true) {
  const d = new DisposableSourceIndexDatabase(['20261024161901_persistent_knowledge_search_snapshot.sql', '20261029070636_durable_ai_monetary_owner.sql']);
  d.sql(`insert into public.businesses values(3);
    alter table public.businesses add column telegram_bot_token text;
    create table public.channel_connections(business_id bigint,provider text,provider_account_id text,status text,reconnect_required boolean,token_expires_at timestamptz);`);
  d.sql(readFileSync(TRIAL, 'utf8'));
  d.sql(readFileSync(RE_EXTRACTION, 'utf8'));
  if (applyTierB) d.sql(readFileSync(FORWARD, 'utf8'));
  return d;
}
function seed(turnNanoUsd = 900000000, tenantNanoUsd = 15000000000) {
  db.sql(`truncate ai_money.events,ai_money.counters,ai_money.reservations,ai_money.trial_cases,ai_money.trial_identities,ai_money.trials,ai_money.entitlements,ai_money.plans,ai_money.periods,ai_money.operators;
   insert into ai_money.operators(account_id,owner_id,approval_ref,provider_account_ref,rates_version,billing_profile,input_bound_approved,enabled,valid_until,
     monthly_nano_usd,emergency_nano_usd,request_nano_usd,turn_nano_usd,warning_bps)
   values('${ACCOUNT}','owned-durable-test','${APPROVAL}','${PROJECT}','${KNOWLEDGE_SOL_RATES.version}','openai-standard-nonregional-30m-v1',true,true,
     now()+interval '20 days',100000000000,200000000000,300000000,${turnNanoUsd},8000);
   insert into ai_money.periods values('${ACCOUNT}','period-one',now()-interval '2 days',now()+interval '2 days');
   insert into ai_money.entitlements values('${ACCOUNT}',3,'period-one','synthetic-sub-3','r1','OFFLINE_ONLY','active',now()-interval '5 days',now()+interval '10 days',null,null,${tenantNanoUsd});`);
}
const rpc = async (command: string, payload: unknown): Promise<any> =>
  db.backendSql(`select public.odin_ai_money_v1(${literal(ACCOUNT)},${literal(APPROVAL)},${literal(command)},${literal(payload)});`);
const raises = async (work: Promise<unknown>, pattern: RegExp) => { await assert.rejects(work, pattern); };
const requestKey = (m: string) => sha('message:' + m);

type Stage = 'extraction' | 're_extraction' | 'verification' | 'knowledge_natural_composition' | 'knowledge_natural_validation';
const LIMITS: Record<Stage, { model: string; rates: string; write: number; output: number; outLimit: number; proxy: number }> = {
  extraction: { model: 'gpt-6.1-sol', rates: KNOWLEDGE_SOL_RATES.version, write: 2500, output: 10000, outLimit: 8192, proxy: 22363 },
  re_extraction: { model: 'gpt-6.1-sol', rates: KNOWLEDGE_SOL_RATES.version, write: 2500, output: 10000, outLimit: 8192, proxy: 22363 },
  verification: { model: 'gpt-6.1-sol', rates: KNOWLEDGE_SOL_RATES.version, write: 2500, output: 10000, outLimit: 8192, proxy: 34277 },
  // Application bounds: composer <= 16,000 B + 4,096 framing, 2,000 output; validator <= 24,000 B + 4,096, 1,200 output.
  knowledge_natural_composition: { model: 'gpt-6.1-sol', rates: KNOWLEDGE_SOL_RATES.version, write: 2500, output: 10000, outLimit: 2000, proxy: 20096 },
  knowledge_natural_validation: { model: 'gpt-5.6-luna', rates: LUNA_RATES, write: 250, output: 1200, outLimit: 1200, proxy: 28096 },
};
function quote(stage: Stage, message: string, overrides: Record<string, unknown> = {}) {
  const l = LIMITS[stage], i = ++n;
  return { businessId: 3, turnId: 'turn-' + message, requestKey: requestKey(message), stage, model: l.model,
    requestSha256: sha('wire' + i), reservationKey: sha(JSON.stringify([3, requestKey(message), stage, i])), inputTokenProxy: l.proxy, outputTokenLimit: l.outLimit,
    maximumNanoUsd: l.proxy * l.write + l.outLimit * l.output, ratesVersion: l.rates, ownerId: 'owned-durable-test', approvalReference: APPROVAL,
    providerProjectId: PROJECT, maximumRequestNanoUsd: 300000000, maximumTurnNanoUsd: 900000000, ...overrides };
}
/** Receipt priced exactly as the DB recomputes it. */
function usage(q: any, tokens = { input: 3000, cached: 0, writes: 0, output: 500, reasoning: 100 }) {
  const p = q.stage === 'knowledge_natural_validation' ? { input: 200, read: 200, write: 250, output: 1200 } : { input: 2000, read: 100, write: 2500, output: 10000 };
  const cost = (tokens.input - tokens.cached - tokens.writes) * p.input + tokens.cached * p.read + tokens.writes * p.write + tokens.output * p.output;
  return { model: q.model, ownerId: q.ownerId, ratesVersion: q.ratesVersion, requestSha256: q.requestSha256, inputTokens: tokens.input, outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning, cachedTokens: tokens.cached, cacheWriteTokens: tokens.writes, estimatedNanoUsd: cost,
    providerProjectId: PROJECT, providerResponseId: 'resp_' + q.reservationKey };
}
async function reserveSettle(stage: Stage, message: string) {
  const q = quote(stage, message), r = await rpc('reserve', { quote: q });
  assert.ok(r && typeof r.id === 'string', stage + ' reserved');
  assert.deepEqual(await rpc('settle', { id: r.id, quote: q, usage: usage(q) }), { settled: true });
  return q;
}
const counters = () => JSON.parse(db.sql(`select coalesce(jsonb_object_agg(bucket::text,jsonb_build_array(known_nano_usd,held_nano_usd)),'{}') from ai_money.counters;`));
const turnBucket = (m: string) => JSON.stringify(['turn', 3, requestKey(m)]).replaceAll(',', ', ');

before(() => { db = freshDatabase(); });
after(() => db?.close());
beforeEach(() => seed());

test('package: exact expected bodies, one function replaced, grants/definer/uniqueness unchanged, no data or grant statements', () => {
  const sql = readFileSync(FORWARD, 'utf8');
  assert.equal(sha(sql), MANIFEST.payloadSha256);
  assert.doesNotMatch(sql.replace(/^--.*$/gmu, '').replace(/ as \$\$[\s\S]*?\$\$;/u, ''), /\bgrant\b|\brevoke\b|\binsert into\b|\bupdate ai_money\b|\bdelete from\b|\bdrop\b|\balter table\b|\bcreate table\b/iu);
  assert.equal(db.sql(`select md5(prosrc) from pg_proc where oid=${CORE};`), MANIFEST.newBodyMd5);
  assert.equal(db.sql(`select prosecdef::text from pg_proc where oid=${CORE};`), 'true');
  assert.equal(db.sql(`select has_function_privilege('anon','public.odin_ai_money_v1(text,text,text,jsonb)','execute')::text||','||
    has_function_privilege('authenticated','public.odin_ai_money_v1(text,text,text,jsonb)','execute')::text||','||
    has_function_privilege('service_role','public.odin_ai_money_v1(text,text,text,jsonb)','execute')::text;`), 'false,false,true');
  assert.equal(db.sql(`select count(*) from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='u';`), '3');
  const before = freshDatabase(false);
  try {
    assert.equal(before.sql(`select md5(prosrc) from pg_proc where oid=${CORE};`), MANIFEST.expectedCurrentBodyMd5);
    const lines = (d: DisposableSourceIndexDatabase) => d.sql(`select prosrc from pg_proc where oid=${CORE};`).split('\n');
    const a = lines(before), b = lines(db);
    assert.deepEqual(a.filter(line => !b.includes(line)), ["   if o.trial_only or q->>'model'<>'gpt-6.1-sol' then return null; end if;"], 'only the production model gate line is replaced');
    assert.ok(b.filter(line => !a.includes(line)).every(line => /natural|Tier B|price_|cache|trial_only|stage=|^\s*--/u.test(line)), 'additions are Tier B only');
  } finally { before.close(); }
});

test('guard refuses an unexpected deployed body or pre-existing Tier B rows, leaving the body untouched', () => {
  const other = freshDatabase(false);
  try {
    other.sql(`create or replace function ai_money.transition_core_v2(p_account text,p_approval text,p_command text,p_payload jsonb,p_scope jsonb default null)
      returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ begin return null; end $$;`);
    assert.throws(() => other.sql(readFileSync(FORWARD, 'utf8')), /ai_money_tierb_unexpected_function_body/u);
    assert.equal(other.sql(`select prosrc like '%knowledge_natural%' from pg_proc where oid=${CORE};`), 'f');
  } finally { other.close(); }
});

test('historical reservations, counters and events are preserved byte for byte by the migration', async () => {
  const old = freshDatabase(false);
  try {
    const save = db; db = old; seed();
    const held = quote('extraction', 'history-1'), r = await rpc('reserve', { quote: held });
    await rpc('unknown', { id: r.id, quote: held });
    await reserveSettle('verification', 'history-2');
    const snapshot = () => db.sql(`select md5(string_agg(t::text,'|' order by t::text)) from (
      select r::text t from ai_money.reservations r union all select c::text from ai_money.counters c union all select e::text from ai_money.events e) x;`);
    const beforeRows = snapshot();
    db.sql(readFileSync(FORWARD, 'utf8'));
    assert.equal(snapshot(), beforeRows);
    assert.equal(db.sql(`select state from ai_money.reservations where request_key='${requestKey('history-1')}';`), 'unknown');
    db = save;
  } finally { old.close(); }
});

test('composition is admitted only after this message\'s Sol verification settled; validation only after composition settled', async () => {
  assert.equal(await rpc('reserve', { quote: quote('knowledge_natural_composition', 'm1') }), null, 'no verification yet');
  const v = quote('verification', 'm1'), vr = await rpc('reserve', { quote: v });
  assert.equal(await rpc('reserve', { quote: quote('knowledge_natural_composition', 'm1') }), null, 'verification held, not settled');
  await rpc('settle', { id: vr.id, quote: v, usage: usage(v) });
  assert.equal(await rpc('reserve', { quote: quote('knowledge_natural_validation', 'm1') }), null, 'no composition yet');
  await reserveSettle('knowledge_natural_composition', 'm1');
  await reserveSettle('knowledge_natural_validation', 'm1');
  assert.equal(db.sql(`select string_agg(stage||':'||model||':'||state,',' order by stage) from ai_money.reservations;`),
    'knowledge_natural_composition:gpt-6.1-sol:settled,knowledge_natural_validation:gpt-5.6-luna:settled,verification:gpt-6.1-sol:settled');
  // Another message's verification never authorizes this one.
  await reserveSettle('verification', 'm2');
  assert.equal(await rpc('reserve', { quote: quote('knowledge_natural_composition', 'm3') }), null);
});

test('one attempt per Tier B stage per message, even after settlement and restart; concurrent reserves admit exactly one', async () => {
  await reserveSettle('verification', 'm4');
  const results = await Promise.all(Array.from({ length: 8 }, () => rpc('reserve', { quote: quote('knowledge_natural_composition', 'm4') }).catch(() => 'ERROR')));
  assert.equal(results.filter(r => r && typeof r === 'object' && r.id).length, 1);
  assert.equal(results.filter(r => r === 'ERROR').length, 0);
  db.restart();
  assert.equal(await rpc('reserve', { quote: quote('knowledge_natural_composition', 'm4') }), null);
  assert.equal(db.sql(`select count(*) from ai_money.reservations where stage='knowledge_natural_composition';`), '1');
});

test('exact model, stage, rates version, output limit and envelope; Luna admitted in production only for validation', async () => {
  await reserveSettle('verification', 'm5');
  await raises(rpc('reserve', { quote: quote('knowledge_natural_composition', 'm5', { outputTokenLimit: 8192 }) }), /ai_money_quote_envelope/u);
  await raises(rpc('reserve', { quote: quote('knowledge_natural_composition', 'm5', { maximumNanoUsd: 1 }) }), /ai_money_quote_envelope/u);
  await raises(rpc('reserve', { quote: quote('knowledge_natural_composition', 'm5', { model: 'gpt-5.6-luna', ratesVersion: LUNA_RATES }) }), /ai_money_unapproved_model_stage/u);
  await raises(rpc('reserve', { quote: quote('knowledge_natural_validation', 'm5', { ratesVersion: 'controlled-trial-standard-20261029' }) }), /ai_money_unapproved_model_stage/u);
  await raises(rpc('reserve', { quote: quote('verification', 'm6', { model: 'gpt-5.6-luna', ratesVersion: LUNA_RATES }) }), /ai_money_unapproved_model_stage/u);
  // Luna for the existing trial-only language stage stays refused outside a trial scope.
  assert.equal(await rpc('reserve', { quote: { ...quote('extraction', 'm7'), model: 'gpt-5.6-luna', stage: 'language', ratesVersion: 'controlled-trial-standard-20261029',
    outputTokenLimit: 8192, maximumNanoUsd: 22363 * 250 + 8192 * 1200 } }), null);
  assert.equal(db.sql(`select count(*) from ai_money.reservations where stage like 'knowledge_natural%';`), '0');
});

test('Tier B shares the message turn bucket; worst-case turn exposure including re_extraction fits the $0.90 turn cap; a lower cap denies Tier B', async () => {
  for (const stage of ['extraction', 're_extraction', 'verification', 'knowledge_natural_composition', 'knowledge_natural_validation'] as Stage[])
    await reserveSettle(stage, 'm8');
  const worst = (['extraction', 're_extraction', 'verification', 'knowledge_natural_composition', 'knowledge_natural_validation'] as Stage[])
    .reduce((sum, s) => sum + quote(s, 'x').maximumNanoUsd, 0);
  assert.ok(worst <= 900000000, String(worst));
  assert.equal(Object.keys(counters()).filter(k => k.startsWith('["turn"')).length, 1, 'one per-message bucket');
  seed();
  await reserveSettle('verification', 'm9');   // settles at 11,000,000 nanoUSD (synthetic receipt)
  const composition = quote('knowledge_natural_composition', 'm9').maximumNanoUsd;
  // A turn cap one nanoUSD below verification actual + composition ceiling (request cap lowered with it: CHECK turn >= request).
  db.sql(`update ai_money.operators set request_nano_usd=${11000000 + composition - 1},turn_nano_usd=${11000000 + composition - 1};`);
  assert.deepEqual(await rpc('reserve', { quote: quote('knowledge_natural_composition', 'm9') }), { denied: 'budget_exhausted' });
  assert.equal(counters()[turnBucket('m9')][1], 0, 'nothing held after the denial');
});

test('settlement recomputes exact cost; cached validator input is never discounted; unknown exposure is retained', async () => {
  await reserveSettle('verification', 'm10');
  await reserveSettle('knowledge_natural_composition', 'm10');
  const q = quote('knowledge_natural_validation', 'm10'), r = await rpc('reserve', { quote: q });
  const wrong = { ...usage(q, { input: 3000, cached: 2000, writes: 0, output: 400, reasoning: 0 }) };
  wrong.estimatedNanoUsd = (1000 * 200) + (2000 * 20) + 400 * 1200;   // a discounted cache read would under-record
  await raises(rpc('settle', { id: r.id, quote: q, usage: wrong }), /ai_money_receipt_cost/u);
  assert.deepEqual(await rpc('settle', { id: r.id, quote: q, usage: usage(q, { input: 3000, cached: 2000, writes: 0, output: 400, reasoning: 0 }) }), { settled: true });
  assert.equal(db.sql(`select actual_nano_usd from ai_money.reservations where stage='knowledge_natural_validation';`), String(3000 * 200 + 400 * 1200));
  const m = 'm11'; await reserveSettle('verification', m);
  const c = quote('knowledge_natural_composition', m), cr = await rpc('reserve', { quote: c });
  await rpc('unknown', { id: cr.id, quote: c });
  assert.equal(db.sql(`select state||':'||maximum_nano_usd from ai_money.reservations where reservation_key='${c.reservationKey}';`), 'unknown:' + c.maximumNanoUsd);
  assert.equal(await rpc('reserve', { quote: quote('knowledge_natural_validation', m) }), null, 'no validation after an unknown composition');
  await raises(rpc('settle', { id: cr.id, quote: c, usage: { ...usage(c), outputTokens: 2001, estimatedNanoUsd: 0 } }), /ai_money_receipt_bounds|ai_money_receipt_cost/u);
});

test('rollback restores the exact deployed body, refuses while Tier B exposure is held, never deletes rows', async () => {
  const d = freshDatabase();
  try {
    const save = db; db = d; seed();
    await reserveSettle('verification', 'r1');
    const held = quote('knowledge_natural_composition', 'r1'); await rpc('reserve', { quote: held });
    assert.throws(() => db.sql(readFileSync(ROLLBACK, 'utf8')), /ai_money_tierb_rollback_held_rows/u);
    const id = db.sql(`select id from ai_money.reservations where reservation_key='${held.reservationKey}';`);
    await rpc('unknown', { id, quote: held });
    db.sql(readFileSync(ROLLBACK, 'utf8'));
    assert.equal(db.sql(`select md5(prosrc) from pg_proc where oid=${CORE};`), MANIFEST.expectedCurrentBodyMd5);
    assert.equal(db.sql(`select count(*) from ai_money.reservations;`), '2');
    db = save;
  } finally { d.close(); }
});
