import {directServiceInformationPlan} from './direct-service-planning';
import {literalInformationFallback} from './knowledge-planning';
import {hasServiceName} from './source-aware-service-proposal';
import {businessInformationTopics,isBusinessInformationQuestion,isExplicitBusinessActionRequest} from './business-information';

// Speech-act grammar only, never documentary topics or business facts. A named
// documentary subject must follow an explicit request for its purpose/limits.
const documentaryForms=[
 /^(?:separately,?\s+)?(?:please\s+)?(?:also\s+)?(?:explain|describe) the documented purpose and limits of (.+)$/iu,
 /^beskriv (?:även )?det dokumenterade syftet och begränsningarna för (.+)$/iu,
 /^(?:bitte )?erläutern sie (?:auch )?den dokumentierten zweck und die grenzen von (.+)$/iu,
 /^(?:bitte )?(?:erklären|erläutern) sie separat den dokumentierten zweck und die grenzen (?:von )?(.+)$/iu,
 /^explica (?:también )?el propósito y los límites documentados de (.+)$/iu,
 /^(?:لطفاً )?هدف و محدودیت(?:‌| )های مستند (.+) را توضیح دهید$/u,
 /^اشرح (?:أيضاً )?الغرض والحدود الموثقة لـ (.+)$/u,
 // Keep the attached Arabic preposition in this syntax-only subject probe.
 // The original question, not this probe, is the downstream request contract.
 /^اشرح بشكل منفصل الغرض والحدود الموثقة (ل.+)$/u,
];

// One locally attached, explicit replacement question. This is request data,
// not proof that either offering replaces the named object. Other forms retain
// semantic planning and the full original question still reaches verification.
const attachedRelationshipForms=[
 /^and can it replace (.+?)[?؟]\s+/iu,
 /^och kan den ersätta (.+?)[?؟]\s+/iu,
 /^und kann (?:sie|es) (.+?) ersetzen[?؟]\s+/iu,
 /^y puede sustituir (.+?)[?؟]\s+/iu,
 /^و آیا می(?:‌| )تواند جایگزین (.+?) شود[?؟]\s+/u,
 /^و?هل يمكن أن تحل محل (.+?)[?؟]\s+/u,
];

/** Admit the existing full-question recovery contract before planning only
 * when both catalog attributes have an exact, unique owner and the remaining
 * request explicitly names documentary scope. This selects no facts, resolves
 * no service/document relationship and grants no entailment or coverage.
 * Unknown grammar, operational requests and references retain model planning. */
export function directMixedSourceInformationPlan(question:string,businessId:number,services:unknown,referenceRequired=false){
 const text=question.trim();
 if(referenceRequired||!text||text.length>240||!Array.isArray(services)||/[!;:؛\n\r<>\[\]{}"`\\]/u.test(text))return null;
 // A documentary title must not conceal a second action, option or reference.
 if(/\b(?:book\p{L}*|reserv\p{L}*|cancel\p{L}*|reschedul\p{L}*|appointment\p{L}*|availability|available|slots?|calendar|boka|bokning\p{L}*|avbok\p{L}*|omboka|tider|buchen|buchung\p{L}*|termin\p{L}*|stornier\p{L}*|verfügbar\p{L}*|citas?|disponib\p{L}*|ignore|override|instructions?|system|prompt|tools?|execute|delete|send|create|update|json|previous|earlier|same|another|other|that|those|these|if|unless|or|eller|oder|wenn|falls|si)\b|رزرو|نوبت|لغو|قبلی|همان|اگر|حجز|موعد|إلغاء|الغاء|السابق|إذا|اذا/iu.test(text))return null;
 const named=services.filter(s=>s&&s.active!==false&&typeof s.name==='string'&&s.name.trim()&&s.name.length<=128&&hasServiceName(text,s.name));
 if(named.length!==1)return null;
 for(const boundary of text.matchAll(/[?؟,،]/gu)){
  const prefix=text.slice(0,boundary.index).trim();
  if(!directServiceInformationPlan(`${prefix}?`,businessId,services,false,true))continue;
  let tail=text.slice(boundary.index+1).trim();
  // One locally attached relationship question is data, not an assertion of
  // equivalence. Its explicit object is retained in the FULL verifier request.
  const label=named[0].name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  const paraphrases=[
   new RegExp(`^(?:could|can) i use (?:it|${label}) (?:instead of|in place of) (.+?)[?؟]\\s+`,'iu'),
   new RegExp(`^kan jag använda (?:den|det|${label}) (?:i stället för|istället för) (.+?)[?؟]\\s+`,'iu'),
   /^kann ich mir damit (.+?) sparen[?؟]\s+/iu,
   new RegExp(`^kann ich (?:sie|es|${label}) anstelle (.+?) nutzen[?؟]\\s+`,'iu'),
   new RegExp(`^¿?puedo (?:usarlo|usarla|usar ${label}) en lugar de (.+?)[?؟]\\s+`,'iu'),
   new RegExp(`^آیا با ${label} دیگر نیازی به (.+?) ندارم[?؟]\\s+`,'u'),
   new RegExp(`^هل تغنيني ${label} عن (.+?)[?؟]\\s+`,'u'),
  ];
  const relation=[...attachedRelationshipForms,...paraphrases].map(form=>form.exec(tail)).find(Boolean);
  if(relation){
   if(!namedSubject(relation[1]))continue;
   tail=tail.slice(relation[0].length);
  }else if(boundary[0]===','||boundary[0]==='،')continue;
  const request=tail.replace(/[.?؟]$/u,'').trim();
  const subject=documentaryForms.map(form=>form.exec(request)?.[1]).find(Boolean);
  if(!subject||!namedSubject(subject)||services.some(s=>s&&typeof s.name==='string'&&s.name.trim()&&s.name.length<=128&&hasServiceName(tail,s.name)))continue;
  const plan=literalInformationFallback(text,true,referenceRequired);
  // Preserve the requested configured authority before retrieval/freshness can
  // remove its record. This adds no facts or coverage and changes no query.
  return {...plan,requestedFacets:plan.requestedFacets.map(f=>({...f,obligations:f.obligations.map(o=>({...o,
    catalogRequirement:{businessId,serviceName:named[0].name,attributes:['price','duration'] as const}}))}))};
 }
 return null;
}

function namedSubject(text:string):boolean{
 return /\p{L}/u.test(text)&&/^[\p{L}\p{M}\p{N} -]{2,80}$/u.test(text)&&text.trim().split(/\s+/u).length<=8&&
  !/(?<![\p{L}\p{M}])(?:it|this|them|there|and|och|und|y|den|det|das|es|sie|dies\p{L}*|ander\p{L}*|nicht|kein\p{L}*|eso|آن|این|و|ذلك|هذا|هذه|هو|هي)(?![\p{L}\p{M}])/iu.test(text)&&
  !/^ل(?:هذا|هذه|ذلك|تلك)(?![\p{L}\p{M}])/u.test(text);
}

/** Shared admission only: coordinated catalog questions may need the existing
 * semantic planner. A conjunction supplies no source facts or applicability.
 * Spanish y needs an adjoining request/attribute, not a letter/name.
 * Arabic waw is also attached to a catalog attribute; do not interpret every
 * word beginning with waw as a conjunction. */
export function mixedSourceInformationQuestion(question:string,businessId:number,services:unknown):boolean {
 if(directMixedSourceInformationPlan(question,businessId,services))return true;
 if(!isBusinessInformationQuestion(question)||isExplicitBusinessActionRequest(question)||
  !businessInformationTopics(question).some(t=>t==='prices'||t==='services'))return false;
 // Whole-question catalog-only contracts retain their structured route.
 if(directServiceInformationPlan(question,businessId,services))return false;
 return /\b(?:and|och|und)\b|\by\s+(?:(?:el|la|los|las|su|sus)\s+)?(?:precio|duraci[oó]n|cu[aá]nto|qu[eé]|l[ií]mites|prop[oó]sito|pued[eo])\b|[،,]|(?<![\p{L}\p{M}])و(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])و(?=(?:ال)?(?:مدة|مدته|مدتها|سعر|سعره|سعرها)(?![\p{L}\p{M}]))/iu.test(question);
}
