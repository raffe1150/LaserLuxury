// Explicit self-identification only; do not harvest names from booking prose.
// Keep the complete name rather than using the legacy two-word cleanup.
export function stripCustomerNameDiagnosticSuffix(text: string): string {
  // A diagnostic run marker is a boundary, never part of a person's name.
  // Require an opaque run identifier (hex or digit-bearing/UUID tokens)
  // or an abbreviated diagnostic placeholder so
  // ordinary prose and names containing the word AIBB are not silently cut.
  return text.replace(/\s+AIBB\s+(?:(?:[A-Fa-f\d]{8,}|[A-Za-z\p{N}_-]*\p{N}[A-Za-z\p{N}_-]*)(?=\s|[.,]|$)|\.{3}|…)[\s\S]*$/u, '').trim();
}

export function extractStandaloneArabicScriptCustomerName(text: string): string | null {
  const candidate = stripCustomerNameDiagnosticSuffix(text.normalize('NFKC'))
    .replace(/[.!۔]+$/u, '').trim();
  // Only called when collecting contact details. Keep bare input short and
  // reuse the explicit parser's Unicode validation and conversational rejection.
  if (!/^[\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+){0,1}$/u.test(candidate)) return null;
  if (/(?:^|\s)(?:نام|اسم|من|است|هست|هستم|الاسم)(?=\s|$)/u.test(candidate)) return null;
  return extractExplicitArabicCustomerName(`اسمي ${candidate}`);
}

export function extractExplicitArabicCustomerName(text: string): string | null {
  const raw = stripCustomerNameDiagnosticSuffix(text.normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim());
  const match = raw.match(/^(?:نعم[،,]?\s+)?(?:(?:أنا|انا)\s+)?(?:اسمي|إسمي|اسمی|إسمی|الاسم)\s+(.+?)\s*[.۔!]*$/u);
  if (!match) return null;
  const candidate = match[1].replace(
    /[،,]?\s+(?:و\s*)?(?:رقم\s+(?:هاتفي|هاتفی|الهاتف)|هاتفي|هاتفی|رقمي|رقمی)(?:\s+المحمول)?(?:\s+هو)?\s*[:：]?\s*\+?[0-9۰-۹٠-٩][0-9۰-۹٠-٩\s()-]{5,}[0-9۰-۹٠-٩]\s*$/u, ''
  ).trim();
  const words = candidate.split(/\s+/u);
  const arabicName = words.every(word =>
    /^[\p{Script=Arabic}\p{M}]+$/u.test(word) &&
    [...word].filter(char => /\p{L}/u.test(char)).length >= 2 &&
    !/[\p{N}\p{P}\p{S}]/u.test(word)
  );
  const latinName = words.every(word => /^[A-Za-zÅÄÖåäöÉéÜüÁáÍíÓóÚúÑñÇçŞşĞğ'-]{2,}$/u.test(word));
  if (words.length > 6 || (!arabicName && !latinName)) return null;
  const normalized = candidate.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[يى]/gu, 'ی');
  // Reject conversational/field tokens rather than trimming them into a name.
  if (/(?:^|\s)(?:ارید|وارید|حجز|موعد|خدمة|خدمه|رقم|ورقم|هاتفی|نعم|لا|اسمی|تغییر|الغاء|احجز|الحجز|الموعد)(?=\s|$)/u.test(normalized)) return null;
  return words.join(' ');
}
