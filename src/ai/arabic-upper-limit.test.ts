import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNumericalConstraint, numericalComparisonShapes, numericalConstraintSafe as safe } from './numerical-constraints';

// SYNTHETIC claims. Arabic "يصل/تصل إلى" means "up to" only when it introduces the
// quantity; otherwise it is the arrival verb "arrives at".
const recommendation = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const retention = 'Glömda föremål sparas i upp till 21 dagar.';
const shape = (claim: string, source: string) => numericalComparisonShapes(assessNumericalConstraint(claim, claim, [source]))[0];

const upTo = [
  'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بما يصل إلى 10 دقائق.',
  'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بما يصل الى 10 دقائق.',
  'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بما تصل إلى 10 دقائق.',
  'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بما تصل الى ١٠ دقائق.',
  'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بما يصل إلى حوالي 10 دقائق.',
];
for (const claim of upTo) {
  test(`up-to before the quantity is a maximum the source does not state: ${claim}`, () => {
    assert.equal(safe(claim, claim, [recommendation]), false);
    const s = shape(claim, recommendation);
    assert.equal(s.candidateBound, 'maximum');
    assert.equal(s.sourceBound, 'unbounded');
    assert.equal(s.boundTriggerPosition, 'before_quantity');
  });
  test(`the same stated upper limit is accepted against itself: ${claim}`, () => assert.equal(safe(claim, claim, [claim]), true));
}

test('a genuine source upper limit: masculine and feminine Arabic both preserve it; a changed value is vetoed', () => {
  for (const verb of ['يصل', 'تصل']) {
    const claim = `يُحتفظ بالأغراض المنسية لمدة ${verb} إلى 21 يومًا.`;
    assert.equal(safe(claim, claim, [retention]), true, claim);
    assert.equal(shape(claim, retention).candidateBound, 'maximum');
    const changed = claim.replace('21', '30');
    assert.equal(safe(changed, changed, [retention]), false, changed);
  }
  const unbounded = 'Glömda föremål sparas i 21 dagar.';
  const limit = 'يُحتفظ بالأغراض المنسية لمدة يصل إلى 21 يومًا.';
  assert.equal(safe(limit, limit, [unbounded]), false, 'an invented upper limit is vetoed');
});

for (const claim of [
  'يُنصح الزائر للمرة الأولى بأن يصل إلى الاستوديو قبل موعده بحوالي 10 دقائق.',
  'يُنصح الزائر للمرة الأولى بأن يصل الى الاستوديو قبل موعده بحوالي 10 دقائق.',
  'يُنصح بأن تصل إلى الاستوديو قبل موعدك بحوالي 10 دقائق.',
  'يُنصح الزائر للمرة الأولى بأن يصل قبل موعده بحوالي 10 دقائق.',
]) test(`arrival "arrives at" is not an upper limit: ${claim}`, () => {
  assert.equal(safe(claim, claim, [recommendation]), true);
  assert.equal(shape(claim, recommendation).candidateBound, 'unbounded');
});

test('an arrival verb never hides a genuine limit in the same clause', () => {
  for (const claim of [
    'يُنصح بأن تصل إلى الاستوديو قبل موعدك بما يصل إلى 10 دقائق.',
    'يُنصح بأن يصل إلى الاستوديو قبل موعده بما لا يزيد عن 10 دقائق.',
    'يُنصح بأن يصل إلى الاستوديو قبل موعده بحد أقصى 10 دقائق.',
  ]) assert.equal(safe(claim, claim, [recommendation]), false, claim);
});

test('purpose clauses: unambiguous "لكي" is accepted; "حتى" keeps its existing conservative rejection', () => {
  assert.equal(safe('يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق لكي يستعدوا بهدوء.',
    'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق لكي يستعدوا بهدوء.', [recommendation]), true);
  const hatta = 'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق حتى يستعدوا بهدوء.';
  assert.equal(safe(hatta, hatta, [recommendation]), false);
});

test('a quantity-less arrival sentence is not treated as an unquantified limit', () => {
  const claim = 'يمكنك أن تصل إلى الاستقبال عبر المصعد.';
  assert.equal(assessNumericalConstraint(claim, claim, ['Det finns hiss i byggnaden.']).safe, true);
});
