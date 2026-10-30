import test from 'node:test';
import assert from 'node:assert/strict';
import {preliminaryAcceptancePlan} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {mixedSourceInformationQuestion,directMixedSourceInformationPlan} from './mixed-source-planning';
import {isCancellationInformationRequested} from './cancellation-policy';
import {documentKnowledgeTopicsEligible} from './knowledge-planning';
import {withoutExplicitParkingFeeTerms} from './information-request-contract';
import {isExplicitBusinessActionRequest} from './business-information';
import {serviceRelationshipUnresolved,serviceScopeUncertainty,independentServiceProposal} from './source-aware-service-proposal';
import {configuredServiceEvidence} from './configured-service-evidence';
import {buildEvidenceFirstAnswer,InformationBudget,parseRequestedFacets,pruneAnswerManifest,type Evidence} from './business-information-answer-plan';
import {directServiceQuestions,serviceQuestionLanguages} from '../../tests/fixtures/direct-service-questions';
const service={name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true},catalog=[service],proposal={name:service.name,evidenceId:'configured-services'};
for(const spec of preliminaryAcceptancePlan.filter(c=>c.family==='B'))test(`mixed admission full prepared ${spec.language}`,()=>{
 assert.equal(mixedSourceInformationQuestion(spec.question,77,catalog),true);assert.equal(isExplicitBusinessActionRequest(spec.question),false);
 const direct=directMixedSourceInformationPlan(spec.question,77,catalog);
 // English was already directly admitted by the accepted B-en repair. The
 // reviewed German/Arabic forms now reuse that same whole-question contract;
 // unrecognized Swedish/Persian/Spanish mixed forms still require planning.
 if(['en','de','ar'].includes(spec.language)){assert.ok(direct);assert.equal(direct.canonicalMeaning,spec.question);assert.equal(direct.requestedFacets[0].obligations[0].description,spec.question);}
 else assert.equal(direct,null);
});
const mixedPositives=[
 '¿Cuál es el precio y la duración de Video Consultation? Explica el propósito documentado de las llamadas.',
 '¿Cuál es el precio y cuánto dura Video Consultation? Explica las restricciones documentadas.',
 'ما سعر ومدة Video Consultation؟ اشرح الغرض الموثق للمكالمات.',
 'ما سعر والمدة المتاحة لخدمة Video Consultation؟ اشرح الحدود الموثقة.',
 'ما سعر Video Consultation و مدة الخدمة؟ اشرح الحدود الموثقة.',
];
for(const q of mixedPositives)test(`coordinated catalog/document request: ${q}`,()=>assert.equal(mixedSourceInformationQuestion(q,77,catalog),true));
const mixedNegatives=[
 'What is the price of the Y connector?',
 'هل وقت الزيارة متاح؟',
 'هل ورد في المستند وصف للخدمة؟',
 '¿Dónde está la entrada y el aparcamiento?',
 'ما عنوان الاستوديو وموقعه؟',
 'Please book Video Consultation and explain the document.',
 'Quiero reservar Video Consultation y saber su precio.',
 'أريد حجز Video Consultation ومعرفة السعر.',
 'I want to cancel Video Consultation and know the fee.',
 'Kan du boka Video Consultation och berätta priset?',
 'Bitte Video Consultation buchen und den Preis nennen.',
 'می‌خواهم Video Consultation رزرو کنم و قیمت را بدانم.',
];
for(const q of mixedNegatives)test(`conjunction is not mixed permission: ${q}`,()=>assert.equal(mixedSourceInformationQuestion(q,77,catalog),false));
for(const language of serviceQuestionLanguages)for(const q of directServiceQuestions[language](service.name))test(`ordinary structured service stays separate ${language}: ${q}`,()=>assert.equal(mixedSourceInformationQuestion(q,77,catalog),false));

const parking:Record<string,string[]>={
 en:['What is the parking fee?','Is there a fee for parking?','What are the car park fees?'],
 sv:['Vad är parkeringsavgiften?','Vad är avgiften för parkering?'],
 de:['Wie hoch ist die Parkgebühr?','Wie hoch ist die Gebühr für das Parken?'],
 fa:['هزینه پارکینگ چقدر است؟','هزینهٔ پارکینگ چقدر است؟'],
 es:['¿Hay cargos por aparcamiento?','¿Cuál es la tarifa del aparcamiento?'],
 ar:['ما رسوم موقف السيارات؟','ما رسوم وقوف السيارات؟'],
};
const cancellation:Record<string,string[]>={
 en:['What is the cancellation fee?','What fee applies if I cancel my appointment?'],
 sv:['Vad är avbokningsavgiften?','Vilka avgifter gäller om jag avbokar?'],
 de:['Wie hoch ist die Stornogebühr?','Welche Gebühr fällt an, wenn ich storniere?'],
 fa:['هزینه لغو نوبت چقدر است؟','اگر نوبت را لغو کنم چه هزینه‌ای دارد؟'],
 es:['¿Cuál es la tarifa de cancelación?','¿Hay cargos si cancelo mi cita?'],
 ar:['ما رسوم إلغاء الموعد؟','ما الرسوم إذا ألغيت الموعد؟'],
};
for(const [language,questions]of Object.entries(parking))for(const q of questions)test(`explicit parking fee is documentary ${language}: ${q}`,()=>{
 assert.equal(isCancellationInformationRequested(q),false);assert.equal(documentKnowledgeTopicsEligible(q),true);
});
for(const [language,questions]of Object.entries(cancellation))for(const q of questions)test(`true cancellation stays protected ${language}: ${q}`,()=>assert.equal(isCancellationInformationRequested(q),true));
for(const language of serviceQuestionLanguages)test(`competing parking and cancellation fees keep cancellation authority ${language}`,()=>assert.equal(isCancellationInformationRequested(`${parking[language][0]} ${cancellation[language][0]}`),true));
for(const spec of preliminaryAcceptancePlan.filter(c=>c.family==='C'))test(`prepared fee question is not cancellation ${spec.language}`,()=>{
 assert.equal(isCancellationInformationRequested(spec.question),false);assert.equal(documentKnowledgeTopicsEligible(spec.question),true);
});
for(const q of ['What fees apply?','Vilka avgifter gäller?','Welche Gebühren gelten?','آیا هزینه‌ای دارد؟','¿Hay cargos?','ما الرسوم؟','What is the parking fee and the booking fee?','What is the price of Video Consultation and the parking fee?'])test(`unrelated or unscoped fees are not erased: ${q}`,()=>{
 if(q.includes('price of'))assert.equal(documentKnowledgeTopicsEligible(q),false);else assert.equal(isCancellationInformationRequested(q),true);
});
test('topic projection is not passed as a replacement question or numerical evidence',()=>{
 const q='Is the parking fee 50 SEK, or is there a 75 SEK booking fee?';const projected=withoutExplicitParkingFeeTerms(q);
 assert.ok(projected.includes('50 SEK'));assert.ok(projected.includes('75 SEK booking fee'));assert.equal(isCancellationInformationRequested(q),true);assert.equal(q,'Is the parking fee 50 SEK, or is there a 75 SEK booking fee?');
});

const fa=preliminaryAcceptancePlan.find(c=>c.id==='B-fa')!.question;
for(const q of [fa,fa.replace('می‌توانم','می توانم'),fa.replace('مراجعه حضوری','بازرسی حضوری')])test(`bounded Persian applicability: ${q}`,()=>assert.equal(serviceRelationshipUnresolved(proposal,q,[],[]),true));
const unrelated=[
 'آیا می‌توانم از آن به جای مراجعه حضوری استفاده کنم؟',
 'قیمت و مدت Other Service چقدر است؟ آیا می‌توانم از آن به جای مراجعه حضوری استفاده کنم؟',
 'قیمت و مدت Video Consultation چقدر است؟ درباره Other Service بگویید. آیا می‌توانم از آن به جای مراجعه حضوری استفاده کنم؟',
 'قیمت و مدت Video Consultation چقدر است؟ آیا می‌توانم از آن هنگام مراجعه حضوری استفاده کنم؟',
 'قیمت و مدت Video Consultation چقدر است؟ آیا می‌توانم از آن به جای پرداخت نقدی استفاده کنم؟',
 'قیمت و مدت Video Consultation چقدر است؟ آیا می‌توانم از این به جای مراجعه حضوری استفاده کنم؟',
 'قیمت و مدت Video Consultation چقدر است؟ «آیا می‌توانم از آن به جای مراجعه حضوری استفاده کنم؟»',
 'قیمت و مدت Video Consultation چقدر است؟ `آیا می‌توانم از آن به جای مراجعه حضوری استفاده کنم؟`',
 'قیمت و مدت Video Consultation چقدر است؟ آیا نمی‌توانم از آن به جای مراجعه حضوری استفاده کنم؟',
 'قیمت و مدت Video Consultation چقدر است؟ آیا می‌توانم از آن به جای مراجعه حضوری استفاده نکنم؟',
];
for(const q of unrelated)test(`Persian antecedent/intent cannot be guessed: ${q}`,()=>assert.equal(serviceRelationshipUnresolved(proposal,q,[],[]),false));

for(const mode of ['false-complete','catalog-revoked','relationship-supported']as const)test(`Persian applicability publication preserves independent source contracts / ${mode}`,async()=>{
 const cat=configuredServiceEvidence(77,catalog)!,text=mode==='relationship-supported'?'Video Consultation جایگزین مراجعه حضوری می‌شود.':'تماس‌های اطلاعاتی دیجیتال فقط برای اطلاعات اولیه هستند.';
 const doc:Evidence={id:'e1',businessId:77,sourceId:'synthetic-policy',chunkId:'c1',version:'v1',text};
 // The genuine positive requests only the two authorities actually supplied.
 // Do not bless complete coverage of omitted documentary-purpose obligations.
 const question=mode==='relationship-supported'?fa.slice(0,fa.indexOf('جداگانه')).trim():fa;
 const facets=parseRequestedFacets([{subject:'customer request',attribute:question,questionType:'description'}]).facets;
 assert.ok(independentServiceProposal(question,'fa',facets,[doc,cat]));
 const manifest=await buildEvidenceFirstAnswer({question,language:'fa',facets,evidence:[doc,cat],authoritativeEvidence:'{}',history:[],businessTone:{},budget:new InformationBudget(),foreground:true,current:async()=>true,
  generate:async(stage,_instruction,data:any)=>{
   if(stage==='extraction')return{text:JSON.stringify({units:[{facetIds:['f1'],subject:mode==='relationship-supported'?'Video Consultation':'Digital information calls',predicate:'documentary policy',value:text,scope:mode==='relationship-supported'?'explicit configured service relationship':'documentary offering only',modality:'descriptive',negation:false,qualifiers:[],language:'fa',text,evidenceRefs:[{evidenceId:'e1',exactQuote:text}]}]})};
   if(stage==='verification')return{text:JSON.stringify({decisions:data.units.map((u:any)=>({unitId:u.id,facetIds:u.facetIds,relation:'ENTAILED',meaningPreserved:true,modalityPreserved:true,qualifiersPreserved:true,relevant:true,languageCorrect:true,negativeAbsence:false,explicitAbsenceEvidence:false})),coverage:[{facetId:'f1',requestAligned:true,materialFactsComplete:true,incompletenessReason:'NONE',materialUnitIds:data.units.map((u:any)=>u.id),obligations:[{obligationId:'f1.o1',status:'COVERED',unitIds:data.units.map((u:any)=>u.id)}]}]})};
   throw Error('Single-facet verified units need no extra composition');
  }});
 assert.equal(manifest.units.length,2);assert.ok(manifest.text.includes(text));assert.ok(manifest.text.includes('300 SEK'));
 if(mode==='relationship-supported')assert.equal(manifest.outcomes[0].status,'VERIFIED');else {assert.equal(manifest.outcomes[0].status,'PARTIAL');assert.ok(manifest.text.includes(serviceScopeUncertainty(service.name,'fa')!));}
 if(mode==='catalog-revoked'){const pruned=pruneAnswerManifest(manifest,[doc]);assert.equal(pruned.outcomes[0].status,'PARTIAL');assert.doesNotMatch(pruned.text,/300 SEK/);}
 if(mode==='relationship-supported')assert.notEqual(pruneAnswerManifest(manifest,[cat]).outcomes[0].status,'VERIFIED','A revoked relationship witness cannot remain complete');
});
