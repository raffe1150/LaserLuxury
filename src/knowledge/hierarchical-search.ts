import {canonicalDocument,canonicalHash,planCanonicalCoverage,type CanonicalDocument,type CanonicalChunk,type CoverageBatch} from './documents/canonical';
import type {KnowledgeSource,KnowledgeSearchMatch} from '../../knowledge';
import {abortable} from './persistent-search';

export const HIERARCHICAL_SEARCH_PROTOCOL='hierarchical-search-v1';
/** JSONB preserves values, not object key order. Do not change canonical source hashes. */
export function searchMetadataDigest(value:unknown):string {
 const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,sorted(v[k])])):v;
 return canonicalHash(sorted(value));
}
export function hierarchicalSearchEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  const value=env.ODINLINK_HIERARCHICAL_SEARCH;
  if(!value||value==='off')return false;
  if(value!==HIERARCHICAL_SEARCH_PROTOCOL)throw Error('hierarchical_search_configuration');
  return true;
}
export type Hint = Readonly<{id:string;level:'document'|'section'|'chunk';nodeId:string;chunkId:string;quote:string;
  language:string;phrases:readonly string[]}>;
export type ProducerIdentity = Readonly<{provider:string;model:string;version:string;verifierModel:string;verifierVersion:string}>;
export type SearchLease = Readonly<{token:string;epoch:string;deadline:string}>;
type MaybePromise<T> = T|Promise<T>;
export type SearchGeneration = Readonly<{protocol:typeof HIERARCHICAL_SEARCH_PROTOCOL;producerVersion:string;businessId:number;sourceId:string;
  fence:string;inventoryRoot:string;revocationEpoch?:string;producerIdentity?:ProducerIdentity;checks?:readonly {batchDigest:string;acceptedIds:readonly string[];reviewedChunkIds:readonly string[]}[];reviewedChunks:readonly string[];hints:readonly Hint[];digest:string}>;
export type HierarchicalSearchProof = Readonly<{protocol:typeof HIERARCHICAL_SEARCH_PROTOCOL;inventoryToken:string;generation:string;fence:string;chunkId:string}>;
export interface SearchGenerationRepository {
  readonly durable?:boolean;
  read(businessId:number,sourceId:string):MaybePromise<SearchGeneration|undefined>;
  readMany?(businessId:number,sourceIds?:readonly string[]):Promise<readonly SearchGeneration[]>;
  publish(generation:SearchGeneration,lease?:SearchLease):MaybePromise<void>;
  invalidate(businessId:number,sourceId:string):MaybePromise<void>;
  claim?(doc:CanonicalDocument,version:string,identity:ProducerIdentity,requests:number):Promise<SearchLease|undefined>;
  stage?(doc:CanonicalDocument,lease:SearchLease,index:number,action:'begin'|'ack'):Promise<void>;
  fail?(doc:CanonicalDocument,lease:SearchLease,known?:boolean):Promise<void>;
}
export class InMemorySearchGenerations implements SearchGenerationRepository {
  private rows=new Map<string,SearchGeneration>();
  read(businessId:number,sourceId:string){return this.rows.get(JSON.stringify([businessId,sourceId]));}
  publish(generation:SearchGeneration){this.rows.set(JSON.stringify([generation.businessId,generation.sourceId]),generation);}
  invalidate(businessId:number,sourceId:string){this.rows.delete(JSON.stringify([businessId,sourceId]));}
}
/** No network implementation in this slice. Enabling an off-request live producer
 * requires a durable repository and separately authorized financial contract. */
export interface InjectedSearchProducer {
  mode:'offline-injected'|'durable-injected'|'durable-readonly';version:string;identity?:ProducerIdentity;
  generate(input:Readonly<{sourceId:string;inventoryRoot:string;targetLanguages:readonly string[];nodes:CanonicalDocument['nodes'];chunks:readonly CanonicalChunk[]}>,signal?:AbortSignal):Promise<unknown>;
  verify(input:Readonly<{chunks:readonly CanonicalChunk[];hints:readonly Hint[]}>,signal?:AbortSignal):Promise<unknown>;
}
const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase().replace(/[\u200c\p{P}\p{S}]/gu,' ').replace(/\s+/gu,' ').trim();
const exactKeys=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&
  JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
function need(value:unknown):asserts value {if(!value)throw Error('hierarchical_search_invalid');}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function parseHints(raw:any,doc:CanonicalDocument,batch:CoverageBatch,languages:readonly string[]):Hint[]{
  need(exactKeys(raw,['hints'])&&Array.isArray(raw.hints)&&raw.hints.length<=80);
  return raw.hints.map((h:any,index:number)=>{
    need(exactKeys(h,['level','nodeId','chunkId','quote','language','phrases']));
    const chunk=doc.chunks.find(c=>c.id===h.chunkId&&batch.chunkIds.includes(c.id));need(chunk);
    need(['document','section','chunk'].includes(h.level)&&languages.includes(h.language));
    need(h.nodeId===(h.level==='document'?doc.sourceId:h.level==='section'?chunk.sectionId:chunk.id));
    need(typeof h.quote==='string'&&h.quote.length>0&&h.quote.length<=2400&&chunk.text.indexOf(h.quote)>=0&&
      chunk.text.indexOf(h.quote,chunk.text.indexOf(h.quote)+1)<0);
    need(Array.isArray(h.phrases)&&h.phrases.length>0&&h.phrases.length<=4&&h.phrases.every((p:any)=>
      typeof p==='string'&&p.length<=120&&normalize(p).split(' ').length>=2));
    const normalized={level:h.level,nodeId:h.nodeId,chunkId:h.chunkId,quote:h.quote,language:h.language,phrases:[...h.phrases]};
    return freeze({...normalized,id:canonicalHash([doc.inventoryRoot,batch.ordinal,index,normalized])});
  });
}
const generationBody=({digest,...body}:SearchGeneration)=>body;
function currentGeneration(doc:CanonicalDocument,g:SearchGeneration|undefined,version:string,languages:readonly string[],identity?:ProducerIdentity):g is SearchGeneration {
  if(!g)return false;
  try {
    const batches=planCanonicalCoverage(doc).batches;
    const byBatch=batches.map(batch=>parseHints({hints:g.hints.filter(h=>batch.chunkIds.includes(h.chunkId)).map(({id,...hint})=>hint)},doc,batch,languages));
    const rebuilt=byBatch.flat();
    if(identity&&(searchMetadataDigest(g.producerIdentity)!==searchMetadataDigest(identity)||!g.revocationEpoch||!Array.isArray(g.checks)||
      searchMetadataDigest(g.checks)!==searchMetadataDigest(batches.map((batch,i)=>({batchDigest:batch.digest,acceptedIds:byBatch[i].map(h=>h.id),reviewedChunkIds:batch.chunkIds})))))return false;
    if(searchMetadataDigest(rebuilt)!==searchMetadataDigest(g.hints))return false;
  }catch{return false;}
  return !!g&&g.protocol===HIERARCHICAL_SEARCH_PROTOCOL&&g.producerVersion===version&&g.businessId===doc.businessId&&g.sourceId===doc.sourceId&&
    g.fence===doc.fence&&g.inventoryRoot===doc.inventoryRoot&&searchMetadataDigest(generationBody(g))===g.digest&&
    g.reviewedChunks.length===doc.chunks.length&&new Set(g.reviewedChunks).size===doc.chunks.length&&doc.chunks.every(c=>g.reviewedChunks.includes(c.id));
}
/** Uses DocumentService's existing recoverIndex/stop worker slot. One source per
 * recovery tick, bounded stages per batch, zero retries and no partial readiness. */
export class HierarchicalSearchIndex {
  private stopped=false;private busy=false;private consumed=new Set<string>();private requests=0;
  private readonly shutdown=new AbortController();
  private readonly pending=new Set<Promise<unknown>>();
  constructor(private readonly sources:(businessId:number)=>Promise<KnowledgeSource[]>,private readonly repository:SearchGenerationRepository,
    private readonly producer:InjectedSearchProducer,private readonly policy:{enabled:boolean;businessIds:readonly number[];maxRequests:number;stageMs?:number;targetLanguages?:readonly string[]}){
    need(producer.version.trim()&&policy.businessIds.length&&policy.businessIds.every(id=>Number.isSafeInteger(id)&&id>0)&&
      Number.isSafeInteger(policy.maxRequests)&&policy.maxRequests>=0&&policy.maxRequests<=1000&&
      (policy.stageMs===undefined||Number.isSafeInteger(policy.stageMs)&&policy.stageMs>0&&policy.stageMs<=20_000));
    if(policy.enabled&&producer.mode==='offline-injected')need(process.env.NODE_ENV==='test');
    if(policy.enabled&&producer.mode!=='offline-injected')need(repository.durable&&repository.claim&&repository.stage&&repository.fail&&
      producer.identity&&['provider','model','version','verifierModel','verifierVersion'].every(k=>typeof (producer.identity as any)[k]==='string'&&!!(producer.identity as any)[k].trim()));
    if(repository.durable)need(producer.identity);
    this.policy=freeze({...policy,businessIds:[...policy.businessIds],...(policy.targetLanguages?{targetLanguages:[...policy.targetLanguages]}:{})});
    need(this.languages().length>0&&this.languages().length<=12&&new Set(this.languages()).size===this.languages().length&&this.languages().every(l=>/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/u.test(l)));
  }
  private languages(){return this.policy.targetLanguages??['fa','es'];}
  private version(){return hierarchicalProducerVersion(this.producer,this.languages());}
  private async generations(documents:readonly CanonicalDocument[]){
    const result=new Map<string,SearchGeneration|undefined>();
    if(!documents.length)return result;
    if(this.repository.readMany){for(const row of await this.repository.readMany(documents[0].businessId,documents.map(doc=>doc.sourceId)))result.set(row.sourceId,row);}
    else await Promise.all(documents.map(async doc=>result.set(doc.sourceId,await this.repository.read(doc.businessId,doc.sourceId))));
    return result;
  }
  stop(){this.stopped=true;this.shutdown.abort();}
  usage(){return{requests:this.requests};}
  private observe<T>(promise:Promise<T>):Promise<T>{
    this.pending.add(promise);void promise.then(()=>{},()=>{}).finally(()=>this.pending.delete(promise));return promise;
  }
  async recover():Promise<readonly {sourceId:string;status:'ready'|'failed'}[]>{
    if(!this.policy.enabled||this.producer.mode==='durable-readonly'||this.producer.mode==='offline-injected'&&process.env.NODE_ENV!=='test'||!hierarchicalSearchEnabled()||this.stopped||this.busy||this.pending.size)return[];
    this.busy=true;
    try{
      for(const businessId of this.policy.businessIds)for(const source of await this.sources(businessId)){
        if(source.businessId!==businessId||source.type!=='document'||source.status!=='ready')continue;
        let doc:CanonicalDocument;try{doc=canonicalDocument(source);}catch{continue;}
        const jobVersion=this.version(),jobIdentity=this.producer.identity?{...this.producer.identity}:undefined;
        const key=canonicalHash([businessId,source.id,doc.fence,jobVersion]);
        if(currentGeneration(doc,await this.repository.read(businessId,source.id),this.version(),this.languages(),this.producer.identity)||this.consumed.has(key))continue;
        const plan=planCanonicalCoverage(doc);
        if(this.requests+plan.batches.length*2>this.policy.maxRequests)return[];
        let lease:SearchLease|undefined;
        if(this.repository.claim){lease=await this.repository.claim(doc,jobVersion,jobIdentity!,plan.batches.length*2);if(!lease)continue;}
        this.consumed.add(key);const hints:Hint[]=[];const reviewedChunks:string[]=[];const checks:NonNullable<SearchGeneration['checks']>[number][]=[];let responseReceived=false;
        try{
          for(const batch of plan.batches){
            need(this.version()===jobVersion&&!this.stopped&&hierarchicalSearchEnabled()&&(this.producer.mode!=='offline-injected'||process.env.NODE_ENV==='test'));
            if(lease)need(Date.now()<Date.parse(lease.deadline));const chunks=doc.chunks.filter(c=>batch.chunkIds.includes(c.id));
            const beforeBatch=(await this.sources(businessId)).find(s=>s.id===source.id&&s.businessId===businessId);
            need(beforeBatch&&canonicalDocument(beforeBatch).fence===doc.fence);
            const generateSignal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(this.policy.stageMs??20_000)]);
            responseReceived=false;if(lease)await this.repository.stage!(doc,lease,batch.ordinal*2,'begin');
            this.requests++;const raw=await abortable(this.observe(Promise.resolve().then(()=>{generateSignal.throwIfAborted();need(!this.stopped&&hierarchicalSearchEnabled()&&this.version()===jobVersion);return this.producer.generate(freeze({sourceId:doc.sourceId,inventoryRoot:doc.inventoryRoot,targetLanguages:this.languages(),nodes:doc.nodes.filter(n=>chunks.some(c=>c.sectionId===n.id)),chunks}),generateSignal);})),generateSignal);
            responseReceived=true;const parsed=parseHints(raw,doc,batch,this.languages());
            if(lease)await this.repository.stage!(doc,lease,batch.ordinal*2,'ack');
            const beforeReview=(await this.sources(businessId)).find(s=>s.id===source.id&&s.businessId===businessId);
            need(this.version()===jobVersion&&!this.stopped&&hierarchicalSearchEnabled()&&beforeReview&&canonicalDocument(beforeReview).fence===doc.fence);
            const reviewSignal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(this.policy.stageMs??20_000)]);
            responseReceived=false;if(lease)await this.repository.stage!(doc,lease,batch.ordinal*2+1,'begin');
            this.requests++;const result:any=await abortable(this.observe(Promise.resolve().then(()=>{reviewSignal.throwIfAborted();need(!this.stopped&&hierarchicalSearchEnabled()&&this.version()===jobVersion);return this.producer.verify(freeze({chunks,hints:parsed}),reviewSignal);})),reviewSignal);
            responseReceived=true;need(exactKeys(result,['acceptedIds','reviewedChunkIds'])&&Array.isArray(result.acceptedIds)&&Array.isArray(result.reviewedChunkIds)&&
              JSON.stringify([...result.acceptedIds].sort())===JSON.stringify(parsed.map(h=>h.id).sort())&&
              JSON.stringify([...result.reviewedChunkIds].sort())===JSON.stringify([...batch.chunkIds].sort()));
            if(lease)await this.repository.stage!(doc,lease,batch.ordinal*2+1,'ack');
            checks.push({batchDigest:batch.digest,acceptedIds:parsed.map(h=>h.id),reviewedChunkIds:[...batch.chunkIds]});
            hints.push(...parsed);reviewedChunks.push(...batch.chunkIds);
          }
          const current=(await this.sources(businessId)).find(s=>s.id===source.id&&s.businessId===businessId);
          need(!this.stopped&&hierarchicalSearchEnabled()&&current&&canonicalDocument(current).fence===doc.fence);
          const body:Omit<SearchGeneration,'digest'>={protocol:HIERARCHICAL_SEARCH_PROTOCOL,producerVersion:jobVersion,businessId,sourceId:source.id,
            fence:doc.fence,inventoryRoot:doc.inventoryRoot,reviewedChunks,hints,...(lease?{revocationEpoch:lease.epoch,producerIdentity:jobIdentity,checks}: {})};
          await this.repository.publish(freeze({...body,digest:searchMetadataDigest(body)}),lease);return[{sourceId:source.id,status:'ready'}];
        }catch{if(lease)await this.repository.fail!(doc,lease,responseReceived).catch(()=>{});return[{sourceId:source.id,status:'failed'}];}
      }
      return[];
    }finally{this.busy=false;}
  }
  async discover(businessId:number,question:string):Promise<KnowledgeSearchMatch[]>{
    if(!this.policy.enabled||!hierarchicalSearchEnabled()||!this.policy.businessIds.includes(businessId)||this.stopped)return[];
    const documents:CanonicalDocument[]=[];
    for(const source of await this.sources(businessId))if(source.businessId===businessId&&source.type==='document'){
      if(source.status!=='ready'){await this.repository.invalidate(businessId,source.id);continue;}
      try{documents.push(canonicalDocument(source));}catch{return[];}
    }
    // An incomplete index cannot silently hide a competing current document.
    const generations=await this.generations(documents);
    if(documents.some(doc=>!currentGeneration(doc,generations.get(doc.sourceId),this.version(),this.languages(),this.producer.identity)))return[];
    const inventoryToken=this.inventoryToken(documents,generations);
    const query=' '+normalize(question)+' ',matches:KnowledgeSearchMatch[]=[];
    for(const doc of documents){
      const generation=generations.get(doc.sourceId)!;
      const selected=new Set(generation.hints.filter(h=>h.phrases.some(p=>query.includes(' '+normalize(p)+' '))).map(h=>h.chunkId));
      for(const chunk of doc.chunks)if(selected.has(chunk.id))matches.push({...chunk.match,score:1,hierarchicalProof:{protocol:HIERARCHICAL_SEARCH_PROTOCOL,inventoryToken,
        generation:generation.digest,fence:doc.fence,chunkId:chunk.id}});
    }
    const seen=new Set<string>(),heads:KnowledgeSearchMatch[]=[],tails:KnowledgeSearchMatch[]=[];
    for(const match of matches){if(seen.has(match.sourceId))tails.push(match);else{seen.add(match.sourceId);heads.push(match);}}
    return seen.size>5?[]:[...heads,...tails];
  }
  private inventoryToken(documents:readonly CanonicalDocument[],generations:ReadonlyMap<string,SearchGeneration|undefined>):string{
    return canonicalHash(documents.map(doc=>[doc.sourceId,doc.fence,generations.get(doc.sourceId)?.digest]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  }
  async validProofs(businessId:number,matches:readonly KnowledgeSearchMatch[],sources:readonly KnowledgeSource[]):Promise<ReadonlySet<KnowledgeSearchMatch>>{
    const valid=new Set<KnowledgeSearchMatch>();
    if(!this.policy.enabled||!hierarchicalSearchEnabled()||!this.policy.businessIds.includes(businessId)||this.stopped)return valid;
    try{
      const documents=sources.filter(s=>s.businessId===businessId&&s.type==='document'&&s.status==='ready').map(s=>canonicalDocument(s));
      for(const source of sources)if(source.businessId===businessId&&source.type==='document'&&source.status!=='ready')await this.repository.invalidate(businessId,source.id);
      const generations=await this.generations(documents);
      if(documents.some(doc=>!currentGeneration(doc,generations.get(doc.sourceId),this.version(),this.languages(),this.producer.identity)))return valid;
      const token=this.inventoryToken(documents,generations);
      for(const match of matches){
        const doc=documents.find(d=>d.sourceId===match.sourceId),p=match.hierarchicalProof;
        if(!doc||!p)continue;const g=generations.get(doc.sourceId)!;
        if(match.businessId===businessId&&p.protocol===HIERARCHICAL_SEARCH_PROTOCOL&&p.inventoryToken===token&&p.generation===g.digest&&p.fence===doc.fence&&
          doc.chunks.some(c=>c.id===p.chunkId&&c.match.text===match.text&&['page','sheet','section'].every(k=>c.match.metadata?.[k]===match.metadata?.[k])))valid.add(match);
      }
    }catch{/* Incomplete, foreign or changed inventories never authorize context. */}
    return valid;
  }
}

export function hierarchicalProducerVersion(producer:Pick<InjectedSearchProducer,'version'|'identity'>,languages:readonly string[]=['fa','es']):string {
 return searchMetadataDigest([HIERARCHICAL_SEARCH_PROTOCOL,producer.version,languages,...(producer.identity?[producer.identity]:[])]);
}
