import assert from 'node:assert/strict';
import test from 'node:test';
import { ordinaryEntailmentPunctuationKey as key, ordinaryEntailmentIsReusable as reusable } from './claim-entailment-reuse';

const request = { atomicClaim: 'You can cancel through chat.', candidateQuote: 'You can cancel through chat',
  claimKind: 'OTHER', citedEvidence: [{ source: 'structured_business_config', quote: '"automaticCancellationEnabled": true' }],
  evidenceCorpus: 'unchanged corpus', businessId: 77, businessInfoTurnId: 'same turn', customerMessage: 'Cancellation policy?',
  language: 'en', serviceName: null, workflow: 'business_information' };

test('only the quote full stop varies; the complete atomic claim remains exact', () => {
  assert.ok(key(request)); assert.equal(key(request), key({ ...request, candidateQuote: request.atomicClaim }));
  for (const quote of ['You can cancel via chat.', 'You can cancel through chat!', ' You can cancel through chat', 'You can cancel through chat.\n'])
    assert.equal(key({ ...request, candidateQuote: quote }), undefined);
});

test('tenant, turn, source ownership/revision, context and scope changes cannot share a receipt', () => {
  for (const change of [
    { businessId: 88 }, { businessInfoTurnId: 'another turn' }, { evidenceCorpus: 'changed revision' },
    { customerMessage: 'Mandatory cancellation notice?' }, { language: 'sv' }, { serviceName: 'another service' },
    { workflow: 'another workflow' }, { claimKind: 'NEGATIVE_ABSENCE' },
    { citedEvidence: [{ source: 'retrieved_knowledge', quote: request.citedEvidence[0].quote }] },
    { citedEvidence: [{ source: 'structured_business_config', quote: '"automaticCancellationEnabled": false' }] },
  ]) assert.notEqual(key(request), key({ ...request, ...change }));
});

test('requested-fact, coverage, adjudication, numbers and identifiers are never aliases', () => {
  for (const change of [{ requireRequestedFact: true }, { cancellationCoverage: true }, { adjudication: true }])
    assert.equal(key({ ...request, ...change }), undefined);
  for (const atomicClaim of ['Cancel at least 24 hours before.', 'Cancel at least ۲۴ hours before.', 'The host is example.com.',
    'Contact a@host.', 'Use https://host.', 'Identifier.', 'One sentence. Another sentence.'])
    assert.equal(key({ ...request, atomicClaim, candidateQuote: atomicClaim }), undefined);
});

test('a qualifier cannot be stripped and a negative fact remains a separate request identity', () => {
  const atomicClaim = 'You can cancel only after staff approval.';
  assert.ok(key({ ...request, atomicClaim, candidateQuote: atomicClaim.slice(0, -1) }));
  assert.equal(key({ ...request, atomicClaim, candidateQuote: 'You can cancel.' }), undefined);
  assert.notEqual(key(request), key({ ...request, atomicClaim: 'You cannot cancel through chat.', candidateQuote: 'You cannot cancel through chat' }));
});

test('only a successful parsed ordinary verdict can supply a receipt', () => {
  assert.equal(reusable({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }, 'OTHER'), true);
  assert.equal(reusable({ relation: 'ENTAILED', claimKind: 'NEGATIVE_ABSENCE', explicitAbsenceEvidence: true }, 'NEGATIVE_ABSENCE'), true);
  for (const relation of ['UNKNOWN', 'NEUTRAL', 'NOT_APPLICABLE', 'CONTRADICTED'])
    assert.equal(reusable({ relation, claimKind: 'OTHER', explicitAbsenceEvidence: true }, 'OTHER'), false);
  for (const result of [null, undefined, { relation: 'ENTAILED', claimKind: 'OTHER' },
    { relation: 'ENTAILED', claimKind: 'invalid', explicitAbsenceEvidence: true }]) assert.equal(reusable(result, 'OTHER'), false);
  assert.equal(reusable({ relation: 'ENTAILED', claimKind: 'NEGATIVE_ABSENCE', explicitAbsenceEvidence: false }, 'OTHER'), false);
  assert.equal(reusable({ relation: 'ENTAILED', claimKind: 'OTHER', explicitAbsenceEvidence: false }, 'NEGATIVE_ABSENCE'), false);
});
