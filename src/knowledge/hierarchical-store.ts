import {canonicalDocument,canonicalHash,type CanonicalDocument} from './documents/canonical';
import {HIERARCHICAL_SEARCH_PROTOCOL,searchMetadataDigest,type SearchGenerationRepository,type SearchGeneration,type SearchLease,type ProducerIdentity} from './hierarchical-search';
import {abortable} from './persistent-search';

/** Service-role RPC transport. No local ready cache and no embedding-store writes.
 * Every native proof check reads a fresh, database-fenced generation snapshot. */
export class SupabaseSearchGenerations implements SearchGenerationRepository {
  readonly durable=true;
  constructor(private readonly client:{rpc:Function},private readonly version:string,private readonly hostSignal?:AbortSignal) {
    if(!/^[a-f0-9]{64}$/u.test(version))throw Error('hint_store_configuration');
  }
  private async rpc(name:string,args:Record<string,unknown>){
    const signal=this.hostSignal?AbortSignal.any([this.hostSignal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
    signal.throwIfAborted();
    const query=this.client.rpc(name,args);
    const {data,error}:any=await abortable(Promise.resolve(typeof query.abortSignal==='function'?query.abortSignal(signal):query),signal);
    if(error)throw Error('hint_store_unavailable');
    return data;
  }
  private scope(doc:CanonicalDocument){return{p_business_id:doc.businessId,p_source_id:doc.sourceId,p_version:this.version};}
  async readMany(businessId:number,sourceIds?:readonly string[]):Promise<readonly SearchGeneration[]>{
    const rows=await this.rpc('read_knowledge_hint_generations_v1',{p_business_id:businessId,p_version:this.version,p_expected_sources:sourceIds?[...sourceIds].sort():null});
    if(!Array.isArray(rows)||rows.length>200||JSON.stringify(rows).length>2_000_000)throw Error('hint_store_invalid');
    const ids=new Set<string>();
    for(const g of rows){
      if(!g||g.protocol!==HIERARCHICAL_SEARCH_PROTOCOL||g.businessId!==businessId||typeof g.sourceId!=='string'||ids.has(g.sourceId)||
        g.producerVersion!==this.version||typeof g.revocationEpoch!=='string'||!/^\d+$/u.test(g.revocationEpoch)||
        !g.producerIdentity||!Array.isArray(g.checks)||!g.checks.length||!Array.isArray(g.hints)||g.hints.length>3200||
        !Array.isArray(g.reviewedChunks))throw Error('hint_store_invalid');
      const {digest,...body}=g;if(searchMetadataDigest(body)!==digest)throw Error('hint_store_invalid');
      const checked=g.checks.flatMap((c:any)=>c.acceptedIds),reviewed=g.checks.flatMap((c:any)=>c.reviewedChunkIds);
      if(canonicalHash(checked)!==canonicalHash(g.hints.map((h:any)=>h.id))||canonicalHash(reviewed)!==canonicalHash(g.reviewedChunks))throw Error('hint_store_invalid');
      ids.add(g.sourceId);
    }
    return rows;
  }
  async read(businessId:number,sourceId:string){return(await this.readMany(businessId)).find(g=>g.sourceId===sourceId);}
  // Revocation is authoritative in the source trigger, never a request-side write.
  invalidate(_businessId:number,_sourceId:string){}
  async claim(doc:CanonicalDocument,version:string,identity:ProducerIdentity,requests:number):Promise<SearchLease|undefined>{
    if(version!==this.version)throw Error('hint_store_configuration');
    const snapshot=await this.rpc('knowledge_hint_source_snapshot_v1',this.scope(doc));
    if(!snapshot)return undefined;
    if(canonicalDocument(snapshot.source).fence!==doc.fence)throw Error('hint_source_changed');
    const binding={revision:doc.revision,fence:doc.fence,inventoryRoot:doc.inventoryRoot,nodes:doc.nodes,
      chunks:doc.chunks.map(c=>({id:c.id,sectionId:c.sectionId,digest:c.digest}))};
    const lease=await this.rpc('claim_knowledge_hint_generation_v1',{...this.scope(doc),p_epoch:snapshot.epoch,p_snapshot:snapshot.snapshot,
      p_binding:binding,p_identity:identity,p_requests:requests});
    if(!lease)return undefined;
    if(typeof lease.token!=='string'||typeof lease.epoch!=='string'||lease.epoch!==snapshot.epoch||
      !Number.isFinite(Date.parse(lease.deadline))||Date.parse(lease.deadline)<=Date.now())throw Error('hint_store_invalid');
    return Object.freeze(lease);
  }
  async stage(doc:CanonicalDocument,lease:SearchLease,index:number,action:'begin'|'ack'){
    if(await this.rpc('transition_knowledge_hint_generation_v1',{...this.scope(doc),p_token:lease.token,p_epoch:lease.epoch,p_action:action,p_stage:index})!==true)
      throw Error('hint_lease_lost');
  }
  async fail(doc:CanonicalDocument,lease:SearchLease,known=false){
    await this.rpc('transition_knowledge_hint_generation_v1',{...this.scope(doc),p_token:lease.token,p_epoch:lease.epoch,p_action:known?'fail-known':'fail',p_stage:0});
  }
  async publish(generation:SearchGeneration,lease?:SearchLease){
    if(!lease||generation.producerVersion!==this.version||generation.revocationEpoch!==lease.epoch)throw Error('hint_store_invalid');
    if(await this.rpc('complete_knowledge_hint_generation_v1',{p_business_id:generation.businessId,p_source_id:generation.sourceId,
      p_version:this.version,p_token:lease.token,p_epoch:lease.epoch,p_generation:generation})!==true)throw Error('hint_commit_rejected');
  }
}
