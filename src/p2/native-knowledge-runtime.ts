import { preflightRejected } from './knowledge-preflight-diagnostic';
import { SmartWaitingCoordinator, smartWaitingControls, type WaitingControls, type WaitingSchedule, type WaitingHandle } from './smart-waiting';
import { NativeKnowledgeProgressAuthority } from './knowledge-progress-authority';
import { randomUUID } from 'node:crypto';
import { snapshot, type KnowledgeInput, type KnowledgeScope, type KnowledgeTask } from './knowledge-lifecycle';
import { type NativeKnowledgeOrder, type OrderedAdmission } from './native-knowledge-order';
import { NativeKnowledgeBindings, databaseNativeConnections, type NativeConnectionResolver } from './native-knowledge-binding';
import { nativeProviderEligible, sendNativeKnowledge } from './native-knowledge-transport';
import { SupabaseOrderedKnowledgeRepository } from './supabase-ordered-knowledge-repository';
import { createDatabaseKnowledgeAuthority, createKnowledgeAuthority, knowledgeTurnCurrent } from './knowledge-authority';
import { KnowledgeRunner, type KnowledgeExecutor, type GuardedKnowledgeTransport, type TrustedDeliveryTarget } from './knowledge-runner';
import { KnowledgeWorkerCycle, type KnowledgeCycleReport } from './knowledge-worker-cycle';
import { runOptionalDiagnostic } from '../ai/business-information-timing';
import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';
import type { KnowledgeService } from '../../knowledge';

export type NativeAsyncControls = Readonly<{admission:boolean;processing:boolean;delivery:boolean;executionMs:number}>;
export function nativeAsyncControls(env:NodeJS.ProcessEnv=process.env):NativeAsyncControls {
  const ms=env.ODINLINK_ASYNC_KNOWLEDGE_EXECUTION_MS;
  if(ms!==undefined && !['20000','30000','35000','40000'].includes(ms))throw new Error('knowledge_invalid_execution_limit');
  return Object.freeze({admission:env.ODINLINK_ASYNC_KNOWLEDGE_ADMISSION==='true',processing:env.ODINLINK_ASYNC_KNOWLEDGE_PROCESSING==='true',
    delivery:env.ODINLINK_ASYNC_KNOWLEDGE_DELIVERY==='true',executionMs:ms?Number(ms):20000});
}
export type NativeKnowledgeIngress = Readonly<{businessId:number;channel:KnowledgeScope['channel'];account:string;recipient:string;eventId:string;order:NativeKnowledgeOrder|null}>;
export type NativeKnowledgeAdmission = Readonly<{scope:KnowledgeScope;eventId:string;order:NativeKnowledgeOrder|null;result:OrderedAdmission}>;
export class NativeKnowledgeRuntime {
  readonly bindings:NativeKnowledgeBindings;
  readonly repository:SupabaseOrderedKnowledgeRepository;
  readonly runner:KnowledgeRunner;
  readonly transport:GuardedKnowledgeTransport;
  private readonly cycle:KnowledgeWorkerCycle;
  private readonly waiting:SmartWaitingCoordinator;
  private stopped=false;private timer:ReturnType<typeof setTimeout>|undefined;private pending:Promise<KnowledgeCycleReport>|undefined;
  lastReport:KnowledgeCycleReport|null=null;lastFailure:unknown=null;
  constructor(private readonly options:{db:KnowledgeDatabase;secret:string;controls:()=>NativeAsyncControls;
    execute:(task:KnowledgeTask,context:Parameters<KnowledgeExecutor>[1],current:()=>Promise<boolean>)=>ReturnType<KnowledgeExecutor>;
    connections?:NativeConnectionResolver;sources?:Pick<KnowledgeService,'list'>;fetcher?:typeof fetch;
    waiting?:()=>WaitingControls;waitingSchedule?:WaitingSchedule;
    diagnostic?:(event:Readonly<{stage:string;turnId?:string;channel?:string}>)=>unknown}) {
    const db=options.db;const fetcher=options.fetcher||fetch;
    this.bindings=new NativeKnowledgeBindings(db,options.secret,options.connections||databaseNativeConnections(db));
    const provider={canonicalConversationKey:async(task:KnowledgeTask)=>this.bindings.canonicalKey(task.scope),
      eligible:async(task:KnowledgeTask)=>nativeProviderEligible(this.bindings,task,fetcher)};
    const authority=options.sources?createKnowledgeAuthority(db,options.sources,provider):createDatabaseKnowledgeAuthority(db,provider);
    this.repository=new SupabaseOrderedKnowledgeRepository(db,s=>this.bindings.canonicalKey(s),authority);
    const waitingControls=()=>{const c=(options.waiting||smartWaitingControls)();return {...c,enabled:c.enabled&&options.controls().processing&&options.controls().delivery&&!this.stopped};};
    const progress=new NativeKnowledgeProgressAuthority({db,secret:options.secret,enabled:()=>waitingControls().enabled,
      connections:options.connections,fetcher});
    this.waiting=new SmartWaitingCoordinator({controls:waitingControls,authority:progress,schedule:options.waitingSchedule,
      send:(target,text,signal)=>sendNativeKnowledge(target.connection,target.recipient,text,signal,fetcher),diagnostic:event=>this.event(event)});
    this.runner=new KnowledgeRunner(this.repository,async(task,context)=>{
      if(!await nativeProviderEligible(this.bindings,task,fetcher,context.signal,undefined,reason=>preflightRejected(task.turnId,task.scope.channel,'provider',reason)))return null;
      let waiting:WaitingHandle={progress:()=>{},stop:()=>{}};
      try{waiting=this.waiting.begin(task,context.signal);}catch{this.event({stage:'waiting_setup_failed',turnId:task.turnId,channel:task.scope.channel});}
      try{return await options.execute(task,{...context,progress:(stage,labels)=>waiting.progress(stage,labels)},async()=>Boolean(await this.bindings.resolve(task.scope)) && await knowledgeTurnCurrent(db,task,provider));}
      finally{try{waiting.stop();}catch{this.event({stage:'waiting_cancel_failed',turnId:task.turnId,channel:task.scope.channel});}}
    },
      `knowledge-${randomUUID()}`,2,event=>this.event({stage:event.stage,turnId:event.turnId,channel:event.channel}));
    const targetScope=(target:TrustedDeliveryTarget):KnowledgeScope|null=>Number.isSafeInteger(target.businessId) && target.conversationId && target.taskId ?
      {businessId:target.businessId!,channel:target.channel,providerAccount:target.providerAccount,conversationId:target.conversationId}:null;
    const matches=(task:KnowledgeTask,target:TrustedDeliveryTarget)=>target.businessId===task.scope.businessId && target.conversationId===task.scope.conversationId &&
      target.taskId===task.id && target.channel===task.scope.channel && target.providerAccount===task.scope.providerAccount;
    this.transport={authorize:authority,
      resolve:async task=>{const r=await this.bindings.resolve(task.scope);return r?{recipient:r.binding.recipient,channel:task.scope.channel,providerAccount:task.scope.providerAccount,
        businessId:task.scope.businessId,conversationId:task.scope.conversationId,taskId:task.id}:null;},
      eligible:async(task,target)=>matches(task,target) && (await this.bindings.resolve(task.scope))?.binding.recipient===target.recipient && await nativeProviderEligible(this.bindings,task,fetcher),
      send:async(target,text,signal)=>{
        const noSend={kind:'DEFINITIVELY_UNSENT' as const,retryable:false};const scope=targetScope(target);
        if(!scope || signal.aborted || !options.controls().delivery || this.stopped)return noSend;
        const task=await this.repository.get(scope,target.taskId!);if(!task || !matches(task,target) || task.result?.text!==text)return noSend;
        const before=await this.bindings.resolve(scope);
        if(!before || before.binding.recipient!==target.recipient || !await authority(task,'send') ||
          !await nativeProviderEligible(this.bindings,task,fetcher,signal,before.connection))return noSend;
        const after=await this.bindings.resolve(scope);
        if(!after || after.connection.id!==before.connection.id || after.connection.credential.accessToken!==before.connection.credential.accessToken ||
          after.binding.recipient!==target.recipient || !await knowledgeTurnCurrent(db,task,provider) || signal.aborted ||
          Date.now()>=task.expiresAt || !options.controls().delivery || this.stopped)return noSend;
        this.event({stage:'native_send_attempt',turnId:task.turnId,channel:task.scope.channel});
        const outcome=await sendNativeKnowledge(before.connection,target.recipient,text,signal,fetcher);
        this.event({stage:`native_${outcome.kind.toLowerCase()}`,turnId:task.turnId,channel:task.scope.channel});
        return outcome;
      }};
    this.cycle=new KnowledgeWorkerCycle(this.repository,this.runner,this.transport,`delivery-${randomUUID()}`,
      {processing:()=>options.controls().processing,delivery:()=>options.controls().delivery});
  }
  private event(event:{stage:string;turnId?:string;channel?:string}){runOptionalDiagnostic(()=>this.options.diagnostic?.(Object.freeze(event)));}
  async accept(ingress:NativeKnowledgeIngress):Promise<NativeKnowledgeAdmission|null>{
    if(this.stopped || !this.options.controls().admission)return null;
    ingress=snapshot(ingress);
    const scope=await this.bindings.ensure(ingress.businessId,ingress.channel,ingress.account,ingress.recipient);
    const result=await this.repository.acceptOrdered(scope,ingress.eventId,ingress.order,undefined,{executionMs:this.options.controls().executionMs});
    this.event({stage:`native_${result.disposition.toLowerCase()}`,turnId:result.acceptance?.identity.turnId,channel:ingress.channel});
    return snapshot({scope,eventId:ingress.eventId,order:ingress.order,result});
  }
  async attach(admission:NativeKnowledgeAdmission,input:KnowledgeInput):Promise<OrderedAdmission|null>{
    if(this.stopped || !this.options.controls().admission || !admission.result.mayAttach)return null;
    const result=await this.repository.acceptOrdered(admission.scope,admission.eventId,admission.order,input);
    this.event({stage:result.mayAttach?'native_attached':'native_attachment_rejected',turnId:result.acceptance?.identity.turnId,channel:admission.scope.channel});
    return result;
  }
  async history(admission:NativeKnowledgeAdmission,foreground:readonly any[]):Promise<KnowledgeInput['history']>{
    const keep=(values:readonly any[])=>snapshot(values.filter(h=>['user','assistant'].includes(h.role)&&typeof h.content==='string'&&h.content.trim())
      .slice(-4).map(h=>({role:h.role as 'user'|'assistant',content:h.content.slice(0,1200)})));
    const sequence=admission.result.acceptance?.identity.sequence;
    if(!sequence || sequence<2)return keep(foreground);
    const s=admission.scope;const {data:tasks,error}=await this.options.db.from('odin_tasks').select('id,payload,knowledge_result')
      .eq('business_id',s.businessId).eq('conversation_id',s.conversationId).eq('knowledge_channel',s.channel).eq('knowledge_account',s.providerAccount)
      .eq('knowledge_sequence',sequence-1).eq('knowledge_state','FINALIZED').limit(1);
    if(error)throw new Error('knowledge_history_read_failed');const previous=tasks?.[0];
    if(!previous)return keep(foreground);
    const {data:out,error:outError}=await this.options.db.from('odin_outbox').select('artifact').eq('business_id',s.businessId).eq('conversation_id',s.conversationId)
      .eq('knowledge_task_id',previous.id).eq('knowledge_kind','final').eq('knowledge_state','SENT').limit(1);
    if(outError)throw new Error('knowledge_history_read_failed');
    const answer=previous.knowledge_result?.text;const question=previous.payload?.question;
    if(typeof answer!=='string'||typeof question!=='string'||out?.[0]?.artifact?.text!==answer)return keep(foreground);
    if(foreground.slice(-2).some(h=>h.role==='assistant'&&h.content===answer))return keep(foreground);
    return keep([...foreground,{role:'user',content:question},{role:'assistant',content:answer}]);
  }
  async tick():Promise<KnowledgeCycleReport>{
    if(this.stopped)return {ran:false,deliveries:[]};
    if(this.pending)return {ran:false,deliveries:[]};
    const pending=this.cycle.tick();this.pending=pending;
    try{this.lastReport=await pending;return this.lastReport;}catch(error){this.lastFailure=error;throw error;}finally{if(this.pending===pending)this.pending=undefined;}
  }
  start(intervalMs=1000):void{
    if(this.stopped || this.timer || !this.options.controls().processing && !this.options.controls().delivery)return;
    if(!Number.isSafeInteger(intervalMs)||intervalMs<250||intervalMs>10000)throw new Error('knowledge_invalid_poll_interval');
    const schedule=()=>{if(this.stopped)return;this.timer=setTimeout(async()=>{
      try{await this.tick();}catch{this.event({stage:'host_cycle_failed'});}finally{schedule();}
    },intervalMs);this.timer.unref();};schedule();
  }
  async stop(graceMs=5000):Promise<boolean>{
    this.stopped=true;if(this.timer)clearTimeout(this.timer);this.waiting.stop();this.cycle.stop();
    const pending=Promise.allSettled([this.pending,this.waiting.drain()]);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([pending.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),graceMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
}
