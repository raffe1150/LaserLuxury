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

const additionalPurposes = [
 ['ability', ' تا بتوانند آماده شوند.'],
 ['ability with manner', ' تا بتوانند با آرامش آماده شوند.'],
 ['purpose complement before time', ' تا برای آماده شدن زمان کافی داشته باشند.'],
 // The same closed preparation clause without the modal (recorded Sol/Luna wording).
 ['get ready, no modal', ' تا آماده شوند.'],
 ['get ready calmly, no modal', ' تا با آرامش آماده شوند.'],
] as const;

for (const n of ['۱۰', '10', '١٠']) for (const [name, suffix] of additionalPurposes)
 test(`SYNTHETIC preparation purpose / ${name} / ${n}`, () => {
  const a = assess(base(n) + suffix);
  assert.equal(a.safe, true, a.reason);
  const shapes = numericalComparisonShapes(a);
  assert.equal(shapes.length, 2);
  assert.ok(shapes.every(row => row.candidateBound === 'unbounded' && row.candidateSide === 'before' && row.boundCompatible));
 });

for (const [qualifier, bound] of [
 ['حداکثر', 'maximum'], ['حد اکثر', 'maximum'], ['تا', 'maximum'],
 ['نه زودتر از', 'maximum'], ['کمتر از', 'strict_maximum'],
 ['حداقل', 'minimum'], ['نه دیرتر از', 'minimum'],
] as const) test(`preparation purpose preserves genuine bound / ${qualifier}`, () => {
 const claim = base('۱۰', qualifier) + additionalPurposes[1][1];
 const a = assess(claim);
 assert.equal(a.safe, false);
 assert.equal(numericalComparisonShapes(a)[0].candidateBound, bound);
 assert.equal(assess(claim, claim).safe, true);
});

for (const [name, claim] of [
 ['wrong quantity', base('۲۰') + additionalPurposes[0][1]],
 ['after', base().replace('قبل', 'بعد') + additionalPurposes[0][1]],
 ['negative arrival', base().replace('حاضر شوند', 'حاضر نشوند') + additionalPurposes[0][1]],
 ['alternative quantity', base().replace('۱۰', '۱۰ یا ۲۰') + additionalPurposes[0][1]],
 ['unrelated action', base().replace('حاضر شوند', 'ثبت نام کنند') + additionalPurposes[0][1]],
 ['unrelated ability', base() + ' تا بتوانند پرداخت کنند.'],
 // Human-labelled faithful (fa-purpose-8) but outside the closed grammar: stays conservative.
 ['purpose outside the closed grammar', base() + ' تا با خیال راحت آماده شوند.'],
 ['deadline', base() + ' تا شروع نوبت.'],
 ['cancellation context', 'لغو: ' + base() + additionalPurposes[0][1]],
] as const) test(`preparation purpose keeps conservative rejection / ${name}`, () => assert.equal(assess(claim).safe, false));

test('no-later-than after an appointment still denotes a maximum', () => {
 const claim = base('۱۰', 'نه دیرتر از').replace('قبل', 'بعد') + '.';
 const a = assess(claim);
 assert.equal(a.safe, false);
 const shape = numericalComparisonShapes(a)[0];
 assert.equal(shape.candidateBound, 'maximum');
 assert.equal(shape.candidateSide, 'after');
 assert.equal(assess(claim, claim).safe, true);
});

for (const comma of ['،', ',']) {
 test(`comma before a recognized preparation purpose / ${comma}`, () => {
  const a = assess(base() + comma + additionalPurposes[1][1]);
  assert.equal(a.safe, true, a.reason);
  const [shape] = numericalComparisonShapes(a);
  assert.equal(shape.candidateBound, 'unbounded');
  assert.equal(shape.candidateSide, 'before');
  assert.equal(shape.purposeClauseCategory, 'finite_preparation');
 });
}

test('a comma before a preparation purpose preserves genuine bounds and deadlines', () => {
 for (const qualifier of ['حداکثر', 'تا']) {
  const claim = base('۱۰', qualifier) + '،' + additionalPurposes[1][1];
  const a = assess(claim);
  assert.equal(a.safe, false);
  assert.equal(numericalComparisonShapes(a)[0].candidateBound, 'maximum');
  assert.equal(assess(claim, claim).safe, true);
 }
 const deadline = assess(base() + '، تا شروع نوبت.');
 assert.equal(deadline.safe, false);
 assert.equal(numericalComparisonShapes(deadline)[0].candidateBound, 'maximum');
 assert.equal(numericalComparisonShapes(deadline)[0].purposeClauseGuardMatched, false);
});

test('a comma before a preparation purpose cannot resolve conflicting or unsupported claims', () => {
 const suffix = '،' + additionalPurposes[1][1];
 const conflict = assess(base('۱۰', 'حداقل یا حداکثر') + suffix);
 assert.equal(conflict.safe, false);
 assert.equal(conflict.reason, 'CLAIM_AMBIGUOUS');
 for (const claim of [
  base('۲۰') + suffix,
  base() + '، تا بتوانند آماده شوند یا ۲۰ دقیقه قبل برسند.',
  base() + '، تا با خیال راحت آماده شوند.',
  base().replace('قبل', 'بعد') + suffix,
  'لغو: ' + base() + suffix,
 ]) assert.equal(assess(claim).safe, false, claim);
});

// Narrow modal-less grammar: same closed preparation clause, every limit preserved.
const getReady = [' تا آماده شوند.', ' تا با آرامش آماده شوند.'] as const;
for (const suffix of getReady) for (const [qualifier, bound] of [
 ['حداکثر', 'maximum'], ['تا', 'maximum'], ['نه زودتر از', 'maximum'], ['کمتر از', 'strict_maximum'],
 ['حداقل', 'minimum'], ['نه دیرتر از', 'minimum'],
] as const) test(`modal-less preparation purpose preserves genuine bound / ${qualifier} / ${suffix.trim()}`, () => {
 const claim = base('۱۰', qualifier) + suffix;
 assert.equal(assess(claim).safe, false);
 assert.equal(numericalComparisonShapes(assess(claim))[0].candidateBound, bound);
 assert.equal(assess(claim, claim).safe, true);
});
test('modal-less preparation purpose: second person and «برسند» arrival are accepted', () => {
 for (const claim of ['اگر بار اول است، بهتر است حدود ۱۰ دقیقه قبل از وقت رزرو برسید تا با آرامش آماده شوید.',
  'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با آرامش آماده شوند.']) {
  const a = assess(claim);
  assert.equal(a.safe, true, a.reason);
  assert.equal(numericalComparisonShapes(a)[0].purposeClauseCategory, 'finite_preparation');
 }
});
for (const [name, claim] of [
 ['deadline before the purpose', base() + ' تا شروع نوبت آماده شوند.'],
 ['until-clause event', base() + ' تا نوبتشان شروع شود.'],
 ['negated preparation', base() + ' تا آماده نشوند.'],
 ['other preparation phrasing', base() + ' تا بدون عجله آماده شوند.'],
 ['cancellation window', 'لغو تا ۱۰ دقیقه قبل از نوبت مجاز است تا آماده شوند.'],
 ['notice period context', 'مهلت: ' + base() + ' تا آماده شوند.'],
 ['exact instead of approximate', base('۱۰', 'دقیقاً') + ' تا آماده شوند.'],
 ['conditional maximum', 'اگر دستورالعمل خاصی دارید، ' + base('۱۰', 'حداکثر') + ' تا آماده شوند.'],
 ['negated recommendation', 'توصیه نمی‌شود مراجعه‌کنندگان بار اول حدود ۱۰ دقیقه قبل از نوبت حاضر شوند تا آماده شوند.'],
 ['wrong quantity', base('۲۰') + ' تا آماده شوند.'],
 ['wrong unit', base().replace('دقیقه', 'ساعت') + ' تا آماده شوند.'],
 ['after the appointment', base().replace('قبل', 'بعد') + ' تا آماده شوند.'],
] as const) test(`modal-less preparation purpose keeps conservative rejection / ${name}`, () => assert.equal(assess(claim).safe, false, claim));
test('a conditional requirement is numerically unbounded; modality and condition remain Verification authority', () => {
 const claim = 'اگر دستورالعمل خاصی دریافت کرده‌اید، باید حدود ۱۰ دقیقه قبل از نوبت برسید تا آماده شوید.';
 assert.equal(assess(claim).safe, true);
 assert.equal(numericalComparisonShapes(assess(claim))[0].candidateBound, 'unbounded');
});
