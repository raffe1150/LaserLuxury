/** S2 Tier A verified presentation: pure, offline, zero-model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgePresentationConfig, presentVerifiedManifest, presentationTransition } from './knowledge-presentation';

const unit = (id: string, facet: string, text: string, modality = 'recommended') => ({ id, facetIds: [facet], text, modality, negation: false,
  subject: 's', predicate: 'p', value: 'v', scope: 'x', qualifiers: [], language: 'en', verification: 'ENTAILED', evidenceRefs: [] });
const facet = (id: string, q = 'description') => ({ id, subject: 's', attribute: 'a', questionType: q, obligations: [{ id: id + '.o1', description: 'd', questionType: q }] });
const ARRIVAL = 'For a first visit, we recommend arriving about 10 minutes before your appointment.';
const CONFIRM = 'We recommend bringing your booking confirmation digitally or on paper.';
const NOTICE = 'The full answer to “do I need to bring anything?” cannot be confirmed from the available information.';
function manifest(over: Record<string, unknown> = {}): any {
  const units = [unit('u1', 'f1', ARRIVAL), unit('u2', 'f2', CONFIRM)];
  return { language: 'en', facets: [facet('f1'), facet('f2', 'requirement')], units,
    outcomes: [{ facetId: 'f1', status: 'VERIFIED' }, { facetId: 'f2', status: 'UNAVAILABLE' }],
    presentation: { unitIds: ['u1', 'u2'], prefix: 'none', addition: false },
    sourceLimitations: [{ facetId: 'f2', obligationId: 'f2.o1', text: NOTICE }],
    text: `${ARRIVAL} ${CONFIRM}\n\n${NOTICE}`, presentationFallback: false, presentationPath: 'direct_verified_units', fallbackReason: null, ...over };
}

test('config: default OFF; unknown values OFF; strict tenant allowlist', () => {
  assert.deepEqual([...knowledgePresentationConfig({}).tenants], []);
  assert.equal(knowledgePresentationConfig({}).mode, 'off');
  for (const v of ['on', 'true', 'ACTIVE', '', ' shadow']) assert.equal(knowledgePresentationConfig({ ODINLINK_KNOWLEDGE_PRESENTATION: v }).mode, 'off', v);
  assert.equal(knowledgePresentationConfig({ ODINLINK_KNOWLEDGE_PRESENTATION: 'shadow' }).mode, 'shadow');
  assert.deepEqual([...knowledgePresentationConfig({ ODINLINK_KNOWLEDGE_PRESENTATION_TENANTS: '3, 7,x,0,-1,3.5,12' }).tenants], [3, 7, 12]);
});

test('partial answer: facts and notice regrouped per question; every verified text byte-identical and exactly once', () => {
  const r = presentVerifiedManifest(manifest());
  assert.equal(r.reason, 'APPLIED');
  assert.equal(r.text, `${ARRIVAL}\n\nOn your other question: ${CONFIRM} ${NOTICE}`);
  for (const v of [ARRIVAL, CONFIRM, NOTICE]) assert.equal(r.text!.split(v).length - 1, 1);
});

test('complete two-question answer gets one fact-free transition', () => {
  const r = presentVerifiedManifest(manifest({ sourceLimitations: undefined, outcomes: [{ facetId: 'f1', status: 'VERIFIED' }, { facetId: 'f2', status: 'VERIFIED' }],
    text: `${ARRIVAL} ${CONFIRM}` }));
  assert.equal(r.text, `${ARRIVAL}\n\nOn your other question: ${CONFIRM}`);
});

test('three questions use numbered, localized transitions (Persian digits in fa)', () => {
  assert.equal(presentationTransition('fa', 2, 3), 'سؤال ۳:');
  assert.equal(presentationTransition('ar', 1, 3), 'السؤال ٢:');
  assert.equal(presentationTransition('en', 1, 2), 'On your other question:');
  assert.equal(presentationTransition('en', 0, 2), null);
  assert.equal(presentationTransition('fr', 1, 2), null);
  const third = 'Parking is not free.';
  const m = manifest({ facets: [facet('f1'), facet('f2', 'requirement'), facet('f3')], units: [unit('u1', 'f1', ARRIVAL), unit('u2', 'f2', CONFIRM), unit('u3', 'f3', third, 'descriptive')],
    presentation: { unitIds: ['u1', 'u2', 'u3'], prefix: 'none', addition: false }, text: `${ARRIVAL} ${CONFIRM} ${third}\n\n${NOTICE}`,
    outcomes: [{ facetId: 'f1', status: 'VERIFIED' }, { facetId: 'f2', status: 'UNAVAILABLE' }, { facetId: 'f3', status: 'VERIFIED' }] });
  assert.equal(presentVerifiedManifest(m).text, `${ARRIVAL}\n\nQuestion 2: ${CONFIRM} ${NOTICE}\n\nQuestion 3: ${third}`);
});

test('unsupported shapes keep the canonical text', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['single question', { facets: [facet('f1')], units: [unit('u1', 'f1', ARRIVAL)], presentation: { unitIds: ['u1'], prefix: 'none', addition: false }, sourceLimitations: undefined }, 'SINGLE_QUESTION'],
    ['composer prefix', { presentation: { unitIds: ['u1', 'u2'], prefix: 'greeting', addition: false } }, 'UNSUPPORTED_SHAPE'],
    ['clarification', { clarification: { kind: 'x' } }, 'UNSUPPORTED_SHAPE'],
    ['scope notice', { sourceScopeNotice: 'n' }, 'UNSUPPORTED_SHAPE'],
    ['two notice kinds', { unresolvedRequirements: [{ facetId: 'f2', obligationId: 'f2.o1', text: 'x' }] }, 'UNSUPPORTED_SHAPE'],
    ['natural attachment', { naturalAttachment: {} }, 'UNSUPPORTED_SHAPE'],
    ['unit missing from presentation', { presentation: { unitIds: ['u1'], prefix: 'none', addition: false } }, 'UNSUPPORTED_SHAPE'],
    ['unit with unknown facet', { units: [unit('u1', 'f1', ARRIVAL), unit('u2', 'f9', CONFIRM)] }, 'UNSUPPORTED_SHAPE'],
    ['notice for unknown facet', { sourceLimitations: [{ facetId: 'f9', obligationId: 'f9.o1', text: NOTICE }] }, 'UNSUPPORTED_SHAPE'],
    ['partial without notices', { sourceLimitations: undefined }, 'UNSUPPORTED_SHAPE'],
    ['canonical lacks a verified text', { text: `${ARRIVAL}\n\n${NOTICE}` }, 'CANONICAL_MISMATCH'],
    ['unsupported language', { language: 'fr' }, 'UNSUPPORTED_LANGUAGE'],
    ['five questions', { facets: ['f1', 'f2', 'f3', 'f4', 'f5'].map(id => facet(id)) }, 'UNSUPPORTED_SHAPE'],
  ];
  for (const [name, over, reason] of cases) { const r = presentVerifiedManifest(manifest(over)); assert.equal(r.reason, reason, name); assert.equal(r.text, null, name); }
});

test('quantities, negation and modality cannot change: verified texts are never edited', () => {
  const negated = 'You must not bring pets.';
  const m = manifest({ units: [unit('u1', 'f1', ARRIVAL), unit('u2', 'f2', negated, 'prohibited')], text: `${ARRIVAL} ${negated}\n\n${NOTICE}` });
  const r = presentVerifiedManifest(m);
  assert.ok(r.text!.includes(negated) && r.text!.includes('10 minutes'));
  assert.equal((r.text!.match(/\d/gu) || []).join(''), '10');
});
