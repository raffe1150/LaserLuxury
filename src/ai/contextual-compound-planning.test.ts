/** P0 2026-11-17: a context sentence followed by coordinated questions keeps one
 * obligation per question (exact user spans) and the context on every facet. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextualCompoundInformationPlan, wholeQuestionInformationPlan } from './knowledge-planning';
import { isBusinessInformationQuestion } from './business-information';
import { isArrivalLeadTimeQuestion } from './information-request-contract';
import { parseRequestedFacets } from './business-information-answer-plan';

const shape = (q: string) => wholeQuestionInformationPlan(q, isBusinessInformationQuestion(q), false, [])?.requestedFacets
  .map((f: any) => [f.questionType, f.subject, f.obligations.map((o: any) => [o.questionType, o.description])]);
const CASES: [string, string, string, string][] = [
  ['من برای اولین بار می‌خوام بیام. چند دقیقه قبل از وقت رزرو باید اونجا باشم و آیا لازم هست چیزی با خودم بیارم؟',
    'من برای اولین بار می‌خوام بیام.', 'چند دقیقه قبل از وقت رزرو باید اونجا باشم', 'آیا لازم هست چیزی با خودم بیارم؟'],
  ['سآتي لأول مرة. كم دقيقة قبل موعدي يجب أن أصل، وهل أحتاج إلى إحضار أي شيء معي؟', 'سآتي لأول مرة.', 'كم دقيقة قبل موعدي يجب أن أصل', 'هل أحتاج إلى إحضار أي شيء معي؟'],
  ['Jag kommer för första gången. Hur många minuter före min bokade tid ska jag komma, och behöver jag ta med mig något?',
    'Jag kommer för första gången.', 'Hur många minuter före min bokade tid ska jag komma', 'behöver jag ta med mig något?'],
  ["I'm coming for the first time. How many minutes before my appointment should I arrive, and do I need to bring anything with me?",
    "I'm coming for the first time.", 'How many minutes before my appointment should I arrive', 'do I need to bring anything with me?'],
  ['Ich komme zum ersten Mal. Wie viele Minuten vor meinem Termin sollte ich da sein, und muss ich etwas mitbringen?',
    'Ich komme zum ersten Mal.', 'Wie viele Minuten vor meinem Termin sollte ich da sein', 'muss ich etwas mitbringen?'],
  ['Voy a ir por primera vez. ¿Cuántos minutos antes de mi cita debo llegar y necesito llevar algo?',
    'Voy a ir por primera vez.', '¿Cuántos minutos antes de mi cita debo llegar', 'necesito llevar algo?'],
];
for (const [q, context, arrival, bring] of CASES) test(`compound with context keeps distinct obligations: ${q}`, () => {
  assert.deepEqual(shape(q), [['description', context, [['description', arrival]]], ['requirement', context, [['requirement', bring]]]]);
  // Contract-valid for the existing native parser (IDs f1/f1.o1, f2/f2.o1).
  const parsed = parseRequestedFacets(wholeQuestionInformationPlan(q, true, false, [])!.requestedFacets);
  assert.deepEqual(parsed.facets.map(f => [f.id, f.obligations.map(o => o.id)]), [['f1', ['f1.o1']], ['f2', ['f2.o1']]]);
});
test('a "can I" second question stays descriptive; separate question marks split too', () => {
  assert.deepEqual(shape("I'm coming for the first time. How many minutes before my appointment should I arrive, and can I bring my booking confirmation?")?.map(f => f[0]), ['description', 'description']);
  assert.deepEqual(shape('Jag kommer för första gången. Hur tidigt ska jag komma före min bokade tid? Måste jag ta med legitimation?')?.map(f => f[0]), ['description', 'requirement']);
});
test('single contextual question keeps the existing whole-question literal container', () => {
  const q = "I'm coming for the first time. How many minutes before my appointment should I arrive?";
  assert.deepEqual(shape(q), [['description', 'customer request', [['description', q]]]]);
});
test('safety: references, actions, oversize and non-question tails are never decomposed', () => {
  for (const q of [
    "I'm coming for the first time. Should I bring it there, and do I need to pay?",                // external reference
    "I'm coming for the first time. Can you book me at 10, and do I need to bring anything?",       // booking action
    "I'm coming for the first time. How early should I arrive, and do I need ID, and can I park, and is there wifi, and may I eat?", // > 4
    "I'm coming for the first time. How early should I arrive and do I need ID? Thanks.",           // trailing sentence
  ]) assert.equal(contextualCompoundInformationPlan(q, isBusinessInformationQuestion(q)), null, q);
});
test('specialised literal plans keep their reviewed contracts', () => {
  const receipt = 'لا تلغ موعدي. هل تنصحون بإحضار إيصال الدفع عند الزيارة؟';
  assert.equal(contextualCompoundInformationPlan(receipt, true), null);
});
test('arrival lead-time speech act (routing): information, never booking or cancellation', () => {
  for (const q of ['چند دقیقه قبل از وقت رزرو باید اونجا باشم؟', 'كم دقيقة قبل موعدي يجب أن أصل؟', 'How many minutes before my appointment should I arrive?',
    'Hur tidigt före min bokade tid ska jag komma?', 'Wie früh vor meinem Termin sollte ich da sein?', '¿Con cuánta antelación a mi cita debo llegar?'])
    { assert.ok(isArrivalLeadTimeQuestion(q), q); assert.ok(isBusinessInformationQuestion(q), q); }
  for (const q of ['How many minutes before my appointment can I cancel?', 'چند دقیقه قبل از نوبت می‌توانم لغو کنم؟', 'Book me 10 minutes before noon tomorrow',
    'Wie viele Minuten vor dem Termin kann ich stornieren?'])
    assert.equal(isArrivalLeadTimeQuestion(q), false, q);
});
