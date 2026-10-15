/** Current-turn control signals only; none authorizes an appointment mutation. */
const negatedAction = /\b(?:don['’]t|do\s+not|not\s+to)\s+(?:(?:want|wish|need)\s+to\s+)?(?:book|reserve|schedule|cancel|reschedule)\b|\b(?:jag\s+)?vill\s+inte\s+(?:boka|avboka|omboka)\b|\b(?:boka|avboka|omboka)\s+inte\b|\b(?:ich\s+)?(?:möchte|moechte|will)\b[^.!?؟;\n]{0,70}\b(?:nicht|nichts|keine[nmrs]?)\b[^.!?؟;\n]{0,40}\b(?:buchen|reservieren|stornieren|verschieben)\b|\b(?:ich\s+)?(?:möchte|moechte|will)\b[^.!?؟;\n]{0,50}\b(?:buchen|reservieren)\s+nicht\b|\bno\s+(?:quiero|deseo|quisiera)\s+(?:reservar|agendar|cancelar|cambiar)\b|نمی[‌\s]?(?:خواهم|خوام)[^.!?؟;\n]{0,70}(?:رزرو|وقت|لغو)|(?:رزرو|لغو)\s+نکن(?:ید)?|لا\s+(?:أريد|اريد|أرغب|ارغب)[^.!?؟;\n]{0,70}(?:حجز|أحجز|احجز|إلغاء|الغاء)|لا\s+(?:تحجز|تلغ)/iu;
const pauseAction = /\b(?:forget|pause|stop|leave)\b[^.!?؟;\n]{0,30}\b(?:booking|appointment|reservation)\b|\b(?:glöm|pausa|sluta\s+med)\b[^.!?؟;\n]{0,30}\b(?:bokning\w*|boka)\b|\b(?:vergiss|pausier\w*)\b[^.!?؟;\n]{0,40}\b(?:buchung|termin)\b|\b(?:olvida|pausa|deja)\b[^.!?؟;\n]{0,30}\b(?:reserva|cita)\b|(?:رزرو|وقت)[^.!?؟;\n]{0,30}(?:فعلا|فعلاً|فراموش|متوقف)|(?:فعلا|فعلاً)[^.!?؟;\n]{0,30}(?:رزرو|وقت)|(?:انس|أوقف|اوقف)[^.!?؟;\n]{0,30}(?:الحجز|حجز|الموعد)/iu;

export function withoutNegatedBookingClauses(text: string): string {
  // Preserve separately stated positive instructions, e.g. "Don't book X;
  // instead book Y". A negated clause must never supply a service label.
  if (!hasBookingInterruption(text)) return String(text || '').trim();
  return String(text || '').split(/(?<=[.!?؟;,،])\s*|\b(?:but|instead|men|utan|aber|sondern|pero|sino)\b|(?:اما|ولكن|لكن)/iu)
    .filter(clause => !negatedAction.test(clause) && !pauseAction.test(clause)).join(' ').trim();
}
export function hasBookingInterruption(text: string): boolean {
  return negatedAction.test(text) || pauseAction.test(text);
}
export function isBookingResumeRequest(text: string): boolean {
  return /\b(?:continue|resume)\b[^.!?؟\n]{0,65}\b(?:booking|appointment|reservation)\b|\b(?:fortsätt(?:a|er)?|återuppta)\b[^.!?؟\n]{0,65}\b(?:bokning\w*|boka)\b|\b(?:buchung|termin)\b[^.!?؟\n]{0,60}\b(?:fortsetzen|weitermachen)\b|\b(?:continuar|continuemos|retomar)\b[^.!?؟\n]{0,65}\b(?:reserva|cita)\b|(?:رزرو|وقت)[^.!?؟\n]{0,60}ادامه|ادامه[^.!?؟\n]{0,60}(?:رزرو|وقت)|(?:نكمل|أكمل|اكمل|متابعة)[^.!?؟\n]{0,60}(?:الحجز|حجز|الموعد)/iu.test(text) && !hasBookingInterruption(text);
}
export function bookingPauseReply(language: string, needsResume = false): string {
  const replies: Record<string, string[]> = {
    en: ['We can leave the booking for now. No appointment has been changed. Say “continue my booking” when you’re ready.', 'To resume the booking we discussed, say “continue my booking”.'],
    sv: ['Vi kan pausa bokningen tills vidare. Ingen bokad tid har ändrats. Säg ”fortsätt min bokning” när du är redo.', 'Säg ”fortsätt min bokning” för att återuppta bokningen vi pratade om.'],
    de: ['Wir können die Buchung vorerst pausieren. Kein bestehender Termin wurde geändert. Sagen Sie „Buchung fortsetzen“, wenn Sie bereit sind.', 'Sagen Sie „Buchung fortsetzen“, um die besprochene Buchung wieder aufzunehmen.'],
    es: ['Podemos dejar la reserva por ahora. No se ha cambiado ninguna cita. Di «continuar mi reserva» cuando quieras retomarla.', 'Di «continuar mi reserva» para retomar la reserva que comentamos.'],
    fa: ['فعلاً رزرو را متوقف می‌کنیم. هیچ نوبتی تغییر نکرده است. برای ادامه بگویید «ادامه رزرو».', 'برای ادامه رزروی که درباره‌اش صحبت کردیم، بگویید «ادامه رزرو».'],
    ar: ['يمكننا إيقاف طلب الحجز مؤقتاً. لم يتغير أي موعد. قل «متابعة الحجز» عندما تكون مستعداً.', 'قل «متابعة الحجز» لاستئناف الحجز الذي تحدثنا عنه.'],
  };
  return (replies[language] || replies.en)[needsResume ? 1 : 0];
}
