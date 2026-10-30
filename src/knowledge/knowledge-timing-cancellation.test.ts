import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryKnowledgeStorage, KnowledgeService, SupabaseKnowledgeStorage } from '../../knowledge';
import { NativeKnowledgeTiming } from '../ai/knowledge-timing-policy';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity } from './embedding-backfill';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('current-source validation forwards the original cancellation signal to storage',async()=>{
 const storage=new InMemoryKnowledgeStorage(),service=new KnowledgeService(storage,storage),controller=new AbortController();
 let received:AbortSignal|undefined;
 storage.list=async(id,options?:any)=>{assert.equal(id,77);received=options?.signal;received?.throwIfAborted();return[];};
 assert.deepEqual(await service.validateMatches(77,[],{strictSources:true,signal:controller.signal}),[]);
 assert.equal(received,controller.signal);controller.abort(Error('source-check cancelled'));
 await assert.rejects(service.validateMatches(77,[],{signal:controller.signal}),/cancelled/);
});
test('lexical SQL search keeps its tenant binding and forwards cancellation to the existing RPC',async()=>{
 const controller=new AbortController();let received:AbortSignal|undefined,params:any;
 const storage=new SupabaseKnowledgeStorage({rpc:(name,args)=>{
  assert.equal(name,'search_knowledge_chunks');params=args;
  return{abortSignal(signal:AbortSignal){received=signal;return Promise.resolve({data:[],error:null});}};
 }} as any);
 assert.deepEqual(await storage.search(88,'visitor policy',5,{signal:controller.signal}),[]);
 assert.equal(params.p_business_id,88);assert.equal(received,controller.signal);
 controller.abort(Error('expired'));
 await assert.rejects(storage.search(88,'visitor policy',5,{signal:controller.signal}),/expired/);
});
test('optional query embedding timeout retains underlying ownership until an uncooperative embedding settles',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000000});
 const timing=new NativeKnowledgeTiming();t.after(()=>timing.close());
 let release!:(value:any)=>void,received:AbortSignal|undefined,settled=false,calls=0;
 const pending=new Promise<any>(resolve=>{release=resolve;});
 const storage=new InMemoryKnowledgeStorage();
 const service=new KnowledgeService(storage,storage,{supportsLocalSemanticSearch:true,
  embedQuery:async(_q,options)=>{calls++;received=options?.signal;return pending;},embedDocuments:async()=>{throw Error('Corpus embedding forbidden');}});
 const search=service.semanticSearch(77,'semantic-only request',5,.55,{signal:timing.signal,timeoutMs:2500,observe:p=>timing.observe(p)});
 await flush();t.mock.timers.tick(2500);await flush();assert.deepEqual(await search,[]);
 assert.ok(received?.aborted);assert.equal(calls,1);
 const drained=timing.drain().then(()=>{settled=true;});await flush();assert.equal(settled,false);
 release({...identity,values:Array.from({length:768},(_,i)=>i===0?1:0)});await drained;
 assert.equal(settled,true);assert.ok(timing.events.some(e=>e.pending===1));
});
