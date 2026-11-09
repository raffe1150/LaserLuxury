import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessNumericalConstraint } from './numerical-constraints';

const source =
  'Förstagångsbesökare rekommenderas att komma 10 minuter före sin bokade tid.';

const cases: Array<[string, string, boolean]> = [
  ['FA', 'بهتر است ۱۰ دقیقه زودتر تشریف بیاورید.', true],
  ['FA', 'توصیه می‌شود ۱۰ دقیقه زودتر در محل حضور داشته باشید.', true],
  ['FA', 'بهتر است ۱۰ دقیقه بعد از وقت رزرو بیایید.', false],
  ['SV', 'Kom gärna 10 minuter före din bokade tid.', true],
  ['SV', 'Var på plats 10 minuter i förväg.', true],
  ['SV', 'Kom 10 minuter efter din bokade tid.', false],
  ['EN', 'Please arrive 10 minutes before your appointment.', true],
  ['EN', 'Please be there 10 minutes early.', true],
  ['EN', 'Please arrive 10 minutes after your appointment.', false],
  ['DE', 'Bitte kommen Sie 10 Minuten vor Ihrem Termin.', true],
  ['DE', 'Seien Sie 10 Minuten früher vor Ort.', true],
  ['DE', 'Bitte kommen Sie 10 Minuten nach Ihrem Termin.', false],
  ['ES', 'Llegue 10 minutos antes de su cita.', true],
  ['ES', 'Preséntese 10 minutos con antelación.', true],
  ['ES', 'Llegue 10 minutos después de su cita.', false],
  ['AR', 'يرجى الحضور قبل الموعد بـ 10 دقائق.', true],
  ['AR', 'يرجى الوصول مبكراً بـ 10 دقائق.', true],
  ['AR', 'يرجى الحضور بعد الموعد بـ 10 دقائق.', false],
];

for (const [language, claim, expected] of cases) {
  test(`${language}: ${claim}`, () => {
    const result = assessNumericalConstraint(claim, claim, [source]);
    assert.equal(result.safe, expected,
      `Expected ${expected ? 'ACCEPT' : 'REJECT'}, got ${result.reason}`);
  });
}
