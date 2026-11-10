import assert from 'node:assert/strict';
import test from 'node:test';
import { isBusinessInformationQuestion } from './business-information';
import { detectNormalizedIntent, normalizeConversationText } from './booking-intelligence';
import { documentKnowledgeTopicsEligible } from './knowledge-planning';

const arabicArrivalQuestions = [
 'إذا كانت هذه زيارتي الأولى، قبل كم دقيقة من موعدي يُنصح أن أصل؟',
 'أنا جاي للاستوديو لأول مرة، تنصحوني أوصل قبل موعد الحجز بكم دقيقة؟',
 'بالنسبة للزبائن الجدد في AdMotion Studio، ما الوقت الموصى به للحضور قبل بدء الموعد؟',
];
for(const [i,question] of arabicArrivalQuestions.entries())test(`Arabic arrival admission ${i+1}`,()=>{
 const text=normalizeConversationText(question);
 assert.equal(isBusinessInformationQuestion(text),true);
 assert.equal(documentKnowledgeTopicsEligible(text),true);
 assert.equal(detectNormalizedIntent(text),'general_question');
});
for(const [name,operation,intent] of [
 ['creation','أريد حجز موعد جديد غدًا.','new_booking'],
 ['reschedule','أريد تغيير موعدي إلى الغد.','reschedule'],
 ['cancel','أريد إلغاء موعدي.','cancellation'],
 ['status','هل لدي موعد محجوز؟','booking_lookup'],
 ['lookup','تحقق من موعدي.','booking_lookup'],
] as const)for(const [index,recommendation] of ['',...arabicArrivalQuestions].entries())test(`Arabic ${name} precedence / arrival ${index}`,()=>{
 const text=normalizeConversationText(operation+' '+recommendation);
 assert.equal(isBusinessInformationQuestion(text),false);
 assert.equal(detectNormalizedIntent(text),intent);
});
for(const question of ['ما الوقت المتاح لحجز موعد؟','تنصحوني أحجز موعد بكرة؟'])
 test(`unrelated scheduling/policy is not newly admitted as arrival: ${question}`,()=>{
  assert.notEqual(detectNormalizedIntent(normalizeConversationText(question)),'general_question');
 });

test('read-only cancellation policies remain information, including mixed arrival questions',()=>{
 for(const policy of ['ما الوقت الموصى به لإلغاء الموعد؟', 'ما هي سياسة إلغاء الموعد؟'])
  for(const arrival of ['',...arabicArrivalQuestions]){
   const text=normalizeConversationText(`${policy} ${arrival}`);
   assert.equal(isBusinessInformationQuestion(text),true);
   assert.equal(detectNormalizedIntent(text),'general_question');
  }
});

// Cover the creation grammar already supported by the routing engine, including
// both arrival wordings and an information-first phrase in the mixed turn.
for (const desire of ['أريد', 'اريد', 'أود', 'اود'])
 for (const verb of ['حجز', 'أحجز', 'احجز', 'أن أحجز', 'أن احجز'])
  test(`supported Arabic creation retains mixed-turn precedence: ${desire}/${verb}`,()=>{
   const operation = `${desire} ${verb} موعد جديد غدًا.`;
   assert.equal(detectNormalizedIntent(operation),'new_booking');
   for(const arrival of [...arabicArrivalQuestions, 'قبل الحجز، كم دقيقة يُنصح أن أصل قبل موعدي؟']) {
    const text = normalizeConversationText(`${operation} ${arrival}`);
    assert.equal(isBusinessInformationQuestion(text),false);
    assert.equal(detectNormalizedIntent(text),'new_booking');
   }
  });

test('exact mixed-turn blocker and undiacritized form retain creation',()=>{
 for(const text of [
  'أود حجز موعد جديد غدًا. تنصحوني أوصل قبل موعد الحجز بكم دقيقة؟',
  'اود حجز موعد غدا. تنصحوني أوصل قبل موعد الحجز بكم دقيقة؟',
 ])assert.equal(detectNormalizedIntent(text),'new_booking');
});

test('arrival references alone confer no creation authority',()=>{
 for(const text of ['تنصحوني أوصل قبل موعد الحجز بكم دقيقة؟', 'عندي موعد، كم دقيقة قبل الموعد؟',
  'لا أريد حجز موعد. تنصحوني أوصل قبل موعد الحجز بكم دقيقة؟',
  'لا اريد حجز موعد. تنصحوني أوصل قبل موعد الحجز بكم دقيقة؟'])
  assert.notEqual(detectNormalizedIntent(text),'new_booking');
});
