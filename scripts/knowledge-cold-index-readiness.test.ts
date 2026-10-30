/** Bounded architecture probes. Synthetic vectors/intercepted storage only.
 * No SDK, credentials, database connection, mutation or provider runner. */
import test,{after}from'node:test';import assert from'node:assert/strict';
import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
import{KnowledgeService,SupabaseKnowledgeStorage,knowledgeSourceRevision}from'../knowledge';
import{sharedCorpus}from'../tests/helpers/shared-core-incident';
import{acceptanceQuestions}from'../tests/fixtures/multilingual-knowledge-acceptance';
import{CompatibleSemanticIndex}from'../src/knowledge/semantic-index';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null'});delete process.env.ODINLINK_SHARED_PG;
const root='docs/validation/shared-core-2026-10-22/cold-index-readiness-20261024',records:any[]=[];
after(()=>writeFileSync(process.env.ODINLINK_COLD_READINESS_RESULTS||root+'/probe-results.json',JSON.stringify({kind:'Offline synthetic vectors, actual KnowledgeService/Supabase adapter, intercepted RPCs; no production observations',providerRequests:0,records},null,2),{flag:'wx'}));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const vector=(model='text-embedding-3-small',provider='openai',version=1,dimensions=768)=>({model,provider,version,dimensions,values:Array.from({length:dimensions},(_,i)=>i?0:1)});
async function fixture(){
 const base=await sharedCorpus(false,true),sources=await base.storage.list(77);const cedar=JSON.parse(readFileSync('tests/fixtures/cedar-repair-knowledge.json','utf8'));
 for(const[i,d]of cedar.documents.entries())await base.storage.create({id:'cedar-'+i,businessId:88,type:'document',title:d.sourceId,status:'ready',content:d.text,metadata:{segments:[{start:0,end:d.text.length,section:'Text'}]},createdAt:'2026',updatedAt:'2026'});
 const calls:any[]=[],rpc:any[]=[],reads:string[]=[];let model='text-embedding-3-small',failure:'query'|'corpus'|null=null,delay=0,noLexical=false,corrupt=false;
 const q=acceptanceQuestions.A.en;
 const storage=new SupabaseKnowledgeStorage({from:(table:string)=>{
  reads.push(table);assert.equal(table,'knowledge_sources','Current semantic corpus reads source text, not stored vectors');let tenant=77;
  const query:any={select:()=>query,limit:()=>query,order:()=>query,retry:()=>query,eq:(column:string,value:any)=>{if(column==='business_id')tenant=Number(value);return query;},then:async(resolve:any)=>resolve({data:(await base.storage.list(tenant)).map(s=>({id:s.id,business_id:s.businessId,type:s.type,title:s.title,status:s.status,content:s.content,metadata:s.metadata,created_at:s.createdAt,updated_at:s.updatedAt})),count:(await base.storage.list(tenant)).length,error:null})};return query;
 },rpc:async(name:string,p:any)=>{
  rpc.push({name,tenant:p.p_business_id});assert.ok([77,88].includes(p.p_business_id),'Scoped RPC');
  if(name==='search_knowledge_chunks_semantic'){assert.equal(p.p_embedding_provider,'openai');assert.equal(p.p_embedding_model,'text-embedding-3-small');assert.equal(p.p_embedding_version,1);return{data:[{source_id:'incident-pdf',business_id:77,content:JSON.parse(readFileSync('tests/fixtures/admotion-production-document.json','utf8')).chunks[0].content,score:1,metadata:{source:'document',page:1,documentRevision:knowledgeSourceRevision(sources.find(s=>s.id==='incident-pdf')!)}}],error:null};}
  assert.equal(name,'search_knowledge_chunks','Retrieval must not persist or mutate');const matches=noLexical?[]:await base.storage.search(p.p_business_id,p.p_query,p.p_limit);return{data:matches.map(m=>({source_id:m.sourceId,business_id:m.businessId,content:m.text,metadata:m.metadata,score:m.score})),error:null};
 }});
 const provider={supportsLocalSemanticSearch:true,embedQuery:async()=>vector(model),embedDocuments:async(texts:string[],options?:any)=>{
  const kind=texts.length===1&&texts[0]===q?'query':'corpus',entry:any={kind,textCount:texts.length,textHashes:texts.map(hash),aborted:false};calls.push(entry);const start=performance.now();
  if(failure===kind)throw Error('Synthetic '+kind+' failure');
  if(kind==='corpus'&&delay)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,delay);const abort=()=>{clearTimeout(timer);entry.aborted=true;reject(Object.assign(Error('Synthetic cancellation'),{name:'AbortError'}));};if(options?.signal?.aborted)return abort();options?.signal?.addEventListener('abort',abort,{once:true});});
  entry.durationMs=performance.now()-start;return texts.map(()=>vector(corrupt&&kind==='corpus'?'wrong-model':model));
 }};
 const service=new KnowledgeService(storage,storage,provider);
 return{...base,memory:base.storage,sources,storage,provider,service,q,calls,rpc,reads,clear:()=>{calls.length=0;rpc.length=0;},setFailure:(f:typeof failure)=>failure=f,setDelay:(n:number)=>delay=n,setNoLexical:()=>noLexical=true,setCorrupt:(b:boolean)=>corrupt=b,setModel:(s:string)=>model=s};
}
test('AdMotion six chunks: cold, warm, restart, expiry; even available compatible persisted RPC is ignored',async t=>{
 const f=await fixture();try{
  const lex=await f.service.search(77,f.q);assert.equal(await f.service.completeSmallCorpus(77,lex),null);
  const a=await f.service.semanticSearchQueries(77,[f.q]);assert.ok(a.length);assert.deepEqual(f.calls.map(c=>[c.kind,c.textCount]),[['query',1],['corpus',6]]);assert.equal(f.rpc.filter(r=>r.name==='search_knowledge_chunks_semantic').length,0);const cold=structuredClone(f.calls);f.clear();
  await f.service.semanticSearchQueries(77,[f.q]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);const warm=structuredClone(f.calls);f.clear();
  await new KnowledgeService(f.storage,f.storage,f.provider).semanticSearchQueries(77,[f.q]);assert.deepEqual(f.calls.map(c=>c.kind),['query','corpus']);const restart=structuredClone(f.calls);f.clear();
  const now=Date.now();t.mock.method(Date,'now',()=>now+300001);await f.service.semanticSearchQueries(77,[f.q]);assert.deepEqual(f.calls.map(c=>c.kind),['query','corpus']);
  // This is a deliberately separate direct adapter control, not production use.
  assert.equal((await f.storage.semanticSearch(77,vector())).length,1);assert.equal(f.rpc.at(-1).name,'search_knowledge_chunks_semantic');
  records.push({case:'cold-warm-restart-expiry',lexical:lex.map(m=>({sourceId:m.sourceId,businessId:m.businessId})),cold,warm,restart,expiry:structuredClone(f.calls),persistedRpcOnlyCalledByExplicitControl:true});
 }finally{f.cleanup();}
});
test('parallel cold customer requests duplicate corpus work; subsequent call reuses one completed cache',async()=>{
 const f=await fixture();try{f.setDelay(30);await Promise.all([f.service.semanticSearchQueries(77,[f.q]),f.service.semanticSearchQueries(77,[f.q])]);assert.equal(f.calls.filter(c=>c.kind==='query').length,2);assert.equal(f.calls.filter(c=>c.kind==='corpus').length,2);const concurrent=structuredClone(f.calls);f.clear();await f.service.semanticSearchQueries(77,[f.q]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);records.push({case:'concurrency',concurrent,next:structuredClone(f.calls)});}finally{f.cleanup();}
});
test('one caller cancellation does not cancel another; failed cold work is retried, not cached',async()=>{
 const f=await fixture();try{f.setDelay(35);const c=new AbortController(),timer=setTimeout(()=>c.abort(),10);const [a,b]=await Promise.all([f.service.semanticSearchQueries(77,[f.q],5,{signal:c.signal}),f.service.semanticSearchQueries(77,[f.q])]);clearTimeout(timer);assert.deepEqual(a,[]);assert.ok(b.length);assert.equal(f.calls.filter(c=>c.kind==='corpus').length,2);assert.equal(f.calls.filter(c=>c.aborted).length,1);const parallel=structuredClone(f.calls);f.clear();await f.service.semanticSearchQueries(77,[f.q]);assert.deepEqual(f.calls.map(c=>c.kind),['query']);records.push({case:'independent-cancellation',parallel,next:structuredClone(f.calls)});}finally{f.cleanup();}
});
for(const mode of ['query','corpus']as const)test(`provider ${mode} failure preserves current lexical evidence; next cold attempt retries`,async()=>{
 const f=await fixture();try{const lex=await f.service.search(77,f.q);f.setFailure(mode);assert.deepEqual(await f.service.semanticSearchQueries(77,[f.q]),[]);assert.equal((await f.service.validateMatches(77,lex,{strictSources:true,captureRevision:true})).length,lex.length);const failed=structuredClone(f.calls);f.clear();f.setFailure(null);assert.ok((await f.service.semanticSearchQueries(77,[f.q])).length);assert.deepEqual(f.calls.map(c=>c.kind),['query','corpus']);records.push({case:'provider-failure-'+mode,failed,recovery:structuredClone(f.calls),lexicalRetained:lex.length});}finally{f.cleanup();}
});
test('no lexical results still allows semantic evidence; lexical presence is not an exhaustiveness proof',async()=>{
 const f=await fixture();try{f.setNoLexical();assert.deepEqual(await f.service.search(77,f.q),[]);const semantic=await f.service.semanticSearchQueries(77,[f.q]);assert.ok(semantic.length);assert.ok(semantic.every(m=>m.businessId===77));assert.equal(await f.service.completeSmallCorpus(77,semantic),null);records.push({case:'semantic-without-lexical',matches:semantic.map(m=>({sourceId:m.sourceId,businessId:m.businessId})),calls:structuredClone(f.calls),completeCorpus:false});}finally{f.cleanup();}
});
for(const mode of ['revision','revoked','tenant','incompatible']as const)test(`source/identity guard: ${mode}`,async()=>{
 const f=await fixture();try{const old=await f.service.semanticSearchQueries(77,[f.q]);f.clear();
  if(mode==='revision'||mode==='revoked'){
   const source=structuredClone(f.sources.find(s=>s.id==='incident-pdf')!);
   if(mode==='revision')source.content=source.content.replace('Stjärngatan 14','Stjärngatan 15');else source.status='disabled';
   await f.memory.create(source);const current=await f.service.semanticSearchQueries(77,[f.q]);
   assert.deepEqual(await f.service.validateMatches(77,old.filter(m=>m.sourceId==='incident-pdf'),{strictSources:true}),[]);
   if(mode==='revision'){assert.ok(current.some(m=>m.text?.includes('Stjärngatan 15')));assert.ok(current.every(m=>!m.text?.includes('Stjärngatan 14')));}
   else assert.ok(current.every(m=>m.sourceId!=='incident-pdf'));
  }
  if(mode==='incompatible'){f.setCorrupt(true);f.setModel('new-query-model');assert.deepEqual(await f.service.semanticSearchQueries(77,[f.q]),[]);f.setCorrupt(false);assert.ok((await f.service.semanticSearchQueries(77,[f.q])).length);}
  if(mode==='tenant'){const other=await f.service.semanticSearchQueries(88,[f.q]);assert.ok(other.length);assert.ok(other.every(m=>m.businessId===88));assert.deepEqual(await f.service.validateMatches(88,old,{strictSources:true}),[]);}
  records.push({case:'source-identity-'+mode,calls:structuredClone(f.calls)});
 }finally{f.cleanup();}
});

for(const [name,wrong] of [['provider',vector('text-embedding-3-small','google')],['model',vector('wrong-model')],['version',vector('text-embedding-3-small','openai',2)],['dimensions',vector('text-embedding-3-small','openai',1,2)]]as const)test(`incompatible stored/generated identity never compared: ${name}`,async()=>{const query=vector(),chunks=[{sourceId:'synthetic',businessId:77,text:'Exact canonical source',metadata:{}}];await assert.rejects(()=>new CompatibleSemanticIndex().searchQueries(77,chunks,[query],{embedQuery:async()=>query,embedDocuments:async()=>[wrong]},5,.55),/identity mismatch/);});

test('two fresh operating-system processes both start cold against the unchanged source snapshot',()=>{
 const code=`import{KnowledgeService}from'./knowledge.ts';import{sharedCorpus}from'./tests/helpers/shared-core-incident.ts';import{acceptanceQuestions}from'./tests/fixtures/multilingual-knowledge-acceptance.ts';const c=await sharedCorpus(false,true),calls=[];const p={supportsLocalSemanticSearch:true,embedQuery:async()=>null,embedDocuments:async texts=>{calls.push(texts.length);return texts.map(()=>({provider:'openai',model:'synthetic-process-probe',version:1,dimensions:2,values:[1,0]}));}};await new KnowledgeService(c.storage,c.storage,p).semanticSearchQueries(77,[acceptanceQuestions.A.en]);console.log(JSON.stringify({pid:process.pid,inputCounts:calls}));c.cleanup();`;
 const run=()=>JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null'},timeout:8000,encoding:'utf8'}).trim().split('\n').at(-1)!);
 const a=run(),b=run();assert.notEqual(a.pid,b.pid);assert.deepEqual(a.inputCounts,[1,6]);assert.deepEqual(b.inputCounts,[1,6]);records.push({case:'fresh-processes',runs:[a,b],provider:'synthetic only'});
});
