import { APPOINTMENT_TEMPLATE_FACTS, hasCompatibleAppointmentTemplateBody } from './appointment-template-contract';

export const WHATSAPP_REMINDER_LANGUAGES = ['en', 'sv', 'de', 'es', 'fa', 'ar'] as const;
export type ReminderLanguage = typeof WHATSAPP_REMINDER_LANGUAGES[number];
export const APPOINTMENT_REMINDER_BODIES: Record<ReminderLanguage, string> = {
  en: 'Hi {{1}}! A friendly reminder from {{5}}: you have an appointment for {{2}} on {{3}} at {{4}}. We look forward to seeing you! 😊',
  sv: 'Hej {{1}}! En vänlig påminnelse från {{5}}: du har en bokad tid för {{2}} den {{3}} kl. {{4}}. Vi ser fram emot att träffa dig! 😊',
  de: 'Hallo {{1}}! Eine freundliche Erinnerung von {{5}}: Sie haben am {{3}} um {{4}} einen Termin für {{2}}. Wir freuen uns auf Ihren Besuch! 😊',
  es: 'Hola {{1}}! Un recordatorio amistoso de {{5}}: tienes una cita para {{2}} el {{3}} a las {{4}}. ¡Esperamos verte pronto! 😊',
  fa: 'سلام {{1}} عزیز! یک یادآوری دوستانه از طرف {{5}}: شما برای {{2}} در تاریخ {{3}} ساعت {{4}} وقت دارید. خوشحال می‌شویم ببینیمتان! 😊',
  ar: 'مرحباً {{1}}! تذكير ودي من {{5}}: لديك موعد لخدمة {{2}} بتاريخ {{3}} الساعة {{4}}. يسعدنا رؤيتك! 😊',
};
// Synthetic, non-customer sample facts, always indexed by placeholder number.
const EXAMPLES: Record<ReminderLanguage, string[]> = {
  en: ['Alex', 'Consultation', '2026-12-10', '14:00', 'Example Studio'],
  sv: ['Alex', 'Konsultation', '2026-12-10', '14:00', 'Exempelstudio'],
  de: ['Alex', 'Beratung', '2026-12-10', '14:00', 'Beispielstudio'],
  es: ['Alex', 'Consulta', '2026-12-10', '14:00', 'Estudio Ejemplo'],
  fa: ['علی', 'مشاوره', '2026-12-10', '14:00', 'استودیو نمونه'],
  ar: ['علي', 'استشارة', '2026-12-10', '14:00', 'استوديو المثال'],
};
export function canonicalAppointmentReminder(language: ReminderLanguage) {
  return { name: 'appointment_reminder', language, category: 'UTILITY', parameter_format: 'POSITIONAL',
    components: [{ type: 'BODY', text: APPOINTMENT_REMINDER_BODIES[language], example: { body_text: [[...EXAMPLES[language]]] } }] };
}
export function isCanonicalAppointmentReminder(template: any, language: ReminderLanguage): boolean {
  return template?.name === 'appointment_reminder' && template.language === language && template.category === 'UTILITY' &&
    hasCompatibleAppointmentTemplateBody(template, APPOINTMENT_TEMPLATE_FACTS.length, true) &&
    template.components.length === 1 && template.components[0].text === APPOINTMENT_REMINDER_BODIES[language];
}
