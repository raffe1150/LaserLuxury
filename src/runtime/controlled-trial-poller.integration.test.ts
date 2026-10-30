/** Owned disposable stores + intercepted metadata GETs, no Telegram delivery. */
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {trialFixture,seedTrial,type TrialFixture} from '../../tests/helpers/controlled-trial-fixture';
import {DisposableNativeKnowledgeDatabase} from '../../tests/helpers/disposable-native-knowledge-db';
let p:TrialFixture;process.env.NODE_ENV='test';process.env.DOTENV_CONFIG_PATH='/dev/null';
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
before(async()=>{p=await trialFixture();});beforeEach(async()=>{await seedTrial(p);});after(()=>{p.close();delete process.env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL;});
const config={id:77,businessId:77,telegramBusinessResolved:true,telegramToken:'123456:synthetic-offline'};
for(const failure of ['foreign','revoked','existing-webhook','metadata-failure'] as const)test(`trial Telegram startup: ${failure} cannot start traffic or delete webhook`,async t=>{
 const pg=new DisposableNativeKnowledgeDatabase();t.after(()=>pg.close());let calls:string[]=[];
 for(const key of ['log','info','warn','error'] as const)t.mock.method(console,key,()=>{});
 t.mock.method(globalThis,'fetch',async(input)=>{
  const url=String(input);calls.push(url.split('/').at(-1)!);
  assert.ok(url.endsWith('/getMe')||url.endsWith('/getWebhookInfo'),'No deleteWebhook, polling or message delivery permitted');
  if(url.endsWith('/getMe'))return new Response(JSON.stringify({ok:true,result:{id:123456,is_bot:true,username:'synthetic_bot'}}));
  return failure==='metadata-failure'?new Response('invalid-json'):new Response(JSON.stringify({ok:true,result:{url:'https://owned-existing.example/webhook'}}));
 });
 b.configure({supabaseClient:pg.db});t.after(async()=>{await b.stopTelegramPollers();b.reset();});
 if(failure==='revoked')p.db.sql('update ai_money.trials set enabled=false;');
 await b.startTelegramPoller(failure==='foreign'?{...config,id:88,businessId:88}:config);
 if(['foreign','revoked'].includes(failure))assert.deepEqual(calls,[]);
 else {assert.deepEqual(calls,['getMe','getWebhookInfo']);assert.equal(b.telegramPollerSnapshot(config.telegramToken)?.isPolling,false);}
});
