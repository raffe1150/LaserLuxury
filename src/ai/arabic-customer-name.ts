// Explicit self-identification only; do not harvest names from booking prose.
// Keep the complete name rather than using the legacy two-word cleanup.
export function extractExplicitArabicCustomerName(text: string): string | null {
  const raw = text.normalize('NFKC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  const match = raw.match(/^(?:نعم[،,]?\s+)?(?:(?:أنا|انا)\s+)?(?:اسمي|إسمي|اسمی|إسمی|الاسم)\s+(.+?)\s*[.۔!]*$/u);
  if (!match) return null;
  const candidate = match[1].replace(
    /[،,]?\s+(?:و\s*)?(?:رقم\s+(?:هاتفي|هاتفی|الهاتف)|هاتفي|هاتفی|رقمي|رقمی)\s*[:：]?\s*\+?[0-9۰-۹٠-٩][0-9۰-۹٠-٩\s()-]{5,}[0-9۰-۹٠-٩]\s*$/u, ''
  ).trim();
  const words = candidate.split(/\s+/u);
  if (words.length > 6 || words.some(word =>
    !/^[\p{Script=Arabic}\p{M}]+$/u.test(word) ||
    [...word].filter(char => /\p{L}/u.test(char)).length < 2 ||
    /[\p{N}\p{P}\p{S}]/u.test(word)
  )) return null;
  const normalized = candidate.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[يى]/gu, 'ی');
  // Reject conversational/field tokens rather than trimming them into a name.
  if (/(?:^|\s)(?:ارید|وارید|حجز|موعد|خدمة|خدمه|رقم|ورقم|هاتفی|نعم|لا|اسمی|تغییر|الغاء|احجز|الحجز|الموعد)(?=\s|$)/u.test(normalized)) return null;
  return words.join(' ');
}
