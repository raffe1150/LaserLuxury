import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCURACY_FIRST_POLICY as P, NativeKnowledgeTiming, accuracyFirstExtractionAllowance as allowance,
  knowledgeAdmission, nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
import { InformationBudget, completeKnowledgeManifest } from './business-information-answer-plan';
import { knowledgeProposalAllowance } from './knowledge-planning';
import { verificationAdmissionDiagnostic } from './knowledge-answer-protocol';
import { AiRequestQueue } from './request-queue';
import { runAiProviderRequest } from './reliability';

const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
const deferred = <T=void>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve}; };
const clock = (t:any) => t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});

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
test('uncooperative provider retains Knowledge admission after caller timeout and quarantine is observable',async t=>{
 clock(t);const late=deferred();let failure=0,owner:NativeKnowledgeTiming|undefined,diagnostic:any;
 const run=runAccuracyFirstNative(async()=>{owner=nativeKnowledgeTiming();return owner!.wait(()=>late.promise);},async()=>{failure++;},e=>{diagnostic=e;});
 await flush();t.mock.timers.tick(38000);await flush();await run;
 assert.equal(failure,1);assert.equal(knowledgeAdmission().snapshot().active,1);
 assert.ok(diagnostic.events.some((e:any)=>e.pending===1));
 late.resolve();await flush();assert.equal(knowledgeAdmission().snapshot().active,0);
 assert.equal(owner?.failure,true);
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
