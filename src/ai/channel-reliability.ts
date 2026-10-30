import { isBusinessInformationQuestion, isExplicitBusinessActionRequest } from './business-information';
import { hasBookingInterruption, withoutNegatedBookingClauses } from './booking-interruption';
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

/** Only top-level communication instructions authorize an explicit switch.
 * Keep clause-local target binding; quoted instructions are data, not requests. */
export function languageInstructionText(text: string): string {
  return text.normalize('NFKC')
    .replace(/```[\s\S]*?```|`[^`]*`/gu,' ')
    .replace(/"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu,' ');
}

// Recognition-only projections never edit the customer message used by other flows.
const LANGUAGE_NEGATION = /\b(?:do\s+not|don['’]t|not|never|no|nicht|nie|niemals|kein(?:e[nrms]?)?|inte|ej|aldrig|icke|nunca|jam[aá]s)\b|(?:^|[^\p{L}\p{N}])(?:هرگز|هیچ[‌\s]?وقت|نکن(?:ید|یم)?|مکن(?:ید)?|نده(?:ید)?|ننویس(?:ید)?|نگو(?:یید)?|نزن(?:ید)?|لا|ليس|أبدا|أبدًا)(?=$|[^\p{L}\p{N}])/iu;
const LANGUAGE_UNCERTAINTY = /\b(?:maybe|perhaps|possibly|vielleicht|eventuell|kanske|möjligen|quiz[aá]s?|tal\s+vez)\b|(?:^|[^\p{L}\p{N}])(?:شاید|ممکن\s+است|ربما|لعل)(?=$|[^\p{L}\p{N}])/iu;
type DirectLanguageInstruction = {targets:string[];polarity:'positive'|'negative'|'uncertain'};

/** Rejection is distinct from absence: implicit/model language detection must
 * not turn a rejected communication instruction into an authorized switch. */
export function languageSwitchDecision(text:string): {language:string|null;blocksImplicit:boolean} {
  if(text.length>4000)return {language:null,blocksImplicit:true};
  const unquoted=languageInstructionText(text);
  const positive=new Set<string>(),negative=new Set<string>();let uncertain=false,recognized=false;
  const clauses=unquoted.split(/[.!?؟,،;؛\n]+|\s+(?:and|but|und|aber|och|men|y|pero|اما|ولی|لكن|و)\s+/iu).map(c=>c.trim()).filter(Boolean);
  for(const clause of clauses) {
    const direct=clause.replace(/^(?:and|but|und|aber|och|men|y|pero|اما|ولی|لكن|و)\s+/iu,'');
    const instruction=detectDirectLanguageSwitch(direct,clauses.length===1);
    if(!instruction)continue;
    recognized=true;
    if(instruction.polarity==='uncertain')uncertain=true;
    else for(const target of instruction.targets)(instruction.polarity==='negative'?negative:positive).add(target);
  }
  const selected=positive.size===1?[...positive][0]:null;
  const language=selected&&!negative.has(selected)&&!uncertain?selected:null;
  return {language,blocksImplicit:recognized&&!language};
}
export function detectExplicitLanguageSwitch(text: string): string | null {
  return languageSwitchDecision(text).language;
}

function detectDirectLanguageSwitch(text: string, allowSelection: boolean): DirectLanguageInstruction | null {
  const raw = String(text || '').normalize('NFKC').trim().toLowerCase();
  if (!raw) return null;

  // A language name mentioned in ordinary prose must not change the active
  // conversation language. Accept only a short language selection or a clear
  // communication request addressed to the assistant.
  const negative=LANGUAGE_NEGATION.test(raw),uncertain=LANGUAGE_UNCERTAINTY.test(raw);
  const recognition=raw.replace(new RegExp(LANGUAGE_NEGATION.source,'giu'),' ')
    .replace(new RegExp(LANGUAGE_UNCERTAINTY.source,'giu'),' ').replace(/\s+/gu,' ').trim();
  const selection = recognition
    .replace(/[.!?؟]+$/u, '')
    .trim()
    .replace(/^(?:please|bitte|por favor|snälla|لطفاً?|من فضلك)\s+/u, '')
    .replace(/\s+(?:please|bitte|tack)$/u, '');

  const languageAliases: Array<[string, RegExp]> = [
    ['en', /(?:^|[^\p{L}\p{N}])(?:english|englisch|engelska|inglés|ingles|انگلیسی|الإنجليزية)(?=$|[^\p{L}\p{N}])/u],
    ['sv', /(?:^|[^\p{L}\p{N}])(?:svenska|swedish|schwedisch|sueco|سوئدی|السويدية)(?=$|[^\p{L}\p{N}])/u],
    ['de', /(?:^|[^\p{L}\p{N}])(?:deutsch|german|tyska|alemán|aleman|آلمانی|الألمانية)(?=$|[^\p{L}\p{N}])/u],
    ['es', /(?:^|[^\p{L}\p{N}])(?:español|espanol|spanish|spanska|spanisch|اسپانیایی|الإسبانية)(?=$|[^\p{L}\p{N}])/u],
    ['fa', /(?:^|[^\p{L}\p{N}])(?:farsi|persian|فارسی|persiska|persisch|persa|الفارسية)(?=$|[^\p{L}\p{N}])/u],
    ['ar', /(?:^|[^\p{L}\p{N}])(?:arabic|عربي|العربية|بالعربية|عربی|arabiska|arabisch|árabe|arabe)(?=$|[^\p{L}\p{N}])/u],
  ];

  const matches=languageAliases.filter(([,pattern])=>pattern.test(selection));
  const selectedLanguage = matches.length===1?matches[0][0]:null;

  const languageOnly = Boolean(
    selectedLanguage &&
    /^(?:(?:in|auf|på|en|به|به زبان|باللغة)\s+)?[\p{L}\p{M}]+$/u.test(selection)
  );

  const request =
    /^(?:(?:please|bitte|por favor|snälla)[,\s]+)?(?:(?:can|could|would)\s+(?:you|we)\s+)?(?:reply|respond|answer|speak|write|continue|switch|use|antworten|antworte|sprechen|sprich|wechsle|wechseln|schreib|schreiben|verwende|verwenden|benutze|benutzen|svara|prata|skriv|använd|fortsätt|byt|responde|responder|habla|hablar|contesta|cambia|escribe|escriba|usa|use|utiliza|utilice)\b/u.test(recognition) ||
    /^(?:kan\s+du|kan\s+ni)\s+(?:svara|prata|skriva|använda|fortsätta|byta)\b/u.test(recognition) ||
    /^(?:bitte\s+)?(?:antworten|sprechen)\s+sie\b/u.test(recognition) ||
    /^(?:por favor[,\s]+)?(?:responde|respóndeme|contesta|habla|continúa|continua|cambia)\b/u.test(recognition) ||
    /^(?:لطفاً?\s+)?(?:از\s+این\s+به\s+بعد\s+)?(?:به\s+[\p{L}\p{M}]+\s+)?(?:پاسخ|جواب|صحبت|حرف|بنویس(?:ید)?|ننویس(?:ید)?)(?=$|[^\p{L}\p{N}])/u.test(recognition) ||
    /^(?:لطفاً?\s+)?(?:از\s+این\s+به\s+بعد\s+)?به\s+[\p{L}\p{M}]+(?:\s+با\s+من)?\s+(?:پاسخ\s+(?:بده|دهید)|جواب\s+(?:بده|دهید)|صحبت\s+(?:کن|کنید))/u.test(recognition) ||
    /^(?:لطفاً?\s+)?فارسی(?:\s+با\s+من)?\s+صحبت(?:\s+کنیم|\s+کن|\s+کنید)?/u.test(recognition) ||
    /^(?:(?:من فضلك|رجاءً?)\s+)?(?:أجب|اجب|تحدث|تكلم|اكتب|أكتب|استخدم)(?=$|[^\p{L}\p{N}])/u.test(recognition) ||
    /^(?:(?:من فضلك|رجاءً?)\s+)?(?:أجب|اجب|تحدث|تكلم|اكتب|أكتب|استخدم)\s+(?:ب)?العربية/u.test(recognition) ||
    /^(?:لطفاً?\s+)?از\s+(?:زبان\s+)?[\p{L}\p{M}]+\s+استفاده/u.test(recognition) ||
    negative&&(/^(?:(?:من فضلك|رجاءً?)\s+)?(?:تجب|تتحدث|تتكلم|تكتب|تستخدم)(?=$|[^\p{L}\p{N}])/u.test(recognition)||
      /^(?:por favor\s+)?(?:respondas|hables|escribas|uses|utilices)\b/u.test(recognition));

  if (!matches.length || (!languageOnly && !request) || (!allowSelection && !request && !(languageOnly&&(negative||uncertain)))) return null;
  if(matches.length!==1)return {targets:matches.map(([code])=>code),polarity:'uncertain'};
  if(request&&!languageOnly) {
    const target=matches[0][1].exec(recognition);
    if(!target)return null;
    const before=recognition.slice(0,target.index+target[0].search(/[\p{L}\p{M}]/u));
    // A language in an explanation/topic is not the requested reply language.
    const boundTarget=/(?:\b(?:in|auf|på|en|to|till|a)|به(?: زبان)?|از(?: زبان)?|باللغة|ب)\s*$/u.test(before)||
      /(?:\b(?:speak|write|use|habla|hablar|escribe|escriba|usa|use|utiliza|utilice|prata|skriv|använd|sprich|schreib|schreiben(?: sie)?|verwende|verwenden(?: sie)?|benutze|benutzen(?: sie)?)|(?:^|\s)(?:تحدث|تكلم|أجب|اجب|اكتب|أكتب|استخدم|تجب|تتحدث|تتكلم|تكتب|تستخدم))\s+$/u.test(before)||
      /^(?:لطفاً?\s+)?فارسی(?:\s+با\s+من)?\s+صحبت/u.test(raw)||
      negative&&/\b(?:respondas|hables|escribas|uses|utilices)\s+$/u.test(before);
    if(!boundTarget)return null;
    if(/^(?:can|could)\s+you\s+speak\b/u.test(raw))return {targets:[selectedLanguage!],polarity:'uncertain'};
  }

  return {targets:[selectedLanguage!],polarity:uncertain?'uncertain':negative?'negative':'positive'};
}

export function resolveStableConversationLanguage(
  previous: string | null | undefined,
  detected: string,
  explicitSwitch?: string | null,
): string {
  return explicitSwitch || previous || detected;
}

export function classifyMessagingIntent(text: string): MessagingIntent {
  const raw = withoutNegatedBookingClauses(text).normalize('NFKC').trim().toLowerCase();
  if (!raw) return hasBookingInterruption(text) ? 'normal' : 'ambiguous';

  if (
    /\b(?:why|chera|varför|warum|por qué|por que).{0,30}(?:language|zaban|språk|sprache|idioma).{0,30}(?:change|avaz|switch|bytte|ändra|wechsel|cambi)/iu.test(raw) ||
    /(?:چرا|چرا زبان).{0,30}(?:عوض|تغییر)/u.test(raw)
  ) return 'language_repair';

  if (isBusinessInformationQuestion(raw)) return 'normal';

  if (
    /\b(?:cancel|cancellation|avboka|laghv).{0,24}(?:appointment|booking|tid|vaght|rezerv)?\b/iu.test(raw) ||
    /\b(?:appointment|booking|tid|vaght|vaghtam|rezerv).{0,24}(?:cancel|avboka|laghv)\b/iu.test(raw) ||
    /(?:لغو|کنسل).{0,24}(?:وقت|رزرو)?/u.test(raw)
  ) return 'cancellation';

  if (
    /\b(?:reschedule|move|change|taghir|avaz).{0,30}(?:appointment|booking|time|tid|vaght|vaghtam|rezerv)\b/iu.test(raw) ||
    /\b(?:appointment|booking|time|tid|vaght|vaghtam|rezerv).{0,30}(?:reschedule|move|change|taghir|avaz)\b/iu.test(raw) ||
    /\b(?:ändra|flytta|boka om).{0,24}(?:tid|bokning)?\b/iu.test(raw) ||
    /\b(?:avaz|taghir)\s+(?:bedam|konam)\b/iu.test(raw) ||
    /(?:تغییر|عوض).{0,24}(?:وقت|رزرو|کنم|بدم)/u.test(raw)
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
  if (sharedIntent === 'cancellation' || sharedIntent === 'reschedule') return sharedIntent;
  if (sharedIntent === 'new_booking') return 'new_booking';
  if (sharedIntent === 'booking_lookup') return 'existing_booking_lookup';
  // An explicit action is dispatch authority even if its service still needs
  // resolution. The engine retains ownership/confirmation checks.
  if (sharedIntent === 'clarification' && isExplicitBusinessActionRequest(raw)) return 'new_booking';
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
