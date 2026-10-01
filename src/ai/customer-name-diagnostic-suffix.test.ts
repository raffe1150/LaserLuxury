import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractExplicitArabicCustomerName, stripCustomerNameDiagnosticSuffix } from './arabic-customer-name';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

for (const [message, name] of [
  ['اسمي لينا اختبار', 'لينا اختبار'],
  ['اسمي لينا اختبار AIBB 93414557 whatsapp-ar. وبالمناسبة، قال لي أحدهم اليوم "hej".', 'لينا اختبار'],
  ['اسمي لَيْنَا اِخْتِبَار AIBB ٩٣٤١٤٥٥٧ whatsapp-ar.', 'لَيْنَا اِخْتِبَار'],
  ['اسمي محمد عبد الله أحمد AIBB 93414557 whatsapp-ar.', 'محمد عبد الله أحمد'],
  ['اسمي لينا اختبار. وبالمناسبة، قال لي أحدهم اليوم "hej".', 'لينا اختبار'],
  ['نام من میرا آزمون است', 'میرا آزمون'],
  ['نام من میرا آزمون AIBB ۹۳۴۱۴۵۵۷ whatsapp-fa. ضمناً امروز کسی به من "hej" گفت.', 'میرا آزمون'],
  ['نام من میرا آزمون است. ضمناً امروز کسی به من "hej" گفت.', 'میرا آزمون'],
  ['My name is Mira Testmann AIBB 93414557 whatsapp-en.', 'Mira Testmann'],
  ['Mein Name ist Mira Testmann AIBB 93414557 whatsapp-de.', 'Mira Testmann'],
  ['Jag heter Mira Testmann AIBB 93414557 whatsapp-sv.', 'Mira Testmann'],
  ['Me llamo Mira Testmann AIBB 93414557 whatsapp-es.', 'Mira Testmann'],
]) {
  test(`explicit customer name survives diagnostic/stress suffix: ${message}`, () => {
    const parts = b.extractBookingContactParts(message);
    assert.equal(parts.nameOnly, name);
    assert.equal(parts.phoneOnly, null);
    assert.equal(b.extractPendingBookingCustomerName(message, { operation: 'new_booking', status: 'awaiting_contact' }), name);
  });
}
for (const text of ['', 'اسمي', 'اسمي 1234 AIBB 93414557 whatsapp-ar.', 'اسمي AIBB 93414557 whatsapp-ar.',
  'اسمي أريد حجز موعد AIBB 93414557 whatsapp-ar.', 'اسمي لينا اختبار وأريد تغيير الموعد.', 'اسمي نعم.', 'اسمي لينا؟']) {
  test(`invalid Arabic name remains invalid: ${text}`, () => assert.equal(extractExplicitArabicCustomerName(text), null));
}
test('diagnostic stripping does not trim arbitrary unmarked Arabic prose or a name-like AIBB word', () => {
  assert.equal(stripCustomerNameDiagnosticSuffix('اسمي لينا اختبار وأريد تغيير الموعد.'), 'اسمي لينا اختبار وأريد تغيير الموعد.');
  assert.equal(stripCustomerNameDiagnosticSuffix('My name is Mira AIBB'), 'My name is Mira AIBB');
});
