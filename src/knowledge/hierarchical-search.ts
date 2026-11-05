import {canonicalDocument,canonicalHash,planCanonicalCoverage,type CanonicalDocument,type CanonicalChunk,type CoverageBatch} from './documents/canonical';
import type {KnowledgeSource,KnowledgeSearchMatch} from '../../knowledge';
import {abortable} from './persistent-search';

export const HIERARCHICAL_SEARCH_PROTOCOL='hierarchical-search-v1';
export function hierarchicalSearchEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  const value=env.ODINLINK_HIERARCHICAL_SEARCH;
  if(!value||value==='off')return false;
  if(value!==HIERARCHICAL_SEARCH_PROTOCOL)throw Error('hierarchical_search_configuration');
  return true;
}
type Hint = Readonly<{id:string;level:'document'|'section'|'chunk';nodeId:string;chunkId:string;quote:string;
  language:string;phrases:readonly string[]}>;
export type SearchGeneration = Readonly<{protocol:typeof HIERARCHICAL_SEARCH_PROTOCOL;producerVersion:string;businessId:number;sourceId:string;
  fence:string;inventoryRoot:string;reviewedChunks:readonly string[];hints:readonly Hint[];digest:string}>;
export type HierarchicalSearchProof = Readonly<{protocol:typeof HIERARCHICAL_SEARCH_PROTOCOL;inventoryToken:string;generation:string;fence:string;chunkId:string}>;
export interface SearchGenerationRepository {
  read(businessId:number,sourceId:string):SearchGeneration|undefined;
  publish(generation:SearchGeneration):void;
  invalidate(businessId:number,sourceId:string):void;
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
  mode:'offline-injected';version:string;
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
    return freeze({...h,id:canonicalHash([doc.inventoryRoot,batch.ordinal,index,h])});
  });
}
const generationBody=({digest,...body}:SearchGeneration)=>body;
function currentGeneration(doc:CanonicalDocument,g:SearchGeneration|undefined,version:string):g is SearchGeneration {
  return !!g&&g.protocol===HIERARCHICAL_SEARCH_PROTOCOL&&g.producerVersion===version&&g.businessId===doc.businessId&&g.sourceId===doc.sourceId&&
    g.fence===doc.fence&&g.inventoryRoot===doc.inventoryRoot&&canonicalHash(generationBody(g))===g.digest&&
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
    if(policy.enabled)need(process.env.NODE_ENV==='test'&&producer.mode==='offline-injected');
    this.policy=freeze({...policy,businessIds:[...policy.businessIds],...(policy.targetLanguages?{targetLanguages:[...policy.targetLanguages]}:{})});
    need(this.languages().length>0&&this.languages().length<=12&&new Set(this.languages()).size===this.languages().length&&this.languages().every(l=>/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/u.test(l)));
  }
  private languages(){return this.policy.targetLanguages??['fa','es'];}
  private version(){return canonicalHash([HIERARCHICAL_SEARCH_PROTOCOL,this.producer.version,this.languages()]);}
  stop(){this.stopped=true;this.shutdown.abort();}
  usage(){return{requests:this.requests};}
  private observe<T>(promise:Promise<T>):Promise<T>{
    this.pending.add(promise);void promise.then(()=>{},()=>{}).finally(()=>this.pending.delete(promise));return promise;
  }
  async recover():Promise<readonly {sourceId:string;status:'ready'|'failed'}[]>{
    if(!this.policy.enabled||process.env.NODE_ENV!=='test'||!hierarchicalSearchEnabled()||this.stopped||this.busy||this.pending.size)return[];
    this.busy=true;
    try{
      for(const businessId of this.policy.businessIds)for(const source of await this.sources(businessId)){
        if(source.businessId!==businessId||source.type!=='document'||source.status!=='ready')continue;
        let doc:CanonicalDocument;try{doc=canonicalDocument(source);}catch{continue;}
        const key=canonicalHash([businessId,source.id,doc.fence,this.version()]);
        if(currentGeneration(doc,this.repository.read(businessId,source.id),this.version())||this.consumed.has(key))continue;
        const plan=planCanonicalCoverage(doc);
        if(this.requests+plan.batches.length*2>this.policy.maxRequests)return[];
        this.consumed.add(key);const hints:Hint[]=[];const reviewedChunks:string[]=[];
        try{
          for(const batch of plan.batches){
            need(!this.stopped&&hierarchicalSearchEnabled()&&process.env.NODE_ENV==='test');const chunks=doc.chunks.filter(c=>batch.chunkIds.includes(c.id));
            const beforeBatch=(await this.sources(businessId)).find(s=>s.id===source.id&&s.businessId===businessId);
            need(beforeBatch&&canonicalDocument(beforeBatch).fence===doc.fence);
            const generateSignal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(this.policy.stageMs??20_000)]);
            this.requests++;const raw=await abortable(this.observe(Promise.resolve().then(()=>this.producer.generate(freeze({sourceId:doc.sourceId,inventoryRoot:doc.inventoryRoot,targetLanguages:this.languages(),nodes:doc.nodes.filter(n=>chunks.some(c=>c.sectionId===n.id)),chunks}),generateSignal))),generateSignal);
            const parsed=parseHints(raw,doc,batch,this.languages());
            const beforeReview=(await this.sources(businessId)).find(s=>s.id===source.id&&s.businessId===businessId);
            need(!this.stopped&&hierarchicalSearchEnabled()&&beforeReview&&canonicalDocument(beforeReview).fence===doc.fence);
            const reviewSignal=AbortSignal.any([this.shutdown.signal,AbortSignal.timeout(this.policy.stageMs??20_000)]);
            this.requests++;const result:any=await abortable(this.observe(Promise.resolve().then(()=>this.producer.verify(freeze({chunks,hints:parsed}),reviewSignal))),reviewSignal);
            need(exactKeys(result,['acceptedIds','reviewedChunkIds'])&&Array.isArray(result.acceptedIds)&&Array.isArray(result.reviewedChunkIds)&&
              JSON.stringify([...result.acceptedIds].sort())===JSON.stringify(parsed.map(h=>h.id).sort())&&
              JSON.stringify([...result.reviewedChunkIds].sort())===JSON.stringify([...batch.chunkIds].sort()));
            hints.push(...parsed);reviewedChunks.push(...batch.chunkIds);
          }
          const current=(await this.sources(businessId)).find(s=>s.id===source.id&&s.businessId===businessId);
          need(!this.stopped&&hierarchicalSearchEnabled()&&current&&canonicalDocument(current).fence===doc.fence);
          const body:Omit<SearchGeneration,'digest'>={protocol:HIERARCHICAL_SEARCH_PROTOCOL,producerVersion:this.version(),businessId,sourceId:source.id,
            fence:doc.fence,inventoryRoot:doc.inventoryRoot,reviewedChunks,hints};
          this.repository.publish(freeze({...body,digest:canonicalHash(body)}));return[{sourceId:source.id,status:'ready'}];
        }catch{return[{sourceId:source.id,status:'failed'}];}
      }
      return[];
    }finally{this.busy=false;}
  }
  async discover(businessId:number,question:string):Promise<KnowledgeSearchMatch[]>{
    if(!this.policy.enabled||!hierarchicalSearchEnabled()||!this.policy.businessIds.includes(businessId)||this.stopped)return[];
    const documents:CanonicalDocument[]=[];
    for(const source of await this.sources(businessId))if(source.businessId===businessId&&source.type==='document'){
      if(source.status!=='ready'){this.repository.invalidate(businessId,source.id);continue;}
      try{documents.push(canonicalDocument(source));}catch{return[];}
    }
    // An incomplete index cannot silently hide a competing current document.
    if(documents.some(doc=>!currentGeneration(doc,this.repository.read(businessId,doc.sourceId),this.version())))return[];
    const inventoryToken=this.inventoryToken(documents);
    const query=' '+normalize(question)+' ',matches:KnowledgeSearchMatch[]=[];
    for(const doc of documents){
      const generation=this.repository.read(businessId,doc.sourceId)!;
      const selected=new Set(generation.hints.filter(h=>h.phrases.some(p=>query.includes(' '+normalize(p)+' '))).map(h=>h.chunkId));
      for(const chunk of doc.chunks)if(selected.has(chunk.id))matches.push({...chunk.match,score:1,hierarchicalProof:{protocol:HIERARCHICAL_SEARCH_PROTOCOL,inventoryToken,
        generation:generation.digest,fence:doc.fence,chunkId:chunk.id}});
    }
    const seen=new Set<string>(),heads:KnowledgeSearchMatch[]=[],tails:KnowledgeSearchMatch[]=[];
    for(const match of matches){if(seen.has(match.sourceId))tails.push(match);else{seen.add(match.sourceId);heads.push(match);}}
    return seen.size>5?[]:[...heads,...tails];
  }
  private inventoryToken(documents:readonly CanonicalDocument[]):string{
    return canonicalHash(documents.map(doc=>[doc.sourceId,doc.fence,this.repository.read(doc.businessId,doc.sourceId)?.digest]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  }
  validProofs(businessId:number,matches:readonly KnowledgeSearchMatch[],sources:readonly KnowledgeSource[]):ReadonlySet<KnowledgeSearchMatch>{
    const valid=new Set<KnowledgeSearchMatch>();
    if(!this.policy.enabled||!hierarchicalSearchEnabled()||!this.policy.businessIds.includes(businessId)||this.stopped)return valid;
    try{
      const documents=sources.filter(s=>s.businessId===businessId&&s.type==='document'&&s.status==='ready').map(s=>canonicalDocument(s));
      for(const source of sources)if(source.businessId===businessId&&source.type==='document'&&source.status!=='ready')this.repository.invalidate(businessId,source.id);
      if(documents.some(doc=>!currentGeneration(doc,this.repository.read(businessId,doc.sourceId),this.version())))return valid;
      const token=this.inventoryToken(documents);
      for(const match of matches){
        const doc=documents.find(d=>d.sourceId===match.sourceId),p=match.hierarchicalProof;
        if(!doc||!p)continue;const g=this.repository.read(businessId,doc.sourceId)!;
        if(match.businessId===businessId&&p.protocol===HIERARCHICAL_SEARCH_PROTOCOL&&p.inventoryToken===token&&p.generation===g.digest&&p.fence===doc.fence&&
          doc.chunks.some(c=>c.id===p.chunkId&&c.match.text===match.text&&['page','sheet','section'].every(k=>c.match.metadata?.[k]===match.metadata?.[k])))valid.add(match);
      }
    }catch{/* Incomplete, foreign or changed inventories never authorize context. */}
    return valid;
  }
}
