import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {knowledgeOperation} from '../p2/knowledge-operation';
import type {AiMoneyDatabase} from '../ai/durable-knowledge-budget-owner';
import type {KnowledgeModelBinding} from '../ai/knowledge-model-policy';

export const CONTROLLED_TRIAL_MODE='controlled-knowledge-v1';
export type TrialChannel='telegram'|'whatsapp'|'messenger'|'instagram';
export type TrialStage='language'|'query_embedding'|'source_index'|'extraction'|'verification';
export const trialSha=(v:string)=>createHash('sha256').update(v).digest('hex');
export const trialModeOn=(env:NodeJS.ProcessEnv=process.env)=>Boolean(env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL && env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL!=='off');
function freeze<T>(v:T):Readonly<T>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const decimalId=(v:unknown)=>typeof v==='number'?Number.isSafeInteger(v)&&v>=0:typeof v==='string'&&/^\d+$/u.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
function requireTrial(ok:unknown):asserts ok {if(!ok)throw Error('controlled_trial_denied');}
export type TrialIdentity=Readonly<{channel:TrialChannel;account:string;sender:string;recipient:string}>;
type Configuration={trialId:string;businessId:number;ownerId:string;approvalReference:string;providerProjectId:string;ratesVersion:string;
 maximumRequestNanoUsd:number;maximumTurnNanoUsd:number;expiresAt:string;identities:TrialIdentity[]};
type Authority={configuration:Readonly<Configuration>;rpc:(command:string,payload:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>};
let installed:Authority|undefined;let installation=0;
type Lease=KnowledgeModelBinding & {trialId:string;caseId:string;leaseToken:string;kind:'knowledge'|'source_index';channel?:TrialChannel;
 account?:string;sender?:string;recipient?:string;stageCaps:Partial<Record<TrialStage,number>>;sourceId?:string;sourceRevision?:string;sourceRequestSha256?:string};
type Scope={authority:Authority;lease:Readonly<Lease>;question:string;tokenSha:string;connection:()=>Promise<{businessId:number;tokenSha:string}|null>;
 controller:AbortController;used:Set<TrialStage>;closed:boolean};
const context=new AsyncLocalStorage<Scope>();
export const trialEnforced=()=>trialModeOn()||!!context.getStore();
export const controlledTrialSignal=()=>context.getStore()?.controller.signal;
export const controlledTrialBinding=():KnowledgeModelBinding|undefined=>{
 const l=context.getStore()?.lease;return l?Object.freeze({businessId:l.businessId,turnId:l.turnId,requestKey:l.requestKey}):undefined;
};
export const controlledTrialSource=()=>{const l=context.getStore()?.lease;return l?.kind==='source_index'?Object.freeze({businessId:l.businessId,sourceId:l.sourceId!,sourceRevision:l.sourceRevision!}):undefined;};
export function denyTrialAction():void {if(trialEnforced())throw Error('controlled_trial_business_action_denied');}
export function assertTrialProvider(provider:string,stage?:string):void {
 if(!trialEnforced())return;
 if(provider!=='openai'||!context.getStore()||!['semantic_language_resolution','knowledge_units_extraction','knowledge_units_verification'].includes(stage??'')) {
  context.getStore()?.controller.abort();throw Error('controlled_trial_provider_stage_denied');
 }
}
export function trialHttpAllowed(path:string):boolean {
 return !trialModeOn()||['/health','/webhook','/webhook/messenger','/webhook/instagram','/webhook/facebook'].includes(path);
}
export function trialPollerAllowed(businessId:number,botId:string):boolean {
 if(!trialModeOn())return true;
 return !!installed&&installed.configuration.businessId===businessId&&installed.configuration.identities.some(i=>i.channel==='telegram'&&i.account===botId);
}
export const trialBusinessId=()=>installed?.configuration.businessId;

/** Backend bootstrap only; no policy, identities, money, cases or approval defaults. */
export async function installControlledTrial(db:AiMoneyDatabase|undefined,env:NodeJS.ProcessEnv=process.env):Promise<boolean>{
 env={ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL:env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL,
  ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL_ID:env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL_ID,
  ODINLINK_AI_MONEY_ACCOUNT:env.ODINLINK_AI_MONEY_ACCOUNT,ODINLINK_AI_MONEY_APPROVAL:env.ODINLINK_AI_MONEY_APPROVAL};
 const generation=++installation;installed=undefined;
 if(!trialModeOn(env))return false;
 requireTrial(env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL===CONTROLLED_TRIAL_MODE&&db&&id(env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL_ID)&&
  id(env.ODINLINK_AI_MONEY_ACCOUNT)&&id(env.ODINLINK_AI_MONEY_APPROVAL));
 const rpc=async(command:string,payload:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>=>knowledgeOperation(async s=>{
  const q=db.rpc('odin_ai_money_trial_v1',{p_account:env.ODINLINK_AI_MONEY_ACCOUNT,p_approval:env.ODINLINK_AI_MONEY_APPROVAL,
   p_trial:env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL_ID,p_command:command,p_payload:payload});
  const {data,error}=await(q.abortSignal?q.abortSignal(s):q);if(error)throw Error('controlled_trial_storage_unavailable');return data;
 },{signal,independent:true,timeoutMs:3000,factualResult:command==='settle'});
 const c=await rpc('configuration',{});
 requireTrial(record(c)&&c.trialId===env.ODINLINK_CONTROLLED_KNOWLEDGE_TRIAL_ID&&positive(c.businessId)&&id(c.ownerId)&&
  c.approvalReference===env.ODINLINK_AI_MONEY_APPROVAL&&typeof c.providerProjectId==='string'&&/^proj_[A-Za-z0-9_-]+$/u.test(c.providerProjectId)&&
  c.ratesVersion==='controlled-trial-standard-20261029'&&positive(c.maximumRequestNanoUsd)&&positive(c.maximumTurnNanoUsd)&&
  typeof c.expiresAt==='string'&&Date.parse(c.expiresAt)>Date.now()&&Array.isArray(c.identities)&&c.identities.every(i=>record(i)&&
   ['telegram','whatsapp','messenger','instagram'].includes(String(i.channel))&&id(i.account)&&id(i.sender)&&id(i.recipient)));
 if(generation!==installation)return false;
 installed={configuration:freeze(structuredClone(c) as Configuration),rpc};return true;
}

// Private transport evidence. No boolean from a request body grants authority.
type Verified=TrialIdentity&{eventId:string;text:string;fingerprint:string;tokenSha?:string};
const ingress=new AsyncLocalStorage<readonly Verified[]>();
const jsonHash=(v:unknown)=>trialSha(JSON.stringify(v));
/** Called only AFTER the existing Meta raw-body HMAC guard succeeds. */
export function withVerifiedTrialMeta<T>(raw:Buffer,work:()=>T):T{
 const body:unknown=JSON.parse(raw.toString('utf8'));const events:Verified[]=[];
 if(record(body)&&Array.isArray(body.entry))for(const entry of body.entry){if(!record(entry)||!id(entry.id))continue;
  if(body.object==='whatsapp_business_account'&&Array.isArray(entry.changes))for(const change of entry.changes){
   const value=record(change)&&record(change.value)?change.value:undefined;
   if(!value||!record(value.metadata)||!id(value.metadata.phone_number_id)||!Array.isArray(value.messages))continue;
   for(const m of value.messages){if(!record(m)||m.type!=='text'||!record(m.text)||!id(m.id)||!id(m.from)||!/^\d+$/u.test(m.from)||typeof m.text.body!=='string'||m.context)continue;
    events.push({channel:'whatsapp',account:value.metadata.phone_number_id,sender:m.from,recipient:m.from,eventId:m.id,text:m.text.body,fingerprint:jsonHash(m)});}
  }
  if(['page','instagram'].includes(String(body.object))&&Array.isArray(entry.messaging))for(const m of entry.messaging){
   if(!record(m)||!record(m.sender)||!record(m.recipient)||m.recipient.id!==entry.id||!id(m.sender.id)||!record(m.message)||
    m.message.is_echo||m.message.attachments||m.postback||!id(m.message.mid)||typeof m.message.text!=='string')continue;
   events.push({channel:body.object==='page'?'messenger':'instagram',account:entry.id,sender:m.sender.id,recipient:m.sender.id,
    eventId:m.message.mid,text:m.message.text,fingerprint:jsonHash(m)});
  }
 }
 if(trialModeOn()){
  requireTrial(record(body)&&Array.isArray(body.entry)&&body.entry.length===1&&events.length===1);
  const e=body.entry[0];requireTrial(record(e));
  if(body.object==='whatsapp_business_account')requireTrial(Array.isArray(e.changes)&&e.changes.length===1&&record(e.changes[0])&&record(e.changes[0].value)&&Array.isArray(e.changes[0].value.messages)&&e.changes[0].value.messages.length===1);
  else requireTrial(!e.changes&&Array.isArray(e.messaging)&&e.messaging.length===1);
 }
 return ingress.run(Object.freeze(events),work);
}
/** Backend poller only, after getMe, current lease and authenticated getUpdates. */
export function withVerifiedTrialTelegram<T>(update:unknown,botId:string,token:string,work:()=>T):T{
 let events:Verified[]=[];
 if(token.split(':')[0]===botId&&/^\d+$/u.test(botId)&&record(update)&&decimalId(update.update_id)&&record(update.message)){const m=update.message;
  if(record(m.from)&&record(m.chat)&&decimalId(m.from.id)&&decimalId(m.chat.id)&&m.chat.type==='private'&&String(m.from.id)===String(m.chat.id)&&m.from.is_bot!==true&&
   typeof m.text==='string'&&!m.voice&&!m.audio&&!m.document&&!m.photo&&!m.forward_origin&&!m.forward_from&&id(String(update.update_id))){
   events=[{channel:'telegram',account:botId,sender:String(m.from.id),recipient:String(m.chat.id),eventId:String(update.update_id),text:m.text,
    fingerprint:jsonHash(update),tokenSha:trialSha(token)}];
  }
 }
 return ingress.run(Object.freeze(events),work);
}
function runtimeKnowledgeReady():boolean{
 return (!process.env.AI_PROVIDER||process.env.AI_PROVIDER==='openai')&&process.env.ODINLINK_KNOWLEDGE_MODEL_PROFILE==='sol-low-v1'&&
 process.env.ODINLINK_KNOWLEDGE_EXTRACTION_PROTOCOL==='v2'&&process.env.ODINLINK_KNOWLEDGE_VERIFIER_PROTOCOL==='v2'&&
 process.env.ODINLINK_EVIDENCE_FIRST_KNOWLEDGE==='true'&&process.env.ODINLINK_KNOWLEDGE_TIMING_POLICY==='accuracy-first-v1'&&
 process.env.ODINLINK_GROUNDED_NATURAL_RESPONSES!=='true'&&process.env.ODINLINK_SMART_WAITING!=='true'&&
 !['ADMISSION','PROCESSING','DELIVERY'].some(x=>process.env['ODINLINK_ASYNC_KNOWLEDGE_'+x]==='true');
}
function leaseOf(v:unknown,a:Authority):Readonly<Lease>{
 requireTrial(record(v)&&v.trialId===a.configuration.trialId&&v.businessId===a.configuration.businessId&&id(v.caseId)&&id(v.leaseToken)&&
  v.turnId==='trial:'+v.leaseToken&&typeof v.requestKey==='string'&&/^[a-f0-9]{64}$/u.test(v.requestKey)&&
  ['knowledge','source_index'].includes(String(v.kind))&&record(v.stageCaps)&&Object.values(v.stageCaps).every(positive));
 if(v.kind==='knowledge')requireTrial(['telegram','whatsapp','messenger','instagram'].includes(String(v.channel))&&id(v.account)&&id(v.sender)&&id(v.recipient));
 else requireTrial(typeof v.sourceId==='string'&&/^[a-f0-9-]{36}$/iu.test(v.sourceId)&&typeof v.sourceRevision==='string'&&/^[a-f0-9]{64}$/u.test(v.sourceRevision)&&typeof v.sourceRequestSha256==='string'&&/^[a-f0-9]{64}$/u.test(v.sourceRequestSha256));
 return freeze(structuredClone(v) as Lease);
}
async function runScope<T>(a:Authority,lease:Readonly<Lease>,question:string,tokenSha:string,
 connection:Scope['connection'],work:()=>Promise<T>):Promise<T>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),lease.kind==='knowledge'?45000:60000);
 const state:Scope={authority:a,lease,question,tokenSha,connection,controller,used:new Set(),closed:false};
 try{return await context.run(state,work);}finally{state.closed=true;controller.abort();clearTimeout(timer);}
}
export async function runControlledTrialInbound<T>(input:{channel:TrialChannel;account:string;recipient:string;eventId:string;text:string;event:unknown},
 connection:Scope['connection'],work:()=>Promise<T>):Promise<T|undefined>{
 if(!trialModeOn())return work();const a=installed;
 if(!a||!runtimeKnowledgeReady())return;
 const verified=ingress.getStore()?.find(e=>e.channel===input.channel&&e.account===input.account&&e.recipient===input.recipient&&
  e.eventId===input.eventId&&e.text===input.text&&e.fingerprint===jsonHash(input.event));
 if(!verified)return;
 const current=await connection();if(!current||current.businessId!==a.configuration.businessId||verified.tokenSha&&verified.tokenSha!==current.tokenSha)return;
 const result=await a.rpc('claim',{kind:'knowledge',businessId:current.businessId,channel:verified.channel,account:verified.account,
  sender:verified.sender,recipient:verified.recipient,eventId:verified.eventId,questionSha256:trialSha(verified.text)});
 if(result===null)return;
 return runScope(a,leaseOf(result,a),verified.text,current.tokenSha,connection,work);
}
/** Explicit operator/index job only. Does not enable automatic runtime indexing. */
export async function runControlledSourceIndex<T>(caseId:string,work:()=>Promise<T>):Promise<T>{
 requireTrial(trialModeOn()&&installed&&id(caseId));const a=installed;
 const result=await a.rpc('claim',{kind:'source_index',caseId,eventId:'source_index:'+caseId});requireTrial(result);
 return runScope(a,leaseOf(result,a),'','',async()=>({businessId:a.configuration.businessId,tokenSha:''}),work);
}
export async function trialCurrent():Promise<boolean>{
 const s=context.getStore();if(!s||s.closed||s.controller.signal.aborted||!trialModeOn()||installed!==s.authority)return false;
 const binding=await s.connection();if(!binding||binding.businessId!==s.lease.businessId||binding.tokenSha!==s.tokenSha)return false;
 return await s.authority.rpc('current',{scope:s.lease},s.controller.signal)===true;
}
export function trialStage(stage:TrialStage){
 const s=context.getStore();requireTrial(s&&!s.closed&&!s.controller.signal.aborted&&trialModeOn()&&installed===s.authority);
 requireTrial(!s.used.has(stage)&&positive(s.lease.stageCaps[stage])&&
  (s.lease.kind==='source_index'?stage==='source_index':stage!=='source_index'));
 s.used.add(stage);return {binding:s.lease,configuration:s.authority.configuration,signal:s.controller.signal,question:s.question,
  maximumNanoUsd:s.lease.stageCaps[stage]!,rpc:s.authority.rpc};
}
export function closeTrial():void{context.getStore()?.controller.abort();}
export async function reserveControlledSol(quote:unknown,signal:AbortSignal):Promise<unknown>{
 requireTrial(record(quote)&&(quote.stage==='extraction'||quote.stage==='verification'));
 const s=trialStage(quote.stage);requireTrial(quote.businessId===s.binding.businessId&&quote.requestKey===s.binding.requestKey&&quote.turnId===s.binding.turnId&&
  quote.ownerId===s.configuration.ownerId&&quote.providerProjectId===s.configuration.providerProjectId&&typeof quote.maximumNanoUsd==='number'&&quote.maximumNanoUsd<=s.maximumNanoUsd);
 requireTrial(await trialCurrent());return s.rpc('reserve',{scope:s.binding,quote},signal);
}
export async function trialSendAllowed(input:string,init:RequestInit):Promise<boolean>{
 if(!trialEnforced())return true;const s=context.getStore();if(!s||s.lease.kind!=='knowledge'||!await trialCurrent())return false;
 const url=new URL(input),body:unknown=JSON.parse(String(init.body??''));if(url.protocol!=='https:'||url.port||url.username||url.password||!record(body)||init.method!=='POST')return false;
 if(s.lease.channel==='telegram'){if(typeof body.text!=='string'||body.reply_markup)return false;}
 else if(s.lease.channel==='whatsapp'){if(body.type!=='text'||!record(body.text)||typeof body.text.body!=='string')return false;}
 else if(!record(body.message)||typeof body.message.text!=='string'||body.message.attachment||body.message.quick_replies)return false;
 const headers=new Headers(init.headers);let token='';let receiver:unknown;
 if(s.lease.channel==='telegram'){
  const m=/^\/bot([^/]+)\/sendMessage$/u.exec(url.pathname);if(url.hostname!=='api.telegram.org'||!m||m[1].split(':')[0]!==s.lease.account)return false;
  token=m[1];receiver=body.chat_id;
 }else{
  if(url.hostname!==(s.lease.channel==='instagram'?'graph.instagram.com':'graph.facebook.com')||!url.pathname.endsWith('/messages'))return false;
  if(s.lease.channel==='whatsapp'&&!url.pathname.endsWith('/'+s.lease.account+'/messages'))return false;
  if(s.lease.channel!=='whatsapp'&&!/\/me\/messages$/u.test(url.pathname))return false;
  token=url.searchParams.get('access_token')??headers.get('authorization')?.replace(/^Bearer /u,'')??'';
  receiver=s.lease.channel==='whatsapp'?body.to:record(body.recipient)?body.recipient.id:undefined;
 }
 if(String(receiver)!==s.lease.recipient||!token||trialSha(token)!==s.tokenSha)return false;
 return await s.authority.rpc('send',{scope:s.lease},s.controller.signal)===true && await trialCurrent();
}
/** Recheck the enrolled Telegram account before every polling network iteration. */
export async function trialPollerCurrent(businessId:number,botId:string):Promise<boolean>{
 if(!trialModeOn())return true;
 if(!trialPollerAllowed(businessId,botId)||!installed)return false;
 try{const c=await installed.rpc('configuration',{});
  return record(c)&&c.businessId===businessId&&Array.isArray(c.identities)&&c.identities.some(i=>record(i)&&i.channel==='telegram'&&i.account===botId);
 }catch{return false;}
}
