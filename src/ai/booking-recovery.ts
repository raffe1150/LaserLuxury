export type DeterministicFailureCategory =
  | 'calendar_unavailable'
  | 'calendar_create_failed'
  | 'calendar_verification_failed'
  | 'database_insert_failed'
  | 'database_verification_failed'
  | 'idempotency_settlement_failed'
  | 'reschedule_update_failed'
  | 'cancellation_failed'
  | 'slot_expired'
  | 'stale_operation'
  | 'invalid_phone'
  | 'ambiguous_appointment';

const messages: Record<string, Record<DeterministicFailureCategory, string>> = {
  en: {
    calendar_unavailable: 'I can’t reach the calendar right now. I kept your booking details—please try again in a moment.',
    calendar_create_failed: 'I couldn’t create the calendar appointment. Your selected time and contact details are saved here; please confirm again shortly.',
    calendar_verification_failed: 'I couldn’t verify the calendar appointment, so I have not confirmed the booking. Your details are kept for a safe retry.',
    database_insert_failed: 'The calendar step could not be safely saved to the booking register, so the booking was not confirmed. Your details are kept for retry.',
    database_verification_failed: 'I couldn’t verify the booking record, so I have not confirmed the appointment. Your details are kept for a safe retry.',
    idempotency_settlement_failed: 'I couldn’t safely complete the booking transaction, so I have not confirmed it. Please confirm again shortly.',
    reschedule_update_failed: 'I couldn’t verify the reschedule. Your selected new time is still saved here; please confirm again shortly.',
    cancellation_failed: 'I couldn’t verify the cancellation, so I have not said the appointment is cancelled. Please try confirming again shortly.',
    slot_expired: 'That time is no longer available. Please choose one of the refreshed times.',
    stale_operation: 'That booking step has expired. I’ll safely check the appointment again before making any change.',
    invalid_phone: 'That mobile number does not look valid. Please send a number with 7–15 digits.',
    ambiguous_appointment: 'I found more than one matching appointment. Please choose the list number you mean.',
  },
  sv: {
    calendar_unavailable: 'Jag kan inte nå kalendern just nu. Dina bokningsuppgifter finns kvar—försök gärna igen om en liten stund.',
    calendar_create_failed: 'Jag kunde inte skapa kalenderbokningen. Din valda tid och kontaktuppgifter finns kvar; bekräfta gärna igen om en stund.',
    calendar_verification_failed: 'Jag kunde inte verifiera kalenderbokningen och har därför inte bekräftat tiden. Uppgifterna finns kvar för ett säkert nytt försök.',
    database_insert_failed: 'Kalendersteget kunde inte sparas säkert i bokningsregistret, så bokningen är inte bekräftad. Uppgifterna finns kvar.',
    database_verification_failed: 'Jag kunde inte verifiera bokningsposten och har därför inte bekräftat tiden. Uppgifterna finns kvar.',
    idempotency_settlement_failed: 'Jag kunde inte slutföra bokningen säkert och har därför inte bekräftat den. Bekräfta gärna igen om en stund.',
    reschedule_update_failed: 'Jag kunde inte verifiera ombokningen. Din valda nya tid finns kvar; bekräfta gärna igen om en stund.',
    cancellation_failed: 'Jag kunde inte verifiera avbokningen och har därför inte sagt att tiden är avbokad. Försök gärna bekräfta igen.',
    slot_expired: 'Den tiden är inte längre ledig. Välj gärna en av de uppdaterade tiderna.',
    stale_operation: 'Det bokningssteget har gått ut. Jag kontrollerar bokningen igen innan någon ändring görs.',
    invalid_phone: 'Mobilnumret verkar inte giltigt. Skicka ett nummer med 7–15 siffror.',
    ambiguous_appointment: 'Jag hittade flera matchande bokningar. Svara med numret i listan.',
  },
  fa: {
    calendar_unavailable: 'الان به تقویم دسترسی ندارم. اطلاعات رزروتان محفوظ است؛ لطفاً کمی بعد دوباره تلاش کنید.',
    calendar_create_failed: 'نتوانستم وقت را در تقویم ایجاد کنم. زمان و اطلاعات تماس شما محفوظ است؛ لطفاً کمی بعد دوباره تأیید کنید.',
    calendar_verification_failed: 'نتوانستم ثبت تقویم را تأیید کنم، بنابراین رزرو را قطعی اعلام نمی‌کنم. اطلاعات برای تلاش امن بعدی محفوظ است.',
    database_insert_failed: 'ثبت تقویم با اطمینان در سامانه رزرو ذخیره نشد، بنابراین رزرو تأیید نشده است. اطلاعات شما محفوظ است.',
    database_verification_failed: 'نتوانستم رکورد رزرو را تأیید کنم، بنابراین وقت را قطعی اعلام نمی‌کنم. اطلاعات شما محفوظ است.',
    idempotency_settlement_failed: 'نتوانستم تراکنش رزرو را امن نهایی کنم، بنابراین رزرو تأیید نشده است. لطفاً کمی بعد دوباره تأیید کنید.',
    reschedule_update_failed: 'نتوانستم تغییر وقت را تأیید کنم. زمان جدید انتخاب‌شده محفوظ است؛ لطفاً کمی بعد دوباره تأیید کنید.',
    cancellation_failed: 'نتوانستم لغو را تأیید کنم، بنابراین اعلام نمی‌کنم که وقت لغو شده است. لطفاً کمی بعد دوباره تأیید کنید.',
    slot_expired: 'آن زمان دیگر خالی نیست. لطفاً یکی از زمان‌های تازه را انتخاب کنید.',
    stale_operation: 'این مرحله منقضی شده است. قبل از هر تغییری دوباره رزرو را بررسی می‌کنم.',
    invalid_phone: 'شماره موبایل معتبر به نظر نمی‌رسد. لطفاً شماره‌ای با ۷ تا ۱۵ رقم بفرستید.',
    ambiguous_appointment: 'بیش از یک رزرو مطابق پیدا شد. لطفاً شماره موردنظر در فهرست را بفرستید.',
  },
};

export function formatDeterministicRecovery(category: DeterministicFailureCategory, language = 'en'): string {
  const localized = messages[language] || messages.en;
  return localized[category] || messages.en[category];
}
