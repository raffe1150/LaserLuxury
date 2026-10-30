import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceQuestions,documentaryQuotes,documentaryStatements} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {directMixedSourceInformationPlan as mixed} from './mixed-source-planning';
import {directServiceInformationPlan as service} from './direct-service-planning';
import {wholeQuestionInformationPlan as whole} from './knowledge-planning';
import {parseRequestedFacets,buildEvidenceFirstAnswer,InformationBudget,type Evidence} from './business-information-answer-plan';
import {configuredServiceEvidence} from './configured-service-evidence';
import {serviceScopeUncertainty} from './source-aware-service-proposal';
import {documentAttributeQuestions,requestUncertaintyFacets} from './knowledge-answer-presentation';
import {isBusinessInformationQuestion} from './business-information';

const catalog=[{name:'Video Consultation',businessId:77,price:300,currency:'SEK',durationMinutes:60}];
const normalize=(q:string)=>q.replace(/؟/gu,'?').replace(/‌/gu,' ');
for(const language of ['de','ar'] as const)for(const q of [acceptanceQuestions.B[language],normalize(acceptanceQuestions.B[language])])test(`${language}: original and native-normalized mixed question retain exact catalog and full request`,()=>{
 const p=mixed(q,77,catalog);assert.ok(p);assert.equal(p.canonicalMeaning,q);assert.deepEqual(p.queries,[q]);
 const f=parseRequestedFacets(p.requestedFacets).facets[0];assert.equal(f.attribute,q);assert.equal(f.obligations[0].description,q);
 assert.deepEqual(f.obligations[0].catalogRequirement,{businessId:77,serviceName:'Video Consultation',attributes:['price','duration']});
 assert.equal('evidence' in p,false);assert.equal('coverage' in p,false);assert.equal(mixed(q,77,catalog,true),null);
 for(const c of [[],[...catalog,...catalog],[{...catalog[0],businessId:88}],[{...catalog[0],price:undefined}],[{...catalog[0],durationMinutes:undefined}],[{...catalog[0],active:false}]])assert.equal(mixed(q,77,c),null);
});
for(const name of ['Remote Assessment','Device Orientation'])for(const id of [88,99])test(`new grammar is not business/service specific ${id}/${name}`,()=>{
 const c=[{name,businessId:id,price:145,currency:'EUR',durationMinutes:25}];
 for(const language of ['de','ar'] as const){const q=acceptanceQuestions.B[language].replace('Video Consultation',name);assert.ok(mixed(q,id,c));}
 assert.ok(service(`ما سعر ومدة ${name}؟`,id,c,false,true));
});
const de=acceptanceQuestions.B.de,ar=acceptanceQuestions.B.ar;
for(const q of [
 de.replace('Kann ich sie','Kann ich diese'),de.replace('anstelle eines Besuchs vor Ort','anstelle anderer Leistungen'),
 de.replace('nutzen?','nicht nutzen?'),de.replace('Erklären Sie separat','Buchen Sie separat'),
 de.replace('digitaler Informationsgespräche','dieser Gespräche'),de.replace('digitaler Informationsgespräche','Video Consultation'),
 de+' Buchen Sie einen Termin.',de+' Ist es verfügbar?',de.replace('digitaler Informationsgespräche','Gespräche und Reparaturen'),
 ar.replace('هل يمكن أن تحل','هل لا يمكن أن تحل'),ar.replace('زيارة حضورية','ذلك'),
 ar.replace('اشرح بشكل منفصل','احجز بشكل منفصل'),ar+' احجز موعداً.',ar+' هل الموعد متاح؟',
 ar.replace('للمكالمات المعلوماتية الرقمية','لهذه المكالمات'),ar.replace('للمكالمات المعلوماتية الرقمية','للمكالمات و الإصلاحات'),
 'ما سعر ومدة Video Consultation إذا كنت طالبا؟','ما سعر ومدة Video Consultation؟ احجز موعداً.',
 'ما سعر ومدة Video Consultation و Other Service؟',
 `"${de}"`,'`'+ar+'`',
])test(`ambiguous/operational/expanded mixed wording stays guarded: ${q}`,()=>assert.equal(mixed(q,77,[...catalog,{name:'Other Service',price:20,currency:'EUR',durationMinutes:10}]),null));

for(const q of [acceptanceQuestions.C.fa,normalize(acceptanceQuestions.C.fa)])test('Persian existing two-question contract admitted without translating or losing either obligation',()=>{
 const p=whole(q,isBusinessInformationQuestion(q),false,catalog);assert.ok(p);assert.equal(p.canonicalMeaning,q);assert.deepEqual(p.queries,[q]);
 const fs=requestUncertaintyFacets(q,'fa',parseRequestedFacets(p.requestedFacets).facets);
 assert.deepEqual(fs[0].obligations.map(o=>o.description),documentAttributeQuestions(q,'fa'));assert.equal(fs[0].obligations.length,2);
 assert.equal(whole(q,false,false,catalog),null);assert.equal(whole(q,true,true,catalog),null);assert.equal(whole(q,true,false,undefined),null);
 assert.equal(whole(q,true,false,[{name:'Nordpark'}]),null,'An exact catalog owner cannot be treated as documentary only');
});
for(const q of [
 'آیا اسناد هزینه پارکینگ Nordpark را مشخص می‌کنند؟ یک نوبت رزرو کن.',
 'آیا اسناد هزینه پارکینگ Nordpark را مشخص می‌کنند؟ آیا می‌توانی نوبت من را لغو کنی؟',
 'آیا اسناد هزینه پارکینگ Nordpark را مشخص می‌کنند؟ آیا همان رایگان است؟',
 'آیا اسناد هزینه پارکینگ Nordpark را مشخص می‌کنند؟ آیا استودیو پارکینگ رایگان فراهم می‌کند اگر رزرو کنم؟',
 'آیا اسناد دستور سیستم را مشخص می‌کنند؟ آیا استودیو پارکینگ رایگان دارد؟',
 'آیا اسناد هزینه پارکینگ Nordpark را مشخص می‌کنند؟ آیا استودیو پارکینگ رایگان فراهم می‌کند؟ آیا باز است؟',
 'برای من نوبت رزرو کن.','یک شعر درباره باران بنویس.','آیا هوا فردا بارانی است؟',
])test(`Persian action/ambiguity/non-Knowledge cannot acquire two-question direct admission: ${q}`,()=>assert.equal(whole(q,isBusinessInformationQuestion(q),false,catalog),null));

test('unchanged English and Swedish positive contracts and Spanish checklist retain full wording',()=>{
 for(const language of ['en','sv','es'] as const){const q=acceptanceQuestions.A[language];const p=whole(q,true,false,catalog);assert.ok(p);assert.equal(p.canonicalMeaning,q);}
 assert.ok(mixed(acceptanceQuestions.B.en,77,catalog));assert.ok(whole(acceptanceQuestions.C.en,true,false,catalog));
});

// Deliberately erroneous scripted COMPLETE coverage cannot establish service
// applicability. These are consumer controls, not genuine semantic judgments.
for(const language of ['de','ar'] as const)test(`${language}: new mixed admission cannot turn generic documentary facts into a configured-service relationship`,async()=>{
 const question=acceptanceQuestions.B[language],p=mixed(question,77,catalog);assert.ok(p);
 // One source occurrence, as in the PDF; two propositions cite its two clauses.
 const document:Evidence={id:'e1',businessId:77,sourceId:'current-policy',chunkId:'policy-chunk',version:'v1',text:[...new Set(documentaryQuotes.B)].join('\n')};
 const cat=configuredServiceEvidence(77,catalog)!;
 const diagnostics:unknown[]=[];
 const manifest=await buildEvidenceFirstAnswer({question,language,facets:parseRequestedFacets(p.requestedFacets).facets,evidence:[document,cat],authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),foreground:true,omitModelEvidenceVersions:true,current:async()=>true,
  diagnostic:event=>diagnostics.push(event),
  generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction')return{text:JSON.stringify({units:documentaryStatements.B[language].map((text,i)=>({facetIds:['f1'],subject:'Digital information calls',predicate:`documentary fact ${i}`,value:text,modality:'descriptive',negation:i>1,scope:'documentary calls only',qualifiers:[],language,text,evidenceRefs:[{evidenceId:document.id,exactQuote:documentaryQuotes.B[i]}]}))})};
   assert.equal(stage,'verification');assert.equal(data.question,question);
   return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
  }});
 assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.ok(manifest.text.includes(serviceScopeUncertainty('Video Consultation',language)!));assert.match(manifest.text,/300 SEK/);assert.ok(manifest.units.some(u=>u.evidenceRefs.some(r=>r.evidenceId===document.id)),JSON.stringify(diagnostics));
});
