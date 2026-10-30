import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {mixedBusinesses,mixedQuestion,mixedParaphraseQuestion,independentMixedQuestion,documentaryRequest,replacementRequest} from '../../tests/fixtures/mixed-source-questions';
import {serviceRelationshipUnresolved,independentServiceProposal} from './source-aware-service-proposal';
import {buildEvidenceFirstAnswer,parseRequestedFacets,InformationBudget,pruneAnswerManifest,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';
import {directMixedSourceInformationPlan} from './mixed-source-planning';
import {directServiceQuestions,serviceQuestionLanguages} from '../../tests/fixtures/direct-service-questions';
const captures:any[]=[];
after(()=>{if(process.env.ODINLINK_APPLICABILITY_RESULTS)writeFileSync(process.env.ODINLINK_APPLICABILITY_RESULTS,JSON.stringify({providerRequests:0,kind:'Deliberately incorrect complete coverage with scripted valid independent facts; not actual model judgments',captures},null,2),{flag:'wx'});});
for(const b of mixedBusinesses)test(`applicability fault-injection ${b.id}: instead-of cannot establish completeness`,async()=>{
 const target=b.id===88?'workshop':'bicycle';
 const question=`What does ${b.service.name} cost and how long does it last? Could I use it instead of a ${target} inspection? Please explain the documented purpose and limits of ${b.subject}.`;
 const original=directMixedSourceInformationPlan(mixedQuestion(b,'en'),b.id,[b.service])!;
 const facets=parseRequestedFacets(original.requestedFacets.map(f=>({...f,attribute:question,obligations:f.obligations.map(o=>({...o,description:question}))}))).facets;
 const doc:Evidence={id:'e1',businessId:b.id,sourceId:'guide',chunkId:'c1',version:'v1',text:b.source};
 const catalog=configuredServiceEvidence(b.id,[b.service])!,sources=[doc,catalog],events:any[]=[],inputs:any[]=[];
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:sources,authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,diagnostic:e=>events.push(e),
 generate:async(stage,_instruction,data:any)=>{inputs.push({stage,data});
  if(stage==='extraction')return{text:JSON.stringify({units:b.source.match(/[^.]+\./gu)!.slice(0,3).map((text,i)=>({facetIds:['f1'],subject:b.subject,predicate:['purpose','replacement limitation','assessment limitation'][i],value:text.trim(),modality:'descriptive',negation:i>0,scope:'documentary offering only',qualifiers:[],language:'en',text:text.trim(),evidenceRefs:[{evidenceId:'e1',exactQuote:text.trim()}]}))})};
  if(stage==='verification'){assert.equal(data.question,question);assert.equal(data.facets[0].obligations[0].description,question);return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};}
  return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 captures.push({businessId:b.id,question,inputs,events,manifest});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.equal(manifest.outcomes[0].materialFactsComplete,false);assert.equal(manifest.outcomes[0].obligations[0].status,'UNRESOLVED');
 assert.equal(manifest.units.length,4);assert.ok(manifest.sourceScopeNotice?.includes(b.service.name));assert.ok(manifest.text.includes(`${b.service.price} ${b.service.currency}`));
 for(const sentence of b.source.match(/[^.]+\./gu)!.slice(0,3))assert.ok(manifest.text.includes(sentence.trim()));
 for(const u of manifest.units)for(const ref of u.evidenceRefs){const e=sources.find(e=>e.id===ref.evidenceId)!;assert.ok(e.text.includes(ref.exactQuote));assert.equal(e.version,ref.version);}
 assert.notEqual(pruneAnswerManifest(manifest,[doc]).outcomes[0].status,'VERIFIED');
});

const name='Remote Assessment',p={name,evidenceId:'configured-services'};
const positive:Record<string,string[]>={
 en:[`Can ${name} replace an inspection?`,`Could I use ${name} instead of an inspection?`,`Could I use it instead of an inspection?`,`Can ${name} substitute for an inspection?`,`Does ${name} make an inspection unnecessary?`],
 sv:[`Kan ${name} ersätta en inspektion?`,`Kan jag använda ${name} i stället för en inspektion?`,`Kan jag använda det istället för en inspektion?`],
 de:[`Kann ${name} eine Inspektion ersetzen?`,`Kann ich ${name} anstelle einer Inspektion nutzen?`,`Kann ich mir mit ${name} den Werkstattbesuch sparen?`],
 es:[`¿Puede ${name} reemplazar una inspección?`,`¿Sirve ${name} para sustituir una inspección?`,`¿Puedo usar ${name} en lugar de una inspección?`],
 fa:[`آیا ${name} جایگزین بازرسی می‌شود؟`,`آیا با ${name} دیگر نیازی به بازرسی ندارم؟`,`آیا می‌توانم ${name} را به جای بازرسی استفاده کنم؟`],
 ar:[`هل يمكن أن تحل ${name} محل الفحص؟`,`هل تغنيني ${name} عن الفحص؟`,`هل يمكنني استخدام ${name} بدلاً من الفحص؟`],
};
const negative:Record<string,string[]>={
 en:[`What is the price of ${name}?`,`How long does ${name} last?`,`Is the price of ${name} the same this month?`,`Explain the purpose and limits of photo briefings.`,`What is the replacement part price?`,`Can I use cash instead of a card to pay for ${name}?`],
 sv:[`Vad kostar ${name}?`,`Hur länge varar ${name}?`,`Har ${name} samma pris?`,`Beskriv syftet och begränsningarna för photo briefings.`],
 de:[`Was kostet ${name}?`,`Wie lange dauert ${name}?`,`Hat ${name} den gleichen Preis?`,`Erläutern Sie den Zweck und die Grenzen von photo briefings.`],
 es:[`¿Cuánto cuesta ${name}?`,`¿Cuánto dura ${name}?`,`¿Tiene ${name} el mismo precio?`,`Explica el propósito y los límites de photo briefings.`],
 fa:[`قیمت ${name} چقدر است؟`,`مدت ${name} چقدر است؟`,`آیا قیمت ${name} یکسان است؟`,`هدف و محدودیت‌های photo briefings را توضیح دهید.`],
 ar:[`ما سعر ${name}؟`,`ما مدة ${name}؟`,`هل ${name} بنفس السعر؟`,`اشرح الغرض والحدود الموثقة لـ photo briefings.`],
};
for(const [language,questions]of Object.entries(positive))for(const question of questions)test(`applicability positive ${language}: ${question}`,()=>assert.equal(serviceRelationshipUnresolved(p,question,[],[]),true));
for(const [language,questions]of Object.entries(negative))for(const question of questions)test(`non-substitution negative ${language}: ${question}`,()=>assert.equal(serviceRelationshipUnresolved(p,question,[],[]),false));

for(const b of mixedBusinesses)test(`verified relationship witness ${b.id} remains a publication dependency`,async()=>{
 const question=`What does ${b.service.name} cost and how long does it last, and can it replace an inspection?`;
 const facets=parseRequestedFacets([{subject:'service',attribute:question,questionType:'description'}]).facets;
 const catalog=configuredServiceEvidence(b.id,[b.service])!;
 const doc:Evidence={id:'e1',businessId:b.id,sourceId:'explicit-service-policy',chunkId:'c1',version:'v1',text:`${b.service.name} can replace an inspection.`};
 const manifest=await buildEvidenceFirstAnswer({question,language:'en',facets,evidence:[doc,catalog],authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,current:async()=>true,
 generate:async(stage,_instruction,data:any)=>{
  if(stage==='extraction')return{text:JSON.stringify({units:[{facetIds:['f1'],subject:b.service.name,predicate:'replacement',value:'inspection',scope:'explicit configured service relationship',modality:'descriptive',negation:false,qualifiers:[],language:'en',text:doc.text,evidenceRefs:[{evidenceId:doc.id,exactQuote:doc.text}]}]})};
  if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:['u1'],obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:['u1']}]}]})};
  return{text:JSON.stringify({unitIds:data.units.map((u:any)=>u.id),prefix:'none',addition:false})};
 }});
 assert.equal(manifest.outcomes[0].status,'VERIFIED','Genuine independently verified service applicability may be complete');
 const revoked=pruneAnswerManifest(manifest,[catalog]);
 assert.equal(revoked.outcomes[0].status,'PARTIAL','A complete model verdict must not conceal loss of the relationship witness');
 assert.equal(revoked.outcomes[0].obligations[0].status,'UNRESOLVED');assert.equal(revoked.units.length,1);
 assert.equal(pruneAnswerManifest(revoked,[doc,catalog]).text,revoked.text,'Revoked support cannot resurrect itself');
});


for(const b of mixedBusinesses)for(const language of serviceQuestionLanguages)test(`obligation parity ${b.id}/${language}: catalog, replacement and documentary scope remain separate`,()=>{
 const question=mixedQuestion(b,language),paraphrase=mixedParaphraseQuestion(b,language),independent=independentMixedQuestion(b,language);
 const plan=directMixedSourceInformationPlan(question,b.id,[b.service])!;assert.ok(plan);const facets=parseRequestedFacets(plan.requestedFacets).facets;
 assert.equal(plan.canonicalMeaning,question);assert.equal(facets[0].obligations[0].description,question);
 assert.deepEqual(facets[0].obligations[0].catalogRequirement,{businessId:b.id,serviceName:b.service.name,attributes:['price','duration']});
 assert.ok(question.includes(documentaryRequest[language](b.subject)));assert.ok(question.includes(replacementRequest[language](b.id===99)));
 const catalog=configuredServiceEvidence(b.id,[b.service])!;
 assert.ok(independentServiceProposal(question,language,facets,[catalog]),'Both catalog attributes remain explicitly requested');
 assert.equal(serviceRelationshipUnresolved({name:b.service.name,evidenceId:catalog.id},question,[],[catalog]),true);
 assert.equal(serviceRelationshipUnresolved({name:b.service.name,evidenceId:catalog.id},paraphrase,[],[catalog]),true);
 assert.equal(serviceRelationshipUnresolved({name:b.service.name,evidenceId:catalog.id},independent,[],[catalog]),false);
 assert.ok(independent.includes(directServiceQuestions[language](b.service.name)[2]));
});
for(const label of ['Remote Assessment (Plus)','Review+','بررسی فنی'])test(`exact service-label projection escapes ${label}`,()=>{
 assert.equal(serviceRelationshipUnresolved({name:label,evidenceId:'configured-services'},`Could I use ${label} instead of an inspection?`,[],[]),true);
 assert.equal(serviceRelationshipUnresolved({name:label,evidenceId:'configured-services'},`What is the price of ${label}?`,[],[]),false);
});
for(const b of mixedBusinesses)for(const language of serviceQuestionLanguages)for(const action of ['booking','foreign-service','unresolved-reference']as const)test(`bounded relationship route rejects ${b.id}/${language}/${action}`,()=>{
 const q=mixedParaphraseQuestion(b,language);
 const mutated=action==='booking'?q+' Please book tomorrow.':action==='foreign-service'?q.replace(b.subject,'Other Service'):q.replace(b.subject,'it');
 assert.equal(directMixedSourceInformationPlan(mutated,b.id,[b.service,{name:'Other Service',price:1,currency:'EUR',durationMinutes:1}]),null);
});
test('ordinary payment alternative is not service substitution admission',()=>{
 const b=mixedBusinesses[0],question=`${directServiceQuestions.en(b.service.name)[2]} Can I use cash instead of a card? ${documentaryRequest.en(b.subject)}`;
 assert.equal(directMixedSourceInformationPlan(question,b.id,[b.service]),null);
 assert.equal(serviceRelationshipUnresolved({name:b.service.name,evidenceId:'configured-services'},question,[],[]),false);
});
