/** Real disposable PostgreSQL monetary/traffic controls. Synthetic SDK receipts; no provider acceptance. */
import {Embeddings} from 'openai/resources/embeddings';
import {embedWithOpenAi,transcribeWithOpenAi} from '../ai/providers/openai';
import {ConfiguredEmbeddingProvider} from '../ai/providers/embeddings';
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {trialFixture,seedTrial,type TrialFixture,identities} from '../../tests/helpers/controlled-trial-fixture';
import {indexSqlLiteral as lit} from '../../tests/helpers/disposable-source-index-db';
import {installControlledTrial,runControlledTrialInbound,withVerifiedTrialTelegram,withVerifiedTrialMeta,trialSha,trialStage,
 trialCurrent,trialSendAllowed,trialHttpAllowed,trialPollerCurrent,denyTrialAction,assertTrialProvider,runControlledSourceIndex} from './controlled-knowledge-trial';
import {executeTrialRequest} from '../ai/controlled-trial-admission';
import {configureKnowledgeBudgetOwner} from '../ai/knowledge-model-policy';
let p:TrialFixture;const question='May visitors nibble before being called?',recipient='46700000001',token='123456:synthetic-offline';
const update={update_id:'701',message:{from:{id:recipient,is_bot:false},chat:{id:recipient,type:'private'},text:question}};
const connection=async()=>({businessId:77,tokenSha:trialSha(token)});
const input={channel:'telegram' as const,account:'123456',recipient,eventId:update.update_id,text:question,event:update};
const inbound=<T>(work:()=>Promise<T>)=>withVerifiedTrialTelegram(update,'123456',token,()=>runControlledTrialInbound(input,connection,work));
const wire={model:'gpt-5.6-luna',instructions:'language classifier',input:[{role:'user',content:question}]};
const embedding={model:'text-embedding-3-small',input:[question],dimensions:768,encoding_format:'float'};
const raw={id:'resp_local',model:'gpt-5.6-luna',service_tier:'default',prompt_cache_options:{mode:'implicit',ttl:'30m'},usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:0,cache_write_tokens:20},output_tokens_details:{reasoning_tokens:0}}};
const embRaw={_request_id:'req_local',model:'text-embedding-3-small',usage:{prompt_tokens:10,total_tokens:10}};
before(async()=>{p=await trialFixture();});after(()=>{p?.close();configureKnowledgeBudgetOwner();delete process.env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL;});
beforeEach(async()=>{await seedTrial(p,question);});
test('OFF has no trial routing change, HTTP or business-action restriction; invalid ON fails closed',async()=>{
 delete process.env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL;assert.equal(trialHttpAllowed('/api/chat'),true);denyTrialAction();let calls=0;
 await runControlledTrialInbound(input,connection,async()=>{calls++;});assert.equal(calls,1);assert.equal(await installControlledTrial(undefined,{}),false);
 process.env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL='invalid';await assert.rejects(installControlledTrial(p.db.client));assert.equal(trialHttpAllowed('/api/chat'),false);
});
test('no trial configuration, disabled policy, missing authority and forged transport cannot admit',async()=>{
 let called=0;await runControlledTrialInbound(input,connection,async()=>{called++;});assert.equal(called,0);
 p.db.sql('update ai_money.trials set enabled=false;');await assert.rejects(installControlledTrial(p.db.client));await inbound(async()=>{called++;});assert.equal(called,0);
});
for(const variant of ['sender','account','recipient','tenant','question','event','forwarded','group'] as const)test(`reject ${variant} before handler/spending`,async()=>{
 let called=0;const u=structuredClone(update);const i={...input};let c=connection;
 if(variant==='sender')u.message.from.id='999';if(variant==='account')i.account='999';if(variant==='recipient')i.recipient='999';
 if(variant==='tenant')c=async()=>({businessId:88,tokenSha:trialSha(token)});if(variant==='question')i.text='a different question';
 if(variant==='event')i.event={...u,update_id:'702'};if(variant==='forwarded')Object.assign(u.message,{forward_origin:{type:'user'}});
 if(variant==='group')u.message.chat.type='group';
 await withVerifiedTrialTelegram(u,'123456',token,()=>runControlledTrialInbound(i,c,async()=>{called++;}));assert.equal(called,0);
 assert.equal(p.db.sql('select count(*) from ai_money.reservations;'),'0');
});
test('one-use claim is atomic across workers, restart and replay; exact questions never progress automatically',async()=>{
 let called=0;await Promise.all([inbound(async()=>{called++;}),inbound(async()=>{called++;})]);assert.equal(called,1);p.db.restart();
 await inbound(async()=>{called++;});assert.equal(called,1);assert.equal(p.db.sql("select count(*) from ai_money.trial_cases where state='claimed';"),'1');
});
for(const channel of ['whatsapp','messenger','instagram'] as const)test(`${channel}: verified transport + exact stored identity + registered tenant required`,async()=>{
 await seedTrial(p,question,channel);const account=identities[channel],eventId='803';
 const event=channel==='whatsapp'?{id:eventId,from:recipient,type:'text',text:{body:question}}:{sender:{id:recipient},recipient:{id:account},message:{mid:eventId,text:question}};
 const body=channel==='whatsapp'?{object:'whatsapp_business_account',entry:[{id:'owned-waba',changes:[{value:{metadata:{phone_number_id:account},messages:[event]}}]}]}:
  {object:channel==='instagram'?'instagram':'page',entry:[{id:account,messaging:[event]}]};
 let n=0;await withVerifiedTrialMeta(Buffer.from(JSON.stringify(body)),()=>runControlledTrialInbound({channel,account,recipient,eventId,text:question,event},async()=>({businessId:77,tokenSha:trialSha('synthetic-only')}),async()=>{n++;assert.equal(await trialCurrent(),true);}));assert.equal(n,1);
});
test('mixed comment/media payloads and unowned Telegram pollers are denied; HTTP blocks unrelated AI/booking/upload routes',async()=>{
 for(const path of ['/api/chat','/api/transcribe','/api/book','/api/businesses/77/knowledge/documents','/api/test-bridge'])assert.equal(trialHttpAllowed(path),false);
 for(const path of ['/health','/webhook','/webhook/messenger','/webhook/instagram','/webhook/facebook'])assert.equal(trialHttpAllowed(path),true);
 assert.equal(await trialPollerCurrent(88,'123456'),false);assert.equal(await trialPollerCurrent(77,'999'),false);assert.equal(await trialPollerCurrent(77,'123456'),true);
 assert.throws(()=>withVerifiedTrialMeta(Buffer.from(JSON.stringify({object:'page',entry:[{id:'40001',changes:[{field:'feed'}]}]})),()=>true));
});
test('language advance hold precedes SDK dispatch; exact billing/project/output, durable settlement and stage one-use',async()=>{
 await inbound(async()=>{
  const r=await executeTrialRequest('language',wire,{timeoutMs:1000},async(body,signal,timeout,project)=>{
   assert.equal(p.db.sql("select count(*) from ai_money.reservations where state='held';"),'1');assert.equal(project,'proj_trial_local');assert.equal(body.max_output_tokens,8192);
   assert.equal(body.service_tier,'default');assert.deepEqual(body.prompt_cache_options,{mode:'implicit',ttl:'30m'});assert.ok(!signal.aborted&&timeout>0);return raw;
  });assert.equal(r,raw);assert.equal(p.db.sql("select actual_nano_usd from ai_money.reservations;"),'33000');
  await assert.rejects(executeTrialRequest('language',wire,{timeoutMs:1000},async()=>raw));
 });
});
for(const failure of ['usage','model','tier','cache','cost','receipt','network'] as const)test(`uncertain ${failure} receipt retains full durable hold`,async()=>{
 await inbound(async()=>{
  const altered=structuredClone(raw);
  if(failure==='usage')Object.assign(altered,{usage:undefined});if(failure==='model')altered.model='other';if(failure==='tier')altered.service_tier='flex';
  if(failure==='cache')altered.usage.input_tokens_details.cache_write_tokens=-1;if(failure==='cost')altered.usage.output_tokens=8193;if(failure==='receipt')altered.id='untrusted';
  await assert.rejects(executeTrialRequest('language',wire,{timeoutMs:1000},async()=>{if(failure==='network')throw Error('synthetic_transport_failure');return altered;}));
 });
 p.db.restart();assert.equal(p.db.sql('select state from ai_money.reservations;'),'unknown');assert.equal(p.db.sql('select actual_nano_usd is null from ai_money.reservations;'),'t');
});
test('query embedding authentic request ID settles; missing usage cannot release, query retry cannot spend',async()=>{
 await inbound(async()=>{await executeTrialRequest('query_embedding',embedding,{timeoutMs:1000},async()=>embRaw);
  assert.equal(p.db.sql('select actual_nano_usd from ai_money.reservations;'),'200');await assert.rejects(executeTrialRequest('query_embedding',embedding,{timeoutMs:1000},async()=>embRaw));});
});
test('query timeout preserves lexical continuation only after confirmed hold; cancellation never allows another dispatch',async()=>{
 await inbound(async()=>{
  const stop=new AbortController();
  await assert.rejects(executeTrialRequest('query_embedding',embedding,{signal:stop.signal,timeoutMs:1000},async()=>{stop.abort(Error('synthetic_optional_timeout'));return new Promise(()=>{});}));
  assert.equal(await trialCurrent(),true);assert.equal(p.db.sql('select state from ai_money.reservations;'),'unknown');
  assert.throws(()=>trialStage('query_embedding'));
 });
});
for(const failure of ['tenant-budget','operator-budget','request-budget','disabled','expired','source','connection','switch-off'] as const)test(`pre-dispatch ${failure} fail closed with no SDK call`,async()=>{
 let sent=0;await inbound(async()=>{
  if(failure==='tenant-budget')p.db.sql('update ai_money.entitlements set tenant_nano_usd=0;');
  if(failure==='operator-budget')p.db.sql('update ai_money.operators set emergency_nano_usd=1;');
  if(failure==='request-budget')p.db.sql('update ai_money.operators set request_nano_usd=1;');
  if(failure==='disabled')p.db.sql('update ai_money.trials set enabled=false;');
  if(failure==='expired')p.db.sql('update ai_money.operators set valid_until=now()-interval \'1 second\';');
  if(failure==='source')p.db.sql("update public.knowledge_sources set status='disabled' where business_id=77;");
  if(failure==='connection')p.db.sql("update public.businesses set telegram_bot_token='999:changed' where id=77;");
  if(failure==='switch-off')delete process.env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL;
  await assert.rejects(executeTrialRequest('language',wire,{timeoutMs:1000},async()=>{sent++;return raw;}));
 });assert.equal(sent,0);
 if(failure==='source')p.db.sql("update public.knowledge_sources set status='ready' where business_id=77;");
 if(failure==='connection')p.db.sql("update public.businesses set telegram_bot_token='123456:synthetic-offline' where id=77;");
});
test('booking, alternate providers, Planner/recovery/composition denied, even inside authorized scope',async()=>{
 await inbound(async()=>{
  assert.throws(denyTrialAction);for(const stage of ['planner','knowledge_units_composition','recovery',undefined])assert.throws(()=>assertTrialProvider('openai',stage));
  assert.throws(()=>assertTrialProvider('gemini','semantic_language_resolution'));
 });
});
test('outbound requires exact token/recipient/account and durable one-time send lease',async()=>{
 await inbound(async()=>{
  const init={method:'POST',body:JSON.stringify({chat_id:recipient,text:'safe response'})};
  assert.equal(await trialSendAllowed('https://api.telegram.org/bot999:other/sendMessage',init),false);
  assert.equal(await trialSendAllowed('https://api.telegram.org/bot'+token+'/sendMessage',{...init,body:JSON.stringify({chat_id:'999',text:'wrong'})}),false);
  assert.equal(await trialSendAllowed('https://api.telegram.org/bot'+token+'/sendMessage',init),true);
  assert.throws(()=>p.db.sql('update ai_money.trial_cases set send_started=false;'));
  assert.equal(await trialSendAllowed('https://api.telegram.org/bot'+token+'/sendMessage',init),false);
 });
});
test('source index exact revision and final SDK request hash, one batch, shared durable counters',async t=>{
 const row=JSON.parse(p.db.sql("select jsonb_build_object('id',id,'revision',public.knowledge_source_index_revision_v1(business_id,id)) from public.knowledge_sources where business_id=77 order by id limit 1;"));
 const body={...embedding,input:['Exact approved source snapshot']};
 p.db.sql(`update ai_money.trial_cases set enabled=false;insert into ai_money.trial_cases(trial_id,id,kind,enabled,human_approval_ref,source_id,source_revision,source_request_sha256,stage_caps)
 values('local-test','index','source_index',true,'OFFLINE_SYNTHETIC_NOT_APPROVED',${lit(row.id)},${lit(row.revision)},${lit(trialSha(JSON.stringify(body)))},'{"source_index":100000}');`);
 t.mock.method(Embeddings.prototype,'create',async(wire,options)=>{assert.deepEqual(wire,body);assert.equal(options?.maxRetries,0);assert.equal(options?.headers?.['OpenAI-Project'],'proj_trial_local');assert.equal(p.db.sql("select count(*) from ai_money.reservations where state='held';"),'1');return {...embRaw,data:[{index:0,embedding:Array(768).fill(.1)}]};});
 await runControlledSourceIndex('index',async()=>{const vectors=await embedWithOpenAi(body.input);assert.equal(vectors.length,1);assert.equal(vectors[0].dimensions,768);await assert.rejects(embedWithOpenAi(body.input));});
 assert.equal(p.db.sql('select stage from ai_money.reservations;'),'source_index');assert.equal(p.db.sql('select actual_nano_usd from ai_money.reservations;'),'200');
 await assert.rejects(runControlledSourceIndex('index',async()=>true));
});
test('service role cannot edit policy or call private engine; public/anon RPC forbidden',async()=>{
 await assert.rejects(p.db.backendSql("update ai_money.trials set enabled=true;"));
 await assert.rejects(p.db.backendSql("select ai_money.transition_core_v2('local-trial','OFFLINE_SYNTHETIC_NOT_APPROVED','configuration','{}',null);"));
 assert.equal(p.db.sql("select has_function_privilege('anon','public.odin_ai_money_trial_v1(text,text,text,text,jsonb)','execute');"),'f');
});

test('missing/null policy bindings are rejected by database constraints',()=>{
 for(const column of ['question_sha256','inventory_token','expected_chunks'])assert.throws(()=>p.db.sql(`update ai_money.trial_cases set ${column}=null;`));
 assert.throws(()=>p.db.sql("insert into ai_money.trial_cases(trial_id,id,kind,enabled,human_approval_ref,source_id,stage_caps) values('local-test','bad','source_index',true,'OFFLINE_ONLY','77000000-0000-4000-8000-000000000001','{}');"));
});
test('wrong protocol, smart waiting and natural mode cannot enter trial handler',async()=>{
 let n=0;for(const [key,value] of [['ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL','literal-evidence-v1'],['ODINLINK_SMART_WAITING','true'],['ODINLINK_GROUNDED_NATURAL_RESPONSES','true']]){
  const old=process.env[key];process.env[key]=value;await inbound(async()=>{n++;});if(old===undefined)delete process.env[key];else process.env[key]=old;
 }assert.equal(n,0);
});
test('alternate embedding/query and audio paths cannot escape trial owner',async()=>{
 process.env.AI_PROVIDER='gemini';const provider=new ConfiguredEmbeddingProvider(()=>{throw Error('KEY_ACCESS_FORBIDDEN');});
 await assert.rejects(provider.embedQuery(question),/controlled_trial_business_action_denied/);
 await assert.rejects(provider.embedDocuments([question]),/controlled_trial_business_action_denied/);
 await assert.rejects(transcribeWithOpenAi({audio:{data:'Zm9v',mimeType:'audio/wav'}}),/controlled_trial_business_action_denied/);
});
test('revocation after advance reserve prevents dispatch and never releases the possible hold',async()=>{
 const underlying=p.db.client;let revoked=false;
 const db={rpc(name:string,args:Record<string,unknown>){
  const run=async()=>{const result=await underlying.rpc(name,args);if(args.p_command==='reserve'&&!revoked){revoked=true;p.db.sql('update ai_money.trial_identities set enabled=false;');}return result;};
  return {then:<TResult1 = {data:unknown;error:unknown},TResult2 = never>(yes?:((v:{data:unknown;error:unknown})=>TResult1|PromiseLike<TResult1>)|null,no?:((e:unknown)=>TResult2|PromiseLike<TResult2>)|null)=>run().then(yes,no)};
 }};
 await installControlledTrial(db);let sent=0;
 await inbound(async()=>{await assert.rejects(executeTrialRequest('language',wire,{timeoutMs:1000},async()=>{sent++;return raw;}));});
 assert.equal(sent,0);assert.equal(p.db.sql('select state from ai_money.reservations;'),'unknown');
});
