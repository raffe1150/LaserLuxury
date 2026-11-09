import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasConversationReference, hasExternalConversationReference, referenceClarificationReply, splitMixedBusinessRequest, prepareLiteralTurn } from './conversation-intent-continuity';
import { literalInformationFallback } from './knowledge-planning';
import { parseRequestedFacets } from './business-information-answer-plan';
import { firstVisitCases, firstVisitQuestion } from '../../tests/fixtures/first-visit-planning-recovery';

for (const [, question] of firstVisitCases) test(`self-contained first-visit recovery retains the full request: ${question}`, () => {
 assert.equal(hasExternalConversationReference(question), false);
 const plan = literalInformationFallback(question, true);
 assert.ok(plan);
 const { facets } = parseRequestedFacets(plan.requestedFacets);
 assert.equal(facets.length, 1);
 assert.equal(facets[0].obligations[0].description, question);
 assert.deepEqual(plan.queries, [question]);
 assert.equal(literalInformationFallback(question, true, true), null, 'An independently unresolved reference still blocks recovery');
});

// Exercise clause grammar, not a first-visit phrase exception. No source or
// booking identity is inferred from these explicitly named in-question events.
for (const question of [
 firstVisitQuestion.replace("it's", 'it’s'),
 'How early should I arrive for my consultation when it is a follow-up session?',
 'How early should I arrive for my appointment if it is a group session?',
 'Hur tidigt bör jag komma till mitt möte om det är ett uppföljningsmöte?',
]) test(`an inline condition can refer to an explicitly introduced event: ${question}`, () => {
 assert.equal(hasExternalConversationReference(question), false);
 assert.ok(literalInformationFallback(question, true));
});

for (const question of [
 'Does it apply to me?', 'What about that one?', 'Is it the same as before?',
 "How early should I arrive if it's available?", 'How early should I arrive if it is cancelled?',
 'How early should I arrive for my appointment if that one is cancelled?',
 'How early should I arrive for my appointment if it is there?',
 'How early should I arrive for my appointment if it is my first visit? Does that rule apply?',
 'How early should I arrive for my appointment if it is my first visit and they allow that?',
 'How early should I arrive for "my appointment" if it is available?',
 'What does "it is my first visit" mean for that one?',
]) test(`recovery cannot infer an external or quoted referent: ${question}`, () => {
 assert.equal(hasExternalConversationReference(question), true);
 assert.equal(literalInformationFallback(question, true), null);
});

test('reporting complementizers and an explicitly named chat need no historical antecedent', () => {
 assert.equal(hasExternalConversationReference('I heard that cancellations are always free and that I must cancel at least 24 hours in advance. Can you confirm both rules, and tell me whether I can cancel through this chat?'), false);
 assert.equal(hasExternalConversationReference('Can I cancel through this chat?'), false);
 for (const text of ['Can I cancel that?', 'I heard that it is free. Can I reserve it there?', 'Can I cancel through this chat and use it there?', 'I heard that rule. Does it apply?'])
  assert.equal(hasExternalConversationReference(text), true, text);
});

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

for(const [language,action,information] of examples)for(const informationFirst of [false,true])
 test(`${language}: literal preparation freezes source order and executes the action first (${informationFirst})`,()=>{
  const text=informationFirst?`${information} ${action}`:`${action} ${information}`;
  const prepared=prepareLiteralTurn(text);
  assert.equal(prepared.kind,'mixed');
  assert.deepEqual(prepared.clauses.map(c=>c.text),informationFirst?[information,action]:[action,information]);
  assert.deepEqual(prepared.executionOrder.map(i=>prepared.clauses[i].text),[action,information]);
  assert.ok(Object.isFrozen(prepared)&&Object.isFrozen(prepared.clauses)&&Object.isFrozen(prepared.executionOrder));
  assert.ok(prepared.clauses.every(Object.isFrozen));
  assert.throws(()=>{(prepared.clauses[0] as any).text='changed target';},TypeError);
 });
for(const text of ['Could you tell me where I can park my car?', 'Please cancel my appointment.',
 'Please reschedule my appointment.', 'Please book Wash and Color for Tuesday.',
 'Please book Video Consultation. Please cancel my appointment. What are the policies?'])
 test(`unsplit preparation preserves the complete literal request: ${text}`,()=>{
  const prepared=prepareLiteralTurn(text);
  assert.equal(prepared.kind,'single');
  assert.deepEqual(prepared.clauses,[{kind:'unclassified',text}]);
  assert.deepEqual(prepared.executionOrder,[0]);
 });
