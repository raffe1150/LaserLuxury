import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessInformationTopics,
  isBusinessInformationQuestion,
} from './business-information';

const cases = [
  ['en', 'Where is the customer entrance?'],
  ['sv', 'Var ligger kundentrén?'],
  ['de', 'Wo ist der Kundeneingang?'],
  ['es', '¿Dónde está la entrada para clientes?'],
  ['fa', 'ورودی مشتریان کجاست؟'],
  ['ar', 'أين مدخل العملاء؟'],
] as const;

for (const [language, text] of cases) {
  test(`${language}: business location and entrance questions route to business information`, () => {
    assert.equal(isBusinessInformationQuestion(text), true);
    assert.ok(
      businessInformationTopics(text).includes('contact'),
      `${text} should be classified as contact/business-location information`,
    );
  });
}
