import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessInformationTopics,
  isBusinessAddressQuestion,
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

const liveAddressParaphrases = [
  ['en', 'Hi, what’s your address?'],
  ['en', 'Where are you guys located?'],
  ['sv', 'Hej, vad har ni för adress?'],
  ['sv', 'Var ligger ni någonstans?'],
  ['es', 'Hola, ¿cuál es su dirección?'],
  ['es', '¿Dónde están ubicados?'],
  ['de', 'Hallo, wie lautet Ihre Adresse?'],
  ['de', 'Wo genau befindet ihr euch?'],
  ['fa', 'سلام، آدرستون کجاست؟'],
  ['fa', 'سلام، شما کجا هستین؟'],
  ['ar', 'مرحباً، ما عنوانكم؟'],
  ['ar', 'أين يقع مكانكم؟'],
] as const;

const parkingQuestions = [
  ['en', 'Where can I park when I come to see you?'],
  ['sv', 'Finns det parkering nära er? Var då?'],
  ['es', '¿Tienen aparcamiento cerca? ¿Dónde está?'],
  ['de', 'Gibt es bei euch Parkplätze? Wo sind die?'],
  ['fa', 'نزدیک شما پارکینگ هست؟ کجاست؟'],
  ['ar', 'هل توجد مواقف سيارات بالقرب منكم؟ أين هي؟'],
] as const;

const unrelatedInformationQuestions = [
  ['en', 'What are the entry requirements?'],
  ['en', 'How do you address customer complaints?'],
  ['sv', 'Vilka villkor gäller för medlemskap?'],
  ['es', '¿Cuáles son los requisitos de acceso?'],
  ['de', 'Welche Zugangsbedingungen gelten?'],
  ['fa', 'شرایط ورود چیست؟'],
  ['ar', 'ما شروط الدخول؟'],
  ['ar', 'ما عنوان الخدمة الجديدة؟'],
  ['ar', 'ما موقعكم الإلكتروني؟'],
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

for (const [language, text] of liveAddressParaphrases) {
  test(`${language}: live address paraphrase routes to business information`, () => {
    assert.equal(isBusinessInformationQuestion(text), true);
    assert.ok(businessInformationTopics(text).includes('contact'));
    assert.equal(isBusinessAddressQuestion(text), true);
  });
}

for (const [language, text] of parkingQuestions) {
  test(`${language}: parking questions route to grounded business information`, () => {
    assert.equal(isBusinessInformationQuestion(text), true);
    assert.ok(businessInformationTopics(text).includes('parking'));
  });
}


for (const [language, text] of unrelatedInformationQuestions) {
  test(`${language}: unrelated information wording does not enable address retrieval bridges`, () => {
    assert.equal(isBusinessAddressQuestion(text), false);
  });
}
