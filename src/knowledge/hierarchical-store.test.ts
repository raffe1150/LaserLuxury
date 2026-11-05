/** SCRIPTED RPC state machine. No database, SQL application or provider calls.
 * Exercises the real repository, worker, service and canonical proof boundary;
 * it is not a substitute for PostgreSQL migration validation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {hierarchicalFixture} from '../../tests/helpers/hierarchical-foundation';
import {canonicalHash,canonicalDocument} from './documents/canonical';
import {SupabaseSearchGenerations} from './hierarchical-store';
import {HierarchicalSearchIndex,hierarchicalProducerVersion,searchMetadataDigest,type InjectedSearchProducer} from './hierarchical-search';
import {hierarchicalIndexForClient,hierarchicalIndexOptions} from './hierarchical-runtime';
import {documentServiceForClient} from './documents/runtime';
import {DocumentService,documentChunks} from './documents/service';
import {KnowledgeService,type KnowledgeSource} from '../../knowledge';
process.env.NODE_ENV='test';process.env.ODINLINK_HIERARCHICAL_SEARCH='hierarchical-search-v1';
const identity={provider:'openai',model:'SCRIPTED-generator',version:'1',verifierModel:'SCRIPTED-independent',verifierVersion:'1'};
class RpcState {
 ingestBytes?:Buffer;
 jobs=new Map<string,any>();epochs=new Map<string,number>();serial=0;clock=0;calls:string[]=[];failBefore='';failAfter='';spoof:any;
 constructor(readonly f:Awaited<ReturnType<typeof hierarchicalFixture>>){}
 async write(source:KnowledgeSource|null){
  const old=source??this.f.source,key=old.businessId+'/'+old.id;this.epochs.set(key,++this.serial);
  for(const job of this.jobs.values())if(job.businessId===old.businessId&&job.sourceId===old.id)job.state='invalidated';
  if(source)await this.f.storage.create(source);else await this.f.storage.delete(old.businessId,old.id);
 }
 now(){return Date.now()+this.clock;}
 client={storage:{getBucket:async()=>({data:{public:false,file_size_limit:5242880},error:null}),from:()=>({download:async()=>({data:new Blob([this.ingestBytes!]),error:null})})},from:(table:string)=>{
  assert.equal(table,'knowledge_sources');let tenant=77,limit=200;const q:any={};
  for(const name of ['select','order','retry','abortSignal'])q[name]=()=>q;
  q.eq=(_key:string,value:number)=>{tenant=value;return q;};q.limit=(value:number)=>{limit=value;return q;};
  q.then=(resolve:any,reject:any)=>this.f.storage.list(tenant).then(sources=>({data:sources.slice(0,limit).map(s=>({id:s.id,business_id:s.businessId,type:s.type,title:s.title,status:s.status,content:s.content,metadata:s.metadata,created_at:s.createdAt,updated_at:s.updatedAt})),count:sources.length,error:null})).then(resolve,reject);return q;
 },rpc:async(name:string,p:any)=>{
  this.calls.push(name);
  if(this.failBefore===name){this.failBefore='';return{error:{message:'SCRIPTED outage'},data:null};}
  const source=(await this.f.storage.list(p.p_business_id)).find(s=>s.id===p.p_source_id),scope=p.p_business_id+'/'+p.p_source_id;
  const epoch=String(this.epochs.get(scope)??1),token=source?canonicalHash([source,epoch]):null;
  const key=scope+'/'+p.p_version+'/'+epoch;let job=this.jobs.get(key),data:any=null;
  if(name==='transition_knowledge_document'){
   if(p.p_action==='claim')data={source_id:p.p_id,business_id:p.p_business_id,object_key:`${p.p_business_id}/${p.p_id}/original.txt`,format:'txt',filename:'new.txt',mime:'text/plain',bytes:this.ingestBytes!.length,sha256:createHash('sha256').update(this.ingestBytes!).digest('hex'),lease_token:'SCRIPTED-ingest'};
   else if(p.p_action==='finish'){await this.write({...this.f.source,content:p.p_content,metadata:p.p_metadata,status:'ready',updatedAt:'2'});data=true;}
   else throw Error('Unexpected ingestion failure');
  }else if(name==='knowledge_hint_source_snapshot_v1')data=source?.status==='ready'?{source,epoch,snapshot:token}:null;
  else if(name==='read_knowledge_hint_generations_v1'){
   data=[];for(const j of this.jobs.values()){
    const s=(await this.f.storage.list(j.businessId)).find(s=>s.id===j.sourceId),ep=String(this.epochs.get(j.businessId+'/'+j.sourceId)??1);
    if(j.businessId===p.p_business_id&&j.version===p.p_version&&j.state==='ready'&&s?.status==='ready'&&j.epoch===ep&&j.snapshot===canonicalHash([s,ep]))data.push(j.generation);
   }
   if(this.spoof)data=this.spoof;
   // Simulate PostgreSQL JSONB object key reordering at the durable read boundary.
   const jsonb=(v:any):any=>Array.isArray(v)?v.map(jsonb):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,jsonb(v[k])])):v;
   data=jsonb(data);
   if(p.p_expected_sources&&JSON.stringify([...p.p_expected_sources].sort())!==JSON.stringify((await this.f.storage.list(p.p_business_id)).filter(s=>s.type==='document'&&s.status==='ready').map(s=>s.id).sort()))data=null;
  }else if(name==='claim_knowledge_hint_generation_v1'){
   if(job?.state==='indexing'&&job.until<this.now())job.state='ambiguous';
   if(!job&&source?.status==='ready'&&epoch===p.p_epoch&&token===p.p_snapshot){
    job={businessId:p.p_business_id,sourceId:p.p_source_id,version:p.p_version,epoch,snapshot:token,binding:p.p_binding,identity:p.p_identity,
     state:'indexing',token:'00000000-0000-4000-8000-'+String(++this.serial).padStart(12,'0'),until:this.now()+60000,deadline:this.now()+1800000,
     started:0,completed:0,pending:false,expected:p.p_requests};this.jobs.set(key,job);
    data={token:job.token,epoch,deadline:new Date(job.deadline).toISOString()};
   }
  }else if(name==='transition_knowledge_hint_generation_v1'){
   data=false;
   if(job&&job.token===p.p_token&&job.epoch===p.p_epoch&&job.state==='indexing'){
    if(p.p_action.startsWith('fail')){job.state=job.pending&&p.p_action==='fail'?'ambiguous':'failed';data=true;}
    else if(job.until>this.now()&&job.snapshot===token){
     if(p.p_action==='begin'&&!job.pending&&p.p_stage===job.completed&&job.started===job.completed&&job.started<job.expected){job.started++;job.pending=true;data=true;}
     if(p.p_action==='ack'&&job.pending&&p.p_stage===job.completed){job.completed++;job.pending=false;data=true;}
    }
   }
  }else if(name==='complete_knowledge_hint_generation_v1'){
   data=!!job&&job.token===p.p_token&&job.epoch===p.p_epoch&&job.snapshot===token&&source?.status==='ready'&&
    job.until>this.now()&&!job.pending&&job.completed===job.expected&&['indexing','ready'].includes(job.state);
   if(data){job.generation=p.p_generation;job.state='ready';}
  }else throw Error('Unexpected RPC '+name);
  if(this.failAfter===name){this.failAfter='';return{error:{message:'SCRIPTED lost acknowledgement'},data:null};}
  return{data:structuredClone(data),error:null};
 }};
}
async function setup(count=4,padding=0){
 const f=await hierarchicalFixture(count,padding),db=new RpcState(f);
 const producer:InjectedSearchProducer={...f.producer,mode:'durable-injected',identity};
 const version=hierarchicalProducerVersion(producer),repo=()=>new SupabaseSearchGenerations(db.client,version);
 const index=()=>new HierarchicalSearchIndex(id=>f.storage.list(id),repo(),producer,{enabled:true,businessIds:[77],maxRequests:400,stageMs:100});
 const worker=index(),service=new KnowledgeService(f.storage,f.storage,null,false,worker);
 return{f,db,producer,version,repo,index,worker,service};
}
for(const count of [4,50])test(`SCRIPTED durable lifecycle / ${count} sections survives worker restart`,async()=>{
 const x=await setup(count);const documents=new DocumentService(null,undefined,x.worker,x.worker);
 assert.equal((await documents.recoverIndex() as any)[0].status,'ready');
 const job=[...x.db.jobs.values()][0];assert.equal(job.completed,Math.ceil(count/5)*2);assert.equal(job.pending,false);
 const after=x.f.calls(),restarted=x.index();assert.deepEqual(await restarted.recover(),[]);assert.equal(x.f.calls(),after);
 const service=new KnowledgeService(x.f.storage,x.f.storage,null,false,restarted);
 const matches=await service.search(77,'اشیای باارزش چگونه ثبت می‌شوند؟');assert.ok(matches.length);
 assert.equal((await service.completeSelectedDocuments(77,matches,matches))?.length,count);
 assert.deepEqual(await service.search(77,'password reset request'),[]);
 assert.ok((await x.repo().readMany(77))[0].checks!.every(c=>c.batchDigest));
});
test('duplicate concurrent workers have one durable claim and no duplicate provider stages',async()=>{
 const x=await setup();const results=await Promise.all([x.worker.recover(),x.index().recover()]);
 assert.equal(results.flat().filter(r=>r.status==='ready').length,1);assert.equal(x.f.calls(),2);
});
for(const change of ['revision','revoke-restore','delete-recreate'] as const)test(`epoch fences old evidence / ${change}`,async()=>{
 const x=await setup();await x.worker.recover();const old=await x.service.search(77,'objetos de valor');assert.ok(old.length);
 if(change==='revision')await x.db.write({...x.f.source,updatedAt:'2'});
 else if(change==='revoke-restore'){await x.db.write({...x.f.source,status:'disabled'});await x.db.write(x.f.source);}
 else{await x.db.write(null);await x.db.write(x.f.source);}
 assert.deepEqual(await x.service.validateMatches(77,old,{strictSources:true,requireCompleteDocumentContext:true}),[]);
 assert.deepEqual(await x.service.search(77,'objetos de valor'),[]);
 assert.equal((await x.index().recover())[0].status,'ready');
 assert.deepEqual(await x.service.validateMatches(77,old,{strictSources:true}),[],'New epoch cannot revive an old proof');
});
test('producer version update requires a new independently verified generation',async()=>{
 const x=await setup();await x.worker.recover();x.producer.version='SCRIPTED-next';
 const repository=new SupabaseSearchGenerations(x.db.client,hierarchicalProducerVersion(x.producer));
 const index=new HierarchicalSearchIndex(id=>x.f.storage.list(id),repository,x.producer,{enabled:true,businessIds:[77],maxRequests:10});
 assert.deepEqual(await index.discover(77,'objetos de valor'),[]);assert.equal((await index.recover())[0].status,'ready');assert.equal(x.f.calls(),4);
});
test('interrupted job and expired lease remain terminal across worker restarts',async()=>{
 const x=await setup();const lease=await x.repo().claim(x.f.document,x.version,identity,2);assert.ok(lease);
 await x.repo().stage(x.f.document,lease,0,'begin');x.db.clock=61000;
 assert.deepEqual(await x.index().recover(),[]);assert.equal([...x.db.jobs.values()][0].state,'ambiguous');assert.equal(x.f.calls(),0);
 await assert.rejects(x.repo().stage(x.f.document,{...lease,token:'foreign-token'},0,'ack'));
});
test('failed independent checking is not readiness and is not a transport failure or retry',async()=>{
 const x=await setup();x.producer.verify=async()=>({acceptedIds:[],reviewedChunkIds:[]});
 assert.equal((await x.worker.recover())[0].status,'failed');assert.equal([...x.db.jobs.values()][0].state,'failed');
 const calls=x.f.calls();assert.deepEqual(await x.index().recover(),[]);assert.equal(x.f.calls(),calls);assert.deepEqual(await x.service.search(77,'objetos de valor'),[]);
});
for(const lost of ['before-begin','after-begin','after-ack','after-commit'] as const)test(`lost RPC acknowledgement / ${lost}`,async()=>{
 const x=await setup();
 if(lost==='before-begin')x.db.failBefore='transition_knowledge_hint_generation_v1';
 if(lost==='after-begin')x.db.failAfter='transition_knowledge_hint_generation_v1';
 if(lost==='after-ack'){
  const original=x.producer.generate;x.producer.generate=async(...args)=>{const raw=await original(...args);x.db.failAfter='transition_knowledge_hint_generation_v1';return raw;};
 }
 if(lost==='after-commit')x.db.failAfter='complete_knowledge_hint_generation_v1';
 assert.equal((await x.worker.recover())[0].status,'failed');const calls=x.f.calls();
 assert.deepEqual(await x.index().recover(),[]);assert.equal(x.f.calls(),calls);
 assert.equal((await x.service.search(77,'objetos de valor')).length>0,lost==='after-commit');
 if(lost.includes('begin'))assert.equal(calls,0);
});
test('source changes after extraction/generation and hint-only matches cannot publish a generation',async()=>{
 const x=await setup();const original=x.producer.generate;
 x.producer.generate=async(...args)=>{const raw=await original(...args);await x.db.write({...x.f.source,status:'disabled'});return raw;};
 assert.equal((await x.worker.recover())[0].status,'failed');assert.deepEqual(await x.service.search(77,'objetos de valor'),[]);
});
test('foreign, stale and corrupted stored generations fail closed at read and proof boundaries',async()=>{
 const x=await setup();await x.worker.recover();const generation=(await x.repo().readMany(77))[0];
 for(const change of [{...generation,businessId:88},{...generation,producerVersion:'other'},{...generation,hints:[]},{...generation,checks:[]}]){
  x.db.spoof=[change];await assert.rejects(x.repo().readMany(77));
 }
 x.db.spoof=undefined;const hit=await x.service.search(77,'objetos de valor');
 assert.deepEqual(await x.service.validateMatches(88,hit,{strictSources:true}),[]);
 await x.db.write(null);assert.deepEqual(await x.service.validateMatches(77,hit,{strictSources:true}),[]);
});
test('bounded source overflow is still unavailable, never replaced with hint text',async()=>{
 const x=await setup(50,300);await x.worker.recover();const hit=await x.service.search(77,'objetos de valor');assert.ok(hit.length);
 assert.equal(await x.service.completeSelectedDocuments(77,hit,hit),null);
 assert.ok(hit.every(h=>!h.text!.includes('objetos de valor')));
});
test('runtime is default-off, pins exact producer identity and has no implicit provider',async()=>{
 const x=await setup(),profile={version:'durable-hints-v1',businessIds:[77],producerVersion:x.producer.version,identity,targetLanguages:['fa','es'],maxRequests:0,stageMs:100};
 assert.equal(hierarchicalIndexOptions(undefined),undefined);assert.throws(()=>hierarchicalIndexOptions('{}'));
 assert.throws(()=>hierarchicalIndexForClient(x.db.client,{...profile,producer:{...x.producer,identity:{...identity,model:'different'}}} as any));
 const reader=hierarchicalIndexForClient(x.db.client,profile as any)!;assert.deepEqual(await reader.recover(),[]);assert.equal(x.f.calls(),0);
 delete process.env.ODINLINK_HIERARCHICAL_SEARCH;try{assert.equal(hierarchicalIndexForClient(x.db.client,profile as any),undefined);}finally{process.env.ODINLINK_HIERARCHICAL_SEARCH='hierarchical-search-v1';}
});
test('new ingestion canonical segments use the same recoverIndex worker contract',async()=>{
 const x=await setup();const chunks=documentChunks([{text:'Alla uppgifter är fiktiva och avsedda för test.'},{text:'Värdesaker registreras separat.'}],'new.txt');
 await x.db.write({...x.f.source,...chunks,updatedAt:'2'});
 const profile={version:'durable-hints-v1' as const,businessIds:[77],producerVersion:x.producer.version,identity,targetLanguages:['fa','es'],maxRequests:20,stageMs:100,producer:x.producer};
 const service=documentServiceForClient(x.db.client as any,undefined,profile);assert.ok(service.hierarchicalIndex);
 assert.equal((await service.recoverIndex() as any)[0].status,'ready');
 assert.ok((await x.service.search(77,'اشیای باارزش چگونه ثبت می‌شوند؟')).length);
});
test('migration review contract: private revocation trigger, backend RPCs and no embedding mutations',()=>{
 const sql=readFileSync('supabase/migrations/20261105202430_durable_hierarchical_knowledge_index_v1.sql','utf8');
 assert.match(sql,/REVIEW DRAFT ONLY/);assert.match(sql,/enable row level security/g);assert.match(sql,/from public,anon,authenticated/g);
 assert.match(sql,/epoch_seq/);assert.match(sql,/state='ambiguous'/);assert.match(sql,/p_stage=j.completed/);
 assert.match(sql,/lease_token is distinct from p_token/);assert.match(sql,/snapshot_token is distinct from/);
 assert.ok(!/update public\.knowledge_chunks|embedding|security definer/iu.test(sql.replace(/--[^\n]*/gu,'').replace('security definer','')));
 assert.equal((sql.match(/security definer/gu)||[]).length,1,'Only the private source trigger has definer privileges');
});

test('durable read checks the complete authoritative source inventory, not a truncated caller list',async()=>{
 const x=await setup();await x.worker.recover();await assert.rejects(x.repo().readMany(77,[]));
 assert.equal((await x.repo().readMany(77,[x.f.source.id])).length,1);
});

test('actual DocumentService.process publishes canonical text before durable hint recovery',async()=>{
 const x=await setup(),sections=[{text:'Alla uppgifter är fiktiva och avsedda för test.'},{text:'Värdesaker registreras separat.'}];
 x.db.ingestBytes=Buffer.from(sections.map(s=>s.text).join('\n'));
 await x.db.write({...x.f.source,status:'processing'});assert.deepEqual(await x.worker.recover(),[]);
 const documents=new DocumentService(x.db.client as any,async()=>sections,x.worker,x.worker);
 await documents.process(77,x.f.source.id);assert.equal((await documents.recoverIndex() as any)[0].status,'ready');
 assert.ok((await x.service.search(77,'objetos de valor')).length);assert.equal(x.f.calls(),2);
});

test('shutdown after durable begin performs zero provider dispatches',async()=>{
 const x=await setup(),original=x.db.client.rpc;
 x.db.client.rpc=async(name,p)=>{const result=await original(name,p);if(name==='transition_knowledge_hint_generation_v1'&&p.p_action==='begin')x.worker.stop();return result;};
 assert.equal((await x.worker.recover())[0].status,'failed');assert.equal(x.f.calls(),0);
 assert.equal([...x.db.jobs.values()][0].state,'ambiguous');assert.deepEqual(await x.index().recover(),[]);
});
for(const fault of ['quote','identity','batch-proof'] as const)test(`rehashed stored metadata cannot acquire canonical authority / ${fault}`,async()=>{
 const x=await setup();await x.worker.recover();const g=structuredClone((await x.repo().readMany(77))[0]);
 if(fault==='quote')(g.hints[0] as any).quote='Invented factual claim.';
 if(fault==='identity')(g.producerIdentity as any).verifierModel='unapproved';
 if(fault==='batch-proof')(g.checks![0] as any).batchDigest='forged';
 const {digest,...body}=g;x.db.spoof=[{...body,digest:searchMetadataDigest(body)}];
 assert.deepEqual(await x.service.search(77,'objetos de valor'),[]);
});
test('producer identity change between stages blocks verification dispatch',async()=>{
 const x=await setup(),original=x.producer.generate;
 x.producer.generate=async(...args)=>{const result=await original(...args);x.producer.identity={...identity,verifierVersion:'changed'};return result;};
 assert.equal((await x.worker.recover())[0].status,'failed');assert.equal(x.f.calls(),1);
});
