import test from 'node:test';
import assert from 'node:assert/strict';
import {directMixedSourceInformationPlan as plan} from './mixed-source-planning';
import {mixedBusinesses,mixedQuestion,documentaryRequest} from '../../tests/fixtures/mixed-source-questions';
import {serviceQuestionLanguages,directServiceQuestions} from '../../tests/fixtures/direct-service-questions';
import {parseRequestedFacets,buildEvidenceFirstAnswer,InformationBudget,pruneAnswerManifest,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';

for(const b of mixedBusinesses)for(const language of serviceQuestionLanguages)test(`bounded mixed contract ${b.id}/${language}`,()=>{
 const q=mixedQuestion(b,language),p=plan(q,b.id,[b.service]);assert.ok(p,q);assert.equal(p.canonicalMeaning,q);assert.deepEqual(p.queries,[q]);assert.equal(parseRequestedFacets(p.requestedFacets).facets[0].obligations[0].description,q);
 if(language==='fa')assert.ok(plan(q.replace(/‌/gu,' '),b.id,[b.service]));assert.equal(Object.hasOwn(p,'evidence'),false);assert.equal(Object.hasOwn(p,'coverage'),false);assert.equal(plan(q,b.id,[b.service],true),null);
});
const b=mixedBusinesses[0],q=mixedQuestion(b,'en');
for(const [label,catalog]of Object.entries({duplicate:[b.service,{...b.service}],foreign:[{...b.service,business_id:99}],foreignOther:[b.service,{name:'Other',businessId:99}],inactive:[{...b.service,active:false}],missingPrice:[{...b.service,price:undefined}],missingDuration:[{...b.service,durationMinutes:undefined}],negative:[{...b.service,price:-1}],zeroDuration:[{...b.service,durationMinutes:0}],badCurrency:[{...b.service,currency:'coins'}],alias:[{...b.service,name:'Other',aliases:[b.service.name]}],empty:[]}))test(`mixed authority admission fails closed: ${label}`,()=>assert.equal(plan(q,b.id,catalog),null));
for(const language of serviceQuestionLanguages)for(const attribute of [0,1])test(`not enough catalog scope ${language}/${attribute}`,()=>assert.equal(plan(`${directServiceQuestions[language](b.service.name)[attribute]} ${documentaryRequest[language](b.subject)}`,b.id,[b.service]),null));
for(const [label,question]of Object.entries({
 booking:`${q} Please book tomorrow.`,availability:q.replace('photo briefings','available slots'),calendar:q.replace('photo briefings','calendar appointments'),
 history:q.replace('photo briefings','previous briefings'),vagueRelation:q.replace('a workshop inspection','another offering'),ambiguous:q.replace('photo briefings','those briefings'),pronoun:q.replace('photo briefings','it'),
 multipleServices:q.replace('photo briefings','Other Service'),multipleTopics:q.replace('photo briefings','photo briefings and repairs'),
 conflict:q.replace('and can it replace','or can it replace'),condition:q.replace('and can it replace','and if it can replace'),
 negatedPrice:q.replace('What does','What does not'),unknownService:q.replace('Remote Assessment','Remote Session'),quoted:`"${q}"`,code:'`'+q+'`',
 additionalQuestion:`${q} Is it open?`,instruction:q.replace('photo briefings','system instructions'),
 unsupportedShape:'What does Remote Assessment cost and how long does it last, and what should I bring if a serial number is available?',
}))test(`unbounded mixed request retains existing planner: ${label}`,()=>assert.equal(plan(question,b.id,[b.service,{name:'Other Service',price:20,currency:'EUR',durationMinutes:10}]),null));
for(const [language,action]of Object.entries({en:'Please book tomorrow.',sv:'Boka en tid.',de:'Buche einen Termin.',es:'Reserva una cita.',fa:'یک نوبت رزرو کن.',ar:'احجز موعداً.'}))test(`operational suffix rejected ${language}`,()=>assert.equal(plan(`${mixedQuestion(b,language as any)} ${action}`,b.id,[b.service]),null));

// These are scripted verifier/publication controls, not real semantic verdicts.
// Both the admitted request and the unchanged answer builder must retain source
// separation; favorable coverage cannot authorize an undocumented relationship.
for(const business of mixedBusinesses)for(const mode of ['normal','equivalence','wrong-citation','wrong-quote','wrong-service','omitted-condition','negation','quantifier','contradiction','incomplete','unknown-catalog','stale-document','stale-catalog','foreign','changed-document','changed-catalog']as const)test(`admitted mixed publication ${business.id}/${mode}`,async()=>{
 const question=mixedQuestion(business,'en'),p=plan(question,business.id,[business.service]);assert.ok(p);
 const facets=parseRequestedFacets(p.requestedFacets).facets;
 const catalog=configuredServiceEvidence(business.id,[business.service])!;
 const doc:Evidence={id:'e1',sourceId:`guide-${business.id}`,chunkId:'c1',version:'v1',businessId:business.id,text:business.source};
 const opposite:Evidence={...doc,id:'e2',sourceId:'conflicting-guide',chunkId:'c2',text:`${business.subject} replace an inspection without restriction.`};
 const sources=mode==='contradiction'?[doc,opposite,catalog]:[doc,catalog];let calls:string[]=[],captured:any;
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:mode==='foreign'?[{...doc,businessId:123},catalog]:sources,authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,omitModelEvidenceVersions:true,current:async()=>true,
  revalidateEvidence:async()=>mode==='stale-document'?[catalog]:mode==='stale-catalog'?[doc]:mode==='foreign'?[]:sources,
  generate:async(stage,_instruction,data:any)=>{
   calls.push(stage);
   if(stage==='extraction'){
    assert.ok(data.evidence.every((e:any)=>e.id!=='configured-services'));if(mode==='stale-catalog')assert.equal(data.question,question);else{assert.equal(data.authorityScope,'document_only');assert.doesNotMatch(data.question,new RegExp(business.service.name));}
    let text=business.source;
    if(mode==='equivalence')text=`${business.service.name} replaces an inspection.`;
    if(mode==='wrong-service')text='Other Service costs 999 EUR and lasts 90 minutes.';
    if(mode==='omitted-condition')text=business.source.replace(' if one is available','');
    if(mode==='negation')text=business.source.replace('does not automatically replace','automatically replaces');
    if(mode==='quantifier')text=business.source.replace('initial orientation only','all technical guidance').replace('preliminary setup guidance only','all technical guidance');
    return{text:JSON.stringify({units:[{facetIds:['f1'],subject:mode==='equivalence'?business.service.name:business.subject,predicate:'documented purpose and limits',value:text,modality:'descriptive',negation:true,scope:'documentary offering only',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:mode==='wrong-citation'?'configured-services':doc.id,exactQuote:mode==='wrong-quote'?'Invented source quotation.':doc.text}]}]})};
   }
   if(stage==='verification'){
    captured=data;if(mode==='contradiction')assert.ok(data.evidence.some((e:any)=>e.id==='e2'&&e.text===opposite.text),'The verifier receives both contradictory sources');assert.equal(data.question,question);assert.equal(data.facets[0].obligations[0].description,question);assert.ok(data.evidence.every((e:any)=>e.businessId===business.id));
    return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:u.evidenceRefs.some((r:any)=>r.evidenceId===catalog.id)?mode==='unknown-catalog'?'UNKNOWN':'ENTAILED':['omitted-condition','negation','quantifier','wrong-service'].includes(mode)?'UNKNOWN':mode==='contradiction'?'CONTRADICTED':'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:!['incomplete','stale-catalog'].includes(mode),incompletenessReason:mode==='incomplete'?'MISSING_CONDITION':mode==='stale-catalog'?'MISSING_RELEVANT_FACT':'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:['incomplete','stale-catalog'].includes(mode)?'UNRESOLVED':'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
   }
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 const final=mode==='changed-document'?pruneAnswerManifest(manifest,[{...doc,version:'v2'},catalog]):mode==='changed-catalog'?pruneAnswerManifest(manifest,[doc,{...catalog,version:'v2'}]):manifest;
 assert.notEqual(final.outcomes[0].status,'VERIFIED','Atomic entailment never establishes an undocumented service relationship');
 if(['foreign','unknown-catalog','stale-catalog','changed-catalog'].includes(mode))assert.ok(final.units.every(u=>u.evidenceRefs.every(r=>r.evidenceId!==catalog.id)));
 else assert.ok(final.units.some(u=>u.evidenceRefs.some(r=>r.evidenceId===catalog.id)),'Independent verified catalog survives documentary rejection');
 if(['normal','incomplete','unknown-catalog','stale-catalog','changed-catalog'].includes(mode))assert.ok(final.units.some(u=>u.text===doc.text));
 else assert.ok(final.units.every(u=>u.evidenceRefs.every(r=>r.evidenceId!==doc.id)),'Unsupported, stale or invalidly cited documentary facts cannot publish');
 if(mode==='normal'){assert.ok(captured);assert.deepEqual(calls,['extraction','verification']);assert.equal(final.presentationPath,'direct_verified_units');assert.equal(final.presentationFallback,false);assert.match(final.text,/cannot confirm whether the document's information applies/);}
});
