import assert from 'node:assert/strict';
import { documentKnowledgeTopicsEligible, wholeQuestionInformationPlan } from './knowledge-planning';
import {
  buildConfiguredServiceCatalogPlan,
  formatConfiguredServiceCatalogPlan,
  isBusinessInformationQuestion,
  isBusinessRecommendationQuestion,
  isServiceCatalogQuestion,
} from './business-information';

for (const text of [
  'Tell me about the company and services before I book.',
  'Ich möchte mich erstmal informieren, bevor ich etwas buche. Können Sie mir etwas über Ihr Unternehmen erzählen?',
  'What are your service prices?', 'Kan du beskriva era tjänster?',
  '¿Qué servicios ofrece la empresa?', 'لطفاً درباره خدمات توضیح بدهید.', 'ما الخدمات التي تقدمها الشركة؟',
  'Gibt es eine zentrale Übersichtsseite?',
  'هل يوجد موقف سيارات لديكم؟',
  'What would you recommend for a first-time visitor?',
]) assert.equal(isBusinessInformationQuestion(text), true, text);

for (const text of [
  'What would you recommend for a first-time visitor?',
  'Vad rekommenderar ni för någon som kommer första gången?',
  'Welche Leistung empfehlen Sie beim ersten Besuch?',
  '¿Qué servicio recomiendan para mi primera visita?',
  'برای اولین مراجعه چه خدمتی پیشنهاد می‌کنید؟',
  'ما الخدمة التي توصي بها لأول مرة؟',
  'Recommend a service for a first-time visitor',
]) {
  assert.equal(isBusinessRecommendationQuestion(text), true, text);
  assert.equal(isBusinessInformationQuestion(text), true, text);
}
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
 'I am visiting for the first time. Where is the entrance and is there an elevator?',
 'Jag ska besöka er för första gången. Var är entrén och finns det hiss?',
 'Ich besuche Sie zum ersten Mal. Wo ist der Eingang und gibt es einen Aufzug?',
 'Voy por primera vez. ¿Dónde está la entrada y hay ascensor?',
 'برای بار اول مراجعه می‌کنم. ورودی کجاست و آیا آسانسور هست؟',
 'سأزوركم لأول مرة. أين المدخل وهل يوجد مصعد؟',
]) {
 assert.equal(isBusinessRecommendationQuestion(text),false,text);
 assert.equal(isBusinessInformationQuestion(text),true,text);
 assert.equal(documentKnowledgeTopicsEligible(text),true,text);
}
for (const text of ['What is your address?', 'Vad är er adress?', 'Was ist Ihre Adresse?', '¿Cuál es su dirección?', 'آدرس شما چیست؟', 'ما عنوانكم؟',
 'Where is the entrance and what is your email?', 'Var är entrén och vad är er adress?'])
 assert.equal(documentKnowledgeTopicsEligible(text),false,text);
for (const text of [
 'What happens if I arrive more than 15 minutes late? Is my appointment automatically cancelled?',
 'Vad händer om jag kommer mer än 15 minuter sent? Avbokas besöket automatiskt?',
 'Was passiert, wenn ich mehr als 15 Minuten zu spät komme? Wird mein Termin automatisch storniert?',
 '¿Qué ocurre si llego más de 15 minutos tarde? ¿Se cancela la cita automáticamente?',
 'اگر بیش از 15 دقیقه دیر برسم چه می‌شود؟ آیا مراجعه خودکار لغو می‌شود؟',
 'ماذا يحدث إذا تأخرت أكثر من 15 دقيقة عن الزيارة؟ هل يتم إلغاء الموعد تلقائيًا؟',
]) {
 const plan=wholeQuestionInformationPlan(text,isBusinessInformationQuestion(text));
 assert.ok(plan,text);assert.equal(plan.requestedFacets[0].obligations[0].description,text);
}


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

// Permission/possibility questions do not authorize executing the named action.
for (const text of [
 'Thanks! And can I reserve a spot there in advance?',
 'Is it possible to book parking?', 'Can this service be cancelled?',
 "What's the cancellation policy for that?", 'Do I need to reserve a place before visiting?',
 'Kan jag reservera en plats där i förväg?', 'Kan den tjänsten avbokas?',
 'Kann ich dort im Voraus einen Platz reservieren?', 'Kann dieser Service storniert werden?',
 '¿Puedo reservar una plaza allí con antelación?', '¿Se puede cancelar ese servicio?',
 'آیا می‌توانم از قبل آنجا جا رزرو کنم؟', 'آیا می‌توان این خدمت را لغو کرد؟',
 'هل يمكنني حجز مكان هناك مسبقًا؟', 'هل يمكن إلغاء هذه الخدمة؟',
]) assert.equal(isBusinessInformationQuestion(text), true, text);
for (const text of [
 "I'd like to book a video consultation for Tuesday.", 'Please cancel my appointment tomorrow.',
 'Move my booking to Friday.', 'Book that service for me.',
 "Can I reserve a spot there? I'd like to book Video Consultation for Tuesday.",
 'Can I reserve a spot there? Please book Video Consultation for Tuesday.',
 'Kan jag reservera en plats där? Boka en Video Consultation åt mig.',
 'Kann ich dort reservieren? Bitte buchen Sie Video Consultation.',
 '¿Puedo reservar allí? Quiero reservar Video Consultation.',
 'آیا می‌توانم آنجا رزرو کنم؟ Video Consultation را رزرو کنید.',
 'هل يمكنني الحجز هناك؟ احجز Video Consultation.',
]) assert.equal(isBusinessInformationQuestion(text), false, text);
