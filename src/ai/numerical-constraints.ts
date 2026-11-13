import { isArrivalInformationQuestion } from './information-request-contract';
/** A conservative literal grammar, not a translator or an entailment substitute.
 * It can veto temporal inequalities; it never grants factual support. Unknown
 * quantified constraints fail closed. Ordinary unqualified durations still use
 * the existing citation, structured-authority and semantic verification gates.
 */
type Bound = 'minimum' | 'maximum' | 'strict_minimum' | 'strict_maximum';
type Side = 'before' | 'after' | 'none';
type Constraint = { seconds: number; bound: Bound | null; side: Side; ambiguous: boolean;
  cancellationKind?: 'free_window' | 'notice' };
type BoundMarkerDiagnostic = {
  boundTriggerCategory: 'persian_ta' | 'explicit_maximum' | 'explicit_minimum' |
    'strict_maximum' | 'strict_minimum' | 'earliest' | 'latest' | 'notice_requirement' | 'none';
  boundTriggerPosition: 'before_quantity' | 'after_quantity' | 'other' | 'unknown';
  purposeClauseGuardMatched: boolean;
  purposeClauseCategory?: 'time_opportunity' | 'finite_preparation' | 'both';
  boundDecisionBranch: 'explicit_bound' | 'temporal_bound' | 'implicit_notice' | 'unbounded';
};
// Only the bounded comparison projection exposes this candidate metadata.
export type NumericalAmbiguityReason = 'oversized_clause' | 'opposed_anchors' | 'unanchored_temporal_bound' |
  'conflicting_bounds' | 'comparison_symbol' | 'alternative' | 'negation' | 'extra_digit' | 'exactness';
const candidateAmbiguityReasons = new WeakMap<Constraint, readonly NumericalAmbiguityReason[]>();
const boundMarkers = new WeakMap<Constraint, BoundMarkerDiagnostic>();

const cancellationClaim = /cancel|avbok|absag|stornier|لغو|إلغاء|الغاء/iu;
const freeClaim = /\b(?:free|gratis|avgiftsfri\w*|kostenlos\w*|gratuit\w*)\b|رایگان|مجاني|المجاني/iu;
const canonical = (s: string) => s.normalize('NFKC').toLocaleLowerCase()
  .replace(/[۰-۹]/gu, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
  .replace(/[٠-٩]/gu, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
  .replace(/[\u064b-\u065f\u200c]/gu, ' ').replace(/\s+/gu, ' ').trim();
const rules: Array<[Bound | 'latest' | 'earliest', string[]]> = [
  ['minimum', ['at least', 'not less than', 'minimum', 'minst', 'minimi', 'inte mindre än', 'mindestens', 'nicht weniger als', 'al menos', 'como mínimo', 'mínimo', 'no menos de', 'حداقل', 'دست کم', 'على الأقل', 'لا يقل عن']],
  ['maximum', ['at most', 'up to', 'not more than', 'maximum', 'högst', 'upp till', 'maximalt', 'inte mer än', 'höchstens', 'bis zu', 'maximal', 'nicht mehr als', 'como máximo', 'hasta', 'máximo', 'a lo sumo', 'no más de', 'حداکثر', 'حد اکثر', 'تا', 'على الأكثر', 'حتى', 'تصل إلى', 'تصل الى', 'يصل إلى', 'يصل الى', 'بحد أقصى', 'بحد اقصى', 'كحد أقصى', 'كحد اقصى', 'لا يزيد عن']],
  ['latest', ['no later than', 'senast', 'spätestens', 'a más tardar', 'نه دیرتر از', 'في موعد أقصاه']],
  ['earliest', ['no earlier than', 'tidigast', 'frühestens', 'no antes de', 'نه زودتر از', 'ليس قبل']],
  // Consume inclusive negated phrases above before their strict substrings.
  // More than N excludes N; it must never equal "at least N".
  ['strict_minimum', ['more than', 'greater than', 'mer än', 'mehr als', 'más de', 'بیش از', 'أكثر من']],
  ['strict_maximum', ['less than', 'fewer than', 'mindre än', 'weniger als', 'menos de', 'کمتر از', 'أقل من']],
];
const boundary = (phrase: string) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
const before = ['before', 'in advance', 'i förväg', 'im voraus', 'de antelación', 'före', 'innan', 'vor', 'vorher', 'antes', 'قبل', 'پیش از', 'پیش'];
const after = ['after', 'efter', 'nach', 'después', 'بعد', 'پس از'];
const hasPhrase = (s: string, list: string[]) => list.some(p => boundary(p).test(s));
// Arabic "يصل/تصل إلى" is an upper limit ("up to N") only when it introduces the
// quantity, optionally approximated; otherwise it is the arrival verb "arrives at".
const quantityLed = new Set(['تصل إلى', 'تصل الى', 'يصل إلى', 'يصل الى']);
const rulePattern = (phrase: string) => quantityLed.has(phrase)
  ? new RegExp(`${boundary(phrase).source}(?=\\s*(?:(?:حوالي|حوالى|نحو|قرابة)\\s+)?[0-9])`, 'gu') : boundary(phrase);
const unitGroups: Array<[number, string[]]> = [
  [60, ['minute', 'minutes', 'minuter', 'minut', 'minuten', 'minuto', 'minutos', 'دقیقه', 'دقيقة', 'دقائق']],
  [3600, ['hour', 'hours', 'timme', 'timmar', 'stunde', 'stunden', 'hora', 'horas', 'ساعت', 'ساعة', 'ساعات']],
  [86400, ['day', 'days', 'dag', 'dagar', 'tag', 'tage', 'tagen', 'día', 'días', 'روز', 'يوم', 'يوما', 'أيام']],
];
const units: Record<string, number> = Object.fromEntries(unitGroups.flatMap(([factor, names]) => names.map(name => [name, factor])));

/** Typography around a standalone numeric temporal literal is not a changed
 * policy quantity. Remove only matched quote pairs immediately before a known
 * time unit, in the parser's copy. Claims/citations are never rewritten, and
 * all comparison, anchor, ambiguity and source checks still run unchanged. */
function quotedTemporalNumbers(text:string):string {
  const pairs:readonly (readonly [string,string])[]=[['"','"'],["'","'"],['“','”'],['‘','’'],['«','»'],['„','“']];
  for(const [open,close] of pairs){
    const literal=new RegExp(`(?<![\\p{L}\\p{N}_-])${open}([0-9]+(?:[.,][0-9]+)?)${close}(?=\\s+(?:${Object.keys(units).join('|')})(?![\\p{L}\\p{N}]))`,'gu');
    text=text.replace(literal,'$1');
  }
  return text;
}

/** A closed spatial grammar, not a general exemption for hasta/تا. Quantified,
 * conditional, fee/notice and ambiguous clauses keep the original strict path.
 * Only the parser's copy changes; citations and published text stay untouched. */
function spatialConnectives(text: string): string {
  // A walking-time description can use Persian "تا" for a destination.
  // Normalize only this narrow spatial pattern in the parser's copy.
  // Policy, deadline, conditional and fee clauses remain unchanged.
  const walkingDestination = /(?<![\p{L}\p{N}])تا(?=\s+(?:ورودی|پذیرش|خروجی)(?:\s+[\p{L}]+){0,3}\s+حدود\s+(?:[0-9]+|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)\s+دقیقه\s+پیاده\s+روی(?![\p{L}\p{N}]))/gu;
  text = text.replace(/[^.!?؟؛;\n]+/gu, clause => {
    if (cancellationClaim.test(clause) ||
        /باید|نباید|اگر|شرط|مهلت|هزینه|جریمه|حداقل|حداکثر|قبل|پیش|بعد|لغو|رایگان/u.test(clause)) return clause;
    return clause.replace(walkingDestination, 'به');
  });
  return text.replace(/[^.!?؟؛;\n]+/gu, clause => {
    if (clause.length > 500 || cancellationClaim.test(clause) || hasPhrase(clause, Object.keys(units)) ||
        /[<>≤≥%]|\b(?:not|never|must|require\w*|deadline|fees?|no|nunca|si|durante|por|antes|después|plazo|aviso|debe\w*|oblig\w*|requier\w*|pagar|pago|tarifa\w*|cargo\w*|gratis|semanas?|mes(?:es)?|años?|quincenas?|weeks?|months?|years?|fortnights?|fecha|hoy|mañana|ayer|lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b|(?:باید|نباید|نکن|شرط|اگر|برای|مدت|هزینه|جریمه|رایگان|مهلت|زمان|قبل|پیش|بعد|هفته|ماه|سال|امروز|فردا|دیروز)/u.test(clause)) return clause;
    // Digits are permitted only in an explicitly marked location identifier.
    // This does not validate the identifier: exact citation + entailment still do.
    const withoutLabels = clause.replace(/(?:\bmarcad[oa]|نشان|علامت|کد)\s+[\p{L}\p{N}_-]+(?:\s+[0-9]+)?/gu, ' ');
    if (/[0-9]/u.test(withoutLabels)) return clause;
    if (/\b(?:sigue|siga|sigan|seguir|camina|camine|caminar|ve|vaya|dirígete|diríjase|continúa|continúe)\b/u.test(clause))
      clause = clause.replace(/\bhasta(?=\s+(?:(?:el|la|los|las|un|una)\s+)?(?:recepción|entrada|salida|puerta|ascensor|escaleras?|piso|planta|mostrador|sala|oficina|pasillo)(?![\p{L}\p{N}]))/gu, 'hacia');
    if (/(?:وارد شوید|دنبال کنید|ادامه دهید|حرکت کنید|بروید|برو)(?![\p{L}\p{N}])/u.test(clause))
      clause = clause.replace(/(?<![\p{L}\p{N}])تا(?=\s+(?:پذیرش|ورودی|خروجی|آسانسور|پله|طبقه|اتاق|دفتر|راهرو)(?![\p{L}\p{N}]))/gu, 'به');
    return clause;
  });
}

/** In a descriptive numeric condition, negating an automatic event does not
 * negate the comparison. Consume only closed indicative verb/adverb forms in
 * the parser's copy; leave other negators, quantities and published text intact.
 * Notice/fee, modal and before/after statements retain the conservative path. */
function indicativeActionNegation(text:string,context:string):string {
  if (freeClaim.test(context) || /\b(?:must|shall|should|require\w*|notice|deadline|fee\w*|debe\w*|oblig\w*|aviso|plazo|tarifa\w*|måste|ska|kräver|varsel|avgift\w*|muss|darf|soll|vorlauf|gebühr\w*)\b|باید|نباید|مهلت|هزینه|جریمه|يجب|إشعار|رسوم/iu.test(context)) return text;
  const forms:readonly [RegExp,RegExp][] = [
    [/\bno\s+(?:se\s+)?cancel(?:a|an)\s+automáticamente\b/gu,/\bno\b/u],
    [/\bnot\s+automatically\s+cancel(?:led|ed)\b|\bdoes\s+not\s+(?:automatically\s+cancel|cancel\s+automatically)\b/gu,/\bnot\b/u],
    [/\bavbokas\s+(?:(?:besöket|tiden|bokningen|mötet)\s+)?inte\s+automatiskt\b/gu,/\binte\b/u],
    [/\bnicht\s+automatisch\s+(?:storniert|abgesagt)\b/gu,/\bnicht\b/u],
    [/(?<![\p{L}\p{N}])خودکار\s+لغو\s+نمی\s*شود(?![\p{L}\p{N}])/gu,/نمی/u],
    [/(?<![\p{L}\p{N}])لا\s+(?:يلغى|تلغى)\s+(?:(?:الموعد|الحجز)\s+)?تلقائيا(?![\p{L}\p{N}])/gu,/لا/u],
  ];
  for(const [form,negator] of forms)text=text.replace(form,match=>match.replace(negator,' '));
  return text;
}

function parse(input: string, diagnoseBound = false): { constraints: Constraint[]; unsupported: boolean } {
  if (input.length > 20_000) return { constraints: [], unsupported: true };
  // German source attribution ("according to the test terms") is not an
  // after-event anchor. Quantified temporal uses of nach remain untouched.
  const text = spatialConnectives(quotedTemporalNumbers(canonical(input))).replace(/\bnach\s+(?:(?:den|dem|diesen|unseren|fiktiven|vorliegenden|genannten)\s+){0,3}(?:testbedingungen|angaben|informationen|dokumenten|dokument)\b/gu, 'laut Quelle');
  const constraints: Constraint[] = [];
  const quantities = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])([0-9]+(?:[.,][0-9]+)?)\\s+(${Object.keys(units).join('|')})(?![\\p{L}\\p{N}])`, 'gu'))];
  for (const quantity of quantities) {
    const start = quantity.index!; const end = start + quantity[0].length;
    // One sentence/semicolon clause owns the quantifier. Do not import a bound
    // from another factual clause or from a later numerical quantity.
    const left = text.slice(0, start).split(/[.!?؟؛;\n]/u).at(-1)!;
    const right = text.slice(end).split(/[.!?؟؛;\n]/u)[0];
    const context = left + quantity[0] + right;
    // A visitor arriving N minutes earlier is relative to the appointment.
    // Keep this narrow: never reinterpret cancellation or policy deadlines.
    const persianEarlyArrival = !cancellationClaim.test(context) &&
      /^\s*زودتر\s+(?:برسید|برسم|برسد|برسند|بیایید|بیام|تشریف\s+بیاورید|حاضر\s+شوید)(?![\p{L}\p{N}])/u.test(right);
    // Narrow arrival-only equivalences. These identify temporal direction,
    // not source entailment, eligibility, modality or publication authority.
    const additionalArrivalBefore = !cancellationClaim.test(context) && (
      /^\s*early(?![\p{L}\p{N}])/u.test(right) &&
        /\b(?:arriv\w*|come|be there|show up|check in)\b/u.test(left) ||
      /^\s*con antelación(?![\p{L}\p{N}])/u.test(right) &&
        /(?:preséntese|preséntate|llegue|llegar|acuda)/u.test(left) ||
      /^\s*زودتر\s+در\s+محل\s+حضور\s+داشته\s+باشید/u.test(right) ||
      /(?:الوصول|الحضور)\s+مبكرا\s+بـ?\s*$/u.test(left)
    );
    const anchoredBefore = hasPhrase(context, before) || /^ زودتر از /u.test(right) ||
      persianEarlyArrival || additionalArrivalBefore;
    const anchoredAfter = hasPhrase(context, after) || /^ دیرتر از /u.test(right);
    const side: Side = anchoredBefore ? 'before' : anchoredAfter ? 'after' : 'none';
    // After the quantity, Persian "تا فرصت ..." introduces a purpose
    // ("so there is time to ..."), rather than a maximum on that quantity.
    let timeOpportunityMatched = false;
    let finitePreparationMatched = false;
    let boundSuffix = side === 'none' ? right : right.replace(boundary('تا فرصت'), () => {
      timeOpportunityMatched = true;
      return ' فرصت';
    });
    // An arrival verb followed by a finite preparation-purpose clause (enough
    // time, or (ability to) get ready, optionally calmly) does not set a bound. Consume only its
    // post-quantity connective; retain real bounds and the rest of the clause.
    if (side === 'before' && !anchoredAfter && !cancellationClaim.test(context) &&
        !/مهلت|هزینه|جریمه/u.test(context)) {
      boundSuffix = boundSuffix.replace(/(?<![\p{L}\p{N}])((?:حاضر\s+شو(?:ند|ید|د|یم|م)|برس(?:ند|ید|د|یم|م))(?:\s*[،,])?\s+)تا(?=\s+(?:(?:(?:زمان|فرصت)\s+کافی\s+برای\s+آماده\s+شدن|برای\s+آماده\s+شدن\s+(?:زمان|فرصت)\s+کافی)\s+داشته\s+باش(?:ند|ید|د|یم|م)|(?:بتوان(?:ند|ید|د|یم|م)\s+)?(?:با\s+آرامش\s+)?آماده\s+شو(?:ند|ید|د|یم|م))(?![\p{L}\p{N}]))/gu, (_, arrival: string) => {
        finitePreparationMatched = true;
        return arrival;
      });
    }
    let remaining = left + quantity[0] + boundSuffix;
    const bounds: Array<Bound | 'latest' | 'earliest'> = [];
    // Long negated phrases are consumed before looking for remaining negation.
    const quantityStart = left.length;
    const quantityEnd = quantityStart + quantity[0].length;
    let firstMarker: Pick<BoundMarkerDiagnostic, 'boundTriggerCategory' | 'boundTriggerPosition' | 'boundDecisionBranch'> | undefined;
    for (const [kind, phrases] of rules) for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
      remaining = remaining.replace(rulePattern(phrase), (match: string, offset: number) => {
        if (diagnoseBound && !firstMarker) {
          // The mapped bound uses the first rule match in scan order.
          const temporal = kind === 'earliest' || kind === 'latest';
          firstMarker = {
            boundTriggerCategory: phrase === 'تا' ? 'persian_ta' :
              kind === 'maximum' ? 'explicit_maximum' : kind === 'minimum' ? 'explicit_minimum' : kind,
            boundTriggerPosition: offset + match.length <= quantityStart ? 'before_quantity' :
              offset >= quantityEnd ? 'after_quantity' : 'other',
            boundDecisionBranch: temporal ? 'temporal_bound' : 'explicit_bound',
          };
        }
        bounds.push(kind);
        return ' ';
      });
    }
    const mapped = bounds.map(b => b === 'latest' ? side === 'before' ? 'minimum' : 'maximum'
      : b === 'earliest' ? side === 'before' ? 'maximum' : 'minimum' : b);
    // A literal advance-notice requirement denotes a minimum notice, unlike a
    // bare "91 hours before" statement. Other implicit quantities stay unknown.
    const noticeRequirement = side === 'before' &&
      /requires?|needs?|kräver|behöver|erfordert|benötigt|requiere|necesita|نیاز دارد|يتطلب/u.test(context) &&
      /notice|varsel|förvarning|vorlauf|ankündigung|aviso|اطلاع|إشعار/u.test(context);
    if (!mapped.length && noticeRequirement) mapped.push('minimum');
    const ambiguityText = side === 'none' && mapped.length === 1 ? indicativeActionNegation(remaining,context) : remaining;
    const ambiguityReasons: NumericalAmbiguityReason[] = [];
    if (context.length > 500) ambiguityReasons.push('oversized_clause');
    if (anchoredBefore && anchoredAfter) ambiguityReasons.push('opposed_anchors');
    if (bounds.some(b => (b === 'latest' || b === 'earliest') && side === 'none')) ambiguityReasons.push('unanchored_temporal_bound');
    if (new Set(mapped).size > 1) ambiguityReasons.push('conflicting_bounds');
    if (/[<>≤≥]/u.test(ambiguityText)) ambiguityReasons.push('comparison_symbol');
    if (/\b(?:between|or|eller|oder|o)\b|(?<![\p{L}])(?:یا|أو)(?![\p{L}])/u.test(ambiguityText)) ambiguityReasons.push('alternative');
    if (/\b(?:inte|nicht|not|no|never)\b|(?<![\p{L}])(?:ليس|ليست|نباید|هرگز)(?![\p{L}])|(?<![\p{L}])نمی|(?<![\p{L}])لا(?![\p{L}])/u.test(ambiguityText)) ambiguityReasons.push('negation');
    if (/[0-9]/u.test(left + right)) ambiguityReasons.push('extra_digit');
    if (/exactly|precisely|exakt|genau|exactamente|دقیقا|بالضبط/u.test(context)) ambiguityReasons.push('exactness');
    const ambiguous = ambiguityReasons.length > 0;
    const constraint: Constraint = { seconds: Number(quantity[1].replace(',', '.')) * units[quantity[2]], bound: mapped[0] || null, side, ambiguous,
      ...(cancellationClaim.test(context) ? { cancellationKind: freeClaim.test(context) ? 'free_window' as const : 'notice' as const } : {}) };
    constraints.push(constraint);
    if (diagnoseBound) {
      if (ambiguous) candidateAmbiguityReasons.set(constraint, ambiguityReasons);
      const purposeClauseCategory = finitePreparationMatched
        ? timeOpportunityMatched ? 'both' : 'finite_preparation'
        : timeOpportunityMatched ? 'time_opportunity' : undefined;
      boundMarkers.set(constraint, {
        ...(firstMarker ?? {
          boundTriggerCategory: noticeRequirement ? 'notice_requirement' : 'none',
          boundTriggerPosition: 'unknown',
          boundDecisionBranch: noticeRequirement ? 'implicit_notice' : 'unbounded',
        }),
        purposeClauseGuardMatched: timeOpportunityMatched || finitePreparationMatched,
        ...(purposeClauseCategory ? { purposeClauseCategory } : {}),
      });
    }
  }
  // Recognized comparative wording with an unknown unit/quantity must not be
  // approved merely because a model copies the same number into a citation.
  const incompleteDeadline = /cancel|avbok|absag|stornier|لغو|إلغاء/iu.test(text) &&
    (hasPhrase(text, before) || hasPhrase(text, after)) &&
    (/(?<![\p{L}\p{N}-])[0-9]+(?![\p{L}\p{N}-])/u.test(text) || hasPhrase(text, Object.keys(units)));
  const marked = rules.some(([, phrases]) => phrases.some(phrase => rulePattern(phrase).test(text))) || /[<>≤≥]/u.test(text) || incompleteDeadline;
  return { constraints, unsupported: marked && !quantities.length };
}

/** Literal identity for completeness checks, never authority to publish a fact. */
export function temporalConstraintSignature(text: string): string | null {
  const result = parse(text);
  const constraint = result.constraints[0];
  return !result.unsupported && result.constraints.length === 1 && !constraint.ambiguous &&
    constraint.bound !== null && constraint.side !== 'none'
    ? JSON.stringify([constraint.seconds, constraint.bound, constraint.side]) : null;
}

export function literalDurationSeconds(text: string): number | null {
  const { constraints, unsupported } = parse(text);
  const constraint = constraints[0];
  return !unsupported && constraints.length === 1 && !constraint.ambiguous && constraint.bound === null && constraint.side === 'none'
    ? constraint.seconds : null;
}

export type NumericalConstraintAssessment = Readonly<{safe:boolean;reason:string;checks:readonly ReturnType<typeof parse>[];sources:readonly ReturnType<typeof parse>[]}>;

export function assessNumericalConstraint(candidateQuote: string, atomicClaim: string, evidence: Array<string | { quote: string; source: string }>, structuredBusinessConfig?: string,
  citationScope: 'quotation' | 'whole_source' = 'quotation'): NumericalConstraintAssessment {
  let checks: ReturnType<typeof parse>[] = [], sources: ReturnType<typeof parse>[] = [];
  const result = (safe: boolean, reason: string): NumericalConstraintAssessment => ({safe,reason,checks,sources});
  let policy: any, services: any[] = [];
  if (structuredBusinessConfig) {
    try { const config = JSON.parse(structuredBusinessConfig); policy = config?.cancellation; services = Array.isArray(config?.services) ? config.services : []; } catch { return result(false,'CONFIGURATION_INVALID'); }
  }
  const typedPolicy = policy?.available === true;
  const structuredPolicyCitation = evidence.some(item => typeof item !== 'string' && item.source === 'structured_business_config' &&
    /"(?:freeCancellationDeadlineMinutes|lateFeeEnabled|automaticCancellationEnabled)"\s*:/u.test(item.quote));
  checks = [parse(candidateQuote, true), parse(atomicClaim, true)];
  // A verified service name can itself contain "Cancellation". Its ordinary
  // duration remains a service attribute, not a cancellation-policy interval.
  const namedServiceDuration = services.some(service => typeof service.name === 'string' && service.name.length > 0 &&
    candidateQuote.includes(service.name) && atomicClaim.includes(service.name)) &&
    checks.every(check => check.constraints.length === 1 && check.constraints[0].bound === null && check.constraints[0].side === 'none') &&
    /lasts|duration|varar|längd|dauert|dauer|dura|duración|مدت|مدة/iu.test(candidateQuote + ' ' + atomicClaim);
  const policyClaim = !namedServiceDuration && !isArrivalInformationQuestion(candidateQuote + ' ' + atomicClaim) && cancellationClaim.test(candidateQuote + ' ' + atomicClaim);
  if (typedPolicy && policyClaim && structuredPolicyCitation) {
    // A configured fee boundary cannot support a mandatory cancellation notice
    // or prohibition. Both the original quotation and extracted claim must
    // name the free-cancellation attribute; the model cannot drop that qualifier.
    if (checks.some(c => c.constraints.length > 0) &&
      (!freeClaim.test(candidateQuote) || !freeClaim.test(atomicClaim))) return result(false,'FREE_WINDOW_SCOPE_MISMATCH');
    if ((!policy.lateFeeEnabled || typeof policy.freeCancellationDeadlineMinutes !== 'number' || policy.freeCancellationDeadlineMinutes <= 0) &&
      checks.some(c => c.constraints.length > 0)) return result(false,'DISABLED_OR_INVALID_FREE_WINDOW');
    if (policy.hardCancellationCutoffMinutes === null || policy.hardCancellationCutoffMinutes === undefined) {
      const text = canonical(candidateQuote + ' ' + atomicClaim);
      const automaticScope = /automatic|automatis|automátic|خودکار|تلقائي/iu;
      const disabledAutomation = policy.automaticCancellationEnabled === false &&
        automaticScope.test(candidateQuote) && automaticScope.test(atomicClaim) &&
        !freeClaim.test(candidateQuote + ' ' + atomicClaim);
      // Mentioning "free" elsewhere cannot hide an affirmative prohibition.
      if (!disabledAutomation && /\b(?:prohibited|forbidden|cannot cancel|can't cancel|not allowed to cancel|no longer cancel|får inte avboka|nicht (?:mehr )?stornieren|no puedes cancelar|prohibid\w*)\b|لغو.{0,30}ممنوع|نمی\s?توان.{0,35}لغو|لا يمكن.{0,25}إلغاء|إلغاء.{0,30}(?:ممنوع|محظور)/iu.test(text)) return result(false,'UNSUPPORTED_CANCELLATION_RESTRICTION');
      if (!freeClaim.test(candidateQuote) && !freeClaim.test(atomicClaim) &&
        /\b(?:must cancel|must be cancel(?:led|ed)|muss\w*.*stornier|måste.*avbok|debes? cancelar)\b|باید.*لغو|يجب.*إلغاء/iu.test(text)) return result(false,'UNSUPPORTED_CANCELLATION_RESTRICTION');
    }
  }
  sources = evidence.map(item => {
    const text = typeof item === 'string' ? item : item.quote;
    const parsed = parse(text);
    // Only a typed free-cancellation field can establish the free-fee boundary.
    // Editable document JSON is not allowed to acquire this structured meaning.
    if (typeof item !== 'string' && item.source === 'structured_business_config') {
      const deadline = text.match(/"freeCancellationDeadlineMinutes"\s*:\s*([0-9]+)(?=\s*[,}\n]|\s*$)/u);
      if (deadline) parsed.constraints.push({ seconds: Number(deadline[1]) * 60, bound: 'minimum', side: 'before', ambiguous: false, cancellationKind: 'free_window' });
    }
    return parsed;
  });
  if (policyClaim && evidence.some(item => typeof item !== 'string' && item.source === 'structured_business_config' &&
    /"freeCancellationDeadlineMinutes"\s*:/u.test(item.quote)) &&
    (!freeClaim.test(candidateQuote) || !freeClaim.test(atomicClaim))) return result(false,'FREE_WINDOW_SCOPE_MISMATCH');
  const authoritative = sources.flatMap(s => s.constraints).filter(c => c.bound !== null || c.side !== 'none');
  if (checks.some(c => c.unsupported)) return result(false,'UNSUPPORTED_CLAIM_COMPARISON');
  // ID-only transport binds a complete source item, which can contain unrelated
  // temporal statements. It must not turn a gate/elevator fact into a deadline.
  // Still compare every asserted bound/anchor and any matching source quantity:
  // removing "up to" from the same 21-day limit must remain a rejection.
  const sourceRelevant = authoritative.length > 0 && (citationScope === 'quotation' ||
    checks.some(c => c.constraints.some(q => authoritative.some(a => a.seconds === q.seconds))));
  const relevant = sourceRelevant || checks.some(c => c.constraints.some(q => q.bound !== null || q.side !== 'none')) ||
    (policyClaim && checks.some(c => c.constraints.length > 0));
  if (!relevant) return result(true,'NO_RELEVANT_CONSTRAINT');
  if (sources.some(s => s.unsupported) || !authoritative.length) return result(false,'SOURCE_CONSTRAINT_UNAVAILABLE');
  let configuredDeadline: number | null = null;
  if (typedPolicy && policyClaim && freeClaim.test(candidateQuote + ' ' + atomicClaim) &&
      (typeof policy.freeCancellationDeadlineMinutes === 'number' || policy.lateFeeEnabled === false)) {
    const value = policy.freeCancellationDeadlineMinutes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return result(false,'CONFIGURED_DEADLINE_INVALID');
    configuredDeadline = value * 60;
  }
  let mismatchReason = 'CLAIM_QUANTITY_COUNT';
  const mismatch = (reason:string) => { mismatchReason=reason;return false; };
  const safe = checks.every(check => check.constraints.length === 1 && check.constraints.every(c => {
    if (c.ambiguous) return mismatch('CLAIM_AMBIGUOUS');
    if (!Number.isFinite(c.seconds) || c.seconds <= 0) return mismatch('CLAIM_VALUE_INVALID');
    // An ordinary relative time is not an inequality. Match its exact value
    // and temporal anchor against equally unbounded explicit source wording.
    if (!c.bound) return (!policyClaim && configuredDeadline === null &&
      authoritative.some(a => !a.ambiguous && a.bound === null && a.seconds === c.seconds && a.side === c.side) &&
      authoritative.filter(a => a.seconds === c.seconds).every(a => !a.ambiguous && a.bound === null && a.side === c.side)) || mismatch('UNBOUNDED_CLAIM_NOT_SUPPORTED');
    if (configuredDeadline !== null && (c.seconds !== configuredDeadline || c.bound !== 'minimum' || c.side !== 'before')) return mismatch('CONFIGURED_DEADLINE_MISMATCH');
    const sameValue = authoritative.filter(a => a.seconds === c.seconds);
    // Equal intervals cannot turn an optional free-fee window into mandatory
    // notice (or vice versa), even when the citation is documentary prose.
    // Keep the attribute clause-local so unrelated policy sentences do not
    // donate or erase the free qualifier.
    if (!sameValue.length) return mismatch('SOURCE_VALUE_MISSING');
    return sameValue.every(a => !a.ambiguous && a.bound === c.bound && a.side === c.side &&
      (!a.cancellationKind || a.cancellationKind === c.cancellationKind)) || mismatch('SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH');
  }));
  return result(safe,safe?'CONSTRAINT_MATCH':mismatchReason);
}

export function numericalConstraintSafe(candidateQuote:string,atomicClaim:string,evidence:Array<string|{quote:string;source:string}>,structuredBusinessConfig?:string,
  citationScope:'quotation'|'whole_source'='quotation'):boolean {
  return assessNumericalConstraint(candidateQuote,atomicClaim,evidence,structuredBusinessConfig,citationScope).safe;
}

/** Claim-to-citation quantity support. Every temporal quantity the candidate
 * asserts must appear (same duration, any wording/unit) in at least one of the
 * candidate's OWN cited quotes. Uses only this parser's existing multilingual
 * grammar; adds no patterns. Bounds/anchors are judged by the assessor itself. */
export function citedQuantitiesSupported(assessment: NumericalConstraintAssessment, citedQuotes: readonly string[]): boolean {
  const cited = new Set(assessment.sources.flatMap(source => source.constraints.map(c => c.seconds)));
  // Unit spellings the grammar does not know ("60 min", "1 h") still support the
  // same numeric value; digits are normalised exactly as the parser does.
  const literals = new Set(citedQuotes.flatMap(quote => [...canonical(quote).matchAll(/(?<![\p{N}.,])([0-9]+(?:[.,][0-9]+)?)(?![\p{N}])/gu)]
    .map(match => Number(match[1].replace(',', '.')))));
  return assessment.checks.every(check => check.constraints.every(c => cited.has(c.seconds) ||
    [60, 3600, 86400].some(factor => literals.has(c.seconds / factor))));
}

/** Fixed parser categories, deduplicated across the two candidate inputs. */
export function numericalAmbiguityReasons(assessment: NumericalConstraintAssessment): NumericalAmbiguityReason[] {
  if (assessment.reason !== 'CLAIM_AMBIGUOUS') return [];
  return [...new Set(assessment.checks.flatMap(check =>
    check.constraints.length === 1 ? candidateAmbiguityReasons.get(check.constraints[0]) ?? [] : []))];
}

/** Diagnostic projection only. Ordinals refer to assessor inputs; no quantities,
 * text or quotations leave this projection. Never used to decide acceptance. */
export function numericalComparisonShapes(assessment: NumericalConstraintAssessment) {
  type Shape = Partial<BoundMarkerDiagnostic> & { candidateIndex:number; sourceIndex:number;
    candidateBound:Bound|'unbounded'; sourceBound:Bound|'unbounded'; candidateSide:Side; sourceSide:Side;
    candidateAmbiguous:boolean; sourceAmbiguous:boolean;
    candidateCancellationKind:'none'|'notice'|'free_window'; sourceCancellationKind:'none'|'notice'|'free_window';
    boundCompatible:boolean; temporalAnchorCompatible:boolean; cancellationKindCompatible:boolean };
  const shapes: Shape[] = [];
  for (const [candidateIndex,check] of assessment.checks.slice(0,2).entries()) {
    if (check.constraints.length !== 1) continue;
    const candidate=check.constraints[0];
    for (const [sourceIndex,source] of assessment.sources.slice(0,4).entries()) {
      for (const constraint of source.constraints.filter(s => s.seconds===candidate.seconds && (s.bound!==null||s.side!=='none')).slice(0,2)) {
        if (shapes.length===8) return shapes;
        shapes.push({candidateIndex,sourceIndex,candidateBound:candidate.bound??'unbounded',sourceBound:constraint.bound??'unbounded',
          candidateSide:candidate.side,sourceSide:constraint.side,candidateAmbiguous:candidate.ambiguous,sourceAmbiguous:constraint.ambiguous,
          candidateCancellationKind:candidate.cancellationKind??'none',sourceCancellationKind:constraint.cancellationKind??'none',
          boundCompatible:candidate.bound===constraint.bound,temporalAnchorCompatible:candidate.side===constraint.side,
          cancellationKindCompatible:!constraint.cancellationKind||constraint.cancellationKind===candidate.cancellationKind,
          ...boundMarkers.get(candidate)});
      }
    }
  }
  return shapes;
}

export const NUMERICAL_DIRECTION_GUIDANCE = `Preserve numerical constraint direction, not just values: minimum/at least is not maximum/at most; before is not after. A cancellation deadline no later than N hours before a visit means at least N hours of advance notice, not at most N. Preserve no earlier/no later distinctions relative to the event. In Persian use حداقل for minimum notice and حداکثر for maximum; Arabic على الأقل/على الأكثر, Swedish minst/högst, German mindestens/höchstens, Spanish al menos/como máximo, English at least/at most. Ambiguous or reversed inequality, temporal anchor or unit cannot be stated as a verified policy. Exact matching numbers are never sufficient support.`;
