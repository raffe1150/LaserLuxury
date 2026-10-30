import test from 'node:test';
import assert from 'node:assert/strict';
import {arrivalPolicyQuestions} from '../../tests/fixtures/arrival-policy-questions';
import {isArrivalInformationQuestion} from './information-request-contract';
import {isBusinessInformationQuestion,isExplicitBusinessActionRequest} from './business-information';
import {detectNormalizedIntent} from './booking-intelligence';

for(const [language,questions] of Object.entries(arrivalPolicyQuestions))for(const question of questions)
test(`arrival policy speech act ${language}: ${question}`,()=>{
  assert.equal(isArrivalInformationQuestion(question),true);
  assert.equal(isExplicitBusinessActionRequest(question),false);
  assert.equal(isBusinessInformationQuestion(question),true);
  assert.equal(detectNormalizedIntent(question),'general_question');
});
for(const q of [
  'Please cancel my appointment because I will be 20 minutes late.',
  'Avboka min bokning eftersom jag blir sen.',
  'Bitte verschieben Sie meinen Termin, weil ich zu spät komme.',
  'Por favor cancelar mi cita porque llegaré tarde.',
  'لطفاً نوبت من را لغو کنید چون دیر می‌رسم.',
  'أريد إلغاء موعدي لأنني سأتأخر.',
])test(`actual appointment instruction retains action authority: ${q}`,()=>{
  assert.equal(isExplicitBusinessActionRequest(q),true);assert.equal(isBusinessInformationQuestion(q),false);
});
for(const q of [
  'Check whether my appointment has already been cancelled.',
  'Kontrollera om min bokning redan är avbokad.',
  'Prüfen Sie, ob mein Termin bereits storniert wurde.',
  'Verifica si mi cita ya está cancelada.',
  'استعلام کنید آیا نوبت من قبلاً لغو شده است؟',
  'تحقق هل تم إلغاء موعدي بالفعل؟',
  'Can you book an appointment 20 minutes after my other appointment?',
  'How much is the fee if I arrive late to my appointment?',
])test(`relative-policy extension cannot authorize records, scheduling or fee rules: ${q}`,()=>
  assert.equal(isArrivalInformationQuestion(q),false));
