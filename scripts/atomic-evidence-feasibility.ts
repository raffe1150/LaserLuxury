/** Explicitly gated synthetic verifier experiment. No server/channel imports. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parse} from 'dotenv';
import {performance} from 'node:perf_hooks';
import {generateWithOpenAi} from '../src/ai/providers/openai';
import {loadAtomicComparison,assertControlledRepresentation,accountAtomicVerdict,type AtomicArm} from '../tests/helpers/atomic-evidence-feasibility';
import {captureSyntheticVerifierRequest,captureSyntheticVerifierDecision} from '../tests/helpers/semantic-verifier-diagnostics';

if(process.env.NODE_ENV!=='test'||process.env.ODINLINK_ATOMIC_FEASIBILITY!=='true')throw Error('Synthetic atomic experiment requires explicit test opt-in');
const keyPath=process.env.ODINLINK_P0_KEY_FILE;if(!keyPath)throw Error('Local credential file required');
const key=parse(readFileSync(keyPath)).OPENAI_API_KEY;if(!key)throw Error('Local credential unavailable');process.env.OPENAI_API_KEY=key;
const comparison=loadAtomicComparison(),policy={...comparison.policy,secrets:[key]};
const directory='docs/validation/shared-core-2026-10-22/',ledgerPath=directory+'source-aware-usage.json';
const profile='source-aware-atomic-feasibility',ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
const originalFetch=globalThis.fetch,originalConsole={...console};
for(const method of ['log','info','warn','error']as const)console[method]=()=>{};
const trials:any[]=[];let active:any,expected:any;
const saveLedger=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
const save=()=>writeFileSync(directory+'real-atomic-feasibility.json',JSON.stringify({profile,productionChanged:false,
 design:'C,A; only if atomic documentary inventory is accepted and compound is not, repeat A,C. At most four calls. No full-answer completeness is inferred from entailment.',
 baselineRequestSha256:comparison.baselineRequestSha256,timeoutMs:comparison.timeoutMs,
 onlyChangedField:comparison.changedFields,model:'gpt-5.6-luna',outbound:'No channels or server invoked',trials},null,2));

globalThis.fetch=async(input,options)=>{
 const url=new URL(String(input));if(url.origin!=='https://api.openai.com'||url.pathname!=='/v1/responses')throw Error('Atomic experiment forbids other network traffic');
 const body=JSON.parse(String(options?.body));assert.deepEqual(body,expected,'Only the predeclared request can leave this process');
 const capture=captureSyntheticVerifierRequest(body,policy);
 if(ledger.estimatedUsd+ledger.unmeteredReserveUsd+.02>.30)throw Error('Existing local diagnostic spend cap would be exceeded');
 active.capture=capture;active.forwardedBytesUnchanged=String(options?.body)===JSON.stringify(expected);
 ledger.unmeteredReserveUsd+=.02;saveLedger();
 const response=await originalFetch(input,options),result=await response.clone().json().catch(()=>({}));
 active.httpStatus=response.status;
 if(result.usage){
  const u=result.usage,inputTokens=u.input_tokens??0,outputTokens=u.output_tokens??0,cached=u.input_tokens_details?.cached_tokens??0,written=u.input_tokens_details?.cache_write_tokens??0;
  const estimatedUsd=((inputTokens-cached-written)*.2+cached*.02+written*.25+outputTokens*1.2)/1e6;
  ledger.unmeteredReserveUsd-=.02;ledger.estimatedUsd+=estimatedUsd;
  ledger.calls.push({profile,arm:active.arm,trial:active.number,model:body.model,inputTokens,outputTokens,cached,estimatedUsd});saveLedger();active.usage=u;active.estimatedUsd=estimatedUsd;
 }
 const text=String(result.output_text||result.output?.filter((i:any)=>i.type==='message').flatMap((i:any)=>i.content||[]).filter((i:any)=>i.type==='output_text').map((i:any)=>i.text).join('')||'');
 active.decisionCapture=captureSyntheticVerifierDecision(capture,text,policy);
 return response;
};

async function run(arm:AtomicArm){
 expected=structuredClone(arm==='compound'?comparison.request:comparison.atomicRequest);
 const input=JSON.parse(expected.input[0].content);assertControlledRepresentation(arm,input);
 active={number:trials.length+1,arm,timeoutMs:comparison.timeoutMs,requestChars:JSON.stringify(expected).length};trials.push(active);
 const controller=new AbortController(),started=performance.now(),timer=setTimeout(()=>controller.abort(),comparison.timeoutMs);
 try{
  const f=expected.text.format;
  const result=await generateWithOpenAi({model:expected.model,systemInstruction:expected.instructions,messages:expected.input,
   reasoningEffort:expected.reasoning.effort,structuredOutput:{name:f.name,schema:f.schema,strict:f.strict,...(f.description?{description:f.description}:{})},signal:controller.signal});
  active.providerDurationMs=Math.round(performance.now()-started);clearTimeout(timer);
  if(result.structuredFailure||result.functionCalls.length)throw Error('Structured verifier response unavailable');
  assert.equal(result.text,active.decisionCapture.rawStructuredText);
  const output=JSON.parse(result.text);active.accounting=await accountAtomicVerdict(input,output);active.status='COMPLETE';
 }catch(error){active.providerDurationMs??=Math.round(performance.now()-started);active.status=controller.signal.aborted?'TIMEOUT':'ERROR';active.errorCategory=error instanceof Error?error.name:'unknown';}
 finally{clearTimeout(timer);save();originalConsole.log(JSON.stringify({trial:active.number,arm,status:active.status,durationMs:active.providerDurationMs,allDocumentaryAccepted:active.accounting?.allDocumentaryPropositionsAccepted,fullQuestion:active.accounting?.fullQuestionOutcomes?.[0]?.status}));}
 return active;
}
try{
 const control=await run('compound');
 if(control.status==='COMPLETE'){
  const atomic=await run('atomic');
  if(atomic.status==='COMPLETE'&&atomic.accounting.catalogAccepted&&control.accounting.catalogAccepted&&atomic.accounting.allDocumentaryPropositionsAccepted&&!control.accounting.allDocumentaryPropositionsAccepted){
   const repeat=await run('atomic');
   if(repeat.status==='COMPLETE'&&repeat.accounting.allDocumentaryPropositionsAccepted)await run('compound');
  }
 }
}finally{globalThis.fetch=originalFetch;Object.assign(console,originalConsole);save();}
