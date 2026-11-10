import assert from 'node:assert/strict';
import test from 'node:test';
import { containsUnverifiedBookingSuccessClaim as booking } from './reliability';
import { containsWebOperationSuccess as web } from './web-response-integrity';
import { assessNumericalConstraint } from './numerical-constraints';

// SYNTHETIC paraphrases, not recovered production model outputs.
const source = 'Kunder som besöker studion för första gången rekommenderas att komma cirka 10 minuter före sin bokade tid för att hinna förbereda sig i lugn och ro.';
const faithful = [
  'ينصح الزوار للمرة الأولى بالوصول قبل موعدك المحجوز بحوالي 10 دقائق.',
  'ينصح الزوار للمرة الأولى بالوصول قبل موعدك المؤكد بحوالي 10 دقائق.',
  'First-time visitors are recommended to arrive approximately 10 minutes before their booked appointment.',
  'Förstagångsbesökare rekommenderas att komma cirka 10 minuter före sin bokade tid.',
  'Erstbesuchern wird empfohlen, ungefähr 10 Minuten vor ihrem gebuchten Termin zu kommen.',
  'Se recomienda a quienes visitan por primera vez llegar aproximadamente 10 minutos antes de la hora reservada para su cita.',
  'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند.',
];
for (const text of faithful) test(`temporal recommendation is not an operation: ${text}`, () => {
  assert.equal(booking(text), false); assert.equal(web(text), false);
  assert.equal(assessNumericalConstraint(text,text,[source]).safe,true);
});
const operations = [
  'موعدك محجوز.', 'موعدك مؤكد.', 'تم حجز موعدك.', 'تم تأكيد موعدك.',
  'حجزك مؤكد.', 'تم إلغاء موعدك.', 'تم تغيير موعدك.',
  'قبل موعدك محجوز.', // Predicative, not the definite attributive adjective.
  'قبل موعدك المحجوز، تم حجز موعد آخر.',
  'قبل موعدك المحجوز، تم تأكيد موعد آخر.',
  'قبل موعدك المحجوز، موعدك مؤكد.',
  'قبل موعدك المؤكد، تم إلغاء موعدك.',
  'قبل موعدك المحجوز، تم تغيير موعدك.',
  'Your appointment is confirmed.', 'I booked your appointment.',
  'Before your booked appointment, I booked another appointment.',
];
for (const text of operations) test(`operation remains rejected: ${text}`, () => {
  assert.ok(booking(text)||web(text));
});
for (const numeral of ['10','۱۰','١٠']) test(`Persian numeral normalization ${numeral}`, () => {
  const text=`به مراجعه‌کنندگان بار اول توصیه می‌شود تقریباً ${numeral} دقیقه قبل از نوبت رزروشده خود حاضر شوند.`;
  assert.equal(assessNumericalConstraint(text,text,[source]).safe,true);
});
for (const text of [
  'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۲۰ دقیقه قبل از نوبت رزروشده خود حاضر شوند.',
  'به مراجعه‌کنندگان بار اول توصیه می‌شود حدود ۱۰ دقیقه بعد از نوبت رزروشده خود حاضر شوند.',
  'ينصح الزوار للمرة الأولى بالوصول بعد موعدك المحجوز بحوالي 10 دقائق.',
]) test(`numerical mismatch remains rejected: ${text}`, () => assert.equal(assessNumericalConstraint(text,text,[source]).safe,false));
