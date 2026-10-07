/** Catalog-independent language normalization. This module never creates a service. */
export function normalizeServiceIntent(value: string): string {
  return value.normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/gu, '')
    .replace(/[يى]/gu, 'ی').replace(/ك/gu, 'ک')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const temporalWords = `
for on at around before after from between in the of next this coming today tomorrow day
morning afternoon evening monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
and to please book schedule reserve
idag imorgon övermorgon i morgon på till för den det nästa nästkommande kommande denna
runt omkring före innan efter från mellan kl klockan morgonen förmiddagen eftermiddagen kvällen
måndag tisdag onsdag torsdag fredag lördag söndag januari februari mars maj juni juli augusti oktober november december och tack
heute morgen übermorgen uebermorgen am um gegen vor nach ab zwischen für fuer nächsten nächste diesen dieser
vormittag vormittags nachmittag nachmittags abend abends montag dienstag mittwoch donnerstag freitag samstag sonntag
januar februar märz maerz mai juni juli oktober dezember uhr buchen bitte und
hoy mañana manana pasado para el la las a alrededor de antes después despues desde entre por
tarde noche lunes martes miércoles miercoles jueves viernes sábado sabado domingo
enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre reservar y
امروز فردا پس برای در حدود حوالی ساعت قبل بعد از صبح ظهر عصر شب
شنبه یکشنبه دوشنبه سه چهارشنبه پنجشنبه جمعه ژانویه فوریه مارس آوریل مه ژوئن ژوئیه اوت سپتامبر اکتبر نوامبر دسامبر رزرو کنم را و
اليوم غدا غد للغد لليوم بعد حوالي نحو الساعة ساعة قبل صباحا صباح مساء مساءا ظهرا الظهر العصر الليل
في بتاريخ عند يوم الأحد الاحد الاثنين الثلاثاء الأربعاء الاربعاء الخميس الجمعة السبت
يناير فبراير أبريل مايو يونيو يوليو أغسطس سبتمبر أكتوبر نوفمبر ديسمبر حجز
`;
const temporalTokens = new Set(normalizeServiceIntent(temporalWords).split(/\s+/u));
const temporalSignals = new Set(normalizeServiceIntent(`today tomorrow morning afternoon evening
monday tuesday wednesday thursday friday saturday sunday
idag imorgon övermorgon morgon morgonen förmiddagen eftermiddagen kvällen måndag tisdag onsdag torsdag fredag lördag söndag
heute morgen übermorgen uebermorgen vormittag vormittags nachmittag nachmittags abend abends montag dienstag mittwoch donnerstag freitag samstag sonntag
hoy mañana manana tarde noche lunes martes miércoles miercoles jueves viernes sábado sabado domingo
امروز فردا صبح ظهر عصر شب شنبه یکشنبه دوشنبه چهارشنبه پنجشنبه جمعه
اليوم غدا للغد لليوم صباحا صباح مساء مساءا ظهرا الظهر العصر الليل الأحد الاحد الاثنين الثلاثاء الأربعاء الاربعاء الخميس الجمعة السبت`).split(/\s+/u));

/** Remove a complete temporal suffix, never arbitrary words after the service.
 * Full catalog labels are matched against the original turn before this runs.
 * Requiring an entirely temporal suffix preserves e.g. "Good Morning Facial".
 */
export function stripServiceTemporalSuffix(value: string): string {
  const raw = value.replace(/\s+/gu, ' ').trim();
  for (const boundary of raw.matchAll(/\s+/gu)) {
    const suffix = raw.slice(boundary.index! + boundary[0].length);
    const tokens = normalizeServiceIntent(suffix).split(/\s+/u).filter(Boolean);
    // Some service concepts contain temporal-looking words, e.g. Arabic
    // "استشارة عن بعد" (remote consultation). Protect the complete concept.
    const before = normalizeServiceIntent(raw.slice(0, boundary.index)).split(/\s+/u);
    const crossesConcept = Object.values(conceptLabels).flat().some(label => {
      const parts = normalizeServiceIntent(label).split(/\s+/u);
      return parts.some((_, split) => split > 0 &&
        before.slice(-split).join(' ') === parts.slice(0, split).join(' ') &&
        tokens.slice(0, parts.length - split).join(' ') === parts.slice(split).join(' '));
    });
    if (crossesConcept) continue;
    const hasSignal = tokens.some(token => temporalSignals.has(token)) ||
      (tokens.some(token => /^[\p{N}]+$/u.test(token)) && tokens.some(token => temporalTokens.has(token))) ||
      /[0-9۰-۹٠-٩]{1,2}[:./-][0-9۰-۹٠-٩]{1,4}/u.test(suffix) ||
      /^(?:at|around|before|after|kl\.?|klockan|um|gegen|vor|nach|a las|antes|después|ساعت|الساعة)\s+[0-9۰-۹٠-٩]/iu.test(suffix);
    if (hasSignal && tokens.every(token => temporalTokens.has(token) || /^[\p{N}]+(?:st|nd|rd|th|e|a)?$/u.test(token))) {
      return raw.slice(0, boundary.index).replace(/[،,;:]$/u, '').trim();
    }
  }
  return raw;
}

// Deliberately bounded concepts. Qualifiers such as skin/premium/business must
// survive; a generic consultation must not erase those distinctions.
const conceptLabels = {
  video_consultation: [
    'video consultation', 'video consult', 'online consultation', 'online consult', 'virtual consultation',
    'videokonsultation', 'video konsultation', 'videokonsultationen', 'videokonsultationer', 'online konsultation',
    'videoberatung', 'video beratung', 'videokonsultation', 'online beratung', 'online konsultation',
    'videoconsulta', 'video consulta', 'consulta por video', 'consulta online', 'consulta en línea', 'consulta virtual',
    'مشاوره ویدیویی', 'مشاوره ویدئویی', 'مشاوره آنلاین', 'مشاوره تصویری',
    'استشارة فيديو', 'استشارة بالفيديو', 'استشارة عبر الفيديو', 'استشارة اونلاين', 'استشارة آنلاین', 'استشارة عن بعد',
    'video مشاوره', 'video استشارة', 'video beratung', 'video consulta',
  ],
} as const;

/** Detect a qualified concept inside conversational wording before legacy
 * generic inference can erase its modality. */
export function hasQualifiedServiceConcept(value: string): boolean {
  const normalized = ` ${normalizeServiceIntent(value)} `;
  return Object.values(conceptLabels).flat().some(label => normalized.includes(` ${normalizeServiceIntent(label)} `));
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = row;
  }
  return previous[b.length];
}

function closeLabel(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 6 || Math.max(a.length, b.length) > 160) return false;
  const limit = Math.min(a.length, b.length) >= 12 ? 2 : 1;
  return Math.abs(a.length - b.length) <= limit && editDistance(a, b) <= limit;
}

export function serviceIntentConcept(value: string): string | null {
  const compact = normalizeServiceIntent(value).replace(/\s+/gu, '');
  for (const [concept, labels] of Object.entries(conceptLabels)) {
    if (labels.some(label => {
      const normalized = normalizeServiceIntent(label).replace(/\s+/gu, '');
      return compact === normalized || closeLabel(compact, normalized);
    })) return concept;
  }
  return null;
}

export const SERVICE_AUTO_MATCH_CONFIDENCE = 0.9;

/** Scores are deterministic evidence tiers, not calibrated probabilities. */
export function serviceIntentMatchScore(requested: string, label: string): number {
  const a = normalizeServiceIntent(requested), b = normalizeServiceIntent(label);
  if (!a || !b) return 0;
  // Short catalog labels often collide with contact names. Do not fold accents
  // or apply spelling tolerance to them ("test́" must not select "test").
  if (Math.min(a.length, b.length) < 6 && requested.normalize('NFC').toLowerCase() !== label.normalize('NFC').toLowerCase()) return 0;
  if (a === b) return 1;
  const ac = a.replace(/\s+/gu, ''), bc = b.replace(/\s+/gu, '');
  if (ac === bc) return 0.98;
  const concept = serviceIntentConcept(a);
  if (concept) return concept === serviceIntentConcept(b) ? 0.94 : 0;
  if (closeLabel(ac, bc)) return 0.9;
  return 0;
}

/** The provider may identify a service span, but cannot supply a booking ID or
 * substitute an invented label. Existing adoption flags still control calls. */
export function groundedSemanticServicePhrase(text: string, proposed: string, confidence: number): string | null {
  if (!Number.isFinite(confidence) || confidence < 0.8 || confidence > 1 || !proposed.trim() || proposed.length > 160) return null;
  const phrase = proposed.normalize('NFKC').trim();
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(text.normalize('NFKC'))) return null;
  return stripServiceTemporalSuffix(phrase);
}
