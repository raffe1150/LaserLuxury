import { withoutTemporalBookingAttribute } from './booking-operation-reference';
// Remove only the local predicate of an explicit modal/non-success form from
// the detection copy. Never exempt a sentence or change the published text:
// another completed predicate, even in the same sentence, remains detectable.
const nonAssertedPredicates = [
  /\b(?:must|should|can|may|could|need(?:s)? to|ha(?:s|ve) to|ought to)\s+(?:be|get)\s+(?:successfully\s+)?(?:booked|confirmed|reserved|created|secured|cancelled|canceled|rescheduled|moved)\b/giu,
  /\b(?:not|never)\s+(?:(?:been|be|yet|successfully)\s+){0,2}(?:booked|confirmed|reserved|created|secured|cancelled|canceled|rescheduled|moved)\b/giu,
  /\b(?:isn|aren|wasn|weren|hasn|haven|hadn)['’]t\s+(?:been\s+)?(?:booked|confirmed|reserved|created|secured|cancelled|canceled|rescheduled|moved)\b/giu,
  /\b(?:cannot|can't|couldn't)\s+(?:be|get)\s+(?:booked|confirmed|reserved|cancelled|canceled|rescheduled|moved)\b/giu,
  /\b(?:måste|ska|skall|bör|kan|behöver)\s+(?:vara|bli)\s+(?:bokad|bekräftad|reserverad|avbokad|ombokad|flyttad)\b/giu,
  /\b(?:inte|ej|aldrig)\s+(?:(?:blivit|vara|bli|ännu)\s+){0,2}(?:bokad|bekräftad|reserverad|avbokad|ombokad|flyttad)\b/giu,
  /\b(?:muss|müssen|soll|sollen|sollte|sollten|kann|können|darf|dürfen)\s+(?:gebucht|bestätigt|reserviert|storniert|verschoben|umgebucht)\s+werden\b/giu,
  /\b(?:nicht|nie)\s+(?:(?:bereits|schon|erfolgreich)\s+)?(?:gebucht|bestätigt|reserviert|storniert|verschoben|umgebucht)\b/giu,
  /\b(?:debe|deben|debería|deberían|puede|pueden|podría|podrían)\s+ser\s+(?:reservada|confirmada|creada|cancelada|reprogramada)\b/giu,
  /\bno\s+(?:(?:ha|han)\s+sido\s+|(?:está|están|fue|fueron)\s+)(?:reservada|confirmada|creada|cancelada|reprogramada)\b/giu,
  /\bno\s+(?:he|hemos)\s+(?:cancelado|reservado|confirmado|reprogramado)\b/giu,
  /(?:يجب|ينبغي|يمكن)\s+(?:أن\s+)?(?:يتم\s+(?:إلغاء|الغاء|تغيير|تعديل|حجز|تأكيد|تاكيد)(?:\s+(?:الموعد|الحجز))?|يكون\s+(?:ملغي|معدل|محجوز|مؤكد))/gu,
  /(?:لم|لن)\s+يتم\s+(?:إلغاء|الغاء|تغيير|تعديل|حجز|تأكيد|تاكيد|الحجز|التأكيد|التاكيد)|(?:ليس|غير)\s+(?:ملغي|معدل|محجوز|مؤكد)/gu,
  /(?:لغو|ثبت|رزرو|تأیید|قطعی)\s+نشد(?:ه)?|تغییر\s+نکرد/gu,
  /(?:باید|نباید|می‌تواند|می‌بایست)\s+(?:لغو|ثبت|رزرو|تأیید|قطعی)\s+شده\s+باشد/gu,
  /ما\s+(?:ألغيت|الغيت|حجزت|أكدت|عدلت)/gu,
];

function assertedOperationProse(sentence: string): string {
  // Keep the subject close to subsequent predicates sharing it, rather than
  // padding away its first predicate and pushing a success past the scan bound.
  return nonAssertedPredicates.reduce((copy, pattern) => copy.replace(pattern, ' '), sentence);
}

// Website has no mutation executor. This guard applies to model prose only;
// deterministic lookup/continuation responses retain their existing evidence.
export function containsWebOperationSuccess(text: string): boolean {
  const normalized = String(text || '').normalize('NFKC');
  return normalized.split(/[.!?\n؟。]+/u).some(original => {
    const sentence = withoutTemporalBookingAttribute(assertedOperationProse(original));
    // Positive booking predicates are checked locally here; the shared guard's
    // sentence-wide negation exemption could hide a second affirmative claim.
    return /\b(?:appointment|booking|slot|time)\b.{0,40}\b(?:booked|confirmed|reserved|created|secured)\b|\b(?:booked|confirmed|reserved|created|secured)\b.{0,40}\b(?:appointment|booking|slot|time)\b/iu.test(sentence) ||
    /\b(?:tid|bokning)\b.{0,35}\b(?:bokad|bekräftad|reserverad)\b|\b(?:termin|buchung)\b.{0,35}\b(?:gebucht|bestätigt|reserviert)\b|\b(?:cita|reserva)\b.{0,35}\b(?:reservada|confirmada|creada)\b/iu.test(sentence) ||
    /(?:وقت|نوبت|رزرو).{0,30}(?:رزرو شد|ثبت شد|تأیید شد|قطعی شد)|(?<![\p{L}\p{N}])(?:و|ف)?تم\s+(?:حجز|تأكيد)|موعدك.{0,25}(?:محجوز|مؤكد)/u.test(sentence) ||
    /\bI(?:'ve| have)?\s+(?:successfully\s+)?(?:booked|reserved|rescheduled|cancelled|canceled)\b/iu.test(sentence) ||
    /\bJag\s+(?:har\s+)?(?:bokat|bekräftat|avbokat|ombokat|flyttat)\b|\b(?:he|hemos)\s+(?:cancelado|reservado|confirmado|reprogramado)\b/iu.test(sentence) ||
    /(?:وقت|نوبت|رزرو).{0,30}(?:لغو|رزرو|ثبت|تأیید)\s+کردم|(?:ألغيت|الغيت|حجزت|أكدت|عدلت).{0,30}(?:موعد|حجز)/u.test(sentence) ||
    /(?<![\p{L}\p{N}])(?:و|ف)?تم\s+(?:الحجز|التأكيد|التاكيد)|حجزك.{0,20}مؤكد/u.test(sentence) ||
    /\b(?:appointment|booking|reservation)\b.{0,50}\b(?:cancelled|canceled|rescheduled|moved)\b|\b(?:cancelled|canceled|rescheduled)\b.{0,50}\b(?:appointment|booking|reservation)\b/iu.test(sentence) ||
    /\b(?:bokning|tid)\b.{0,35}\b(?:avbokad|ombokad|flyttad)\b|\b(?:termin|buchung)\b.{0,35}\b(?:storniert|verschoben|umgebucht)\b|\b(?:cita|reserva)\b.{0,35}\b(?:cancelada|reprogramada)\b/iu.test(sentence) ||
    /(?:رزرو|وقت|نوبت).{0,30}(?:لغو شد|تغییر کرد)|(?<![\p{L}\p{N}])(?:و|ف)?تم\s+(?:إلغاء|الغاء|تغيير|تعديل)|موعدك.{0,20}(?:ملغي|معدل)/u.test(sentence) ||
    /\b(?:you(?:'re| are) all set|see you (?:on|at|tomorrow)|booking (?:complete|successful)|successfully (?:booked|rescheduled|cancelled|canceled))\b/iu.test(sentence)
  });
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
