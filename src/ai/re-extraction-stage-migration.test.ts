/** Real owned local PostgreSQL. Synthetic policies only, NOT production approval.
 * Applies the deployed migration chain, then the forward-only re_extraction
 * migration, and checks every financial invariant it must preserve. */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DisposableSourceIndexDatabase, indexSqlLiteral as literal } from '../../tests/helpers/disposable-source-index-db';
import { DurableKnowledgeBudgetOwner, type AiMoneyDatabase } from './durable-knowledge-budget-owner';
import { KNOWLEDGE_SOL_RATES, type KnowledgeCostQuote, type KnowledgeUsage } from './knowledge-model-policy';

const FORWARD = 'supabase/migrations/20261112123601_knowledge_re_extraction_stage.sql';
const ROLLBACK = 'docs/validation/sol-extraction-canary-20261112/rollback-re-extraction-stage.sql';
const TRIAL = 'supabase/migrations/20261029082649_controlled_knowledge_trial_safeguards.sql';
const ACCOUNT = 'SHARED_OWNED_TEST_ACCOUNT', APPROVAL = 'SYNTHETIC_NOT_PRODUCTION_APPROVAL';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let db: DisposableSourceIndexDatabase;
let n = 0;

function freshDatabase(applyForward = true) {
  const d = new DisposableSourceIndexDatabase(['20261024161901_persistent_knowledge_search_snapshot.sql', '20261029070636_durable_ai_monetary_owner.sql']);
  d.sql(`alter table public.businesses add column telegram_bot_token text;
    create table public.channel_connections(business_id bigint,provider text,provider_account_id text,status text,reconnect_required boolean,token_expires_at timestamptz);`);
  d.sql(readFileSync(TRIAL, 'utf8'));
  if (applyForward) d.sql(readFileSync(FORWARD, 'utf8'));
  return d;
}
const client = (): AiMoneyDatabase => ({ rpc(name, args) {
  assert.equal(name, 'odin_ai_money_v1');
  let signal: AbortSignal | undefined;
  const statement = `select public.odin_ai_money_v1(${literal(args.p_account)},${literal(args.p_approval)},${literal(args.p_command)},${literal(args.p_payload)});`;
  const run = async () => { try { return { data: await db.backendSql(statement, signal), error: null }; } catch { return { data: null, error: { code: 'LOCAL' } }; } };
  return { abortSignal: (s: AbortSignal) => { signal = s; return { then: (a: any, b: any) => run().then(a, b) }; }, then: (a: any, b: any) => run().then(a, b) };
} });
function seed(turnNanoUsd = 400000000, tenantNanoUsd: number | null = null) {
  db.sql(`truncate ai_money.events,ai_money.counters,ai_money.reservations,ai_money.trial_cases,ai_money.trial_identities,ai_money.trials,ai_money.entitlements,ai_money.plans,ai_money.periods,ai_money.operators;
   insert into ai_money.operators(account_id,owner_id,approval_ref,provider_account_ref,rates_version,billing_profile,input_bound_approved,enabled,valid_until,
     monthly_nano_usd,emergency_nano_usd,request_nano_usd,turn_nano_usd,warning_bps)
   values('${ACCOUNT}','owned-durable-test','${APPROVAL}','proj_owned_test','${KNOWLEDGE_SOL_RATES.version}','openai-standard-nonregional-30m-v1',true,true,
     now()+interval '20 days',1000000000,2000000000,200000000,${turnNanoUsd},8000);
   insert into ai_money.periods values('${ACCOUNT}','period-one',now()-interval '2 days',now()+interval '2 days');
   insert into ai_money.entitlements values('${ACCOUNT}',77,'period-one','synthetic-sub-77','r1','OFFLINE_ONLY','active',now()-interval '5 days',now()+interval '10 days',null,null,${tenantNanoUsd ?? 900000000}),
    ('${ACCOUNT}',88,'period-one','synthetic-sub-88','r1','OFFLINE_ONLY','active',now()-interval '5 days',now()+interval '10 days',null,null,900000000);`);
}
const requestKey = (label: string) => sha('message:' + label);
function quote(stage: string, message: string, overrides: Partial<KnowledgeCostQuote> = {}): KnowledgeCostQuote {
  const i = ++n;
  return { businessId: 77, turnId: 'turn-' + message, requestKey: requestKey(message), stage: stage as KnowledgeCostQuote['stage'], model: 'gpt-6.1-sol',
    requestSha256: sha('wire' + i), reservationKey: sha(JSON.stringify([77, requestKey(message), stage, i])), inputTokenProxy: 10000, outputTokenLimit: 8192,
    maximumNanoUsd: 106920000, ratesVersion: KNOWLEDGE_SOL_RATES.version, ownerId: 'owned-durable-test', approvalReference: APPROVAL,
    providerProjectId: 'proj_owned_test', maximumRequestNanoUsd: 200000000, maximumTurnNanoUsd: 400000000, ...overrides };
}
const usage = (q: KnowledgeCostQuote): KnowledgeUsage => ({ model: q.model, ownerId: q.ownerId, ratesVersion: q.ratesVersion, requestSha256: q.requestSha256,
  inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cachedTokens: 10, cacheWriteTokens: 50, estimatedNanoUsd: 406000,
  providerProjectId: 'proj_owned_test', providerResponseId: 'resp_' + q.reservationKey });
const owner = () => DurableKnowledgeBudgetOwner.prepare(client(), { accountId: ACCOUNT, approvalReference: APPROVAL });
const reserve = async (q: KnowledgeCostQuote) => {
  try { return await (await owner()).reserve(q, new AbortController().signal); }
  catch (error) { if (error instanceof Error && error.message === 'information_budget_exhausted') return 'EXHAUSTED' as const; throw error; }
};
const counters = () => JSON.parse(db.sql(`select coalesce(jsonb_object_agg(bucket::text,jsonb_build_array(known_nano_usd,held_nano_usd)),'{}') from ai_money.counters;`));
const exposure = () => Number(db.sql(`select coalesce(sum(coalesce(actual_nano_usd,maximum_nano_usd)),0) from ai_money.reservations;`));

before(() => { db = freshDatabase(); });
after(() => db?.close());
beforeEach(() => seed());

test('migration is a three-line change of the two deployed bodies and keeps grants, definer and uniqueness', () => {
  const sql = readFileSync(FORWARD, 'utf8');
  assert.equal((sql.match(/re_extraction/gu) ?? []).length >= 3, true);
  assert.doesNotMatch(sql, /\bgrant\b|\binsert into ai_money\.(operators|entitlements|plans|periods|trials|trial_cases)|\bdrop\b|\balter table\b/iu);
  assert.equal(db.sql(`select string_agg(proname||':'||prosecdef::text,',' order by proname) from pg_proc where pronamespace='ai_money'::regnamespace and proname in ('transition_core_v2','trial_transition');`),
    'transition_core_v2:true,trial_transition:true');
  assert.equal(db.sql(`select has_function_privilege('service_role','ai_money.transition_core_v2(text,text,text,jsonb,jsonb)','execute')::text||has_function_privilege('anon','public.odin_ai_money_v1(text,text,text,jsonb)','execute')::text;`), 'falsefalse');
  assert.equal(db.sql(`select count(*) from pg_constraint where conrelid='ai_money.reservations'::regclass and contype='u';`), '3');
  // Exactly the stage allowlists differ from the deployed bodies.
  const restored = freshDatabase(false);
  try {
    const body = (d: DisposableSourceIndexDatabase, f: string) => d.sql(`select prosrc from pg_proc where proname='${f}' and pronamespace='ai_money'::regnamespace;`).split('\n');
    for (const f of ['transition_core_v2', 'trial_transition']) {
      const a = body(restored, f), b = body(db, f);
      const changed = b.filter(line => !a.includes(line));
      assert.ok(changed.length >= 1 && changed.length <= 2 && changed.join('\n').includes('re_extraction') && changed.every(line => /stage/u.test(line)), f);
      assert.ok(a.filter(line => !b.includes(line)).length <= 2, f);
    }
  } finally { restored.close(); }
});

test('guard refuses an unexpected deployed body and leaves it untouched', () => {
  const other = freshDatabase(false);
  try {
    other.sql(`create or replace function ai_money.transition_core_v2(p_account text,p_approval text,p_command text,p_payload jsonb,p_scope jsonb default null)
      returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ begin return null; end $$;`);
    assert.throws(() => other.sql(readFileSync(FORWARD, 'utf8')), /ai_money_re_extraction_unexpected_function_body/u);
    assert.equal(other.sql(`select prosrc like '%re_extraction%' from pg_proc where proname='trial_transition';`), 'f');
  } finally { other.close(); }
});

test('extraction, re_extraction and verification each get exactly one reservation per message', async () => {
  for (const stage of ['extraction', 're_extraction', 'verification']) assert.ok(typeof (await reserve(quote(stage, 'm1'))) === 'object');
  // A second re_extraction for the same message: new reservation key, new hash, after restart.
  assert.equal(await reserve(quote('re_extraction', 'm1')), null);
  db.restart();
  assert.equal(await reserve(quote('re_extraction', 'm1')), null);
  assert.equal(db.sql(`select string_agg(stage,',' order by stage) from ai_money.reservations;`), 'extraction,re_extraction,verification');
});

test('same reservation key is never re-issued, even after settlement', async () => {
  const q = quote('re_extraction', 'm2');
  const r = await reserve(q); assert.ok(r && r !== 'EXHAUSTED');
  await (await owner()).settle(r.id, q, usage(q));
  assert.equal(await reserve(q), null);
  assert.equal(db.sql(`select state||':'||actual_nano_usd from ai_money.reservations;`), 'settled:406000');
});

test('re_extraction shares the per-message turn cap: no budget bypass', async () => {
  seed(213840000); // exactly two worst-case Sol requests per message
  assert.ok(typeof (await reserve(quote('extraction', 'm3'))) === 'object');
  assert.ok(typeof (await reserve(quote('re_extraction', 'm3'))) === 'object');
  assert.equal(await reserve(quote('verification', 'm3')), 'EXHAUSTED');
  const c = counters();
  assert.deepEqual(c[JSON.stringify(['turn', 77, requestKey('m3')]).replaceAll(',', ', ')], [0, 213840000]);
  // The same cap for a different message is independent; tenant 88 never borrows.
  assert.ok(typeof (await reserve(quote('re_extraction', 'm4'))) === 'object');
});

test('re_extraction is denied when the tenant allowance or request cap is exhausted', async () => {
  seed(400000000, 150000000);
  assert.ok(typeof (await reserve(quote('extraction', 'm5'))) === 'object');
  assert.equal(await reserve(quote('re_extraction', 'm5')), 'EXHAUSTED');
  assert.equal(await reserve(quote('re_extraction', 'm6', { maximumRequestNanoUsd: 1 })), 'EXHAUSTED');
  // Another tenant's allowance is independent and is never borrowed.
  assert.ok(typeof (await reserve(quote('re_extraction', 'm6', { businessId: 88 }))) === 'object');
});

test('concurrent re_extraction reserves for one message admit exactly one', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => reserve(quote('re_extraction', 'm7'))));
  assert.equal(results.filter(r => r && r !== 'EXHAUSTED').length, 1);
  assert.equal(db.sql(`select count(*) from ai_money.reservations where stage='re_extraction';`), '1');
  assert.equal(Number(counters()[JSON.stringify(['turn', 77, requestKey('m7')]).replaceAll(',', ', ')][1]), 106920000);
});

test('unknown re_extraction exposure is retained and only an authentic matching receipt settles it', async () => {
  const q = quote('re_extraction', 'm8');
  const r = await reserve(q); assert.ok(r && r !== 'EXHAUSTED');
  await (await owner()).retainUnknown(q, r.id);
  assert.equal(db.sql(`select state from ai_money.reservations;`), 'unknown');
  db.restart();
  await assert.rejects((await owner()).settle(r.id, { ...q, stage: 'extraction' }, usage(q)));
  assert.equal(exposure(), 106920000);
  await (await owner()).settle(r.id, q, usage(q));
  assert.equal(exposure(), 406000);
  const c = counters()[JSON.stringify(['turn', 77, requestKey('m8')]).replaceAll(',', ', ')];
  assert.deepEqual(c, [406000, 0]);
});

test('only the exact new stage name is admitted', async () => {
  for (const stage of ['reextraction', 're-extraction', 'RE_EXTRACTION', 'extraction_retry', 're_extraction ']) {
    await assert.rejects(reserve(quote(stage, 'm9')));
  }
  assert.equal(db.sql(`select count(*) from ai_money.reservations;`), '0');
});

test('controlled trial: four- and five-stage knowledge caps claim; re_extraction needs its own cap and stays inside the turn limit', () => {
  // Isolate the stage-cap rules: connection/source currency are separately
  // owned production checks and are stubbed ONLY in this disposable database.
  db.sql(`create or replace function ai_money.trial_connection_current(t ai_money.trials,c ai_money.trial_cases) returns boolean language sql as 'select true';
    create or replace function ai_money.trial_source_current(c ai_money.trial_cases,b bigint) returns boolean language sql as 'select true';
    update ai_money.operators set trial_only=true,trial_rates_version='controlled-trial-standard-20261029';
    insert into ai_money.trials values('t1','${ACCOUNT}',77,'OFFLINE',true,now()-interval '1 day',now()+interval '1 day',10,10);
    insert into ai_money.trial_identities values('t1','telegram','1','2','2',true);`);
  const arm = (id: string, caps: Record<string, number>, question: string) => db.sql(`update ai_money.trial_cases set enabled=false where state='pending';
    insert into ai_money.trial_cases(trial_id,id,kind,enabled,human_approval_ref,channel,account,sender,recipient,question_sha256,inventory_token,expected_chunks,stage_caps)
    values('t1','${id}','knowledge',true,'OFFLINE','telegram','1','2','2','${sha(question)}','${sha('inventory')}',1,'${JSON.stringify(caps)}');`);
  const claim = (question: string, event: string) => JSON.parse(db.sql(`set role service_role; select public.odin_ai_money_trial_v1('${ACCOUNT}','${APPROVAL}','t1','claim',
    jsonb_build_object('channel','telegram','account','1','sender','2','recipient','2','questionSha256','${sha(question)}','businessId',77,'eventId','${event}'));`) || 'null');
  const four = { language: 1000, query_embedding: 1000, extraction: 106920000, verification: 106920000 };
  arm('c4', four, 'q4'); assert.ok(claim('q4', 'e4'));
  arm('c5', { ...four, re_extraction: 106920000 }, 'q5'); const scope = claim('q5', 'e5'); assert.ok(scope);
  arm('c6', { ...four, re_extraction: 1 }, 'q6'); assert.ok(claim('q6', 'e6')); // armed but cannot fund a request
  arm('cx', { ...four, retry: 1000 }, 'qx'); assert.equal(claim('qx', 'ex'), null);
  arm('cy', { ...four, re_extraction: 200000000 }, 'qy'); assert.equal(claim('qy', 'ey'), null); // caps sum > turn limit
  const trialReserve = (stage: string, s: any) => JSON.parse(db.sql(`set role service_role; select public.odin_ai_money_trial_v1('${ACCOUNT}','${APPROVAL}','t1','reserve',
    jsonb_build_object('scope',jsonb_build_object('trialId','t1','caseId','${s.caseId}','leaseToken','${s.leaseToken}'),'quote',${literal(
      quote(stage, 'trial', { requestKey: s.requestKey, turnId: s.turnId, reservationKey: sha(stage + s.caseId) }))}));`) || 'null');
  assert.ok(trialReserve('re_extraction', scope)?.id);
  assert.equal(trialReserve('re_extraction', { ...scope }), null);
  const c4 = JSON.parse(db.sql(`select to_jsonb(x) from (select 'c4' as "caseId",lease_token as "leaseToken",event_key as "requestKey",'trial:'||lease_token as "turnId" from ai_money.trial_cases where id='c4') x;`));
  assert.equal(trialReserve('re_extraction', c4), null); // a four-stage case has no re_extraction cap
});

test('rollback draft restores the deployed bodies; held re_extraction exposure is never released', async () => {
  const d = freshDatabase();
  const saved = db; db = d;
  try {
    seed();
    const q = quote('re_extraction', 'rb');
    const r = await reserve(q); assert.ok(r && r !== 'EXHAUSTED');
    d.sql(readFileSync(ROLLBACK, 'utf8'));
    assert.equal(d.sql(`select md5(prosrc) from pg_proc where proname='transition_core_v2';`), '8560db6ba67fbc9792b2b63326d9712d');
    await assert.rejects(reserve(quote('re_extraction', 'rb2')));
    await assert.rejects((await owner()).settle(r.id, q, usage(q)));
    assert.equal(d.sql(`select state||':'||maximum_nano_usd from ai_money.reservations;`), 'held:106920000');
    assert.ok(typeof (await reserve(quote('extraction', 'rb3'))) === 'object');
  } finally { db = saved; d.close(); }
});

test('real OpenAI adapter + durable owner: canary extraction then one re_extraction settle under one message cap', async t => {
  const { captureKnowledgeModelProfile, configureKnowledgeBudgetOwner, knowledgeStageOptions } = await import('./knowledge-model-policy');
  const { generateWithOpenAi } = await import('./providers/openai');
  const { knowledgeStructuredOutput } = await import('./knowledge-answer-protocol');
  const saved = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: 'synthetic-offline-only', ODINLINK_SOL_EXTRACTION_MODE: 'active', ODINLINK_SOL_EXTRACTION_TENANT_IDS: '77' });
  delete process.env.OPENAI_BASE_URL; delete process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE; delete process.env.OPENAI_PROJECT_ID;
  configureKnowledgeBudgetOwner(await owner());
  try {
    let n = 0;
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init?: RequestInit) => {
      const wire = JSON.parse(String(init?.body)); assert.equal(wire.model, 'gpt-6.1-sol');
      return new Response(JSON.stringify({ id: 'resp_canary' + (++n), object: 'response', model: 'gpt-6.1-sol', status: 'completed', service_tier: 'default',
        reasoning: { effort: 'low' }, prompt_cache_options: { mode: 'implicit', ttl: '30m' },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"oversized":false,"units":[]}' }] }],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 }, output_tokens_details: { reasoning_tokens: 5 } } }),
        { headers: { 'Content-Type': 'application/json' } });
    });
    const binding = { businessId: 77, turnId: 'durable-canary', requestKey: requestKey('durable-canary') };
    const profile = captureKnowledgeModelProfile({ ...binding, provider: 'openai', nativeForeground: true, natural: false, durable: false,
      extractionProtocol: 'v2', verificationProtocol: 'source-exhaustive-v2', documentary: true, operational: false, current: async () => true });
    assert.equal(profile.id, 'sol-extraction-v1');
    const send = (stage: 'extraction' | 're_extraction') => generateWithOpenAi({ ...knowledgeStageOptions(profile, stage, binding, Date.now() + 19000),
      signal: new AbortController().signal, systemInstruction: 'OdinLink UNIT EXTRACTION',
      messages: [{ role: 'user', content: JSON.stringify({ evidence: [{ id: 'e1', businessId: 77, text: 'Source.' }] }) }],
      structuredOutput: knowledgeStructuredOutput('extraction', false, ['f1'], 6, 'v2') });
    await send('extraction'); await send('re_extraction');
    assert.equal(db.sql(`select string_agg(stage||':'||state||':'||actual_nano_usd,',' order by stage) from ai_money.reservations;`),
      'extraction:settled:406000,re_extraction:settled:406000');
    assert.deepEqual(counters()[JSON.stringify(['turn', 77, binding.requestKey]).replaceAll(',', ', ')], [812000, 0]);
    assert.throws(() => knowledgeStageOptions(profile, 're_extraction', binding, Date.now() + 19000), /stage_already_closed/u);
    assert.deepEqual(knowledgeStageOptions(profile, 'verification', binding, Date.now() + 19000), {});
  } finally {
    configureKnowledgeBudgetOwner();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
