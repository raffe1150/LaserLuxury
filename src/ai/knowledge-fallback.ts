/** Contextual Knowledge fallback (S1). Deterministic and fact-free: it never
 * states a business fact, never claims that information does not exist when
 * retrieval, extraction or verification merely failed, and varies only with the
 * turn's own state (failure category, the customer's question, and whether the
 * previous assistant turn in this conversation was the same fallback). */
import { formatBusinessSupportVerificationUnavailable } from './business-information';

export type KnowledgeFallbackCategory = 'VERIFICATION' | 'NO_EVIDENCE' | 'TIMEOUT' | 'TECHNICAL';
export type KnowledgeFallbackLanguage = 'en' | 'sv' | 'de' | 'es' | 'fa' | 'ar';
const LANGUAGES: readonly string[] = ['en', 'sv', 'de', 'es', 'fa', 'ar'];

const TIMEOUT_REASONS = new Set(['DEADLINE', 'PUBLICATION_RESERVE', 'NATURAL_TIMEOUT']);
// Positively identified runtime faults only. PROVIDER_FAILURE is excluded: it is
// also the generic mapping for budget-owner denials, so it cannot prove a
// technical fault. Spending/admission controls and model refusals likewise keep
// the conservative VERIFICATION wording.
const TECHNICAL_REASONS = new Set(['MALFORMED_RESPONSE', 'MALFORMED_JSON', 'TRUNCATED',
  'VALIDATOR_ERROR', 'SOURCE_UNAVAILABLE', 'SOURCE_NOT_READY', 'EVIDENCE_PACKING_FAILED', 'TOOL_OUTPUT']);

/** Categorise only from backend-owned signals. Anything not positively
 * identified falls back to VERIFICATION, the existing conservative wording. */
export function classifyKnowledgeFallback(signals: Readonly<{ timingFailure?: boolean; freshnessFailure?: string | null;
  fallbackReason?: string | null; retrievalStatus?: string | null }>): KnowledgeFallbackCategory {
  const { timingFailure, freshnessFailure, fallbackReason, retrievalStatus } = signals;
  if (timingFailure || freshnessFailure === 'DEADLINE' || fallbackReason && TIMEOUT_REASONS.has(fallbackReason)) return 'TIMEOUT';
  if (retrievalStatus === 'failed' || retrievalStatus === 'partial' || retrievalStatus === 'invalid' ||
      fallbackReason && TECHNICAL_REASONS.has(fallbackReason)) return 'TECHNICAL';
  // "Nothing found" requires BOTH a completed retrieval that returned no
  // evidence and a pipeline that stopped for that reason.
  if (fallbackReason === 'NO_EVIDENCE' && retrievalStatus === 'empty') return 'NO_EVIDENCE';
  return 'VERIFICATION';
}

const genericSubject: Record<KnowledgeFallbackLanguage, string> = {
  en: 'the requested details', sv: 'de efterfrågade uppgifterna', de: 'die angefragten Einzelheiten',
  es: 'los detalles solicitados', fa: 'جزئیات درخواست‌شده', ar: 'التفاصيل المطلوبة',
};
const quotes: Record<KnowledgeFallbackLanguage, [string, string]> = {
  en: ['“', '”'], sv: ['”', '”'], de: ['„', '“'], es: ['«', '»'], fa: ['«', '»'], ar: ['«', '»'],
};

/** The customer's own question, quoted, when it is short and plain enough to
 * echo safely: one sentence, at most one terminal question mark, no line breaks,
 * markup, quotes, URLs or long numbers. Otherwise null (generic subject). */
export function quotableQuestion(question: string, language: string): string | null {
  if (/[\r\n\u2028\u2029]/u.test(question.trim())) return null;
  const text = question.trim().replace(/\s+/gu, ' ');
  if (text.length < 8 || text.length > 90 || !/^[\p{L}\p{M}\p{N}‌ ,،'’\-?؟¿()]+$/u.test(text) ||
      /\d{4}|https?|www\./iu.test(text) || (text.match(/[?؟]/gu) || []).length > 1 || /[?؟]./u.test(text)) return null;
  // Intake normalises Arabic-script punctuation; restore it for RTL rendering.
  return language === 'fa' || language === 'ar' ? text.replace(/\?/gu, '؟').replace(/,/gu, '،') : text;
}

const timeout: Record<KnowledgeFallbackLanguage, (s: string) => string> = {
  en: s => `Checking ${s} is taking longer than expected, so I can’t give a verified answer right now. Please send your question again in a moment.`,
  sv: s => `Det tar längre tid än väntat att kontrollera ${s}, så jag kan inte ge ett bekräftat svar just nu. Skicka gärna frågan igen om en stund.`,
  de: s => `Die Prüfung dauert länger als erwartet, daher kann ich ${s} gerade nicht bestätigen. Bitte senden Sie Ihre Frage gleich noch einmal.`,
  es: s => `Comprobar ${s} está tardando más de lo previsto, así que ahora no puedo darte una respuesta verificada. Vuelve a enviar tu pregunta en un momento.`,
  fa: s => `بررسی ${s} بیشتر از حد انتظار طول کشید، به همین دلیل الان نمی‌توانم پاسخ تأییدشده‌ای بدهم. لطفاً چند لحظه دیگر سؤالتان را دوباره بفرستید.`,
  ar: s => `استغرق التحقق من ${s} وقتًا أطول من المتوقع، لذلك لا أستطيع تقديم إجابة مؤكدة الآن. يُرجى إعادة إرسال سؤالك بعد قليل.`,
};
const technical: Record<KnowledgeFallbackLanguage, (s: string) => string> = {
  en: s => `I can’t check ${s} right now because of a temporary technical problem. Please try again shortly.`,
  sv: s => `Jag kan inte kontrollera ${s} just nu på grund av ett tillfälligt tekniskt fel. Försök gärna igen om en liten stund.`,
  de: s => `Ich kann ${s} wegen eines vorübergehenden technischen Problems gerade nicht prüfen. Bitte versuchen Sie es in Kürze erneut.`,
  es: s => `Ahora no puedo comprobar ${s} por un problema técnico temporal. Inténtalo de nuevo en un rato.`,
  fa: s => `به دلیل یک مشکل فنی موقت، الان نمی‌توانم ${s} را بررسی کنم. لطفاً کمی بعد دوباره امتحان کنید.`,
  ar: s => `لا أستطيع التحقق من ${s} الآن بسبب مشكلة تقنية مؤقتة. يُرجى المحاولة مرة أخرى بعد قليل.`,
};
const noEvidence: Record<KnowledgeFallbackLanguage, (s: string) => string> = {
  en: s => `I couldn’t find anything about ${s} in the information the business has shared with me. The business can confirm what applies.`,
  sv: s => `Jag hittade inget om ${s} i den information verksamheten har delat med mig. Verksamheten kan bekräfta vad som gäller.`,
  de: s => `In den Informationen, die mir das Unternehmen bereitgestellt hat, habe ich nichts gefunden, das ${s} beantwortet. Das Unternehmen kann bestätigen, was gilt.`,
  es: s => `No encontré nada sobre ${s} en la información que el negocio ha compartido conmigo. El negocio puede confirmar lo que corresponde.`,
  fa: s => `در اطلاعاتی که مجموعه در اختیار من گذاشته، چیزی دربارهٔ ${s} پیدا نکردم. خود مجموعه می‌تواند مورد دقیق را تأیید کند.`,
  ar: s => `لم أجد شيئًا عن ${s} في المعلومات التي شاركها النشاط التجاري معي. يمكن للنشاط التجاري تأكيد ما ينطبق.`,
};
// Second identical fallback in a row: no repeated apology, a different and
// supported next step, still no fact and no absence claim.
const repeatedUnconfirmed: Record<KnowledgeFallbackLanguage, (s: string) => string> = {
  en: s => `I still can’t confirm ${s} from the information available to me, so it’s best to ask the business directly.`,
  sv: s => `Jag kan fortfarande inte bekräfta ${s} utifrån den information jag har, så det är bäst att fråga verksamheten direkt.`,
  de: s => `Ich kann ${s} mit den mir vorliegenden Informationen weiterhin nicht bestätigen. Am besten fragen Sie direkt beim Unternehmen nach.`,
  es: s => `Sigo sin poder confirmar ${s} con la información de la que dispongo, así que lo mejor es preguntar directamente al negocio.`,
  fa: s => `هنوز نمی‌توانم ${s} را بر اساس اطلاعاتی که دارم تأیید کنم؛ بهتر است مستقیماً از خود مجموعه بپرسید.`,
  ar: s => `ما زلت لا أستطيع تأكيد ${s} من المعلومات المتاحة لي، لذا من الأفضل أن تسأل النشاط التجاري مباشرة.`,
};
const repeatedUnavailable: Record<KnowledgeFallbackLanguage, (s: string) => string> = {
  en: s => `Checking ${s} still isn’t working right now. You can try again a little later, or ask the business directly.`,
  sv: s => `Det går fortfarande inte att kontrollera ${s} just nu. Du kan försöka igen lite senare eller fråga verksamheten direkt.`,
  de: s => `Ich kann ${s} gerade weiterhin nicht prüfen. Sie können es etwas später erneut versuchen oder direkt beim Unternehmen nachfragen.`,
  es: s => `Todavía no puedo comprobar ${s} en este momento. Puedes intentarlo un poco más tarde o preguntar directamente al negocio.`,
  fa: s => `هنوز امکان بررسی ${s} وجود ندارد. می‌توانید کمی بعد دوباره امتحان کنید یا مستقیماً از خود مجموعه بپرسید.`,
  ar: s => `ما زال التحقق من ${s} غير ممكن الآن. يمكنك المحاولة لاحقًا أو السؤال مباشرة لدى النشاط التجاري.`,
};

function render(category: KnowledgeFallbackCategory, language: KnowledgeFallbackLanguage, subject: string, repeated: boolean): string {
  if (repeated) return (category === 'TIMEOUT' || category === 'TECHNICAL' ? repeatedUnavailable : repeatedUnconfirmed)[language](subject);
  if (category === 'TIMEOUT') return timeout[language](subject);
  if (category === 'TECHNICAL') return technical[language](subject);
  if (category === 'NO_EVIDENCE') return noEvidence[language](subject);
  return formatBusinessSupportVerificationUnavailable(language, subject);
}

/** Last assistant message strictly BEFORE the current user turn. The current
 * turn's own placeholder (after the last user message) is never consulted. */
export function previousAssistantReply(history: readonly any[] | undefined): string | undefined {
  if (!Array.isArray(history)) return undefined;
  let i = history.length - 1;
  while (i >= 0 && history[i]?.role !== 'user') i--;
  for (i--; i >= 0; i--) {
    if (history[i]?.role === 'assistant') return typeof history[i].content === 'string' ? history[i].content : undefined;
    if (history[i]?.role === 'user') return undefined;
  }
  return undefined;
}

export type KnowledgeFallback = Readonly<{ text: string; category: KnowledgeFallbackCategory; quoted: boolean; repeated: boolean }>;

/** Deterministic: the same inputs always give the same text. */
export function contextualKnowledgeFallback(input: Readonly<{ language: string; question?: string | null;
  category: KnowledgeFallbackCategory; previousAssistantReply?: string }>): KnowledgeFallback {
  const language = (LANGUAGES.includes(input.language) ? input.language : 'en') as KnowledgeFallbackLanguage;
  const quotedQuestion = input.question ? quotableQuestion(input.question, language) : null;
  const subject = quotedQuestion ? quotes[language][0] + quotedQuestion + quotes[language][1] : genericSubject[language];
  const first = render(input.category, language, subject, false), again = render(input.category, language, subject, true);
  // A repeat is the same fallback (same category and subject) given on the
  // previous assistant turn, in either its first or its repeated form.
  const repeated = !!input.previousAssistantReply && (input.previousAssistantReply === first || input.previousAssistantReply === again);
  return Object.freeze({ text: repeated ? again : first, category: input.category, quoted: !!quotedQuestion, repeated });
}
