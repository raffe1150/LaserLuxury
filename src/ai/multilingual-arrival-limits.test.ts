import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNumericalConstraint, numericalComparisonShapes } from './numerical-constraints';

// SYNTHETIC equivalent-meaning cases (not literal translations) for the first-visit
// arrival recommendation. The source states an approximate, unbounded "before"
// recommendation; every real limit, deadline, wrong quantity or anchor must be vetoed,
// and a limit is accepted only when the source states the same limit.
const source = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const assess = (claim: string, evidence = source) => assessNumericalConstraint(claim, claim, [evidence]);
const bound = (claim: string) => numericalComparisonShapes(assess(claim))[0]?.candidateBound;

type Cases = { purpose: string[]; maximum: string[]; minimum: string[]; latest: string[]; wrong: string[]; after: string[] };
const languages: Record<'fa' | 'ar' | 'es' | 'sv' | 'en' | 'de', Cases> = {
  fa: {
    purpose: ['به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت برسند تا با آرامش آماده شوند.',
      'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت برسند، برای اینکه با آرامش آماده شوند.'],
    maximum: ['به مراجعه‌کنندگان بار اول توصیه می‌شود حداکثر ۱۰ دقیقه قبل از نوبت برسند تا آماده شوند.',
      'به مراجعه‌کنندگان بار اول توصیه می‌شود تا ۱۰ دقیقه قبل از نوبت برسند.'],
    minimum: ['به مراجعه‌کنندگان بار اول توصیه می‌شود حداقل ۱۰ دقیقه قبل از نوبت برسند تا آماده شوند.'],
    latest: ['مراجعه‌کنندگان بار اول نه دیرتر از ۱۰ دقیقه قبل از نوبت برسند.'],
    wrong: ['به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۲۰ دقیقه قبل از نوبت برسند تا آماده شوند.'],
    after: ['به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه بعد از نوبت برسند تا آماده شوند.'],
  },
  ar: {
    purpose: ['يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق لكي يستعدوا بهدوء.',
      'يُنصح الزائر للمرة الأولى بأن يصل إلى الاستوديو قبل موعده بحوالي 10 دقائق.'],
    maximum: ['يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحد أقصى 10 دقائق.',
      'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بـ 10 دقائق كحد أقصى.',
      'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحد اقصى 10 دقائق.',
      'يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بما يصل إلى 10 دقائق.'],
    minimum: ['يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بـ 10 دقائق على الأقل.'],
    latest: ['يجب وصول الزوار للمرة الأولى في موعد أقصاه 10 دقائق قبل الموعد.'],
    wrong: ['يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 20 دقيقة لكي يستعدوا بهدوء.'],
    after: ['يُنصح الزوار للمرة الأولى بالوصول بعد موعدهم بحوالي 10 دقائق لكي يستعدوا بهدوء.'],
  },
  es: {
    purpose: ['Se recomienda a quienes vienen por primera vez llegar unos 10 minutos antes de su cita para prepararse con calma.'],
    maximum: ['Se recomienda a quienes vienen por primera vez llegar como máximo 10 minutos antes de su cita.',
      'Se recomienda a quienes vienen por primera vez llegar hasta 10 minutos antes de su cita.'],
    minimum: ['Se recomienda a quienes vienen por primera vez llegar al menos 10 minutos antes de su cita.'],
    latest: ['Quienes vienen por primera vez deben llegar a más tardar 10 minutos antes de su cita.'],
    wrong: ['Se recomienda a quienes vienen por primera vez llegar unos 20 minutos antes de su cita para prepararse con calma.'],
    after: ['Se recomienda a quienes vienen por primera vez llegar unos 10 minutos después de su cita para prepararse con calma.'],
  },
  sv: {
    purpose: ['Förstagångsbesökare rekommenderas att komma ungefär 10 minuter före sin bokade tid så att de hinner förbereda sig.'],
    maximum: ['Förstagångsbesökare rekommenderas att komma högst 10 minuter före sin bokade tid.',
      'Förstagångsbesökare rekommenderas att komma upp till 10 minuter före sin bokade tid.'],
    minimum: ['Förstagångsbesökare rekommenderas att komma minst 10 minuter före sin bokade tid.'],
    latest: ['Förstagångsbesökare ska komma senast 10 minuter före sin bokade tid.'],
    wrong: ['Förstagångsbesökare rekommenderas att komma ungefär 20 minuter före sin bokade tid så att de hinner förbereda sig.'],
    after: ['Förstagångsbesökare rekommenderas att komma ungefär 10 minuter efter sin bokade tid så att de hinner förbereda sig.'],
  },
  en: {
    purpose: ['First-time visitors are recommended to arrive about 10 minutes before their booking in order to prepare calmly.'],
    maximum: ['First-time visitors are recommended to arrive at most 10 minutes before their booking.',
      'First-time visitors are recommended to arrive up to 10 minutes before their booking.'],
    minimum: ['First-time visitors are recommended to arrive at least 10 minutes before their booking.'],
    latest: ['First-time visitors must arrive no later than 10 minutes before their booking.'],
    wrong: ['First-time visitors are recommended to arrive about 20 minutes before their booking in order to prepare calmly.'],
    after: ['First-time visitors are recommended to arrive about 10 minutes after their booking in order to prepare calmly.'],
  },
  de: {
    purpose: ['Erstbesuchern wird empfohlen, etwa 10 Minuten vor ihrem Termin da zu sein, damit sie sich in Ruhe vorbereiten können.'],
    maximum: ['Erstbesuchern wird empfohlen, höchstens 10 Minuten vor ihrem Termin zu kommen.',
      'Erstbesuchern wird empfohlen, bis zu 10 Minuten vor ihrem Termin zu kommen.'],
    minimum: ['Erstbesuchern wird empfohlen, mindestens 10 Minuten vor ihrem Termin zu kommen.'],
    latest: ['Erstbesucher müssen spätestens 10 Minuten vor ihrem Termin da sein.'],
    wrong: ['Erstbesuchern wird empfohlen, etwa 20 Minuten vor ihrem Termin da zu sein, damit sie sich in Ruhe vorbereiten können.'],
    after: ['Erstbesuchern wird empfohlen, etwa 10 Minuten nach ihrem Termin da zu sein, damit sie sich in Ruhe vorbereiten können.'],
  },
};

for (const [language, cases] of Object.entries(languages)) {
  for (const claim of cases.purpose) test(`${language}: faithful approximate recommendation/purpose is accepted / ${claim}`, () => {
    const a = assess(claim);
    assert.equal(a.safe, true, a.reason);
    assert.equal(bound(claim), 'unbounded');
  });
  for (const [kind, expected] of [['maximum', 'maximum'], ['minimum', 'minimum'], ['latest', 'minimum']] as const)
    for (const claim of cases[kind]) test(`${language}: ${kind} is vetoed against the unbounded source and accepted only against the same limit / ${claim}`, () => {
      assert.equal(assess(claim).safe, false);
      assert.equal(bound(claim), expected);
      assert.equal(assess(claim, claim).safe, true);
    });
  for (const claim of [...cases.wrong, ...cases.after]) test(`${language}: changed quantity or anchor is vetoed / ${claim}`, () =>
    assert.equal(assess(claim).safe, false));
}

test('Arabic «بحد أقصى»: the same stated maximum in a Swedish source is accepted; a different one is vetoed', () => {
  const limitSource = 'Förstagångsbesökare bör komma högst 10 minuter före sin bokade tid.';
  for (const claim of languages.ar.maximum.slice(0, 3)) {
    assert.equal(assess(claim, limitSource).safe, true, claim);
    assert.equal(assess(claim.replace('10', '15'), limitSource).safe, false, claim);
  }
});

test('known pre-existing conservative rejection: English «ahead of» is not a recognised anchor (fails closed)', () => {
  // Faithful paraphrase, but the closed anchor vocabulary has «before», not «ahead of».
  // Unchanged by this work; safe direction (no publication), recorded as a gap.
  const claim = 'First-time visitors are advised to get there roughly 10 minutes ahead of their booked time so they can settle in and prepare.';
  assert.equal(assess(claim).safe, false);
  assert.equal(assess(claim).reason, 'UNBOUNDED_CLAIM_NOT_SUPPORTED');
});

test('language-specific safeguards are retained', () => {
  // Arabic «حتى» stays a conservative limit marker even in a purpose clause.
  assert.equal(assess('يُنصح الزوار للمرة الأولى بالوصول قبل موعدهم بحوالي 10 دقائق حتى يستعدوا بهدوء.').safe, false);
  // Persian «تا» before the quantity is "up to".
  assert.equal(bound('به مراجعه‌کنندگان بار اول توصیه می‌شود تا ۱۰ دقیقه قبل از نوبت برسند.'), 'maximum');
  // A Persian purpose outside the closed grammar keeps the conservative path (re-extraction trigger).
  assert.equal(assess('به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده برسند تا با خیال راحت آماده شوند.').safe, false);
  // Spanish «hasta» before a quantity is "up to".
  assert.equal(bound('Se recomienda llegar hasta 10 minutos antes de la cita.'), 'maximum');
});
