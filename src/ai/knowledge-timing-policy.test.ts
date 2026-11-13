import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCURACY_FIRST_POLICY as P, NativeKnowledgeTiming, accuracyFirstExtractionAllowance as allowance,
  accuracyFirstEnabled, knowledgeAdmission, nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
import { InformationBudget, completeKnowledgeManifest } from './business-information-answer-plan';
import { knowledgeProposalAllowance } from './knowledge-planning';
import { verificationAdmissionDiagnostic } from './knowledge-answer-protocol';
import { AiRequestQueue } from './request-queue';
import { runAiProviderRequest } from './reliability';

// This file specifies the 45s default; the extension is set explicitly per test below.
delete process.env.ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS;delete process.env.ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS;
const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
const deferred = <T=void>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve}; };
const clock = (t:any) => t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
function admissionSettings(t:any, active?:string, waiting?:string) {
 const saved={active:process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS,waiting:process.env.KNOWLEDGE_MAX_WAITING_REQUESTS};
 const set=(name:string,value:string|undefined)=>{if(value===undefined)delete process.env[name];else process.env[name]=value;};
 set('KNOWLEDGE_MAX_ACTIVE_REQUESTS',active);set('KNOWLEDGE_MAX_WAITING_REQUESTS',waiting);
 t.after(()=>{set('KNOWLEDGE_MAX_ACTIVE_REQUESTS',saved.active);set('KNOWLEDGE_MAX_WAITING_REQUESTS',saved.waiting);});
}

test('extended timing requires both backend selector and exact tenant enrollment',()=>{
 const enabled={ODINLINK_KNOWLEDGE_TIMING_POLICY:P.version,ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'3'};
 assert.equal(accuracyFirstEnabled(3,enabled),true);
 for(const id of [1,2,4,77,0,-3,NaN,Infinity,3.5,'3',undefined,null] as any[])
  assert.equal(accuracyFirstEnabled(id,enabled),false);
 assert.equal(accuracyFirstEnabled(3,{...enabled,ODINLINK_KNOWLEDGE_TIMING_POLICY:'off'}),false);
 assert.equal(accuracyFirstEnabled(3,{ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:'3'}),false);
 // 'all' is the explicit global mode (see sol-release-readiness.test.ts); near-misses stay OFF.
 for(const list of [undefined,'','*','ALL',' all','all,3','03','3,','3,invalid','3,0','3,-1','3,1.5','3,1e2','3,9007199254740992',Array(11).fill('3').join(',')])
  assert.equal(accuracyFirstEnabled(3,{...enabled,ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:list}),false,list);
 assert.equal(accuracyFirstEnabled(3,{...enabled,ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS:' 3, 8 '}),true);
 // No cached enrollment: changing the backend list affects the next admission.
 enabled.ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS='4';assert.equal(accuracyFirstEnabled(3,enabled),false);
});

test('trial settings are immutable and legacy default stays 20s / 1500ms',()=>{
 assert.ok(Object.isFrozen(P));const old=new InformationBudget();assert.equal(old.remaining(),20000);assert.equal(old.publicationReserveMs,1500);
 assert.equal(P.turnMs,45000);assert.equal(P.knowledgeMs,35000);assert.equal(P.verificationReserveMs,12000);
});
for(const [g,expected] of [[31650,19650],[32000,20000],[25000,13000],[12000,0],[11999,0],[NaN,0],[Infinity,0]])
 test(`dynamic extraction allowance ${g} -> ${expected}`,()=>assert.equal(allowance(g),expected));
test('before/after incident allocation leaves mandatory verification and publication time',t=>{
 clock(t);const timing=new NativeKnowledgeTiming();t.after(()=>timing.close());t.mock.timers.tick(1792);
 const trial=new InformationBudget(undefined,timing);t.mock.timers.tick(318);
 assert.equal(knowledgeProposalAllowance(19682-1500),9091);
 assert.equal(trial.remaining(),34682);assert.equal(allowance(trial.generationRemaining()),19682);
 assert.equal(trial.remaining()-allowance(trial.generationRemaining()),15000);
});
for(const extended of [false,true])test(`measured extraction 6773ms and slow verifier: ${extended?'scoped success':'legacy timeout'}`,async t=>{
 clock(t);const timing=extended?new NativeKnowledgeTiming():undefined;
 t.after(()=>timing?.close());const budget=new InformationBudget(undefined,timing);
 t.mock.timers.tick(1592);
 const proposal=extended?allowance(budget.generationRemaining()):knowledgeProposalAllowance(budget.generationRemaining());
 await runAiProviderRequest({timeoutMs:proposal,cancelOnTimeout:true,invoke:async()=>{t.mock.timers.tick(6773);return 'three proposed units';}});
 t.mock.timers.tick(602);
 const verifier=deferred<string>();let signal:AbortSignal|undefined;
 const limit=Math.min(20000,budget.generationRemaining());
 assert.equal(limit,extended?20000:9533);
 const pending=runAiProviderRequest({timeoutMs:limit,cancelOnTimeout:true,invoke:async(_,s)=>{signal=s;return verifier.promise;}});
 const result=extended?pending:assert.rejects(pending,(e:any)=>e.category==='TIMEOUT');
 await flush();t.mock.timers.tick(9535);await flush();
 if(extended){
  assert.equal(signal?.aborted,false);t.mock.timers.tick(2465);verifier.resolve('independent complete verdict');
  assert.equal(await result,'independent complete verdict');assert.ok(budget.remaining()>budget.publicationReserveMs);
 }else{
  await result;assert.equal(signal?.aborted,true);assert.equal(budget.remaining(),1498);
  verifier.resolve('late verdict cannot replace fallback');await flush();
 }
});
test('absolute deadline includes language/queue work and never resets on repeated access',t=>{
 clock(t);const timing=new NativeKnowledgeTiming();t.after(()=>timing.close());const outer=timing.deadlineAt;
 t.mock.timers.tick(10000);const deadline=timing.knowledgeDeadline();assert.equal(deadline,outer-7000);
 t.mock.timers.tick(5000);assert.equal(timing.knowledgeDeadline(),deadline);
 assert.equal(new InformationBudget(undefined,timing).deadlineAt,deadline);
 assert.throws(()=>{(timing as any).deadlineAt=Date.now()+45000;},TypeError);
});
test('bounded diagnostics preserve terminal delivery and closure under repeated source reads',()=>{
 const timing=new NativeKnowledgeTiming();for(let i=0;i<100;i++)timing.record('operation_started');
 timing.record('delivery_started');timing.close();assert.ok(timing.events.length<=64);
 assert.ok(timing.events.some(e=>e.event==='delivery_started'));assert.equal(timing.events.at(-1)?.event,'closed');
});
test('verification dispatch floor includes stage timeout, queue consumption and reserve',()=>{
 for(const [generation,admitted] of [[10000,true],[9999,false],[6000,false]] as const){
  assert.equal(verificationAdmissionDiagnostic(generation+P.publicationMs,P.publicationMs,P.verificationDispatchMs,'after_queue').admitted,admitted);
 }
});
test('source wait abort cannot return a late success',async t=>{
 clock(t);const timing=new NativeKnowledgeTiming();const late=deferred<string>();t.after(()=>timing.close());
 const pending=timing.wait(()=>late.promise);const result=assert.rejects(pending,/knowledge_deadline/);
 await flush();t.mock.timers.tick(38000);await result;late.resolve('revoked late source');await timing.drain();
 assert.equal(timing.failure,true);await assert.rejects(timing.wait(async()=> 'late'),/knowledge_deadline/);
});
test('bounded admission rejects overload, and aborted queued work never executes',async()=>{
 const queue=new AiRequestQueue(1,1),held=deferred();const first=queue.run(()=>held.promise);await flush();
 const controller=new AbortController();let ran=false;
 const waiting=queue.run(async()=>{ran=true;},undefined,controller.signal);
 const rejected=assert.rejects(waiting,/cancel/);
 await assert.rejects(queue.run(async()=>{}),/overload/);assert.equal(queue.snapshot().waiting,1);
 controller.abort(Error('cancel'));await rejected;held.resolve();await first;
 assert.equal(ran,false);assert.equal(queue.snapshot().active,0);
});
test('native admission defaults to one active turn and retains explicit operator bounds',t=>{
 admissionSettings(t);assert.deepEqual(knowledgeAdmission().snapshot(),{active:0,waiting:0,concurrency:1,maxWaiting:3});
 process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS='1';assert.equal(knowledgeAdmission().snapshot().concurrency,1);
 process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS='99';process.env.KNOWLEDGE_MAX_WAITING_REQUESTS='99';
 assert.deepEqual(knowledgeAdmission().snapshot(),{active:0,waiting:0,concurrency:3,maxWaiting:12});
 process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS='0';assert.equal(knowledgeAdmission().snapshot().concurrency,1);
 process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS='invalid';assert.equal(knowledgeAdmission().snapshot().concurrency,1);
});
test('four staggered native turns share two slots in FIFO order without renewing any deadline',async t=>{
 admissionSettings(t,'2');clock(t);
 const start=Date.now(),names=['telegram','whatsapp','instagram','messenger'];
 const arrivals=[0,12777,16511,23145],owners:NativeKnowledgeTiming[]=[],jobs:Promise<unknown>[]=[],admitted:number[]=[],completed:number[]=[],fallbacks:number[]=[];
 let active=0,peak=0;
 const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
 // Scheduling rehearsal only: measured incident extraction/verification times,
 // with 1s of local work. It does not simulate model correctness or all incident overhead.
 const launch=(i:number)=>jobs.push(runAccuracyFirstNative(async()=>{
  const owner=nativeKnowledgeTiming()!;owners[i]=owner;admitted[i]=Date.now()-start;active++;peak=Math.max(peak,active);
  try{
   assert.equal(owner.startedAt,start+arrivals[i]);assert.equal(owner.deadlineAt,start+arrivals[i]+P.turnMs);
   const budget=new InformationBudget(undefined,owner);
   await owner.wait(()=>pause(1000));
   assert.ok(allowance(budget.generationRemaining())>=6154,names[i]+' extraction retains verification reserve');
   await owner.wait(()=>pause(6154));
   assert.ok(verificationAdmissionDiagnostic(budget.remaining(),budget.publicationReserveMs,P.verificationDispatchMs,'after_queue').admitted);
   await owner.wait(()=>pause(12047));
   assert.ok(budget.remaining()>P.publicationMs);
   await owner.deliver(async()=>{completed.push(i);});
  }finally{active--;}
 },async()=>{fallbacks.push(i);}));
 // Small steps flush asynchronous continuations before advancing the next timer.
 for(let elapsed=0;elapsed<=60000;elapsed++){
  const i=arrivals.indexOf(elapsed);if(i>=0)launch(i);
  await flush();if(completed.length+fallbacks.length===4)break;
  t.mock.timers.tick(1);
 }
 await Promise.all(jobs);
 assert.equal(peak,2);assert.equal(active,0);assert.deepEqual(fallbacks,[]);assert.deepEqual(completed,[0,1,2,3]);
 assert.deepEqual(admitted,[0,12777,19201,31978]);
 assert.ok(owners.every((owner,i)=>owner.deadlineAt===start+arrivals[i]+45000));
 assert.deepEqual(knowledgeAdmission().snapshot(),{active:0,waiting:0,concurrency:2,maxWaiting:3});
});
test('two native turns leave the third provider slot usable by unrelated work',async t=>{
 admissionSettings(t,'2');const providers=new AiRequestQueue(3),held=[deferred(),deferred()];let unrelated=false;
 const jobs=held.map(h=>runAccuracyFirstNative(async()=>{
  const owner=nativeKnowledgeTiming()!;
  return owner.wait(()=>providers.run(()=>h.promise,undefined,owner.signal));
 },async()=>assert.fail('Held work is resolved before its deadline')));
 await flush();assert.equal(knowledgeAdmission().snapshot().active,2);assert.equal(providers.snapshot().active,2);
 await providers.run(async()=>{unrelated=true;});assert.equal(unrelated,true);assert.equal(providers.snapshot().active,2);
 held.forEach(h=>h.resolve());await Promise.all(jobs);assert.equal(providers.snapshot().active,0);
});
test('two ignored aborts retain native admission and a waiting turn never executes after its original deadline',async t=>{
 admissionSettings(t,'2');clock(t);const held=[deferred(),deferred()];let ran=0,failures=0;
 const jobs=held.map(h=>runAccuracyFirstNative(async()=>{
  const owner=nativeKnowledgeTiming()!;return owner.wait(()=>h.promise);
 },async()=>{failures++;}));
 await flush();const waiting=runAccuracyFirstNative(async()=>{ran++;},async()=>{failures++;});
 await flush();assert.equal(knowledgeAdmission().snapshot().active,2);assert.equal(knowledgeAdmission().snapshot().waiting,1);
 t.mock.timers.tick(38000);await flush();await Promise.all([...jobs,waiting]);
 assert.equal(ran,0);assert.equal(failures,3);assert.equal(knowledgeAdmission().snapshot().active,2);assert.equal(knowledgeAdmission().snapshot().waiting,0);
 // Reconfiguration cannot abandon either real pending owner.
 process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS='1';assert.equal(knowledgeAdmission().snapshot().concurrency,2);
 held[0].resolve();await flush();assert.equal(knowledgeAdmission().snapshot().active,1);
 held[1].resolve();await flush();assert.equal(knowledgeAdmission().snapshot().active,0);
 assert.equal(knowledgeAdmission().snapshot().concurrency,1);
});
test('uncooperative provider retains Knowledge admission after caller timeout and quarantine is observable',async t=>{
 admissionSettings(t,'1');clock(t);const late=deferred();let failure=0,owner:NativeKnowledgeTiming|undefined,diagnostic:any;
 const run=runAccuracyFirstNative(async()=>{owner=nativeKnowledgeTiming();return owner!.wait(()=>late.promise);},async()=>{failure++;},e=>{diagnostic=e;});
 await flush();t.mock.timers.tick(38000);await flush();await run;
 assert.equal(failure,1);assert.equal(knowledgeAdmission().snapshot().active,1);
 assert.ok(diagnostic.events.some((e:any)=>e.pending===1));
 late.resolve();await flush();assert.equal(knowledgeAdmission().snapshot().active,0);
 assert.equal(owner?.failure,true);
});
test('late uncooperative completion after fallback cannot send a second response',async t=>{
 clock(t);const late=deferred<string>();let sends=0,owner:NativeKnowledgeTiming|undefined;
 const turn=runAccuracyFirstNative(async()=>{
  owner=nativeKnowledgeTiming()!;owner.knowledgeDeadline();
  const answer=await owner.wait(()=>late.promise);
  return owner.deliver(async()=>{sends++;return answer;});
 },async()=>{await owner!.deliver(async()=>{sends++;return 'safe fallback';});});
 await flush();t.mock.timers.tick(35000);await flush();await turn;
 assert.equal(sends,1);late.resolve('late verified-looking answer');await flush();
 assert.equal(sends,1);await assert.rejects(owner!.deliver(async()=>{sends++;}),/closed|deadline|delivery_attempted/);
 assert.equal(sends,1);assert.equal(knowledgeAdmission().snapshot().active,0);
});
test('parent cancellation reaches provider, cannot be retried, and cannot become late success',async()=>{
 const parent=new AbortController(),late=deferred<string>();let calls=0,signal:AbortSignal|undefined;
 const pending=runAiProviderRequest({timeoutMs:20000,cancelOnTimeout:true,signal:parent.signal,
  invoke:async(_,s)=>{calls++;signal=s;return late.promise;}});
 const rejected=assert.rejects(pending);await flush();parent.abort(Error('aborted'));await rejected;
 assert.ok(signal?.aborted);late.resolve('late');await flush();assert.equal(calls,1);
});
test('retry and delayed event-loop completion cannot restart an absolute provider deadline',async t=>{
 clock(t);let calls=0;
 await assert.rejects(runAiProviderRequest({timeoutMs:20000,deadlineAt:Date.now()+10000,cancelOnTimeout:true,
  invoke:async()=>{calls++;throw Error('503 unavailable');},beforeRetry:()=>{t.mock.timers.tick(11000);}}), (e:any)=>e.category==='TIMEOUT');
 assert.equal(calls,1);
 await assert.rejects(runAiProviderRequest({timeoutMs:20000,deadlineAt:Date.now()+1000,cancelOnTimeout:true,
  invoke:async()=>{t.mock.timers.tick(1001);return 'late';}}),(e:any)=>e.category==='TIMEOUT');
});
test('delivery deadline aborts body work and consumes the only attempt',async t=>{
 clock(t);const timing=new NativeKnowledgeTiming();t.after(()=>timing.close());const late=deferred();let signal:AbortSignal|undefined;
 const pending=timing.deliver(async s=>{signal=s;await late.promise;s.throwIfAborted();return 'sent';});
 const rejected=assert.rejects(pending,/knowledge_deadline/);await flush();t.mock.timers.tick(5000);await rejected;
 assert.ok(signal?.aborted);await assert.rejects(timing.deliver(async()=> 'retry'),/delivery_attempted/);
 late.resolve();await timing.drain();assert.ok(timing.events.some(e=>e.event==='delivery_ambiguous'));
});
test('already authorized delivery retains its own allowance across the Knowledge compute deadline',async t=>{
 clock(t);const reply=deferred<string>();let failures=0,signal:AbortSignal|undefined;
 const turn=runAccuracyFirstNative(async()=>{
  const timing=nativeKnowledgeTiming()!;timing.knowledgeDeadline();t.mock.timers.tick(34500);
  return timing.deliver(async s=>{signal=s;return reply.promise;});
 },async()=>{failures++;});
 await flush();t.mock.timers.tick(1000);await flush();assert.equal(signal?.aborted,false);
 t.mock.timers.tick(3000);reply.resolve('accepted');assert.equal(await turn,'accepted');assert.equal(failures,0);
});
test('processing timeout retains only bounded delivery allowance and cleanup',async t=>{
 clock(t);const timing=new NativeKnowledgeTiming();t.after(()=>timing.close());t.mock.timers.tick(38000);
 assert.equal(timing.failure,true);assert.equal(timing.remaining(),7000);
 t.mock.timers.tick(5000);await assert.rejects(timing.deliver(async()=> 'late'),/deadline/);
});
test('expired authorization suppresses dispatch and an expiring window cancels in-flight delivery',async t=>{
 clock(t);const expired=new NativeKnowledgeTiming();let calls=0;
 await assert.rejects(expired.deliver(async()=>{calls++;},Date.now()),/deadline/);assert.equal(calls,0);expired.close();
 const timing=new NativeKnowledgeTiming();t.after(()=>timing.close());const late=deferred();let signal:AbortSignal|undefined;
 const delivery=timing.deliver(async s=>{signal=s;await late.promise;},Date.now()+750);
 const rejected=assert.rejects(delivery,/deadline/);await flush();t.mock.timers.tick(750);await rejected;
 assert.ok(signal?.aborted);late.resolve();await timing.drain();
});
test('complete publication rejects missing outcomes, units, conditions and unresolved obligations',()=>{
 const unit={id:'u1',verification:'ENTAILED',facetIds:['f1']};
 const facet={id:'f1',obligations:[{id:'f1.o1'}]};
 const outcome={facetId:'f1',status:'VERIFIED',requestAligned:true,materialFactsComplete:true,obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1']}]};
 const valid:any={units:[unit],facets:[facet],outcomes:[outcome]};assert.equal(completeKnowledgeManifest(valid),true);
 for(const patch of [{units:[]},{outcomes:[]},{units:[{...unit,verification:'PROPOSED'}]},
  {outcomes:[{...outcome,status:'PARTIAL'}]},{outcomes:[{...outcome,materialFactsComplete:false}]},
  {outcomes:[{...outcome,obligations:[{obligationId:'f1.o1',status:'UNRESOLVED',unitIds:[]}]}]}])
  assert.equal(completeKnowledgeManifest({...valid,...patch}),false);
});

// Controlled 50-second turn: ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS.
import { knowledgeTurnExtension, runDetachedKnowledgeShadow } from './knowledge-timing-policy';
function extensionSetting(t:any,value?:string,tenants?:string){
 const keys=['ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS','ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS'] as const,values=[value,tenants];
 const saved=keys.map(k=>process.env[k]);
 keys.forEach((k,i)=>{if(values[i]===undefined)delete process.env[k];else process.env[k]=values[i];});
 t.after(()=>keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];}));
}
test('turn extension is tenant-scoped: only exactly 5000 plus a valid list naming the business extends; everything else fails closed',()=>{
 const on=(list?:string)=>({ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS:'5000',...(list===undefined?{}:{ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS:list})});
 assert.deepEqual(knowledgeTurnExtension(3,{}),{extensionMs:0,invalid:false},'default off');
 assert.deepEqual(knowledgeTurnExtension(3,{ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS:'3'}),{extensionMs:0,invalid:false},'list alone enables nothing');
 assert.deepEqual(knowledgeTurnExtension(3,on('3')),{extensionMs:5000,invalid:false});
 assert.deepEqual(knowledgeTurnExtension(3,on(' 3, 8 ')),{extensionMs:5000,invalid:false});
 for(const other of [4,7,8_000,30,33] as number[])assert.deepEqual(knowledgeTurnExtension(other,on('3')),{extensionMs:0,invalid:false},String(other));
 for(const id of [undefined,0,-3,NaN,Infinity,3.5,'3',null] as any[])assert.deepEqual(knowledgeTurnExtension(id,on('3')),{extensionMs:0,invalid:false},String(id));
 assert.deepEqual(knowledgeTurnExtension(3,on()),{extensionMs:0,invalid:true},'missing list never enables everyone');
 for(const list of ['','all','ALL','*',' ','03','3,','3,,4','3;4','3,abc','0','-3','1.5','1e2','0x3','9007199254740992',Array(11).fill('3').join(',')])
  assert.deepEqual(knowledgeTurnExtension(3,on(list)),{extensionMs:0,invalid:true},JSON.stringify(list));
 for(const value of ['','0','5000 ',' 5000','05000','5e3','5000.0','4999','5001','10000','15000','-5000','true','5s'])
  assert.deepEqual(knowledgeTurnExtension(3,{ODINLINK_KNOWLEDGE_TURN_EXTENSION_MS:value,ODINLINK_KNOWLEDGE_TURN_EXTENSION_TENANT_IDS:'3'}),{extensionMs:0,invalid:true},value);
});
test('5000 extends turn and Knowledge window equally; every reserve, cap and floor is unchanged',t=>{
 clock(t);
 for(const [ext,turn,knowledge,extraction] of [[0,45000,35000,11115],[5000,50000,40000,16115]] as const){
  const timing=new NativeKnowledgeTiming(ext);t.after(()=>timing.close());
  assert.equal(timing.turnMs,turn);assert.equal(timing.knowledgeMs,knowledge);assert.equal(timing.deadlineAt,timing.startedAt+turn);
  assert.throws(()=>{(timing as any).turnMs=60000;},TypeError);assert.throws(()=>{(timing as any).deadlineAt=0;},TypeError);
  assert.equal(timing.publicationReserveMs,3000);assert.equal(timing.policy.version,'accuracy-first-v1');
  assert.equal(timing.knowledgeDeadline(),timing.startedAt+knowledge);
  const budget=new InformationBudget(undefined,timing);assert.equal(budget.generationRemaining(),knowledge-3000);
  // 10:55 shape: 8,885 ms of Knowledge time spent before Extraction.
  t.mock.timers.tick(8885);assert.equal(allowance(budget.generationRemaining()),extraction);
  // An Extraction timeout still leaves exactly 15,000 ms: Verification reserve + publication.
  t.mock.timers.tick(extraction);assert.equal(budget.remaining(),15000);
  const admission=verificationAdmissionDiagnostic(budget.remaining(),budget.publicationReserveMs,P.verificationDispatchMs,'before_queue');
  assert.equal(admission.verificationAdmissionFloorMs,10000);assert.equal(admission.effectiveAllowanceMs,12000);assert.equal(admission.admitted,true);
  t.mock.timers.tick(15000);assert.equal(budget.remaining(),0);assert.equal(timing.failure,true);
 }
 assert.equal(allowance(40000-3000),20000,'Extraction cap stays 20 s');
 assert.deepEqual([P.turnMs,P.knowledgeMs,P.extractionMs,P.verificationReserveMs,P.verificationDispatchMs,P.publicationMs,P.deliveryMs,P.cleanupMs],
  [45000,35000,20000,12000,10000,3000,5000,2000]);
 const coerced=new NativeKnowledgeTiming(10000 as any);t.after(()=>coerced.close());assert.equal(coerced.turnMs,45000);
});
async function managedTurn(t:any,value?:string,tenants?:string,businessId?:number,openWindow=true){
 extensionSetting(t,value,tenants);clock(t);
 const held=deferred(),events:any[]=[];let abortedAt=0,failures=0,start=Date.now(),turnMs=0;
 const run=runAccuracyFirstNative(async()=>{
  const timing=nativeKnowledgeTiming()!;turnMs=timing.turnMs;if(openWindow)timing.knowledgeDeadline();
  timing.signal.addEventListener('abort',()=>{abortedAt=Date.now()-start;},{once:true});
  return timing.wait(()=>held.promise);
 },async()=>{failures++;},event=>events.push(event),businessId);
 await flush();
 return {run,held,events,turnMs:()=>turnMs,abortedAt:()=>abortedAt,failures:()=>failures};
}
for(const [label,value,tenants,businessId,turn,knowledge,invalid] of [
 ['unset / business 3',undefined,undefined,3,45000,35000,false],
 ['5000 + list 3 / business 3','5000','3',3,50000,40000,false],
 ['5000 + list 3 / business 7','5000','3',7,45000,35000,false],
 ['5000 + list 3 / no authoritative business','5000','3',undefined,45000,35000,false],
 ['5000 without list / business 3','5000',undefined,3,45000,35000,true],
 ['5000 + list all / business 3','5000','all',3,45000,35000,true],
 ['10000 + list 3 / business 3','10000','3',3,45000,35000,true],
] as const)
 test(`managed turn, ${label}: processing stops at the Knowledge window and the log carries effective durations`,async t=>{
  const turn_=await managedTurn(t,value,tenants,businessId);assert.equal(turn_.turnMs(),turn);
  t.mock.timers.tick(knowledge-1);await flush();assert.equal(turn_.abortedAt(),0);
  t.mock.timers.tick(1);await flush();assert.equal(await turn_.run,undefined);
  assert.equal(turn_.abortedAt(),knowledge);assert.equal(turn_.failures(),1,'safe fallback sent once');
  turn_.held.resolve();await flush();
  const [event]=turn_.events;assert.equal(event.policyVersion,'accuracy-first-v1');
  assert.equal(event.turnMs,turn);assert.equal(event.knowledgeMs,knowledge);assert.equal(event.turnExtensionMs,turn-45000);
  assert.equal('turnExtensionInvalid' in event,invalid);
  assert.deepEqual(Object.keys(event).filter(k=>/question|text|recipient|evidence|business|tenant/iu.test(k)),[]);
 });
test('with 5000 and no Knowledge window, processing stops at turn - 7s (43s), not 38s',async t=>{
 const turn_=await managedTurn(t,'5000','3',3,false);
 t.mock.timers.tick(42999);await flush();assert.equal(turn_.abortedAt(),0);
 t.mock.timers.tick(1);await flush();await turn_.run;assert.equal(turn_.abortedAt(),43000);turn_.held.resolve();await flush();
});
test('delivery keeps its 5s window and 2s cleanup, measured from the extended deadline',async t=>{
 clock(t);
 const base=new NativeKnowledgeTiming(),extended=new NativeKnowledgeTiming(5000);t.after(()=>{base.close();extended.close();});
 t.mock.timers.tick(44000);
 await assert.rejects(base.deliver(async()=> 'sent'),/knowledge_deadline/);
 let budget=0;assert.equal(await extended.deliver(async signal=>{budget=extended.deadlineAt-2000-Date.now();return signal.aborted?'aborted':'sent';}),'sent');
 assert.equal(budget,4000);assert.equal(extended.deliverySignal.aborted,false);
 t.mock.timers.tick(4000);assert.equal(extended.deliverySignal.aborted,true,'lifetime ends at turn - 2s (48s)');
});
test('the detached Sol shadow never receives the extension',async t=>{
 extensionSetting(t,'5000','3');let seen=0;
 await runDetachedKnowledgeShadow(async()=>{seen=nativeKnowledgeTiming()!.turnMs;});assert.equal(seen,45000);
});
