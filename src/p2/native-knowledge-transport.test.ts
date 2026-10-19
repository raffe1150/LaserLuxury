import test from 'node:test';
import assert from 'node:assert/strict';
import { sendNativeKnowledge } from './native-knowledge-transport';
import { nativeAsyncControls, NativeKnowledgeRuntime } from './native-knowledge-runtime';
import type { ResolvedChannelConnection } from '../channels/connections/contracts';
const channels=['whatsapp','telegram','instagram','messenger'] as const;
const recipient='46700000001';
for(const channel of channels){
  const connection:ResolvedChannelConnection={id:'fixture',businessId:77,provider:channel,providerAccountId:'123456',providerConnectionId:null,
    tokenExpiresAt:null,grantedScopes:[],status:'connected',connectedAt:null,lastVerifiedAt:null,reconnectRequired:false,displayName:null,source:'self_service',
    credential:{accessToken:'synthetic-only'},metadata:{}};
  const accepted=channel==='telegram'?{ok:true,result:{message_id:123,chat:{id:Number(recipient)}}}:channel==='whatsapp'?{messages:[{id:'wamid.synthetic'}],contacts:[{wa_id:recipient}]}:{message_id:'mid.synthetic',recipient_id:recipient};
  for(const [name,status,body,kind]of [
    ['exact provider acknowledgement',200,accepted,'API_ACCEPTED'],['unproven HTTP 200',200,{},'AMBIGUOUS'],
    ['explicit permission rejection',403,channel==='telegram'?{ok:false,error_code:403}:{error:{code:10}},'DEFINITIVELY_UNSENT'],
    ['explicit throttling',429,channel==='telegram'?{ok:false,error_code:429}:{error:{code:4}},'DEFINITIVELY_UNSENT'],
    ['server error',500,{error:{code:2}},'AMBIGUOUS'],['request timeout',408,{error:{code:2}},'AMBIGUOUS'],
  ]as const)test(`${channel}: ${name} classifies one raw request`,async()=>{
    let calls=0;const fetcher:typeof fetch=async(_url,init)=>{calls++;assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');return new Response(JSON.stringify(body),{status});};
    const outcome=await sendNativeKnowledge(connection,recipient,'Complete verified answer.',new AbortController().signal,fetcher);
    assert.equal(outcome.kind,kind);assert.equal(calls,1);if(outcome.kind==='DEFINITIVELY_UNSENT')assert.equal(outcome.retryable,status===429);
  });
  test(`${channel}: network exception and malformed successful body remain uncertain, without retry`,async()=>{
    let calls=0;const throwing:typeof fetch=async()=>{calls++;throw new Error('synthetic lost response');};
    assert.equal((await sendNativeKnowledge(connection,recipient,'Answer',new AbortController().signal,throwing)).kind,'AMBIGUOUS');assert.equal(calls,1);
    const malformed:typeof fetch=async()=>{calls++;return new Response('not-json',{status:200});};
    assert.equal((await sendNativeKnowledge(connection,recipient,'Answer',new AbortController().signal,malformed)).kind,'AMBIGUOUS');assert.equal(calls,2);
  });
  test(`${channel}: opaque conversation key and preflight cancellation never reach a provider`,async()=>{
    const forbidden:typeof fetch=async()=>assert.fail('No provider call');
    assert.equal((await sendNativeKnowledge(connection,'whatsapp:77:opaque-key','Answer',new AbortController().signal,forbidden)).kind,'DEFINITIVELY_UNSENT');
    const abort=new AbortController();abort.abort();assert.equal((await sendNativeKnowledge(connection,recipient,'Answer',abort.signal,forbidden)).kind,'DEFINITIVELY_UNSENT');
  });
}
test('all host controls default off independently; disabled construction/start/admission/tick perform no work',async()=>{
  assert.deepEqual(nativeAsyncControls({}),{admission:false,processing:false,delivery:false,executionMs:20000});
  for(const name of ['ADMISSION','PROCESSING','DELIVERY']){
    const c=nativeAsyncControls({['ODINLINK_ASYNC_KNOWLEDGE_'+name]:'true'});assert.equal(Number(c.admission)+Number(c.processing)+Number(c.delivery),1);
  }
  const no=()=>assert.fail('Disabled runtime must not access a repository/provider');
  const runtime=new NativeKnowledgeRuntime({db:{from:no,rpc:no},secret:'synthetic-secret-with-at-least-32-bytes',controls:()=>nativeAsyncControls({}),execute:async()=>no()});
  runtime.start(250);assert.equal(await runtime.accept({businessId:77,channel:'telegram',account:'123',recipient,eventId:'event',order:null}),null);
  assert.deepEqual(await runtime.tick(),{ran:false,deliveries:[]});assert.equal(await runtime.stop(),true);
});
