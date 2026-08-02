import { detectNormalizedIntent, parseTimeConstraint } from './booking-intelligence';

export type MessagingIntent =
  | 'normal'
  | 'language_repair'
  | 'new_booking'
  | 'reschedule'
  | 'cancellation'
  | 'existing_booking_lookup'
  | 'ambiguous';

export type TelegramReplyMode = 'auto' | 'text' | 'voice';

export type TelegramReplyPreference = {
  mode: TelegramReplyMode;
  explicit: boolean;
};

export type NormalizedTimeRange =
  | { kind: 'exclusive_lower'; time: string }
  | { kind: 'inclusive_lower'; time: string }
  | { kind: 'exclusive_upper'; time: string }
  | { kind: 'exact'; time: string }
  | { kind: 'window'; minTime: string; maxTime: string }
  | { kind: 'relative_later' }
  | null;

const FINGLISH_WEIGHTS: Record<string, number> = {
  salam: 3,
  khub: 2,
  khubi: 2,
  hastin: 2,
  mishe: 2,
  begi: 2,
  begin: 2,
  shoma: 2,
  shuma: 2,
  chie: 2,
  chera: 2,
  zaban: 2,
  zabaneto: 2,
  mikoni: 2,
  mikham: 2,
  mikhastam: 2,
  mitoni: 2,
  mitooni: 2,
  man: 1,
  kare: 1,
  kar: 1,
  vaght: 3,
  vaghtam: 3,
  rezerv: 3,
  ghabli: 2,
  taghir: 2,
  avaz: 1,
  laghv: 3,
  konam: 1,
  daram: 1,
  mersi: 2,
  mamnoon: 2,
  lotfan: 2,
};

function normalizedWords(text: string): string[] {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function scoreLatinPersianEvidence(text: string): number {
  const unique = new Set(normalizedWords(text));
  let score = 0;
  for (const word of unique) score += FINGLISH_WEIGHTS[word] || 0;
  return score;
}

export function hasStrongLatinPersianEvidence(text: string): boolean {
  return scoreLatinPersianEvidence(text) >= 3;
}

export function detectExplicitLanguageSwitch(text: string): string | null {
  const raw = String(text || '').normalize('NFKC').trim().toLowerCase();
  if (!raw) return null;
  if (/\b(?:english|in english|speak english|reply in english|can we continue in english)\b/.test(raw)) return 'en';
  if (/\b(?:svenska|på svenska|prata svenska|svara på svenska)\b/.test(raw)) return 'sv';
  if (/\b(?:deutsch|auf deutsch|sprechen sie deutsch|bitte deutsch)\b/.test(raw)) return 'de';
  if (/\b(?:español|espanol|en español|habla español|responde en español)\b/.test(raw)) return 'es';
  if (/\b(?:farsi|persian|فارسی|به فارسی|فارسی صحبت کنیم)\b/u.test(raw)) return 'fa';
  if (/\b(?:arabic|عربي|العربية|بالعربية|تكلم عربي|تحدث العربية)\b/u.test(raw)) return 'ar';
  return null;
}

export function resolveStableConversationLanguage(
  previous: string | null | undefined,
  detected: string,
  explicitSwitch?: string | null,
): string {
  return explicitSwitch || previous || detected;
}

export function classifyMessagingIntent(text: string): MessagingIntent {
  const raw = String(text || '').normalize('NFKC').trim().toLowerCase();
  if (!raw) return 'ambiguous';

  if (
    /\b(?:why|chera|varför|warum|por qué|por que).{0,30}(?:language|zaban|språk|sprache|idioma).{0,30}(?:change|avaz|switch|bytte|ändra|wechsel|cambi)/iu.test(raw) ||
    /(?:چرا|چرا زبان).{0,30}(?:عوض|تغییر)/u.test(raw)
  ) return 'language_repair';

  if (
    /\b(?:cancel|cancellation|avboka|laghv).{0,24}(?:appointment|booking|tid|vaght|rezerv)?\b/iu.test(raw) ||
    /\b(?:appointment|booking|tid|vaght|vaghtam|rezerv).{0,24}(?:cancel|avboka|laghv)\b/iu.test(raw) ||
    /(?:لغو|کنسل).{0,24}(?:وقت|رزرو)?/u.test(raw)
  ) return 'cancellation';

  if (
    /\b(?:reschedule|move|change|taghir|avaz).{0,30}(?:appointment|booking|time|tid|vaght|vaghtam|rezerv)\b/iu.test(raw) ||
    /\b(?:appointment|booking|time|tid|vaght|vaghtam|rezerv).{0,30}(?:reschedule|move|change|taghir|avaz)\b/iu.test(raw) ||
    /\b(?:ändra|flytta|boka om).{0,24}(?:tid|bokning)?\b/iu.test(raw) ||
    /(?:تغییر|عوض).{0,24}(?:وقت|رزرو)/u.test(raw)
  ) return 'reschedule';

  if (
    /\b(?:do i have|did i book|when is|check).{0,30}(?:appointment|booking)\b/iu.test(raw) ||
    /\b(?:aya|mishe|mitoni).{0,24}(?:vaght|rezerv|booking).{0,24}(?:daram|ghabli|kardam)\b/iu.test(raw) ||
    /\b(?:har jag|när är|kan du kolla).{0,24}(?:tid|bokning)\b/iu.test(raw) ||
    /(?:آیا|میشه|می.?تونی).{0,24}(?:وقت|رزرو).{0,24}(?:دارم|کردم)/u.test(raw)
  ) return 'existing_booking_lookup';

  if (
    /\b(?:book|booking|appointment|boka|bokning|mikham|mikhastam).{0,30}(?:new|appointment|booking|tid|vaght|rezerv|konam)\b/iu.test(raw) ||
    /(?:می.?خوام).{0,24}(?:وقت|رزرو)/u.test(raw)
  ) return 'new_booking';

  if (
    /\b(?:what do you do|what services|which services|mishe.{0,16}(?:begi|begin).{0,24}(?:kar|kare).{0,12}(?:chie|chist)|vad gör ni|vilka tjänster|was machen sie|qué hacen|que hacen)\b/iu.test(raw) ||
    /(?:کارتون چیه|چه خدماتی|چه کاری)/u.test(raw)
  ) return 'normal';

  const sharedIntent = detectNormalizedIntent(raw);
  if (sharedIntent === 'new_booking') return 'new_booking';
  if (sharedIntent === 'booking_lookup') return 'existing_booking_lookup';
  if (sharedIntent === 'clarification') return 'ambiguous';
  if (/\b(?:appointment|booking|bokning|tid|vaght|vaghtam|rezerv|وقت|رزرو)\b/iu.test(raw)) {
    return 'ambiguous';
  }
  return 'normal';
}

export function explicitTelegramReplyMode(text: string): TelegramReplyMode | null {
  const raw = String(text || '').normalize('NFKC').trim().toLowerCase();
  if (!raw) return null;
  if (
    /\b(?:reply|answer|respond|svara|javab|جواب).{0,20}(?:with|as|med|ba|با)?\s*(?:voice|audio|röst|seda|صدا|ویس)\b/iu.test(raw) ||
    /(?:ویس|صوتی|صدا).{0,20}(?:جواب|پاسخ|بده)/u.test(raw)
  ) return 'voice';
  if (
    /\b(?:reply|answer|respond|svara|javab|جواب).{0,20}(?:with|as|in|med|ba|به)?\s*(?:text|writing|skrift|matn|متن|نوشتاری)\b/iu.test(raw) ||
    /(?:متنی|نوشتاری).{0,20}(?:جواب|پاسخ|بده)/u.test(raw)
  ) return 'text';
  return null;
}

export function resolveTelegramReplyPreference(
  previous: TelegramReplyPreference | null | undefined,
  inputMode: 'text' | 'voice',
  normalizedText: string,
): TelegramReplyPreference {
  const explicitMode = explicitTelegramReplyMode(normalizedText);
  if (explicitMode) return { mode: explicitMode, explicit: true };
  if (previous?.explicit) return previous;
  if (inputMode === 'voice') return { mode: 'voice', explicit: false };
  return { mode: 'auto', explicit: false };
}

export function selectTelegramDeliveryMode(
  preference: TelegramReplyPreference,
  inputMode: 'text' | 'voice',
): 'text' | 'voice' {
  if (preference.mode === 'voice') return 'voice';
  if (preference.mode === 'text') return 'text';
  return inputMode === 'voice' ? 'voice' : 'text';
}

function normalizeTime(hourValue: string, minuteValue?: string): string | null {
  const hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function parseNormalizedTimeRange(text: string): NormalizedTimeRange {
  const raw = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const shared = parseTimeConstraint(raw);
  if (shared?.kind === 'after' && shared.startMinutes !== undefined) return { kind: 'exclusive_lower', time: minutesToClock(shared.startMinutes) };
  if (shared?.kind === 'from' && shared.startMinutes !== undefined) return { kind: 'inclusive_lower', time: minutesToClock(shared.startMinutes) };
  if (shared?.kind === 'before' && shared.endMinutes !== undefined) return { kind: 'exclusive_upper', time: minutesToClock(shared.endMinutes) };
  if (shared?.kind === 'exact' && shared.startMinutes !== undefined) return { kind: 'exact', time: minutesToClock(shared.startMinutes) };
  if (shared?.kind === 'between' && shared.startMinutes !== undefined && shared.endMinutes !== undefined) {
    return { kind: 'window', minTime: minutesToClock(shared.startMinutes), maxTime: minutesToClock(shared.endMinutes) };
  }
  const token = String.raw`([01]?\d|2[0-3])(?:[\.:](\d{2}))?`;

  const between = raw.match(new RegExp(String.raw`(?:between|mellan|bin|بین)\s*${token}\s*(?:and|och|ta|تا|و)\s*${token}`, 'iu'));
  if (between) {
    const minTime = normalizeTime(between[1], between[2]);
    const maxTime = normalizeTime(between[3], between[4]);
    if (minTime && maxTime && minTime < maxTime) return { kind: 'window', minTime, maxTime };
  }

  const patterns: Array<[Exclude<NormalizedTimeRange, null>['kind'], RegExp]> = [
    ['exclusive_lower', new RegExp(String.raw`(?:after|later than|efter(?: klockan)?|bad az(?: saat)?|بعد از(?: ساعت)?)\s*${token}`, 'iu')],
    ['inclusive_lower', new RegExp(String.raw`(?:from|från(?: klockan)?|az(?: saat)?|از(?: ساعت)?)\s*${token}`, 'iu')],
    ['exclusive_upper', new RegExp(String.raw`(?:before|före(?: klockan)?|ghabl az(?: saat)?|قبل از(?: ساعت)?)\s*${token}`, 'iu')],
    ['exact', new RegExp(String.raw`(?:at|klockan|kl|saat|ساعت)\s*${token}`, 'iu')],
  ];
  for (const [kind, pattern] of patterns) {
    const match = raw.match(pattern);
    const time = match ? normalizeTime(match[1], match[2]) : null;
    if (time) return { kind: kind as 'exclusive_lower' | 'inclusive_lower' | 'exclusive_upper' | 'exact', time };
  }
  if (/^(?:later|a bit later|senare|lite senare|bad tar|دیرتر|کمی دیرتر)$/iu.test(raw)) {
    return { kind: 'relative_later' };
  }
  return null;
}

function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function isSlotListRepeatRequest(text: string): boolean {
  const raw = String(text || '').normalize('NFKC').trim().toLowerCase();
  return /\b(?:repeat|show|send|list).{0,24}(?:times|slots|options)\b|\b(?:visa|skicka).{0,24}(?:tiderna|tider|alternativen)\b|\b(?:dobare|bazam).{0,24}(?:vaght|saat)\b|(?:دوباره|باز هم).{0,24}(?:زمان|وقت|ساعت)/iu.test(raw);
}
