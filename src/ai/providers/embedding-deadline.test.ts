import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Embeddings} from 'openai/resources/embeddings';
import {ConfiguredEmbeddingProvider} from './embeddings';
import {CompatibleSemanticIndex} from '../../knowledge/semantic-index';
import {KnowledgeService,InMemoryKnowledgeStorage} from '../../../knowledge';
test('same bounded abort signal reaches query and cold corpus OpenAI SDK requests',async t=>{
 const env={...process.env};Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-only'});t.after(()=>{for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);});
 const controller=new AbortController();const seen:any[]=[];
 t.mock.method(Embeddings.prototype,'create',async(p:any,o:any)=>{seen.push(o);return{data:p.input.map((_:string,index:number)=>({index,embedding:Array.from({length:768},(_,i)=>i?0:1)}))};});
 const provider=new ConfiguredEmbeddingProvider(()=>undefined),storage=new InMemoryKnowledgeStorage();
 await storage.create({id:'pdf',businessId:77,type:'text',status:'ready',title:'parking',content:'Nordpark garage',metadata:{},createdAt:'2026',updatedAt:'2026'});
 const service=new KnowledgeService(storage,storage,provider);assert.equal((await service.semanticSearchQueries(77,['parking'],5,{signal:controller.signal,timeoutMs:2500})).length,1);
 assert.equal(seen.length,2);for(const o of seen){assert.equal(o.signal,controller.signal);assert.equal(o.timeout,2500);}
 controller.abort();assert.deepEqual(await service.semanticSearchQueries(77,['parking'],5,{signal:controller.signal,timeoutMs:1}),[]);assert.equal(seen.length,2,'Already aborted request cannot call SDK');
});
test('aborted corpus embedding cannot warm the cross-request vector cache',async()=>{
 const controller=new AbortController();let calls=0;
 const vector={provider:'openai',model:'synthetic',dimensions:1,version:1,values:[1]};
 const provider:any={embedDocuments:async()=>{calls++;if(calls===1)controller.abort();return[vector];}};
 const index=new CompatibleSemanticIndex(),chunks=[{sourceId:'pdf',businessId:77,text:'parking',metadata:{}}];
 await assert.rejects(index.searchQueries(77,chunks,[vector],provider,5,.55,{signal:controller.signal}));
 assert.equal((await index.searchQueries(77,chunks,[vector],provider,5,.55))[0].length,1);assert.equal(calls,2);
});
test('unbudgeted cold semantic-only retrieval keeps slow SDK results and reusable corpus cache',async t=>{
 const env={...process.env};Object.assign(process.env,{AI_PROVIDER:'openai',OPENAI_API_KEY:'synthetic-only'});t.after(()=>{for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);});
 let calls=0;const seen:any[]=[];
 t.mock.method(Embeddings.prototype,'create',async(p:any,o:any)=>{
  calls++;seen.push(o);if(calls===1)await new Promise(r=>setTimeout(r,2700));
  return{data:p.input.map((_:string,index:number)=>({index,embedding:Array.from({length:768},(_,i)=>i?0:1)}))};
 });
 const storage=new InMemoryKnowledgeStorage();await storage.create({id:'legacy-cold',businessId:790,type:'text',status:'ready',title:'garage',content:'Nordpark garage',metadata:{},createdAt:'2026',updatedAt:'2026'});
 const service=new KnowledgeService(storage,storage,new ConfiguredEmbeddingProvider(()=>undefined));
 assert.equal((await service.semanticSearchQueries(790,['parking'],5)).length,1);assert.equal(calls,2);
 for(const options of seen){assert.equal(options?.signal,undefined);assert.notEqual(options?.timeout,2500);}
 assert.equal((await service.semanticSearchQueries(790,['garage'],5)).length,1);assert.equal(calls,3,'Unaborted cold corpus can warm the shared index; new query still embeds');
});
