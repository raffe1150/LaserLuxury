import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryKnowledgeStorage, KnowledgeService, knowledgeSourceRevision, type KnowledgeSearchMatch } from '../../knowledge';
import { documentChunks } from './documents/service';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity } from './embedding-backfill';

async function fixture(count=5,chars=40) {
 const storage=new InMemoryKnowledgeStorage(),service=new KnowledgeService(storage);
 const parsed=documentChunks(Array.from({length:count},(_,i)=>({text:`Customer entrance section ${i}. `+'x'.repeat(chars),page:i+1})),'Guide.txt');
 const source={id:'guide',businessId:77,type:'document' as const,status:'ready' as const,title:'Guide.txt',content:parsed.content,metadata:parsed.metadata,createdAt:'2026',updatedAt:'2026'};
 await storage.create(source);
 const rows:KnowledgeSearchMatch[]=parsed.chunks.map(c=>({sourceId:source.id,businessId:77,text:String(c.content),score:1,metadata:{...(c.metadata as any),documentRevision:knowledgeSourceRevision(source)}}));
 return {storage,service,source,rows};
}
test('current lexical source expands to five canonical chunks without storage writes',async()=>{
 const f=await fixture(),before=JSON.stringify(await f.storage.list(77));
 const result=await f.service.completeSelectedDocuments(77,f.rows.slice(0,2),[f.rows[0]]);
 assert.equal(result?.length,5);assert.deepEqual(result?.map(m=>m.text),f.rows.map(m=>m.text));
 assert.equal(JSON.stringify(await f.storage.list(77)),before);
});
for(const count of [6,20,50])test(`document with ${count} chunks cannot fit`,async()=>{
 const f=await fixture(count);assert.equal(await f.service.completeSelectedDocuments(77,[f.rows[0]],[f.rows[0]]),null);
});
for(const fault of ['missing-revision','stale','foreign','revoked','missing','broken-map'] as const)
test(`source completion fails closed: ${fault}`,async()=>{
 const f=await fixture();let hit=f.rows[0];
 if(fault==='missing-revision')hit={...hit,metadata:{...hit.metadata,documentRevision:undefined}};
 if(fault==='stale')await f.storage.create({...f.source,content:f.source.content+' Changed.'});
 if(fault==='foreign')hit={...hit,businessId:88};
 if(fault==='revoked')await f.storage.create({...f.source,status:'disabled'});
 if(fault==='missing')await f.storage.delete(77,'guide');
 if(fault==='broken-map'){
  const source={...f.source,metadata:{...f.source.metadata,segments:f.source.metadata.segments.slice(0,1)}};
  await f.storage.create(source);hit={...hit,metadata:{...hit.metadata,documentRevision:knowledgeSourceRevision(source)}};
 }
 assert.equal(await f.service.completeSelectedDocuments(77,[hit],[hit]),null);
});
test('a competing source is never displaced to fit a five-chunk PDF',async()=>{
 const f=await fixture();const text='The entrance is closed during construction.';
 const doc=documentChunks([{text}],'Conditions.txt');const source={...f.source,id:'conditions',content:doc.content,metadata:doc.metadata};await f.storage.create(source);
 const other={sourceId:source.id,businessId:77,text,score:1,metadata:{...(doc.chunks[0].metadata as any),documentRevision:knowledgeSourceRevision(source)}};
 const complete=await f.service.completeSelectedDocuments(77,[f.rows[0],other],[f.rows[0],other]);
 assert.equal(complete?.length,6);assert.ok(complete?.some(m=>m.text===text),'Competing condition survives grouping');
});
test('independently relevant TXT and conflicting conditions are retained when both fit',async()=>{
 const f=await fixture(3),text='Customer access is unavailable during construction.';
 const doc=documentChunks([{text}],'Conditions.txt');const source={...f.source,id:'conditions',content:doc.content,metadata:doc.metadata};await f.storage.create(source);
 const other={sourceId:source.id,businessId:77,text,score:1,metadata:{...(doc.chunks[0].metadata as any),documentRevision:knowledgeSourceRevision(source)}};
 const result=await f.service.completeSelectedDocuments(77,[f.rows[0],other],[f.rows[0],other]);
 assert.equal(result?.length,4);assert.ok(result?.some(m=>m.text===text),'Completion cannot resolve a conflict or hide a condition');
});
test('character packing overflow is not truncated into eligibility',async()=>{
 const f=await fixture(5,1790);assert.ok(f.source.content.length>9000);
 assert.equal(await f.service.completeSelectedDocuments(77,[f.rows[0]],[f.rows[0]]),null);
});
test('unselected, absent or semantic-only relevance cannot authorize expansion',async()=>{
 const f=await fixture();
 assert.equal(await f.service.completeSelectedDocuments(77,[f.rows[0]],[]),null);
 assert.equal(await f.service.completeSelectedDocuments(77,[f.rows[0]],[f.rows[1]]),null);
 assert.equal(await f.service.completeSelectedDocuments(77,[{...f.rows[0],score:0.54}],[]),null);
 for(const score of [0,NaN,Infinity])assert.equal(await f.service.completeSelectedDocuments(77,[f.rows[0]],[{...f.rows[0],score}]),null);
});
test('a partial semantic-only competitor cannot be completed by another source lexical anchor',async()=>{
 const f=await fixture(2),text='Different customer condition.';
 const doc=documentChunks([{text},{text:'Another condition.'}],'Other.txt');const source={...f.source,id:'other',content:doc.content,metadata:doc.metadata};await f.storage.create(source);
 const other={sourceId:source.id,businessId:77,text,score:0.8,metadata:{...(doc.chunks[0].metadata as any),documentRevision:knowledgeSourceRevision(source)}};
 assert.equal(await f.service.completeSelectedDocuments(77,[f.rows[0],other],[f.rows[0]]),null);
});
test('aborted completion returns no canonical expansion',async()=>{
 const f=await fixture(),c=new AbortController();c.abort();
 await assert.rejects(f.service.completeSelectedDocuments(77,[f.rows[0]],[f.rows[0]],{signal:c.signal}));
});
test('actual semantic retrieval still rejects a 0.54 distractor at the 0.55 threshold',async()=>{
 const f=await fixture(2);
 const vector=(cosine:number)=>({...identity,values:Array.from({length:768},(_,i)=>i===0?cosine:i===1?Math.sqrt(1-cosine*cosine):0)});
 await f.storage.replaceChunks(77,'guide',f.rows.map((m,i)=>({chunkIndex:i,content:m.text!,metadata:m.metadata})));
 f.storage.completeSemanticIndex(77,'guide',f.storage.indexSnapshot(77,'guide')!,f.rows.map(()=>vector(0.54)));
 const service=new KnowledgeService(f.storage,f.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>vector(1),embedDocuments:async()=>[]});
 const hits=await service.semanticSearchQueries(77,['Unrelated semantic query'],5);
 assert.deepEqual(hits,[]);
 assert.equal(await service.completeSelectedDocuments(77,hits,[]),null);
});
