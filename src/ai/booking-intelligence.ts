import { applyBookingTransition, mergeBookingRequest } from './booking-state-machine';

export type SupportedLanguage = 'fa' | 'sv' | 'en' | 'de' | 'es' | 'ar';
export type NormalizedIntent =
  | 'general_question'
  | 'new_booking'
  | 'reschedule'
  | 'cancellation'
  | 'booking_lookup'
  | 'clarification'
  | 'unknown';

export type NormalizedTimeConstraint = {
  kind: 'exact' | 'before' | 'after' | 'from' | 'between' | 'morning' | 'afternoon' | 'evening' | 'none';
  startMinutes?: number;
  endMinutes?: number;
  startInclusive?: boolean;
  endInclusive?: boolean;
  confidence: 'high' | 'medium' | 'low';
};

export type NormalizedBookingRequest = {
  intent: NormalizedIntent;
  language: SupportedLanguage;
  service?: { raw?: string; normalized?: string; confidence: 'high' | 'medium' | 'low' };
  date?: {
    kind: 'exact_date' | 'weekday' | 'relative_date' | 'date_range';
    value?: string;
    endValue?: string;
    weekday?: number;
    relative?: string;
    confidence: 'high' | 'medium' | 'low';
  };
  timeConstraint?: NormalizedTimeConstraint;
  customerCorrection?: { replacesDate: boolean; replacesTime: boolean; replacesService: boolean };
  sourceMode: 'text' | 'voice';
  normalizedText: string;
  requiresClarification: boolean;
  clarificationReason?: string;
  dateConflict?: {
    kind: 'weekday_explicit_date_conflict';
    explicitDate: string;
    weekdayDate: string;
    requestedWeekday: number;
  };
};

export type ConversationInput = {
  businessId: number | string;
  channel: string;
  conversationKey: string;
  inputMode: 'text' | 'voice';
  text: string;
  activeLanguage?: SupportedLanguage;
  timezone: string;
  now?: Date;
};

export type BookingRequestMergeResult = {
  request: NormalizedBookingRequest;
  replaced: { date: boolean; time: boolean; service: boolean };
  invalidatesOffers: boolean;
};

export type PersistedNormalizedBookingRequest = Omit<NormalizedBookingRequest, 'normalizedText' | 'sourceMode' | 'service'> & {
  service?: { normalized?: string; confidence: 'high' | 'medium' | 'low' };
};

export function toPersistedBookingRequest(request: NormalizedBookingRequest): PersistedNormalizedBookingRequest {
  const { normalizedText: _text, sourceMode: _mode, ...safe } = request;
  return { ...safe, ...(safe.service ? { service: { normalized: safe.service.normalized, confidence: safe.service.confidence } } : {}) };
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function normalizeConversationText(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[۰-۹]/g, digit => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/\u200c/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[،]/g, ',')
    .replace(/[؟]/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

const PERSIAN_NUMBER_WORDS: Array<[RegExp, string]> = [
  [/(?<![\u0600-\u06ff])(?:هجده|هژده)(?![\u0600-\u06ff])/gu, '18'],
  [/(?<![\u0600-\u06ff])هفده(?![\u0600-\u06ff])/gu, '17'],
  [/(?<![\u0600-\u06ff])شانزده(?![\u0600-\u06ff])/gu, '16'],
  [/(?<![\u0600-\u06ff])پانزده(?![\u0600-\u06ff])/gu, '15'],
  [/(?<![\u0600-\u06ff])چهارده(?![\u0600-\u06ff])/gu, '14'],
  [/(?<![\u0600-\u06ff])سیزده(?![\u0600-\u06ff])/gu, '13'],
  [/(?<![\u0600-\u06ff])دوازده(?![\u0600-\u06ff])/gu, '12'],
  [/(?<![\u0600-\u06ff])یازده(?![\u0600-\u06ff])/gu, '11'],
  [/(?<![\u0600-\u06ff])ده(?![\u0600-\u06ff])/gu, '10'],
  [/(?<![\u0600-\u06ff])نه(?![\u0600-\u06ff])/gu, '9'],
  [/(?<![\u0600-\u06ff])هشت(?![\u0600-\u06ff])/gu, '8'],
  [/(?<![\u0600-\u06ff])هفت(?![\u0600-\u06ff])/gu, '7'],
  [/(?<![\u0600-\u06ff])شش(?![\u0600-\u06ff])/gu, '6'],
  [/(?<![\u0600-\u06ff])پنج(?![\u0600-\u06ff])/gu, '5'],
  [/(?<![\u0600-\u06ff])چهار(?![\u0600-\u06ff])/gu, '4'],
  [/(?<![\u0600-\u06ff])سه(?![\u0600-\u06ff])/gu, '3'],
  [/(?<![\u0600-\u06ff])دو(?![\u0600-\u06ff])/gu, '2'],
  [/(?<![\u0600-\u06ff])یک(?![\u0600-\u06ff])/gu, '1'],
];

/** Normalizes provider output only; it never invents an unclear value. */
export function normalizeTranscribedText(text: string): string {
  let normalized = normalizeConversationText(text);
  if (/\[(?:unclear|نامفهوم)\]/iu.test(normalized)) return normalized;
  for (const [pattern, value] of PERSIAN_NUMBER_WORDS) normalized = normalized.replace(pattern, value);
  normalized = normalized
    .replace(/(\b\d{1,2})\s+و\s+نیم\b/gu, '$1:30')
    .replace(/(\b\d{1,2})\s+و\s+ربع\b/gu, '$1:15');
  return normalized.replace(/\s+/g, ' ').trim();
}

function detectGrammaticalLatinLanguage(text: string): SupportedLanguage | null {
  const lower = normalizeConversationText(text).toLowerCase();
  const scores: Record<'sv' | 'de' | 'es' | 'en', number> = { sv: 0, de: 0, es: 0, en: 0 };
  const add = (language: keyof typeof scores, pattern: RegExp, weight: number) => {
    const matches = lower.match(pattern);
    if (matches) scores[language] += matches.length * weight;
  };

  add('sv', /\b(vilka?|finns|jag|mig|du|den|det|för|någon|några)\b/gu, 2);
  add('sv', /\b(lediga?|tider?)\b/gu, 2);
  add('de', /\b(welche[rsn]?|ich|mich|gibt\s+es|am|für)\b/gu, 2);
  add('de', /\b(freie[nrms]?|zeiten?|termine?)\b/gu, 2);
  add('es', /\b(qué|cuáles?|hay|quiero|para|el|la)\b/gu, 2);
  add('es', /\b(horas?|disponibles?|citas?)\b/gu, 2);
  add('en', /\b(what|which|i|me|are\s+there|for|on)\b/gu, 2);
  add('en', /\b(available|times?|appointments?)\b/gu, 2);

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] >= 6 && ranked[0][1] > ranked[1][1]
    ? ranked[0][0] as SupportedLanguage
    : null;
}

function detectLanguage(text: string, active?: SupportedLanguage): SupportedLanguage {
  if (/[أإؤئءةىيك]/u.test(text) || /(?:هل|لديكم|حجز|متاح|الساعة|يوم|الجمعة|سبتمبر)/u.test(text)) return 'ar';
  if (/[\u0600-\u06ff]/u.test(text)) return 'fa';
  const grammaticalLanguage = detectGrammaticalLatinLanguage(text);
  if (grammaticalLanguage) return grammaticalLanguage;
  if (/\b(?:jag|vill|boka|fredag|före|efter|klockan|mellan|tider?|lediga?)\b/iu.test(text)) return 'sv';
  if (/\b(?:haben sie|termin|uhr|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|später|spaeter)\b/iu.test(text)) return 'de';
  if (/\b(?:tienen|cita|reserva|disponible|viernes|después|despues|septiembre)\b/iu.test(text)) return 'es';
  if (/\b(?:mikham|mitoni|vaght|jomeh?|baraye|ghabl|sate?|moshavereh?|chera|zaban)\b/iu.test(text)) return 'fa';
  return active || 'en';
}

export function isServiceGuidanceRequest(text: string): boolean {
  const raw = normalizeConversationText(text).toLowerCase().trim();
  if (!raw) return false;

  const patterns = [
    // English
    /\b(?:which|what)\s+(?:service|treatment)\b.{0,40}\b(?:right|best|suitable|recommend)/iu,
    /\b(?:help|recommend|advise)\b.{0,40}\b(?:choose|select|service|treatment)\b/iu,
    /\b(?:don't|do not|not sure|unsure)\b.{0,40}\b(?:which|what)\b.{0,20}\b(?:service|treatment)\b/iu,

    // Swedish
    /\b(?:vilken|vilka)\s+(?:tjänst|behandling)\b.{0,40}\b(?:passar|bäst|rätt|rekommender)/iu,
    /\b(?:hjälp|hjälpa|rekommendera|råd)\b.{0,40}\b(?:välja|tjänst|behandling)\b/iu,
    /\b(?:vet inte|osäker)\b.{0,40}\b(?:vilken|vad)\b.{0,20}\b(?:tjänst|behandling)\b/iu,
    /\bvet\s+(?:fortfarande\s+)?inte\b.{0,50}\b(?:vilken|vad)\b.{0,28}\b(?:typ\s+av\s+)?(?:tjänst|behandling)\b/iu,
    /\b(?:behöver|vill)\s+(?:först\s+)?(?:veta|förstå)\b.{0,50}\b(?:vilken|vilka|vad)\b.{0,30}\b(?:tjänst|tjänster|behandling|behandlingar)\b/iu,
    /\b(?:beskriv|förklara)\b.{0,50}\b(?:tjänst|tjänster|behandling|behandlingar)\b/iu,
    /\b(?:ge|visa|nämn)\b.{0,24}\b(?:exempel|översikt)\b.{0,32}\b(?:tjänster|behandlingar)\b/iu,

    // German
    /\b(?:welche|welcher)\s+(?:behandlung|dienstleistung)\b.{0,40}\b(?:passt|geeignet|richtig|empfehl)/iu,
    /\b(?:helfen|hilfe|empfehlen|beratung)\b.{0,40}\b(?:wählen|behandlung|dienstleistung)\b/iu,

    // Spanish
    /\b(?:qué|que|cuál|cual)\s+(?:servicio|tratamiento)\b.{0,40}\b(?:mejor|adecuado|conviene|recomiend)/iu,
    /\b(?:ayuda|ayudar|recomendar|aconsejar)\b.{0,40}\b(?:elegir|servicio|tratamiento)\b/iu,

    // Persian
    /(?:نمی.?دونم|نمی.?دانم|مطمئن نیستم).{0,40}(?:کدوم|کدام|چه).{0,24}(?:سرویس|خدمت|درمان|کار)/u,
    /(?:کمک|راهنمایی|پیشنهاد).{0,40}(?:انتخاب|سرویس|خدمت|درمان)/u,

    // Arabic
    /(?:لا أعرف|لست متأكد|مش عارف).{0,40}(?:أي|ما).{0,24}(?:خدمة|علاج)/u,
    /(?:ساعدني|مساعدة|أنصحني|نصيحة|اقترح).{0,40}(?:اختيار|خدمة|علاج)/u,
  ];

  return patterns.some((pattern) => pattern.test(raw));
}

export function isReadOnlyAvailabilityInquiry(text: string): boolean {
  const raw = normalizeConversationText(text).toLowerCase().trim();
  if (!raw) return false;
  const availabilityLanguage =
    /\b(?:available|availability|free|open|ledig|ledigt|lediga|frei|freier|verfügbar|verfugbar|disponible|disponibles|libre|libres)\b/iu.test(raw) ||
    /(?:خالی|آزاد|متاح|متوفر|شاغر)/u.test(raw);
  const questionForm = /[?؟]$/u.test(raw) ||
    /^(?:is|are|do|does|can|could|är|finns|har|ist|sind|haben|hay|tienen|es|está|esta|آیا|هل)\b/iu.test(raw);
  const explicitBookingAction =
    /\b(?:book|book it|reserve|schedule|boka|boka den|reservera|buchen|reservieren|reservar|resérvala|reservala|quiero|möchte|mochte|want)\b/iu.test(raw) ||
    /(?:احجز|أحجز|حجزه|رزرو (?:کن|کنید)|می ?خوام|می ?خواهم)/u.test(raw);
  return availabilityLanguage && questionForm && !explicitBookingAction;
}

export function detectNormalizedIntent(text: string): NormalizedIntent {
  const raw = normalizeConversationText(text).toLowerCase();
  if (!raw) return 'unknown';

  // Service-selection guidance is informational, not permission to start
  // availability discovery. Once the customer actually chooses a service
  // and asks to book it, normal booking classification applies.
  if (isServiceGuidanceRequest(raw)) return 'general_question';
  if (/\b(?:why|chera|varför).{0,30}(?:language|zaban|språk).{0,30}(?:change|avaz|switch|ändra)\b/iu.test(raw) || /چرا.{0,20}(?:زبان).{0,20}(?:عوض|تغییر)/u.test(raw)) return 'general_question';
  if (/\b(?:cancel|avboka|laghv).{0,25}(?:appointment|booking|tid|vaght|rezerv)?\b/iu.test(raw) || /(?:لغو|کنسل).{0,20}(?:وقت|رزرو)/u.test(raw)) return 'cancellation';
  if (/(?:^|\s)(?:reschedule|move|change|ändra|flytta|taghir|avaz).{0,30}(?:appointment|booking|time|tid|vaght|rezerv)(?=\s|$)/iu.test(raw) || /(?:^|\s)boka\s+om(?=\s|$)/iu.test(raw) || /\b(?:avaz|taghir)\s+(?:bedam|konam)\b/iu.test(raw) || /(?:تغییر|عوض).{0,20}(?:وقت|رزرو|کنم|بدم)/u.test(raw)) return 'reschedule';
  if (/\b(?:do i have|did i book|check|har jag|aya).{0,30}(?:appointment|booking|tid|vaght|rezerv)\b/iu.test(raw) || /(?:آیا|میشه).{0,24}(?:وقت|رزرو).{0,24}(?:دارم|کردم)|(?:هل\s+لدي(?=\s|$).{0,24}(?:موعد|حجز)|هل\s+حجزت|متى\s+موعدي|تحقق\s+من\s+موعدي)/u.test(raw)) return 'booking_lookup';

  const germanBookingAction =
    /\bich\s+(?:möchte|moechte|will)\b.{0,120}\b(?:buchen|reservieren)\b/iu.test(raw) ||
    /\b(?:einen?\s+)?termin\s+(?:buchen|reservieren)\b/iu.test(raw);

  if (germanBookingAction) return 'new_booking';

  const bookingNoun = /\b(?:appointment|booking|consultation|slot|time|boka|bokning|tid|konsultation|termin|cita|reserva|reservación|reservacion|vaght|rezerv|moshavereh?|laser)\b/iu.test(raw) || /(?:وقت|رزرو|مشاوره|لیزر|موعد|مواعيد|حجز)/u.test(raw);
  const bookingAction = /\b(?:book|want|need|available|have anything|have any time|do you have any time|boka|vill|behöver|finns|har ni|haben sie|möchte|mochte|buchen|tienen|hay|disponible|disponibles|mikham|mikhastam|mitoni|bدي|begiram|dari)\b/iu.test(raw) || /(?:می ?خوام|می ?خواهم|می ?تونی|وقت داری|بگیرم|بگیری|متاح|متوفر|شاغر)/u.test(raw);
  const directBookingAction = /\b(?:book|boka|buchen|reservieren|reservar)\b/iu.test(raw);
  const dateOrTime = /\b(?:today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|fredag|måndag|tisdag|onsdag|torsdag|lördag|söndag|morgen|uhr|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|después|despues|antes|später|spaeter|jomeh?|shanbe|sate?|after|before|efter|före)\b/iu.test(raw) || /(?:امروز|فردا|جمعه|شنبه|ساعت|بعد از|قبل از)/u.test(raw);
  if ((bookingNoun && bookingAction) || (bookingNoun && dateOrTime)) return 'new_booking';
  if (directBookingAction && dateOrTime) return 'new_booking';
  if (bookingNoun) return 'clarification';
  return 'general_question';
}

function clockToMinutes(hourText: string, minuteText?: string, meridiemText?: string, daypartText?: string): number | null {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  const meridiem = String(meridiemText || '').toLowerCase();
  const daypart = String(daypartText || '').toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if ((meridiem === 'pm' || /(?:evening|afternoon|kväll|عصر|بعدازظهر)/u.test(daypart)) && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return hour * 60 + minute;
}

const NAMED_MONTH_NUMBERS: Record<string, number> = {
  january: 1, januari: 1, januar: 1, enero: 1, ژانویه: 1, يناير: 1,
  february: 2, februari: 2, februar: 2, febrero: 2, فوریه: 2, فبراير: 2,
  march: 3, mars: 3, märz: 3, marz: 3, marzo: 3, مارس: 3,
  april: 4, abril: 4, آوریل: 4, أبريل: 4, ابريل: 4,
  may: 5, maj: 5, mai: 5, mayo: 5, مه: 5, مايو: 5,
  june: 6, juni: 6, junio: 6, ژوئن: 6, يونيو: 6,
  july: 7, juli: 7, julio: 7, ژوئیه: 7, يوليو: 7,
  august: 8, augusti: 8, agosto: 8, اوت: 8, أغسطس: 8, اغسطس: 8,
  september: 9, septiembre: 9, سپتامبر: 9, سبتمبر: 9,
  october: 10, oktober: 10, octubre: 10, اکتبر: 10, أكتوبر: 10, اكتوبر: 10,
  november: 11, noviembre: 11, نوامبر: 11, نوفمبر: 11,
  december: 12, dezember: 12, diciembre: 12, دسامبر: 12, ديسمبر: 12,
};
const NAMED_MONTH_PATTERN = Object.keys(NAMED_MONTH_NUMBERS)
  .sort((a, b) => b.length - a.length)
  .join('|');
const DATE_RANGE_CONNECTOR_PATTERN = String.raw`(?:and|och|to|through|till|until|und|bis|y|hasta|a|-|تا|و|إلى|الى)`;

function matchNamedCalendarDateRange(text: string): {
  startDay: string;
  endDay: string;
  month: string;
  year?: string;
} | null {
  const raw = normalizeConversationText(text).toLowerCase().replace(/[–—]/g, '-');
  const dayFirst = new RegExp(
    String.raw`(?:^|\s)(\d{1,2})(?::e|e|a|º|ª)?\s*${DATE_RANGE_CONNECTOR_PATTERN}\s*(\d{1,2})(?::e|e|a|º|ª)?\s+(${NAMED_MONTH_PATTERN})(?:\s+(20\d{2}))?(?=\s|[?.!,]|$)`,
    'iu'
  );
  const monthFirst = new RegExp(
    String.raw`(?:^|\s)(${NAMED_MONTH_PATTERN})\s+(\d{1,2})(?::e|e|a|º|ª)?\s*${DATE_RANGE_CONNECTOR_PATTERN}\s*(\d{1,2})(?::e|e|a|º|ª)?(?:\s+(20\d{2}))?(?=\s|[?.!,]|$)`,
    'iu'
  );
  const dayMatch = raw.match(dayFirst);
  if (dayMatch) {
    return { startDay: dayMatch[1], endDay: dayMatch[2], month: dayMatch[3], year: dayMatch[4] };
  }
  const monthMatch = raw.match(monthFirst);
  if (!monthMatch) return null;
  return { startDay: monthMatch[2], endDay: monthMatch[3], month: monthMatch[1], year: monthMatch[4] };
}

export function parseNamedBookingDateRange(
  text: string,
  timezone: string,
  now = new Date()
): { startDate: string; endDate: string } | null {
  const match = matchNamedCalendarDateRange(text);
  if (!match) return null;
  const startDay = Number(match.startDay);
  const endDay = Number(match.endDay);
  const month = NAMED_MONTH_NUMBERS[String(match.month || '').toLowerCase()];
  const year = Number(match.year || zonedDateParts(now, timezone).iso.slice(0, 4));
  if (!month || startDay < 1 || endDay < startDay || endDay > 31) return null;
  const startDate = `${year}-${String(month).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  const valid = (value: string) => {
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  return valid(startDate) && valid(endDate) ? { startDate, endDate } : null;
}

export function parseTimeConstraint(text: string): NormalizedTimeConstraint | undefined {
  const raw = normalizeTranscribedText(text)
    .toLowerCase()
    .replace(/\bnoon\b/giu, '12:00')
    .replace(/ظهر/gu, '12:00');

  if (!raw || /\[(?:unclear|نامفهوم)\]/iu.test(raw)) return undefined;

  // A rejected clock value must not be reinterpreted as a new requested time.
  const rejectedExplicitTime = new RegExp(
    String.raw`(?:[01]?\d|2[0-3])(?:[\.:]\d{2})?\s*(?:uhr)?[^\p{N}]{0,24}(?:passt\s+nicht|no\s+me\s+va|لا\s+تناسبني)`,
    'iu',
  );
  if (rejectedExplicitTime.test(raw)) return undefined;

  const token = String.raw`(2[0-3]|[01]?\d)(?:[\.:](\d{2}))?\s*(am|pm)?\s*(morning|afternoon|evening|morgon|eftermiddag|kväll|abend|tarde|noche|صبح|بعدازظهر|عصر|المساء)?`;
  const clockMarker = String.raw`(?:klockan|a\s+las?|saat|sate|ساعت|(?:ال)?ساعة)`;

  // Preserve the local named-date-range guard so calendar date ranges are not
  // accidentally consumed as clock ranges.
  const between = matchNamedCalendarDateRange(raw)
    ? null
    : raw.match(new RegExp(
        String.raw`(?:between|mellan|bin|بین|zwischen|entre(?:\s+las?)?|بين)\s*(?:${clockMarker})?\s*${token}\s*(?:uhr)?\s*(?:and|och|ta|تا|و|und|y)\s*(?:las?\s+|${clockMarker}\s*)?${token}\s*(?:uhr)?`,
        'iu',
      ));

  if (between) {
    const start = clockToMinutes(between[1], between[2], between[3], between[4]);
    const end = clockToMinutes(between[5], between[6], between[7], between[8]);

    if (start !== null && end !== null && start < end) {
      return {
        kind: 'between',
        startMinutes: start,
        endMinutes: end,
        startInclusive: true,
        endInclusive: true,
        confidence: 'high',
      };
    }
  }

  const rules: Array<[NormalizedTimeConstraint['kind'], RegExp, boolean, boolean]> = [
    [
      'after',
      new RegExp(
        String.raw`(?:(?:after|later than)(?:\s+at)?|efter(?:\s+kl(?:ockan)?\.?)?|senare än(?:\s+kl(?:ockan)?\.?)?|nach(?:\s+(?:dem|um))?|später als|spaeter als|despu[eé]s de(?:\s+las?)?|bad az(?: sa(?:a)?t(?:e)?)?|بعد از(?: ساعت)?|بعد(?:\s+(?:ال)?ساعة|\s+ساعة))\s*${token}\s*(?:uhr)?`,
        'iu',
      ),
      false,
      false,
    ],
    [
      'before',
      new RegExp(
        String.raw`(?:before|innan(?:\s+kl(?:ockan)?\.?)?|före(?:\s+kl(?:ockan)?\.?)?|vor(?:\s+um)?|antes de(?:\s+las?)?|ghabl az(?: sate?)?|قبل از(?: ساعت)?|قبل(?:\s+(?:ال)?ساعة|\s+ساعة))\s*${token}\s*(?:uhr)?`,
        'iu',
      ),
      false,
      false,
    ],
    [
      'from',
      new RegExp(
        String.raw`(?:from|från(?: klockan)?|desde(?:\s+las?)?|az(?: sate?)?|از(?: ساعت)?|من(?:\s+(?:ال)?ساعة|\s+ساعة))\s*${token}`,
        'iu',
      ),
      true,
      false,
    ],
    [
      'exact',
      new RegExp(
        String.raw`(?:at|klockan|kl\.?|um|a\s+las?|saat|sate|ساعت|(?:ال)?ساعة)\s*${token}\s*(?:uhr)?`,
        'iu',
      ),
      true,
      true,
    ],
  ];

  for (const [kind, pattern, startInclusive, endInclusive] of rules) {
    const match = raw.match(pattern);
    if (!match) continue;

    const value = clockToMinutes(match[1], match[2], match[3], match[4]);
    if (value === null) return undefined;

    if (kind === 'before') {
      return { kind, endMinutes: value, endInclusive, confidence: 'high' };
    }

    return {
      kind,
      startMinutes: value,
      startInclusive,
      endInclusive,
      confidence: 'high',
    };
  }

  const bareExact = raw.match(/^([01]?\d|2[0-3])[\.:]([0-5]\d)$/u);

  if (bareExact) {
    return {
      kind: 'exact',
      startMinutes: Number(bareExact[1]) * 60 + Number(bareExact[2]),
      startInclusive: true,
      endInclusive: true,
      confidence: 'high',
    };
  }

  // Preserve local German bare-clock support.
  const germanClock = raw.match(/\b([01]?\d|2[0-3])(?:[\.:]([0-5]\d))?\s*uhr\b/u);

  if (germanClock) {
    return {
      kind: 'exact',
      startMinutes: Number(germanClock[1]) * 60 + Number(germanClock[2] || 0),
      startInclusive: true,
      endInclusive: true,
      confidence: 'high',
    };
  }

  // Preserve local deterministic owned-slot selection.
  const contextualExact = raw.match(/(?:^|[^\d])([01]?\d|2[0-3])[\.:]([0-5]\d)(?!\d)/u);

  if (
    contextualExact &&
    (
      /\b(?:slot|time|appointment|take|choose|want|prefer|book|works|perfect|fine|tid|tiden|väljer|valjer|vill ha|passar|perfekt|utmärkt|utmarkt|boka|termin|hora|cita)\b/iu.test(raw) ||
      /(?:وقت|زمان|ساعت|رزرو|موعد)/u.test(raw)
    )
  ) {
    return {
      kind: 'exact',
      startMinutes: Number(contextualExact[1]) * 60 + Number(contextualExact[2]),
      startInclusive: true,
      endInclusive: true,
      confidence: 'high',
    };
  }

  const daypartText = raw.replace(/\bi\s+morgon\b/giu, ' ');
  if (/\b(?:morning|morgon(?:en)?)\b/iu.test(daypartText) || /صبح/u.test(raw)) {
    return { kind: 'morning', startMinutes: 9 * 60, endMinutes: 12 * 60, startInclusive: true, endInclusive: false, confidence: 'high' };
  }

  if (/\b(?:afternoon|eftermiddag(?:en)?|tarde)\b/iu.test(raw) || /بعدازظهر/u.test(raw)) {
    return { kind: 'afternoon', startMinutes: 12 * 60, endMinutes: 17 * 60, startInclusive: true, endInclusive: false, confidence: 'high' };
  }

  if (/\b(?:evening|kväll(?:en)?|abend|noche)\b/iu.test(raw) || /(?:عصر|مساء|المساء)/u.test(raw)) {
    return { kind: 'evening', startMinutes: 17 * 60, endMinutes: 21 * 60, startInclusive: true, endInclusive: false, confidence: 'high' };
  }

  return undefined;
}

function zonedDateParts(date: Date, timezone: string): { iso: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { iso: `${get('year')}-${get('month')}-${get('day')}`, weekday };
}

function zonedClockMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
  return get('hour') * 60 + get('minute');
}

export function getDateInTimeZone(date: Date, timezone: string): string {
  return zonedDateParts(date, timezone).iso;
}

function addIsoDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type CanonicalRelativeDateSemantic =
  | 'today'
  | 'tomorrow'
  | 'day_after_tomorrow';

export function resolveRelativeBookingDateSemantic(
  semantic: CanonicalRelativeDateSemantic,
  timezone: string,
  now: Date,
): NonNullable<NormalizedBookingRequest['date']> | null {
  const dayOffset = semantic === 'today'
    ? 0
    : semantic === 'tomorrow'
      ? 1
      : semantic === 'day_after_tomorrow'
        ? 2
        : null;
  if (dayOffset === null || Number.isNaN(now.getTime())) return null;
  const today = zonedDateParts(now, timezone).iso;
  return {
    kind: 'relative_date',
    value: addIsoDays(today, dayOffset),
    relative: semantic,
    confidence: 'high',
  };
}

const BOOKING_WEEKDAYS: Array<[number, RegExp]> = [
  [0, /\b(?:sunday|söndag|sonntag|domingo|yek\s*shanbe|1\s*shanbe)\b|یک ?شنبه|(?:الأحد|الاحد)/iu], [1, /\b(?:monday|måndag|montag|lunes|do\s*shanbe|2\s*shanbe)\b|دو ?شنبه|(?:الإثنين|الاثنين|الإثنان|الاثنان)/iu],
  [2, /\b(?:tuesday|tisdag|dienstag|martes|se\s*shanbe|3\s*shanbe)\b|سه ?شنبه|الثلاثاء/iu], [3, /\b(?:wednesday|onsdag|mittwoch|miércoles|miercoles|chahar\s*shanbe|4\s*shanbe)\b|چهار ?شنبه|(?:الأربعاء|الاربعاء)/iu],
  [4, /\b(?:thursday|torsdag|donnerstag|jueves|panj\s*shanbe|5\s*shanbe)\b|پنج ?شنبه|الخميس/iu], [5, /\b(?:friday|fredag|freitag|viernes|jomeh?)\b|جمعه|الجمعة/iu],
  [6, /\b(?:saturday|lördag|samstag|sábado|sabado|(?<![1-5])shanbe)\b|(?<!یک |دو |سه |چهار |پنج )شنبه|السبت/iu],
];

function extractBookingWeekday(text: string): number | undefined {
  return BOOKING_WEEKDAYS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function getBookingWeekdayReference(text: string): {
  weekday: number;
  qualifier: 'bare' | 'this' | 'next';
} | undefined {
  const raw = normalizeConversationText(text).toLowerCase();
  const weekday = extractBookingWeekday(raw);
  if (weekday === undefined) return undefined;

  if (
    /\b(?:next|nästa|nächste[rsnm]?|naechste[rsnm]?|próxim[oa]|proxim[oa]|ayande)\b/iu.test(raw) ||
    /آینده|القادم(?:ة)?|التالي(?:ة)?/u.test(raw)
  ) {
    return { weekday, qualifier: 'next' };
  }

  if (/\bthis\b|\bdenna\b|همین|این/u.test(raw)) {
    return { weekday, qualifier: 'this' };
  }

  return { weekday, qualifier: 'bare' };
}

function resolveNearestWeekdayDate(explicitDate: string, requestedWeekday: number): string {
  const actualWeekday = new Date(`${explicitDate}T12:00:00Z`).getUTCDay();
  const forwardDays = (requestedWeekday - actualWeekday + 7) % 7;
  const nearestDays = forwardDays <= 3 ? forwardDays : forwardDays - 7;
  return addIsoDays(explicitDate, nearestDays);
}

function detectWeekdayExplicitDateConflict(
  text: string,
  parsedDate: NormalizedBookingRequest['date'] | undefined,
): NormalizedBookingRequest['dateConflict'] | undefined {
  if (parsedDate?.kind !== 'exact_date' || !parsedDate.value) return undefined;
  const requestedWeekday = extractBookingWeekday(text);
  if (requestedWeekday === undefined) return undefined;
  const weekdayDate = resolveNearestWeekdayDate(parsedDate.value, requestedWeekday);
  if (weekdayDate === parsedDate.value) return undefined;
  return {
    kind: 'weekday_explicit_date_conflict',
    explicitDate: parsedDate.value,
    weekdayDate,
    requestedWeekday,
  };
}

function parseBookingDateCandidate(text: string, timezone: string, now = new Date()): NormalizedBookingRequest['date'] | undefined {
  const raw = normalizeConversationText(text).toLowerCase();
  const today = zonedDateParts(now, timezone);
  const isoMatch = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const candidate = new Date(`${isoMatch[1]}T12:00:00Z`);
    if (!Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === isoMatch[1] && isoMatch[1] >= today.iso) return { kind: 'exact_date', value: isoMatch[1], confidence: 'high' };
    return undefined;
  }
  const monthNames: Record<string, number> = {
    january: 1, januari: 1, januar: 1, enero: 1, ژانویه: 1, يناير: 1, february: 2, februari: 2, februar: 2, febrero: 2, فوریه: 2, فبراير: 2,
    march: 3, mars: 3, märz: 3, marz: 3, marzo: 3, مارس: 3, april: 4, abril: 4, آوریل: 4, أبريل: 4, ابريل: 4, may: 5, maj: 5, mai: 5, mayo: 5, مه: 5, مايو: 5,
    june: 6, juni: 6, junio: 6, ژوئن: 6, يونيو: 6, july: 7, juli: 7, julio: 7, ژوئیه: 7, يوليو: 7,
    august: 8, augusti: 8, agosto: 8, اوت: 8, آگوست: 8, أغسطس: 8, اغسطس: 8, september: 9, septiembre: 9, سپتامبر: 9, سبتمبر: 9,
    october: 10, oktober: 10, octubre: 10, اکتبر: 10, أكتوبر: 10, اكتوبر: 10, november: 11, noviembre: 11, نوامبر: 11, نوفمبر: 11,
    december: 12, december_sv: 12, dezember: 12, diciembre: 12, دسامبر: 12, ديسمبر: 12,
  };
  const named = raw.match(/(?:^|\s)(\d{1,2})(?::[ae]|\.)?\s+(?:de\s+)?(january|januari|januar|enero|ژانویه|يناير|february|februari|februar|febrero|فوریه|فبراير|march|mars|märz|marz|marzo|مارس|april|abril|آوریل|أبريل|ابريل|may|maj|mai|mayo|مه|مايو|june|juni|junio|ژوئن|يونيو|july|juli|julio|ژوئیه|يوليو|august|augusti|agosto|اوت|آگوست|أغسطس|اغسطس|september|septiembre|سپتامبر|سبتمبر|october|oktober|octubre|اکتبر|أكتوبر|اكتوبر|november|noviembre|نوامبر|نوفمبر|december|dezember|diciembre|دسامبر|ديسمبر)(?:\s+(?:de\s+)?(20\d{2}))?(?:\s|[,.!?]|$)/iu);

  const monthFirstNamed = raw.match(/(?:^|\s)(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)?(20\d{2})?(?=\s|[,.!?]|$)/iu);

  const namedMonth = named
    ? named[2]
    : monthFirstNamed?.[1];

  const namedDay = named
    ? named[1]
    : monthFirstNamed?.[2];

  const namedYear = named
    ? named[3]
    : monthFirstNamed?.[3];

  if (namedMonth && namedDay) {
    const month = monthNames[namedMonth.toLowerCase()];
    const year = Number(namedYear || today.iso.slice(0, 4));
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(Number(namedDay)).padStart(2, '0')}`;
    const parsed = new Date(`${candidate}T12:00:00Z`);

    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === candidate &&
      candidate >= today.iso
    ) {
      return { kind: 'exact_date', value: candidate, confidence: 'high' };
    }

    return undefined;
  }
  if (
    /(?:^|\s)(?:day after tomorrow|i övermorgon|övermorgon|übermorgen|uebermorgen|pasado mañana|pasado manana|pas farda|pasfarda)(?=\s|[.!?,;]|$)/iu.test(raw) ||
    /پس ?فردا|بعد\s+(?:غد[\u064B-\u065F]*ا?|بكر[ةه])/u.test(raw)
  ) {
    return { kind: 'relative_date', value: addIsoDays(today.iso, 2), relative: 'day_after_tomorrow', confidence: 'high' };
  }

  // "morgen" means tomorrow except in the German daypart phrase "am Morgen".
  const germanTomorrow = /\bmorgen\b/iu.test(raw) && !/\bam\s+morgen\b/iu.test(raw);

  if (
    /\b(?:tomorrow|imorgon|mañana|manana|farda)\b/iu.test(raw) ||
    /(?:^|\s)i\s+morgon(?=\s|[.!?,;]|$)/iu.test(raw) ||
    germanTomorrow ||
    /فردا|غد[\u064B-\u065F]*ا?|بكر[ةه]/u.test(raw)
  ) {
    return { kind: 'relative_date', value: addIsoDays(today.iso, 1), relative: 'tomorrow', confidence: 'high' };
  }

  if (
    /\b(?:today|idag|heute|hoy|emrooz|emruz)\b/iu.test(raw) ||
    /امروز|اليوم/u.test(raw)
  ) {
    return { kind: 'relative_date', value: today.iso, relative: 'today', confidence: 'high' };
  }

  const weekdayReference = getBookingWeekdayReference(raw);
  if (!weekdayReference) return undefined;
  const requestedWeekday = weekdayReference.weekday;
  let days = (requestedWeekday - today.weekday + 7) % 7;
  if (weekdayReference.qualifier === 'next') days = days === 0 ? 7 : days + 7;
  else if (days === 0) {
    const explicitTime = parseTimeConstraint(raw);
    const exactTimeIsStillAhead = explicitTime?.kind === 'exact' &&
      explicitTime.startMinutes !== undefined &&
      explicitTime.startMinutes > zonedClockMinutes(now, timezone);
    const isThisWeekday = weekdayReference.qualifier === 'this';
    if (!exactTimeIsStillAhead && !isThisWeekday) days = 7;
    else if (explicitTime?.kind === 'exact' && !exactTimeIsStillAhead) days = 7;
  }
  return { kind: 'weekday', value: addIsoDays(today.iso, days), weekday: requestedWeekday, confidence: 'high' };
}

export function getBookingDateConflict(
  text: string,
  timezone: string,
  now = new Date(),
): NormalizedBookingRequest['dateConflict'] | undefined {
  const normalizedText = normalizeConversationText(text).toLowerCase();
  return detectWeekdayExplicitDateConflict(
    normalizedText,
    parseBookingDateCandidate(normalizedText, timezone, now),
  );
}

export function parseBookingDate(text: string, timezone: string, now = new Date()): NormalizedBookingRequest['date'] | undefined {
  const candidate = parseBookingDateCandidate(text, timezone, now);
  return detectWeekdayExplicitDateConflict(
    normalizeConversationText(text).toLowerCase(),
    candidate,
  ) ? undefined : candidate;
}

function inferService(text: string): NormalizedBookingRequest['service'] | undefined {
  const raw = normalizeConversationText(text).toLowerCase();
  if (/\b(?:consultation|konsultation|moshavereh?)\b/iu.test(raw) || /مشاوره/u.test(raw)) return { raw: text, normalized: 'Konsultation', confidence: 'high' };
  if (/\b(?:laser)\b/iu.test(raw) || /لیزر/u.test(raw)) return { raw: text, normalized: 'Laserbehandling', confidence: 'high' };
  return undefined;
}

export function normalizeBookingRequest(input: ConversationInput): NormalizedBookingRequest {
  const normalizedText = input.inputMode === 'voice' ? normalizeTranscribedText(input.text) : normalizeConversationText(input.text);
  const language = detectLanguage(normalizedText, input.activeLanguage);
  const intent = detectNormalizedIntent(normalizedText);
  const namedDateRange = parseNamedBookingDateRange(
    normalizedText,
    input.timezone,
    input.now
  );
  const parsedDate = namedDateRange
    ? {
        kind: 'date_range' as const,
        value: namedDateRange.startDate,
        endValue: namedDateRange.endDate,
        confidence: 'high' as const,
      }
    : parseBookingDateCandidate(normalizedText, input.timezone, input.now);
  const dateConflict = namedDateRange
    ? undefined
    : detectWeekdayExplicitDateConflict(normalizedText.toLowerCase(), parsedDate);
  const date = dateConflict ? undefined : parsedDate;
  const parsedTimeConstraint = parseTimeConstraint(normalizedText);
  // An explicit named date range is also an authoritative replacement of a
  // previously selected date/time. Persist `none` so state merging cannot retain
  // an old exact clock merely because this turn has no narrower time preference.
  const timeConstraint = parsedTimeConstraint || (namedDateRange
    ? {
        kind: 'none' as const,
        confidence: 'high' as const,
      }
    : undefined);
  const service = inferService(normalizedText);
  const correction = /\b(?:no|not|meant|instead|nej|menade|istället|na|manzuram)\b/iu.test(normalizedText) || /(?:نه|منظورم|به جاش)/u.test(normalizedText);
  const unclearCritical = /\[(?:unclear|نامفهوم)\]/iu.test(normalizedText) && /(?:time|date|day|at|klockan|saat|sate|ساعت|روز|تاریخ)/iu.test(normalizedText);
  const ambiguousTime = (/\b(?:at|klockan|saat|sate)\s+(?:[1-9]|1[0-2])\b/iu.test(normalizedText) && !timeConstraint) || unclearCritical;
  const requiresClarification = ambiguousTime || Boolean(dateConflict);
  return {
    intent,
    language,
    ...(service ? { service } : {}),
    ...(date ? { date } : {}),
    ...(timeConstraint ? { timeConstraint } : {}),
    ...(correction ? { customerCorrection: { replacesDate: Boolean(date), replacesTime: Boolean(timeConstraint), replacesService: Boolean(service) } } : {}),
    sourceMode: input.inputMode,
    normalizedText,
    requiresClarification,
    ...(dateConflict ? { dateConflict } : {}),
    ...(requiresClarification ? {
      clarificationReason: dateConflict
        ? 'weekday_explicit_date_conflict'
        : unclearCritical
          ? 'unclear_critical_segment'
          : 'ambiguous_12_hour_time'
    } : {}),
  };
}

/** Latest explicit fields win. Omitted fields remain; any replacement invalidates prior offers/selection/fingerprint. */
export function mergeNormalizedBookingRequest(
  previous: NormalizedBookingRequest | PersistedNormalizedBookingRequest,
  latest: NormalizedBookingRequest,
): BookingRequestMergeResult {
  return mergeBookingRequest(previous, latest);
}

export function applyNormalizedRequestToPending(pending: Record<string, any>, latest: NormalizedBookingRequest) {
  const transition = applyBookingTransition(pending, latest);
  if (!latest.requiresClarification) {
    pending.normalizedBookingRequest = toPersistedBookingRequest(transition.request);
  }
  return transition;
}

export { isCurrentConversationTurn, registerConversationTurn } from './booking-state-machine';

/** Between is inclusive at both ends; before/after are strict; from is inclusive. */
export function slotMinutesSatisfyConstraint(minutes: number, constraint?: NormalizedTimeConstraint): boolean {
  if (!constraint || constraint.kind === 'none') return true;
  if (constraint.startMinutes !== undefined && (constraint.startInclusive === false ? minutes <= constraint.startMinutes : minutes < constraint.startMinutes)) return false;
  if (constraint.endMinutes !== undefined && (constraint.endInclusive === false ? minutes >= constraint.endMinutes : minutes > constraint.endMinutes)) return false;
  if (constraint.kind === 'exact') return minutes === constraint.startMinutes;
  return true;
}

export function getZonedSlotParts(iso: string, timezone: string): { date: string; minutes: number } | null {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function zonedLocalIso(date: string, time: string, timezone: string): string {
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(new Date(`${date}T12:00:00Z`)).find(part => part.type === 'timeZoneName')?.value || 'GMT+00:00';
  return `${date}T${time}${offsetName.replace('GMT', '').replace('−', '-') || '+00:00'}`;
}

export function buildSlotFingerprintSource(input: {
  businessId: string; service: string; date: string; timezone: string;
  constraint?: NormalizedTimeConstraint; durationMinutes: number;
}): string {
  return JSON.stringify({
    businessId: input.businessId,
    service: input.service.trim().toLowerCase(),
    date: input.date,
    timezone: input.timezone,
    kind: input.constraint?.kind || 'none',
    startMinutes: input.constraint?.startMinutes ?? null,
    endMinutes: input.constraint?.endMinutes ?? null,
    startInclusive: input.constraint?.startInclusive ?? null,
    endInclusive: input.constraint?.endInclusive ?? null,
    durationMinutes: input.durationMinutes,
  });
}

export function availabilityFieldsFromConstraint(constraint: NormalizedTimeConstraint): Record<string, any> {
  const clock = (minutes?: number) => minutes === undefined ? undefined : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  if (constraint.kind === 'exact') return { kind: 'exact_time', exactTime: clock(constraint.startMinutes) };
  if (constraint.kind === 'between') return { kind: 'time_window', minTime: clock(constraint.startMinutes), maxTime: clock(constraint.endMinutes) };
  if (constraint.kind === 'before') return { kind: 'time_boundary', timeBoundary: { kind: 'exclusive_upper', time: clock(constraint.endMinutes) } };
  if (constraint.kind === 'after') return { kind: 'time_boundary', timeBoundary: { kind: 'exclusive_lower', time: clock(constraint.startMinutes) } };
  if (constraint.kind === 'from') return { kind: 'time_boundary', timeBoundary: { kind: 'inclusive_lower', time: clock(constraint.startMinutes) } };
  return { kind: 'daypart', daypart: constraint.kind, minTime: clock(constraint.startMinutes), maxTime: clock(constraint.endMinutes) };
}

const FA_HOURS = ['دوازده', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه', 'ده', 'یازده'];
export function formatPersianSpokenTime(minutesAfterMidnight: number): string {
  const hour24 = Math.floor(minutesAfterMidnight / 60);
  const minute = minutesAfterMidnight % 60;
  if (hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59) return '';
  const hour = FA_HOURS[hour24 % 12];
  const suffix = hour24 < 12 ? 'صبح' : hour24 < 17 ? 'بعدازظهر' : 'عصر';
  const minuteText = minute === 0 ? '' : minute === 15 ? ' و ربع' : minute === 30 ? ' و نیم' : minute === 45 ? ' و چهل و پنج دقیقه' : ` و ${minute} دقیقه`;
  return `ساعت ${hour}${minuteText} ${suffix}`;
}

export function preparePersianTextForTts(text: string): string {
  let output = normalizeConversationText(text).replace(/(?:ساعت\s*){2,}/gu, 'ساعت ');
  output = output.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, value => formatPersianSpokenDate(value));
  output = output.replace(/(?:ساعت\s*)?(\d{1,2}):([0-5]\d)/gu, (_match, hours, minutes) => formatPersianSpokenTime(Number(hours) * 60 + Number(minutes)));
  return output.replace(/(?:ساعت\s*){2,}/gu, 'ساعت ').trim();
}

export function formatPersianSpokenPhone(phone: string): string {
  const names = ['صفر', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
  return normalizeConversationText(phone).replace(/\d/g, digit => `${names[Number(digit)]} `).replace(/\s+/g, ' ').trim();
}

export function formatPersianSpokenDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const months = ['ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن', 'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر'];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${Number(match[1])}`;
}
