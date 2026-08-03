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

function detectLanguage(text: string, active?: SupportedLanguage): SupportedLanguage {
  if (/[\u0600-\u06ff]/u.test(text)) return 'fa';
  if (/\b(?:jag|vill|boka|fredag|före|efter|klockan|mellan|tid)\b/iu.test(text)) return 'sv';
  if (/\b(?:mikham|mitoni|vaght|jomeh?|baraye|ghabl|sate?|moshavereh?|chera|zaban)\b/iu.test(text)) return 'fa';
  return active || 'en';
}

export function detectNormalizedIntent(text: string): NormalizedIntent {
  const raw = normalizeConversationText(text).toLowerCase();
  if (!raw) return 'unknown';
  if (/\b(?:why|chera|varför).{0,30}(?:language|zaban|språk).{0,30}(?:change|avaz|switch|ändra)\b/iu.test(raw) || /چرا.{0,20}(?:زبان).{0,20}(?:عوض|تغییر)/u.test(raw)) return 'general_question';
  if (/\b(?:cancel|avboka|laghv).{0,25}(?:appointment|booking|tid|vaght|rezerv)?\b/iu.test(raw) || /(?:لغو|کنسل).{0,20}(?:وقت|رزرو)/u.test(raw)) return 'cancellation';
  if (/(?:^|\s)(?:reschedule|move|change|ändra|flytta|taghir|avaz).{0,30}(?:appointment|booking|time|tid|vaght|rezerv)(?=\s|$)/iu.test(raw) || /(?:^|\s)boka\s+om(?=\s|$)/iu.test(raw) || /\b(?:avaz|taghir)\s+(?:bedam|konam)\b/iu.test(raw) || /(?:تغییر|عوض).{0,20}(?:وقت|رزرو|کنم|بدم)/u.test(raw)) return 'reschedule';
  if (/\b(?:do i have|did i book|check|har jag|aya).{0,30}(?:appointment|booking|tid|vaght|rezerv)\b/iu.test(raw) || /(?:آیا|میشه).{0,24}(?:وقت|رزرو).{0,24}(?:دارم|کردم)/u.test(raw)) return 'booking_lookup';

  const bookingNoun = /\b(?:appointment|booking|consultation|slot|boka|bokning|tid|konsultation|vaght|rezerv|moshavereh?|laser)\b/iu.test(raw) || /(?:وقت|رزرو|مشاوره|لیزر)/u.test(raw);
  const bookingAction = /\b(?:book|want|need|available|have anything|boka|vill|behöver|finns|har ni|mikham|mikhastam|mitoni|bدي|begiram|dari)\b/iu.test(raw) || /(?:می ?خوام|می ?خواهم|می ?تونی|وقت داری|بگیرم|بگیری)/u.test(raw);
  const dateOrTime = /\b(?:today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|fredag|måndag|tisdag|onsdag|torsdag|lördag|söndag|jomeh?|shanbe|sate?|after|before|efter|före)\b/iu.test(raw) || /(?:امروز|فردا|جمعه|شنبه|ساعت|بعد از|قبل از)/u.test(raw);
  if ((bookingNoun && bookingAction) || (bookingNoun && dateOrTime)) return 'new_booking';
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

export function parseTimeConstraint(text: string): NormalizedTimeConstraint | undefined {
  const raw = normalizeTranscribedText(text)
    .toLowerCase()
    .replace(/\bnoon\b/giu, '12:00')
    .replace(/ظهر/gu, '12:00');
  if (!raw || /\[(?:unclear|نامفهوم)\]/iu.test(raw)) return undefined;
  const token = String.raw`([01]?\d|2[0-3])(?:[\.:](\d{2}))?\s*(am|pm)?\s*(morning|afternoon|evening|morgon|eftermiddag|kväll|صبح|بعدازظهر|عصر)?`;
  const between = raw.match(new RegExp(String.raw`(?:between|mellan|bin|بین)\s*(?:klockan|saat|sate|ساعت)?\s*${token}\s*(?:and|och|ta|تا|و)\s*(?:klockan|saat|sate|ساعت)?\s*${token}`, 'iu'));
  if (between) {
    const start = clockToMinutes(between[1], between[2], between[3], between[4]);
    const end = clockToMinutes(between[5], between[6], between[7], between[8]);
    if (start !== null && end !== null && start < end) return { kind: 'between', startMinutes: start, endMinutes: end, startInclusive: true, endInclusive: true, confidence: 'high' };
  }
  const rules: Array<[NormalizedTimeConstraint['kind'], RegExp, boolean, boolean]> = [
    ['after', new RegExp(String.raw`(?:after|efter(?: klockan)?|bad az(?: sate?)?|بعد از(?: ساعت)?)\s*${token}`, 'iu'), false, false],
    ['before', new RegExp(String.raw`(?:before|före(?: klockan)?|ghabl az(?: sate?)?|قبل از(?: ساعت)?)\s*${token}`, 'iu'), false, false],
    ['from', new RegExp(String.raw`(?:from|från(?: klockan)?|az(?: sate?)?|از(?: ساعت)?)\s*${token}`, 'iu'), true, false],
    ['exact', new RegExp(String.raw`(?:at|klockan|kl\.?|saat|sate|ساعت)\s*${token}`, 'iu'), true, true],
  ];
  for (const [kind, pattern, startInclusive, endInclusive] of rules) {
    const match = raw.match(pattern);
    if (!match) continue;
    const value = clockToMinutes(match[1], match[2], match[3], match[4]);
    if (value === null) return undefined;
    if (kind === 'before') return { kind, endMinutes: value, endInclusive, confidence: 'high' };
    return { kind, startMinutes: value, startInclusive, endInclusive, confidence: 'high' };
  }
  const bareExact = raw.match(/^([01]?\d|2[0-3])[\.:]([0-5]\d)$/u);
  if (bareExact) {
    return { kind: 'exact', startMinutes: Number(bareExact[1]) * 60 + Number(bareExact[2]), startInclusive: true, endInclusive: true, confidence: 'high' };
  }
  if (/\b(?:morning|morgon)\b/iu.test(raw) || /صبح/u.test(raw)) return { kind: 'morning', startMinutes: 9 * 60, endMinutes: 12 * 60, startInclusive: true, endInclusive: false, confidence: 'high' };
  if (/\b(?:afternoon|eftermiddag)\b/iu.test(raw) || /بعدازظهر/u.test(raw)) return { kind: 'afternoon', startMinutes: 12 * 60, endMinutes: 17 * 60, startInclusive: true, endInclusive: false, confidence: 'high' };
  if (/\b(?:evening|kväll)\b/iu.test(raw) || /عصر/u.test(raw)) return { kind: 'evening', startMinutes: 17 * 60, endMinutes: 20 * 60, startInclusive: true, endInclusive: true, confidence: 'high' };
  return undefined;
}

function zonedDateParts(date: Date, timezone: string): { iso: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { iso: `${get('year')}-${get('month')}-${get('day')}`, weekday };
}

export function getDateInTimeZone(date: Date, timezone: string): string {
  return zonedDateParts(date, timezone).iso;
}

function addIsoDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parseBookingDate(text: string, timezone: string, now = new Date()): NormalizedBookingRequest['date'] | undefined {
  const raw = normalizeConversationText(text).toLowerCase();
  const today = zonedDateParts(now, timezone);
  const isoMatch = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const candidate = new Date(`${isoMatch[1]}T12:00:00Z`);
    if (!Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === isoMatch[1] && isoMatch[1] >= today.iso) return { kind: 'exact_date', value: isoMatch[1], confidence: 'high' };
    return undefined;
  }
  const monthNames: Record<string, number> = {
    january: 1, januari: 1, ژانویه: 1, february: 2, februari: 2, فوریه: 2,
    march: 3, mars: 3, مارس: 3, april: 4, آوریل: 4, may: 5, maj: 5, مه: 5,
    june: 6, juni: 6, ژوئن: 6, july: 7, juli: 7, ژوئیه: 7,
    august: 8, augusti: 8, اوت: 8, september: 9, سپتامبر: 9,
    october: 10, oktober: 10, اکتبر: 10, november: 11, نوامبر: 11,
    december: 12, december_sv: 12, دسامبر: 12,
  };
  const named = raw.match(/(?:^|\s)(\d{1,2})(?::e)?\s+(january|januari|ژانویه|february|februari|فوریه|march|mars|مارس|april|آوریل|may|maj|مه|june|juni|ژوئن|july|juli|ژوئیه|august|augusti|اوت|september|سپتامبر|october|oktober|اکتبر|november|نوامبر|december|دسامبر)(?:\s+(20\d{2}))?(?:\s|$)/iu);
  if (named) {
    const month = monthNames[named[2].toLowerCase()];
    const year = Number(named[3] || today.iso.slice(0, 4));
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(Number(named[1])).padStart(2, '0')}`;
    const parsed = new Date(`${candidate}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate && candidate >= today.iso) return { kind: 'exact_date', value: candidate, confidence: 'high' };
    return undefined;
  }
  if (/\b(?:day after tomorrow|i övermorgon|övermorgon|pas farda|pasfarda)\b/iu.test(raw) || /پس ?فردا/u.test(raw)) return { kind: 'relative_date', value: addIsoDays(today.iso, 2), relative: 'day_after_tomorrow', confidence: 'high' };
  if (/\b(?:tomorrow|imorgon|farda)\b/iu.test(raw) || /فردا/u.test(raw)) return { kind: 'relative_date', value: addIsoDays(today.iso, 1), relative: 'tomorrow', confidence: 'high' };
  if (/\b(?:today|idag|emrooz|emruz)\b/iu.test(raw) || /امروز/u.test(raw)) return { kind: 'relative_date', value: today.iso, relative: 'today', confidence: 'high' };
  const weekdays: Array<[number, RegExp]> = [
    [0, /\b(?:sunday|söndag|yek\s*shanbe|1\s*shanbe)\b|یک ?شنبه/iu], [1, /\b(?:monday|måndag|do\s*shanbe|2\s*shanbe)\b|دو ?شنبه/iu],
    [2, /\b(?:tuesday|tisdag|se\s*shanbe|3\s*shanbe)\b|سه ?شنبه/iu], [3, /\b(?:wednesday|onsdag|chahar\s*shanbe|4\s*shanbe)\b|چهار ?شنبه/iu],
    [4, /\b(?:thursday|torsdag|panj\s*shanbe|5\s*shanbe)\b|پنج ?شنبه/iu], [5, /\b(?:friday|fredag|jomeh?)\b|جمعه/iu],
    [6, /\b(?:saturday|lördag|(?<![1-5])shanbe)\b|(?<!یک |دو |سه |چهار |پنج )شنبه/iu],
  ];
  const matched = weekdays.find(([, pattern]) => pattern.test(raw));
  if (!matched) return undefined;
  const isNext = /\b(?:next|nästa|ayande)\b/iu.test(raw) || /آینده/u.test(raw);
  let days = (matched[0] - today.weekday + 7) % 7;
  if (isNext) days = days === 0 ? 7 : days + 7;
  else if (days === 0 && !/\bthis\b|\bdenna\b|همین|این/u.test(raw)) days = 7;
  return { kind: 'weekday', value: addIsoDays(today.iso, days), weekday: matched[0], confidence: 'high' };
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
  const date = parseBookingDate(normalizedText, input.timezone, input.now);
  const timeConstraint = parseTimeConstraint(normalizedText);
  const service = inferService(normalizedText);
  const correction = /\b(?:no|not|meant|instead|nej|menade|istället|na|manzuram)\b/iu.test(normalizedText) || /(?:نه|منظورم|به جاش)/u.test(normalizedText);
  const unclearCritical = /\[(?:unclear|نامفهوم)\]/iu.test(normalizedText) && /(?:time|date|day|at|klockan|saat|sate|ساعت|روز|تاریخ)/iu.test(normalizedText);
  const ambiguousTime = (/\b(?:at|klockan|saat|sate)\s+(?:[1-9]|1[0-2])\b/iu.test(normalizedText) && !timeConstraint) || unclearCritical;
  return {
    intent,
    language,
    ...(service ? { service } : {}),
    ...(date ? { date } : {}),
    ...(timeConstraint ? { timeConstraint } : {}),
    ...(correction ? { customerCorrection: { replacesDate: Boolean(date), replacesTime: Boolean(timeConstraint), replacesService: Boolean(service) } } : {}),
    sourceMode: input.inputMode,
    normalizedText,
    requiresClarification: ambiguousTime,
    ...(ambiguousTime ? { clarificationReason: unclearCritical ? 'unclear_critical_segment' : 'ambiguous_12_hour_time' } : {}),
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
  pending.normalizedBookingRequest = toPersistedBookingRequest(transition.request);
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
