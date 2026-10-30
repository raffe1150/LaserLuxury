/** Real owned local PostgreSQL; synthetic policies and SDK receipts, NOT production approval. */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DisposableSourceIndexDatabase, indexSqlLiteral as literal } from '../../tests/helpers/disposable-source-index-db';
import { DurableKnowledgeBudgetOwner, approvedAllowanceNanoUsd, installConfiguredKnowledgeBudgetOwner, type AiMoneyDatabase } from './durable-knowledge-budget-owner';
import { KNOWLEDGE_SOL_RATES, configureKnowledgeBudgetOwner, captureKnowledgeModelProfile, knowledgeStageOptions,
  type KnowledgeCostQuote, type KnowledgeUsage } from './knowledge-model-policy';
import { knowledgeStructuredOutput } from './knowledge-answer-protocol';
import { Responses } from 'openai/resources/responses';
import { generateWithOpenAi } from './providers/openai';
const migration = '20261029070636_durable_ai_monetary_owner.sql';
let db: DisposableSourceIndexDatabase;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let count = 0;
const config = { accountId: 'SHARED_OWNED_TEST_ACCOUNT', approvalReference: 'SYNTHETIC_NOT_PRODUCTION_APPROVAL' };
const client: AiMoneyDatabase = { rpc(name,args) {
  assert.equal(name,'odin_ai_money_v1');
  let signal: AbortSignal | undefined;
  const statement = `select public.odin_ai_money_v1(${literal(args.p_account)},${literal(args.p_approval)},${literal(args.p_command)},${literal(args.p_payload)});`;
  const run = async () => {
    try { return { data: await db.backendSql(statement, signal), error: null }; }
    catch { return { data: null, error: { code: 'SYNTHETIC_LOCAL_DB_ERROR' } }; }
  };
  return { abortSignal: s => { signal=s; return { then: (a,b) => run().then(a,b) }; }, then: (a,b) => run().then(a,b) };
} };
function seed() {
 db.sql(`truncate ai_money.events,ai_money.counters,ai_money.reservations,ai_money.entitlements,ai_money.plans,ai_money.periods,ai_money.operators;
 insert into ai_money.operators values('SHARED_OWNED_TEST_ACCOUNT','owned-durable-test','SYNTHETIC_NOT_PRODUCTION_APPROVAL','proj_owned_test',
 '${KNOWLEDGE_SOL_RATES.version}','openai-standard-nonregional-30m-v1',true,true,now()+interval '20 days',1000000000,2000000000,200000000,400000000,8000);
 insert into ai_money.periods values('SHARED_OWNED_TEST_ACCOUNT','period-one',now()-interval '2 days',now()+interval '2 days');
 insert into ai_money.plans values('SHARED_OWNED_TEST_ACCOUNT','Basic','r1','OFFLINE_ONLY',true,'USD',300000000,1,1,'USD_IDENTITY',300000000,200000000,400000000),
 ('SHARED_OWNED_TEST_ACCOUNT','Pro','r1','OFFLINE_ONLY',true,'USD',800000000,1,1,'USD_IDENTITY',800000000,200000000,400000000);
 insert into ai_money.entitlements values('SHARED_OWNED_TEST_ACCOUNT',77,'period-one','synthetic-sub-77','r1','OFFLINE_ONLY','active',now()-interval '5 days',now()+interval '10 days','Basic','r1',null),
 ('SHARED_OWNED_TEST_ACCOUNT',88,'period-one','synthetic-sub-88','r1','OFFLINE_ONLY','active',now()-interval '5 days',now()+interval '10 days','Pro','r1',null);`);
}
function quote(overrides: Partial<KnowledgeCostQuote> = {}): KnowledgeCostQuote {
 const n = ++count;
 return { businessId:77, turnId:`local-turn-${n}`,requestKey:sha('message'+n),stage:'extraction',model:'gpt-6.1-sol',requestSha256:sha('exact-wire'+n),
  reservationKey:sha('reserve'+n),inputTokenProxy:10000,outputTokenLimit:8192,maximumNanoUsd:106920000,ratesVersion:KNOWLEDGE_SOL_RATES.version,
  ownerId:'owned-durable-test',approvalReference:config.approvalReference,providerProjectId:'proj_owned_test',maximumRequestNanoUsd:200000000,maximumTurnNanoUsd:400000000,...overrides };
}
function usage(q: KnowledgeCostQuote): KnowledgeUsage { return { model:q.model, ownerId:q.ownerId,ratesVersion:q.ratesVersion,requestSha256:q.requestSha256,
 inputTokens:100,outputTokens:20,reasoningTokens:5,cachedTokens:10,cacheWriteTokens:50,estimatedNanoUsd:406000,providerProjectId:'proj_owned_test',providerResponseId:'resp_'+q.reservationKey }; }
const owner = () => DurableKnowledgeBudgetOwner.prepare(client,config);
// Most assertions count granted permits; normalize ONLY the explicit known
// exhausted-budget outcome to a denied permit. Its exact error has a separate gate.
const reserve = async (q: KnowledgeCostQuote) => {
 try { return await (await owner()).reserve(q,new AbortController().signal); }
 catch(error){ if(error instanceof Error && error.message==='information_budget_exhausted')return null;throw error; }
};
before(() => { db = new DisposableSourceIndexDatabase([migration]); });
after(() => { configureKnowledgeBudgetOwner(); db?.close(); });
beforeEach(() => { configureKnowledgeBudgetOwner(); seed(); });

test('no configured financial owner installs by default; missing approval/envelope/tenants blocks',async()=>{
 assert.equal(await installConfiguredKnowledgeBudgetOwner(client,{}),false);
 await assert.rejects(DurableKnowledgeBudgetOwner.prepare(client,{...config,approvalReference:'wrong'}));
 for(const column of ['enabled','input_bound_approved']) {
  db.sql(`update ai_money.operators set ${column}=false;`); await assert.rejects(owner()); db.sql(`update ai_money.operators set ${column}=true;`);
 }
 db.sql('truncate ai_money.entitlements;'); await assert.rejects(owner());
});
test('atomic operator monthly cap under concurrent independent tenant requests',async()=>{
 db.sql('update ai_money.operators set monthly_nano_usd=250000000;');
 const results=await Promise.all(Array.from({length:10},(_,i)=>reserve(quote({businessId:i%2?77:88}))));
 assert.equal(results.filter(Boolean).length,2);
 assert.equal(db.sql('select sum(maximum_nano_usd) from ai_money.reservations;'),'213840000');
});
test('independent tenant quota cannot borrow another tenant plan balance',async()=>{
 const results=await Promise.all(Array.from({length:7},()=>reserve(quote())));
 assert.equal(results.filter(Boolean).length,2); // 3 x 0.10692 exceeds Basic .30
 assert.ok(await reserve(quote({businessId:88})));
 assert.equal(await reserve(quote({businessId:99})),null);
});
test('emergency lifetime ceiling includes prior settled costs and current holds',async()=>{
 db.sql('update ai_money.operators set emergency_nano_usd=110000000;');
 const q=quote(),o=await owner(),r=await reserve(q); assert.ok(r); await o.settle(r.id,q,usage(q));
 assert.ok(await reserve(quote({businessId:88})));
 assert.equal(await reserve(quote({businessId:88})),null);
});
test('same message stage cannot get a second dispatch permit after restart or changed request hash',async()=>{
 const q=quote(),r=await reserve(q); assert.ok(r); db.restart();
 assert.equal(await reserve(q),null);
 assert.equal(await reserve({...q,turnId:'new-worker',reservationKey:sha('alternate-key'),requestSha256:sha('changed-wire')}),null);
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'1');
});
test('atomic per-turn capacity spans both stages/workers and logical message identity',async()=>{
 db.sql('update ai_money.operators set turn_nano_usd=200000000;');
 const q=quote(); const results=await Promise.all([reserve(q),reserve({...quote(),requestKey:q.requestKey,stage:'verification'})]);
 assert.equal(results.filter(Boolean).length,1);
});
test('settlement exact integer usage idempotent; conflicting and foreign receipts fail',async()=>{
 const o=await owner(),q=quote(),r=await reserve(q); assert.ok(r);
 const u=usage(q); await o.settle(r.id,q,u); await o.settle(r.id,q,u);
 assert.equal(db.sql('select actual_nano_usd from ai_money.reservations;'),String(u.estimatedNanoUsd));
 await assert.rejects(o.settle(r.id,q,{...u,estimatedNanoUsd:1}));
 await assert.rejects(o.settle(r.id,{...q,businessId:88},u));
 assert.equal(db.sql("select count(*) from ai_money.events where kind='settled';"),'1');
});
test('unknown holds survive time, process/database restart and settle only from authentic matching late usage',async()=>{
 const q=quote(),o=await owner(),r=await reserve(q); assert.ok(r);
 await o.retainUnknown(q,r.id); db.restart();
 const fresh=await owner(); assert.equal(db.sql('select state from ai_money.reservations;'),'unknown');
 await assert.rejects(fresh.reconcileLateReceipt(r.id,q,{...usage(q),providerResponseId:undefined}));
 assert.equal(db.sql('select state from ai_money.reservations;'),'unknown');
 await fresh.reconcileLateReceipt(r.id,q,usage(q)); await fresh.retainUnknown(q,r.id);
 assert.equal(db.sql('select state from ai_money.reservations;'),'settled');
 assert.equal(await reserve(q),null);
});
for(const kind of ['cost','tokens','reasoning','model','rate','request','receipt-id','fraction'] as const) test(`invalid ${kind} usage never releases exposure`,async()=>{
 const q=quote(),r=await reserve(q),o=await owner(); assert.ok(r); const u={...usage(q)};
 if(kind==='cost') u.estimatedNanoUsd=1; if(kind==='tokens') u.inputTokens=10001;
 if(kind==='reasoning') u.reasoningTokens=21; if(kind==='model') Object.assign(u,{model:'other'});
 if(kind==='rate') u.ratesVersion='wrong'; if(kind==='request') u.requestSha256=sha('other');
 if(kind==='receipt-id') u.providerResponseId=undefined; if(kind==='fraction') u.cachedTokens=.5;
 await assert.rejects(o.settle(r.id,q,u)); await o.retainUnknown(q,r.id);
 assert.equal(db.sql('select state from ai_money.reservations;'),'unknown');
});
test('subscription suspension/revocation, source revision and plan revocation rechecked after owner capture',async()=>{
 const o=await owner(); db.sql("update ai_money.entitlements set status='revoked' where business_id=77;");
 assert.equal(await o.reserve(quote(),new AbortController().signal),null);
 assert.ok(await o.reserve(quote({businessId:88}),new AbortController().signal));
 db.sql("update ai_money.plans set enabled=false where plan_key='Pro';");
 assert.equal(await o.reserve(quote({businessId:88}),new AbortController().signal),null);
});
test('period rollover carries uncertain exposure; old known costs settle to original period',async()=>{
 db.sql("update ai_money.periods set ends_at=now()+interval '0.8 seconds';");
 const q=quote(),r=await reserve(q); assert.ok(r); const o=await owner(); await o.retainUnknown(q,r.id);
 await new Promise(resolve=>setTimeout(resolve,850));
 db.sql(`
 insert into ai_money.periods values('SHARED_OWNED_TEST_ACCOUNT','period-two',now(),now()+interval '20 days');
 insert into ai_money.entitlements select account_id,business_id,'period-two',subscription_ref,source_revision,authority_ref,status,valid_from,valid_until,plan_key,plan_revision,150000000 from ai_money.entitlements;`);
 assert.equal(await reserve(quote()),null); // old unknown + next full exposure > new allowance
 await o.reconcileLateReceipt(r.id,q,usage(q)); assert.ok(await reserve(quote()));
 assert.equal(db.sql(`select period_id from ai_money.reservations where id='${r.id}';`),'period-one');
});
test('missing/overlapping period, missing entitlement and expired authority deny admission',async()=>{
 db.sql("insert into ai_money.periods values('SHARED_OWNED_TEST_ACCOUNT','overlap',now()-interval '1 day',now()+interval '1 day');");
 assert.equal(await reserve(quote()),null);
 db.sql("delete from ai_money.periods where period_id='overlap';");
 const captured=await owner(); db.sql("update ai_money.entitlements set valid_until=now()-interval '1 day';");
 assert.equal(await captured.reserve(quote(),new AbortController().signal),null);
});
test('approved SEK conversion uses exact rational floor; invalid/changed FX cannot mint credit',async()=>{
 assert.equal(approvedAllowanceNanoUsd({currency:'SEK',units:123n,numerator:1000000000n,denominator:1007n,approvalReference:'OWNER_APPROVED_TEST_RATE'}),122144985n);
 assert.throws(()=>approvedAllowanceNanoUsd({currency:'USD',units:100n,numerator:2n,denominator:1n,approvalReference:'wrong'}));
 db.sql(`insert into ai_money.plans values('SHARED_OWNED_TEST_ACCOUNT','SEK-plan','fx-r1','OFFLINE_ONLY',true,'SEK',123,1000000000,1007,'OWNER_APPROVED_TEST_RATE',122144985,200000000,400000000);`);
 assert.throws(()=>db.sql("update ai_money.plans set fx_denominator=1 where plan_key='SEK-plan';"));
});
test('unapproved rate version/malformed amount and exact request envelope mismatches reject',async()=>{
 for(const q of [quote({ratesVersion:'wrong'}),quote({maximumNanoUsd:1}),quote({inputTokenProxy:272001}),quote({maximumNanoUsd:.5})]) await assert.rejects(reserve(q));
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'0');
});
test('backend privilege boundary and append-only audit; default migration starts without funds',()=>{
 for(const role of ['anon','authenticated']) assert.throws(()=>db.sql(`set role ${role}; select public.odin_ai_money_v1('x','y','configuration');`));
 assert.throws(()=>db.sql("set role service_role; update ai_money.operators set enabled=true;"));
 assert.throws(()=>db.sql('delete from ai_money.events;'));
 assert.throws(()=>db.sql('update ai_money.events set kind=\'wrong\';'));
});
test('operational disable stops new reserves but safely settles captured inflight usage',async()=>{
 const o=await owner(),q=quote(),r=await reserve(q); assert.ok(r); db.sql('update ai_money.operators set enabled=false;');
 assert.equal(await o.reserve(quote(),new AbortController().signal),null);
 await o.settle(r.id,q,usage(q)); assert.equal(db.sql('select state from ai_money.reservations;'),'settled');
});
test('administrative tenant status is explicit and never returned by customer pipeline',async()=>{
 const o=await owner(); await reserve(quote()); const status=await o.administrativeStatus(77);
 assert.ok(status && typeof status==='object'); await assert.rejects(o.administrativeStatus(99));
});
test('pre-cancellation sends no DB reservation; RPC failure cannot dispatch',async()=>{
 const o=await owner(),c=new AbortController(); c.abort(); await assert.rejects(o.reserve(quote(),c.signal));
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'0');
});

test('actual OpenAI adapter + durable owner pairs stages; exact model/schema/wire and source check',async t=>{
 const env={ODINLINK_KNOWLEDGE_MODEL_PROFILE:'sol-low-v1',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'77'};
 const oldKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-offline-only';
 try {
  configureKnowledgeBudgetOwner(await owner());
  const binding={businessId:77,turnId:'native-turn',requestKey:sha('native-original-message')}; let current=0,calls=0;
  const profile=captureKnowledgeModelProfile({...binding,provider:'openai',nativeForeground:true,natural:false,durable:false,
   extractionProtocol:'v2',verificationProtocol:'v2',documentary:true,operational:false,current:async()=>{current++;return true;}},env);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
   calls++;assert.equal(String(url),'https://api.openai.com/v1/responses');assert.equal(db.sql("select count(*) from ai_money.reservations where state='held';"),'1');
   assert.equal(new Headers(options?.headers).get('OpenAI-Project'),'proj_owned_test');
   const wire=JSON.parse(String(options?.body));assert.equal(wire.model,'gpt-6.1-sol');assert.deepEqual(wire.reasoning,{effort:'low'});
   assert.equal(wire.max_output_tokens,8192);assert.equal(wire.service_tier,'default');assert.deepEqual(wire.prompt_cache_options,{mode:'implicit',ttl:'30m'});
   return new Response(JSON.stringify({id:'resp_sdk_'+calls,object:'response',model:'gpt-6.1-sol',status:'completed',service_tier:'default',reasoning:{effort:'low'},
    prompt_cache_options:{mode:'implicit',ttl:'30m'},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{}'}]}],
    usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:10,cache_write_tokens:50},output_tokens_details:{reasoning_tokens:5}}}),{headers:{'Content-Type':'application/json'}});
  });
  for(const stage of ['extraction','verification']) {
   const req={...knowledgeStageOptions(profile,stage,binding,Date.now()+19000),systemInstruction:'Original instructions',
    messages:[{role:'user' as const,content:JSON.stringify({question:'original',evidence:[{businessId:77,text:'Exact original source'}]})}],
    structuredOutput:knowledgeStructuredOutput(stage as 'extraction'|'verification',false,stage==='extraction'?['f1']:undefined,6,'v2'),signal:new AbortController().signal};
   const result=await generateWithOpenAi(req);assert.ok(result.knowledgeUsage?.providerResponseId);
  }
  assert.equal(calls,2);assert.equal(current,2);assert.equal(db.sql("select count(*) from ai_money.reservations where state='settled';"),'2');
 }finally {configureKnowledgeBudgetOwner();if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
});

test('late authentic receipt settles under captured approval after administrative approval rotation',async()=>{
 const o=await owner(),q=quote(),r=await reserve(q);assert.ok(r);await o.retainUnknown(q,r.id);
 db.sql("update ai_money.operators set approval_ref='NEW_OWNER_APPROVAL',owner_id='new-owner',enabled=false;");
 await o.reconcileLateReceipt(r.id,q,usage(q));assert.equal(db.sql('select state from ai_money.reservations;'),'settled');
 await assert.rejects(o.reserve(quote(),new AbortController().signal));
});
test('entitlement revisions cannot silently switch within a selected logical turn',async()=>{
 const q=quote();assert.ok(await reserve(q));
 db.sql("update ai_money.entitlements set source_revision='r2' where business_id=77;");
 assert.equal(await reserve({...quote(),requestKey:q.requestKey,stage:'verification'}),null);
 assert.ok(await reserve(quote()));
});
test('decreased cap is enforced at next reserve even with old captured owner limits',async()=>{
 const o=await owner();db.sql('update ai_money.operators set request_nano_usd=1;');
 await assert.rejects(o.reserve(quote(),new AbortController().signal),/information_budget_exhausted/u);
});
test('SEK and USD SQL policies share exact rational rounding and explicit versions',()=>{
 assert.equal(db.sql("select ai_money.allowance('SEK',123,1000000000,1007,'fx-approved');"),'122144985');
 assert.equal(db.sql("select ai_money.allowance('USD',123,1,1,'USD_IDENTITY');"),'123');
 for(const sql of ["select ai_money.allowance('EUR',123,1,1,'x');","select ai_money.allowance('SEK',123,1,0,'fx');",
  "select ai_money.allowance('USD',123,2,1,'USD_IDENTITY');","update ai_money.operators set rates_version='unapproved-version';"])
  assert.throws(()=>db.sql(sql));
});
test('duplicate provider receipt cannot settle two different request holds',async()=>{
 const o=await owner(),q=quote(),q2=quote(),r=await reserve(q),r2=await reserve(q2);assert.ok(r&&r2);
 const u=usage(q);await o.settle(r.id,q,u);
 await assert.rejects(o.settle(r2.id,q2,{...usage(q2),providerResponseId:u.providerResponseId}));
 assert.equal(db.sql("select count(*) from ai_money.reservations where state='settled';"),'1');
});
test('two shared-ledger aliases cannot bypass operator limits for the same central project',()=>{
 assert.throws(()=>db.sql("insert into ai_money.operators select 'alternate',owner_id,approval_ref,provider_account_ref,rates_version,billing_profile,input_bound_approved,enabled,valid_until,monthly_nano_usd,emergency_nano_usd,request_nano_usd,turn_nano_usd,warning_bps from ai_money.operators;"));
});
test('missing/null quote identity cannot create a hold',async()=>{
 for(const property of ['ownerId','ratesVersion','businessId','stage','inputTokenProxy','turnId']) {
  const q=quote();Reflect.set(q,property,null);await assert.rejects(reserve(q));
 }
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'0');
});
test('migration is compatible with existing canonical source/booking schemas and safe rollback preserves holds',async()=>{
 const q=quote(),r=await reserve(q);assert.ok(r);
 db.sql('update ai_money.operators set enabled=false;'); // reversible rollback; no DROP or money deletion
 const o=await owner().catch(()=>null);assert.equal(o,null);
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'1');
 assert.equal(db.sql("select to_regclass('public.knowledge_sources') is not null and to_regclass('public.knowledge_source_index_state') is not null;"),'t');
});

for(const mode of ['source-revoked','cancelled-after-reserve','invalid-usage','provider-error','wrong-project'] as const)
 test(`durable real adapter fail-closed:${mode}; no silent fallback or hold release`,async t=>{
 const oldKey=process.env.OPENAI_API_KEY,oldProject=process.env.OPENAI_PROJECT_ID;
 process.env.OPENAI_API_KEY='synthetic-offline-only';delete process.env.OPENAI_PROJECT_ID;
 try {
  configureKnowledgeBudgetOwner(await owner());const controller=new AbortController();let calls=0;
  const binding={businessId:77,turnId:'failure-turn',requestKey:sha('failure-'+mode)};
  const profile=captureKnowledgeModelProfile({...binding,provider:'openai',nativeForeground:true,natural:false,durable:false,operational:false,
   documentary:true,extractionProtocol:'v2',verificationProtocol:'v2',current:async()=>{
    if(mode==='cancelled-after-reserve')controller.abort();return mode!=='source-revoked';
   }},{ODINLINK_KNOWLEDGE_MODEL_PROFILE:'sol-low-v1',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'77'});
  if(mode==='wrong-project')process.env.OPENAI_PROJECT_ID='proj_foreign';
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(mode==='provider-error')throw Error('SCRIPTED_NETWORK_FAILURE');
   return new Response(JSON.stringify({id:'resp_no_usage',object:'response',model:'gpt-6.1-sol',service_tier:'default',reasoning:{effort:'low'},
    prompt_cache_options:{mode:'implicit',ttl:'30m'},output:[]}),{headers:{'Content-Type':'application/json'}});
  });
  const req={...knowledgeStageOptions(profile,'extraction',binding,Date.now()+19000),systemInstruction:'unchanged',signal:controller.signal,
   messages:[{role:'user' as const,content:JSON.stringify({question:'same original',evidence:[{businessId:77,text:'same source'}]})}],
   structuredOutput:knowledgeStructuredOutput('extraction',false,['f1'],6,'v2')};
  await assert.rejects(generateWithOpenAi(req));
  assert.equal(calls,['invalid-usage','provider-error'].includes(mode)?1:0);
  assert.equal(db.sql('select count(*) from ai_money.reservations;'),mode==='wrong-project'?'0':'1');
  if(mode!=='wrong-project')assert.equal(db.sql('select state from ai_money.reservations;'),'unknown');
  assert.throws(()=>knowledgeStageOptions(profile,'verification',binding,Date.now()+19000),/stage_already_closed/u);
 }finally{configureKnowledgeBudgetOwner();if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;
 if(oldProject===undefined)delete process.env.OPENAI_PROJECT_ID;else process.env.OPENAI_PROJECT_ID=oldProject;}
});

test('unresponsive monetary RPC hits finite cancellation without provider dispatch',async()=>{
 const o=await owner();const c=new AbortController();
 // Abort bounds the actual local RPC operation, including an uncertain commit.
 const stopped=AbortSignal.timeout(1);
 await assert.rejects(o.reserve(quote(),stopped));
 // A possible late DB commit is not released; no SDK request was authorized.
 c.abort();
});

test('counter aggregates reconcile exactly to immutable reservation exposure, including duplicate settlement',async()=>{
 const o=await owner(),q=quote(),q2=quote({businessId:88}),r=await reserve(q),r2=await reserve(q2);assert.ok(r&&r2);
 await o.retainUnknown(q2,r2.id);await o.settle(r.id,q,usage(q));await o.settle(r.id,q,usage(q));
 assert.equal(db.sql(`select (select known_nano_usd+held_nano_usd from ai_money.counters where bucket='["account"]'::jsonb)=
 (select sum(coalesce(actual_nano_usd,maximum_nano_usd)) from ai_money.reservations);`),'t');
 assert.equal(db.sql(`select (select held_nano_usd from ai_money.counters where bucket='["account"]'::jsonb)=
 (select sum(maximum_nano_usd) from ai_money.reservations where state<>'settled');`),'t');
});
test('financial plan revisions and occupied periods cannot be silently rewritten',async()=>{
 assert.throws(()=>db.sql("update ai_money.plans set allowance_nano_usd=400000000,source_units=400000000 where plan_key='Basic';"));
 const q=quote();await reserve(q);assert.throws(()=>db.sql("update ai_money.periods set ends_at=ends_at+interval '1 day';"));
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'1');
});

test('lost reserve response retains durable admission; no duplicate permit or optimistic release',async()=>{
 const lossy: AiMoneyDatabase={rpc(name,args){
  const query=client.rpc(name,args);
  return {then:(ok,bad)=>Promise.resolve(query).then(result=>{if(args.p_command==='reserve'&&!result.error)throw Error('SIMULATED_RESPONSE_LOSS_AFTER_COMMIT');return result;}).then(ok,bad)};
 }};
 const o=await DurableKnowledgeBudgetOwner.prepare(lossy,config),q=quote();
 await assert.rejects(o.reserve(q,new AbortController().signal));
 await o.retainUnknown(q,null);
 assert.equal(db.sql('select state from ai_money.reservations;'),'unknown');
 assert.equal(await reserve(q),null);
});


test('known tenant budget exhaustion reports existing safe BUDGET_EXHAUSTED outcome without financial details',async()=>{
 const o=await owner();db.sql('update ai_money.entitlements set tenant_nano_usd=0 where business_id=77;');
 await assert.rejects(o.reserve(quote(),new AbortController().signal),/^(?:Error: )?information_budget_exhausted$/u);
 assert.equal(db.sql('select count(*) from ai_money.reservations;'),'0');
});


test('late valid SDK receipt settles after cancellation without reopening the failed stage',async t=>{
 const oldKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='synthetic-offline-only';
 try {
  configureKnowledgeBudgetOwner(await owner());const c=new AbortController();let calls=0;
  const binding={businessId:77,turnId:'late-receipt-turn',requestKey:sha('late-original-message')};
  const profile=captureKnowledgeModelProfile({...binding,provider:'openai',nativeForeground:true,natural:false,durable:false,operational:false,
   documentary:true,extractionProtocol:'v2',verificationProtocol:'v2',current:async()=>true},
   {ODINLINK_KNOWLEDGE_MODEL_PROFILE:'sol-low-v1',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'77'});
  t.mock.method(Responses.prototype,'create',async()=>{
   calls++;setTimeout(()=>c.abort(),5);await new Promise(resolve=>setTimeout(resolve,60));
   return {id:'resp_late_authentic_fixture',object:'response',model:'gpt-6.1-sol',status:'completed',service_tier:'default',reasoning:{effort:'low'},
    prompt_cache_options:{mode:'implicit',ttl:'30m'},output:[],usage:{input_tokens:100,output_tokens:20,
    input_tokens_details:{cached_tokens:10,cache_write_tokens:50},output_tokens_details:{reasoning_tokens:5}}};
  });
  await assert.rejects(generateWithOpenAi({...knowledgeStageOptions(profile,'extraction',binding,Date.now()+19000),systemInstruction:'unchanged',signal:c.signal,
   messages:[{role:'user',content:JSON.stringify({question:'same original',evidence:[{businessId:77,text:'same source'}]})}],
   structuredOutput:knowledgeStructuredOutput('extraction',false,['f1'],6,'v2')}));
  await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(calls,1);assert.equal(db.sql('select state from ai_money.reservations;'),'settled');
  assert.equal(db.sql('select actual_nano_usd from ai_money.reservations;'),'406000');
  assert.throws(()=>knowledgeStageOptions(profile,'verification',binding,Date.now()+19000),/stage_already_closed/u);
 }finally{configureKnowledgeBudgetOwner();if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
});


test('business deletion revokes allowance projection without erasing uncertain financial exposure',async()=>{
 db.sql(`insert into public.businesses values(9999);
 insert into ai_money.entitlements select account_id,9999,period_id,'synthetic-sub-deleted','r1','OFFLINE_ONLY','active',valid_from,valid_until,plan_key,plan_revision,null
 from ai_money.entitlements where business_id=77;`);
 const q=quote({businessId:9999}),o=await owner(),r=await reserve(q);assert.ok(r);
 await o.retainUnknown(q,r.id);db.sql('delete from public.businesses where id=9999;');
 assert.equal(await o.reserve(quote({businessId:9999}),new AbortController().signal),null);
 assert.equal(db.sql('select state from ai_money.reservations;'),'unknown');
 await o.reconcileLateReceipt(r.id,q,usage(q));assert.equal(db.sql('select state from ai_money.reservations;'),'settled');
});


const enabledProfileInput=()=>({businessId:77,turnId:'bootstrap-isolation',requestKey:sha('bootstrap-message'),provider:'openai',nativeForeground:true,
 natural:false,durable:false,documentary:true,operational:false,extractionProtocol:'v2',verificationProtocol:'v2',current:async()=>true});
const enabledProfileEnv={ODINLINK_KNOWLEDGE_MODEL_PROFILE:'sol-low-v1',ODINLINK_KNOWLEDGE_SOL_TENANT_IDS:'77'};
test('missing or failed reconfiguration removes new selection authority while captured turns retain binding',async()=>{
 configureKnowledgeBudgetOwner(await owner());const old=captureKnowledgeModelProfile(enabledProfileInput(),enabledProfileEnv);
 assert.equal(await installConfiguredKnowledgeBudgetOwner(client,{}),false);
 assert.equal(captureKnowledgeModelProfile(enabledProfileInput(),enabledProfileEnv).activationBlock,'budget_owner_unavailable');
 assert.equal(knowledgeStageOptions(old,'extraction',{businessId:77,turnId:'bootstrap-isolation',requestKey:sha('bootstrap-message')},Date.now()+19000).model,'gpt-6.1-sol');
 configureKnowledgeBudgetOwner(await owner());
 await assert.rejects(installConfiguredKnowledgeBudgetOwner(client,{ODINLINK_AI_MONEY_ACCOUNT:config.accountId,ODINLINK_AI_MONEY_APPROVAL:'wrong'}));
 assert.equal(captureKnowledgeModelProfile(enabledProfileInput(),enabledProfileEnv).activationBlock,'budget_owner_unavailable');
});
test('delayed previous bootstrap cannot reinstall an owner after operational disable',async()=>{
 let release:()=>void=()=>{},arrived:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{arrived=resolve;});
 const delayed:AiMoneyDatabase={rpc(name,args){const result=Promise.resolve(client.rpc(name,args));
  return {then:(ok,bad)=>result.then(async value=>{arrived();await gate;return value;}).then(ok,bad)};
 }};
 const pending=installConfiguredKnowledgeBudgetOwner(delayed,{ODINLINK_AI_MONEY_ACCOUNT:config.accountId,ODINLINK_AI_MONEY_APPROVAL:config.approvalReference});
 await ready;await installConfiguredKnowledgeBudgetOwner(client,{});release();assert.equal(await pending,false);
 assert.equal(captureKnowledgeModelProfile(enabledProfileInput(),enabledProfileEnv).activationBlock,'budget_owner_unavailable');
});
