/** A conservative literal grammar, not a translator or an entailment substitute.
 * It can veto temporal inequalities; it never grants factual support. Unknown
 * quantified constraints fail closed. Ordinary unqualified durations still use
 * the existing citation, structured-authority and semantic verification gates.
 */
type Bound = 'minimum' | 'maximum';
type Side = 'before' | 'after' | 'none';
type Constraint = { seconds: number; bound: Bound | null; side: Side; ambiguous: boolean };
const canonical = (s: string) => s.normalize('NFKC').toLocaleLowerCase()
  .replace(/[۰-۹]/gu, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
  .replace(/[٠-٩]/gu, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
  .replace(/[\u064b-\u065f\u200c]/gu, ' ').replace(/\s+/gu, ' ').trim();
const rules: Array<[Bound | 'latest' | 'earliest', string[]]> = [
  ['minimum', ['at least', 'not less than', 'minimum', 'minst', 'minimi', 'inte mindre än', 'mindestens', 'nicht weniger als', 'al menos', 'como mínimo', 'mínimo', 'no menos de', 'حداقل', 'دست کم', 'على الأقل', 'لا يقل عن']],
  ['maximum', ['at most', 'not more than', 'maximum', 'högst', 'maximalt', 'inte mer än', 'höchstens', 'maximal', 'nicht mehr als', 'como máximo', 'máximo', 'a lo sumo', 'no más de', 'حداکثر', 'حد اکثر', 'على الأكثر', 'لا يزيد عن']],
  ['latest', ['no later than', 'senast', 'spätestens', 'a más tardar', 'نه دیرتر از', 'في موعد أقصاه']],
  ['earliest', ['no earlier than', 'tidigast', 'frühestens', 'no antes de', 'نه زودتر از', 'ليس قبل']],
];
const boundary = (phrase: string) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
const before = ['before', 'in advance', 'i förväg', 'im voraus', 'de antelación', 'före', 'innan', 'vor', 'vorher', 'antes', 'قبل', 'پیش از', 'پیش'];
const after = ['after', 'efter', 'nach', 'después', 'بعد', 'پس از'];
const hasPhrase = (s: string, list: string[]) => list.some(p => boundary(p).test(s));
const unitGroups: Array<[number, string[]]> = [
  [60, ['minute', 'minutes', 'minuter', 'minut', 'minuten', 'minuto', 'minutos', 'دقیقه', 'دقيقة', 'دقائق']],
  [3600, ['hour', 'hours', 'timme', 'timmar', 'stunde', 'stunden', 'hora', 'horas', 'ساعت', 'ساعة', 'ساعات']],
  [86400, ['day', 'days', 'dag', 'dagar', 'tag', 'tage', 'tagen', 'día', 'días', 'روز', 'يوم', 'يوما', 'أيام']],
];
const units: Record<string, number> = Object.fromEntries(unitGroups.flatMap(([factor, names]) => names.map(name => [name, factor])));

function parse(input: string): { constraints: Constraint[]; unsupported: boolean } {
  if (input.length > 20_000) return { constraints: [], unsupported: true };
  const text = canonical(input);
  const constraints: Constraint[] = [];
  const quantities = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])([0-9]+(?:[.,][0-9]+)?)\\s+(${Object.keys(units).join('|')})(?![\\p{L}\\p{N}])`, 'gu'))];
  for (const quantity of quantities) {
    const start = quantity.index!; const end = start + quantity[0].length;
    // One sentence/semicolon clause owns the quantifier. Do not import a bound
    // from another factual clause or from a later numerical quantity.
    const left = text.slice(0, start).split(/[.!?؟؛;\n]/u).at(-1)!;
    const right = text.slice(end).split(/[.!?؟؛;\n]/u)[0];
    const context = left + quantity[0] + right;
    const side: Side = hasPhrase(context, before) ? 'before' : hasPhrase(context, after) ? 'after' : 'none';
    let remaining = context; const bounds: Array<Bound | 'latest' | 'earliest'> = [];
    // Long negated phrases are consumed before looking for remaining negation.
    for (const [kind, phrases] of rules) for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
      remaining = remaining.replace(boundary(phrase), () => { bounds.push(kind); return ' '; });
    }
    const mapped = bounds.map(b => b === 'latest' ? side === 'before' ? 'minimum' : 'maximum'
      : b === 'earliest' ? side === 'before' ? 'maximum' : 'minimum' : b);
    // A literal advance-notice requirement denotes a minimum notice, unlike a
    // bare "91 hours before" statement. Other implicit quantities stay unknown.
    const noticeRequirement = side === 'before' &&
      /requires?|needs?|kräver|behöver|erfordert|benötigt|requiere|necesita|نیاز دارد|يتطلب/u.test(context) &&
      /notice|varsel|förvarning|vorlauf|ankündigung|aviso|اطلاع|إشعار/u.test(context);
    if (!mapped.length && noticeRequirement) mapped.push('minimum');
    const ambiguous = context.length > 500 || (hasPhrase(context, before) && hasPhrase(context, after)) ||
      bounds.some(b => (b === 'latest' || b === 'earliest') && side === 'none') ||
      new Set(mapped).size > 1 || /[<>≤≥]|\b(?:between|or|eller|oder|o|inte|nicht|not|no|never)\b|(?<![\p{L}])(?:یا|أو|ليس|ليست|نباید|هرگز)(?![\p{L}])|(?<![\p{L}])نمی|(?<![\p{L}])لا(?![\p{L}])/u.test(remaining) ||
      /[0-9]/u.test(left + right) || /exactly|precisely|exakt|genau|exactamente|دقیقا|بالضبط/u.test(context);
    constraints.push({ seconds: Number(quantity[1].replace(',', '.')) * units[quantity[2]], bound: mapped[0] || null, side, ambiguous });
  }
  // Recognized comparative wording with an unknown unit/quantity must not be
  // approved merely because a model copies the same number into a citation.
  const incompleteDeadline = /cancel|avbok|absag|stornier|لغو|إلغاء/iu.test(text) &&
    (hasPhrase(text, before) || hasPhrase(text, after)) &&
    (/(?<![\p{L}\p{N}-])[0-9]+(?![\p{L}\p{N}-])/u.test(text) || hasPhrase(text, Object.keys(units)));
  const marked = rules.some(([, phrases]) => hasPhrase(text, phrases)) || /[<>≤≥]/u.test(text) || incompleteDeadline;
  return { constraints, unsupported: marked && !quantities.length };
}

export function numericalConstraintSafe(candidateQuote: string, atomicClaim: string, evidence: Array<string | { quote: string; source: string }>, structuredBusinessConfig?: string): boolean {
  const cancellationClaim = /cancel|avbok|absag|stornier|لغو|إلغاء|الغاء/iu;
  const freeClaim = /\b(?:free|gratis|avgiftsfri\w*|kostenlos\w*|gratuit\w*)\b|رایگان|مجاني|المجاني/iu;
  let policy: any, services: any[] = [];
  if (structuredBusinessConfig) {
    try { const config = JSON.parse(structuredBusinessConfig); policy = config?.cancellation; services = Array.isArray(config?.services) ? config.services : []; } catch { return false; }
  }
  const typedPolicy = policy && ('freeCancellationDeadlineMinutes' in policy || policy.available === false);
  const checks = [parse(candidateQuote), parse(atomicClaim)];
  // A verified service name can itself contain "Cancellation". Its ordinary
  // duration remains a service attribute, not a cancellation-policy interval.
  const namedServiceDuration = services.some(service => typeof service.name === 'string' && service.name.length > 0 &&
    candidateQuote.includes(service.name) && atomicClaim.includes(service.name)) &&
    checks.every(check => check.constraints.length === 1 && check.constraints[0].bound === null && check.constraints[0].side === 'none') &&
    /lasts|duration|varar|längd|dauert|dauer|dura|duración|مدت|مدة/iu.test(candidateQuote + ' ' + atomicClaim);
  const policyClaim = !namedServiceDuration && cancellationClaim.test(candidateQuote + ' ' + atomicClaim);
  if (typedPolicy && policyClaim) {
    if (policy.available === false) return false;
    // A configured fee boundary cannot support a mandatory cancellation notice
    // or prohibition. Both the original quotation and extracted claim must
    // name the free-cancellation attribute; the model cannot drop that qualifier.
    if (checks.some(c => c.constraints.length > 0) &&
      (!freeClaim.test(candidateQuote) || !freeClaim.test(atomicClaim))) return false;
    if ((!policy.lateFeeEnabled || policy.freeCancellationDeadlineMinutes === 0) &&
      checks.some(c => c.constraints.length > 0)) return false;
    if (policy.hardCancellationCutoffMinutes === null) {
      const text = canonical(candidateQuote + ' ' + atomicClaim);
      const automaticScope = /automatic|automatis|automátic|خودکار|تلقائي/iu;
      const disabledAutomation = policy.automaticCancellationEnabled === false &&
        automaticScope.test(candidateQuote) && automaticScope.test(atomicClaim) &&
        !freeClaim.test(candidateQuote + ' ' + atomicClaim);
      // Mentioning "free" elsewhere cannot hide an affirmative prohibition.
      if (!disabledAutomation && /\b(?:prohibited|forbidden|cannot cancel|can't cancel|not allowed to cancel|no longer cancel|får inte avboka|nicht (?:mehr )?stornieren|no puedes cancelar|prohibid\w*)\b|لغو.{0,30}ممنوع|نمی\s?توان.{0,35}لغو|لا يمكن.{0,25}إلغاء|إلغاء.{0,30}(?:ممنوع|محظور)/iu.test(text)) return false;
      if (!freeClaim.test(candidateQuote) && !freeClaim.test(atomicClaim) &&
        /\b(?:must cancel|must be cancel(?:led|ed)|muss\w*.*stornier|måste.*avbok|debes? cancelar)\b|باید.*لغو|يجب.*إلغاء/iu.test(text)) return false;
    }
  }
  const sources = evidence.map(item => {
    const text = typeof item === 'string' ? item : item.quote;
    const parsed = parse(text);
    // Only a typed free-cancellation field can establish the free-fee boundary.
    // Editable document JSON is not allowed to acquire this structured meaning.
    if (typeof item !== 'string' && item.source === 'structured_business_config') {
      const deadline = text.match(/"freeCancellationDeadlineMinutes"\s*:\s*([0-9]+)(?=\s*[,}\n]|\s*$)/u);
      if (deadline) parsed.constraints.push({ seconds: Number(deadline[1]) * 60, bound: 'minimum', side: 'before', ambiguous: false });
    }
    return parsed;
  });
  if (policyClaim && evidence.some(item => typeof item !== 'string' && item.source === 'structured_business_config' &&
    /"freeCancellationDeadlineMinutes"\s*:/u.test(item.quote)) &&
    (!freeClaim.test(candidateQuote) || !freeClaim.test(atomicClaim))) return false;
  const authoritative = sources.flatMap(s => s.constraints).filter(c => c.bound !== null || c.side !== 'none');
  if (checks.some(c => c.unsupported)) return false;
  const relevant = authoritative.length > 0 || checks.some(c => c.constraints.some(q => q.bound !== null || q.side !== 'none')) ||
    (policyClaim && checks.some(c => c.constraints.length > 0));
  if (!relevant) return true;
  if (sources.some(s => s.unsupported) || !authoritative.length) return false;
  let configuredDeadline: number | null = null;
  if (typedPolicy && policyClaim) {
    const value = policy.freeCancellationDeadlineMinutes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    configuredDeadline = value * 60;
  }
  return checks.every(check => check.constraints.length === 1 && check.constraints.every(c => {
    if (c.ambiguous || !c.bound || !Number.isFinite(c.seconds) || c.seconds <= 0) return false;
    if (configuredDeadline !== null && (c.seconds !== configuredDeadline || c.bound !== 'minimum' || c.side !== 'before')) return false;
    const sameValue = authoritative.filter(a => a.seconds === c.seconds);
    return sameValue.length > 0 && sameValue.every(a => !a.ambiguous && a.bound === c.bound && a.side === c.side);
  }));
}

export const NUMERICAL_DIRECTION_GUIDANCE = `Preserve numerical constraint direction, not just values: minimum/at least is not maximum/at most; before is not after. A cancellation deadline no later than N hours before a visit means at least N hours of advance notice, not at most N. Preserve no earlier/no later distinctions relative to the event. In Persian use حداقل for minimum notice and حداکثر for maximum; Arabic على الأقل/على الأكثر, Swedish minst/högst, German mindestens/höchstens, Spanish al menos/como máximo, English at least/at most. Ambiguous or reversed inequality, temporal anchor or unit cannot be stated as a verified policy. Exact matching numbers are never sufficient support.`;
