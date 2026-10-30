import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleEmbeddingProvider } from '../../ai/embeddings';
import { embedWithOpenAi } from '../../ai/providers/openai';
import { OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as openai, KNOWLEDGE_BACKFILL_EMBEDDING_IDENTITY as google } from '../embedding-backfill';
import { createSourceIndexProvider } from './indexing-provider';
import { SourceIndexCoordinator, SupabaseSourceIndexRepository } from './indexing';
import { documentServiceForClient, startDocumentRecovery, newDocumentIndexingOptions, createDocumentRuntime } from './runtime';

const newUploadPolicy={version:'new-documents-v1',notBefore:'2026-11-01T00:00:00.000Z',allowedBusinessIds:[77],maxSources:2,maxRequests:2,maxInputChars:9000,maxInputBytes:36000};
test('existing production runtime entry installs only explicitly configured new-upload recovery',async t=>{
 const original={...process.env},beforeTerm=new Set(process.listeners('SIGTERM')),beforeInt=new Set(process.listeners('SIGINT'));
 Object.assign(process.env,{KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED:'true',SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_offline'});
 const requests:URL[]=[];
 t.mock.method(globalThis,'fetch',async(input)=>{
  const url=new URL(String(input));assert.equal(url.hostname,'offline.invalid');assert.match(url.pathname,/knowledge_sources$/u);
  requests.push(url);return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});
 });
 try{
  delete process.env.ODINLINK_DOCUMENT_INDEXING_POLICY;
  assert.deepEqual(await createDocumentRuntime().recoverIndex(),[]);assert.equal(requests.length,0);
  process.env.ODINLINK_DOCUMENT_INDEXING_POLICY=JSON.stringify(newUploadPolicy);
  const service=createDocumentRuntime();assert.deepEqual(await service.recoverIndex(),[]);service.stopIndexing();
  assert.equal(requests.length,1);assert.equal(requests[0].searchParams.get('created_at'),'gte.'+newUploadPolicy.notBefore);
  assert.equal(requests[0].searchParams.get('type'),'eq.document');assert.equal(requests[0].searchParams.get('business_id'),'eq.77');
 }finally{
  for(const listener of process.listeners('SIGTERM'))if(!beforeTerm.has(listener))process.removeListener('SIGTERM',listener);
  for(const listener of process.listeners('SIGINT'))if(!beforeInt.has(listener))process.removeListener('SIGINT',listener);
  for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);
 }
});
test('new-upload indexing is default-off and requires explicit bounded policy without provider calls',()=>{
 const signal=new AbortController().signal;
 assert.equal(newDocumentIndexingOptions(undefined,signal),undefined);
 const options=newDocumentIndexingOptions(JSON.stringify(newUploadPolicy),signal)!;
 assert.equal(options.newDocumentsSince,newUploadPolicy.notBefore);assert.deepEqual(options.identity,openai);
 for(const invalid of [{}, {...newUploadPolicy,notBefore:''},{...newUploadPolicy,allowedBusinessIds:[]},{...newUploadPolicy,maxRequests:0},
  {...newUploadPolicy,maxInputChars:1_000_001},{...newUploadPolicy,maxSources:Infinity}])
  assert.throws(()=>newDocumentIndexingOptions(JSON.stringify(invalid),signal));
});

test('new-upload recovery survives restart with the same cutoff and excludes historical ready sources',async()=>{
 const id='77000000-0000-4000-8000-000000000001',calls:any[]=[];
 const row={id,business_id:77,type:'document',status:'ready',created_at:newUploadPolicy.notBefore};
 let returned:any[]= [row];
 const client={from:(table:string)=>{
  assert.equal(table,'knowledge_sources');
  const q:any={};for(const method of ['select','eq','order','limit','gte','gt'])q[method]=(...args:any[])=>{calls.push([method,...args]);return q;};
  q.then=(resolve:any)=>Promise.resolve({data:returned,error:null}).then(resolve);return q;
 }};
 for(let restart=0;restart<2;restart++){
  const repo=new SupabaseSourceIndexRepository(client,newUploadPolicy.notBefore);
  assert.deepEqual(await repo.scan(77,null,new AbortController().signal),[row]);
  assert.ok(calls.some(c=>c[0]==='gte'&&c[1]==='created_at'&&c[2]===newUploadPolicy.notBefore));
  assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='type'&&c[2]==='document'));
 }
 const repo=new SupabaseSourceIndexRepository(client,newUploadPolicy.notBefore);
 for(const bad of [{...row,created_at:'2026-10-16T00:00:00.000Z'},{...row,type:'text'},{...row,business_id:88},{...row,created_at:undefined}]){
  returned=[bad];await assert.rejects(repo.scan(77,null,new AbortController().signal),/configuration/);
 }
});

test('provider construction pins explicit identities without reading a key or calling a provider',()=>{
  let reads=0;const key=()=>{reads++;throw new Error('No key access allowed');};
  assert.equal(createSourceIndexProvider(openai,key).embedDocuments,embedWithOpenAi);
  assert.ok(createSourceIndexProvider(google,key) instanceof GoogleEmbeddingProvider);
  assert.throws(()=>createSourceIndexProvider({...openai,version:2} as any,key),/invalid_identity/);
  assert.equal(reads,0);
});

test('Google optional indexing settings are bounded, abortable and single-attempt; ordinary shape is unchanged',async()=>{
  const requests:any[]=[];const controller=new AbortController();
  const provider=new GoogleEmbeddingProvider({apiKeyProvider:()=> 'synthetic-unused',clientFactory:()=>({models:{embedContent:async request=>{
    requests.push(request);return {embeddings:[{values:Array.from({length:768},(_,i)=>i===0?1:0)}]};
  }}})});
  await provider.embedDocuments(['Synthetic']);assert.deepEqual(requests[0].config,{outputDimensionality:768});
  await provider.embedDocuments(['Synthetic'],{signal:controller.signal,timeoutMs:20_000});
  assert.deepEqual(requests[1].config,{outputDimensionality:768,abortSignal:controller.signal,httpOptions:{timeout:20_000,retryOptions:{attempts:1}}});
  controller.abort();await assert.rejects(provider.embedDocuments(['Synthetic'],{signal:controller.signal}));assert.equal(requests.length,2);
});

test('index configuration rejects unbounded scopes and request budgets before any transport access',()=>{
  const repo=new SupabaseSourceIndexRepository({rpc:()=>{throw new Error('no transport');}});
  const provider={embedDocuments:async()=>{throw new Error('no provider');}};
  const limits={allowedBusinessIds:[77],maxSources:1,maxRequests:1,maxInputChars:100,maxInputBytes:400};
  for(const change of [{allowedBusinessIds:[]},{allowedBusinessIds:[-1]},{maxSources:51},{maxRequests:101},{maxInputChars:1_000_001},{maxInputBytes:4_000_001}])
    assert.throws(()=>new SourceIndexCoordinator(repo,provider,openai,{...limits,...change}),/invalid_configuration/);
});

test('job deadline cancellation retains its timeout category instead of appearing as operator shutdown',async()=>{
  const repo=new SupabaseSourceIndexRepository({rpc:()=>Promise.resolve({data:true,error:null})});
  const deadline=new AbortController();deadline.abort({code:'provider_timeout'});
  await assert.rejects(repo.renew({businessId:77,sourceId:'77000000-0000-4000-8000-000000000001'},
    {lease_token:'77000000-0000-4000-8000-000000000002'} as any,deadline.signal),/provider_timeout/);
});

test('existing service construction has no indexing; malformed opt-in does not disable text processing',async t=>{
  const client={rpc:()=>{throw new Error('No RPC allowed');}};
  const plain=documentServiceForClient(client as any);assert.deepEqual(await plain.recoverIndex(),[]);
  const warn=t.mock.method(console,'warn',()=>{});
  const invalid=documentServiceForClient(client as any,{provider:{embedDocuments:async()=>{throw new Error('No provider allowed');}},identity:openai,shutdownSignal:new AbortController().signal,
    limits:{allowedBusinessIds:[],maxSources:1,maxRequests:1,maxInputChars:100,maxInputBytes:400}});
  assert.deepEqual(await invalid.recoverIndex(),[]);assert.equal(warn.mock.callCount(),1);
  await assert.rejects(invalid.retry(77,'synthetic'),/No RPC allowed/);
});

test('explicit runtime indexing requires a host shutdown signal and is fenced when it aborts',async()=>{
  const host=new AbortController();const client={rpc:()=>{throw new Error('No transport after shutdown');}};
  const service=documentServiceForClient(client as any,{provider:{embedDocuments:async()=>{throw new Error('No provider allowed');}},identity:openai,
    limits:{allowedBusinessIds:[77],maxSources:1,maxRequests:1,maxInputChars:100,maxInputBytes:400},shutdownSignal:host.signal});
  host.abort();assert.deepEqual(await service.recoverIndex(),[]);
});

test('one existing recovery timer owns extraction/indexing, excludes overlaps and aborts indexing on shutdown',async t=>{
  const before=process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED;process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED='true';
  let tick!:()=>void;let extracted=0,indexed=0,stopped=0,cleared=0,release!:()=>void;
  const pending=new Promise<void>(r=>release=r);
  t.mock.method(globalThis,'setInterval',((fn:()=>void,ms:number)=>{assert.equal(ms,10_000);tick=fn;return{unref(){}};}) as any);
  t.mock.method(globalThis,'clearInterval',(()=>{cleared++;}) as any);
  const service={recover:async()=>{extracted++;await pending;},recoverIndex:async()=>{indexed++;await pending;},stopIndexing:()=>{stopped++;}};
  try{
    const stop=startDocumentRecovery(service as any);assert.equal(extracted,1);assert.equal(indexed,1);
    tick();assert.equal(extracted,1);assert.equal(indexed,1);release();await new Promise(resolve=>setImmediate(resolve));
    tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(extracted,2);assert.equal(indexed,2);
    stop();tick();assert.equal(extracted,2);assert.equal(stopped,1);assert.equal(cleared,1);
  }finally{if(before===undefined)delete process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED;else process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED=before;}
});

test('disabled upload/recovery flag cannot start indexing',async()=>{
  const before=process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED;process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED='false';let work=0,stops=0;
  try{const stop=startDocumentRecovery({recover:async()=>{work++;},recoverIndex:async()=>{work++;},stopIndexing:()=>{stops++;}} as any);
    assert.equal(work,0);stop();assert.equal(stops,1);
  }finally{if(before===undefined)delete process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED;else process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED=before;}
});

test('recovery reports bounded failure categories without raw errors or repeated identical warnings',async t=>{
  const before=process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED;process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED='true';let tick!:()=>void;
  t.mock.method(globalThis,'setInterval',((fn:()=>void)=>{tick=fn;return{unref(){}};}) as any);t.mock.method(globalThis,'clearInterval',(()=>{}) as any);
  const warn=t.mock.method(console,'warn',()=>{});
  const service={recover:async()=>{},recoverIndex:async()=>[{status:'failed',reason:'storage'},{status:'failed',reason:'sensitive unrelated error text'}],stopIndexing:()=>{}};
  try{const stop=startDocumentRecovery(service as any);await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(warn.mock.calls[0].arguments,['[KnowledgeDocuments] index recovery incomplete',{storage:1,unknown:1}]);
    tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(warn.mock.callCount(),1);stop();
  }finally{if(before===undefined)delete process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED;else process.env.KNOWLEDGE_DOCUMENT_UPLOADS_ENABLED=before;}
});
