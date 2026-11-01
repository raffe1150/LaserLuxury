import { businessInformationTopics } from './business-information';
import { cancellationAspects, hasCancellationInformationTopic, type CancellationCoverage } from './cancellation-information';
import { temporalConstraintSignature, literalDurationSeconds } from './numerical-constraints';

/** Receipts from ordinary exact-citation + numerical + atomic entailment gates.
 * Coverage cannot create these receipts or change the published factual text. */
export type GroundedCancellationProposition = Readonly<{
  claim: string; candidateQuote: string;
  evidence: readonly { source: string; quote: string }[];
}>;
type Attribute = 'permission' | 'automation' | 'notice' | 'free_window' | 'fee' | `detail:${string}`;
type Fact = { attribute: Attribute; key: string; source: string };
type ServiceDuration = { name: string; durationMinutes: number };
const canonical = (text: string) => text.normalize('NFKC').toLowerCase()
  .replace(/[۰-۹]/gu, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
  .replace(/[٠-٩]/gu, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
  .replace(/[\u064b-\u065f]/gu, '').replace(/\u200c/gu, ' ').replace(/\s+/gu, ' ').trim();
const free = /free|gratis|avgiftsfri|kostenlos|gratuit|رایگان|مجاني/iu;
const fee = /\bfees?\b|charge|penalt|avgift|gebühr|cargo|tarifa|هزینه|رسوم|غرام/iu;
const mandatory = /\b(?:must|require\w*|need\w*|måste|ska|skall|muss|müssen|debe\w*)\b|erforder|باید|نیاز دارد|يجب|يتطلب/iu;
const notice = /advance|notice|deadline|how far|\bwhen\b|förväg|varsel|frist|voraus|antelación|aviso|plazo|مهلت|چند.*قبل|إشعار|اشعار|كم.*قبل/iu;
const permission = /\b(?:may|can|cannot|permitted|allowed|får|darf)\b|can't|prohibit|forbid|tillåt|dürf|erlaub|gestatt|permite|permitid|puede|مجاز|ممنوع|يسمح|يمكن|محظور/iu;
const negative = /cannot|can't|\bno\b|\bnot\b|prohibit|forbid|får inte|inte.*tillåt|nicht|no se permite|no puede|مجاز نیست|ممنوع|لا يسمح|لا يمكن|محظور/iu;
const automation = /automatic|automatisk|automatisch|automátic|خودکار|تلقائ|\bchat\b/iu;
const broadPolicy = /polic|pol[ií]tic|terms|conditions|rules|villkor|regler|richtlini|bedingungen|condicion|reglas|normas|سیاست|شرایط|مقررات|سياسة|شروط|قواعد|أحكام/iu;
const details: Array<[Attribute, RegExp]> = [
  ['detail:entrance', /entrance|entry|entré|ingång|eingang|entrada|ورودی|مدخل/iu],
  ['detail:address', /address|location|located|adress|standort|adresse|ubicaci|direcci|آدرس|عنوان|موقع/iu],
  ['detail:phone', /phone|telefon|teléfono|تلفن|هاتف/iu],
  ['detail:email', /e-?mail|correo|ایمیل|بريد/iu],
  ['detail:hours', /opening hours|öppettider|öffnungszeiten|horario|ساعات کاری|ساعات العمل/iu],
  ['detail:parking', /parking|parkering|parken|aparcamiento|پارکینگ|مواقف/iu],
  ['detail:parking_identifier', /^(?=[\s\S]*(?:parking|parkering|parken|aparcamiento|پارکینگ|مواقف))(?=[\s\S]*(?:identifier|marking|label|märkning|kennzeich|código|شناسه|معرف))/iu],
  ['detail:service_duration', /duration|how long|lasts|varar|längd|dauert|dauer|duración|مدت|طول.*کشد|مدة/iu],
  ['detail:refund', /refund|återbetal|erstatt|reembols|بازپرداخت|استرداد/iu],
  ['detail:exceptions', /exception|undantag|ausnahme|excepci|استثنا|استثناء/iu],
  ['detail:method', /how (?:do|can)|steps|contact.*cancel|hur.*avbok|wie.*stornier|cómo.*cancel|چگونه.*لغو|كيف.*إلغاء|\b(?:email|call|telephone)\b.*cancel|cancel.*\b(?:email|call|telephone)\b/iu],
];
const same = (a: Fact, b: Fact) => a.attribute === b.attribute && a.key === b.key && a.source === b.source;
const scalarNegation = /\b(?:not|no|cannot|inte|ingen|inga|nicht|kein\w*|sin)\b|can't|isn['’]t|aren['’]t|نیست|(?:^|\s)(?:لا|ليس|ليست)(?=\s)/u;
const locationQuestion = /\b(?:where|var|wo|dónde|address|adress|adresse|dirección)\b|کجا|آدرس|أين|اين|عنوان/iu;
const positiveLocation = (text: string) => {
  const value = canonical(text);
  return !scalarNegation.test(value) &&
    /\b(?:is|are)\s+(?:located\s+)?(?:at|on|in)\b|\blocated\s+(?:at|on|in)\b|ligger\s+(?:på|i)(?=\s)|befindet\s+sich\s+(?:in|an|auf)\b|ist\s+(?:in|an|auf)\b|está\s+en\b|در\s+.+\s+است|في\s+.+/u.test(value);
};

// A conditional/service-specific proposition is only discharged by its complete
// literal wording. Matching an interval alone must not erase its scope/qualifiers.
const qualified = /\b(?:if|unless|except|only|for|some|certain|specific|between|wenn|falls|nur|außer|für|om|endast|utom|för|solo|excepto|para)\b|اگر|مگر|فقط|إذا|اذا|فقط/iu;
// Typed value equality is sufficient only for a literal, generic business-wide
// proposition. Unknown entity names/qualifiers retain their entire wording as
// identity, so equal intervals cannot collapse two different services/scopes.
const genericWords = new Set(`appointment appointments booking bookings cancellation cancellations cancel cancelled canceled cancelling
  the a an is are be may can cannot not no must at least hours hour minutes minute days day before visit available free fee late
  en bokad bokade tid tider avbokning avbokningen avboka avbokas avbokningsavgift avbokningsavgiften avgiftsfri avgiftsfritt är får inte måste ska minst senast timmar timme minuter minut dagar dag före besöket möjlig
  eine die der das ein ist sind werden termin termine stornierung storniert stornieren stornierungsgebühr kostenlose kostenlos möglich dürfen darf können müssen muss mindestens stunden stunde minuten minute tage tag vor dem besuch beträgt
  se permite permitido las la el los cita citas cancelación cancelar cancelarse deben debe al menos horas hora minutos minuto días día antes de visita cargo por es gratuita gratuito está disponible
  لغو نوبت رزرو مجاز است نیست باید حداقل ساعت دقیقه روز پیش از قبل مراجعه هزینه رایگان امکان پذیر به اطلاع نیاز دارد شود
  يسمح بإلغاء إلغاء المواعيد الموعد الحجز لا يمكن يجب قبل ساعة ساعات دقيقة دقائق يوم أيام على الأقل رسوم الإلغاء هي المجاني مجاني متاح`.split(/\s+/u).filter(Boolean));
const genericScope = (text: string) => !qualified.test(text) &&
  (text.replace(/[0-9]+(?:[.,][0-9]+)?\s*[a-z]{3}(?![a-z])/gu, '').match(/[\p{L}\p{M}]+/gu) || [])
    .every(word => genericWords.has(word));
function proseFacts(text: string, source: string, services: ServiceDuration[] = []): Fact[] {
  const result: Fact[] = [];
  for (const sentence of text.split(/\n+|(?<=[.!?؟。])\s+/u).filter(Boolean)) {
    const start = result.length;
    const normalized = canonical(sentence);
    if (/[?؟]/u.test(sentence)) continue;
    const literal = `literal:${normalized}`;
    const add = (attribute: Attribute, value: string) => {
      const quantitiesInScope = ['permission', 'automation'].includes(attribute) ? /[0-9]/u.test(normalized)
        : attribute === 'fee' && /[0-9]/u.test(normalized.replace(/[0-9]+(?:[.,][0-9]+)?\s*[a-z]{3}(?![a-z])/gu, ''));
      result.push({ attribute, key: genericScope(normalized) && !quantitiesInScope ? value : literal, source });
    };
    for (const [attribute, pattern] of details) if (pattern.test(normalized)) {
      if (attribute === 'detail:service_duration') {
        const seconds = literalDurationSeconds(sentence);
        for (const service of services) if (seconds !== null && normalized.includes(canonical(service.name))) {
          result.push({ attribute, key: JSON.stringify([service.name, seconds]), source });
        }
      } else if (attribute === 'detail:parking_identifier') {
        const ids = sentence.match(/\b[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+\b/gu);
        result.push({ attribute, key: ids?.length === 1 && !scalarNegation.test(normalized) ? ids[0] : literal, source });
      } else result.push({ attribute, key: literal, source });
    }
    if (!hasCancellationInformationTopic(normalized)) continue;
    const interval = temporalConstraintSignature(sentence);
    const money = [...normalized.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*([a-z]{3})(?![a-z])/gu)]
      .map(m => `${Number(m[1].replace(',', '.'))}:${m[2].toUpperCase()}`);
    // Fee absence alone supplies no temporal boundary. A requested deadline
    // needs an actual grounded interval, even when cancellation itself is free.
    const negatedFree = free.test(normalized) && scalarNegation.test(normalized);
    const negatedAmount = money.length > 0 && scalarNegation.test(normalized);
    if (free.test(normalized) && interval && !negatedFree) add('free_window', interval);
    else if (free.test(normalized) && !/[0-9]/u.test(normalized) && !negatedFree) add('fee', 'disabled');
    if (fee.test(normalized) && money.length === 1 && !negatedAmount) add('fee', money[0]);
    else if (fee.test(normalized) && !money.length && !negatedFree && /\b(?:no|not|without|ingen|inga|inte|kein\w*|nicht|sin)\b|نیست|بدون|لا|دون/iu.test(normalized)) add('fee', 'disabled');
    if (!free.test(normalized) && mandatory.test(normalized) && interval) add('notice', interval);
    if (permission.test(normalized) && !interval && !fee.test(normalized)) add(automation.test(normalized) ? 'automation' : 'permission', negative.test(normalized) ? 'false' : 'true');
    if (result.length === start && normalized.length > 0) {
      result.push({ attribute: 'detail:policy', key: literal, source });
    }
  }
  return result;
}

function sourceProse(text: string): string {
  if (!text.includes('untrusted_document_text:')) return text;
  return text.split('\n').flatMap(line => {
    if (!line.startsWith('untrusted_document_text:')) return [];
    try { const value = JSON.parse(line.slice('untrusted_document_text:'.length)); return typeof value === 'string' ? [value] : []; }
    catch { return []; }
  }).join('\n');
}
function structuredFacts(policy: any, citation?: string, services: ServiceDuration[] = []): Fact[] {
  const result: Fact[] = [];
  const add = (attribute: Attribute, key: string, field: string) => {
    if (!citation || citation.includes(`"${field}"`)) result.push({ attribute, key, source: 'structured_business_config' });
  };
  if (policy?.available === true) {
    if (typeof policy.automaticCancellationEnabled === 'boolean') add('automation', String(policy.automaticCancellationEnabled), 'automaticCancellationEnabled');
    if (typeof policy.freeCancellationDeadlineMinutes === 'number') add('free_window', JSON.stringify([policy.freeCancellationDeadlineMinutes * 60, 'minimum', 'before']), 'freeCancellationDeadlineMinutes');
    if (policy.lateFeeEnabled === false) add('fee', 'disabled', 'lateFeeEnabled');
    else if (policy.lateFeeEnabled === true) add('fee', `${policy.lateFeeAmount}:${policy.lateFeeCurrency}`, 'lateFeeAmount');
  }
  for (const service of services) add('detail:service_duration', JSON.stringify([service.name, service.durationMinutes * 60]), 'durationMinutes');
  return result;
}

/** Conservative completeness proof over already verified propositions. Literal
 * grammars only restrict completeness; an unknown role/value remains unresolved.
 * Neither a coverage enum nor a quote shared by several facets grants support. */
export function bindCancellationCoverage(input: {
  question: string; reply: string; coverage: CancellationCoverage[];
  propositions: readonly GroundedCancellationProposition[];
  sources: Readonly<Record<string, string>>;
}): { coverage: CancellationCoverage[]; conflict: boolean } {
  const question = canonical(input.question);
  const clauses = question.split(/[?؟;]|\b(?:and|och|und|y|plus|samt|sowie)\b|\s+و\s+|\s+و(?=(?:ما|هل|كيف|كم|أين|اين|متى)\s)/u).map(c => c.trim()).filter(Boolean);
  let policy: any, services: ServiceDuration[] = [];
  try {
    const config = JSON.parse(input.sources.structured_business_config || '{}'); policy = config.cancellation;
    services = (Array.isArray(config.services) ? config.services : []).filter((s: any) => typeof s.name === 'string' && s.name.length > 0 &&
      canonical(input.question).includes(canonical(s.name)) && typeof s.durationMinutes === 'number' && s.durationMinutes > 0);
  } catch { /* No authority. */ }
  const current = [...structuredFacts(policy, undefined, services), ...['retrieved_knowledge', 'business_system_prompt'].flatMap(source =>
    proseFacts(sourceProse(input.sources[source] || ''), source, services).filter(f => f.attribute !== 'detail:service_duration'))];
  if (current.length > 128 || input.propositions.length > 64) return {
    coverage: cancellationAspects.map(aspect => ({ aspect, status: 'missing', quote: '' })), conflict: false,
  };
  const grounded: Array<{ fact: Fact; quote: string }> = [];
  for (const proposition of input.propositions) {
    if (!input.reply.includes(proposition.candidateQuote)) continue;
    for (const citation of proposition.evidence) {
      if (!input.sources[citation.source]?.includes(citation.quote) &&
        !sourceProse(input.sources[citation.source] || '').includes(citation.quote)) continue;
      const cited = citation.source === 'structured_business_config' ? structuredFacts(policy, citation.quote, services) : proseFacts(citation.quote, citation.source, services);
      const claimFacts = proseFacts(proposition.claim, citation.source, services), quoteFacts = proseFacts(proposition.candidateQuote, citation.source, services);
      for (const fact of cited) {
        if (fact.key.startsWith('literal:')) {
          // Matching a topic/whole quotation is not a property proof. A service
          // price with "Cancellation Fee" in its name is not a cancellation fee;
          // an entrance being closed does not answer where the entrance is.
          const pattern = details.find(([attribute]) => attribute === fact.attribute)?.[1];
          const requests = pattern ? clauses.filter(clause => pattern.test(clause)) : [];
          if (!['detail:entrance', 'detail:address'].includes(fact.attribute) || !requests.length ||
            !requests.every(clause => locationQuestion.test(clause)) ||
            ![citation.quote, proposition.claim, proposition.candidateQuote].every(positiveLocation)) continue;
        }
        if (current.some(f => same(f, fact)) && claimFacts.some(f => same(f, fact)) && quoteFacts.some(f => same(f, fact))) {
          grounded.push({ fact, quote: proposition.candidateQuote });
        }
      }
    }
  }
  const broad = broadPolicy.test(question);
  const required = new Map<string, Attribute[]>();
  if (broad || permission.test(question)) required.set('permission', [
    ...(broad || clauses.some(c => permission.test(c) && !automation.test(c)) ? ['permission' as const] : []),
    ...(automation.test(question) ? ['automation' as const] : []),
  ]);
  const freeRequested = free.test(question), feeRequested = fee.test(question.replace(free, ''));
  const windowRequested = freeRequested && (notice.test(question) || /window|tidsgräns|مهلة|فترة/iu.test(question));
  if (broad || notice.test(question) && (!freeRequested && !feeRequested || mandatory.test(question))) required.set('advance_notice', ['notice']);
  if (broad || feeRequested || freeRequested) required.set('fees_and_windows', broad || feeRequested && freeRequested
    ? ['free_window', 'fee'] : windowRequested ? ['free_window'] : ['fee']);
  let requestedDetails = details.filter(([attribute, pattern]) => clauses.some(clause => pattern.test(clause) &&
    (attribute !== 'detail:method' || !notice.test(clause)))).map(([attribute]) => attribute);
  // An unrecognized coordinated request is an unresolved obligation, never
  // evidence that the customer did not ask it. E.g. permission to bring a guest
  // cannot be discharged by a verified permission to cancel an appointment.
  if (clauses.some(clause => !/^(?:please|thanks|thank you|tack|bitte|danke|por favor|gracias|لطفا|ممنون|من فضلك|شكرا)[,.!،]*$/u.test(clause) &&
    !details.some(([attribute, pattern]) => attribute !== 'detail:method' && pattern.test(clause)) &&
    !(hasCancellationInformationTopic(clause) && (broadPolicy.test(clause) || permission.test(clause) || notice.test(clause) ||
      mandatory.test(clause) || fee.test(clause) || free.test(clause) || details.find(([a]) => a === 'detail:method')![1].test(clause))))) {
    requestedDetails.push('detail:unknown');
  }
  if (requestedDetails.includes('detail:parking_identifier')) requestedDetails = requestedDetails.filter(a => a !== 'detail:parking');
  if (broad && current.some(f => f.attribute === 'detail:policy')) requestedDetails.push('detail:policy');
  const otherTopics = businessInformationTopics(input.question).filter(t => !['policies', 'prices'].includes(t));
  if (requestedDetails.length || otherTopics.length) required.set('other_requested_details', requestedDetails.length ? requestedDetails : ['detail:unknown']);
  if (!required.size) required.set('other_requested_details', ['detail:unknown']);
  const conflict = ['permission', 'automation', 'notice', 'free_window', 'fee'].some(attribute =>
    new Set(current.filter(f => f.attribute === attribute && !f.key.startsWith('literal:')).map(f => f.key)).size > 1);
  const coverage = cancellationAspects.map(aspect => {
    const verdict = input.coverage.find(c => c.aspect === aspect)!;
    const attributes = required.get(aspect);
    if (!attributes) return verdict;
    const obligations = current.filter(f => attributes.includes(f.attribute));
    const ambiguousScopes = attributes.some(attribute =>
      new Set(obligations.filter(f => f.attribute === attribute && f.key.startsWith('literal:')).map(f => f.key)).size > 1);
    // Identical propositions can be independently supported by either current
    // source; a duplicate document statement does not require a second citation.
    const allExplicitAttributesPresent = aspect !== 'fees_and_windows' || !broad && freeRequested && feeRequested
      ? attributes.every(attribute => obligations.some(f => f.attribute === attribute)) : true;
    const bound = !ambiguousScopes && allExplicitAttributesPresent && obligations.length > 0 && obligations.every(f => grounded.some(g =>
      g.fact.attribute === f.attribute && g.fact.key === f.key && verdict.quote.includes(g.quote)));
    // Permission/notice need their own positive binding. For fee/window questions
    // all applicable evidenced fee AND window facts are required, not one of them.
    return verdict.status === 'covered' && bound && !conflict ? verdict : { aspect, status: 'missing' as const, quote: '' };
  });
  return { coverage, conflict };
}
