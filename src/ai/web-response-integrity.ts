import { containsUnverifiedBookingSuccessClaim } from './reliability';

// Website has no mutation executor. This guard applies to model prose only;
// deterministic lookup/continuation responses retain their existing evidence.
export function containsWebOperationSuccess(text: string): boolean {
  const normalized = String(text || '').normalize('NFKC');
  return normalized.split(/[.!?\n]+/u).some(sentence =>
    containsUnverifiedBookingSuccessClaim(sentence) ||
    /\bI(?:'ve| have)?\s+(?:successfully\s+)?(?:booked|reserved|rescheduled|cancelled|canceled)\b/iu.test(sentence) ||
    /(?:تم\s+(?:الحجز|التأكيد|التاكيد)|حجزك.{0,20}مؤكد)/u.test(sentence) ||
    /\b(?:appointment|booking|reservation)\b.{0,50}\b(?:cancelled|canceled|rescheduled|moved)\b|\b(?:cancelled|canceled|rescheduled)\b.{0,50}\b(?:appointment|booking|reservation)\b/iu.test(sentence) ||
    /\b(?:bokning|tid)\b.{0,35}\b(?:avbokad|ombokad|flyttad)\b|\b(?:termin|buchung)\b.{0,35}\b(?:storniert|verschoben|umgebucht)\b|\b(?:cita|reserva)\b.{0,35}\b(?:cancelada|reprogramada)\b/iu.test(sentence) ||
    /(?:رزرو|وقت|نوبت).{0,30}(?:لغو شد|تغییر کرد)|(?:تم\s+(?:إلغاء|الغاء|تغيير|تعديل)|موعدك.{0,20}(?:ملغي|معدل))/u.test(sentence) ||
    /\b(?:you(?:'re| are) all set|see you (?:on|at|tomorrow)|booking (?:complete|successful)|successfully (?:booked|rescheduled|cancelled|canceled))\b/iu.test(sentence)
  );
}

export function webUnverifiedOperationReply(language: string): string {
  const replies: Record<string,string> = {
    en: 'I cannot verify a booking change here. Please contact the business to confirm your request.',
    sv: 'Jag kan inte verifiera en bokningsändring här. Kontakta verksamheten för att bekräfta din förfrågan.',
    de: 'Ich kann hier keine Buchungsänderung verifizieren. Bitte kontaktieren Sie das Unternehmen, um Ihre Anfrage zu bestätigen.',
    es: 'No puedo verificar un cambio de reserva aquí. Contacta con el negocio para confirmar tu solicitud.',
    ar: 'لا يمكنني التحقق من تغيير الحجز هنا. يرجى التواصل مع المنشأة لتأكيد طلبك.',
    fa: 'اینجا نمی‌توانم تغییر رزرو را تأیید کنم. لطفاً برای تأیید درخواست خود با مجموعه تماس بگیرید.',
  };
  return replies[language] || replies.en;
}
