import type {AnswerUnit,Evidence} from './business-information-answer-plan';

export const CANONICAL_CONFIG_PRODUCER = 'canonical-config-v1' as const;
export const CANONICAL_CONFIG_SCHEMA = 'odinlink_knowledge_extraction_literal_config_v1';
export const SOURCE_PARTITIONED_PRODUCER = 'source-partitioned-v1' as const;
export const SOURCE_PARTITIONED_SCHEMA = 'odinlink_knowledge_documentary_partition_v1';
type ProducerProtocol = typeof CANONICAL_CONFIG_PRODUCER | typeof SOURCE_PARTITIONED_PRODUCER;
type Proposal = Omit<AnswerUnit,'id'|'verification'>;
type WireProposal = Omit<Proposal,'evidenceRefs'> & {evidenceRefs: readonly Readonly<{evidenceId:string}>[]};
export type CanonicalConfigurationProducer = Readonly<{protocol:ProducerProtocol;
  units:readonly WireProposal[];documentEvidenceIds:readonly string[];inventory:string}>;
const owners=new WeakSet<object>();
const stable=(v:any):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const inventory=(e:readonly Evidence[])=>stable([...e].sort((a,b)=>a.id.localeCompare(b.id)));
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:any,expected:readonly string[])=>object(v)&&stable(Object.keys(v).sort())===stable([...expected].sort());
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
// Host-owned semantic slots are (subject, predicate), independent of state,
// negation, scope or rendering language. Comparison never rewrites model output.
const identity=(v:unknown):string=>typeof v==='string'?v.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase():'';
const reserves=(p:WireProposal,u:any):boolean=>
  identity(p.subject)===identity(u.subject)&&identity(p.predicate)===identity(u.predicate)||
  identity(p.text)===identity(u.text);

/** Backend-only producer opt-in, captured once. Never model-selected. */
export function canonicalConfigurationProducerEnabled():boolean {
  return selectCanonicalConfigurationProducer()!=='off';
}
export function selectCanonicalConfigurationProducer():ProducerProtocol|'off' {
  const value=process.env.ODINLINK_KNOWLEDGE_CONFIG_PROPOSITIONS??'off';
  if(value!=='off'&&value!==CANONICAL_CONFIG_PRODUCER&&value!==SOURCE_PARTITIONED_PRODUCER)throw Error('unsupported_configuration_producer');
  return value;
}

/** Caller supplies existing HOST-owned configuration proposals, never model
 * output. This object constrains extraction; it grants no factual authority. */
export function captureCanonicalConfigurationProducer(businessId:number,proposals:readonly Proposal[],evidence:readonly Evidence[],
  protocol:ProducerProtocol=CANONICAL_CONFIG_PRODUCER):CanonicalConfigurationProducer {
  if(![CANONICAL_CONFIG_PRODUCER,SOURCE_PARTITIONED_PRODUCER].includes(protocol)||!Number.isSafeInteger(businessId)||businessId<=0||!proposals.length||proposals.length>6||!evidence.length||evidence.length>6||
    evidence.some(e=>e.businessId!==businessId||e.text.length>2400)||new Set(evidence.map(e=>e.id)).size!==evidence.length)
    throw Error('invalid_configuration_producer_context');
  const configIds=new Set<string>();
  for(const p of proposals){
    if(p.modality!=='descriptive'||p.evidenceRefs.length!==1||!p.facetIds.length||p.facetIds.length>4||
      p.evidenceRefs.some(r=>!evidence.some(e=>e.id===r.evidenceId&&e.businessId===businessId&&e.sourceId===r.sourceId&&
        e.chunkId===r.chunkId&&e.version===r.version&&e.text.includes(r.exactQuote))))throw Error('invalid_configuration_producer_binding');
    configIds.add(p.evidenceRefs[0].evidenceId);
  }
  const units=proposals.map(({evidenceRefs,...p})=>({...p,facetIds:[...p.facetIds],qualifiers:[...p.qualifiers],
    evidenceRefs:[{evidenceId:evidenceRefs[0].evidenceId}]}));
  const context:CanonicalConfigurationProducer=freeze({protocol,units,documentEvidenceIds:evidence.filter(e=>!configIds.has(e.id)).map(e=>e.id),inventory:inventory(evidence)});
  owners.add(context);return context;
}

export const CANONICAL_CONFIG_INSTRUCTION = `Canonical configuration propositions v1. For the backend-supplied canonicalConfigurationProposals, the extraction schema defines the ONLY permitted representations of those configuration facts. If proposing one, copy its complete fields, natural-language text, scope, qualifiers and ID-only citation exactly; do not substitute a charging-action predicate, a full disabled-state clause as value, or a different negation. These are still unverified proposals, not accepted facts, permissions or booking actions. Never infer a universal fee rule, unrelated fee, deadline or absence of a requirement from a configuration flag.
The backend-owned subject/predicate slots and assertion texts are reserved to their canonical source identities, not just their citation schema branch. A documentary citation MUST NOT be used for a canonical configuration claim, even if the claim is true elsewhere in the supplied context. Copy the canonical evidenceId together with the complete canonical proposition. Do not rename fields to evade this source contract. Other material source propositions must remain independently represented using documentary evidence IDs allowed by the schema. Do not hide a document condition or broaden a canonical fact. A unit requiring an unsupported mixed-source combination must not be invented or narrowed; report oversized=true if the material inventory cannot be represented safely. The backend retains its canonical proposals and every model proposal for independent verification; it never repairs or silently discards a rejected proposal. Return only the strict producer schema with literal-evidence-v1 ID-only citations.`;

export const SOURCE_PARTITIONED_INSTRUCTION = `Source-partitioned documentary extraction v1. Your sole responsibility is proposing facts explicitly supported by the supplied documentary evidence. Use only its evidence IDs with literal-evidence-v1. Authoritative configuration is a separate backend producer and is intentionally absent: never reconstruct, infer or copy its settings into documentary claims. An absent setting is unknown, not false or unrestricted. An empty valid documentary inventory is allowed when no supplied documentary proposition answers the request.
Preserve all directly applicable documentary conditions, exceptions, restrictions and recommendations with their original modality, even when their relationship to a separate configured offering is unknown. Multiple documentary evidence IDs may support one unit; never invent a cross-source relationship. If a necessary complete proposition cannot be represented within the schema or remaining unit limit, return oversized=true and units=[]. Do not add uncertainty as a factual proposition. All documentary proposals and separate backend proposals must still undergo independent verification against the complete evidence inventory. A source ID alone grants no truth or publication authority.`;

/** Disjoint source-ID alternatives: documentary free text cannot cite a host
 * configuration source; configuration units are exact host-owned alternatives. */
export function canonicalConfigurationSchema(base:any,context:CanonicalConfigurationProducer):any {
  if(!owners.has(context))throw Error('unowned_configuration_producer');
  const item=base.properties.units.items;
  if(context.protocol===SOURCE_PARTITIONED_PRODUCER){
    const capacity=6-context.units.length;
    if(!context.documentEvidenceIds.length||capacity<1)throw Error('documentary_partition_unrepresentable');
    return {...base,properties:{...base.properties,units:{...base.properties.units,maxItems:Math.min(base.properties.units.maxItems??6,capacity),
      items:{...item,properties:{...item.properties,evidenceRefs:{...item.properties.evidenceRefs,
        items:{type:'object',additionalProperties:false,required:['evidenceId'],properties:{evidenceId:{type:'string',enum:[...context.documentEvidenceIds]}}}}}}}}};
  }
  const enumeration=(value:any)=>({type:typeof value,enum:[value]});
  const choices:any[]=context.units.map(p=>({type:'object',additionalProperties:false,required:Object.keys(item.properties),properties:{
    ...Object.fromEntries(Object.entries(p).filter(([k])=>!['facetIds','qualifiers','evidenceRefs'].includes(k)).map(([k,v])=>[k,enumeration(v)])),
    facetIds:{...item.properties.facetIds,items:{type:'string',enum:[...p.facetIds]},minItems:p.facetIds.length,maxItems:p.facetIds.length},
    qualifiers:{...item.properties.qualifiers,...(p.qualifiers.length?{items:{type:'string',enum:[...p.qualifiers]}}:{}),minItems:p.qualifiers.length,maxItems:p.qualifiers.length},
    evidenceRefs:{type:'array',minItems:1,maxItems:1,items:{type:'object',additionalProperties:false,required:['evidenceId'],
      properties:{evidenceId:{type:'string',enum:[p.evidenceRefs[0].evidenceId]}}}},
  }}));
  if(context.documentEvidenceIds.length)choices.push({...item,description:'Documentary propositions only. Backend-owned canonical subject/predicate slots and assertion texts require their exact canonical alternative and source ID; this branch cannot supply them.',properties:{...item.properties,evidenceRefs:{...item.properties.evidenceRefs,
    items:{type:'object',additionalProperties:false,required:['evidenceId'],properties:{evidenceId:{type:'string',enum:[...context.documentEvidenceIds]}}}}}});
  return {...base,properties:{...base.properties,units:{...base.properties.units,items:{anyOf:choices}}}};
}

/** Reject the WHOLE extraction on a producer-contract violation, before literal
 * hydration or verification. No field rewriting, dropping units or deduping. */
export function canonicalConfigurationOutputValid(raw:any,context:CanonicalConfigurationProducer,current:readonly Evidence[]):boolean {
  if(!owners.has(context)||inventory(current)!==context.inventory||!keys(raw,['oversized','units'])||typeof raw.oversized!=='boolean'||
    !Array.isArray(raw.units)||raw.units.length>6)return false;
  const partitioned=context.protocol===SOURCE_PARTITIONED_PRODUCER;
  if(partitioned&&(raw.oversized||raw.units.length>6-context.units.length))return false;
  const configIds=new Set(context.units.flatMap(p=>p.evidenceRefs.map(r=>r.evidenceId)));
  return raw.units.every((u:any)=>{
    if(!keys(u,Object.keys(context.units[0]))||!Array.isArray(u.evidenceRefs)||!u.evidenceRefs.length||u.evidenceRefs.length>4||
      u.evidenceRefs.some((r:any)=>!keys(r,['evidenceId'])||typeof r.evidenceId!=='string')||
      new Set(u.evidenceRefs.map((r:any)=>r.evidenceId)).size!==u.evidenceRefs.length)return false;
    // Select authority from the proposition contract as well as the citation.
    // Reject the entire packet if a reserved assertion/slot uses the document
    // branch, even with a changed value, negation or scope. Never repair its ID.
    if(context.units.some(p=>reserves(p,u))||u.evidenceRefs.some((r:any)=>configIds.has(r.evidenceId)))
      return !partitioned&&context.units.some(p=>stable(u)===stable(p));
    return u.evidenceRefs.every((r:any)=>context.documentEvidenceIds.includes(r.evidenceId));
  });
}
