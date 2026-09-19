import assert from 'node:assert/strict';
import {
  buildConfiguredServiceCatalogPlan,
  formatConfiguredServiceCatalogPlan,
  isBusinessInformationQuestion,
  isServiceCatalogQuestion,
} from './business-information';

for (const text of [
  'Tell me about the company and services before I book.',
  'Ich möchte mich erstmal informieren, bevor ich etwas buche. Können Sie mir etwas über Ihr Unternehmen erzählen?',
  'What are your service prices?', 'Kan du beskriva era tjänster?',
  '¿Qué servicios ofrece la empresa?', 'لطفاً درباره خدمات توضیح بدهید.', 'ما الخدمات التي تقدمها الشركة؟',
  'Gibt es eine zentrale Übersichtsseite?',
]) assert.equal(isBusinessInformationQuestion(text), true, text);
for (const text of [
  'Please book Video Consultation tomorrow at 14:00.',
  'Can you book the service tomorrow?',
  'Bitte buchen Sie die Dienstleistung morgen um 14 Uhr.',
  'Ich möchte eine Dienstleistung buchen.',
  'Boka en tjänst imorgon.',
  'Quiero reservar un servicio mañana.',
  'لطفاً خدمات را رزرو کنید.', 'احجز خدمة غداً.',
  'What are the service prices? Please book Video Consultation tomorrow.',
  'Ich möchte Informationen, bevor ich etwas buche. Bitte buchen Sie trotzdem die Dienstleistung morgen.',
  'Alex Testsson, 0701234567',
]) assert.equal(isBusinessInformationQuestion(text), false, text);
console.log('19 informational-routing boundary cases passed');


for (const text of [
  'What services do you offer?',
  'Welche Dienstleistungen bieten Sie an?',
  'Vilka tjänster erbjuder ni?',
  '¿Qué servicios ofrecen?',
  'چه سرویس‌هایی ارائه می‌دهید؟',
  'ما الخدمات التي تقدمونها؟',
  'What services are available?',
  'Vilka tjänster finns tillgängliga?',
  'Welche Dienstleistungen sind verfügbar?',
  '¿Qué servicios están disponibles?',
  'چه خدماتی ارائه می‌دهید؟',
  'ما الخدمات المتاحة؟',

]) assert.equal(isServiceCatalogQuestion(text), true, `catalog: ${text}`);

for (const text of [
  'Can you describe your services?',
  'Can you explain your main services?',
  'Können Sie Ihre Dienstleistungen kurz erklären?',
  'Kan du beskriva era tjänster?',
  '¿Puedes explicar brevemente sus servicios?',
  'می‌توانید خدماتتان را توضیح بدهید؟',
  'هل يمكنك شرح خدماتكم؟',
]) assert.equal(isServiceCatalogQuestion(text), false, `explanation-not-catalog: ${text}`);

for (const text of [
  'What is the difference between your main services?',
  'Which service would you recommend for me?',
  'Was ist der Unterschied zwischen den wichtigsten Dienstleistungen?',
  'Welche Dienstleistung würden Sie mir empfehlen?',
  'Vad är skillnaden mellan era viktigaste tjänster?',
  'Vilken tjänst skulle du rekommendera för mig?',
  '¿Cuál es la diferencia entre los servicios principales?',
  '¿Qué servicio me recomendarías?',
  'فرق سرویس‌های اصلی چیه؟',
  'کدام سرویس برای من مناسب‌تره؟',
  'ما الفرق بين الخدمات الرئيسية؟',
  'أي خدمة تنصحني بها؟',
]) assert.equal(isServiceCatalogQuestion(text), false, `comparison: ${text}`);

console.log('18 service-catalog boundary cases passed');


for (const text of [
  'Do you offer Video Consultation?',
  'Is Golden video available?',
  'Har ni Video Consultation?',
  'Bieten Sie Video Consultation an?',
  '¿Ofrecen Video Consultation?',
  'آیا Video Consultation دارید؟',
  'هل لديكم Video Consultation؟',
]) assert.equal(isServiceCatalogQuestion(text), false, `specific-service-not-catalog: ${text}`);

console.log('7 specific-service catalog exclusions passed');


const catalogPlan = buildConfiguredServiceCatalogPlan([
  { name: 'Video Consultation', durationMinutes: 60, price: 300, currency: 'SEK' },
  { name: 'test', durationMinutes: 40, price: 150, currency: 'SEK' },
  { name: 'video for tiktok', durationMinutes: 15, price: 900, currency: 'SEK' },
  { name: 'Golden video', durationMinutes: 60, price: 1500, currency: 'SEK' },
  { name: 'Reklam', durationMinutes: 60, price: 1200, currency: 'SEK' },
  { name: 'video for Instagram', durationMinutes: 1, price: 500, currency: 'SEK' },
]);

assert.equal(catalogPlan.totalServiceCount, 6);
assert.equal(catalogPlan.displayedServices.length, 5);
assert.equal(catalogPlan.hasMoreServices, true);
assert.deepEqual(catalogPlan.displayedServices[0], {
  name: 'Video Consultation',
  durationMinutes: 60,
  price: 300,
  currency: 'SEK',
});
assert.equal(
  catalogPlan.displayedServices.some(service => service.name === 'video for Instagram'),
  false,
);

const englishCatalog = formatConfiguredServiceCatalogPlan(catalogPlan, 'en');

assert.match(englishCatalog, /Video Consultation/);
assert.match(englishCatalog, /60 minutes/);
assert.match(englishCatalog, /300 SEK/);
assert.match(englishCatalog, /Reklam/);
assert.doesNotMatch(englishCatalog, /video for Instagram/);
assert.match(
  englishCatalog,
  /more services|other services|looking for|interested in/i,
);

const partialFactsPlan = buildConfiguredServiceCatalogPlan([
  { name: 'Name Only' },
  { name: 'Duration Only', durationMinutes: 25 },
  { name: 'Price Only', price: 450, currency: 'SEK' },
]);

const partialFactsReply = formatConfiguredServiceCatalogPlan(partialFactsPlan, 'en');

assert.match(partialFactsReply, /Name Only/);
assert.match(partialFactsReply, /Duration Only/);
assert.match(partialFactsReply, /25 minutes/);
assert.match(partialFactsReply, /Price Only/);
assert.match(partialFactsReply, /450 SEK/);
assert.doesNotMatch(partialFactsReply, /undefined|null|NaN/);

console.log('shared service-catalog plan contract passed');

const missingNumericFactsPlan = buildConfiguredServiceCatalogPlan([
  { name: 'Null Price', price: null, currency: 'SEK' },
  { name: 'Empty Price', price: '', currency: 'SEK' },
  { name: 'Null Duration', durationMinutes: null },
  { name: 'Empty Duration', durationMinutes: '' },
]);

for (const service of missingNumericFactsPlan.displayedServices) {
  if (service.name.includes('Price')) {
    assert.equal(service.price, null, `${service.name} must not turn missing price into zero`);
  }
  if (service.name.includes('Duration')) {
    assert.equal(service.durationMinutes, null, `${service.name} must not turn missing duration into zero`);
  }
}

console.log('missing catalog numeric facts remain null');
