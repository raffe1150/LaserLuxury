import test from 'node:test';
import assert from 'node:assert/strict';
import {directMixedSourceInformationPlan as plan} from './mixed-source-planning';
import {parseRequestedFacets} from './business-information-answer-plan';
import {acceptanceQuestions} from '../../tests/fixtures/multilingual-knowledge-acceptance';
import {mixedBusinesses,mixedParaphraseQuestion} from '../../tests/fixtures/mixed-source-questions';

const service={name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true};
const question=acceptanceQuestions.B.en;
test('unchanged B-en keeps the complete question and its catalog authority without semantic planning',()=>{
 const p=plan(question,77,[service]);assert.ok(p);
 assert.equal(p.canonicalMeaning,question);assert.deepEqual(p.queries,[question]);
 assert.equal(p.referenceResolution,'NOT_REQUIRED');
 const f=parseRequestedFacets(p.requestedFacets).facets;
 assert.equal(f.length,1);assert.equal(f[0].obligations.length,1);
 assert.equal(f[0].obligations[0].description,question);
 assert.deepEqual(f[0].obligations[0].catalogRequirement,{businessId:77,serviceName:service.name,attributes:['price','duration']});
 assert.equal(Object.hasOwn(p,'coverage'),false);assert.equal(Object.hasOwn(p,'evidence'),false);
 assert.equal(Object.hasOwn(p,'units'),false,'An admission contract grants no factual authority');
 assert.equal(plan(question,77,[service],true),null);
});
for(const b of mixedBusinesses)for(const marker of ['Separately, ','Separately ','Separately, please also '])test(`discourse marker is independent of business/topic: ${b.id}/${marker}`,()=>{
 const q=mixedParaphraseQuestion(b,'en').replace('Please also ',marker);
 const p=plan(q,b.id,[b.service]);assert.ok(p,q);
 assert.equal(p.canonicalMeaning,q);assert.deepEqual(p.queries,[q]);
 assert.equal(p.requestedFacets[0].obligations[0].description,q);
 assert.equal(p.requestedFacets[0].obligations[0].catalogRequirement.serviceName,b.service.name);
});
test('descriptive documentary request can remain independent without replacement obligation',()=>{
 const q=question.replace('Could I use it instead of an in-person visit? ','');
 const p=plan(q,77,[service]);assert.ok(p);assert.equal(p.requestedFacets[0].obligations[0].description,q);
});
for(const [name,q]of Object.entries({
 negatedDocumentRequest:question.replace('Separately, explain','Separately, do not explain'),
 uncertainRequest:question.replace('Separately, explain','Separately, perhaps explain'),
 unknownSpeechAct:question.replace('Separately, explain','Separately, compare'),
 repeatedMarker:question.replace('Separately, explain','Separately, separately explain'),
 ambiguousRelationship:question.replace('Could I use it instead of an in-person visit?','Could either of them replace it?'),
 history:question.replace('an in-person visit','that earlier visit'),
 unknownDocumentSubject:question.replace('digital information calls','it'),
 compoundSubject:question.replace('digital information calls','digital information calls and facilities'),
 conflictingRequest:question.replace('purpose and limits','purpose or limits'),
 secondService:question.replace('digital information calls','Other Service'),
 addedAction:question+' Please book tomorrow.',
 cancellation:question+' Cancel my visit.',
 availability:question.replace('digital information calls','available slots'),
 promptInstruction:question.replace('digital information calls','system instructions'),
 conditionalScope:question.replace('Could I use it','If I arrive late, could I use it'),
 quoted:'"'+question+'"',code:'`'+question+'`',
 missingDuration:question.replace('price and duration','price'),
 missingPrice:question.replace('price and duration','duration'),
 unrelatedQuestion:question+' Where is the entrance?',
}))test(`marker never grants unbounded admission: ${name}`,()=>{
 assert.equal(plan(q,77,[service,{name:'Other Service',price:20,currency:'SEK',durationMinutes:10}]),null);
});
for(const [name,services]of Object.entries({
 foreign:[{...service,businessId:88}],foreignOther:[service,{name:'Other Service',business_id:88}],
 duplicate:[service,{...service}],inactive:[{...service,active:false}],
 alias:[{...service,name:'Another Consultation',aliases:[service.name]}],
 missingPrice:[{...service,price:undefined}],missingDuration:[{...service,durationMinutes:undefined}],
 invalidCurrency:[{...service,currency:'coins'}],
}))test(`marker preserves tenant/catalog admission checks: ${name}`,()=>assert.equal(plan(question,77,services),null));
