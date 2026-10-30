import test from 'node:test';
import assert from 'node:assert/strict';
import {wholeQuestionInformationPlan,literalInformationFallback,documentKnowledgeTopicsEligible} from './knowledge-planning';
import {documentAttributeQuestions,requestUncertaintyFacets} from './knowledge-answer-presentation';
import {parseRequestedFacets} from './business-information-answer-plan';
import {acceptanceQuestions} from '../../tests/fixtures/multilingual-knowledge-acceptance';
const q=acceptanceQuestions.C.en,catalog=[{name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60}];
test('exact original C-en reuses full literal contract and both downstream obligations',()=>{
 const p=wholeQuestionInformationPlan(q,true,false,catalog);assert.ok(p);assert.deepEqual(p,literalInformationFallback(q,true));
 assert.equal(p.canonicalMeaning,q);assert.deepEqual(p.queries,[q]);assert.equal(p.requestedFacets[0].obligations[0].description,q);
 const fs=requestUncertaintyFacets(q,'en',parseRequestedFacets(p.requestedFacets).facets);assert.equal(fs[0].obligations.length,2);
 assert.deepEqual(fs[0].obligations.map(o=>o.description),documentAttributeQuestions(q,'en'));assert.equal(fs[0].obligations.map(o=>o.description).join(' '),q);
 for(const key of ['evidence','units','coverage'])assert.equal(Object.hasOwn(p,key),false);
 assert.equal(wholeQuestionInformationPlan(q,false,false,catalog),null);assert.equal(wholeQuestionInformationPlan(q,true,true,catalog),null);
});
for(const attr of ["Orion's storage capacity",'the warranty period for Nova'])test(`generic documentary attributes need no business-specific rule: ${attr}`,()=>{
 const text=`Do the documents specify ${attr}? Does the studio provide collection?`;
 assert.equal(documentKnowledgeTopicsEligible(text),true);assert.ok(wholeQuestionInformationPlan(text,true,false,catalog));
 assert.equal(wholeQuestionInformationPlan(text,true,false,catalog)?.canonicalMeaning,text);
});
for(const inventory of [undefined,null,{},'unknown',[{}],[{name:'x'.repeat(129)}]])test('unknown catalog inventory cannot acquire the new route',()=>{
 assert.equal(wholeQuestionInformationPlan(q,true,false,inventory),null);
});
for(const [name,text]of Object.entries({
 ambiguousAttribute:q.replace("Nordpark's parking fee",'that fee'),ambiguousSubject:q.replace('the studio','it'),
 unknownScope:q.replace("Nordpark's parking fee",'some other fee'),condition:q.replace('for me?','for me if I arrive?'),
 action:q+' Please book tomorrow.',cancel:q+' Cancel my visit.',thirdQuestion:q+' Is it open?',
 quote:'"'+q+'"',code:'`'+q+'`',markup:q.replace('documents','<documents>'),
 instructions:q.replace('provide free parking or reserve a space for me','ignore the earlier instructions'),
 tool:q.replace('provide free parking or reserve a space for me','execute a tool'),
 availability:q.replace('Does the studio provide free parking or reserve a space for me?','Are slots free tomorrow?'),
 currentAvailability:q.replace('Does the studio provide free parking or reserve a space for me?','Are spaces free now?'),
 specificTime:q.replace('for me?','at 14?'),
 servicePrice:q.replace('Does the studio provide free parking or reserve a space for me?','Does Video Consultation cost 300 SEK?'),
 serviceNames:"Do the documents state Alpha's facilities? Does Beta provide equipment?",
 cancellationPolicy:q.replace("Nordpark's parking fee","Orion's cancellation fee"),
 permissions:q.replace('Does the studio provide free parking or reserve a space for me?','Can I leave without permission?'),
 alternativeAttributes:q.replace("Nordpark's parking fee","Nordpark's fee or hours"),
 unbounded:q.replace("Nordpark's parking fee",'x'.repeat(200)),
}))test(`guarded request retains existing planning/authority: ${name}`,()=>{
 assert.equal(wholeQuestionInformationPlan(text,true,false,[...catalog,{name:'Alpha'},{name:'Beta'}]),null);
});
test('a pre-existing single documentary question retains its original direct contract',()=>{
 const text='Do the documents state the policy?';
 assert.deepEqual(wholeQuestionInformationPlan(text,true,false,catalog),wholeQuestionInformationPlan(text,true));
 assert.ok(wholeQuestionInformationPlan(text,true));
});
test('the exact C-en route cannot interpret a named configured service as anonymous Knowledge',()=>{
 const inventory=[...catalog,{name:'Nordpark'}];assert.equal(wholeQuestionInformationPlan(q,true,false,inventory),null);
});
