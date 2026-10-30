import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {aenSpec,aenRoot,aenRevalidationRoot} from './knowledge-aen-single-provider';
import {phase4Root,gateRoot,approvalId,fixtures,candidateBinding,verifyPrepared,validateApproval,claimPersistentCase,validateOfflineReadiness,persistentTransport,runPersistentLifecycle,validateCurrentLedger,type PersistentState} from './knowledge-persistent-aen';
import {sha256,latchFailure,admitRequest,claimProviderLock,captureRequirements} from './knowledge-multilingual-acceptance-policy';
import {documentaryStatements,documentaryQuotes} from '../tests/fixtures/multilingual-knowledge-acceptance';
import {incidentFlags} from '../tests/helpers/p0-incident-knowledge';
const binding=()=>verifyPrepared();
const baseline=()=>JSON.parse(readFileSync(join(phase4Root,'ledger-before.json'),'utf8'));
const approved=()=>({...JSON.parse(readFileSync(join(gateRoot,'execution-approval.template.json'),'utf8')),providerExecutionAuthorized:true});
const body={model:'gpt-5.6-luna',instructions:'OdinLink EVIDENCE-FIRST UNIT EXTRACTION',input:[{content:JSON.stringify({evidence:[{businessId:77}]})}],max_output_tokens:100};
const response=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const completed=(text='{}')=>({object:'response',status:'completed',usage:{input_tokens:100,output_tokens:10},output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]});
function transport(network:typeof fetch){
 const ledger=structuredClone(baseline()),state:PersistentState={stopReason:null,calls:[],replies:[],startedAt:performance.now(),activity:'customer',sourceIndex:0,receipts:[]},controller=new AbortController();let writes=0;
 const guarded=persistentTransport({ledger,baseline:baseline(),key:'synthetic-private-sentinel',state,controller,network,save:()=>{},saveLedger:()=>{writes++;}});
 return {ledger,state,controller,guarded,writes:()=>writes,call:(b:any=body,url='https://api.openai.com/v1/responses',signal?:AbortSignal)=>guarded(url,{method:'POST',body:JSON.stringify(b),signal})};
}
test('complete candidate, 18 questions, six source chunks and current 163-row budget are bound',()=>{
 const b=binding();assert.deepEqual(candidateBinding(),b);assert.equal(fixtures().sources.reduce((n:number,s:any)=>n+s.chunks.length,0),6);assert.equal(fixtures().prepared.preliminaryCases.length,18);
 assert.equal(baseline().calls.length,163);assert.ok(Math.abs(baseline().unmeteredReserveUsd-.36)<1e-12);
 assert.equal(sha256(readFileSync('docs/validation/shared-core-2026-10-22/source-aware-usage.json')),b.ledgerSha256);
 assert.equal(JSON.parse(readFileSync(join(gateRoot,'execution-approval.template.json'),'utf8')).providerExecutionAuthorized,false);
 assert.equal(existsSync(join(gateRoot,'execution-approval.json')),false);assert.equal(existsSync(join(gateRoot,'A-en.consumed.json')),false);assert.equal(existsSync(join(gateRoot,'A-en.result.json')),false);
});
for(const [field,value]of Object.entries({authorizationId:'old-A-en',caseId:'A-sv',channel:'whatsapp',language:'sv',businessId:88,providerExecutionAuthorized:false,automaticRetry:true,localCapUsd:2,indexPreparation:'synthetic-vectors',candidateSha256:'0'.repeat(64),sourceSnapshotSha256:'0'.repeat(64),questionSha256:'0'.repeat(64),ledgerSha256:'0'.repeat(64)}))test(`deny changed/unapproved single-case authorization: ${field}`,()=>assert.throws(()=>validateApproval({...approved(),[field]:value},binding())));
test('new one-use marker and exclusive output preserve historical markers and existing output',()=>{
 const b=binding(),dir=mkdtempSync('/tmp/odin-persistent-auth-');
 const historical=[aenRoot,aenRevalidationRoot].flatMap(d=>['A-en.consumed.json','A-en.result.json','first-failure-stop.json'].map(f=>join(d,f))).filter(existsSync).map(path=>({path,hash:sha256(readFileSync(path))}));
 try{const file=claimPersistentCase(dir,approved(),b);assert.equal(readFileSync(file,'utf8'),'{}');writeFileSync(file,'{"synthetic":true}');const hash=sha256(readFileSync(file));assert.throws(()=>claimPersistentCase(dir,approved(),b));assert.equal(sha256(readFileSync(file)),hash);assert.ok(existsSync(join(dir,'A-en.consumed.json')));
  latchFailure(dir,'A-en','synthetic');assert.throws(()=>claimPersistentCase(dir,approved(),b));
 }finally{rmSync(dir,{recursive:true});}
 for(const h of historical)assert.equal(sha256(readFileSync(h.path)),h.hash);
 const collision=mkdtempSync('/tmp/odin-persistent-collision-');try{writeFileSync(join(collision,'A-en.result.json'),'preserved');assert.throws(()=>claimPersistentCase(collision,approved(),b));assert.equal(readFileSync(join(collision,'A-en.result.json'),'utf8'),'preserved');assert.ok(existsSync(join(collision,'A-en.consumed.json')),'An attempted collision consumes authorization');}finally{rmSync(collision,{recursive:true});}
});
for(const defect of ['row0','row162','drop-row','reserve','metered'])test(`all 163 ledger rows and unknown reserve protected: ${defect}`,()=>{
 const b=baseline(),ledger=structuredClone(b);if(defect==='row0')ledger.calls[0]={changed:true};if(defect==='row162')ledger.calls[162]={changed:true};if(defect==='drop-row')ledger.calls.pop();if(defect==='reserve')ledger.unmeteredReserveUsd-=.02;if(defect==='metered')ledger.estimatedUsd-=.001;
 assert.throws(()=>validateCurrentLedger(ledger,b));
});
test('same cap admits seven .02 reservations without discounting history; insufficient funds stop before network',async()=>{
 const b=baseline(),ledger=structuredClone(b);for(let i=0;i<7;i++){admitRequest(ledger,.02);ledger.unmeteredReserveUsd+=.02;}
 assert.ok(ledger.estimatedUsd+ledger.unmeteredReserveUsd<=1);assert.equal(ledger.calls.length,163);
 let calls=0;const h=transport(async()=>{calls++;return response(completed());});h.ledger.estimatedUsd=.63;await assert.rejects(h.call());assert.equal(calls,0);
});
test('offline proof is candidate/test/evidence bound and cannot authorize provider execution',()=>{
 const b=binding(),path=join(phase4Root,'ledger-before.json');
 const proof={passed:true,candidateSha256:b.bindings.candidateSha256,runnerSha256:sha256(readFileSync('scripts/knowledge-persistent-aen.ts')),runnerTestSha256:sha256(readFileSync('scripts/knowledge-persistent-aen.test.ts')),evidence:Array.from({length:3},()=>({path,sha256:sha256(readFileSync(path))}))};
 validateOfflineReadiness(proof,b);
 for(const key of ['candidateSha256','runnerSha256','runnerTestSha256'])assert.throws(()=>validateOfflineReadiness({...proof,[key]:'0'.repeat(64)},b));
 assert.throws(()=>validateOfflineReadiness({...proof,passed:false},b));assert.throws(()=>validateOfflineReadiness({...proof,evidence:[{path,sha256:'0'.repeat(64)},...proof.evidence.slice(1)]},b));
 assert.throws(()=>validateApproval(JSON.parse(readFileSync(join(gateRoot,'execution-approval.template.json'),'utf8')),b));
});
test('shared lock stays exclusive and existing watchdog, stage ceilings and retry prohibition remain unchanged',()=>{
 const dir=mkdtempSync('/tmp/odin-persistent-lock-'),path=join(dir,'provider.lock');
 try{const release=claimProviderLock(path);assert.throws(()=>claimProviderLock(path));release();const again=claimProviderLock(path);again();}finally{rmSync(dir,{recursive:true});}
 assert.deepEqual(captureRequirements.limits,{requestReserveUsd:.02,requestCeilingUsd:.02,caseWatchdogMs:45000,maximumRequestsPerCase:7,providerAutomaticRetries:0,plannerAndOptionalSemanticMs:2500,foregroundMs:20000});
});
for(const kind of ['planner','corpus','duplicate-query','unknown-model','foreign-tenant','unlisted-network','secret-body','oversize','closed'])test(`narrow lifecycle denial before network: ${kind}`,async()=>{
 let calls=0;const h=transport(async()=>{calls++;return response(completed());});let b:any=body,url='https://api.openai.com/v1/responses';
 if(kind==='planner')b={...body,instructions:'Knowledge retrieval query planner'};
 if(kind==='corpus'||kind==='duplicate-query'){url='https://api.openai.com/v1/embeddings';b={model:'text-embedding-3-small',input:kind==='corpus'?[fixtures().sources[0].chunks[0].content]:[aenSpec.question]};if(kind==='duplicate-query')h.state.calls.push({activity:'customer',stage:'embedding'});}
 if(kind==='unknown-model')b={...body,model:'wrong'};if(kind==='foreign-tenant')b={...body,input:[{content:JSON.stringify({evidence:[{businessId:88}]})}]};
 if(kind==='unlisted-network')url='https://example.com/v1/responses';if(kind==='secret-body')b={...body,instructions:'synthetic-private-sentinel'};if(kind==='oversize')b={...body,instructions:'x'.repeat(100000)};if(kind==='closed')h.state.activity='closed';
 await assert.rejects(h.call(b,url));assert.equal(calls,0);assert.equal(h.ledger.unmeteredReserveUsd,baseline().unmeteredReserveUsd);
});
test('index requests are source-specific, separately labelled and admitted only once',async()=>{
 const h=transport(async(_input,init)=>{assert.ok(h.ledger.unmeteredReserveUsd>baseline().unmeteredReserveUsd);const b=JSON.parse(String(init?.body));return response({data:b.input.map((_s:string,index:number)=>({index,embedding:Array.from({length:768},(_,i)=>i===0?1:0)})),usage:{prompt_tokens:100,total_tokens:100}});});
 h.state.activity='index-preparation';h.state.sourceIndex=0;const input=fixtures().sources[0].chunks.map((c:any)=>c.content);
 await h.call({model:'text-embedding-3-small',input},'https://api.openai.com/v1/embeddings');assert.equal(h.state.receipts.length,1);assert.equal(h.state.calls[0].activity,'index-preparation');assert.equal((h.ledger.calls.at(-1)as any).activity,'index-preparation');
 await assert.rejects(h.call({model:'text-embedding-3-small',input},'https://api.openai.com/v1/embeddings'));assert.equal(h.state.calls.length,1);
});
test('unknown usage/abort retain reserve and stop all later calls; HTTP, truncation and count guards remain',async()=>{
 let count=0;const a=new AbortController(),h=transport(async()=>{count++;a.abort();throw new DOMException('synthetic','AbortError');});await assert.rejects(h.call(body,undefined,a.signal));assert.equal(h.ledger.unmeteredReserveUsd,baseline().unmeteredReserveUsd+.02);await assert.rejects(h.call());assert.equal(count,1);
 for(const [status,http]of [['incomplete',200],['failed',429]]as const){const x=transport(async()=>response({status,error:{type:'synthetic',code:'test'}},http));await assert.rejects(x.call());assert.equal(x.ledger.unmeteredReserveUsd,baseline().unmeteredReserveUsd+.02);}
 const capped=transport(async()=>response(completed()));capped.state.calls=Array.from({length:7},()=>({}));await assert.rejects(capped.call());assert.equal(capped.state.stopReason,'REQUEST_COUNT_CEILING');
});
test('invalid vector receipt never proves readiness and a foreign native send is never forwarded',async()=>{
 for(const vector of [[],Array(767).fill(1),Array(768).fill(0)]){
  const h=transport(async()=>response({data:[{index:0,embedding:vector}],usage:{prompt_tokens:100,total_tokens:100}}));
  await assert.rejects(h.call({model:'text-embedding-3-small',input:[aenSpec.question]},'https://api.openai.com/v1/embeddings'));
  assert.equal(h.state.stopReason,'INVALID_EMBEDDING_RECEIPT');assert.equal(h.state.receipts.length,0);await assert.rejects(h.call());
 }
 let calls=0;const h=transport(async()=>{calls++;return response({});});await assert.rejects(h.call({text:'synthetic'},'https://graph.facebook.com/v20.0/me/messages'));assert.equal(calls,0);assert.equal(h.state.replies.length,0);
});

test('exact persistent A-en rehearsal: actual coordinator/SQL/restart, SDK transport interception, native extraction/verifier, no credentials', {timeout:45000},async t=>{
 const bytes=readFileSync('docs/validation/shared-core-2026-10-22/source-aware-usage.json'),b=baseline(),ledger=structuredClone(b),originalEnv={...process.env};
 incidentFlags();process.env.OPENAI_API_KEY='synthetic-offline-only';delete process.env.ODINLINK_SHARED_PG;
 for(const name of Object.keys(process.env))if(/SUPABASE|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|^DATABASE_URL$/u.test(name))delete process.env[name];
 const state:PersistentState={stopReason:null,calls:[],replies:[],startedAt:performance.now(),activity:'index-preparation',sourceIndex:0,receipts:[]},controller=new AbortController(),record:any={mode:'offline-rehearsal',credentialAccess:false,realProviderRequests:0};
 const provider=async(input:any,init:any)=>{
  const url=new URL(String(input)),body=JSON.parse(String(init.body));assert.equal(url.origin,'https://api.openai.com');
  if(url.pathname==='/v1/embeddings')return response({data:body.input.map((_s:string,index:number)=>({index,embedding:Array.from({length:768},(_,i)=>i===0?1:0)})),usage:{prompt_tokens:100,total_tokens:100}});
  assert.equal(url.pathname,'/v1/responses');const instruction=body.instructions;let output:any;
  if(instruction.includes('language-routing classifier'))output={language:'en',requestedReplyLanguage:null,confidence:.99};
  else{
   const data=JSON.parse(body.input[0].content);assert.equal(data.question,aenSpec.question);assert.ok(data.evidence.every((e:any)=>e.businessId===77));
   if(instruction.includes('UNIT EXTRACTION'))output={units:documentaryStatements.A.en.map((text,i)=>{const quote=documentaryQuotes.A[i],e=data.evidence.find((e:any)=>e.text.includes(quote));assert.ok(e);return {facetIds:['f1'],subject:'AdMotion Studio visitor policy',predicate:`preparation policy ${i}`,value:text,scope:'documented visitor conditions',modality:['required','recommended','permitted','prohibited','permitted'][i],negation:i===3,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:e.id,exactQuote:quote}]};})};
   else if(instruction.includes('BATCH ENTAILMENT')){
    for(const u of data.units)for(const r of u.evidenceRefs)assert.ok(data.evidence.find((e:any)=>e.id===r.evidenceId)?.text.includes(r.exactQuote));
    output={decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:data.facets.map((f:any)=>({facetId:f.id,requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:f.obligations.map((o:any)=>({obligationId:o.id,status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}))}))};
   }else throw Error('Unexpected stage; no planner or optional composition is needed');
  }
  return response(completed(JSON.stringify(output)));
 };
 const guarded=persistentTransport({ledger,baseline:b,key:'synthetic-offline-only',state,controller,network:provider,save:()=>{},saveLedger:()=>validateCurrentLedger(ledger,b)});
 t.mock.method(globalThis,'fetch',async(input,init)=>{record.attemptedRequests||=[];record.attemptedRequests.push({url:String(input),body:JSON.parse(String(init?.body))});return guarded(input,init);});for(const m of ['log','warn','error','info']as const)t.mock.method(console,m,()=>{});
 try{
  await runPersistentLifecycle({key:'synthetic-offline-only',state,controller,save:()=>{},record,mode:'offline-rehearsal'});
  assert.equal(state.stopReason,null);assert.equal(record.automaticIntegrityPassed,true);assert.equal(state.calls.length,6);assert.equal(state.receipts.filter(r=>r.activity==='index-preparation').length,2);assert.equal(state.receipts.filter(r=>r.activity==='customer').length,1);
  assert.deepEqual(state.calls.map(c=>[c.activity,c.stage]),[['index-preparation','embedding'],['index-preparation','embedding'],['customer','language'],['customer','embedding'],['customer','extraction'],['customer','verification']]);
  for(const text of documentaryStatements.A.en)assert.ok(state.replies[0].includes(text),'Every obligation must survive the actual shared pipeline');
  assert.equal(record.actions,0);assert.equal(record.indexReadiness.coverage.complete,true);assert.equal(record.indexReadiness.coverage.sources.reduce((n:number,s:any)=>n+s.compatibleChunks,0),6);
  assert.equal(record.databaseCalls.some((c:any)=>c.name==='search_knowledge_index_snapshot_v1'&&c.args.p_queries.length===1),true);
  assert.deepEqual(readFileSync('docs/validation/shared-core-2026-10-22/source-aware-usage.json'),bytes);
  if(process.env.ODINLINK_PHASE4_REHEARSAL_OUTPUT)writeFileSync(process.env.ODINLINK_PHASE4_REHEARSAL_OUTPUT,JSON.stringify({...record,state,simulatedLedgerAfter:{calls:ledger.calls.length,estimatedUsd:ledger.estimatedUsd,reserveUsd:ledger.unmeteredReserveUsd}},null,2),{flag:'wx'});
 }finally{
  if(process.env.ODINLINK_PHASE4_REHEARSAL_OUTPUT&&!existsSync(process.env.ODINLINK_PHASE4_REHEARSAL_OUTPUT))writeFileSync(process.env.ODINLINK_PHASE4_REHEARSAL_OUTPUT,JSON.stringify({...record,state,simulatedLedgerAfter:{calls:ledger.calls.length,estimatedUsd:ledger.estimatedUsd,reserveUsd:ledger.unmeteredReserveUsd}},null,2),{flag:'wx'});
  controller.abort();for(const name of Object.keys(process.env))if(!(name in originalEnv))delete process.env[name];Object.assign(process.env,originalEnv);
 }
});
