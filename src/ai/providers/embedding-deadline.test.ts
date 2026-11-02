import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Embeddings} from 'openai/resources/embeddings';
import {ConfiguredEmbeddingProvider} from './embeddings';
import {CompatibleSemanticIndex} from '../../knowledge/semantic-index';
import {KnowledgeService,InMemoryKnowledgeStorage} from '../../../knowledge';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from '../../knowledge/embedding-backfill';
process.env.AI_PROVIDER='openai'; // Process-local offline fixture; SDK transport is always mocked.
const vector=()=>({...identity,values:Array.from({length:768},(_,i)=>i?0:1)});
const response=(input:string[])=>({data:input.map((_,index)=>({index,embedding:vector().values}))});
async function storageFixture(id:number,ready:boolean){
 const storage=new InMemoryKnowledgeStorage();const source={id:'guide',businessId:id,type:'text' as const,status:'ready' as const,title:'parking',content:'Nordpark garage',metadata:{},createdAt:'2026',updatedAt:'2026'};
 await storage.create(source);await storage.replaceChunks(id,source.id,[{chunkIndex:0,content:source.content}]);
 if(ready)storage.completeSemanticIndex(id,source.id,storage.indexSnapshot(id,source.id)!,[vector()]);
 return {storage,source};
}
test('bounded semantic owner reaches query-only SDK and database; parent abort stops in-flight work',{timeout:5000},async t=>{
 const {storage}=await storageFixture(77,true),seen:any[]=[],databaseSignals:AbortSignal[]=[];
 const read=storage.persistentSemanticSearch.bind(storage);
 storage.persistentSemanticSearch=async(r,o)=>{if(r.embeddings.length)databaseSignals.push(o!.signal!);return read(r,o);};
 let hold=false,release!:(r:any)=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 t.mock.method(Embeddings.prototype,'create',async(p:any,o:any)=>{
  assert.deepEqual(p.input,['parking'],'Customer requests embed queries, never the corpus');seen.push(o);
  if(hold){entered();return new Promise(r=>{release=r;});}return response(p.input);
 });
 const controller=new AbortController(),service=new KnowledgeService(storage,storage,new ConfiguredEmbeddingProvider(()=>undefined));
 assert.equal((await service.semanticSearchQueries(77,['parking'],5,{signal:controller.signal,timeoutMs:2500})).length,1);
 assert.equal(seen.length,1);assert.equal(seen[0].timeout,2500);assert.equal(seen[0].signal instanceof AbortSignal,true);
 assert.equal(databaseSignals[0],seen[0].signal,'One derived semantic owner covers query SDK and search');
 hold=true;const pending=service.semanticSearchQueries(77,['parking'],5,{signal:controller.signal,timeoutMs:2500});await started;controller.abort();
 assert.deepEqual(await pending,[]);assert.equal(seen[1].signal.aborted,true);assert.equal(databaseSignals.length,1,'Aborted query cannot reach search');
 release(response(['parking']));await Promise.resolve();
 assert.deepEqual(await service.semanticSearchQueries(77,['parking'],5,{signal:controller.signal,timeoutMs:1}),[]);
 assert.equal(seen.length,2,'Already aborted request cannot call SDK');
});
test('aborted corpus embedding cannot warm the cross-request vector cache',async()=>{
 const controller=new AbortController();let calls=0;
 const vector={provider:'openai',model:'synthetic',dimensions:1,version:1,values:[1]};
 const provider:any={embedDocuments:async()=>{calls++;if(calls===1)controller.abort();return[vector];}};
 const index=new CompatibleSemanticIndex(),chunks=[{sourceId:'pdf',businessId:77,text:'parking',metadata:{}}];
 await assert.rejects(index.searchQueries(77,chunks,[vector],provider,5,.55,{signal:controller.signal}));
 assert.equal((await index.searchQueries(77,chunks,[vector],provider,5,.55))[0].length,1);assert.equal(calls,2);
});
test('unbudgeted semantic queries stay bounded and never build a cold corpus or warm an unproven cache',{timeout:5000},async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:3000000});
 const {storage,source}=await storageFixture(790,false),seen:any[]=[],inputs:string[][]=[];let release!:(r:any)=>void;
 t.mock.method(Embeddings.prototype,'create',async(p:any,o:any)=>{seen.push(o);inputs.push(p.input);
  if(seen.length===1)return new Promise(r=>{release=r;});return response(p.input);
 });
 const service=new KnowledgeService(storage,storage,new ConfiguredEmbeddingProvider(()=>undefined));
 const pending=service.semanticSearchQueries(790,['parking'],5);
 const flush=async()=>{for(let i=0;i<200;i++)await Promise.resolve();};await flush();assert.equal(seen.length,1);
 t.mock.timers.tick(2500);await flush();assert.deepEqual(await pending,[]);assert.equal(seen[0].signal.aborted,true);assert.equal(seen[0].timeout,2500);
 release(response(['parking']));await flush();
 const coverage=await storage.persistentSemanticSearch({businessId:790,embeddings:[],limit:1,minSimilarity:.55,excludedChunks:[]});
 assert.equal(coverage.coverage.complete,false,'Late query results cannot publish a corpus index');
 assert.deepEqual(await service.semanticSearchQueries(790,['garage'],5),[]);assert.equal(seen.length,2);
 // Only explicit off-request fixture publication makes this revision usable.
 storage.completeSemanticIndex(790,source.id,storage.indexSnapshot(790,source.id)!,[vector()]);
 assert.equal((await service.semanticSearchQueries(790,['parking'],5)).length,1);assert.equal(seen.length,3);
 const restarted=new KnowledgeService(storage,storage,new ConfiguredEmbeddingProvider(()=>undefined));
 assert.equal((await restarted.semanticSearchQueries(790,['garage'],5)).length,1);assert.equal(seen.length,4,'Restart reuses the persisted generation, not a corpus cache');
 for(const input of inputs){assert.equal(input.length,1);assert.notEqual(input[0],source.content,'No customer-time corpus embedding');}
 for(const options of seen){assert.equal(options.timeout,2500);assert.equal(options.signal instanceof AbortSignal,true);}
});
