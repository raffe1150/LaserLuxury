import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseAnswerUnits,
  parseRequestedFacets,
} from './business-information-answer-plan';
import { assessNumericalConstraint } from './numerical-constraints';

const source =
  'Förstagångsbesökare rekommenderas att komma 10 minuter före sin bokade tid.';

const evidence = [{
  id: 'e1',
  businessId: 7,
  sourceId: 'document-1',
  chunkId: 'chunk-1',
  version: 'v1',
  text: source,
}];

const facets = parseRequestedFacets([{
  subject: 'arrival',
  attribute: 'recommended arrival time',
  questionType: 'description',
  obligations: [{
    description: 'What is the recommended arrival time for first-time visitors?',
    questionType: 'description',
  }],
}]).facets;

const cases = [
  {
    name: 'correct Persian honorific arrival',
    claim: 'بهتر است ۱۰ دقیقه زودتر تشریف بیاورید.',
    expected: true,
  },
  {
    name: 'existing correct Persian arrival',
    claim: 'بهتر است ۱۰ دقیقه زودتر برسید.',
    expected: true,
  },
  {
    name: 'contradictory temporal direction',
    claim: 'بهتر است ۱۰ دقیقه بعد از وقت رزرو برسید.',
    expected: false,
  },
  {
    name: 'incorrect arrival quantity',
    claim: 'بهتر است ۲۰ دقیقه زودتر تشریف بیاورید.',
    expected: false,
  },
  {
    name: 'different temporal direction with honorific',
    claim: 'بهتر است ۱۰ دقیقه بعد تشریف بیاورید.',
    expected: false,
  },
];

for (const { name, claim, expected } of cases) {
  test(`Persian arrival regression: ${name}`, () => {
    const numeric = assessNumericalConstraint(claim, claim, [source]);
    assert.equal(numeric.safe, expected, numeric.reason);

    const parsed = parseAnswerUnits({
      oversized: false,
      units: [{
        facetIds: ['f1'],
        subject: 'arrival',
        predicate: 'recommended arrival time',
        value: '10 minutes before appointment',
        modality: 'recommended',
        negation: false,
        scope: 'first-time visitors',
        qualifiers: [],
        language: 'fa',
        text: claim,
        evidenceRefs: [{ evidenceId: 'e1', exactQuote: source }],
      }],
    }, facets, evidence, 'fa', () => {},
    'quotation', {
      businessId: 7,
      question: 'What is the recommended arrival time for first-time visitors?',
      language: 'fa',
    });

    assert.equal(parsed.units.some(unit => unit.text === claim), expected);
  });
}
