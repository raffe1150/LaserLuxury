import test from 'node:test';
import assert from 'node:assert/strict';
import { InformationBudget } from './business-information-answer-plan';
import { nativeKnowledgeTiming, runAccuracyFirstNative } from './knowledge-timing-policy';
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/dev/null',AI_PROVIDER:'gemini',MAX_CONCURRENT_AI_REQUESTS:'1'});
const {priority1hUnifiedEngineTestBoundary:b}=await import('../../server');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};

test('actual provider dispatch rechecks the ten-second verifier floor after shared-queue waiting',async t=>{
 b.reset();let now=Date.now();t.mock.method(Date,'now',()=>now);const held=deferred();let verifierCalls=0,failed=0;
 for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,()=>{});
 b.configure({geminiGenerate:async p=>{
  if(p.config.systemInstruction==='unrelated queue holder')return held.promise;
  verifierCalls++;return{text:'should not dispatch'};
 }});
 try {
  const holder=b.promptAuditGenerate(null,{messages:[{role:'user',content:'synthetic'}],systemInstruction:'unrelated queue holder'});
  await flush();
  const pending=runAccuracyFirstNative(async()=>b.promptAuditGenerate(null,{messages:[{role:'user',content:'{}'}],
   systemInstruction:'synthetic verifier scheduling only',informationBudget:new InformationBudget(undefined,nativeKnowledgeTiming()),
   context:{stage:'knowledge_units_verification'}}),async()=>{failed++;});
  await flush();now+=11000;held.resolve({text:'holder complete'});await holder;await pending;
  assert.equal(verifierCalls,0,'Nine seconds of the stage window remain, although the Knowledge window is larger');
  assert.equal(failed,1);
 } finally {b.reset();}
});

test('actual extraction dispatch consumes queue time and retains downstream verification capacity',async t=>{
 b.reset();let now=Date.now();t.mock.method(Date,'now',()=>now);const held=deferred();let budget:InformationBudget|undefined,remainingBeforeClose=0;
 const stages:string[]=[];for(const method of ['log','info','warn','error'] as const)t.mock.method(console,method,()=>{});
 b.configure({geminiGenerate:async p=>{
  if(p.config.systemInstruction==='unrelated queue holder')return held.promise;
  assert.ok(p.config.abortSignal instanceof AbortSignal);
  stages.push(p.config.systemInstruction);now+=p.config.systemInstruction==='extraction'?13000:1000;return{text:'synthetic result'};
 }});
 try {
  const holder=b.promptAuditGenerate(null,{messages:[{role:'user',content:'synthetic'}],systemInstruction:'unrelated queue holder'});await flush();
  const pending=runAccuracyFirstNative(async()=>{
   budget=new InformationBudget(undefined,nativeKnowledgeTiming());
   const options={messages:[{role:'user',content:'{}'}],informationBudget:budget};
   await b.promptAuditGenerate(null,{...options,systemInstruction:'extraction',context:{stage:'knowledge_units_extraction'}});
   assert.equal(budget.generationRemaining(),13000);
   await b.promptAuditGenerate(null,{...options,systemInstruction:'verification',context:{stage:'knowledge_units_verification'}});
   remainingBeforeClose=budget.remaining();
  },async()=>assert.fail('Both bounded stages should complete'));
  await flush();now+=6000;held.resolve({text:'holder complete'});await holder;await pending;
  assert.deepEqual(stages,['extraction','verification']);assert.equal(remainingBeforeClose,15000);
  assert.equal(budget?.remaining(),0,'A completed/closed turn cannot spend leftover time');
 }finally{b.reset();}
});
