import { boundedInteger, requireId, snapshot, type DeliveryOutcome, type KnowledgeScope, type TaskToken } from './knowledge-lifecycle';
import { NativeKnowledgeBindings, databaseNativeConnections, type NativeConnectionResolver } from './native-knowledge-binding';
import { nativeProviderEligible } from './native-knowledge-transport';
import { knowledgeTurnCurrent } from './knowledge-authority';
import { SupabaseOrderedKnowledgeRepository } from './supabase-ordered-knowledge-repository';
import type { KnowledgeDatabase } from './supabase-knowledge-lifecycle-repository';

type ProgressClaim = Readonly<{ taskId:string; deliveryId:string; owner:string; taskFence:number; deliveryFence:number;
  until:number; text:string; checkpoint:string }>;
/** Progress only: no model, Booking executor, final authority or transport send.
 * Runtime opts in independently. Missing enabled callback disables this boundary.
 * Never expose this service-side adapter/its receipt through inbound payloads.
 */
export class NativeKnowledgeProgressAuthority {
  private readonly bindings:NativeKnowledgeBindings;
  private readonly repository:SupabaseOrderedKnowledgeRepository;
  constructor(private readonly options:{db:KnowledgeDatabase;secret:string;enabled?:()=>boolean;
    connections?:NativeConnectionResolver;fetcher?:typeof fetch}) {
    this.bindings=new NativeKnowledgeBindings(options.db,options.secret,options.connections||databaseNativeConnections(options.db));
    // Separate reader/settlement adapter: it cannot grant factual authority.
    this.repository=new SupabaseOrderedKnowledgeRepository(options.db,s=>this.bindings.canonicalKey(s),async()=>false);
  }
  private enabled(){return this.options.enabled?.()===true;}
  private async receipt(scope:KnowledgeScope,token:TaskToken,signal:AbortSignal){
    const owned=(t:Awaited<ReturnType<SupabaseOrderedKnowledgeRepository['get']>>)=>Boolean(t && t.state==='RUNNING' && !t.result &&
      t.checkpoint && t.lease && t.lease.owner===token.owner && t.fence===token.fence && t.lease.fence===token.fence &&
      t.lease.until>Date.now() && t.expiresAt>Date.now());
    if(!this.enabled()||signal.aborted)return null;
    const before=await this.repository.get(scope,token.taskId);if(!owned(before))return null;
    const binding=await this.bindings.resolve(scope);if(!binding)return null;
    const provider={canonicalConversationKey:()=>this.bindings.canonicalKey(scope),eligible:async()=>false};
    if(!await knowledgeTurnCurrent(this.options.db,before!,provider) ||
      !await nativeProviderEligible(this.bindings,before!,this.options.fetcher||fetch,signal,binding.connection))return null;
    const after=await this.repository.get(scope,token.taskId);const current=await this.bindings.resolve(scope);
    if(!owned(after)||!current||current.binding.mac!==binding.binding.mac||current.connection.id!==binding.connection.id||
      current.connection.credential.accessToken!==binding.connection.credential.accessToken||after!.checkpoint!==before!.checkpoint||
      !await knowledgeTurnCurrent(this.options.db,after!,provider)||signal.aborted||!this.enabled())return null;
    return {purpose:'knowledge-progress-v1',businessId:scope.businessId,conversationId:scope.conversationId,channel:scope.channel,
      account:scope.providerAccount,key:current.key,taskId:after!.id,turnId:after!.turnId,sequence:after!.sequence,
      owner:token.owner,fence:token.fence,checkpoint:after!.checkpoint!,bindingMac:current.binding.mac,checkedAt:new Date().toISOString()};
  }
  async claim(scope:KnowledgeScope,token:TaskToken,text:string,signal:AbortSignal,leaseMs=3000):Promise<ProgressClaim|null>{
    if(!this.enabled()||signal.aborted)return null;
    scope=snapshot(scope);token=snapshot(token);requireId(token.owner);boundedInteger(token.fence,1,Number.MAX_SAFE_INTEGER);boundedInteger(leaseMs,1,5000);
    if(typeof text!=='string'||!text.trim()||text.length>240)throw new Error('knowledge_progress_bounds');
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(1000)]);
    const authority=await this.receipt(scope,token,bounded);if(!authority)return null;
    const {data,error}=await this.options.db.rpc('odin_claim_knowledge_progress_v1',{p_business:scope.businessId,p_conversation:scope.conversationId,
      p_task:token.taskId,p_channel:scope.channel,p_account:scope.providerAccount,p_key:authority.key,p_owner:token.owner,
      p_task_fence:token.fence,p_text:text,p_receipt:authority,p_lease_ms:leaseMs});
    if(error)throw new Error('knowledge_progress_claim_failed');
    if(!data)return null;
    if(data.knowledge_kind!=='progress'||data.knowledge_state!=='SENDING'||data.business_id!==scope.businessId||data.conversation_id!==scope.conversationId||
      data.channel!==scope.channel||data.knowledge_task_id!==token.taskId||data.knowledge_owner!==token.owner||
      data.artifact?.progress_execution_v1?.fence!==token.fence||data.artifact?.progress_execution_v1?.owner!==token.owner||
      data.artifact?.progress_execution_v1?.checkpoint!==authority.checkpoint||data.artifact?.text!==text)throw new Error('knowledge_progress_scope_mismatch');
    const until=Date.parse(data.knowledge_lease_until);if(!Number.isFinite(until))throw new Error('knowledge_progress_lease_invalid');
    return snapshot({taskId:token.taskId,deliveryId:data.id,owner:token.owner,taskFence:token.fence,
      deliveryFence:Number(data.knowledge_fence),until,text:data.artifact.text,checkpoint:authority.checkpoint});
  }
  async existingText(scope:KnowledgeScope,taskId:string):Promise<string|null>{
    if(!this.enabled())return null;
    const {data,error}=await this.options.db.from('odin_outbox').select('artifact').eq('business_id',scope.businessId)
      .eq('conversation_id',scope.conversationId).eq('channel',scope.channel).eq('knowledge_task_id',taskId).eq('knowledge_kind','progress').maybeSingle();
    if(error)throw new Error('knowledge_progress_read_failed');
    return typeof data?.artifact?.text==='string'?data.artifact.text:null;
  }
  /** Fresh check immediately before guarded progress transport. Not a remote send
   * guarantee: a request already transmitted cannot be recalled on finalization.
   */
  async dispatchTarget(scope:KnowledgeScope,claim:ProgressClaim,signal:AbortSignal){
    if(!this.enabled()||signal.aborted||claim.until<=Date.now())return null;
    scope=snapshot(scope);claim=snapshot(claim);
    const before=await this.bindings.resolve(scope);if(!before)return null;
    const receipt=await this.receipt(scope,{taskId:claim.taskId,owner:claim.owner,fence:claim.taskFence},AbortSignal.any([signal,AbortSignal.timeout(1000)]));
    if(!receipt||receipt.checkpoint!==claim.checkpoint)return null;
    const {data,error}=await this.options.db.from('odin_outbox').select('knowledge_state,knowledge_owner,knowledge_fence,knowledge_lease_until,artifact')
      .eq('business_id',scope.businessId).eq('conversation_id',scope.conversationId).eq('channel',scope.channel)
      .eq('knowledge_task_id',claim.taskId).eq('knowledge_kind','progress').eq('id',claim.deliveryId).maybeSingle();
    if(error)throw new Error('knowledge_progress_read_failed');
    if(!data||data.knowledge_state!=='SENDING'||data.knowledge_owner!==claim.owner||Number(data.knowledge_fence)!==claim.deliveryFence||
      Date.parse(data.knowledge_lease_until)<=Date.now()||data.artifact?.text!==claim.text||signal.aborted||!this.enabled())return null;
    const binding=await this.bindings.resolve(scope);
    const task=await this.repository.get(scope,claim.taskId);
    return binding&&binding.binding.mac===receipt.bindingMac && binding.connection.id===before.connection.id &&
      binding.connection.credential.accessToken===before.connection.credential.accessToken && task?.state==='RUNNING' && !task.result &&
      task.fence===claim.taskFence && task.lease?.owner===claim.owner && task.lease.until>Date.now() && task.expiresAt>Date.now() &&
      task.checkpoint===claim.checkpoint && claim.until>Date.now() && !signal.aborted && this.enabled() ?
      snapshot({channel:scope.channel,providerAccount:scope.providerAccount,recipient:binding.binding.recipient,connection:binding.connection}):null;
  }
  /** Settle only this progress identity. No factual authority/claim, no retry.
   * Existing RPC preserves genuine in-flight outcomes after finalization.
   */
  async settle(scope:KnowledgeScope,claim:ProgressClaim,outcome:DeliveryOutcome):Promise<boolean>{
    const {data,error}=await this.options.db.from('odin_outbox').select('knowledge_task_id,knowledge_kind')
      .eq('business_id',scope.businessId).eq('conversation_id',scope.conversationId).eq('channel',scope.channel).eq('id',claim.deliveryId).maybeSingle();
    if(error)throw new Error('knowledge_progress_read_failed');
    if(data?.knowledge_task_id!==claim.taskId||data?.knowledge_kind!=='progress')return false;
    return this.repository.settleDelivery(scope,{deliveryId:claim.deliveryId,owner:claim.owner,fence:claim.deliveryFence},outcome);
  }
}
