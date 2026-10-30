import { hasServiceName } from './source-aware-service-proposal';

// Whole-question grammar after replacing ONE exact tenant catalog label. A
// recognized noun or a price keyword alone never establishes catalog-only scope.
const forms:readonly [RegExp,readonly ('price'|'duration')[]][]=[
 [/^(?:what is (?:the )?(?:configured )?price of SERVICE|how much does SERVICE cost|what does SERVICE cost)$/iu,['price']],
 [/^(?:how long does SERVICE last|what is (?:the )?(?:configured )?duration of SERVICE)$/iu,['duration']],
 [/^(?:what is (?:the )?(?:configured )?price of SERVICE|how much does SERVICE cost|what does SERVICE cost),? and how long does it last$/iu,['price','duration']],
 [/^what (?:is|are) (?:the )?(?:configured )?price and duration of SERVICE$/iu,['price','duration']],
 [/^vad kostar SERVICE$/iu,['price']],
 [/^(?:hur lång tid tar SERVICE|hur länge varar SERVICE)$/iu,['duration']],
 [/^vad kostar SERVICE och (?:hur lång tid tar|hur länge varar) (?:den|det)$/iu,['price','duration']],
 [/^was kostet SERVICE$/iu,['price']],
 [/^wie lange dauert SERVICE$/iu,['duration']],
 [/^was kostet SERVICE und wie lange dauert (?:sie|es)$/iu,['price','duration']],
 [/^cuánto cuesta SERVICE$/iu,['price']],
 [/^cuánto (?:tiempo )?dura SERVICE$/iu,['duration']],
 [/^cuánto cuesta SERVICE y cuánto (?:tiempo )?dura$/iu,['price','duration']],
 [/^قیمت SERVICE چقدر است$/u,['price']],
 [/^مدت SERVICE چقدر است$/u,['duration']],
 [/^قیمت SERVICE چقدر است و مدت آن چقدر است$/u,['price','duration']],
 [/^(?:ما|كم) سعر SERVICE$/u,['price']],
 [/^(?:ما مدة SERVICE|كم تستغرق SERVICE)$/u,['duration']],
 [/^(?:ما|كم) سعر SERVICE و(?:ما مدتها|كم تستغرق)$/u,['price','duration']],
 [/^(?:ما|كم) سعر ومدة SERVICE$/u,['price','duration']],
];

/** Request contract only: no facts, inferred aliases or publication permission.
 * Unrecognized conditions, negation, additional subjects and actions keep the
 * existing planner. Catalog revisions and every claim still need verification. */
export function directServiceInformationPlan(question:string,businessId:number,services:unknown,referenceRequired=false,requirePriceAndDuration=false){
 const text=question.trim();
 if(referenceRequired||!Number.isSafeInteger(businessId)||businessId<=0||!Array.isArray(services)||!text||text.length>240||(text.match(/[?؟]/gu)||[]).length!==1||!/[?؟]$/u.test(text))return null;
 // Fail closed if a supplied catalog contains explicitly foreign ownership.
 if(services.some(s=>s&&['businessId','business_id'].some(k=>s[k]!=null&&String(s[k])!==String(businessId))))return null;
 const active=services.filter(s=>s&&s.active!==false&&typeof s.name==='string'&&s.name.trim()&&s.name.length<=128);
 const matches=active.filter(s=>hasServiceName(text,s.name));
 if(matches.length!==1)return null;
 const service=matches[0];
 const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
 const name=normalize(service.name).replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
 const pattern=new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${name}(?![\\p{L}\\p{M}\\p{N}])`,'gu');
 const namedQuestion=normalize(text);if([...namedQuestion.matchAll(pattern)].length!==1)return null;
 const request=namedQuestion.replace(pattern,'SERVICE').replace(/^¿/u,'').replace(/[?؟]$/u,'').trim();
 const attributes=forms.find(([form])=>form.test(request))?.[1];
 if(!attributes||requirePriceAndDuration&&attributes.length!==2)return null;
 if(attributes.includes('price')&&(!Number.isFinite(service.price)||service.price<0||typeof service.currency!=='string'||!/^[A-Z]{3}$/u.test(service.currency)))return null;
 const duration=service.durationMinutes??service.duration_minutes??service.duration;
 if(attributes.includes('duration')&&(!Number.isFinite(duration)||duration<=0))return null;
 return {canonicalMeaning:text,queries:[text],queryLanguages:{},requestKind:'BUSINESS_INFORMATION',referenceResolution:'NOT_REQUIRED' as const,
  requestedFacets:[{subject:'customer request',attribute:text,questionType:'description',obligations:[{description:text,questionType:'description'}]}]};
}
