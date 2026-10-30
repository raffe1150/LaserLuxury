import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryKnowledgeStorage,KnowledgeService,type KnowledgeSource} from '../../knowledge';
import {mixedBusinesses} from '../../tests/fixtures/mixed-source-questions';

// Explicit synthetic vectors: test source/identity lifecycle, not semantic quality.
for(const business of mixedBusinesses)test(`persistent generation lifecycle ${business.id}: cold, warm, restart, revision, identity, expiry and revocation`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:1792710000000});
 const storage=new InMemoryKnowledgeStorage(),calls:string[][]=[];let version=1;
 const source:KnowledgeSource={id:'guide',businessId:business.id,type:'document',title:'guide',status:'ready',content:business.source,metadata:{segments:[{start:0,end:business.source.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'};
 await storage.create(source);
 await storage.replaceChunks(business.id,source.id,[{chunkIndex:0,content:source.content,metadata:{source:'document',section:'Text'}}]);
 const v=()=>({provider:'openai',model:'text-embedding-3-small',version,dimensions:768,values:Array.from({length:768},(_,i)=>i===0?1:0)});
 const foreign='Foreign secret that must never be embedded.';await storage.create({...source,id:'foreign',businessId:777,content:foreign,metadata:{segments:[{start:0,end:foreign.length,section:'Text'}]}});
 const provider={supportsLocalSemanticSearch:true,embedQuery:async()=>{throw Error('Batch contract required');},embedDocuments:async(texts:string[])=>{calls.push([...texts]);return texts.map(()=>v());}};
 storage.completeSemanticIndex(business.id,source.id,storage.indexSnapshot(business.id,source.id)!,[v()]);
 const service=new KnowledgeService(storage,storage,provider),query='What is the documented scope?';
 const cold=await service.semanticSearchQueries(business.id,[query]);assert.equal(calls.length,1);assert.equal(cold.length,1);assert.equal(cold[0].text,business.source);
 await service.semanticSearchQueries(business.id,[query]);assert.equal(calls.length,2,'Warm request embeds only its question');
 const restarted=new KnowledgeService(storage,storage,provider);await restarted.semanticSearchQueries(business.id,[query]);assert.equal(calls.length,3,'Restart reuses durable generation, not a corpus cache');
 const captured=await service.validateMatches(business.id,cold,{strictSources:true,captureRevision:true});
 await storage.create({...source,updatedAt:'2027'});await service.semanticSearchQueries(business.id,[query]);assert.equal(calls.length,4);
 assert.equal((await service.validateMatches(business.id,captured,{strictSources:true})).length,1);
 await storage.create({...source,metadata:{segments:[{start:0,end:business.source.length,section:'Revised provenance'}]}});
 assert.deepEqual(await service.semanticSearchQueries(business.id,[query]),[]);assert.equal(calls.length,5,'Changed provenance cannot trigger customer-time rebuilding');
 assert.deepEqual(await service.validateMatches(business.id,captured,{strictSources:true}),[]);
 await storage.create(source);version=2;assert.deepEqual(await service.semanticSearchQueries(business.id,[query]),[]);assert.equal(calls.length,6,'Incompatible query identity fails closed without rebuilding');
 version=1;t.mock.timers.tick(300001);assert.equal((await service.semanticSearchQueries(business.id,[query])).length,1);assert.equal(calls.length,7,'Persistent proof survives local cache expiry');
 await storage.create({...source,status:'disabled'});assert.deepEqual(await service.semanticSearchQueries(business.id,[query]),[]);assert.equal(calls.length,8);
 await storage.delete(business.id,source.id);assert.deepEqual(await service.semanticSearchQueries(business.id,[query]),[]);assert.equal(calls.length,9);
 assert.deepEqual(await service.validateMatches(777,cold,{strictSources:true}),[]);assert.ok(calls.every(batch=>batch.every(text=>!text.includes('Foreign secret'))));
});
