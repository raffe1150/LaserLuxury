/** Read-only topic recognition. It does not choose services or authorize bookings. */
export type BusinessInformationTopic = 'company' | 'services' | 'contact' | 'hours' | 'prices' | 'policies' | 'parking';

const businessAddressPattern = /(?<![\p{L}\p{M}\p{N}_])(?:location|located|standort\w*|kundeneingang\w*|adresse|adress|kundentré\w*|ubicaci[oó]n|ubicad\w*|direcci[oó]n|befind\w*)(?![\p{L}\p{M}\p{N}_])|\b(?:your|our|business|street|postal|mailing|physical)\s+address\b|\b(?:what(?:['’]s|\s+is)|where(?:['’]s|\s+is))\s+(?:the\s+|your\s+|our\s+)?address\b|\bcustomer\s+entrance\b|\bentrance\s+(?:for\s+)?customers?\b|\bvar\s+ligger\b|\bentrada\s+(?:de\s+|para\s+)?clientes?\b|آدرس|ورودی\s+مشتری(?:ان)?|کجا\s+هست|عنوان(?:كم|ك|نا)|مدخل\s+العملاء|(?:أين|اين)\s+(?:يقع\s+)?(?:مكان|موقع)/iu;

// Location can be expressed as a relationship to the business without an
// address/location noun. Use the same role for requests and verified claims;
// recognizing the role does not establish that the claim is supported.
const businessLocationRelationPattern = /\bvar\s+finns\s+ni\b|\b(?:ni|du)\s+(?:kan\s+)?hitta(?:r)?\s+oss\s+(?:på|i)(?![\p{L}\p{M}])|\b(?:you\s+(?:can\s+)?find\s+us\s+at|where\s+can\s+i\s+find\s+you)\b|\b(?:sie|du|ihr)\s+(?:finden|findest|findet)\s+uns\s+(?:in|an|auf)\b|\bnos\s+encuentra(?:s|n)?\s+en\b|(?<![\p{L}\p{M}])تجدوننا\s+في\s|(?<![\p{L}\p{M}])ما\s+را\s+در\s+[^.!?؟\n]{1,120}\s+پیدا\s+می[‌\s]?کنید/iu;

const topicPatterns: Record<BusinessInformationTopic, RegExp> = {
  company: /\b(?:company|business|unternehmen|firma|företag|verksamhet|empresa|negocio)\b|کسب.?و.?کار|شرکت|الشركة|المنشأة/iu,
  services: /\b(?:services?|offer(?:ings?)?|dienstleistungen?|leistungen?|angebot\w*|serviceportfolio|leistungskatalog|pakete?|tjänst\w*|utbud|servicios?|ofrecen|paquetes?)\b|خدمات|سرویس|الخدمات|خدمة/iu,
  contact: /(?<![\p{L}\p{M}\p{N}_])(?:contact\w*|reach|website|location|located|entrance\w*|entry|übersichtsseite|standort\w*|kundeneingang\w*|eingang\w*|zugang\w*|erreichen|kontakt\w*|address|adresse|adress|ingång\w*|entré\w*|kundentré\w*|ubicaci[oó]n|ubicad\w*|direcci[oó]n|entrada\w*|acceso\w*|befind\w*)(?![\p{L}\p{M}\p{N}_])|\bvar\s+ligger\b|تماس|آدرس|ورودی|محل|موقع|عنوان|اتصال|مدخل|المدخل|مكان|کجا\s+هست/iu,
  hours: /(?<![\p{L}\p{M}\p{N}_])(?:opening hours|hours|öffnungszeiten|öppettider|horarios?)(?![\p{L}\p{M}\p{N}_])|ساعات کاری|ساعات العمل/iu,
  prices: /\b(?:prices?|costs?|pricing|preisen?|preise?|kosten|pris\w*|kostar|precios?|cuesta)\b|قیمت|هزینه|السعر|أسعار/iu,
  policies: /\b(?:polic\w*|conditions|requirements|preparation|prepare|bring|payment|documents?|bedingungen|geschäftsbedingungen|vorbereit\w*|mitbringen|betalning|villkor|förbereda|ta med|condiciones|preparar|llevar|pago)\b|شرایط|آماده|پرداخت|شروط|تحضير|دفع/iu,
  parking: /(?<![\p{L}\p{M}\p{N}_])(?:park(?:ing|er[\p{L}\p{M}]*|en|pl[\p{L}\p{M}]*)?|aparca[\p{L}\p{M}]*)(?![\p{L}\p{M}\p{N}_])|پارکینگ|پارک\s+کن|موقف(?:ات)?|مواقف|ركن\s+سيار/iu,
};
export function businessInformationTopics(text: string): BusinessInformationTopic[] {
  return (Object.entries(topicPatterns) as [BusinessInformationTopic, RegExp][])
    .filter(([topic, pattern]) => pattern.test(text) || (topic === 'contact' && isBusinessAddressQuestion(text)))
    .map(([topic]) => topic);
}

export function isBusinessAddressQuestion(text: string): boolean {
  const raw = String(text || '');
  return businessAddressPattern.test(raw) || businessLocationRelationPattern.test(raw);
}

export function isBusinessRecommendationQuestion(text: string): boolean {
  return /\b(?:recommend(?:ation|ed|ing)?|suggest(?:ion|ed|ing)?|best\s+(?:service|option|choice)|first[- ]time|first\s+visit|new\s+customer|what\s+(?:service|option)\s+(?:should|would)\s+(?:i|you)|what\s+(?:should|would)\s+(?:i|you)\s+(?:choose|pick|book|try|get)|empfehl\w*|erstbesuch|zum\s+ersten\s+mal|rekommend\w*|första\s+gången|förstagångsbesök|recomiend\w*|recomend\w*|primera\s+vez)\b|پیشنهاد|توصیه|بار اول|لأول مرة|توصي|اقتراح/iu.test(String(text || ''));
}

export function isBusinessInformationQuestion(text: string): boolean {
  if (!businessInformationTopics(text).length && !isBusinessRecommendationQuestion(text)) return false;
  const informationFirst = /\b(?:before\s+i\s+book|bevor\s+ich|erstmal\s+informieren|innan\s+jag\s+bokar|antes\s+de\s+reservar)\b|قبل از رزرو|قبل الحجز/iu.test(text);
  // A real instruction, including a mixed question + booking request, must stay
  // with the deterministic engine. Mentioning "how booking works" is not one.
  const action = /\b(?:please\s+(?:book|cancel|reschedule)|(?:i\s+(?:want|would like)\s+to|can you)\s+(?:book|cancel|reschedule)|(?:bitte|ich möchte|ich will)\s+(?:(?:einen?|den|die|das)\s+)?(?:.{0,45}\s+)?(?:buchen|buche|stornieren|verschieben)|(?:boka|avboka|omboka)\s+(?:en|ett|min|den)|(?:quiero|por favor)\s+(?:reservar|cancelar|cambiar))\b|(?:رزرو|لغو)\s+کن|(?:احجز|أحجز|الغاء|إلغاء)\s/iu.test(text);
  if (action && !informationFirst) return false;
  return isBusinessRecommendationQuestion(text) || /[?؟]|\b(?:tell me|explain|information|describe|erzähl\w*|erfahr\w*|informier\w*|erklär\w*|wissen|berätta|beskriv|förklara|veta|informaci[oó]n|explica\w*)\b|اطلاعات|توضیح|معلومات|اشرح/iu.test(text);
}

export function formatRecommendationClarification(language: string): string {
  if (language === 'sv') return 'För att kunna rekommendera rätt tjänst, berätta vad du vill uppnå, vad du behöver tjänsten till och om du har några viktiga önskemål eller begränsningar, till exempel tid eller budget.';
  if (language === 'de') return 'Damit ich die passende Leistung empfehlen kann, sagen Sie mir bitte, was Sie erreichen möchten, wofür Sie die Leistung benötigen und ob es wichtige Wünsche oder Einschränkungen gibt, zum Beispiel Zeit oder Budget.';
  if (language === 'es') return 'Para recomendarte el servicio adecuado, dime qué quieres conseguir, para qué lo necesitas y si tienes alguna preferencia o limitación importante, como el tiempo o el presupuesto.';
  if (language === 'fa') return 'برای اینکه خدمت مناسب‌تری پیشنهاد بدهم، بگویید هدفتان چیست، این خدمت را برای چه نیازی می‌خواهید، و آیا ترجیح یا محدودیت مهمی مثل زمان یا بودجه دارید؟';
  if (language === 'ar') return 'لكي أوصي بالخدمة الأنسب، أخبرني ما الهدف الذي تريد تحقيقه، وما الذي تحتاج الخدمة من أجله، وهل لديك أي تفضيلات أو قيود مهمة مثل الوقت أو الميزانية؟';
  return 'To recommend the right service, tell me what you want to achieve, what you need it for, and any important preferences or constraints such as timing or budget.';
}

const topicLabels: Record<string, Record<BusinessInformationTopic, string>> = {
  en: { company: 'the company', services: 'services', contact: 'contact details and links', hours: 'opening hours', prices: 'prices', policies: 'terms and preparation', parking: 'parking' },
  de: { company: 'das Unternehmen', services: 'die Dienstleistungen', contact: 'Kontaktmöglichkeiten und Links', hours: 'die Öffnungszeiten', prices: 'die Preise', policies: 'Bedingungen und Vorbereitung', parking: 'Parkmöglichkeiten' },
  sv: { company: 'företaget', services: 'tjänsterna', contact: 'kontaktuppgifter och länkar', hours: 'öppettiderna', prices: 'priserna', policies: 'villkor och förberedelser', parking: 'parkering' },
  es: { company: 'la empresa', services: 'los servicios', contact: 'contactos y enlaces', hours: 'los horarios', prices: 'los precios', policies: 'condiciones y preparación', parking: 'aparcamiento' },
  fa: { company: 'شرکت', services: 'خدمات', contact: 'اطلاعات تماس و لینک‌ها', hours: 'ساعات کاری', prices: 'قیمت‌ها', policies: 'شرایط و آمادگی', parking: 'پارکینگ' },
  ar: { company: 'الشركة', services: 'الخدمات', contact: 'بيانات الاتصال والروابط', hours: 'ساعات العمل', prices: 'الأسعار', policies: 'الشروط والتحضير', parking: 'مواقف السيارات' },
};
export function businessInformationSubject(
  text: string,
  language: string,
  topics?: BusinessInformationTopic[],
): string {
  const labels = topicLabels[language] || topicLabels.en;
  return (topics || businessInformationTopics(text)).map(topic => {
    if (topics && topic === 'contact' && isBusinessAddressQuestion(text)) {
      const addressLabels: Record<string, string> = {
        en: 'the location/address', de: 'den Standort/die Adresse', sv: 'platsen/adressen',
        es: 'la ubicación/dirección', fa: 'مکان/آدرس', ar: 'الموقع/العنوان',
      };
      return addressLabels[language] || addressLabels.en;
    }
    return labels[topic];
  }).join(' / ');
}

/** A failed verifier says nothing about whether the business has the fact. */
export function formatBusinessSupportVerificationUnavailable(language: string, subject: string): string {
  if (language === 'sv') return `Jag kan inte verifiera ett svar om ${subject} just nu. Verksamheten kan bekräfta vad som gäller.`;
  if (language === 'de') return `Ich kann eine Antwort zu ${subject} derzeit nicht überprüfen. Das Unternehmen kann bestätigen, was gilt.`;
  if (language === 'es') return `No puedo verificar una respuesta sobre ${subject} en este momento. El negocio puede confirmar qué corresponde.`;
  if (language === 'ar') return `لا أستطيع التحقق من إجابة بشأن ${subject} الآن. يمكن للمنشأة تأكيد ما ينطبق.`;
  if (language === 'fa') return `در حال حاضر نمی‌توانم پاسخی درباره ${subject} تأیید کنم. خود مجموعه می‌تواند مورد دقیق را تأیید کند.`;
  return `I cannot verify an answer about ${subject} right now. The business can confirm what applies.`;
}

export function isServiceCatalogQuestion(text: string, allowAdditionalTopics = false): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const topics = businessInformationTopics(raw);
  if (!topics.includes("services")) return false;

  // If the customer is actually asking about prices, policies, contact details,
  // opening hours, or parking, a plain service catalog is not sufficient.
  if (!allowAdditionalTopics && topics.some((topic) =>
    ["prices", "policies", "contact", "hours", "parking"].includes(topic)
  )) {
    return false;
  }

  if (!isBusinessInformationQuestion(raw)) return false;

  // Recommendation requests require recommendation handling even when they
  // mention the service collection. They must never collapse into a
  // deterministic catalog-only response.
  if (isBusinessRecommendationQuestion(raw)) return false;

  // A catalog request asks about the service collection itself, not merely
  // whether one named service is offered.
  const mentionsServiceCollection =
    /\b(?:services?|offerings?|dienstleistungen?|leistungen?|serviceportfolio|leistungskatalog|tjänster|utbud|servicios?|paquetes?)\b|خدمات|سرویس(?:‌|\s)*(?:ها|هایی)|الخدمات/iu.test(raw);

  if (!mentionsServiceCollection) return false;

  // In a compound request, a singular named service is not a catalog request.
  if (allowAdditionalTopics && !/\b(?:services|offerings|dienstleistungen|leistungen|serviceportfolio|leistungskatalog|tjänster|utbud|servicios|paquetes)\b|خدمات|الخدمات/iu.test(raw)) return false;

  // Catalog questions ask what services exist. Explanation, comparison and
  // recommendation requests require richer grounding and must not collapse
  // into a deterministic list of service names.
  const asksForExplanation =
    /\b(?:describe|explain|tell\s+me\s+about|difference|compare|recommend|suitable|best\s+for|erzähl\w*|etwas\s+über|erklär\w*|beschreib\w*|unterschied|vergleich\w*|empfehl\w*|beskriv\w*|förklara|skillnad\w*|jämför\w*|rekommender\w*|explica\w*|describ\w*|diferencia|compar\w*|recomendar\w*)\b|(?:توضیح|شرح|فرق|تفاوت|مقایسه|پیشنهاد|مناسب(?:‌|\s)?تر)|(?:شرح|اشرح|الفرق|مقارنة|قارن|تنصح|أنسب)/iu.test(raw);

  if (asksForExplanation) return false;

  const asksForBroaderBusinessOverview =
    topics.includes("company") &&
    topics.includes("services");

  if (asksForBroaderBusinessOverview) return false;

  return true;
}

/** Conservative whole-question coverage for the catalog + address fast path.
 * Additional/unrecognized clauses stay on the full grounding path. */
export function isSimpleCatalogLocationQuestion(text: string): boolean {
  if (!isServiceCatalogQuestion(text, true) || !isBusinessAddressQuestion(text)) return false;
  const question = text.normalize('NFKC').replace(/[\u064b-\u065f]/gu, '').trim()
    .replace(/^[¡¿]*(?:hello|hi|hej|hallo|hola|مرحبا|سلام)(?=[\s!,،.])[\s!,،.]+/iu, '')
    .replace(/^[¿¡]+|[?!؟.]+$/gu, '').trim();
  return [
    /^(?:what|which) services do you (?:offer|provide) and (?:where are you located|where can I find you|what is your address)$/iu,
    /^vilka tjänster erbjuder ni och (?:var finns ni|var ligger ni|vad är er adress)$/iu,
    /^welche dienstleistungen bieten sie an und (?:wo befinden sie sich|wo sind sie|wie lautet ihre adresse)$/iu,
    /^qué servicios ofrecen y (?:dónde están ubicados|dónde se encuentran|cuál es su dirección)$/iu,
    /^ما الخدمات التي تقدمونها وأين (?:موقعكم|يقع مكانكم)$/u,
    /^چه خدماتی دارید و (?:کجا هستین|کجا هستید|آدرستون کجاست)$/u,
  ].some(pattern => pattern.test(question));
}

/** Whole-question recognition only: no goal, named service, comparison, extra
 * fact or booking instruction. Unknown wording retains normal grounding. */
export function isGenericRecommendationClarificationQuestion(text: string): boolean {
  if (!isBusinessRecommendationQuestion(text)) return false;

  const question = text.normalize('NFKC')
    .replace(/[\u064b-\u065f]/gu, '')
    .trim()
    .replace(/^[¡¿]*(?:hello|hi|hej|hallo|hola|مرحبا|سلام)(?=[\s!,،.])[\s!,،.]+/iu, '')
    .replace(/^[¿¡]+|[?!؟.]+$/gu, '')
    .trim();

  // Never use the deterministic shortcut for compound factual requests.
  if (businessInformationTopics(question).some(topic =>
    ['company', 'prices', 'contact', 'hours', 'policies', 'parking'].includes(topic)
  )) return false;

  // Never consume an actual booking instruction here.
  if (
    /\b(?:please\s+(?:book|reserve)|i\s+(?:want|would like)\s+to\s+(?:book|reserve)|boka|buche?n|reservar|reserva)\b|(?:رزرو\s+کن|احجز|أحجز)/iu
      .test(question)
  ) return false;

  // Existing conservative first-visit / catalog recommendation forms.
  const existingGeneric = [
    /^(?:what (?:would|do) you recommend|which service (?:would|do) you recommend(?: for me)?)(?: for (?:a first[- ]time visitor|someone visiting for the first time))?$/iu,
    /^what services do you offer and what (?:would|do) you recommend(?: for a first[- ]time visitor)?$/iu,
    /^(?:can you )?tell me (?:a little )?about your services and what you (?:would )?recommend for someone visiting for the first time$/iu,
    /^vad rekommenderar ni(?: för (?:mig|någon som kommer första gången))?$/iu,
    /^vilka tjänster (?:har|erbjuder) ni och vad rekommenderar ni(?: för första gången)?$/iu,
    /^(?:kan ni )?berätta lite om era tjänster och vad ni rekommenderar för någon som kommer första gången$/iu,
    /^welche (?:leistung|dienstleistung) (?:empfehlen sie|würden sie (?:mir )?empfehlen)(?: beim ersten besuch)?$/iu,
    /^welche dienstleistungen bieten sie an und was empfehlen sie(?: beim ersten besuch)?$/iu,
    /^können sie mir etwas über ihre dienstleistungen erzählen und was sie für einen ersten besuch empfehlen$/iu,
    /^qué servicio recomendarían(?: para (?:mí|alguien que viene por primera vez))?$/iu,
    /^qué servicios ofrecen y qué (?:recomiendan|recomendarían)(?: para alguien que viene por primera vez)?$/iu,
    /^pueden contarme un poco sobre sus servicios y qué recomendarían para alguien que viene por primera vez$/iu,
    /^(?:برای بار اول )?چه خدماتی پیشنهاد می[‌\s]?کنید$/u,
    /^چه خدماتی دارید و برای بار اول چه پیشنهادی دارید$/u,
    /^می[‌\s]?توانید کمی درباره خدماتتان بگویید و برای کسی که بار اول می[‌\s]?آید چه پیشنهادی دارید$/u,
    /^ما الخدمة التي توصي بها(?: لزيارة أولى)?$/u,
    /^ما الخدمات التي تقدمونها وماذا توصي به(?: لزيارة أولى)?$/u,
    /^هل يمكنك إخباري قليلا عن خدماتكم وما الذي توصي به لشخص يزوركم لأول مرة$/u,
  ].some(pattern => pattern.test(question));

  if (existingGeneric) return true;

  // Structural clarification pattern:
  // A) customer says they do not know which service fits them
  // B) customer asks what information is needed before a recommendation
  const uncertainServiceFit = [
    /\b(?:i(?:'m| am)? not sure|i do not know|i don't know|unsure).{0,80}\b(?:which|what).{0,30}\b(?:service|option).{0,40}\b(?:suit(?:s|ed|able)?|fit(?:s)?|right|appropriate|best)(?:\s+me)?(?=\s*[.!?]|$)/iu,
    /\b(?:jag vet inte|jag är osäker).{0,80}\b(?:vilken|vilka).{0,30}\b(?:tjänst|tjänster|alternativ).{0,40}\b(?:passar|lämplig)(?:\s+(?:mig|för mig))?(?=\s*[.!?]|$)/iu,
    /\b(?:ich weiß nicht|ich weiss nicht|ich bin unsicher).{0,80}\b(?:welche|welcher).{0,30}\b(?:dienstleistung|leistung|option).{0,40}\b(?:passt|geeignet)(?=\s*[.!?]|$)/iu,
    /\b(?:no sé|no se|no estoy seguro|no estoy segura).{0,80}\b(?:qué|que|cuál|cual).{0,30}\b(?:servicio|opción|opcion).{0,40}\b(?:conviene|adecuad[oa]?|encaja)(?:\s+(?:para mí|para mi))?(?=\s*[.!?]|$)/iu,
    /(?:نمی[‌\s]?دانم|مطمئن نیستم).{0,80}(?:کدام|چه).{0,30}(?:خدمت|سرویس|گزینه).{0,40}(?:مناسب|بهتر)(?:\s+(?:است|هست))?(?=\s*[.!؟?]|$)/u,
    /(?:لا أعرف|لست متأكدا|لست متأكدة).{0,80}(?:أي|ما).{0,30}(?:خدمة|خدمات|خيار).{0,40}(?:تناسب(?:ني)?|مناسب(?:ة)?)(?=\s*[.!؟?]|$)/u,
  ].some(pattern => pattern.test(question));

  const asksWhatIsNeeded = [
    /\bwhat.{0,40}(?:do you need to know|information do you need).{0,60}(?:before|to).{0,30}(?:recommend|suggest)/iu,
    /\bvad.{0,40}(?:behöver ni veta|behöver du veta|behöver ni för information).{0,60}(?:innan|för att).{0,30}rekommend/iu,
    /\bwas.{0,40}(?:müssen sie wissen|muessen sie wissen|brauchen sie).{0,60}(?:bevor|um).{0,30}empfehl/iu,
    /\bqué.{0,40}(?:necesitan saber|información necesitan|informacion necesitan).{0,60}(?:antes de|para).{0,30}recomend/iu,
    /(?:چه|چقدر).{0,40}(?:اطلاعات|چیزی).{0,40}(?:نیاز دارید|لازم دارید).{0,60}(?:پیش از|قبل از|برای).{0,30}پیشنهاد/u,
    /(?:پیش از|قبل از).{0,20}پیشنهاد.{0,40}(?:چه|چقدر).{0,30}(?:اطلاعات|چیزی).{0,30}(?:نیاز دارید|لازم دارید)/u,
    /(?:ما|ماذا).{0,40}(?:تحتاجون إلى معرفته|تحتاج أن تعرف|المعلومات التي تحتاج).{0,60}(?:قبل|لأجل|من أجل).{0,30}(?:التوصية|توصي)/u,
  ].some(pattern => pattern.test(question));

  return uncertainServiceFit && asksWhatIsNeeded;
}

export function isRecommendationInformationRequest(text: string): boolean {
  if (!isBusinessRecommendationQuestion(text)) return false;

  const question = text.normalize('NFKC')
    .replace(/[\u064b-\u065f]/gu, '')
    .trim()
    .replace(/^[¡¿]*(?:hello|hi|hej|hallo|hola|مرحبا|سلام)(?=[\s!,،.])[\s!,،.]+/iu, '')
    .replace(/^[¿¡]+|[?!؟.]+$/gu, '')
    .trim();

  if (businessInformationTopics(question).some(topic =>
    ['company', 'prices', 'contact', 'hours', 'policies', 'parking'].includes(topic)
  )) return false;

  if (
    /\b(?:please\s+(?:book|reserve)|i\s+(?:want|would like)\s+to\s+(?:book|reserve)|boka|buche?n|reservar|reserva)\b|(?:رزرو\s+کن|احجز|أحجز)/iu
      .test(question)
  ) return false;

  const uncertainServiceFit = [
    /\b(?:i(?:'m| am)? not sure|i do not know|i don't know|unsure).{0,80}\b(?:which|what).{0,30}\b(?:service|option).{0,40}\b(?:suit(?:s|ed|able)?|fit(?:s)?|right|appropriate|best)(?:\s+me)?(?=\s*[.!?]|$)/iu,
    /\b(?:jag vet inte|jag är osäker).{0,80}\b(?:vilken|vilka).{0,30}\b(?:tjänst|tjänster|alternativ).{0,40}\b(?:passar|lämplig)(?:\s+(?:mig|för mig))?(?=\s*[.!?]|$)/iu,
    /\b(?:ich weiß nicht|ich weiss nicht|ich bin unsicher).{0,80}\b(?:welche|welcher).{0,30}\b(?:dienstleistung|leistung|option).{0,40}\b(?:passt|geeignet)(?=\s*[.!?]|$)/iu,
    /\b(?:no sé|no se|no estoy seguro|no estoy segura).{0,80}\b(?:qué|que|cuál|cual).{0,30}\b(?:servicio|opción|opcion).{0,40}\b(?:conviene|adecuad[oa]?|encaja)(?:\s+(?:para mí|para mi))?(?=\s*[.!?]|$)/iu,
    /(?:نمی[‌\s]?دانم|مطمئن نیستم).{0,80}(?:کدام|چه).{0,30}(?:خدمت|سرویس|گزینه).{0,40}(?:مناسب|بهتر)(?:\s+(?:است|هست))?(?=\s*[.!؟?]|$)/u,
    /(?:لا أعرف|لست متأكدا|لست متأكدة).{0,80}(?:أي|ما).{0,30}(?:خدمة|خدمات|خيار).{0,40}(?:تناسب(?:ني)?|مناسب(?:ة)?)(?=\s*[.!؟?]|$)/u,
  ].some(pattern => pattern.test(question));

  const asksWhatIsNeeded = [
    /\bwhat.{0,40}(?:do you need to know|information do you need).{0,60}(?:before|to).{0,30}(?:recommend|suggest)/iu,
    /\bvad.{0,40}(?:behöver ni veta|behöver du veta|behöver ni för information).{0,60}(?:innan|för att).{0,30}rekommend/iu,
    /\bwas.{0,40}(?:müssen sie wissen|muessen sie wissen|brauchen sie).{0,60}(?:bevor|um).{0,30}empfehl/iu,
    /\bqué.{0,40}(?:necesitan saber|información necesitan|informacion necesitan).{0,60}(?:antes de|para).{0,30}recomend/iu,
    /(?:چه|چقدر).{0,40}(?:اطلاعات|چیزی).{0,40}(?:نیاز دارید|لازم دارید).{0,60}(?:پیش از|قبل از|برای).{0,30}پیشنهاد/u,
    /(?:پیش از|قبل از).{0,20}پیشنهاد.{0,40}(?:چه|چقدر).{0,30}(?:اطلاعات|چیزی).{0,30}(?:نیاز دارید|لازم دارید)/u,
    /(?:ما|ماذا).{0,40}(?:تحتاجون إلى معرفته|تحتاج أن تعرف|المعلومات التي تحتاج).{0,60}(?:قبل|لأجل|من أجل).{0,30}(?:التوصية|توصي)/u,
  ].some(pattern => pattern.test(question));

  return uncertainServiceFit && asksWhatIsNeeded;
}

export type ConfiguredServiceCatalogItem = {
  name: string;
  durationMinutes: number | null;
  price: number | null;
  currency: string | null;
};

export type ConfiguredServiceCatalogPlan = {
  totalServiceCount: number;
  displayedServices: ConfiguredServiceCatalogItem[];
  hasMoreServices: boolean;
};

export function buildConfiguredServiceCatalogPlan(
  services: any[],
  limit: number = 5,
): ConfiguredServiceCatalogPlan {
  const eligible = (Array.isArray(services) ? services : [])
    .filter((service) => service && service.active !== false && service.bookable !== false)
    .map((service) => {
      const name = String(
        service?.name || service?.service || service?.title || "",
      ).trim();

      const durationRaw =
        service?.durationMinutes ??
        service?.duration_minutes ??
        service?.duration;

      const durationMissing =
        durationRaw === null ||
        durationRaw === undefined ||
        String(durationRaw).trim() === "";

      const priceRaw = service?.price;
      const priceMissing =
        priceRaw === null ||
        priceRaw === undefined ||
        String(priceRaw).trim() === "";

      const durationNumber = durationMissing ? NaN : Number(durationRaw);
      const priceNumber = priceMissing ? NaN : Number(priceRaw);
      const currency = String(service?.currency || "").trim();

      return {
        name,
        durationMinutes:
          Number.isFinite(durationNumber) && durationNumber > 0
            ? durationNumber
            : null,
        price:
          Number.isFinite(priceNumber) && priceNumber >= 0
            ? priceNumber
            : null,
        currency: currency || null,
      };
    })
    .filter((service) => service.name);

  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? limit : 5;

  return {
    totalServiceCount: eligible.length,
    displayedServices: eligible.slice(0, safeLimit),
    hasMoreServices: eligible.length > safeLimit,
  };
}

const serviceMinuteLabels: Record<string, string> = {
  en: "minutes", sv: "minuter", de: "Minuten", es: "minutos", fa: "دقیقه", ar: "دقيقة",
};
const isRtlCatalogLanguage = (language: string) => language === 'ar' || language === 'fa';

function formatConfiguredServiceRow(service: ConfiguredServiceCatalogItem, language: string): string {
  const duration = service.durationMinutes !== null
    ? `${service.durationMinutes} ${isRtlCatalogLanguage(language) ? 'min' : serviceMinuteLabels[language]}` : "";
  const price = service.price !== null
    ? service.currency ? `${service.price} ${service.currency}` : String(service.price) : "";
  if (isRtlCatalogLanguage(language)) {
    // Isolate the complete mixed-script service payload so Meta/plain-text
    // clients cannot reorder the service name, separator, and metadata.
    // Keep numeric/currency metadata explicitly LTR inside that row isolate.
    // Values and currency still come only from the configured service record.
    const details = [duration, price].filter(Boolean).join(', ');
    return details
      ? `• \u2068${service.name} — \u2066${details}\u2069\u2069`
      : `• \u2068${service.name}\u2069`;
  }
  const details = [duration, price].filter(Boolean);
  return details.length
    ? `• ${service.name} — ${details.join(", ")}`
    : `• ${service.name}`;
}

export function formatConfiguredServiceCatalogPlan(
  plan: ConfiguredServiceCatalogPlan,
  language: string,
): string {
  const lang = ["en", "sv", "de", "es", "fa", "ar"].includes(language)
    ? language
    : "en";

  const intro: Record<string, string> = {
    en: "Our bookable services are:",
    sv: "Våra bokningsbara tjänster är:",
    de: "Unsere buchbaren Dienstleistungen sind:",
    es: "Nuestros servicios disponibles para reservar son:",
    fa: "خدمات قابل رزرو ما عبارت‌اند از:",
    ar: "خدماتنا المتاحة للحجز هي:",
  };

  const more: Record<string, string> = {
    en: "We have more services too. Tell me what you're looking for and I can help you find the right one.",
    sv: "Vi har fler tjänster också. Berätta vad du letar efter så hjälper jag dig att hitta rätt.",
    de: "Wir haben noch weitere Leistungen. Sagen Sie mir, wonach Sie suchen, dann helfe ich Ihnen, die passende zu finden.",
    es: "También tenemos más servicios. Dime qué estás buscando y te ayudo a encontrar el adecuado.",
    fa: "خدمات بیشتری هم داریم. بگویید دنبال چه نوع خدمتی هستید تا گزینه مناسب را پیدا کنم.",
    ar: "لدينا خدمات أخرى أيضًا. أخبرني بما تبحث عنه وسأساعدك في العثور على الخدمة المناسبة.",
  };

  const rows = plan.displayedServices.map(service => formatConfiguredServiceRow(service, lang));

  if (!rows.length) return "";

  return [
    intro[lang],
    rows.join("\n"),
    ...(plan.hasMoreServices ? [more[lang]] : []),
  ].join("\n");
}


/** Presentation-only: call after grounding, when this tenant's catalog is selected.
 * Remove catalog-role spans, not every sentence mentioning a configured service.
 * Values and units may be formatted differently; prose describing another fact
 * is retained. No evidence or entailment decision is made here.
 */
export function normalizeGroundedCompoundCatalogReply(
  reply: string,
  plan: ConfiguredServiceCatalogPlan,
  language: string,
  businessName = '',
  verifiedLocationQuotes: string[] = [],
): string {
  const catalog = formatConfiguredServiceCatalogPlan(plan, language);
  if (!catalog) return reply;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [...plan.displayedServices].sort((a, b) => b.name.length - a.name.length);
  const namePatterns = names.map(service => new RegExp(
    `(?<![\\p{L}\\p{N}])${escape(service.name)}(?![\\p{L}\\p{N}])`, 'gu',
  ));
  // Intl supplies localized unit and list labels, including short/narrow forms.
  // The configured formatter supplies its own labels and optional follow-up.
  const labels = new Set<string>();
  const listConnectors = new Set<string>();
  const numberReaders: ((text: string) => number)[] = [];
  for (const locale of ['en', 'sv', 'de', 'es', 'fa', 'ar']) {
    const formatter = new Intl.NumberFormat(locale);
    const parts = formatter.formatToParts(12345.6);
    const group = parts.find(part => part.type === 'group')?.value;
    const decimal = parts.find(part => part.type === 'decimal')?.value;
    const digits = Array.from({ length: 10 }, (_, value) => formatter.format(value));
    numberReaders.push(text => {
      let numeric = text;
      digits.forEach((digit, value) => { numeric = numeric.replaceAll(digit, String(value)); });
      if (group) numeric = numeric.replaceAll(group, '');
      if (decimal) numeric = numeric.replaceAll(decimal, '.');
      return Number(numeric);
    });
    for (const unit of ['minute', 'hour'] as const) {
      for (const unitDisplay of ['long', 'short', 'narrow'] as const) {
        for (const value of [1, 2, 30]) {
          for (const part of new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay }).formatToParts(value)) {
            if (part.type === 'unit') labels.add(part.value);
          }
        }
      }
    }
    for (const part of new Intl.ListFormat(locale).formatToParts(['@a', '@b'])) {
      if (part.type === 'literal' && part.value.trim()) {
        labels.add(part.value.trim());
        listConnectors.add(part.value);
      }
    }
  }
  const labelPattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${[...labels].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu',
  );
  const currencies = [...new Set(names.map(service => service.currency).filter((value): value is string => Boolean(value)))];
  const currencyPattern = currencies.length ? new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${currencies.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu',
  ) : null;
  const isCatalogHeading = (text: string): boolean => {
    const heading = businessName ? text.replaceAll(businessName, '') : text;
    const topics = businessInformationTopics(heading);
    return /[:：]$/u.test(text.trim()) &&
      (topics.some(topic => topic === 'services' || topic === 'company') || Boolean(businessName && text.includes(businessName))) &&
      topics.every(topic => topic === 'services' || topic === 'company' || topic === 'prices');
  };
  // Empty topic detection is not positive evidence of an offering preamble.
  // Require an offering verb and only grammatical framing, never extra facts.
  const offeringGrammar: Record<string, { verb: RegExp; framing: RegExp }> = {
    en: { verb: /(?<![\p{L}\p{M}])(?:offer|provide)(?![\p{L}\p{M}])/giu, framing: /(?<![\p{L}\p{M}])(?:we|i)(?![\p{L}\p{M}])/giu },
    de: { verb: /(?<![\p{L}\p{M}])biet(?:e|en|et|t)(?![\p{L}\p{M}])/giu, framing: /(?<![\p{L}\p{M}])(?:wir|ich|an)(?![\p{L}\p{M}])/giu },
    sv: { verb: /(?<![\p{L}\p{M}])erbjud(?:er|s)(?![\p{L}\p{M}])/giu, framing: /(?<![\p{L}\p{M}])(?:vi|jag)(?![\p{L}\p{M}])/giu },
    es: { verb: /(?<![\p{L}\p{M}])ofrec(?:emos|e|en)(?![\p{L}\p{M}])/giu, framing: /(?<![\p{L}\p{M}])nosotros(?![\p{L}\p{M}])/giu },
    ar: { verb: /(?<![\p{L}\p{M}])(?:نقدم|أقدم)(?![\p{L}\p{M}])/gu, framing: /(?<![\p{L}\p{M}])(?:نحن|أنا)(?![\p{L}\p{M}])/gu },
    fa: { verb: /(?<![\p{L}\p{M}])ارائه\s+می[\s‌]*ده(?:یم|م)(?![\p{L}\p{M}])/gu, framing: /(?<![\p{L}\p{M}])(?:ما|من)(?![\p{L}\p{M}])/gu },
  };
  const isOfferingPreamble = (heading: string): boolean => {
    const grammar = offeringGrammar[language];
    return Boolean(grammar && heading.search(grammar.verb) >= 0 &&
      !/[\p{L}\p{M}]/u.test(heading.replace(grammar.verb, '').replace(grammar.framing, '')));
  };
  const attachedConnectorPattern = new RegExp(
    `(?:${[...listConnectors].map(escape).join('|')})(?=(?:${names.map(service => escape(service.name)).join('|')})(?![\\p{L}\\p{N}]))`, 'gu',
  );
  const isCatalogSpan = (text: string): boolean => {
    // Intl may attach a list conjunction directly to the next configured name.
    let remainder = text.replace(attachedConnectorPattern, ' ');
    // An inline list may include its offering preamble before the first name.
    const colon = remainder.search(/[:：]/u);
    if (colon >= 0) {
      const heading = remainder.slice(0, colon + 1);
      const body = remainder.slice(colon + 1);
      // Offering preambles need not contain a services/company topic word.
      // A complete enumeration still needs positive heading/offer recognition;
      // its names, values, units and remaining prose are still checked below.
      const headingTopics = businessInformationTopics(heading);
      const completeInlineCatalog = (headingTopics.length > 0 || isOfferingPreamble(heading)) &&
        namePatterns.every(pattern => body.search(pattern) >= 0) &&
        !/\p{N}/u.test(heading) && headingTopics.every(topic =>
          topic === 'services' || topic === 'company' || topic === 'prices');
      if (isCatalogHeading(heading) || completeInlineCatalog) remainder = body;
    }
    const matchedServices: ConfiguredServiceCatalogItem[] = [];
    namePatterns.forEach((pattern, index) => {
      remainder = remainder.replace(pattern, () => { matchedServices.push(names[index]); return ''; });
    });
    if (!matchedServices.length) return false;
    const catalogValues = matchedServices.flatMap(service => [
      service.price, service.durationMinutes,
      service.durationMinutes === null ? null : service.durationMinutes / 60,
    ]).filter((value): value is number => value !== null);
    // A numeric-only non-catalog fact (e.g. an age requirement) must survive.
    // Accept localized/decimal values and minute-to-hour presentation only.
    const numbers = remainder.match(/\p{N}+(?:(?:[.,٫٬\u00a0\u202f])\p{N}+)*/gu) || [];
    if (numbers.some(token => !numberReaders.some(read => catalogValues.some(value =>
      read(token) === value || read(token) === Number(value.toFixed(3))
    )))) return false;
    if (currencyPattern) remainder = remainder.replace(currencyPattern, '');
    remainder = remainder.replace(labelPattern, '');
    // A row may label its price. Other lexical content is a separate fact and
    // must survive, even if it names every service in the catalog.
    remainder = remainder.replace(/[\p{L}\p{M}]+/gu, word => {
      const topics = businessInformationTopics(word);
      return topics.length === 1 && topics[0] === 'prices' ? '' : word;
    });
    return !/[\p{L}\p{M}]/u.test(remainder);
  };
  const segments = reply.split(/(\n+|(?<=[.!?؟。])\s+)/u);
  // A localized unit abbreviation's period is not a sentence boundary.
  const dottedUnits = [...labels].filter(label => label.endsWith('.'));
  for (let index = 1; index < segments.length; index += 2) {
    if (!segments[index].includes('\n') && names.some(service => segments[index - 1].includes(service.name)) &&
        dottedUnits.some(unit => segments[index - 1].trimEnd().endsWith(unit))) {
      segments[index - 1] += segments[index] + segments[index + 1];
      segments.splice(index, 2);
      index -= 2;
    }
  }
  const fragments = segments.filter((_, index) => index % 2 === 0).map(part => part.trim());
  const roles = fragments.map(isCatalogSpan);
  const detailParts = new Set<string>();
  if (isRtlCatalogLanguage(language)) {
    for (const service of names) {
      const fields = formatConfiguredServiceRow(service, language).split("\n").slice(1).map(field => field.trim());
      // Recognize previous localized representations only beneath their exact
      // configured service header, never beneath an unrelated factual heading.
      const legacyFields = [
        ...(service.durationMinutes !== null ? [language === 'ar' ? 'المدة:' : 'مدت:', `${service.durationMinutes} ${serviceMinuteLabels[language]}`] : []),
        ...(service.price !== null ? [language === 'ar' ? 'السعر:' : 'قیمت:', service.currency ? `${service.price} ${service.currency}` : String(service.price)] : []),
      ];
      const legacyCompact = [
        service.durationMinutes !== null ? `\u2067${service.durationMinutes} ${serviceMinuteLabels[language]}\u2069` : '',
        service.price !== null ? `\u2066${service.currency ? `${service.price} ${service.currency}` : String(service.price)}\u2069` : '',
      ].filter(Boolean).join(' · ');
      const variants = [fields, legacyFields, ...(legacyCompact ? [[legacyCompact]] : [])];
      variants.flat().forEach(field => detailParts.add(field));
      fragments.forEach((part, index) => {
        if (!roles[index] || part.replace(/^[•*-]\s*/u, '').trim() !== service.name) return;
        for (const variant of variants) {
          if (variant.every((field, offset) => fragments[index + offset + 1] === field)) {
            variant.forEach((_, offset) => { roles[index + offset + 1] = true; });
          }
        }
      });
    }
  }
  const canonicalProse = new Set(catalog.split(/\n+|(?<=[.!?؟。])\s+/u)
    .filter(part => !isCatalogSpan(part) && !detailParts.has(part)));
  const seenLocations = new Set<string>();
  let remainder = '';
  let previousKept = -2;
  for (let index = 0; index < fragments.length; index++) {
    const part = fragments[index];
    if (!part || roles[index] || canonicalProse.has(part) ||
        (isCatalogHeading(part) && roles[index + 1])) continue;
    if (isBusinessAddressQuestion(part) || verifiedLocationQuotes.includes(part)) {
      if (seenLocations.has(part)) continue;
      seenLocations.add(part);
    }
    // Preserve contiguous non-catalog prose, including long verified passages.
    remainder += (remainder ? previousKept === index - 1 ? segments[index * 2 - 1] : '\n' : '') + part;
    previousKept = index;
  }
  return [catalog, remainder].filter(Boolean).join('\n');
}


export function formatRecommendationServiceSummary(
  plan: ConfiguredServiceCatalogPlan,
  language: string,
): string {
  const lang = ["en", "sv", "de", "es", "fa", "ar"].includes(language)
    ? language
    : "en";

  const intro: Record<string, string> = {
    en: "We offer several bookable services. Here are a few examples:",
    sv: "Vi erbjuder flera bokningsbara tjänster. Här är några exempel:",
    de: "Wir bieten mehrere buchbare Leistungen an. Hier sind einige Beispiele:",
    es: "Ofrecemos varios servicios que puedes reservar. Aquí tienes algunos ejemplos:",
    fa: "چندین خدمت قابل رزرو ارائه می‌دهیم. چند نمونه:",
    ar: "نقدم عدة خدمات متاحة للحجز. إليك بعض الأمثلة:",
  };

  const rows = plan.displayedServices.slice(0, 3).map(service => formatConfiguredServiceRow(service, lang));

  if (!rows.length) return "";

  return [intro[lang], rows.join("\n")].join("\n");
}

export function formatConfiguredServiceOverview(names: string[], language: string): string {
  const prefix: Record<string, string> = {
    en: 'The configured bookable services are', de: 'Die buchbaren Dienstleistungen sind',
    sv: 'De bokningsbara tjänsterna är', es: 'Los servicios disponibles para reservar son',
    fa: 'خدمات قابل رزرو عبارت‌اند از', ar: 'الخدمات المتاحة للحجز هي',
  };
  return names.length ? `${prefix[language] || prefix.en}: ${names.join(', ')}.` : '';
}
