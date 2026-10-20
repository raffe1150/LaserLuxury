import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeKnowledgeProgressAuthority } from './knowledge-progress-authority';
import { NativeKnowledgeBindings } from './native-knowledge-binding';
import { SupabaseOrderedKnowledgeRepository } from './supabase-ordered-knowledge-repository';
import { DisposableNativeKnowledgeDatabase } from '../../tests/helpers/disposable-native-knowledge-db';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';
const secret='synthetic-progress-integrity-key-at-least-32-bytes';
const literal=(v:any)=>v===null?'NULL':"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'"+(typeof v==='object'?'::jsonb':'');
const signal=()=>new AbortController().signal;

test('trusted progress authority: real signed bindings, new PostgreSQL claim RPC and intercepted channel eligibility',async t=>{
  const pg=new DisposableNativeKnowledgeDatabase();t.after(()=>pg.close());
  pg.sql("SET odin.approved_knowledge_progress_safety_v1='yes';\n"+readFileSync('docs/designs/knowledge-progress-safety-v1/progress-safety-v1.sql.draft','utf8'));
  let newRpcCalls=0,posts=0,revoked=false,enabled=true;
  const db:KnowledgeDatabase={from:pg.db.from,rpc:async(name,args)=>{
    if(name!=='odin_claim_knowledge_progress_v1')return pg.db.rpc(name,args);
    newRpcCalls++;
    try{return {data:JSON.parse(pg.sql('SET ROLE service_role; SELECT public.odin_claim_knowledge_progress_v1('+Object.entries(args).map(([k,v])=>k+'=>'+literal(v)).join(',')+');')||'null'),error:null};}
    catch(error){return {data:null,error};}
  }};
  const accounts={whatsapp:'10001',telegram:'123456',instagram:'30001',messenger:'40001'};
  const connections=new Map<string,ResolvedChannelConnection>();
  for(const channel of Object.keys(accounts) as (keyof typeof accounts)[])connections.set(channel,{id:'connection-'+channel,businessId:77,provider:channel,providerAccountId:accounts[channel],
    providerConnectionId:channel==='whatsapp'?'20001':null,tokenExpiresAt:null,grantedScopes:channel==='whatsapp'?['whatsapp_business_messaging']:channel==='instagram'?['instagram_business_manage_messages']:channel==='messenger'?['pages_messaging']:[],
    status:'connected',connectedAt:null,lastVerifiedAt:null,reconnectRequired:false,displayName:null,source:'self_service',credential:{accessToken:channel==='telegram'?'123456:synthetic':'synthetic'},metadata:{}});
  const resolver=async(business:number,channel:keyof typeof accounts)=>business===77?connections.get(channel)||null:null;
  const fetcher:typeof fetch=async(input,options)=>{
    assert.notEqual(options?.method,'POST','Authority must never send a customer message');posts+=Number(options?.method==='POST');
    const u=new URL(String(input));const channel=u.hostname==='api.telegram.org'?'telegram':u.hostname==='graph.instagram.com'?'instagram':u.pathname.includes('10001')||u.pathname.includes('20001')||u.pathname.endsWith('debug_token')?'whatsapp':'messenger';
    const response=(v:any,status=200)=>new Response(JSON.stringify(v),{status});
    if(revoked)return response({error:{code:190}},403);
    if(u.pathname.endsWith('getMe'))return response({ok:true,result:{id:123456,is_bot:true}});
    if(u.pathname.endsWith('getChat'))return response({ok:true,result:{id:Number(u.searchParams.get('chat_id')),type:'private'}});
    if(u.pathname.endsWith('getChatMember'))return response({ok:true,result:{user:{id:123456},status:'member'}});
    if(u.pathname.endsWith('debug_token'))return response({data:{app_id:'789',is_valid:true,user_id:'60001',scopes:['whatsapp_business_messaging','whatsapp_business_management'],granular_scopes:[{scope:'whatsapp_business_messaging'},{scope:'whatsapp_business_management'}],expires_at:0,data_access_expires_at:0}});
    if(u.pathname==='/v25.0/20001')return response({id:'20001',owner_business_info:{id:'50001'}});
    if(u.pathname.endsWith('/assigned_users'))return response({data:[{id:'60001',tasks:['MANAGE']}]});
    if(u.pathname.endsWith('phone_numbers'))return response({data:[{id:'10001'}]});
    if(channel==='whatsapp')return response({id:'10001',health_status:{can_send_message:'AVAILABLE'}});
    if(u.pathname.endsWith('/me'))return response(channel==='instagram'?{user_id:accounts.instagram}:{id:accounts.messenger});
    return response({data:[{participants:{data:[{id:accounts[channel]},{id:u.searchParams.get('user_id')}]},can_reply:true}]});
  };
  const oldApp=process.env.META_WHATSAPP_APP_ID;process.env.META_WHATSAPP_APP_ID='789';t.after(()=>{if(oldApp===undefined)delete process.env.META_WHATSAPP_APP_ID;else process.env.META_WHATSAPP_APP_ID=oldApp;});
  const bindings=new NativeKnowledgeBindings(db,secret,resolver);
  // Synthetic final authority only for this SQL fixture; production final
  // source/evidence authority is unchanged and tested in its own regressions.
  const repo=new SupabaseOrderedKnowledgeRepository(db,s=>bindings.canonicalKey(s),async()=>true);
  const authority=new NativeKnowledgeProgressAuthority({db,secret,enabled:()=>enabled,connections:resolver,fetcher});
  let serial=0;
  const fixture=async(channel:keyof typeof accounts,checkpoint=true)=>{
    const recipient=String(46000000000+ ++serial);const scope=await bindings.ensure(77,channel,accounts[channel],recipient);
    const accepted=await repo.acceptOrdered(scope,'event-'+serial,{atMs:Math.floor((Date.now()-5000)/1000)*1000,sequence:channel==='telegram'?serial:null},
      {question:'Parking?',language:'en',history:[]},{executionMs:40000});
    const task=await repo.claim(scope,accepted.acceptance!.task!.id,'worker-a',15000);assert.ok(task);
    const token={taskId:task.id,owner:'worker-a',fence:task.fence};if(checkpoint)assert.equal(await repo.checkpoint(scope,token,'planning'),true);
    return {scope,token,recipient};
  };
  for(const channel of Object.keys(accounts) as (keyof typeof accounts)[])await t.test(channel+': trusted scope, recipient, active ownership and finalization',async()=>{
    const f=await fixture(channel);const claim=await authority.claim(f.scope,f.token,'Checking relevant information.',signal());assert.ok(claim);
    assert.equal((await authority.dispatchTarget(f.scope,claim,signal()))?.recipient,f.recipient);
    revoked=true;assert.equal(await authority.dispatchTarget(f.scope,claim,signal()),null);revoked=false;
    assert.equal(await repo.verified(f.scope,f.token,{protocol:'evidence-first-v2',independentlyVerified:true,completeRequiredFacts:true,text:'Verified fixture only.',sources:[{id:'doc',revision:'r1'}]}),true);
    assert.ok(await repo.finalize(f.scope,f.token));assert.equal(await authority.dispatchTarget(f.scope,claim,signal()),null);
    assert.equal(await authority.claim(f.scope,f.token,'No late waiting.',signal()),null);
    assert.equal(await authority.settle(f.scope,claim,{kind:'API_ACCEPTED',providerMessageId:'synthetic-inflight'}),true);
  });
  await t.test('wrong fence, missing checkpoint and revoked connection cannot mint a progress receipt',async()=>{
    const missing=await fixture('telegram',false);const beforeMissing=newRpcCalls;
    assert.equal(await authority.claim(missing.scope,missing.token,'Check',signal()),null);assert.equal(newRpcCalls,beforeMissing);
    const f=await fixture('telegram');let before=newRpcCalls;
    assert.equal(await authority.claim(f.scope,{...f.token,fence:f.token.fence+1},'Check',signal()),null);
    revoked=true;assert.equal(await authority.claim(f.scope,f.token,'Check',signal()),null);revoked=false;
    assert.equal(newRpcCalls,before);
    const c=connections.get('telegram')!;connections.set('telegram',{...c,status:'disconnected'} as any);
    assert.equal(await authority.claim(f.scope,f.token,'Check',signal()),null);connections.set('telegram',c);
  });
  await t.test('cross-tenant scope and tampered signed binding fail closed',async()=>{
    const f=await fixture('telegram');assert.equal(await authority.claim({...f.scope,businessId:88},f.token,'Check',signal()),null);
    pg.sql("UPDATE public.odin_conversations SET aggregate_meta=jsonb_set(aggregate_meta,'{knowledge_native_recipient_v1,recipient}','\"99999999999\"') WHERE id="+literal(f.scope.conversationId)+';');
    assert.equal(await authority.claim(f.scope,f.token,'Check',signal()),null);
  });
  await t.test('default-disabled boundary does no repository/provider work',async()=>{
    const no=()=>assert.fail('Disabled progress cannot perform IO');const off=new NativeKnowledgeProgressAuthority({db:{from:no,rpc:no},secret,fetcher:no});
    assert.equal(await off.claim({businessId:77,channel:'telegram',providerAccount:'123456',conversationId:'not-read'}, {taskId:'not-read',owner:'worker',fence:1},'Check',signal()),null);
    enabled=false;const f={scope:{businessId:77,channel:'telegram' as const,providerAccount:'123456',conversationId:'not-read'},token:{taskId:'not-read',owner:'worker',fence:1}};
    assert.equal(await authority.claim(f.scope,f.token,'Check',signal()),null);enabled=true;
  });
  assert.equal(posts,0);assert.ok(newRpcCalls>=4);assert.ok(pg.calls.every(name=>!name.includes('booking')));
});
