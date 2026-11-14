import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnswerUnits, parseRequestedFacets, type Evidence, type ReExtractionTally } from './business-information-answer-plan';
import { assessNumericalConstraint, numericalRejectionShape, type NumericalRejectionShape } from './numerical-constraints';
import type { KnowledgeDecision } from './knowledge-answer-protocol';

// SYNTHETIC claims only. Sources follow the public test business's Swedish wording.
// Expected decisions were recorded from baseline d0702e1. The diagnostic itself
// never changes a decision; the only expected change since then is intentional:
// written cardinal numbers before a known unit are now parsed (row "written").
const threshold = 'Vid en försening på mer än 15 minuter kan studion behöva göra en ny bedömning av om besöket kan genomföras enligt plan.';
const arrival = 'Vi rekommenderar att du kommer 10 minuter före din bokade tid.';
const claims = {
  de: { one: 'Bei mehr als 15 Minuten Verspätung kann das Studio den Besuch neu beurteilen.',
    written: 'Bei mehr als fünfzehn Minuten Verspätung kann das Studio den Besuch neu beurteilen.',
    none: 'Bei einer Verspätung kann das Studio den Besuch neu beurteilen.',
    repeated: 'Bei mehr als 15 Minuten Verspätung kann das Studio den Besuch neu beurteilen. Bitte melden Sie sich, wenn es mehr als 15 Minuten werden.',
    two: 'Wir empfehlen, 10 Minuten vor dem Termin zu kommen. Bei mehr als 15 Minuten Verspätung kann das Studio den Besuch neu beurteilen.',
    twoWrong: 'Wir empfehlen, 10 Minuten vor dem Termin zu kommen. Bei mehr als 16 Minuten Verspätung kann das Studio den Besuch neu beurteilen.',
    abbreviated: 'Kommen Sie 10 Min. vor dem Termin.' },
  sv: { one: 'Vid mer än 15 minuter försening kan personalen behöva bedöma besöket.',
    written: 'Vid mer än femton minuter försening kan personalen behöva bedöma besöket.',
    none: 'Vid försening kan personalen behöva bedöma besöket.',
    repeated: 'Vid mer än 15 minuter försening kan personalen behöva bedöma besöket. Hör av dig om det blir mer än 15 minuter.',
    two: 'Vi rekommenderar att du kommer 10 minuter före din tid. Vid mer än 15 minuter försening kan personalen behöva bedöma besöket.',
    twoWrong: 'Vi rekommenderar att du kommer 10 minuter före din tid. Vid mer än 16 minuter försening kan personalen behöva bedöma besöket.',
    abbreviated: 'Kom 10 min före din tid.' },
  en: { one: 'With more than 15 minutes of delay staff may need to assess the visit.',
    written: 'With more than fifteen minutes of delay staff may need to assess the visit.',
    none: 'With a delay staff may need to assess the visit.',
    repeated: 'With more than 15 minutes of delay staff may need to assess the visit. Please get in touch if it will be more than 15 minutes.',
    two: 'We recommend arriving 10 minutes before your appointment. With more than 15 minutes of delay staff may need to assess the visit.',
    twoWrong: 'We recommend arriving 10 minutes before your appointment. With more than 16 minutes of delay staff may need to assess the visit.',
    abbreviated: 'Arrive 10 min before your appointment.' },
  es: { one: 'Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita.',
    written: 'Con más de quince minutos de retraso el estudio puede necesitar evaluar la visita.',
    none: 'Con retraso el estudio puede necesitar evaluar la visita.',
    repeated: 'Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita. Avise si van a ser más de 15 minutos.',
    two: 'Recomendamos llegar 10 minutos antes de la cita. Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita.',
    twoWrong: 'Recomendamos llegar 10 minutos antes de la cita. Con más de 16 minutos de retraso el estudio puede necesitar evaluar la visita.',
    abbreviated: 'Llegue 10 min antes de la cita.' },
  fa: { one: 'با بیش از ۱۵ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.',
    written: 'با بیش از پانزده دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.',
    none: 'در صورت تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.',
    repeated: 'با بیش از ۱۵ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند. اگر بیش از ۱۵ دقیقه شد خبر دهید.',
    two: 'توصیه می‌کنیم ۱۰ دقیقه قبل از نوبت برسید. با بیش از ۱۵ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.',
    twoWrong: 'توصیه می‌کنیم ۱۰ دقیقه قبل از نوبت برسید. با بیش از ۱۶ دقیقه تأخیر ممکن است کارکنان نیاز به ارزیابی مراجعه داشته باشند.',
    abbreviated: '۱۰دقیقه قبل از نوبت برسید.' },
  ar: { one: 'عند التأخر أكثر من ١٥ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.',
    written: 'عند التأخر أكثر من خمس عشرة دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.',
    none: 'عند التأخر قد يحتاج الموظفون إلى تقييم الزيارة.',
    repeated: 'عند التأخر أكثر من ١٥ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة. يرجى إبلاغنا إذا كان التأخر أكثر من ١٥ دقيقة.',
    two: 'نوصي بالحضور ١٠ دقائق قبل الموعد. عند التأخر أكثر من ١٥ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.',
    twoWrong: 'نوصي بالحضور ١٠ دقائق قبل الموعد. عند التأخر أكثر من ١٦ دقيقة قد يحتاج الموظفون إلى تقييم الزيارة.',
    abbreviated: 'احضر ١٠ د قبل الموعد.' },
} as const;
type Kind = keyof typeof claims.de;
const sourcesFor = (kind: Kind) => kind === 'abbreviated' ? [arrival] : kind.startsWith('two') ? [threshold, arrival] : [threshold];

// [expected reason, claimCount, claimDistinct, repeated, supportedAlone, numeric form]
// "written" was UNSUPPORTED_CLAIM_COMPARISON / unit_no_digits before written numbers were parsed.
const expected: Record<Kind, readonly [string, number, number, boolean, number | null, NumericalRejectionShape['claimForm']]> = {
  one: ['CONSTRAINT_MATCH', 1, 1, false, 1, 'parsed'],
  written: ['CONSTRAINT_MATCH', 1, 1, false, 1, 'parsed'],
  none: ['CLAIM_QUANTITY_COUNT', 0, 0, false, 0, 'neither'],
  repeated: ['CLAIM_QUANTITY_COUNT', 2, 1, true, 2, 'parsed'],
  two: ['CLAIM_QUANTITY_COUNT', 2, 2, false, 2, 'parsed'],
  twoWrong: ['CLAIM_QUANTITY_COUNT', 2, 2, false, 1, 'parsed'],
  abbreviated: ['CLAIM_QUANTITY_COUNT', 0, 0, false, 0, 'digits_no_unit'],
};

const SHAPE_KEYS = ['claimCount', 'claimAmbiguous', 'claimDistinct', 'repeated', 'claimForm', 'supportedAlone', 'sourceCount', 'sourceAuthoritative'].sort();
const FORMS = ['parsed', 'digits_unit_unpaired', 'digits_no_unit', 'unit_no_digits', 'neither', 'oversized'];
function assertBounded(shape: NumericalRejectionShape, trusted: boolean) {
  assert.deepEqual(Object.keys(shape).sort(), SHAPE_KEYS);
  for (const key of ['claimCount', 'claimAmbiguous', 'claimDistinct'] as const)
    assert.ok(Number.isInteger(shape[key]) && shape[key] >= 0 && shape[key] <= 4, key);
  for (const key of ['supportedAlone', 'sourceCount', 'sourceAuthoritative'] as const)
    assert.ok(shape[key] === null || (Number.isInteger(shape[key]) && shape[key]! >= 0 && shape[key]! <= 4), key);
  assert.ok(FORMS.includes(shape.claimForm));
  assert.equal(typeof shape.repeated, 'boolean');
  if (!trusted) assert.deepEqual([shape.sourceCount, shape.sourceAuthoritative], [null, null]);
  assert.ok(Buffer.byteLength(JSON.stringify(shape)) <= 200, 'compact enough for existing event size bounds');
}

for (const [language, set] of Object.entries(claims)) for (const kind of Object.keys(set) as Kind[]) {
  test(`${language} ${kind}: expected decision and bounded shape`, () => {
    const text = set[kind];
    const assessment = assessNumericalConstraint(text, text, sourcesFor(kind));
    const [reason, count, distinct, repeated, supported, form] = expected[kind];
    assert.equal(assessment.reason, reason);
    const shape = numericalRejectionShape(assessment, true);
    assertBounded(shape, true);
    assert.deepEqual([shape.claimCount, shape.claimDistinct, shape.repeated,
      shape.supportedAlone, shape.claimForm], [count, distinct, repeated, supported, form]);
    // Computing the projection twice, or not at all, cannot change the assessment.
    assert.deepEqual(numericalRejectionShape(assessment, true), shape);
    assert.equal(assessNumericalConstraint(text, text, sourcesFor(kind)).reason, reason);
  });
}

test('counts are capped and an oversized input is reported without values', () => {
  const many = Array.from({ length: 7 }, (_, i) => `Kom ${i + 2} minuter före din tid.`).join(' ');
  const shape = numericalRejectionShape(assessNumericalConstraint(many, many, [arrival]), true);
  assert.equal(shape.claimCount, 4);
  assert.equal(shape.claimDistinct, 4);
  const huge = 'x'.repeat(20_001);
  const oversized = numericalRejectionShape(assessNumericalConstraint(huge, huge, [arrival]), true);
  assertBounded(oversized, true);
  assert.equal(oversized.claimForm, 'oversized');
  assert.equal(oversized.supportedAlone, null);
});

const contact = 'Kontakta studion så snart som möjligt via din vanliga kontaktkanal.';
const sourceId = '2ac009ba-c913-48bc-b13d-c09adf34c8e0';
const revision = '4b86e3e3f6b07821689017b9a1d996c7c884ff7a8be96d8607a2a203af2cdaf1';
const evidence: Evidence[] = [
  { id: 'e1', sourceId, chunkId: 'c1', version: revision, businessId: 3, text: threshold },
  { id: 'e2', sourceId, chunkId: 'c2', version: revision, businessId: 3, text: arrival },
  { id: 'e3', sourceId, chunkId: 'c3', version: revision, businessId: 3, text: contact },
];
const facets = parseRequestedFacets([{ subject: 'late arrival', attribute: 'policy', questionType: 'description' }]).facets;
const unit = (text: string, refs: { evidenceId: string; exactQuote: string }[]) => ({ facetIds: ['f1'], subject: 'visit', predicate: 'timing',
  value: 'timing', scope: 'visitors', qualifiers: [], modality: 'descriptive', negation: false, language: 'de', text, evidenceRefs: refs });
const cite = { e1: { evidenceId: 'e1', exactQuote: threshold }, e2: { evidenceId: 'e2', exactQuote: arrival }, e3: { evidenceId: 'e3', exactQuote: contact } };

function run(raw: unknown, items = evidence) {
  const events: KnowledgeDecision[] = [];
  const tally: ReExtractionTally = { ambiguousConnective: 0, citationOmitsQuantity: 0 };
  const result = parseAnswerUnits(raw, facets, items, 'de', e => events.push(e), 'quotation', { businessId: 3, question: 'PRIVATE_QUESTION_SENTINEL', language: 'de' },
    { businessId: 3, protocol: 'source-exhaustive-v2' }, undefined, tally);
  const silentTally: ReExtractionTally = { ambiguousConnective: 0, citationOmitsQuantity: 0 };
  assert.deepEqual(result, parseAnswerUnits(raw, facets, items, 'de', undefined, 'quotation', undefined, { businessId: 3, protocol: 'source-exhaustive-v2' }, undefined, silentTally));
  assert.deepEqual(tally, silentTally, 'diagnostics cannot alter recovery eligibility');
  return { result, events, tally };
}

test('incident-shaped synthetic proposal: two count rejections are now distinguishable; decisions unchanged', () => {
  // Synthetic stand-in for a 3-unit German proposal with two CLAIM_QUANTITY_COUNT
  // rejections. It does not reproduce or identify the production wording.
  const raw = { units: [unit(claims.de.none, [cite.e1]), unit(claims.de.repeated, [cite.e1]), unit(claims.de.one, [cite.e1])] };
  const { result, events, tally } = run(raw);
  assert.deepEqual(result.units.map(u => u.id), ['u3']);
  assert.deepEqual(tally, { ambiguousConnective: 0, citationOmitsQuantity: 0 }, 'baseline: quantity-count failures are recovery-ineligible');
  const numerical = events.filter(e => e.reason === 'NUMERICAL_CONSTRAINT');
  assert.deepEqual(numerical.map(e => [e.unitId, e.numericalMismatchReason]), [['u1', 'CLAIM_QUANTITY_COUNT'], ['u2', 'CLAIM_QUANTITY_COUNT']]);
  assert.deepEqual(numerical.map(e => [e.numericalShape?.claimCount, e.numericalShape?.repeated]), [[0, false], [2, true]]);
  for (const event of numerical) assertBounded(event.numericalShape!, true);
  assert.equal(numerical[0].numericalShape?.sourceAuthoritative, 1);
  assert.ok(events.filter(e => e.reason !== 'NUMERICAL_CONSTRAINT').every(e => e.numericalShape === undefined));
});

test('numerical diagnostics carry no claim, source, question, value or parser structure', () => {
  const raw = { units: [unit(claims.de.twoWrong, [cite.e1, cite.e2]), unit(claims.de.abbreviated, [cite.e2])] };
  const { events } = run(raw);
  const serialized = JSON.stringify(events);
  for (const forbidden of [claims.de.twoWrong, claims.de.abbreviated, threshold, arrival, 'PRIVATE_QUESTION_SENTINEL', 'Verspätung', 'minuter',
    '"seconds"', '"bound"', '"side"', '"constraints"', '900', '600', '960']) assert.ok(!serialized.includes(forbidden), forbidden);
  for (const event of events.filter(e => e.reason === 'NUMERICAL_CONSTRAINT')) assertBounded(event.numericalShape!, true);
});

test('source counts are withheld unless every cited item has same-tenant metadata', () => {
  const foreign: Evidence[] = [{ ...evidence[0], businessId: 9 }, evidence[1], evidence[2]];
  const { events } = run({ units: [unit(claims.de.repeated, [cite.e1])] }, foreign);
  const event = events.find(e => e.reason === 'NUMERICAL_CONSTRAINT')!;
  assert.deepEqual(event.evidenceBindings, []);
  assertBounded(event.numericalShape!, false);
  assert.equal(event.numericalShape?.claimCount, 2);
});

test('the quantity-not-in-citation rejection carries the same bounded shape', () => {
  const plain = 'Die Behandlung dauert 45 Minuten.';
  const { result, events } = run({ units: [unit(plain, [cite.e3])] });
  assert.equal(result.units.length, 0);
  const event = events.find(e => e.numericalMismatchReason === 'QUANTITY_NOT_IN_CITATION')!;
  assertBounded(event.numericalShape!, true);
  assert.equal(event.numericalShape?.claimCount, 1);
  assert.ok(!JSON.stringify(event).includes('45'));
});
