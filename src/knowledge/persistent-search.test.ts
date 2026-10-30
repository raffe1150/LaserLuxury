import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {InMemoryKnowledgeStorage,KnowledgeService,SupabaseKnowledgeStorage} from '../../knowledge';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from './embedding-backfill';
import {parsePersistentSearch,compatibleQuery,type SemanticStatus,type PersistentSearchRequest} from './persistent-search';
const v=()=>({...identity,values:Array.from({length:768},(_,i)=>i===0?1:0)});
async function fixture(){
 const storage=new InMemoryKnowledgeStorage();const source={id:'synthetic-local',businessId:77,type:'text' as const,status:'ready' as const,title:'Visitor guide',content:'Bring identification only if available.',metadata:{},createdAt:'2026',updatedAt:'2026'};
 await storage.create(source);await storage.replaceChunks(77,source.id,[{chunkIndex:0,content:source.content,metadata:{}}]);
 storage.completeSemanticIndex(77,source.id,storage.indexSnapshot(77,source.id)!,[v()]);
 const request:PersistentSearchRequest={businessId:77,embeddings:[v()],limit:5,minSimilarity:.55,excludedChunks:[]};
 return{storage,source,request,result:await storage.persistentSemanticSearch(request)};
}
for(const defect of ['tenant','source','proof','inventory','readiness','coverage-count','complete','identity','provenance-inventory','missing-sets','score','limit','excluded'])test(`persistent adapter rejects malformed authority: ${defect}`,async()=>{
 const f=await fixture(),r=structuredClone(f.result);const m=r.matches[0][0];
 switch(defect){case'tenant':m.businessId=88;break;case'source':m.sourceId='foreign';break;case'proof':m.indexProof!.source={...m.indexProof!.source,generation:'00000000-0000-4000-8000-000000000099'};break;
 case'inventory':m.indexProof!.inventoryToken='0'.repeat(64);break;case'readiness':r.coverage.sources[0].ready=false;break;
 case'coverage-count':r.coverage.readySourceCount++;break;case'complete':r.coverage.complete=false;break;
 case'identity':(r.coverage.identity as any).model='other';break;case'provenance-inventory':r.coverage.sources.push(r.coverage.sources[0]);break;
 case'missing-sets':r.matches=[];break;case'score':m.score=NaN;break;case'limit':r.matches[0]=Array.from({length:6},()=>m);break;
 case'excluded':f.request.excludedChunks.push({source_id:m.sourceId,content:m.text!});break;}
 assert.throws(()=>parsePersistentSearch(r,f.request),/invalid_response/);
});
for(const change of [{provider:'google'},{model:'other'},{dimensions:2},{version:2},{values:Array(768).fill(0)},{values:[NaN,...Array(767).fill(0)]},{values:[Infinity,...Array(767).fill(0)]},{values:[1]}])test(`incompatible/malformed query rejected: ${Object.keys(change)[0]}/${String(Object.values(change)[0]).slice(0,12)}`,async()=>{
 const f=await fixture();let requests=0;const bad={...v(),...change};assert.equal(compatibleQuery(bad),false);
 const read=f.storage.persistentSemanticSearch.bind(f.storage);f.storage.persistentSemanticSearch=async(...args)=>{requests++;return read(...args);};
 const k=new KnowledgeService(f.storage,f.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>bad,embedDocuments:async()=>[bad]});
 let status:SemanticStatus|undefined;
 assert.deepEqual(await k.semanticSearchQueries(77,['Documented guidance?'],5,{onStatus:s=>status=s}),[]);
 assert.deepEqual(status,{status:'unavailable',reason:'invalid_vector'});assert.equal(requests,0);
});
test('local publication requires a full matching snapshot and never adopts incompatible/unproven stored vectors',async()=>{
 const s=new InMemoryKnowledgeStorage();await s.create({id:'x',businessId:77,type:'text',status:'ready',title:'x',content:'Not all procedures are digital.',metadata:{},createdAt:'2026',updatedAt:'2026'});
 await s.replaceChunks(77,'x',[{chunkIndex:0,content:'Not all procedures are digital.'}]);const rev=s.indexSnapshot(77,'x')!;
 assert.throws(()=>s.completeSemanticIndex(88,'x',rev,[v()]));assert.throws(()=>s.completeSemanticIndex(77,'x','wrong',[v()]));assert.throws(()=>s.completeSemanticIndex(77,'x',rev,[]));
 await s.replaceChunks(77,'x',[{chunkIndex:0,content:'Not all procedures are digital.',embedding:v().values,embeddingProvider:'google',embeddingModel:'gemini-embedding-2',embeddingDimensions:768,embeddingVersion:1}]);
 assert.throws(()=>s.completeSemanticIndex(77,'x',s.indexSnapshot(77,'x')!,[v()]));
 const r=await s.persistentSemanticSearch({businessId:77,embeddings:[v()],limit:5,minSimilarity:.55,excludedChunks:[]});assert.equal(r.coverage.complete,false);assert.deepEqual(r.matches,[[]]);
});
test('real Supabase client serializes only query vectors, forwards abort and emits no authorization data to diagnostics',async()=>{
 const f=await fixture();let calls=0,signal:AbortSignal|undefined;
 const client=createClient('https://synthetic.invalid','synthetic-unused',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.hostname,'synthetic.invalid');assert.ok(url.pathname.endsWith('/rpc/search_knowledge_index_snapshot_v1'));
  const body=JSON.parse(String(init?.body));assert.deepEqual(body.p_identity,identity);assert.deepEqual(body.p_queries,[v().values]);assert.equal(body.p_business_id,77);
  signal=init?.signal as AbortSignal;calls++;return new Response(JSON.stringify(f.result),{headers:{'Content-Type':'application/json'}});
 }}});
 const controller=new AbortController();const s=new SupabaseKnowledgeStorage(client);
 assert.deepEqual(await s.persistentSemanticSearch(f.request,{signal:controller.signal}),f.result);assert.equal(calls,1);assert.ok(signal);controller.abort();assert.equal(signal!.aborted,true);
});
test('database cancellation in both OpenAI paths preserves lexical evidence and never embeds a corpus',async()=>{
 const f=await fixture();let embeddings=0,db=0;const signals:AbortSignal[]=[];
 f.storage.persistentSemanticSearch=async(_r,o)=>{db++;signals.push(o!.signal!);return new Promise(()=>{});};
 const k=new KnowledgeService(f.storage,f.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>{embeddings++;return v();},embedDocuments:async qs=>{assert.equal(qs.length,1);embeddings++;return[v()];}});
 for(const batch of [false,true]){let status:SemanticStatus|undefined;const opts={timeoutMs:25,onStatus:(s:SemanticStatus)=>status=s};
  const start=performance.now();assert.deepEqual(await(batch?k.semanticSearchQueries(77,['Guidance?'],5,opts):k.semanticSearch(77,'Guidance?',5,.55,opts)),[]);
  assert.ok(performance.now()-start<500);assert.deepEqual(status,{status:'unavailable',reason:'timeout'});assert.equal(signals.at(-1)?.aborted,true);
 }
 assert.equal(embeddings,2);assert.equal(db,2);assert.equal((await k.search(77,'identification')).length,1);
});
test('aborted requests and unavailable persistent adapters start no embedding work',async()=>{
 const f=await fixture();let calls=0;const k=new KnowledgeService(f.storage,f.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>{calls++;return v();},embedDocuments:async()=>{calls++;return[v()];}});
 const controller=new AbortController();controller.abort();assert.deepEqual(await k.semanticSearchQueries(77,['Guidance?'],5,{signal:controller.signal}),[]);
 (f.storage as any).persistentSemanticSearch=undefined;assert.deepEqual(await k.semanticSearch(77,'Guidance?'),[]);assert.equal(calls,0);
});

test('publication rejects a malformed/incompatible readiness response; inventory revalidation also fails closed',async()=>{
 const f=await fixture();const k=new KnowledgeService(f.storage,f.storage,{supportsLocalSemanticSearch:true,embedQuery:async()=>v(),embedDocuments:async qs=>qs.map(()=>v())});
 const initial=await k.semanticSearchQueries(77,['Guidance?']);assert.equal(initial.length,1);
 const read=f.storage.persistentSemanticSearch.bind(f.storage);
 f.storage.persistentSemanticSearch=async(request,options)=>{const result=await read(request,options);if(!request.embeddings.length)(result.coverage.identity as any)={...identity,version:2};return result;};
 assert.deepEqual(await k.validateMatches(77,initial,{strictSources:true}),[]);
 assert.equal(await k.validateSemanticCoverage(77,f.result.coverage),false);
});

test('an empty local inventory cannot authorize a different tenant',async()=>{
 const s=new InMemoryKnowledgeStorage(),k=new KnowledgeService(s,s);
 const read=(businessId:number)=>s.persistentSemanticSearch({businessId,embeddings:[],limit:1,minSimilarity:.55,excludedChunks:[]});
 const a=await read(77),b=await read(88);assert.equal(a.coverage.complete,false);assert.notEqual(a.coverage.inventoryToken,b.coverage.inventoryToken);
 assert.equal(await k.validateSemanticCoverage(77,a.coverage),true);assert.equal(await k.validateSemanticCoverage(88,a.coverage),false);
 assert.throws(()=>parsePersistentSearch(a,{businessId:88,embeddings:[],limit:1,minSimilarity:.55,excludedChunks:[]}),/invalid_response/);
});
