import test from 'node:test';
import assert from 'node:assert/strict';
import {directServiceInformationPlan as plan} from './direct-service-planning';
import {directServiceQuestions,serviceQuestionLanguages} from '../../tests/fixtures/direct-service-questions';
import {parseRequestedFacets} from './business-information-answer-plan';
const service={name:'Video Consultation',price:300,currency:'SEK',durationMinutes:60,active:true};
for(const language of serviceQuestionLanguages)for(const[index,q]of directServiceQuestions[language](service.name).entries())test(`${language}/${index}: complete exact-label catalog request`,()=>{
 const p=plan(q,77,[service]);assert.ok(p);assert.equal(p.canonicalMeaning,q);assert.deepEqual(p.queries,[q]);assert.equal(parseRequestedFacets(p.requestedFacets).facets[0].obligations[0].description,q);
 assert.equal(Object.hasOwn(p,'evidence'),false);assert.equal(Object.hasOwn(p,'coverage'),false);
 assert.equal(plan(q,77,[service],true),null);
});
for(const q of [
 'What is the configured price of Video Consultation if I am a student?',
 'What is not included in the price of Video Consultation?',
 'Does Video Consultation not cost 300 SEK?',
 'What does Video Consultation cost and can it replace an in-person visit?',
 'What is the price of Video Consultation and Remote Assessment?',
 'What is the price of Remote Session?',
 'What is the price of Consultation?',
 'What is the price of Video ConsultationPlus?',
 'What is the price of Video Consultation? Please book tomorrow.',
 'Please cancel Video Consultation and tell me the price.',
 'Which Video Consultation times are available?',
 'What is the price of Video Consultation, and where is the studio?',
 'What is the price of Video Consultation or another service?',
 '"What is the price of Video Consultation?"',
 '`What is the price of Video Consultation?`',
 'Vad kostar Video Consultation om jag är student?',
 'Vad kostar inte Video Consultation?',
 'Boka Video Consultation och ange priset.',
 'Was kostet Video Consultation, wenn ich Student bin?',
 'Was kostet Video Consultation nicht?',
 'Buche Video Consultation morgen.',
 '¿Cuánto cuesta Video Consultation si soy estudiante?',
 '¿Cuánto no cuesta Video Consultation?',
 'Reserva Video Consultation y dime el precio.',
 'اگر دانشجو باشم قیمت Video Consultation چقدر است؟',
 'آیا قیمت Video Consultation نیست؟',
 'Video Consultation را رزرو کن و قیمت را بگو.',
 'ما سعر Video Consultation إذا كنت طالبا؟',
 'ما ليس سعر Video Consultation؟',
 'احجز Video Consultation وأخبرني بسعره.',
])test(`non-catalog-only request stays on existing route: ${q}`,()=>assert.equal(plan(q,77,[service,{name:'Remote Assessment',price:145,currency:'EUR',durationMinutes:25}]),null));
for(const [label,catalog]of Object.entries({duplicate:[service,{...service}],foreign:[{...service,business_id:88}],mixedOwnership:[service,{name:'Other',businessId:88}],inactive:[{...service,active:false}],aliasOnly:[{...service,name:'Other',aliases:['Video Consultation']}],empty:[],noPrice:[{...service,price:undefined}],negativePrice:[{...service,price:-1}],badCurrency:[{...service,currency:'coins'}],noDuration:[{...service,durationMinutes:undefined}],zeroDuration:[{...service,durationMinutes:0}]}))test(`no guessed identity/attributes: ${label}`,()=>assert.equal(plan(directServiceQuestions.en(service.name)[2],77,catalog),null));
test('only the requested attribute must be present; no unrequested value invented',()=>{
 assert.ok(plan(directServiceQuestions.en(service.name)[0],77,[{name:service.name,price:0,currency:'SEK'}]));
 assert.ok(plan(directServiceQuestions.en(service.name)[1],77,[{name:service.name,duration_minutes:60}]));
 assert.equal(plan(directServiceQuestions.en(service.name)[2],77,[{name:service.name,price:300,currency:'SEK'}]),null);
 for(const id of [0,-1,NaN,88.5])assert.equal(plan(directServiceQuestions.en(service.name)[2],id,[service]),null);
});
