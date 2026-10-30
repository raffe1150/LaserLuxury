/** Fixed Phase 4 A-en gate. --prepare never reads credentials or calls providers.
 * Execution requires a future, bound approval; no retry/other-case command exists. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync,renameSync,openSync,closeSync,ftruncateSync,fstatSync,lstatSync,writeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {aenSpec,aenRoot,aenTransport,privateCredential,type AenState} from './knowledge-aen-single-provider';
import {sha256,planSha256,claimCase,claimProviderLock,latchFailure,validateLedger,admitRequest,safeDiagnostic,captureRequirements,type Ledger} from './knowledge-multilingual-acceptance-policy';
import {DisposableSourceIndexDatabase,indexSqlLiteral as lit} from '../tests/helpers/disposable-source-index-db';
import {KnowledgeService,SupabaseKnowledgeStorage} from '../knowledge';
import {SourceIndexCoordinator,SupabaseSourceIndexRepository} from '../src/knowledge/documents/indexing';
import {OPENAI_KNOWLEDGE_EMBEDDING_IDENTITY as identity} from '../src/knowledge/embedding-backfill';
import {ConfiguredEmbeddingProvider} from '../src/ai/providers/embeddings';
import {PERSISTENT_SEARCH_RPC,type IndexCoverage} from '../src/knowledge/persistent-search';
import {incidentConfig,incidentFlags,incidentInbound} from '../tests/helpers/p0-incident-knowledge';

export const phase4Root=resolve('docs/validation/shared-core-2026-10-22/persistent-index-phase4-preparation-20261024');
export const gateRoot=join(phase4Root,'one-use-A-en');
export const approvalId='A-en-persistent-index-20261024-once';
const ledgerPath=resolve('docs/validation/shared-core-2026-10-22/source-aware-usage.json');
const preparedRoot='docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024';
const searchMigration='20261024161901_persistent_knowledge_search_snapshot.sql';
const sourceIds=['77000000-0000-4000-8000-000000000001','77000000-0000-4000-8000-000000000002'];
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
export function fixtures(){
 const prepared=read(join(preparedRoot,'prepared-gate-final.json')),pdf=read('tests/fixtures/admotion-production-document.json');
 assert.equal(prepared.preliminaryCases.length,18);assert.equal(pdf.chunks.length,5);
 assert.equal(sha256(readFileSync('tests/fixtures/admotion-production-document.json')),prepared.sourceFileSha256);
 assert.ok(readFileSync(join(preparedRoot,'QUESTIONS-final.md'),'utf8').includes('\n'+aenSpec.question+'\n'));
 assert.equal(aenSpec.id,'A-en');assert.equal(aenSpec.channel,'telegram');assert.equal(aenSpec.businessId,77);
 return {prepared,pdf,sources:prepared.sources.map((s:any,i:number)=>({...s,databaseId:sourceIds[i],chunks:i===0?pdf.chunks:[{chunk_index:0,content:s.content,metadata:{source:'document',section:'Text'}}]}))};
}
function walk(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(path,e.name)):[join(path,e.name)]);}
export function candidateBinding(){
 const {prepared}=fixtures();
 const files=[...walk('src').filter(f=>/\.(ts|cjs)$/u.test(f)&&!f.endsWith('.test.ts')),
  ...readdirSync('.').filter(f=>/\.(ts|cjs)$/u.test(f)&&!f.endsWith('.test.ts')),
  ...walk('supabase/migrations').filter(f=>f.endsWith('.sql')),
  'package.json','package-lock.json','tsconfig.json',
  'scripts/knowledge-persistent-aen.ts','scripts/knowledge-persistent-aen.test.ts','scripts/knowledge-aen-single-provider.ts','scripts/knowledge-multilingual-acceptance-policy.ts',
  'tests/helpers/disposable-source-index-db.ts','tests/helpers/p0-incident-knowledge.ts','tests/fixtures/multilingual-knowledge-acceptance.ts','tests/fixtures/admotion-production-document.json',
  join(preparedRoot,'prepared-gate-final.json'),join(preparedRoot,'QUESTIONS-final.md'),join(preparedRoot,'local-budget-cap-20261024-100.json')];
 const hashes=Object.fromEntries([...new Set(files)].sort().map(f=>[f,sha256(readFileSync(f))]));
 return {bindings:{candidateSha256:sha256(JSON.stringify(hashes)),planSha256,sourceSnapshotSha256:sha256(JSON.stringify({sources:prepared.sources,catalog:prepared.catalog}))},
  hashes,questionSha256:sha256(aenSpec.question),ledgerSha256:sha256(readFileSync(ledgerPath)),sourceMapping:sourceIds,provider:identity,authorizationId:approvalId};
}
export function validateCurrentLedger(current:Ledger,baseline:Ledger){
 validateLedger(current,read(join(aenRoot,'ledger-before.json')));
 assert.equal(baseline.calls.length,163);assert.ok(Math.abs(baseline.unmeteredReserveUsd-.36)<1e-12);
 assert.equal(sha256(JSON.stringify(current.calls.slice(0,baseline.calls.length))),sha256(JSON.stringify(baseline.calls)),'Historical ledger prefix changed');
 assert.ok(current.estimatedUsd>=baseline.estimatedUsd&&current.unmeteredReserveUsd>=baseline.unmeteredReserveUsd,'Historical spending/reserves reduced');
}
export function verifyPrepared(){
 const binding=read(join(phase4Root,'candidate-binding.json')),current=candidateBinding();
 assert.deepEqual(current,binding,'Candidate, fixture or starting ledger changed');
 assert.equal(binding.ledgerSha256,sha256(readFileSync(join(phase4Root,'ledger-before.json'))));
 validateCurrentLedger(read(ledgerPath),read(join(phase4Root,'ledger-before.json')));return binding;
}
export function validateApproval(approval:any,binding:ReturnType<typeof candidateBinding>){
 assert.equal(approval.authorizationId,approvalId);assert.equal(approval.caseId,'A-en');assert.equal(approval.channel,'telegram');assert.equal(approval.language,'en');assert.equal(approval.businessId,77);
 assert.equal(approval.questionSha256,binding.questionSha256);assert.equal(approval.ledgerSha256,binding.ledgerSha256);assert.equal(approval.indexPreparation,'real-provider-fresh-disposable-database');
 // Existing authorization validator also enforces plan/source/candidate hashes,
 // one-case scope, explicit true authorization, cap and no retry.
 assert.equal(approval.scope,'one-preliminary-case-only');assert.equal(approval.providerExecutionAuthorized,true);
 for(const key of ['candidateSha256','planSha256','sourceSnapshotSha256'])assert.equal(approval[key],binding.bindings[key]);
 assert.equal(approval.localCapUsd,1);assert.equal(approval.automaticRetry,false);
}
export function claimPersistentCase(directory:string,approval:any,binding:ReturnType<typeof candidateBinding>){
 validateApproval(approval,binding);return claimCase(directory,'A-en',approval,binding.bindings);
}
export function validateOfflineReadiness(offline:any,binding:ReturnType<typeof candidateBinding>){
 assert.equal(offline.passed,true);assert.equal(offline.candidateSha256,binding.bindings.candidateSha256);
 assert.equal(offline.runnerSha256,sha256(readFileSync('scripts/knowledge-persistent-aen.ts')));
 assert.equal(offline.runnerTestSha256,sha256(readFileSync('scripts/knowledge-persistent-aen.test.ts')));
 assert.ok(Array.isArray(offline.evidence)&&offline.evidence.length>=3);
 for(const item of offline.evidence){
  assert.equal(item.path.startsWith(phase4Root+'/'),true);assert.equal(item.sha256,sha256(readFileSync(item.path)));
 }
}
export type PersistentState=AenState & {activity:'index-preparation'|'customer'|'closed';sourceIndex:number;receipts:any[]};
/** Reuses the original transport, prices/ceilings, .02 reservations, seven-call
 * cap and allowlist. The wrapper only narrows the fixed lifecycle and inputs. */
export function persistentTransport(options:{ledger:Ledger;baseline:Ledger;key:string;state:PersistentState;controller:AbortController;network:typeof fetch;save:()=>void;saveLedger:()=>void}):typeof fetch{
 const {state,controller}=options,f=fixtures();
 const fail=(reason:string):never=>{state.stopReason??=reason;controller.abort();options.save();throw Error(reason);};
 const guarded=aenTransport({...options,historical:read(join(aenRoot,'ledger-before.json')),saveLedger:()=>{
  validateCurrentLedger(options.ledger,options.baseline);
  for(const row of options.ledger.calls.slice(options.baseline.calls.length) as any[])if(!row.activity)row.activity=state.activity;
  options.saveLedger();
 }});
 return async(input,init)=>{
  if(state.activity==='closed'||state.stopReason||controller.signal.aborted)throw Error('Persistent A-en gate stopped');
  validateCurrentLedger(options.ledger,options.baseline);
  const url=new URL(input instanceof Request?input.url:String(input));let body:any;
  try{body=JSON.parse(String(init?.body));}catch{return fail('INVALID_REQUEST_BODY');}
  const embedding=url.pathname==='/v1/embeddings';
  if(embedding){
   if(state.activity==='index-preparation'){
    const expected=f.sources[state.sourceIndex];if(!expected||JSON.stringify(body.input)!==JSON.stringify(expected.chunks.map((c:any)=>c.content)))return fail('INDEX_INPUT_SCOPE_MISMATCH');
    if(state.calls.some(c=>c.activity==='index-preparation'&&c.sourceIndex===state.sourceIndex))return fail('DUPLICATE_INDEX_REQUEST');
   }else if(JSON.stringify(body.input)!==JSON.stringify([aenSpec.question])||state.calls.some(c=>c.activity==='customer'&&c.stage==='embedding'))return fail('CUSTOMER_CORPUS_OR_DUPLICATE_QUERY');
  }else if(url.pathname==='/v1/responses'){
   if(state.activity!=='customer')return fail('MODEL_CALL_DURING_INDEXING');
   const instruction=String(body.instructions||'');
   if(/query planner/iu.test(instruction))return fail('UNEXPECTED_PLANNING_REQUEST');
   const stage=instruction.includes('language-routing classifier')?'language':instruction.includes('UNIT EXTRACTION')?'extraction':instruction.includes('BATCH ENTAILMENT')?'verification':instruction.includes('VERIFIED-UNIT PRESENTATION')?'composition':'other';
   if(stage==='other'||state.calls.some(c=>c.activity==='customer'&&c.stage===stage))return fail('UNEXPECTED_OR_DUPLICATE_MODEL_STAGE');
  }else if(state.activity!=='customer')return fail('SEND_DURING_INDEXING');
  const index=state.calls.length,activity=state.activity,sourceIndex=state.sourceIndex;
  try {
   const response=await guarded(input,init),data=embedding?await response.clone().json():null;
   if(embedding){
    if(!Array.isArray(data?.data)||data.data.length!==body.input.length||data.data.some((e:any,i:number)=>e.index!==i||!Array.isArray(e.embedding)||e.embedding.length!==768||e.embedding.some((x:any)=>typeof x!=='number'||!Number.isFinite(x))||!e.embedding.some((x:number)=>x!==0)))return fail('INVALID_EMBEDDING_RECEIPT');
    state.receipts.push({activity,sourceIndex:activity==='index-preparation'?sourceIndex:null,inputSha256:sha256(JSON.stringify(body.input)),count:data.data.length,dimensions:768,vectorPayloadSha256:sha256(JSON.stringify(data.data))});
   }
   return response;
  }finally{if(state.calls[index])Object.assign(state.calls[index],{activity,sourceIndex:activity==='index-preparation'?sourceIndex:null});options.save();}
 };
}

export async function runPersistentLifecycle(options:{key:string;state:PersistentState;controller:AbortController;save:()=>void;record:any;mode:'offline-rehearsal'|'real-provider'}){
 const {state,controller,record}=options,f=fixtures(),started=performance.now();
 const db=new DisposableSourceIndexDatabase([searchMigration]);let coordinator:SourceIndexCoordinator|undefined,b:any;
 try {
  record.database={type:'owned disposable PostgreSQL',externalConnections:false};record.sourceBindings=[];
  for(const source of f.sources){
   db.sql(`INSERT INTO public.knowledge_sources(id,business_id,type,title,status,content,metadata) VALUES(${lit(source.databaseId)},77,${lit(source.type)},${lit(source.title)},'ready',${lit(source.content)},${lit(source.metadata)});
     SELECT public.replace_knowledge_chunks(77,${lit(source.databaseId)},${lit(source.chunks)});`);
   record.sourceBindings.push({alias:source.id,databaseId:source.databaseId,businessId:77,content:source.content,metadata:source.metadata,chunks:source.chunks,
    canonicalRevision:db.sql(`SELECT public.knowledge_source_index_revision_v1(77,${lit(source.databaseId)});`)});
  }
  const provider=new ConfiguredEmbeddingProvider(()=>{throw Error('Google credentials forbidden');});
  coordinator=new SourceIndexCoordinator(new SupabaseSourceIndexRepository(db.client),provider,identity,{allowedBusinessIds:[77],maxSources:2,maxRequests:2,maxInputChars:200000,maxInputBytes:800000},controller.signal);
  record.indexing=[];
  for(const [i,source]of f.sources.entries()){
   state.sourceIndex=i;const outcome=await coordinator.indexSource({businessId:77,sourceId:source.databaseId});record.indexing.push(outcome);options.save();
   assert.equal(outcome.status,'ready','Durable index preparation did not complete');
  }
  const storage=new SupabaseKnowledgeStorage(db.client),empty={businessId:77,embeddings:[],limit:5,minSimilarity:.55,excludedChunks:[]};
  const coverage=(await storage.persistentSemanticSearch(empty,{signal:controller.signal})).coverage;
  assert.equal(coverage.complete,true);assert.equal(coverage.sourceCount,2);assert.equal(coverage.readySourceCount,2);
  assert.equal(coverage.sources.reduce((n,s)=>n+s.expectedChunks,0),6);
  assert.deepEqual(coverage.sources.map(s=>s.sourceId).sort(),sourceIds);
  assert.ok(coverage.sources.every(s=>s.businessId===77&&s.ready&&s.compatibleChunks===s.expectedChunks));
  assert.equal(state.receipts.filter(r=>r.activity==='index-preparation').length,2,'Both index batches require actual guarded transport receipts');
  record.indexReadiness={coverage,vectorOrigin:options.mode==='real-provider'?'guarded dedicated OpenAI requests':'SYNTHETIC OFFLINE VECTORS — NOT REAL-PROVIDER ACCEPTANCE'};
  db.restart(); // Persistence must survive a new process, not a temporary corpus cache.
  const service=new KnowledgeService(new SupabaseKnowledgeStorage(db.client),storage,provider,true);
  assert.equal(await service.validateSemanticCoverage(77,coverage,{signal:controller.signal}),true);
  const foreign=(await storage.persistentSemanticSearch({...empty,businessId:88})).coverage;assert.equal(foreign.complete,false);assert.equal(foreign.sourceCount,0);
  record.retrieval=[];record.diagnostics=[];record.decisions=[];record.actions=0;
  Object.assign(incidentConfig,{services:structuredClone(f.prepared.catalog),language:'sv'});
  b=(await import('../server')).priority1hUnifiedEngineTestBoundary;b.reset();
  const forbidden=async()=>{record.actions++;state.stopReason||='UNAUTHORIZED_ACTION';controller.abort();options.save();throw Error('No booking/calendar/notification actions');};
  const tenant=(id:number)=>assert.equal(id,77);
  b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeSearch:async(id,q,limit)=>{tenant(id);const matches=await service.search(id,q,limit);record.retrieval.push({phase:'lexical',question:q,matches});options.save();return matches;},
   knowledgeSourceLanguages:id=>{tenant(id);return service.sourceLanguageHints(id);},completeKnowledgeCorpus:(id,m)=>{tenant(id);return service.completeSmallCorpus(id,m);},
   semanticKnowledgeSearchQueries:async(id,queries,limit,opts)=>{tenant(id);const matches=await service.semanticSearchQueries(id,queries,limit,{...opts,onStatus:s=>{record.semanticStatus=s;}});record.retrieval.push({phase:'semantic',queries,matches});options.save();return matches;},
   validateKnowledgeMatches:async(id,m)=>{tenant(id);const matches=await service.validateMatches(id,m,{strictSources:true,captureRevision:true});record.retrieval.push({phase:'freshness',matches});options.save();return matches;},
   knowledgeServiceCatalog:async id=>{tenant(id);return incidentConfig.services;},knowledgeRetrievalDiagnostic:e=>{record.retrieval.push({phase:'metrics',data:e});options.save();},
   evidenceFirstDiagnostic:e=>{record.diagnostics.push(e);options.save();},evidenceFirstDecisionDiagnostic:e=>{record.decisions.push(e);options.save();},
   calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  record.indexPreparationWallMs=performance.now()-started;state.activity='customer';state.startedAt=performance.now();record.customerStartedAt=Date.now();options.save();
  await incidentInbound(b,'telegram',aenSpec.question);
  if(state.stopReason)throw Error('Provider gate stopped');
  assert.equal(state.replies.length,1);assert.equal(record.actions,0);
  for(const stage of ['language','embedding','extraction','verification'])assert.equal(state.calls.filter(c=>c.activity==='customer'&&c.stage===stage).length,1,'Required real stage did not execute');
  assert.equal(state.calls.some(c=>c.stage==='planning'),false);assert.equal(state.calls.filter(c=>c.activity==='index-preparation').length,2);
  assert.equal(record.semanticStatus?.status,'complete');assert.ok(record.retrieval.some((r:any)=>r.phase==='semantic'&&r.matches.some((m:any)=>m.indexProof?.source.ready)));
  assert.equal(record.decisions.findLast((e:any)=>e.stage==='publication')?.route,'verified_manifest','A-en requires complete verified publication');
  assert.equal(await service.validateSemanticCoverage(77,coverage,{signal:controller.signal}),true);
  for(const source of record.sourceBindings)assert.equal(db.sql(`SELECT public.knowledge_source_index_revision_v1(77,${lit(source.databaseId)});`),source.canonicalRevision);
  record.automaticIntegrityPassed=true;record.manualReview={status:'REQUIRED',passed:null,obligations:aenSpec.obligations.map(id=>({id,passed:null})),everyMaterialClaimMustBeReviewed:true};
  record.databaseCalls=db.calls;record.customerWallMs=performance.now()-state.startedAt;options.save();
 }finally{record.totalWorkflowWallMs=performance.now()-started;state.activity='closed';coordinator?.stop();b?.reset();db.close();}
}

export function prepareArtifacts(){
 mkdirSync(gateRoot,{recursive:true});const binding=candidateBinding();
 writeFileSync(join(phase4Root,'candidate-binding.json'),JSON.stringify(binding,null,2)+'\n',{flag:'wx'});
 writeFileSync(join(phase4Root,'ledger-before.json'),readFileSync(ledgerPath),{flag:'wx',mode:0o600});
 const template={...binding.bindings,authorizationId:approvalId,caseId:'A-en',channel:'telegram',language:'en',businessId:77,questionSha256:binding.questionSha256,ledgerSha256:binding.ledgerSha256,indexPreparation:'real-provider-fresh-disposable-database',scope:'one-preliminary-case-only',providerExecutionAuthorized:false,localCapUsd:1,automaticRetry:false};
 writeFileSync(join(gateRoot,'execution-approval.template.json'),JSON.stringify(template,null,2)+'\n',{flag:'wx',mode:0o600});
 return binding;
}
async function execute(){
 const binding=verifyPrepared(),approval=read(join(gateRoot,'execution-approval.json'));validateApproval(approval,binding);
 validateOfflineReadiness(read(join(phase4Root,'offline-ready.json')),binding);
 const baseline=read(join(phase4Root,'ledger-before.json')) as Ledger,ledger=read(ledgerPath) as Ledger;
 validateCurrentLedger(ledger,baseline);admitRequest(ledger,.02);
 const release=claimProviderLock();let key='',fd:number|undefined,path:string|undefined,diskHash=sha256(readFileSync(ledgerPath));
 const controller=new AbortController(),state:PersistentState={stopReason:null,calls:[],replies:[],startedAt:performance.now(),activity:'index-preparation',sourceIndex:0,receipts:[]};
 const record:any={caseId:'A-en',spec:aenSpec,binding:binding.bindings,mode:'real-provider',outbound:'intercepted',provider:'real OpenAI',manualReview:{status:'REQUIRED',passed:null}};
 const originalConsole={...console},network=globalThis.fetch;
 const save=()=>{if(fd===undefined)return;const bytes=safeDiagnostic({...record,state,budget:{capUsd:1,before:{calls:baseline.calls.length,estimatedUsd:baseline.estimatedUsd,unknownReserveUsd:baseline.unmeteredReserveUsd},after:{calls:ledger.calls.length,estimatedUsd:ledger.estimatedUsd,unknownReserveUsd:ledger.unmeteredReserveUsd,reservedUsd:ledger.estimatedUsd+ledger.unmeteredReserveUsd}}},key?[key]:[]);writeSync(fd,bytes,0,'utf8');ftruncateSync(fd,Buffer.byteLength(bytes));};
 const saveLedger=()=>{validateCurrentLedger(ledger,baseline);assert.equal(sha256(readFileSync(ledgerPath)),diskHash);const tmp=ledgerPath+'.persistent-aen.tmp';writeFileSync(tmp,JSON.stringify(ledger,null,2),{flag:'wx',mode:0o600});renameSync(tmp,ledgerPath);diskHash=sha256(readFileSync(ledgerPath));};
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  // Recheck under the shared lock: a request that settled while this executor
  // was acquiring ownership must never be replaced by a pre-lock ledger copy.
  verifyPrepared();assert.deepEqual(ledger,read(ledgerPath),'Starting ledger changed before exclusive ownership');
  path=claimPersistentCase(gateRoot,approval,binding);fd=openSync(path,'r+');assert.equal(fstatSync(fd).ino,lstatSync(path).ino);save();
  for(const method of ['log','info','warn','error']as const)console[method]=()=>{};
  key=privateCredential();process.env.OPENAI_API_KEY=key;process.env.DOTENV_CONFIG_PATH='/dev/null';incidentFlags();delete process.env.ODINLINK_SHARED_PG;
  for(const name of Object.keys(process.env))if(/SUPABASE|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|^DATABASE_URL$/u.test(name))delete process.env[name];
  globalThis.fetch=persistentTransport({key,state,controller,ledger,baseline,network,save,saveLedger});
  timer=setTimeout(()=>{state.stopReason||='HARNESS_CASE_DEADLINE';controller.abort();save();},captureRequirements.limits.caseWatchdogMs);
  await runPersistentLifecycle({key,state,controller,save,record,mode:'real-provider'});
 }catch{state.stopReason||='PERSISTENT_AEN_EXECUTION_STOPPED';save();}
 finally{
  if(timer)clearTimeout(timer);controller.abort();state.activity='closed';if(state.stopReason&&path)latchFailure(gateRoot,'A-en',state.stopReason);save();if(fd!==undefined)closeSync(fd);
  delete process.env.OPENAI_API_KEY;key='';globalThis.fetch=async()=>{throw Error('A-en gate closed');};Object.assign(console,originalConsole);release();
  console.log(JSON.stringify({caseId:'A-en',stopReason:state.stopReason,result:path,manualReviewRequired:true}));if(state.stopReason)process.exitCode=1;
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.slice(2).join(' ')==='--prepare')prepareArtifacts();
 else if(process.argv.slice(2).join(' ')==='--execute-persistent-aen')await execute();
 else throw Error('Only fixed preparation or separately authorized A-en execution is supported');
}
