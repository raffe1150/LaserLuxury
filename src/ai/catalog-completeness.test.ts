import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildEvidenceFirstAnswer,parseRequestedFacets,pruneAnswerManifest,InformationBudget,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';
import {directMixedSourceInformationPlan} from './mixed-source-planning';
import {directServiceInformationPlan} from './direct-service-planning';
import {mixedBusinesses,mixedQuestion,documentaryRequest} from '../../tests/fixtures/mixed-source-questions';
import {directServiceQuestions} from '../../tests/fixtures/direct-service-questions';

const saved=JSON.parse(readFileSync(new URL('../../docs/validation/shared-core-2026-10-22/mixed-source-planning/known-coverage-dependency.json',import.meta.url),'utf8'));
const verdict=(units:any[],ids=units.map(u=>u.id))=>({decisions:units.map(u=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:ids,obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:ids}]}]});
for(const b of mixedBusinesses)test(`unchanged original false-complete witness ${b.id} must remain partial`,async()=>{
 const c=saved.results.find((c:any)=>c.businessId===b.id),doc:Evidence={id:'e1',businessId:b.id,sourceId:'guide',chunkId:'c1',version:'v1',text:b.source};
 const catalog=configuredServiceEvidence(b.id,[b.service])!;
 const manifest=await buildEvidenceFirstAnswer({question:c.question,language:'en',facets:c.captured[0].input.facets,evidence:[doc,catalog],authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,revalidateEvidence:async()=>[doc],
  generate:async(stage,_instruction,data:any)=>{
   const prior=c.captured.find((p:any)=>p.stage===stage);if(prior)assert.deepEqual(data,prior.input,'Exact historical question, facets, sources and proposed units remain unchanged');
   if(stage==='extraction')return{text:JSON.stringify({units:[{facetIds:['f1'],subject:b.subject,predicate:'documented purpose and limits',value:b.source,scope:'documentary offering only',modality:'descriptive',negation:true,qualifiers:[],language:'en',text:b.source,evidenceRefs:[{evidenceId:'e1',exactQuote:b.source}]}]})};
   if(stage==='verification')return{text:JSON.stringify(verdict(data.units))};
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');assert.ok(manifest.text.includes(doc.text));
 assert.ok(manifest.sourceScopeNotice?.includes(b.service.name));assert.doesNotMatch(manifest.text,new RegExp(`${b.service.price} ${b.service.currency}`));
});

type Business=typeof mixedBusinesses[number];
async function run(b:Business,mode='normal',relationship=true){
 const question=relationship?mixedQuestion(b,'en'):`${directServiceQuestions.en(b.service.name)[2]} ${documentaryRequest.en(b.subject)}`;
 const plan=directMixedSourceInformationPlan(question,b.id,[b.service])!;assert.ok(plan);
 const facets=parseRequestedFacets(plan.requestedFacets).facets;
 const extra=mode==='explicit-relationship'?` ${b.service.name} cannot replace a ${b.id===88?'workshop':'bicycle'} inspection.`:'';
 const doc:Evidence={id:'e1',sourceId:'guide',chunkId:'c1',version:'v1',businessId:b.id,text:b.source+extra};
 const services=[{...b.service,...(mode==='missing-price'?{price:undefined}:{}),...(mode==='missing-duration'?{durationMinutes:undefined}:{})}];
 const catalog=configuredServiceEvidence(mode==='foreign-catalog'?999:b.id,services)!;
 const evidence=mode==='missing-catalog'||mode==='deleted-record'?[doc]:[mode==='foreign-document'?{...doc,businessId:999}:doc,catalog];
 let reads=0;const observed:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence,authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,
  revalidateEvidence:async()=>{reads++;return mode==='revoked-initial'||mode==='revoked-after-extraction'&&reads>=2?[doc]:mode==='changed-revision'&&reads>=2?[doc,{...catalog,version:'changed'}]:evidence;},
  generate:async(stage,_instruction,data:any)=>{
   observed.push({stage,data});
   if(stage==='extraction'||stage==='verification')assert.ok(data.facets.every((f:any)=>f.obligations.every((o:any)=>!Object.hasOwn(o,'catalogRequirement'))),'Local request authority cannot contaminate model source context');
   if(stage==='extraction'){
    const quotes=b.source.match(/[^.]+\./gu)!.slice(0,3).map(t=>t.trim());if(extra)quotes.push(extra.trim());
    return{text:JSON.stringify({units:quotes.map((text,i)=>({facetIds:['f1'],subject:i===3?b.service.name:b.subject,predicate:['purpose','replacement limitation','assessment limitation','explicit service relationship'][i],value:text,scope:i===3?'configured service relationship':'documented offering only',modality:'descriptive',negation:i>0,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:'e1',exactQuote:mode==='invalid-quote'&&i===1?'Absent quotation':text}]}))})};
   }
   if(stage==='verification'){
    const documentIds=data.units.filter((u:any)=>u.evidenceRefs.every((r:any)=>r.evidenceId!=='configured-services')).map((u:any)=>u.id);
    const result=verdict(data.units,documentIds);
    for(const d of result.decisions){const u=data.units.find((u:any)=>u.id===d.unitId),isCatalog=u.evidenceRefs.some((r:any)=>r.evidenceId==='configured-services');
     if(isCatalog&&mode==='catalog-unknown')d.relation='UNKNOWN';if(isCatalog&&['catalog-contradicted','all-contradicted'].includes(mode))d.relation='CONTRADICTED';
     if(!isCatalog&&['document-contradicted','all-contradicted'].includes(mode))d.relation='CONTRADICTED';}
    return{text:JSON.stringify(result)};
   }
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 return{manifest,doc,catalog,observed,facets,question};
}

for(const b of mixedBusinesses)for(const mode of ['missing-catalog','deleted-record','missing-price','missing-duration','revoked-initial','revoked-after-extraction','changed-revision','catalog-unknown','catalog-contradicted','foreign-catalog','foreign-document','document-contradicted','invalid-quote']as const)
test(`catalog completeness fails closed ${b.id}/${mode}`,async()=>{
 const {manifest}=await run(b,mode);
 assert.notEqual(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
 if(!['foreign-catalog','foreign-document','document-contradicted','invalid-quote'].includes(mode)){
  assert.equal(manifest.units.length,3,'Supported document atoms survive unavailable catalog requirements');
  assert.doesNotMatch(manifest.text,new RegExp(`${b.service.price} ${b.service.currency}`));
  for(const q of b.source.match(/[^.]+\./gu)!.slice(0,3))assert.ok(manifest.text.includes(q.trim()));
 }
});

for(const b of mixedBusinesses)test(`current catalog witness required even if model coverage omits it ${b.id}`,async()=>{
 const {manifest,doc,catalog}=await run(b,'normal',false);
 assert.equal(manifest.outcomes[0].status,'VERIFIED','Valid fully supported mixed facts remain complete when no relationship was asked');
 assert.ok(manifest.outcomes[0].materialUnitIds.includes('u1'));
 assert.ok(manifest.outcomes[0].obligations[0].unitIds.includes('u1'));
 for(const current of [[doc],[doc,{...catalog,version:'changed'}]]){
  const pruned=pruneAnswerManifest(manifest,current);assert.equal(pruned.outcomes[0].status,'PARTIAL');assert.equal(pruned.outcomes[0].materialFactsComplete,false);
  assert.equal(pruned.outcomes[0].obligations[0].status,'UNRESOLVED');assert.equal(pruned.units.length,3);
  assert.doesNotMatch(pruned.text,new RegExp(`${b.service.price} ${b.service.currency}`));
  assert.equal(pruneAnswerManifest(pruned,[doc,catalog]).outcomes[0].status,'PARTIAL','Later authority cannot resurrect a removed catalog witness');
 }
});
for(const b of mixedBusinesses)test(`an explicit verified service relationship may be complete ${b.id}`,async()=>{
 const {manifest}=await run(b,'explicit-relationship');assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.sourceScopeNotice,undefined);
});

for(const b of mixedBusinesses)for(const scope of ['catalog','knowledge','price-only','duration-only']as const)test(`valid complete answer is preserved ${b.id}/${scope}`,async()=>{
 const catalog=configuredServiceEvidence(b.id,[b.service])!,doc:Evidence={id:'e1',businessId:b.id,sourceId:'guide',chunkId:'c1',version:'v1',text:b.source};
 const question=scope==='catalog'?directServiceQuestions.en(b.service.name)[2]:scope==='knowledge'?`Explain the purpose and limits of ${b.subject}.`:directServiceQuestions.en(b.service.name)[scope==='price-only'?0:1];
 const plan=directServiceInformationPlan(question,b.id,[b.service]);
 const facets=parseRequestedFacets(plan?.requestedFacets||[{subject:b.subject,attribute:question,questionType:'description'}]).facets;
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:scope==='knowledge'?[doc]:[catalog],authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,
  generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction'){
    const text=scope==='knowledge'?b.source:scope==='price-only'?`${b.service.name} costs ${b.service.price} ${b.service.currency}.`:`${b.service.name} lasts ${b.service.durationMinutes} minutes.`;
    const e=scope==='knowledge'?doc:catalog;
    return{text:JSON.stringify({units:[{facetIds:['f1'],subject:scope==='knowledge'?b.subject:b.service.name,predicate:'source fact',value:text,scope:'exact source actor',modality:'descriptive',negation:scope==='knowledge',qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:e.id,exactQuote:e.text}]}]})};
   }
   if(stage==='verification')return{text:JSON.stringify(verdict(data.units))};
   return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
  }});
 assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.outcomes[0].materialFactsComplete,true);
});

test('malformed request constraints fail closed and cannot become source authority',()=>{
 for(const patch of [{businessId:0},{businessId:999},{serviceName:''},{attributes:['price']},{attributes:['duration','price']}]){
  const requirement={businessId:88,serviceName:'Remote Assessment',attributes:['price','duration'],...patch};
  const result=parseRequestedFacets([{subject:'request',attribute:'facts',questionType:'description',obligations:[{description:'facts',questionType:'description',catalogRequirement:requirement}]}]);
  if(patch.businessId===999)assert.equal(result.facets.length,1,'A foreign request constraint may restrict; it never supplies evidence');else assert.equal(result.facets.length,0);
 }
});

for(const b of mixedBusinesses)test(`catalog safeguard preserves a genuine conflict outcome ${b.id}`,async()=>{
 const {manifest}=await run(b,'all-contradicted');
 assert.equal(manifest.units.length,0);assert.equal(manifest.outcomes[0].status,'CONFLICT');assert.equal(manifest.outcomes[0].materialFactsComplete,false);
});

for(const b of mixedBusinesses)test(`unscoped legacy catalog prose keeps its existing complete contract ${b.id}`,async()=>{
 const catalog=configuredServiceEvidence(b.id,[b.service])!,question=directServiceQuestions.en(b.service.name)[2];
 const facets=parseRequestedFacets([{subject:'service',attribute:question,questionType:'description'}]).facets;
 const text=`${b.service.name} lasts ${b.service.durationMinutes} minutes and costs ${b.service.price} ${b.service.currency}.`;
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:[catalog],authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
  generate:async(stage,_instruction,data:any)=>stage==='extraction'?{text:JSON.stringify({units:[{facetIds:['f1'],subject:b.service.name,predicate:'configured duration and price',value:text,scope:'configured service only',modality:'descriptive',negation:false,qualifiers:[],language:'en',text,evidenceRefs:[{evidenceId:catalog.id,exactQuote:catalog.text}]}]})}:stage==='verification'?{text:JSON.stringify(verdict(data.units))}:{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})}});
 assert.equal(manifest.outcomes[0].status,'VERIFIED');assert.equal(manifest.text,text);
});
