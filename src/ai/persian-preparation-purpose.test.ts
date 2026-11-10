import assert from 'node:assert/strict';
import test from 'node:test';
import { assessNumericalConstraint, numericalComparisonShapes } from './numerical-constraints';

// SYNTHETIC proposals; production model wording was not retained.
const source = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const base = (n = '۱۰', qualifier = 'حدود') => `به مراجعه‌کنندگان بار اول توصیه می‌شود ${qualifier} ${n} دقیقه قبل از نوبت رزروشده خود حاضر شوند`;
const purpose = ' تا زمان کافی برای آماده شدن داشته باشند.';
const assess = (claim: string, evidence = source) => assessNumericalConstraint(claim, claim, [evidence]);

for (const n of ['۱۰', '10', '١٠']) for (const noun of ['زمان', 'فرصت'])
 test(`post-quantity preparation purpose / ${n} / ${noun}`, () => {
  const a = assess(base(n) + purpose.replace('زمان', noun));
  assert.equal(a.safe, true);
  assert.ok(numericalComparisonShapes(a).every(row => row.candidateBound === 'unbounded' && row.boundCompatible));
 });

test('preparation grammar is independent of the incident quantity', () => {
 assert.equal(assess(base('۷') + purpose, source.replace('10', '7')).safe, true);
});

for (const [qualifier, bound] of [['حداکثر', 'maximum'], ['حداقل', 'minimum'], ['تا', 'maximum']] as const)
 test(`genuine ${qualifier} remains a bound alongside purpose`, () => {
  const claim = base('۱۰', qualifier) + purpose;
  assert.equal(assess(claim).safe, false);
  assert.equal(numericalComparisonShapes(assess(claim))[0].candidateBound, bound);
  assert.equal(assess(claim, claim).safe, true);
 });

for (const [name, claim] of [
 ['quantity', base('۲۰') + purpose],
 ['direction', base().replace('قبل', 'بعد') + purpose],
 ['negation', base() + ' تا زمان کافی برای آماده شدن نداشته باشند.'],
 ['negated arrival', base().replace('حاضر شوند', 'حاضر نشوند') + purpose],
 ['ambiguous', base() + ' یا ۲۰ دقیقه قبل از نوبت حاضر شوند' + purpose],
 ['unrelated action', base().replace('حاضر شوند', 'ثبت نام کنند') + purpose],
 ['unrelated purpose', base() + ' تا زمان کافی برای پرداخت داشته باشند.'],
 ['incomplete purpose', base() + ' تا زمان کافی برای آماده شدن.'],
 ['deadline', base() + ' تا ساعت ۱۷' + purpose],
 ['purpose before quantity', 'تا زمان کافی برای آماده شدن داشته باشند، ' + base() + '.'],
] as const) test(`conservative rejection / ${name}`, () => assert.equal(assess(claim).safe, false));

test('cancellation notice and fee constraints do not acquire the arrival exemption', () => {
 const claim = 'لغو تا ۱۰ دقیقه قبل از نوبت مجاز است' + purpose;
 assert.equal(assess(claim, 'Avbokning är tillåten minst 10 minuter före besöket.').safe, false);
 const notice = 'لغو حداقل ۱۰ دقیقه قبل از نوبت مجاز است.';
 assert.equal(assess(notice, 'Avbokning är tillåten minst 10 minuter före besöket.').safe, true);
 assert.equal(assess(notice.replace('حداقل', 'حداکثر'), notice).safe, false);
 const fee = 'لغو رایگان حداقل ۱۰ دقیقه قبل از نوبت مجاز است.';
 assert.equal(assess(notice, fee).safe, false);
});
