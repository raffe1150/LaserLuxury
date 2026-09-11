import assert from 'node:assert/strict';
import { isBusinessInformationQuestion, isServiceCatalogQuestion } from './business-information';

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
