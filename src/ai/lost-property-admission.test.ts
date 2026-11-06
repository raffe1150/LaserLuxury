import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizeConversationText} from './booking-intelligence';
import {businessInformationTopics,isBusinessInformationQuestion,isBusinessAddressQuestion,isExplicitBusinessActionRequest} from './business-information';
import {documentKnowledgeTopicsEligible} from './knowledge-planning';

export const liveLostPropertyQuestion='اگر وسیله‌ای رو در محل شما جا بذارم، تا چند روز نگهش می‌دارید و برای تحویل گرفتنش باید چه اطلاعاتی بدم؟';
const policies=[liveLostPropertyQuestion,
 'اگر چیزی در محل شما جا بگذارم، تا چه مدت نگهش می‌دارید؟',
 'در محل شما اشیای جامانده چند روز نگهداری می‌شوند؟',
 'If I leave an item at your premises, how long do you keep it and what must I provide to collect it?',
 'Om jag glömmer något hos er, hur länge förvaras det och vad behöver jag uppge för att hämta det?',
 'Wenn ich einen Gegenstand bei Ihnen vergesse, wie lange bewahren Sie ihn auf und welche Angaben brauche ich zur Abholung?',
 'Si olvido un objeto en sus instalaciones, ¿cuánto tiempo lo guardan y qué información necesito para recogerlo?'];
for(const q of policies)test('documentary policy admission: '+q,()=>{
 assert.equal(isBusinessInformationQuestion(q),true);assert.equal(documentKnowledgeTopicsEligible(q),true);
 assert.equal(isExplicitBusinessActionRequest(q),false);
});
for(const q of ['محل شما','محلتان کجاست؟','محل شما کجاست؟','محل دقیق شما کجاس؟','مکان شما کجاست؟','محل شما؟','لطفاً محل شما را بفرستید',
 'آدرس محل شما چیست؟','آدرس شما کجاست؟','Where is your location?','What is your address?',
 'Vad är er adress?','Wo befindet sich Ihr Studio?','¿Cuál es su dirección?',
 'اگر چیزی در محل شما جا بگذارم، آدرس شما چیست؟'])test('preserve address route: '+q,()=>{
 assert.equal(isBusinessAddressQuestion(q),true);assert.ok(businessInformationTopics(q).includes('contact'));
 assert.equal(documentKnowledgeTopicsEligible(q),false);
});
for(const q of ['How can I contact you?','What are your opening hours?',
 'Wie sind Ihre Öffnungszeiten?',
 'ساعات کاری شما چیست؟','ساعات کار محل شما چیست؟','شماره تلفن محل شما چیست؟','راه ارتباط با محل شما چیست؟','شماره تلفن شما چیست؟','شماره تلفن و آدرس شما چیست؟'])test('preserve structured contact/hours route: '+q,()=>{
 assert.equal(documentKnowledgeTopicsEligible(q),false);
});
for(const q of ['Please book an appointment.','Please cancel my appointment.','Please reschedule my appointment.',
 'Jag vill boka en tid.','Jag vill avboka min tid.','Bitte verschieben Sie meinen Termin.',
 'Quiero cancelar mi cita.','لطفاً نوبتم را لغو کنید.'])test('preserve action intent: '+q,()=>{
 assert.equal(isExplicitBusinessActionRequest(q),true);
});
for(const q of ['در محل شما','هوا در محل شما','سلام'])test('no unrelated information admission: '+q,()=>{
 assert.equal(isBusinessInformationQuestion(q),false);
});

// Preserve baseline outcomes outside this fix, including existing coarse-classifier
// limitations. These are parity controls, not claims of structured-route coverage.
for(const q of ['What is your phone number?','Vad är ert telefonnummer?','¿Cuál es su teléfono?','Tell me a joke.'])
 test('unchanged baseline eligibility: '+q,()=>assert.equal(documentKnowledgeTopicsEligible(q),true));
test('unchanged baseline Persian rescheduling classifier',()=>assert.equal(isExplicitBusinessActionRequest('لطفاً وقت من را تغییر دهید.'),false));

test('adapter normalization matches the observed production question fingerprint',()=>{
 const normalized=normalizeConversationText(liveLostPropertyQuestion);
 assert.equal(createHash('sha256').update(normalized).digest('hex').slice(0,12),'7c0de454d6f3');
 assert.equal(documentKnowledgeTopicsEligible(normalized),true);
});

const firstVisit = 'من می‌خوام اولین بار بیام استودیو. باید زودتر برسم؟ تأییدیه رزرو رو همراهم داشته باشم؟ آدرس دقیق رو از کجا می‌تونم بگیرم؟';
test('first-visit address-delivery question retains the whole documentary request',()=>{
 for(const question of [firstVisit, normalizeConversationText(firstVisit), firstVisit.replace('از کجا می‌تونم بگیرم','چگونه دریافت کنم')]) {
  assert.equal(isBusinessInformationQuestion(question),true);
  assert.equal(isExplicitBusinessActionRequest(question),false);
  assert.equal(documentKnowledgeTopicsEligible(question),true);
 }
});
test('address-delivery admission does not consume other structured contact requests',()=>{
 for(const suffix of [' آدرس شما چیست؟',' شماره تلفن شما چیست؟',' ایمیل شما چیست؟',' ساعات کاری شما چیست؟'])
  assert.equal(documentKnowledgeTopicsEligible(firstVisit+suffix),false);
 assert.equal(documentKnowledgeTopicsEligible(firstVisit.replace('آدرس دقیق رو از کجا می‌تونم بگیرم؟','آدرس دقیق شما چیست؟')),false);
});
