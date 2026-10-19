import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNativeOrder, nativeKnowledgeOrder } from './native-knowledge-order';
import { SupabaseOrderedKnowledgeRepository } from './supabase-ordered-knowledge-repository';
import type { KnowledgeScope } from './knowledge-lifecycle';

const atMs = 1792400000000;
for (const channel of ['whatsapp','telegram','instagram','messenger'] as const) {
  for (const [language, text] of Object.entries({ en:'Where can I park?', sv:'Var kan jag parkera?', de:'Wo kann ich parken?', es:'¿Dónde puedo aparcar?', fa:'کجا می‌توانم پارک کنم؟', ar:'أين يمكنني ركن السيارة؟' })) {
    test(`${channel}/${language}: capture provider order without retaining message content`, () => {
      const event = channel==='telegram' ? { update_id:102, message:{date:atMs/1000, text} } : channel==='whatsapp' ?
        { id:'wamid.opaque-zz==',timestamp:String(atMs/1000),text:{body:text} } : { timestamp:atMs,message:{mid:'opaque-aa',text} };
      assert.deepEqual(nativeKnowledgeOrder(channel,event),{atMs,sequence:channel==='telegram'?102:null});
      assert.deepEqual(Object.keys(nativeKnowledgeOrder(channel,event)!).sort(),['atMs','sequence']);
      assert.equal(nativeKnowledgeOrder(channel,{...event,timestamp:undefined,message:{text}}),null);
    });
  }
}
test('no receipt-time substitution, opaque-ID ordering, string coercion, echoes or fractional seconds', () => {
  assert.equal(nativeKnowledgeOrder('whatsapp',{id:'999999',timestamp:'not-a-time'}),null);
  assert.equal(nativeKnowledgeOrder('telegram',{update_id:'102',message:{date:atMs/1000}}),null);
  assert.equal(nativeKnowledgeOrder('telegram',{update_id:102,message:{date:atMs/1000+0.1}}),null);
  assert.equal(nativeKnowledgeOrder('messenger',{timestamp:String(atMs),message:{mid:'102'}}),null);
  assert.equal(nativeKnowledgeOrder('instagram',{timestamp:atMs,message:{is_echo:true}}),null);
  assert.throws(()=>captureNativeOrder('whatsapp',{atMs,sequence:102}));
  assert.throws(()=>captureNativeOrder('telegram',{atMs,sequence:null}));
  assert.throws(()=>captureNativeOrder('telegram',{atMs,sequence:102,recipient:'unchecked'}));
});
function fixture(disposition='ACCEPTED', withInbox=true) {
  const scope:KnowledgeScope={businessId:77,channel:'whatsapp',providerAccount:'acct',conversationId:'11111111-1111-4111-8111-111111111111'};
  const calls: any[]=[];let failed=false;
  const row={conversation_key:'canonical',knowledge_channel:null,knowledge_account:null};
  const db={from:()=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:row,error:null})};return q;},
    rpc:async(name:string,args:any)=>{calls.push({name,args});return failed?{data:null,error:{message:'must-not-leak-secret'}}:{error:null,data:{
      disposition,mayAttach:disposition==='ACCEPTED'||disposition==='DUPLICATE',inserted:disposition==='ACCEPTED',task:null,
      inbox:withInbox?{knowledge_turn_id:'22222222-2222-4222-8222-222222222222',provider_event_id:'opaque-event',knowledge_sequence:1,
        knowledge_accepted_at:new Date(atMs).toISOString(),knowledge_expires_at:new Date(atMs+40000).toISOString()}:null}};}};
  const repo=new SupabaseOrderedKnowledgeRepository(db,async()=> 'canonical',async()=>false);
  return {repo,scope,calls,fail:()=>{failed=true;}};
}
test('ordered repository submits only v2, canonical scope and bounded original input',async()=>{
  const f=fixture();const input={question:'Parking?',language:'en',history:[{role:'user' as const,content:'Earlier context'}]};
  const order={atMs,sequence:null};const scope={...f.scope};
  const pending=f.repo.acceptOrdered(scope,'opaque-event',order,input,{executionMs:35000});
  input.question='mutated';input.history[0].content='mutated';order.atMs++;scope.providerAccount='foreign';
  const result=await pending;assert.equal(result.acceptance!.identity.eventId,'opaque-event');assert.equal(result.disposition,'ACCEPTED');
  assert.equal(f.calls.length,1);const call=f.calls[0];assert.equal(call.name,'odin_accept_knowledge_turn_v2');
  assert.equal(call.args.p_key,'canonical');assert.equal(call.args.p_account,'acct');assert.equal(call.args.p_execution_ms,35000);
  assert.equal(call.args.p_order.atMs,atMs);assert.equal(call.args.p_input.question,'Parking?');assert.equal(call.args.p_input.history[0].content,'Earlier context');
});
for(const disposition of ['DUPLICATE','STALE','AMBIGUOUS','BLOCKED'])test(`explicit ${disposition} cannot masquerade as an accepted new turn`,async()=>{
  const f=fixture(disposition,['DUPLICATE','AMBIGUOUS'].includes(disposition));
  const result=await f.repo.acceptOrdered(f.scope,'opaque-event',null);
  assert.equal(result.disposition,disposition);assert.equal(result.acceptance?.task??null,null);
  if(disposition==='STALE'||disposition==='BLOCKED')assert.equal(result.acceptance,null);
});
test('no constructor side effects, v1 fallback, or unsafe default accept method',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);
  await assert.rejects(f.repo.accept(f.scope,'event'),/knowledge_native_order_required/);assert.equal(f.calls.length,0);
  f.fail();await assert.rejects(f.repo.acceptOrdered(f.scope,'event',{atMs,sequence:null}),/^Error: knowledge_repository_operation_failed$/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'odin_accept_knowledge_turn_v2');
});
test('malformed admission envelopes fail closed instead of authorizing work', async()=>{
  const missing=fixture('ACCEPTED',false);
  await assert.rejects(missing.repo.acceptOrdered(missing.scope,'event',null),/knowledge_invalid_ordered_response/);
  const stale=fixture('STALE',true);
  await assert.rejects(stale.repo.acceptOrdered(stale.scope,'event',null),/knowledge_invalid_ordered_response/);
});
