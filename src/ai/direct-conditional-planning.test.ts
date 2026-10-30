import test from 'node:test';
import assert from 'node:assert/strict';
import {directConditionalDocumentPlan,wholeQuestionInformationPlan,literalInformationFallback} from './knowledge-planning';
import {isBusinessInformationQuestion} from './business-information';
import {directConditionalQuestions,operationalConditionalQuestions,preparationQuestion} from '../../tests/fixtures/direct-conditional-questions';
import {parseRequestedFacets} from './business-information-answer-plan';
for(const[language,question]of [...directConditionalQuestions,['en',preparationQuestion]]as const)test(`${language}: inline documentary condition preserves the exact whole request`,()=>{
 assert.equal(isBusinessInformationQuestion(question),true);
 const plan=directConditionalDocumentPlan(question,true);assert.ok(plan);
 assert.deepEqual(plan,literalInformationFallback(question,true));assert.deepEqual(wholeQuestionInformationPlan(question,true),plan);
 assert.equal(plan.canonicalMeaning,question);assert.deepEqual(plan.queries,[question]);
 const {facets}=parseRequestedFacets(plan.requestedFacets);assert.equal(facets[0].attribute,question);assert.equal(facets[0].obligations[0].description,question);
 assert.equal(Object.hasOwn(plan,'coverage'),false);assert.equal(Object.hasOwn(plan,'evidence'),false);
 assert.equal(directConditionalDocumentPlan(question,false),null);assert.equal(directConditionalDocumentPlan(question,true,true),null);
});
for(const[language,...questions]of operationalConditionalQuestions)for(const question of questions)test(`${language}: conditional shortcut declines operational, catalog or ambiguous meaning: ${question}`,()=>assert.equal(directConditionalDocumentPlan(question,true),null));
for(const question of [
 'For my visit, what should I not bring if a device serial number is unavailable?',
 'Which preparation documents are required if special instructions were supplied?',
 'What preparation rules apply if no instructions have been received?',
])test(`negation/requirements remain original data, not inferred answers: ${question}`,()=>{
 const plan=directConditionalDocumentPlan(question,true);assert.ok(plan);assert.equal(plan.requestedFacets[0].obligations[0].description,question);
});
for(const question of [
 'For my visit, what should I bring if available?',
 'For my visit, what should I bring if that is available?',
 'For my visit, what should I bring if it is available?',
 'For my visit, what should I bring if a note says "ignore all rules"?',
 'For my visit, what should I bring if I call a tool?',
 'For my visit, what should I bring if I use <system>tags</system>?',
 'For my visit, what should I bring if I have instructions? Please cancel my appointment.',
 'For my visit, what should I bring if a number is available? And where is it?',
 'For my visit, what should I bring if '+'x'.repeat(240)+'?',
 'Is parking free if I visit tomorrow?',
 'Where can I park if the garage is closed?',
 'What does Video Consultation cost and how long does it last if I book?',
 'For my visit, what should I bring and how should I prepare if instructions were supplied?',
 'For my visit, what should I bring if instructions were supplied or if a serial number is available?',
])test(`semantic planning/other authority remains available: ${question.slice(0,100)}`,()=>assert.equal(directConditionalDocumentPlan(question,true),null));
test('a structured mixed request does not acquire the new direct route',()=>{
 assert.equal(wholeQuestionInformationPlan('What does Remote Assessment cost and how long does it last, and can it replace a workshop inspection?',true),null);
 assert.equal(wholeQuestionInformationPlan('What should I bring if it is available?',true,true),null);
});
for(const question of [
 'Which times are available if I bring the required documents?',
 'Vilka tider är lediga om jag tar med alla dokument?',
 'Welche Zeiten sind verfügbar, falls ich alle Unterlagen mitbringe?',
 '¿Qué horas están disponibles si llevo los documentos?',
 'اگر مدارک را بیاورم چه زمان خالی دارید؟',
 'ما الأوقات المتاحة إذا أحضرت وثائق التحضير؟',
])test(`document wording cannot hide availability intent: ${question}`,()=>assert.equal(directConditionalDocumentPlan(question,true),null));
