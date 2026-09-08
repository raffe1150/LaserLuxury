import assert from 'node:assert/strict';
import { isBusinessInformationQuestion } from './business-information';

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
