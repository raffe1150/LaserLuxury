import {SupabaseKnowledgeStorage} from '../../knowledge';
import {HierarchicalSearchIndex,hierarchicalSearchEnabled,hierarchicalProducerVersion,searchMetadataDigest,type InjectedSearchProducer,type ProducerIdentity} from './hierarchical-search';
import {SupabaseSearchGenerations} from './hierarchical-store';

export type HierarchicalIndexOptions={version:'durable-hints-v1';businessIds:readonly number[];producerVersion:string;
 identity:ProducerIdentity;targetLanguages:readonly string[];maxRequests:number;stageMs:number;producer?:InjectedSearchProducer;shutdownSignal?:AbortSignal};

/** No default model, credential access or SDK construction. A live producer must
 * be explicitly injected by a separately reviewed/authorized budget owner. */
export function hierarchicalIndexOptions(raw:string|undefined):HierarchicalIndexOptions|undefined{
 if(!raw)return undefined;
 const p=JSON.parse(raw);
 if(!p||JSON.stringify(Object.keys(p).sort())!==JSON.stringify(['version','businessIds','producerVersion','identity','targetLanguages','maxRequests','stageMs'].sort())||p.version!=='durable-hints-v1'||!Array.isArray(p.businessIds)||!p.businessIds.length||p.businessIds.length>10||
   new Set(p.businessIds).size!==p.businessIds.length||p.businessIds.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0)||
   typeof p.producerVersion!=='string'||!p.producerVersion.trim()||!p.identity||
   !['provider','model','version','verifierModel','verifierVersion'].every(k=>typeof p.identity[k]==='string'&&p.identity[k].trim())||
   !Array.isArray(p.targetLanguages)||!p.targetLanguages.length||p.targetLanguages.length>12||
   !Number.isSafeInteger(p.maxRequests)||p.maxRequests<0||p.maxRequests>1000||
   !Number.isSafeInteger(p.stageMs)||p.stageMs<1||p.stageMs>20000)throw Error('hint_runtime_configuration');
 return p;
}
export function hierarchicalIndexForClient(client:any,options?:HierarchicalIndexOptions):HierarchicalSearchIndex|undefined{
 if(!hierarchicalSearchEnabled())return undefined;
 options??=hierarchicalIndexOptions(process.env.ODINLINK_HIERARCHICAL_INDEX_PROFILE);
 if(!options)return undefined;
 // Validate programmatic options with the same strict admission as environment input.
 hierarchicalIndexOptions(JSON.stringify({...options,producer:undefined,shutdownSignal:undefined}));
 const producer:InjectedSearchProducer=options.producer??{mode:'durable-readonly',version:options.producerVersion,identity:options.identity,
   generate:async()=>{throw Error('hint_producer_not_authorized');},verify:async()=>{throw Error('hint_verifier_not_authorized');}};
 if(producer.mode==='offline-injected'||producer.version!==options.producerVersion||
   searchMetadataDigest(producer.identity)!==searchMetadataDigest(options.identity))throw Error('hint_runtime_identity');
 const storage=new SupabaseKnowledgeStorage(client);
 const repository=new SupabaseSearchGenerations(client,hierarchicalProducerVersion(producer,options.targetLanguages),options.shutdownSignal);
 const index=new HierarchicalSearchIndex(async id=>{const sources=await storage.listReadyComplete(id,200);if(!sources)throw Error('hint_inventory_incomplete');return sources;},repository,producer,{enabled:true,businessIds:options.businessIds,
   maxRequests:options.maxRequests,stageMs:options.stageMs,targetLanguages:options.targetLanguages});
 if(options.shutdownSignal){options.shutdownSignal.addEventListener('abort',()=>index.stop(),{once:true});if(options.shutdownSignal.aborted)index.stop();}
 return index;
}
