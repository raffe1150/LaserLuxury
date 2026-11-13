// Deterministic Latin-script marker helpers shared by inbound language
// detection and outbound answer-language validation.
//
// JavaScript `\b` is ASCII-only, even with the `u` flag: markers beginning or
// ending in å/ä/ö/ü/é/á/ñ (är, några, hallå, qué) never matched at a word edge,
// while ASCII fragments next to such letters matched inside words. These helpers
// keep the existing marker lists and change only the boundary semantics.

const WORD = String.raw`[\p{L}\p{M}\p{N}_]`;
const UNICODE_BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const compiled = new Map<string, RegExp>();

function withUnicodeBoundaries(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      out += !inClass && next === 'b' ? UNICODE_BOUNDARY : ch + (next ?? '');
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    out += ch;
  }
  return out;
}

/** Same pattern, with `\b` replaced by a Unicode letter/mark/number boundary. */
export function unicodeWordPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('u') ? pattern.flags : `${pattern.flags}u`;
  const key = `${flags}/${pattern.source}`;
  let regex = compiled.get(key);
  if (!regex) {
    regex = new RegExp(withUnicodeBoundaries(pattern.source), flags);
    compiled.set(key, regex);
  }
  regex.lastIndex = 0;
  return regex;
}

const TOKEN = /[\p{L}\p{M}]+/gu;
function tokens(text: string): string[] {
  return String(text || '').normalize('NFC').toLowerCase().match(TOKEN) || [];
}

// Swedish words ending in -st that can stand next to "du" ("senast du bokade",
// "just du"). They must not be read as German second-person verb forms.
const SWEDISH_ST_WORDS = new Set([
  'först', 'bäst', 'mest', 'minst', 'sist', 'helst', 'senast', 'tidigast', 'högst',
  'längst', 'näst', 'störst', 'just', 'fast', 'kanske',
]);
// German second-person singular verbs end in -st/-ßt (kannst, hast, bist, weißt).
const isGermanSecondPersonVerb = (word?: string) =>
  Boolean(word && /^\p{L}{2,}(?:st|ßt)$/u.test(word) && !SWEDISH_ST_WORDS.has(word));
const GERMAN_DU_PRONOUNS = new Set(['dich', 'dir', 'dein', 'deine', 'deinem', 'deinen', 'deiner', 'deines']);
const SWEDISH_DU_NEIGHBOURS = new Set([
  'kan', 'vill', 'har', 'är', 'ska', 'behöver', 'får', 'måste', 'kommer', 'blir', 'tar',
  'om', 'när', 'att', 'hur', 'vad', 'var', 'dig', 'din', 'ditt', 'dina',
]);

export type DuAttribution = 'none' | 'sv' | 'de' | 'mixed';

/**
 * "du" is the second-person pronoun in both Swedish and German. Attribute each
 * occurrence from its immediate grammatical neighbours. Occurrences without a
 * deciding neighbour stay Swedish (the previous behaviour) unless the same text
 * has German second-person grammar, so Swedish-only text is scored as before.
 */
export function germanSwedishDuEvidence(text: string): { sv: number; de: number; attribution: DuAttribution } {
  const words = tokens(text);
  let sv = 0, de = 0, unframed = 0;
  words.forEach((word, i) => {
    if (word !== 'du') return;
    const before = words[i - 1], after = words[i + 1];
    // Swedish neighbours never occur in German, so they take precedence over a
    // Swedish -st noun that resembles a German verb ("är du gäst").
    if (SWEDISH_DU_NEIGHBOURS.has(before ?? '') || SWEDISH_DU_NEIGHBOURS.has(after ?? '')) sv++;
    else if (isGermanSecondPersonVerb(before) || isGermanSecondPersonVerb(after)) de++;
    else unframed++;
  });
  if (de || words.some(w => GERMAN_DU_PRONOUNS.has(w))) de += unframed; else sv += unframed;
  const attribution: DuAttribution = !sv && !de ? 'none' : sv && de ? 'mixed' : sv ? 'sv' : 'de';
  return { sv, de, attribution };
}

// Closed sets of high-frequency words exclusive to one of German/Swedish (and
// not English words such as "die", "was" or "till"). Used only to attribute a
// lexeme both languages share; never as standalone evidence.
const GERMAN_FUNCTION_WORDS = new Set([
  'und', 'ist', 'sind', 'nicht', 'auch', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'mit', 'bei', 'nach', 'für', 'auf', 'dem', 'das', 'der', 'des', 'wir', 'ihr', 'ihre',
  'ihren', 'ihrem', 'ihnen', 'sie', 'uns', 'zu', 'zum', 'zur', 'im', 'vom', 'oder', 'wenn',
  'wie', 'kann', 'dauert', 'kostet', 'minuten', 'stunden', 'uhr', 'bitte',
]);
const SWEDISH_FUNCTION_WORDS = new Set([
  'och', 'är', 'inte', 'också', 'en', 'ett', 'med', 'hos', 'efter', 'för', 'på', 'det', 'vi',
  'ni', 'oss', 'om', 'eller', 'när', 'hur', 'vad', 'kan', 'vill', 'har', 'ska', 'tar',
  'kostar', 'minuter', 'timmar', 'timme', 'kl', 'klockan', 'gärna', 'vänligen',
]);

export function germanSwedishFunctionWordBalance(text: string): { de: number; sv: number } {
  let de = 0, sv = 0;
  for (const word of tokens(text)) {
    if (GERMAN_FUNCTION_WORDS.has(word)) de++;
    if (SWEDISH_FUNCTION_WORDS.has(word)) sv++;
  }
  return { de, sv };
}

const SHARED_GERMAN_SWEDISH_LEXEMES = /\bkonsultation\b/i;
export function hasSharedGermanSwedishLexeme(text: string): boolean {
  return unicodeWordPattern(SHARED_GERMAN_SWEDISH_LEXEMES).test(String(text || ''));
}

/**
 * A shared lexeme stays Swedish evidence (the previous behaviour) unless German
 * grammar clearly dominates: exclusive function words plus attributed "du".
 */
export function resolveSharedGermanSwedishLexeme(text: string): 'de' | 'sv' {
  const words = germanSwedishFunctionWordBalance(text);
  const du = germanSwedishDuEvidence(text);
  return words.de + du.de > words.sv + du.sv ? 'de' : 'sv';
}

export type GrammaticalLatinScores = Record<'sv' | 'de' | 'es' | 'en', number>;

export function scoreGrammaticalLatinLanguage(text?: string): GrammaticalLatinScores {
  const lower = String(text || '').trim().toLowerCase();
  const scores: GrammaticalLatinScores = { sv: 0, de: 0, es: 0, en: 0 };
  if (!lower) return scores;
  const add = (language: keyof GrammaticalLatinScores, pattern: RegExp, weight: number) => {
    const matches = lower.match(unicodeWordPattern(pattern));
    if (matches) scores[language] += matches.length * weight;
  };

  // "den" is also a German article; it cannot independently prove Swedish.
  // "du" is shared with German and is attributed from its neighbours below.
  add('sv', /\b(vilka?|finns|jag|mig|det|för|någon|några)\b/gu, 2);
  const du = germanSwedishDuEvidence(lower);
  scores.sv += du.sv * 2;
  scores.de += du.de * 2;
  add('sv', /\bjag\s+(?:vill|behöver|ska)\b/gu, 2);
  add('sv', /\b(lediga?|tider?)\b/gu, 2);
  // Complete question frames provide language evidence when the provider is unavailable.
  add('sv', /^vilk(?:en|et|a)\s+[^.!?\n]{1,80}\s+(?:har|finns|är)\b/gu, 4);
  add('de', /\b(welche[rsn]?|ich|mich|gibt\s+es|am|für)\b/gu, 2);
  add('de', /\bich\s+(?:möchte|moechte)\b/gu, 2);
  add('de', /\b(freie[nrms]?|zeiten?|termine?)\b/gu, 2);
  add('de', /\b(können sie|könnten sie|unternehmen|dienstleistungen|informationen|erklären|erzählen|erstellt|kurze|videoanzeigen|bestätigung)\b/gu, 2);
  add('de', /^welch(?:e|er|es|en|em)\s+[^.!?\n]{1,80}\s+(?:hat|haben|ist|sind|gilt)\b/gu, 4);
  add('es', /\b(qué|cuáles?|hay|quiero|para|el|la)\b/gu, 2);
  add('es', /\b(?:quiero|quisiera|me\s+gustar[ií]a)\b/gu, 2);
  add('es', /\b(horas?|disponibles?|citas?)\b/gu, 2);
  // Avoid cross-language pronouns/prepositions as standalone evidence.
  // For example, "me" is common Spanish and must not make a Spanish sentence English.
  add('en', /\b(what|which|are\s+there)\b/gu, 2);
  // Standalone "i" is also a Swedish preposition. Require English grammar
  // around the first-person pronoun rather than counting Swedish occurrences.
  add('en', /\bi\s+(?:am|have|will|need|can|could|should|was)\b/gu, 2);
  // A complete first-person verb frame is grammatical evidence, like jag vill
  // or ich möchte. Standalone Swedish preposition "i" still contributes nothing.
  add('en', /\bi\s+(?:want|would\s+like)\b/gu, 4);
  add('en', /\b(available|times?|appointments?)\b/gu, 2);
  return scores;
}

export function detectGrammaticalLatinLanguage(text?: string): string | null {
  const ranked = Object.entries(scoreGrammaticalLatinLanguage(text)).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] >= 4 && ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}
