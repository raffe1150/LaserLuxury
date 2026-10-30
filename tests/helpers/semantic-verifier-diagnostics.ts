/** Local synthetic harness only. Never imported by the production server.
 * These records describe explicit outputs; they do not explain model internals
 * or participate in acceptance, entailment, coverage or publication. */
import {createHash} from 'node:crypto';

export type SyntheticVerifierPolicy={
 enabled:boolean;nodeEnv:string;question:string;allowedEvidence:ReadonlySet<string>;
 structuredAuthority:unknown;secrets:readonly string[];
};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const canonical=(x:any):string=>JSON.stringify(Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])):x);
const fail=():never=>{throw Error('Synthetic verifier capture rejected');};
function safe(value:unknown,policy:SyntheticVerifierPolicy,maximum:number){
 const text=JSON.stringify(value);if(!text||text.length>maximum)fail();
 if(policy.secrets.some(s=>s.length>=8&&text.includes(s))||/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|Bearer\s+\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\+?\d[ ()-]*){9,}/u.test(text))fail();
 const inspect=(v:any)=>{if(object(v))for(const[k,x]of Object.entries(v)){if(/^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|customer[_-]?(?:name|phone|email))$/iu.test(k))fail();inspect(x);}else if(Array.isArray(v))v.forEach(inspect);};
 inspect(value);return text;
}
export function captureSyntheticVerifierRequest(body:unknown,policy:SyntheticVerifierPolicy){
 if(!policy.enabled||policy.nodeEnv!=='test'||!object(body))return fail();
 // No options/headers enter this API. Unknown request fields are refused rather
 // than silently omitted while claiming a complete capture.
 if(Object.keys(body).some(k=>!['model','instructions','input','tools','reasoning','text','temperature'].includes(k)))fail();
 if(body.model!=='gpt-5.6-luna'||typeof body.instructions!=='string'||!body.instructions.includes('BATCH ENTAILMENT')||body.tools?.length)fail();
 const encoded=safe(body,policy,128_000);
 if(!Array.isArray(body.input)||body.input.length!==1||body.input[0]?.role!=='user'||typeof body.input[0]?.content!=='string')fail();
 let input:any;try{input=JSON.parse(body.input[0].content);}catch{fail();}
 if(!object(input)||input.question!==policy.question||!Array.isArray(input.units)||input.units.length>6||!Array.isArray(input.facets)||input.facets.length>4||!Array.isArray(input.evidence)||input.evidence.length>6)fail();
 safe(input,policy,64_000);
 if(input.evidence.some((e:any)=>!object(e)||e.businessId!==77||typeof e.id!=='string'||!policy.allowedEvidence.has(e.text))||new Set(input.evidence.map((e:any)=>e.id)).size!==input.evidence.length)fail();
 let authority=input.authoritativeEvidence;
 if(typeof authority==='string'){try{authority=JSON.parse(authority);}catch{fail();}}
 if(!object(authority)||Object.keys(authority).sort().join(',')!=='business_system_prompt,structured_business_config,verified_booking_state'||authority.business_system_prompt!==''||authority.verified_booking_state!=='')fail();
 let config=authority.structured_business_config;
 if(typeof config==='string'){try{config=JSON.parse(config);}catch{fail();}}
 if(canonical(config)!==canonical(policy.structuredAuthority))fail();
 return {captureStatus:'COMPLETE' as const,request:structuredClone(body),input:structuredClone(input),
  requestSha256:digest(encoded),inputSha256:digest(JSON.stringify(input)),
  privacy:'Only the pre-authorized synthetic fixture contract; no HTTP headers captured'};
}
type Capture=ReturnType<typeof captureSyntheticVerifierRequest>;

export function captureSyntheticVerifierDecision(capture:Capture,text:string,policy:SyntheticVerifierPolicy){
 safe(text,policy,32_000);let output:any;
 try{output=JSON.parse(text);}catch{return{captureStatus:'COMPLETE',rawStructuredText:text,reasonStatus:'UNKNOWN',reason:'Malformed structured response; no decision witness inferred'}};
 const input=capture.input;
 const decisions=Array.isArray(output?.decisions)?output.decisions:[];
 const units=input.units.map((u:any)=>{
  const rows=decisions.filter((d:any)=>d?.unitId===u.id),d=rows.length===1?rows[0]:null;
  const categories:string[]=[];
  if(d){
   if(d.relation!=='ENTAILED')categories.push('ENTAILMENT_RELATION');
   for(const[field,category]of Object.entries({meaningPreserved:'SEMANTIC_PRESERVATION',modalityPreserved:'MODALITY',qualifiersPreserved:'CONDITIONS_OR_QUALIFIERS',relevant:'RELEVANCE',languageCorrect:'LANGUAGE'}))if(d[field]===false)categories.push(category);
   if(d.negativeAbsence===true&&d.explicitAbsenceEvidence===false)categories.push('EXPLICIT_ABSENCE_EVIDENCE');
  }
  return{unitId:u.id,proposition:{subject:u.subject,predicate:u.predicate,value:u.value,scope:u.scope,qualifiers:u.qualifiers,modality:u.modality,negation:u.negation,text:u.text},
   reviewedSpan:{start:0,end:typeof u.text==='string'?u.text.length:0,text:u.text,granularity:'WHOLE_UNIT'},
   evidenceBindings:(Array.isArray(u.evidenceRefs)?u.evidenceRefs:[]).map((r:any)=>{
    const e=input.evidence.find((e:any)=>e.id===r.evidenceId),start=e&&typeof r.exactQuote==='string'?e.text.indexOf(r.exactQuote):-1;
    return{evidenceAlias:r.evidenceId,quotedSpan:r.exactQuote,sourceSha256:e?digest(e.text):null,sourceStartUtf16:start>=0?start:null,sourceEndUtf16:start>=0?start+r.exactQuote.length:null,
     bindingStatus:!e?'EVIDENCE_ALIAS_UNKNOWN':start<0?'QUOTE_NOT_FOUND':'EXACT'};
   }),reportedDecision:d,observableCategories:categories,
   reasonStatus:'UNKNOWN',exactRejectedSubproposition:null,semanticExplanation:null,
   reason:d?'The production response supplies flags and relation, not a source-anchored explanation':'Missing or duplicate verdict; no unique model decision',
   provenance:'Copied decision fields and deterministic source offsets; no generated explanation; not acceptance authority'};
 });
 const coverage=input.facets.map((f:any)=>{
  const rows=(Array.isArray(output?.coverage)?output.coverage:[]).filter((c:any)=>c?.facetId===f.id),c=rows.length===1?rows[0]:null;
  return{facetId:f.id,requestedQuestion:input.question,requestedObligations:f.obligations,reportedCoverage:c,
   reportedMaterialUnits:c?.materialUnitIds??null,
   missingRequestedProposition:{status:!c||c.materialFactsComplete!==true?'UNKNOWN':'NOT_REPORTED_MISSING',text:null,evidenceAlias:null,sourceSpan:null},
   reasonStatus:'UNKNOWN',reason:'No source-anchored missing proposition exists in the production response contract. Unit presence and an enum cannot identify it.'};
 });
 return{captureStatus:'COMPLETE',rawStructuredText:text,outputSha256:digest(text),units,coverage,
  noDecisionMutation:true,noExplanationGeneration:true,sourceScopeReason:'UNKNOWN unless separately reported by the application; never inferred from meaningPreserved=false'};
}
