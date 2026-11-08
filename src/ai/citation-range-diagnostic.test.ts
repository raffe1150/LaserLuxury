import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerEvidence,
  parseAnswerUnits,
  parseRequestedFacets
} from './business-information-answer-plan';

test('citation diagnostics distinguish missing quote from rejected range', () => {
  const text = 'Entrance at courtyard. Accessible restroom on reception floor.';
  const original = answerEvidence(77, [{
    businessId: 77,
    sourceId: 'accessibility-fixture',
    text,
    metadata: { documentRevision: 'v1' }
  }]);

  const evidence = original.map(e => ({
    ...e,
    citationRanges: [{ start: 0, end: 22 }]
  }));

  const facets = parseRequestedFacets([{
    subject: 'studio',
    attribute: 'accessibility',
    questionType: 'description'
  }]).facets;

  function run(quote: string) {
    const events: any[] = [];
    const result = parseAnswerUnits({
      units: [{
        facetIds: ['f1'],
        subject: 'studio',
        predicate: 'provides',
        value: 'accessible restroom',
        modality: 'descriptive',
        negation: false,
        scope: 'studio facilities',
        qualifiers: [],
        language: 'en',
        text: 'An accessible restroom is available.',
        evidenceRefs: [{
          evidenceId: evidence[0].id,
          exactQuote: quote
        }]
      }]
    }, facets, evidence, 'en', e => events.push(e));

    assert.equal(result.units.length, 0);
    return events;
  }

  const outside = run('Accessible restroom on reception floor.');
  assert.ok(outside.some(e =>
    e.reason === 'INVALID_CITATION' &&
    e.citationSubtype === 'QUOTE_NOT_FOUND' &&
    e.citationRangeRejected === true
  ));

  const missing = run('A completely invented quotation.');
  assert.ok(missing.some(e =>
    e.reason === 'INVALID_CITATION' &&
    e.citationSubtype === 'QUOTE_NOT_FOUND' &&
    e.citationRangeRejected !== true
  ));
});
