import { createHash } from 'node:crypto';
import { type AnswerUnit, type Evidence } from './business-information-answer-plan';
/** Structured service data is a separate authority, never a document revision.
 * Unknown fields and credentials cannot enter the model evidence envelope. */
export function configuredServiceEvidence(businessId:number, services:unknown): Evidence | null {
 if (!Number.isSafeInteger(businessId) || businessId<=0 || !Array.isArray(services)) return null;
 const catalog=services.filter(s=>s && typeof s.name==='string' && s.name.trim() && s.active!==false).map(s=>({
  name:s.name, ...(typeof s.description==='string'?{description:s.description}:{}),
  ...(Number.isFinite(s.price)?{price:s.price}:{}), ...(typeof s.currency==='string'?{currency:s.currency}:{}),
  ...(Number.isFinite(s.durationMinutes??s.duration_minutes??s.duration)?{durationMinutes:s.durationMinutes??s.duration_minutes??s.duration}:{}),
 }));
 if(!catalog.length)return null;
 const text=JSON.stringify({authority:'structured_services',services:catalog});
 const version=createHash('sha256').update(text).digest('hex');
 return Object.freeze({id:'configured-services',businessId,sourceId:`configured-services:${businessId}`,chunkId:version,version,text});
}

/** Extra veto, never proof of entailment. A catalog label cannot supply a
 * missing document-to-service identity relationship. Ordinary catalog-only
 * facts and independently scoped document facts retain their existing gates. */
export function configuredServiceScopeSupported(unit:Pick<AnswerUnit,'text'|'subject'|'predicate'|'value'|'scope'|'qualifiers'|'evidenceRefs'>,evidence:readonly Evidence[]):boolean {
 const catalog=evidence.find(e=>e.id==='configured-services'&&e.sourceId===`configured-services:${e.businessId}`);
 if(!catalog)return true;
 const docs=unit.evidenceRefs.map(r=>evidence.find(e=>e.id===r.evidenceId)).filter((e):e is Evidence=>!!e&&e.id!=='configured-services');
 if(!docs.length)return true;
 if(docs.some(e=>e.businessId!==catalog.businessId))return false;
 let services:any[];
 try {const parsed=JSON.parse(catalog.text);if(parsed.authority!=='structured_services'||!Array.isArray(parsed.services))return false;services=parsed.services;}catch{return false;}
 const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
 const hasName=(text:string,name:string)=>new RegExp(`(?<![\\p{L}\\p{N}])${normalize(name).replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}(?![\\p{L}\\p{N}])`,'u').test(normalize(text));
 const fields=[unit.text,unit.subject,unit.predicate,unit.value,unit.scope,...unit.qualifiers].join('\n');
 if(fields.includes('[separate catalog service]')||fields.includes('[question subject]'))return false;
 return services.every(s=>typeof s.name!=='string'||!s.name.trim()||!hasName(fields,s.name)||docs.every(d=>hasName(d.text,s.name)));
}
