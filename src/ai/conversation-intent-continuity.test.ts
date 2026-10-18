import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasConversationReference, referenceClarificationReply, splitMixedBusinessRequest } from './conversation-intent-continuity';

const examples = [
 ['en','Please book Video Consultation for Tuesday.','Can I reserve a spot there in advance?'],
 ['sv','Boka en Video Consultation på tisdag.','Kan jag reservera en plats där i förväg?'],
 ['de','Bitte buchen Sie Video Consultation für Dienstag.','Kann ich dort im Voraus reservieren?'],
 ['es','Quiero reservar Video Consultation para el martes.','¿Puedo reservar una plaza allí?'],
 ['fa','Video Consultation را رزرو کنید.','آیا می‌توانم آنجا جا رزرو کنم؟'],
 ['ar','احجز Video Consultation يوم الثلاثاء.','هل يمكنني حجز ذلك هناك؟'],
] as const;
for (const [language, action, information] of examples) test(`${language}: independent action and reference question retain their literal clauses`, () => {
 assert.deepEqual(splitMixedBusinessRequest(`${action} ${information}`), { action, information });
 assert.equal(hasConversationReference(information),true);
 assert.match(referenceClarificationReply(language), /[?؟]/u);
 assert.doesNotMatch(referenceClarificationReply(language,true),/[?؟]/u);
});
for (const text of [
 'Please book Video Consultation and Golden video for Tuesday.',
 'Please book Video Consultation. Please cancel my appointment. What are the policies?',
 'What is the policy? I do not want to book anything.',
]) test(`uncertain or multiple action clauses are not rewritten: ${text}`, () => assert.equal(splitMixedBusinessRequest(text),null));

test('abbreviated service label stays whole in the action span', () => {
 assert.deepEqual(splitMixedBusinessRequest('Please book Dr. Video Consultation. What is your policy?'),
  {action:'Please book Dr. Video Consultation.',information:'What is your policy?'});
});

for (const action of ['Please book Video Consultation between Tuesday and Friday.', 'Please book Wash and Color for Tuesday.'])
 test(`conjunction inside an action span remains literal: ${action}`, () => {
  assert.deepEqual(splitMixedBusinessRequest(`${action} Can I reserve it there?`), {action,information:'Can I reserve it there?'});
 });
