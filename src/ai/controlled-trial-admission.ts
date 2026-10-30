import {isDeepStrictEqual} from 'node:util';
import {trialStage,trialCurrent,trialSha,closeTrial} from '../runtime/controlled-knowledge-trial';
import type {TrialStage} from '../runtime/controlled-knowledge-trial';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function need(v:unknown):asserts v {if(!v)throw Error('controlled_trial_admission_denied');}
const ratesVersion='controlled-trial-standard-20261029';
type Send<T>=(wire:Record<string,unknown>,signal:AbortSignal,timeout:number,project:string)=>Promise<T>;
function race<T>(p:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{
 const abort=()=>reject(signal.reason??Error('controlled_trial_cancelled'));
 signal.addEventListener('abort',abort,{once:true});p.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();
});}
/** Complete final SDK wire, exact fixed-point pricing, one durable advance hold.
 * Missing/invalid/late receipts never grant another attempt or release a hold.
 */
export async function executeTrialRequest<T>(stage:Extract<TrialStage,'language'|'query_embedding'|'source_index'>,
 params:Record<string,unknown>,options:{signal?:AbortSignal;timeoutMs:number},send:Send<T>):Promise<T>{
 const s=trialStage(stage),embedding=stage!=='language';
 let quote:Record<string,unknown>|undefined,id:string|null=null,settled=false,denied=false,dispatched=false;
 const timeoutMs=Math.min(options.timeoutMs,20000);
 need(Number.isFinite(timeoutMs)&&timeoutMs>0);
 const deadline=Date.now()+timeoutMs;
 const signal=AbortSignal.any([s.signal,...(options.signal?[options.signal]:[]),AbortSignal.timeout(timeoutMs)]);
 try{
  need(!process.env.OPENAI_BASE_URL||process.env.OPENAI_BASE_URL.replace(/\/$/u,'')==='https://api.openai.com/v1');
  need(!process.env.OPENAI_PROJECT_ID||process.env.OPENAI_PROJECT_ID===s.configuration.providerProjectId);
  if(embedding){
   need(params.model==='text-embedding-3-small'&&params.dimensions===768&&params.encoding_format==='float'&&
    Array.isArray(params.input)&&params.input.length>0&&params.input.every(x=>typeof x==='string'&&x.trim().length>0));
   if(stage==='query_embedding')need(params.input.length===1); // Query may use the existing backend query projection.
   need(Object.keys(params).sort().join(',')==='dimensions,encoding_format,input,model');
  }else{
   need(params.model==='gpt-5.6-luna'&&Array.isArray(params.input)&&params.input.length===1&&record(params.input[0])&&
    params.input[0].role==='user'&&params.input[0].content===s.question&&(!Array.isArray(params.tools)||params.tools.length===0));
  }
  const wire:Record<string,unknown>=JSON.parse(JSON.stringify(embedding?params:{...params,max_output_tokens:8192,service_tier:'default',prompt_cache_options:{mode:'implicit',ttl:'30m'}}));
  const serialized=JSON.stringify(wire),requestSha256=trialSha(serialized),inputTokenProxy=Buffer.byteLength(serialized,'utf8')+2048;
  if(stage==='source_index')need(requestSha256===s.binding.sourceRequestSha256);
  need(inputTokenProxy<=272000);
  const maximumNanoUsd=inputTokenProxy*(embedding?20:250)+(embedding?0:8192*1200);
  need(maximumNanoUsd<=s.maximumNanoUsd&&maximumNanoUsd<=s.configuration.maximumRequestNanoUsd&&maximumNanoUsd<=s.configuration.maximumTurnNanoUsd);
  quote={businessId:s.binding.businessId,turnId:s.binding.turnId,requestKey:s.binding.requestKey,stage,model:wire.model,requestSha256,
   reservationKey:trialSha(JSON.stringify([s.binding.businessId,s.binding.requestKey,stage])),inputTokenProxy,outputTokenLimit:embedding?0:8192,
   maximumNanoUsd,ratesVersion,ownerId:s.configuration.ownerId,approvalReference:s.configuration.approvalReference,
   providerProjectId:s.configuration.providerProjectId,maximumRequestNanoUsd:s.configuration.maximumRequestNanoUsd,maximumTurnNanoUsd:s.configuration.maximumTurnNanoUsd};
  signal.throwIfAborted();need(await race(trialCurrent(),signal));
  const receipt=await race(s.rpc('reserve',{scope:s.binding,quote},signal),signal);denied=receipt===null;
  need(record(receipt)&&typeof receipt.id==='string'&&/^[a-f0-9-]{36}$/iu.test(receipt.id)&&receipt.reservationKey===quote.reservationKey&&receipt.maximumNanoUsd===maximumNanoUsd);
  id=receipt.id;signal.throwIfAborted();need(await race(trialCurrent(),signal));signal.throwIfAborted();
  need(trialSha(JSON.stringify(wire))===requestSha256&&deadline>Date.now());
  const settle=async(raw:unknown)=>{
   need(record(raw)&&raw.model===wire.model&&record(raw.usage));const u=raw.usage;
   let input:unknown,output:unknown,cached:unknown,writes:unknown,reasoning:unknown,providerResponseId:unknown;
   if(embedding){input=u.prompt_tokens;output=0;cached=0;writes=0;reasoning=0;providerResponseId=raw._request_id;
    need(u.total_tokens===input&&typeof providerResponseId==='string'&&/^req_[A-Za-z0-9_-]+$/u.test(providerResponseId));
   }else{
    need(raw.service_tier==='default'&&isDeepStrictEqual(raw.prompt_cache_options,{mode:'implicit',ttl:'30m'}));
    need(record(u.input_tokens_details)&&record(u.output_tokens_details));
    input=u.input_tokens;output=u.output_tokens;cached=u.input_tokens_details.cached_tokens;writes=u.input_tokens_details.cache_write_tokens;
    reasoning=u.output_tokens_details.reasoning_tokens;providerResponseId=raw.id;
    const ttl=u.input_tokens_details.cache_write_tokens_details;need(!record(ttl)||!ttl.ttl_12h_tokens);
    need(typeof providerResponseId==='string'&&/^resp_[A-Za-z0-9_-]+$/u.test(providerResponseId));
   }
   need(integer(input)&&input<=inputTokenProxy&&integer(output)&&output<=(embedding?0:8192)&&integer(cached)&&integer(writes)&&
    cached+writes<=input&&integer(reasoning)&&reasoning<=output);
   const cost=embedding?input*20:(input-cached-writes)*200+cached*20+writes*250+output*1200;
   need(integer(cost)&&cost<=maximumNanoUsd);
   const usage={model:wire.model,ownerId:s.configuration.ownerId,ratesVersion,requestSha256,providerProjectId:s.configuration.providerProjectId,
    inputTokens:input,outputTokens:output,cachedTokens:cached,cacheWriteTokens:writes,reasoningTokens:reasoning,estimatedNanoUsd:cost,providerResponseId};
   const result=await s.rpc('settle',{id,quote,usage});need(record(result)&&result.settled===true);
  };
  dispatched=true;const pending=send(wire,signal,deadline-Date.now(),s.configuration.providerProjectId);
  void pending.then(async raw=>{if(signal.aborted){try{await settle(raw);}catch{/* Durable hold remains. */}}},()=>{});
  const raw=await race(pending,signal);await race(settle(raw),signal);settled=true;signal.throwIfAborted();need(await race(trialCurrent(),signal));return raw;
 }catch(error){
  if(quote&&!settled&&!denied){try{await s.rpc('unknown',{id,quote});}catch{/* Keep possible hold. */}}
  // A confirmed optional query dispatch timeout may retain lexical evidence;
  // all authorization, reserve and receipt-identity failures close the turn.
  if(!(stage==='query_embedding'&&id&&dispatched&&signal.aborted&&!s.signal.aborted))closeTrial();
  throw error;
 }
}
