import test from 'node:test';
import assert from 'node:assert/strict';
import { compactKnowledgeVerifierInput } from './knowledge-verifier-input';
import { hasForeignAddressPreposition } from './knowledge-prose-language';
import { literalInformationPlan } from './knowledge-planning';
import { incidentQuestions } from '../../tests/helpers/p0-incident-knowledge';

test('verifier compaction removes only JSON quoting and preserves full evidence and flags', () => {
  const authority = { sources: [{ text: 'No free parking. Only with staff approval.', citation: 'page 2', revision: 17 }],
    competing: [{ text: 'Contact the studio for alternatives.', freshness: null }], contradiction: false };
  const input = { question: 'Is parking free?', authoritativeEvidence: JSON.stringify(authority),
    units: [{ negation: true, modality: 'descriptive', quantity: null }], requestedFacets: [{ condition: 'only with approval' }] };
  const output = compactKnowledgeVerifierInput(input) as any;
  assert.notEqual(output, input); assert.deepEqual(output, { ...input, authoritativeEvidence: authority });
  assert.equal(input.authoritativeEvidence, JSON.stringify(authority));
  assert.ok(JSON.stringify(output).length < JSON.stringify(input).length);
  for (const unexpected of [null, '', { authoritativeEvidence: 'bad JSON' }, { authoritativeEvidence: '[]' }, { authoritativeEvidence: 'null' }])
    assert.equal(compactKnowledgeVerifierInput(unexpected), unexpected);
});

test('bounded incident planning preserves the complete question and grants no answer authority', () => {
  for (const text of Object.values(incidentQuestions)) {
    const plan = literalInformationPlan(text, true); assert.ok(plan);
    assert.equal(plan.canonicalMeaning, text); assert.equal(plan.requestedFacets[0].obligations[0].description, text);
    assert.equal(Object.hasOwn(plan, 'coverage'), false);
    assert.equal(literalInformationPlan(text, true, true), null);
  }
});

test('Arabic comma cannot hide a named garage from literal lexical lookup', () => {
  const question = 'أين يقع مدخل موقف Nordpark، وكم يبعد سيرًا عن الاستوديو؟';
  const plan = literalInformationPlan(question, true); assert.ok(plan);
  assert.equal(plan.canonicalMeaning, question); assert.match(plan.queries[0], /Nordpark\s/u);
  assert.equal(plan.requestedFacets[0].obligations[0].description, question);
});

test('foreign address glue is rejected while proper names and native prepositions survive', () => {
  assert.equal(hasForeignAddressPreposition('The address is på Stjärngatan 14.', 'en'), true);
  for (const [language, prose] of [
    ['en', 'The entrance is at Stjärngatan 14.'], ['sv', 'Entrén ligger på Stjärngatan 14.'],
    ['de', 'Der Eingang befindet sich an der Stjärngatan 14.'], ['es', 'La entrada está en Stjärngatan 14.'],
    ['fa', 'ورودی در Stjärngatan 14 است.'], ['ar', 'المدخل في Stjärngatan 14.'],
    ['en', 'Meet at På Gatan 14.'], ['en', 'Meet at En Gata 14.'],
  ]) assert.equal(hasForeignAddressPreposition(prose, language), false, prose);
});
