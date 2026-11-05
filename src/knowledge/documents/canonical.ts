import {createHash} from 'node:crypto';
import {chunkKnowledgeContent, knowledgeSourceRevision, type KnowledgeSource, type KnowledgeSearchMatch} from '../../../knowledge';

export const CANONICAL_DOCUMENT_VERSION = 'canonical-document-v1';
export const CANONICAL_RESOURCE_LIMITS=Object.freeze({maxChars:100_000,maxNodes:200,maxChunks:200});
export const canonicalHash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type BlockKind = 'section'|'heading'|'paragraph'|'table'|'condition'|'exception'|'cross-reference';
export type TableCell = Readonly<{row:number;column:number;rowSpan:number;columnSpan:number;start:number;end:number;header:boolean}>;
/** Adapter structure is source data, not a semantic completeness certificate. */
export type AdapterBlock = {text:string;kind?:BlockKind;heading?:string;scope?:'document'|'section';parent?:number;references?:number[];
  page?:number;sheet?:string;section?:string;cells?:readonly TableCell[]};
export type CanonicalAdapterInput = {format:string;adapterVersion:string;blocks:readonly AdapterBlock[]};
export type CanonicalNode = Readonly<{id:string;parentId:string;kind:BlockKind;heading?:string;scope:'document'|'section'|'unknown';references:readonly string[];
  rawStart:number;rawEnd:number;rawDigest:string;cells?:readonly TableCell[];provenance:Readonly<{page?:number;sheet?:string;section?:string}>}>;
export type CanonicalChunk = Readonly<{id:string;sectionId:string;digest:string;text:string;match:KnowledgeSearchMatch}>;
export type CanonicalDocument = Readonly<{protocol:typeof CANONICAL_DOCUMENT_VERSION;businessId:number;sourceId:string;
  revision:string;fence:string;inventoryRoot:string;contentHash:string;format:string;adapterVersion:string;
  nodes:readonly CanonicalNode[];chunks:readonly CanonicalChunk[];
  structure:'legacy-flat'|'adapter-structured';qualificationCompleteness:'UNCLASSIFIED'}>;
function need(value:unknown):asserts value {if(!value)throw Error('canonical_document_invalid');}
function frozen<T>(v:T):T {if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}

/** Shared adapter boundary; parsing PDF/DOCX/HTML bytes remains in their adapters.
 * This representation does not increase existing upload/resource limits. */
export function canonicalAdapterContent(input:CanonicalAdapterInput) {
  need(input.format.trim()&&input.adapterVersion.trim()&&input.blocks.length);
  let content='';
  const segments=input.blocks.map((block,index)=>{
    need(typeof block.text==='string'&&block.text.trim());
    need(block.parent===undefined||Number.isInteger(block.parent)&&block.parent>=0&&block.parent<index);
    need(!block.references||block.references.every(ref=>Number.isInteger(ref)&&ref>=0&&ref<input.blocks.length));
    const {text,...metadata}=block,start=content.length;content+=text+'\n\n';return{start,end:start+text.length,...metadata};
  });
  return {content:content.trimEnd(),metadata:{segments,canonicalAdapter:{format:input.format,version:input.adapterVersion}}};
}

/** Canonical compatibility projection. Raw ranges retain original extracted text;
 * chunk spans address the existing normalized citation text (UTF-16 offsets).
 * Normalization is the existing legacy chunker, never generated prose. */
export function canonicalDocument(source:KnowledgeSource,limits:Readonly<{maxChars:number;maxNodes:number;maxChunks:number}>=CANONICAL_RESOURCE_LIMITS):CanonicalDocument {
  need(Object.values(limits).every(n=>Number.isSafeInteger(n)&&n>0));
  need(Number.isSafeInteger(source.businessId)&&source.businessId>0&&source.id&&source.type==='document'&&source.status==='ready');
  const segments=source.metadata.segments;need(source.content.length<=limits.maxChars&&Array.isArray(segments)&&segments.length&&segments.length<=limits.maxNodes);
  const revision=knowledgeSourceRevision(source),root=canonicalHash([source.businessId,source.id,revision]);
  const ids=segments.map((segment,index)=>canonicalHash([root,'section',index,segment]));
  const chunks:CanonicalChunk[]=[],nodes:CanonicalNode[]=[];let end=0;
  for(const [index,s] of segments.entries()){
    need(s&&Number.isInteger(s.start)&&Number.isInteger(s.end)&&s.start>=end&&s.end>s.start&&s.end<=source.content.length);
    need(!source.content.slice(end,s.start).trim());end=s.end;
    need(s.parent===undefined||Number.isInteger(s.parent)&&s.parent>=0&&s.parent<index);
    need(!s.references||Array.isArray(s.references)&&s.references.every((ref:any)=>Number.isInteger(ref)&&ref>=0&&ref<segments.length));
    const kind=s.kind??'section';need(['section','heading','paragraph','table','condition','exception','cross-reference'].includes(kind));
    need(s.scope===undefined||['document','section'].includes(s.scope));
    need(s.heading===undefined||typeof s.heading==='string');
    need(s.page===undefined||Number.isInteger(s.page)&&s.page>0);
    need(['sheet','section'].every(key=>s[key]===undefined||typeof s[key]==='string'));
    const provenance={...(s.page!==undefined?{page:s.page}:{}),...(s.sheet!==undefined?{sheet:s.sheet}:{}),...(s.section!==undefined?{section:s.section}:{})};
    const raw=source.content.slice(s.start,s.end);
    if(s.cells!==undefined){
      need(kind==='table'&&Array.isArray(s.cells));
      for(const cell of s.cells)need(cell&&['row','column','start'].every(k=>Number.isSafeInteger(cell[k])&&cell[k]>=0)&&
        ['rowSpan','columnSpan'].every(k=>Number.isSafeInteger(cell[k])&&cell[k]>0)&&Number.isSafeInteger(cell.end)&&
        cell.end>cell.start&&cell.end<=raw.length&&typeof cell.header==='boolean');
    }
    nodes.push({id:ids[index],parentId:s.parent===undefined?root:ids[s.parent],kind,heading:s.heading,scope:s.scope??'unknown',
      references:(s.references||[]).map((ref:number)=>ids[ref]),rawStart:s.start,rawEnd:s.end,rawDigest:canonicalHash(raw),...(s.cells?{cells:s.cells.map((cell:TableCell)=>({...cell}))}:{}),provenance});
    for(const [ordinal,chunk] of chunkKnowledgeContent(raw).entries()){
      const digest=canonicalHash([chunk.content,provenance]),id=canonicalHash([root,ids[index],ordinal,digest]);
      chunks.push({id,sectionId:ids[index],digest,text:chunk.content,match:{businessId:source.businessId,sourceId:source.id,text:chunk.content,
        metadata:{source:'document',filename:source.title,untrusted:true,...provenance,documentRevision:revision}}});
    }
  }
  need(!source.content.slice(end).trim()&&chunks.length&&chunks.length<=limits.maxChunks);
  const inventoryRoot=canonicalHash([root,nodes,chunks.map(c=>[c.id,c.digest])]);
  const adapter=source.metadata.canonicalAdapter as Record<string,unknown>|undefined;
  if(adapter)need(typeof adapter.format==='string'&&typeof adapter.version==='string');
  return frozen({protocol:CANONICAL_DOCUMENT_VERSION,businessId:source.businessId,sourceId:source.id,revision,
    fence:canonicalHash([revision,source.updatedAt,inventoryRoot]),inventoryRoot,contentHash:canonicalHash(source.content),
    format:String(adapter?.format||'legacy'),adapterVersion:String(adapter?.version||'legacy-v1'),
    structure:source.metadata.canonicalAdapter?'adapter-structured':'legacy-flat',qualificationCompleteness:'UNCLASSIFIED',nodes,chunks});
}

export type CoverageBatch = Readonly<{ordinal:number;chunkIds:readonly string[];digest:string}>;
export type CoveragePlan = Readonly<{inventoryRoot:string;batches:readonly CoverageBatch[];reviewState:'NOT_REVIEWED'}>;
/** Exhaustive bounded traversal, NOT a model verdict or publication authority.
 * Number of batches grows with the inventory; evidence limits do not grow. */
export function planCanonicalCoverage(doc:CanonicalDocument):CoveragePlan {
  const batches:CoverageBatch[]=[];let ids:string[]=[],chars=0;
  const flush=()=>{if(ids.length)batches.push({ordinal:batches.length,chunkIds:ids,digest:canonicalHash(ids.map(id=>doc.chunks.find(c=>c.id===id)!.digest))});ids=[];chars=0;};
  for(const chunk of doc.chunks){
    need(chunk.text.length<=2400);
    if(ids.length===5||chars+chunk.text.length>9000)flush();
    ids.push(chunk.id);chars+=chunk.text.length;
  }
  flush();return frozen({inventoryRoot:doc.inventoryRoot,batches,reviewState:'NOT_REVIEWED'});
}
export function canonicalTraversalComplete(doc:CanonicalDocument,plan:CoveragePlan,reviewed:readonly string[]):boolean {
  return plan.inventoryRoot===doc.inventoryRoot&&canonicalHash(plan)===canonicalHash(planCanonicalCoverage(doc))&&
    reviewed.length===doc.chunks.length&&new Set(reviewed).size===reviewed.length&&doc.chunks.every(c=>reviewed.includes(c.id));
}
