/** Fixed, one-use A-en runner. No other case, retry, matrix or ping entry point. */
import {readFileSync,writeFileSync,lstatSync,statSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {parse} from 'dotenv';
import {preliminaryAcceptancePlan} from '../tests/fixtures/multilingual-knowledge-acceptance';
import {sharedCorpus} from '../tests/helpers/shared-core-incident';
import {incidentConfig,incidentFlags,incidentInbound,interceptedIncidentSend} from '../tests/helpers/p0-incident-knowledge';
import {KnowledgeService} from '../knowledge';
import {ConfiguredEmbeddingProvider} from '../src/ai/providers/embeddings';
import {assertCaseAuthorization,claimCase,claimProviderLock,latchFailure,admitRequest,validateLedger,safeDiagnostic,classifyNetwork,sha256,planSha256,captureRequirements,type Ledger} from './knowledge-multilingual-acceptance-policy';
export const aenRoot=resolve('docs/validation/shared-core-2026-10-22/aen-single-provider-20261024');
export const aenRevalidationRoot=resolve('docs/validation/shared-core-2026-10-22/aen-revalidation-provider-20261024');
const ledgerPath=resolve('docs/validation/shared-core-2026-10-22/source-aware-usage.json');
export const aenSpec=preliminaryAcceptancePlan.find(c=>c.id==='A-en')!;
export function validateAenScope(approval:any,binding:any){
 assertCaseAuthorization(approval,'A-en',binding);
 if(approval.caseId!=='A-en'||approval.channel!=='telegram'||approval.language!=='en'||approval.businessId!==77||aenSpec.channel!=='telegram'||aenSpec.businessId!==77)throw Error('Only A-en Telegram tenant 77 is authorized');
}
export function verifyCandidate(revalidation=false){
 const binding=JSON.parse(readFileSync(revalidation?'docs/validation/shared-core-2026-10-22/aen-planning-repair-20261024/candidate-binding.json':'docs/validation/shared-core-2026-10-22/multilingual-route-repair-20261024/candidate-binding.json','utf8'));
 if(revalidation)assert.equal(binding.bindings.candidateSha256,'029ea1a42020ef9f647eada8fedefbd16bae6287e032a62eca00a728cf1823a6');
 for(const [path,hash]of Object.entries(binding.runtimeSources))assert.equal(sha256(readFileSync(path)),hash,'Corrected runtime changed');
 assert.equal(sha256(JSON.stringify(binding.runtimeSources)),binding.bindings.candidateSha256);
 assert.equal(planSha256,binding.bindings.planSha256);
 const prepared=JSON.parse(readFileSync('docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024/prepared-gate-final.json','utf8'));
 assert.equal(sha256(JSON.stringify({sources:prepared.sources,catalog:prepared.catalog})),binding.bindings.sourceSnapshotSha256);
 assert.equal(sha256(readFileSync('tests/fixtures/admotion-production-document.json')),prepared.sourceFileSha256);
 const questions=readFileSync('docs/validation/shared-core-2026-10-22/multilingual-acceptance-preparation-20261024/QUESTIONS-final.md','utf8');assert.ok(questions.includes('\n'+aenSpec.question+'\n'));
 return binding;
}
export function requestCeiling(body:any,path:string){
 const request={...body};if(path==='/v1/responses')request.max_output_tokens=Math.min(request.max_output_tokens??8192,8192);
 const bytes=Buffer.byteLength(JSON.stringify(request),'utf8'),ceiling=((bytes+2048)*.25+(request.max_output_tokens??0)*1.2)/1e6;
 return {request,ceiling,inputTokenUpperBound:bytes+2048};
}
export function estimateUsage(usage:any){
 if(!usage)return null;
 const inputTokens=usage.input_tokens??usage.prompt_tokens,outputTokens=usage.output_tokens??usage.completion_tokens??0,cached=usage.input_tokens_details?.cached_tokens??0,written=usage.input_tokens_details?.cache_write_tokens??0;
 if(![inputTokens,outputTokens,cached,written].every(n=>Number.isSafeInteger(n)&&n>=0)||cached+written>inputTokens)return null;
 return {inputTokens,outputTokens,cached,written,estimatedUsd:((inputTokens-cached-written)*.2+cached*.02+written*.25+outputTokens*1.2)/1e6};
}
export type AenState={stopReason:string|null;calls:any[];replies:string[];startedAt:number};
/** Reuses the reviewed allowlist, $.02 admission/ceiling, historical estimator,
 * request cap and 45s watchdog. Headers never enter capture or diagnostic data. */
export function aenTransport(options:{ledger:Ledger;historical:Ledger;key:string;state:AenState;controller:AbortController;network:typeof fetch;save:()=>void;saveLedger:()=>void}){
 const {ledger,historical,key,state,controller}=options;
 const fail=(reason:string):never=>{state.stopReason??=reason;controller.abort();options.save();throw Error(reason);};
 return async(input:Parameters<typeof fetch>[0],init?:RequestInit):Promise<Response>=>{
  if(state.stopReason||controller.signal.aborted)throw Error('A-en gate stopped');
  const url=new URL(input instanceof Request?input.url:String(input));
  let body:any;try{body=JSON.parse(String(init?.body));}catch{return fail('INVALID_REQUEST_BODY');}
  let kind:string;try{kind=classifyNetwork(url.toString(),init?.method||'GET',body.model);}catch{return fail('NETWORK_ALLOWLIST_REJECTED');}
  if(kind==='intercept-only'){
   if(url.hostname!=='api.telegram.org'||state.replies.length) return fail('UNAUTHORIZED_OR_DUPLICATE_SEND');
   let text:string;try{text=interceptedIncidentSend(input,init);safeDiagnostic({text},[key]);}catch{return fail('OUTBOUND_INTERCEPTION_REJECTED');}
   state.replies.push(text);options.save();return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200,headers:{'Content-Type':'application/json'}});
  }
  if(state.calls.length>=captureRequirements.limits.maximumRequestsPerCase)return fail('REQUEST_COUNT_CEILING');
  const bounded=requestCeiling(body,url.pathname);body=bounded.request;
  try{validateLedger(ledger,historical);admitRequest(ledger,bounded.ceiling);safeDiagnostic(body,[key]);}catch{return fail('BUDGET_OR_REDACTION_ADMISSION_REJECTED');}
  const stage=url.pathname==='/v1/embeddings'?'embedding':body.instructions?.includes('language-routing classifier')?'language':body.instructions?.includes('UNIT EXTRACTION')?'extraction':body.instructions?.includes('BATCH ENTAILMENT')?'verification':body.instructions?.includes('query planner')?'planning':body.instructions?.includes('VERIFIED-UNIT PRESENTATION')?'composition':'other';
  let payload:any;try{payload=JSON.parse(body.input?.[0]?.content);}catch{}
  if(payload?.evidence?.some((e:any)=>e.businessId!==77))return fail('EVIDENCE_TENANT_MISMATCH');
  const call:any={stage,model:body.model,request:body,requestSha256:sha256(JSON.stringify(body)),inputTokenUpperBound:bounded.inputTokenUpperBound,conservativeCeilingUsd:bounded.ceiling,startedAfterCaseMs:performance.now()-state.startedAt};
  state.calls.push(call);ledger.unmeteredReserveUsd+=.02;options.saveLedger();options.save();let settled=false;const started=performance.now();
  try{
   const response=await options.network(input,{...init,body:JSON.stringify(body),signal:init?.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal});
   const result=await response.clone().json();
   const outputText=String(result.output_text||result.output?.filter((i:any)=>i.type==='message').flatMap((i:any)=>i.content||[]).filter((i:any)=>i.type==='output_text').map((i:any)=>i.text).join('')||'');
   const capture={durationMs:performance.now()-started,httpStatus:response.status,responseStatus:result.status,outputText,usage:result.usage,providerError:result.error?{type:result.error.type,code:result.error.code}:undefined,incompleteDetails:result.incomplete_details};
   safeDiagnostic(capture,[key]);Object.assign(call,capture);
   const usage=estimateUsage(result.usage);
   if(usage){ledger.unmeteredReserveUsd-=.02;ledger.estimatedUsd+=usage.estimatedUsd;ledger.calls.push({profile:'authorized-multilingual-A-en-only',case:'A-en',model:body.model,...usage});settled=true;options.saveLedger();call.estimatedUsd=usage.estimatedUsd;}
   else call.unknownReserveRetainedUsd=.02;
   options.save();
   if(!response.ok)return fail('PROVIDER_HTTP_FAILURE');
   if(result.status==='incomplete')return fail('PROVIDER_TRUNCATED');
   if(usage&&(usage.estimatedUsd>.02||ledger.estimatedUsd+ledger.unmeteredReserveUsd>1+1e-12))return fail('COST_CEILING_VIOLATION');
   return response;
  }catch(error){call.durationMs=performance.now()-started;call.errorType=error instanceof Error?error.name:'unknown';if(!settled)call.unknownReserveRetainedUsd=.02;return fail(state.stopReason|| (init?.signal?.aborted?'PROVIDER_STAGE_ABORT':controller.signal.aborted?'HARNESS_CASE_DEADLINE':'PROVIDER_TRANSPORT_FAILURE'));}
 };
}
/** Additional revalidation floor: retain every one of the 161 prior rows and
 * the $.34 reserve, while reusing the original 160-row transport validator. */
export function validateRevalidationLedger(current:Ledger,baseline:Ledger){
 const original=JSON.parse(readFileSync(resolve(aenRoot,'ledger-before.json'),'utf8')) as Ledger;
 validateLedger(current,original);
 assert.equal(baseline.calls.length,161);assert.equal(baseline.unmeteredReserveUsd,.34);
 assert.ok(current.calls.length>=161,'Prior ledger rows removed');assert.equal(sha256(JSON.stringify(current.calls.slice(0,161))),sha256(JSON.stringify(baseline.calls)));
 assert.ok(current.estimatedUsd>=baseline.estimatedUsd,'Prior metered spending reduced');assert.ok(current.unmeteredReserveUsd>=baseline.unmeteredReserveUsd,'Prior unknown reserve reduced');
}
export function revalidationTransport(guarded:typeof fetch,ledger:Ledger,baseline:Ledger,state:AenState,controller:AbortController,save:()=>void):typeof fetch{
 return async(input,init)=>{
  validateRevalidationLedger(ledger,baseline);
  let instruction='';try{instruction=JSON.parse(String(init?.body)).instructions||'';}catch{}
  if(instruction.includes('Knowledge retrieval query planner')){state.stopReason||='UNEXPECTED_PLANNING_REQUEST';controller.abort();save();throw Error('Planning forbidden in this revalidation');}
  return guarded(input,init);
 };
}
export function privateCredential(){
 const path='/Users/raffe/.config/odinlink/work-openai.env',s=lstatSync(path);
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600)throw Error('Dedicated credential permissions invalid');
 try{const key=parse(readFileSync(path)).OPENAI_API_KEY;if(!key||!key.startsWith('sk-'))throw Error();return key;}catch{throw Error('Dedicated credential unavailable');}
}
async function execute(){
 const command=process.argv.slice(2).join(' '),revalidation=command==='--execute-aen-revalidation';
 if(command!=='--execute-aen'&&!revalidation)throw Error('Exactly one fixed A-en command is required; no additional cases');
 const outputRoot=revalidation?aenRevalidationRoot:aenRoot;
 const binding=verifyCandidate(revalidation),approval=JSON.parse(readFileSync(resolve(outputRoot,'execution-approval.json'),'utf8'));
 if(revalidation)assert.equal(approval.authorizationId,'A-en-revalidation-20261024-once');
 validateAenScope(approval,binding.bindings);
 const offline=JSON.parse(readFileSync(resolve(outputRoot,'offline-ready.json'),'utf8'));
 assert.equal(offline.runnerSha256,sha256(readFileSync('scripts/knowledge-aen-single-provider.ts')));assert.equal(offline.passed,true);
 const historical=JSON.parse(readFileSync(resolve(outputRoot,'ledger-before.json'),'utf8')) as Ledger;
 const transportHistorical=revalidation?JSON.parse(readFileSync(resolve(aenRoot,'ledger-before.json'),'utf8')) as Ledger:historical;
 const validateHistorical=()=>revalidation?validateRevalidationLedger(ledger,historical):validateLedger(ledger,historical);
 const release=claimProviderLock();let destination:string|undefined,key='',cleanup=()=>{},b:any;
 const realFetch=globalThis.fetch,originalConsole={...console},ledger=JSON.parse(readFileSync(ledgerPath,'utf8')) as Ledger;
 const state:AenState={stopReason:null,calls:[],replies:[],startedAt:performance.now()};const controller=new AbortController();let stage='setup',actions=0,canonical:any,retrieval:any[]=[],diagnostics:any[]=[],decisions:any[]=[],watchdog:ReturnType<typeof setTimeout>|undefined;
 let diskLedgerHash=sha256(readFileSync(ledgerPath));
 const save=()=>{if(!destination)return;writeFileSync(destination,safeDiagnostic({spec:aenSpec,binding:binding.bindings,provider:'real OpenAI',model:'gpt-5.6-luna',channel:'telegram',language:'en',outbound:'intercepted',database:'canonical synthetic in-memory fixture; actual KnowledgeService and configured provider adapter',embeddingInitialState:{process:'fresh',cache:'cold',prewarming:false,persistedFixtureVectors:false},asyncKnowledge:false,smartWaiting:false,stage,stopReason:state.stopReason,elapsedMs:performance.now()-state.startedAt,calls:state.calls,retrieval,canonical,diagnostics,decisions,replies:state.replies,forbiddenActions:actions,budget:{capUsd:1,before:{calls:historical.calls.length,estimatedUsd:historical.estimatedUsd,unknownReserveUsd:historical.unmeteredReserveUsd},after:{calls:ledger.calls.length,estimatedUsd:ledger.estimatedUsd,unknownReserveUsd:ledger.unmeteredReserveUsd,reservedUsd:ledger.estimatedUsd+ledger.unmeteredReserveUsd},incrementalEstimatedUsd:ledger.estimatedUsd-historical.estimatedUsd},manualReview:{passed:null,status:'PENDING_MANUAL_REVIEW'}},key?[key]:[]));};
 const saveLedger=()=>{
  validateHistorical();assert.equal(sha256(readFileSync(ledgerPath)),diskLedgerHash,'Ledger changed outside exclusive writer');
  const tmp=ledgerPath+'.aen-write.tmp';writeFileSync(tmp,JSON.stringify(ledger,null,2),{flag:'wx',mode:0o600});renameSync(tmp,ledgerPath);diskLedgerHash=sha256(readFileSync(ledgerPath));
 };
 try{
  assert.equal(diskLedgerHash,binding.ledgerSha256,'Historical admission ledger changed');validateHistorical();admitRequest(ledger,.02);
  destination=claimCase(outputRoot,'A-en',approval,binding.bindings);save();
  for(const method of ['log','info','warn','error']as const)console[method]=()=>{};
  key=privateCredential();process.env.OPENAI_API_KEY=key;process.env.DOTENV_CONFIG_PATH='/dev/null';incidentFlags();delete process.env.ODINLINK_SHARED_PG;
  for(const name of Object.keys(process.env))if(/SUPABASE|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|^DATABASE_URL$/u.test(name))delete process.env[name];
  const guarded=aenTransport({ledger,historical:transportHistorical,key,state,controller,network:realFetch,save,saveLedger});
  globalThis.fetch=revalidation?revalidationTransport(guarded,ledger,historical,state,controller,save):guarded;
  const corpus=await sharedCorpus(false,true);cleanup=corpus.cleanup;canonical={sources:await corpus.storage.list(77),catalog:incidentConfig.services};assert.equal(sha256(JSON.stringify(canonical)),binding.bindings.sourceSnapshotSha256);
  const service=new KnowledgeService(corpus.storage,corpus.storage,new ConfiguredEmbeddingProvider(()=>undefined));
  b=(await import('../server')).priority1hUnifiedEngineTestBoundary;
  const forbidden=async()=>{actions++;state.stopReason||='UNAUTHORIZED_ACTION_ATTEMPT';controller.abort();save();throw Error('A-en forbids booking/calendar/notification actions');};
  const checkTenant=(id:number)=>assert.equal(id,77,'Unexpected tenant');
  b.reset();b.configure({postProcess:async()=>{},incrementUsage:async()=>({allowed:true,count:1,limit:1000}),
   knowledgeRetrievalDiagnostic:e=>{retrieval.push({phase:'retrieval',data:e});save();},
   knowledgeSearch:async(id,q,limit)=>{checkTenant(id);const matches=await service.search(id,q,limit);retrieval.push({phase:'lexical',businessId:id,question:q,matches});save();return matches;},
   knowledgeSourceLanguages:id=>{checkTenant(id);return service.sourceLanguageHints(id);},completeKnowledgeCorpus:(id,m)=>{checkTenant(id);return service.completeSmallCorpus(id,m);},
   semanticKnowledgeSearchQueries:async(id,q,limit,options)=>{checkTenant(id);const matches=await service.semanticSearchQueries(id,q,limit,options);retrieval.push({phase:'semantic',businessId:id,queries:q,matches});save();return matches;},
   validateKnowledgeMatches:async(id,m)=>{checkTenant(id);const matches=await service.validateMatches(id,m,{strictSources:true,captureRevision:true});retrieval.push({phase:'freshness',businessId:id,matches});save();return matches;},
   knowledgeServiceCatalog:async id=>{checkTenant(id);return incidentConfig.services;},evidenceFirstDiagnostic:e=>{diagnostics.push(e);save();},evidenceFirstDecisionDiagnostic:e=>{decisions.push(e);save();},
   calendarAdapter:{getCalendarId:()=> 'synthetic',getEvents:forbidden,checkSlots:forbidden,insertAppointment:forbidden,cancelAppointment:forbidden,updateAppointment:forbidden},recordAppointment:forbidden,cancelAppointmentRow:forbidden,updateAppointmentRow:forbidden});
  stage='native-inbound';state.startedAt=performance.now();watchdog=setTimeout(()=>{state.stopReason||='HARNESS_CASE_DEADLINE';controller.abort();save();},45000);save();
  await incidentInbound(b,'telegram',aenSpec.question);
  if(state.replies.length!==1)state.stopReason||='MISSING_OR_DUPLICATE_REPLY';
  stage=state.stopReason?'stopped':'manual-review-required';save();
 }catch{state.stopReason||='CASE_EXECUTION_FAILURE';stage='stopped';save();}
 finally{
  if(watchdog)clearTimeout(watchdog);controller.abort();if(state.stopReason&&destination)latchFailure(outputRoot,'A-en',state.stopReason);
  globalThis.fetch=realFetch;Object.assign(console,originalConsole);b?.reset();cleanup();delete process.env.OPENAI_API_KEY;release();save();
  console.log(JSON.stringify({caseId:'A-en',stopReason:state.stopReason,calls:state.calls.length,replies:state.replies.length,result:destination}));
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await execute();
