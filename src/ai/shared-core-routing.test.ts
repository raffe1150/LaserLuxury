import test from 'node:test';
import assert from 'node:assert/strict';
import {businessInformationTopics,isBusinessInformationQuestion,isExplicitBusinessActionRequest} from './business-information';
import {isArrivalInformationQuestion,isConditionalArrivalInformationQuestion} from './information-request-contract';
import {documentKnowledgeTopicsEligible,wholeQuestionInformationPlan,literalInformationFallback} from './knowledge-planning';
import {sharedQuestions} from '../../tests/helpers/shared-core-incident';

// These controls classify requests, never provide business policy or authorize
// a booking. Native mutation authority is also covered by protected suites.
const controls={
 en:['Please book a consultation.','Please cancel my appointment.','What times are available tomorrow?','If I arrive late, what cancellation fee applies?','If I arrive late, what notice deadline applies?','What is your address?','I was late; is my appointment confirmed?'],
 de:['Ich möchte einen Termin buchen.','Bitte meinen Termin stornieren.','Welche Zeiten sind morgen verfügbar?','Wenn ich zu spät zum Besuch komme, welche Gebühr fällt an?','Wenn ich zu spät zum Besuch komme, welche Frist gilt für die Mitteilung?','Was ist Ihre Adresse?','Ich war zu spät; ist mein Termin bestätigt?'],
 sv:['Boka en konsultation.','Avboka min bokning.','Vilka tider är lediga imorgon?','Om jag kommer sent till besöket, vilken avgift gäller?','Om jag kommer sent till besöket, vilket varsel krävs?','Vad är er adress?','Jag kom sent; är min tid bekräftad?'],
 fa:['لطفاً یک نوبت رزرو کنید.','لطفاً نوبت من را لغو کنید.','چه زمان خالی برای فردا دارید؟','اگر برای مراجعه دیر برسم، چه هزینه لغوی دارد؟','اگر برای مراجعه دیر برسم، مهلت اطلاع دادن چیست؟','آدرس شما چیست؟','دیر رسیدم؛ آیا نوبتم تأیید شده است؟'],
 es:['Quiero reservar una consulta.','Quiero cancelar mi cita.','¿Qué horas están disponibles mañana?','Si llego tarde a la visita, ¿qué tarifa de cancelación se aplica?','Si llego tarde a la visita, ¿qué plazo de aviso se aplica?','¿Cuál es su dirección?','Llegué tarde; ¿está confirmada mi cita?'],
 ar:['احجز موعدًا للاستشارة.','ألغ موعدي.','هل لديكم مواعيد متاحة غدًا؟','إذا تأخرت عن زيارتي، فما رسوم الإلغاء؟','إذا تأخرت عن زيارتي، فما مهلة الإشعار المطلوبة؟','ما عنوانكم؟','تأخرت عن زيارتي؛ هل موعدي مؤكد؟'],
}as const;
for(const [language,questions]of Object.entries(sharedQuestions)) {
 test(`${language}: hypothetical late arrival stays policy, not booking status`,()=>assert.equal(isConditionalArrivalInformationQuestion(questions[2]),true));
 for(const[index,question]of questions.entries())test(`${language}/${index}: bounded information contract preserves the full request`,()=>{
  assert.equal(isBusinessInformationQuestion(question),true);
  assert.equal(isExplicitBusinessActionRequest(question),false);
  const plan=wholeQuestionInformationPlan(question,true)||literalInformationFallback(question,true);
  assert.ok(plan);assert.equal(plan.requestedFacets[0].obligations[0].description,question);
 });
 const [book,cancel,availability,fee,notice,contact,status]=controls[language as keyof typeof controls];
 for(const[actionIndex,action]of [book,cancel].entries())test(`${language}: action control ${actionIndex}`,()=>{
  assert.equal(isExplicitBusinessActionRequest(action),true);assert.equal(isBusinessInformationQuestion(action),false);
  assert.equal(literalInformationFallback(action,true),null);
 });
 test(`${language}: availability stays operational`,()=>assert.equal(isBusinessInformationQuestion(availability),false));
 for(const[k,question]of Object.entries({fee,notice}))test(`${language}: ${k} is not an arrival-policy exception`,()=>assert.equal(isArrivalInformationQuestion(question),false));
 test(`${language}: genuine contact retains structured authority`,()=>{
  assert.ok(businessInformationTopics(contact).includes('contact'));
  assert.equal(documentKnowledgeTopicsEligible(contact),false);
 });
 test(`${language}: actual status is not hypothetical policy`,()=>assert.equal(isConditionalArrivalInformationQuestion(status),false));
 test(`${language}: conditional context cannot hide a real status question`,()=>{
  const prefixes={en:'If I arrive late, ',de:'Wenn ich zu spät zum Besuch komme, ',sv:'Om jag kommer sent till besöket, ',fa:'اگر برای مراجعه دیر برسم، ',es:'Si llego tarde a la visita, ',ar:'إذا تأخرت عن زيارتي، '};
  assert.equal(isConditionalArrivalInformationQuestion(prefixes[language as keyof typeof prefixes]+status),false);
 });
}
test('Arabic replacement idiom does not authorize contact routing; genuine location survives',()=>{
 assert.deepEqual(businessInformationTopics(sharedQuestions.ar[1]),['prices']);
 assert.ok(businessInformationTopics('أين محل الاستوديو؟').includes('contact'));
 assert.ok(businessInformationTopics('هل تحل محل الزيارة، وما عنوانكم؟').includes('contact'));
});
test('legitimate semantic planning remains available for self-contained conditional questions',()=>{
 for(const question of [sharedQuestions.es[3],sharedQuestions.ar[2]]){
  assert.equal(wholeQuestionInformationPlan(question,true),null);
  assert.equal(literalInformationFallback(question,true)?.canonicalMeaning,question);
 }
});
