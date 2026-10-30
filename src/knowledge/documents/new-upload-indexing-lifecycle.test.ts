import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { documentChunks } from './service';
import { documentServiceForClient, newDocumentIndexingOptions } from './runtime';
import { SupabaseSourceIndexRepository } from './indexing';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity } from '../embedding-backfill';

// In-memory transport doubles only. No PostgreSQL, Supabase or provider request.
function fixture(t:any,mode:'normal'|'revoked'|'invalid'|'timeout'='normal') {
 const id='77000000-0000-4000-8000-000000000001',created='2026-11-01T01:00:00.000Z';
 const bytes=Buffer.from('Synthetic visitor instructions.');
 const extracted=documentChunks([{text:bytes.toString(),section:'Text'}],'new.txt');
 const source={id,business_id:77,type:'document',title:'new.txt',status:'processing',content:extracted.content,metadata:extracted.metadata,created_at:created};
 let ready=false,commits=0,embeddings=0,revision=1,failures=0;
 const snapshot=()=>({businessId:77,sourceId:id,status:'ready' as const,snapshotToken:`snapshot-${revision}`,chunks:extracted.chunks.map((c:any,i)=>({
  id:`chunk-${i}`,businessId:77,sourceId:id,chunkIndex:c.chunk_index,content:c.content,metadata:c.metadata,
  embedding:null,embeddingProvider:null,embeddingModel:null,embeddingDimensions:null,embeddingVersion:null}))});
 const repo=SupabaseSourceIndexRepository.prototype;
 t.mock.method(repo,'scan',async()=>source.status==='ready'?[structuredClone(source)]:[]);
 t.mock.method(repo,'eligible',async()=>!ready&&source.status==='ready');
 t.mock.method(repo,'prepare',async()=>{
  if(source.status!=='ready')throw Error('Source revoked');
  return {source:structuredClone(source),snapshot:snapshot()};
 });
 t.mock.method(repo,'claim',async()=>({admitted:true,lease_token:'77000000-0000-4000-8000-000000000002',content_revision:'a'.repeat(64),identity,
  canonical_version:1,snapshot_token:`snapshot-${revision}`,job_deadline:new Date(Date.now()+60_000).toISOString(),
  chunks:snapshot().chunks.map(c=>({id:c.id,business_id:77,source_id:id,chunk_index:c.chunkIndex,content:c.content,metadata:c.metadata,embedding:null}))}));
 t.mock.method(repo,'renew',async()=>{});
 t.mock.method(repo,'fail',async()=>{failures++;});
 t.mock.method(repo,'complete',async(_scope:any,_claim:any,chunks:any[])=>{
  assert.equal(source.status,'ready');assert.equal(chunks.length,1);assert.equal(chunks[0].content,bytes.toString());
  assert.equal(chunks[0].embedding_provider,'openai');assert.equal(chunks[0].embedding.length,768);commits++;ready=true;
 });
 const client={rpc:async(_name:string,p:any)=>{
  if(p.p_action==='claim')return {data:{source_id:id,business_id:77,object_key:`77/${id}/original.txt`,filename:'new.txt',format:'txt',mime:'text/plain',bytes:bytes.length,
   sha256:createHash('sha256').update(bytes).digest('hex'),lease_token:'77000000-0000-4000-8000-000000000003'},error:null};
  assert.equal(p.p_action,'finish');source.status='ready';return {data:true,error:null};
 },storage:{getBucket:async()=>({data:{public:false,file_size_limit:5*1024*1024},error:null}),from:()=>({download:async()=>({data:new Blob([bytes]),error:null})})}};
 const host=new AbortController();
 const options=newDocumentIndexingOptions(JSON.stringify({version:'new-documents-v1',notBefore:'2026-11-01T00:00:00.000Z',allowedBusinessIds:[77],
  maxSources:2,maxRequests:2,maxInputChars:9000,maxInputBytes:36000}),host.signal)!;
 options.provider={embedDocuments:async(texts,request)=>{
  embeddings++;assert.deepEqual(texts,[bytes.toString()]);assert.equal(request?.timeoutMs,20_000);
  if(mode==='revoked')source.status='deleted';
  if(mode==='timeout')return new Promise((_,reject)=>request!.signal!.addEventListener('abort',()=>reject(request!.signal!.reason),{once:true}));
  return texts.map(()=>({...identity,values:Array.from({length:768},(_,i)=>mode==='invalid'?0:i===0?1:0)}));
 }};
 return {id,source,host,service:()=>documentServiceForClient(client as any,options),counts:()=>({commits,embeddings,failures}),
  revise:()=>{revision++;ready=false;}};
}

test('new Ready upload indexes off-request, survives restart, and reindexes a changed revision',async t=>{
 const f=fixture(t);t.after(()=>f.host.abort());const service=f.service();
 await service.process(77,f.id);assert.equal(f.source.status,'ready');assert.equal(f.counts().embeddings,0);
 assert.deepEqual(await service.recoverIndex(),[{status:'ready',reason:'committed'}]);assert.equal(f.counts().embeddings,1);
 assert.deepEqual(await f.service().recoverIndex(),[{status:'skipped',reason:'ineligible'}]);assert.equal(f.counts().embeddings,1);
 f.revise();assert.deepEqual(await service.recoverIndex(),[{status:'ready',reason:'committed'}]);assert.equal(f.counts().embeddings,2);
 f.host.abort();assert.deepEqual(await service.recoverIndex(),[]);
});
for(const mode of ['revoked','invalid'] as const)test(`new-upload ${mode} result cannot commit an index`,async t=>{
 const f=fixture(t,mode);t.after(()=>f.host.abort());const service=f.service();await service.process(77,f.id);
 const result=await service.recoverIndex();assert.equal(result[0].status,'failed');assert.equal(f.counts().commits,0);assert.equal(f.counts().embeddings,1);
});
test('new-upload embedding timeout aborts work without publishing a partial index',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-11-01T02:00:00.000Z')});
 const f=fixture(t,'timeout');t.after(()=>f.host.abort());const service=f.service();await service.process(77,f.id);
 const pending=service.recoverIndex();for(let i=0;i<60;i++)await Promise.resolve();assert.equal(f.counts().embeddings,1);
 t.mock.timers.tick(20_001);assert.deepEqual(await pending,[{status:'failed',reason:'provider_timeout'}]);assert.equal(f.counts().commits,0);
});
