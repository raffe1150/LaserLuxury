/** Read-only topic recognition. It does not choose services or authorize bookings. */
export type BusinessInformationTopic = 'company' | 'services' | 'contact' | 'hours' | 'prices' | 'policies';
const topicPatterns: Record<BusinessInformationTopic, RegExp> = {
  company: /\b(?:company|business|unternehmen|firma|företag|verksamhet|empresa|negocio)\b|کسب.?و.?کار|شرکت|الشركة|المنشأة/iu,
  services: /\b(?:services?|offer(?:ings?)?|dienstleistungen?|leistungen?|angebot\w*|serviceportfolio|leistungskatalog|pakete?|tjänst\w*|utbud|servicios?|ofrecen|paquetes?)\b|خدمات|سرویس|الخدمات|خدمة/iu,
  contact: /(?<![\p{L}\p{M}\p{N}_])(?:contact\w*|reach|website|übersichtsseite|standort\w*|erreichen|kontakt\w*|address|adresse|adress|ubicaci[oó]n|direcci[oó]n)(?![\p{L}\p{M}\p{N}_])|تماس|آدرس|موقع|عنوان|اتصال/iu,
  hours: /(?<![\p{L}\p{M}\p{N}_])(?:opening hours|hours|öffnungszeiten|öppettider|horarios?)(?![\p{L}\p{M}\p{N}_])|ساعات کاری|ساعات العمل/iu,
  prices: /\b(?:prices?|costs?|pricing|preisen?|preise?|kosten|pris\w*|kostar|precios?|cuesta)\b|قیمت|هزینه|السعر|أسعار/iu,
  policies: /\b(?:polic\w*|conditions|requirements|preparation|prepare|bring|payment|documents?|bedingungen|geschäftsbedingungen|vorbereit\w*|mitbringen|betalning|villkor|förbereda|ta med|condiciones|preparar|llevar|pago)\b|شرایط|آماده|پرداخت|شروط|تحضير|دفع/iu,
};
export function businessInformationTopics(text: string): BusinessInformationTopic[] {
  return (Object.entries(topicPatterns) as [BusinessInformationTopic, RegExp][])
    .filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}
export function isBusinessInformationQuestion(text: string): boolean {
  if (!businessInformationTopics(text).length) return false;
  const informationFirst = /\b(?:before\s+i\s+book|bevor\s+ich|erstmal\s+informieren|innan\s+jag\s+bokar|antes\s+de\s+reservar)\b|قبل از رزرو|قبل الحجز/iu.test(text);
  // A real instruction, including a mixed question + booking request, must stay
  // with the deterministic engine. Mentioning "how booking works" is not one.
  const action = /\b(?:please\s+(?:book|cancel|reschedule)|(?:i\s+(?:want|would like)\s+to|can you)\s+(?:book|cancel|reschedule)|(?:bitte|ich möchte|ich will)\s+(?:(?:einen?|den|die|das)\s+)?(?:.{0,45}\s+)?(?:buchen|buche|stornieren|verschieben)|(?:boka|avboka|omboka)\s+(?:en|ett|min|den)|(?:quiero|por favor)\s+(?:reservar|cancelar|cambiar))\b|(?:رزرو|لغو)\s+کن|(?:احجز|أحجز|الغاء|إلغاء)\s/iu.test(text);
  if (action && !informationFirst) return false;
  return /[?؟]|\b(?:tell me|explain|information|describe|erzähl\w*|erfahr\w*|informier\w*|erklär\w*|wissen|berätta|beskriv|förklara|veta|informaci[oó]n|explica\w*)\b|اطلاعات|توضیح|معلومات|اشرح/iu.test(text);
}

const topicLabels: Record<string, Record<BusinessInformationTopic, string>> = {
  en: { company: 'the company', services: 'services', contact: 'contact details and links', hours: 'opening hours', prices: 'prices', policies: 'terms and preparation' },
  de: { company: 'das Unternehmen', services: 'die Dienstleistungen', contact: 'Kontaktmöglichkeiten und Links', hours: 'die Öffnungszeiten', prices: 'die Preise', policies: 'Bedingungen und Vorbereitung' },
  sv: { company: 'företaget', services: 'tjänsterna', contact: 'kontaktuppgifter och länkar', hours: 'öppettiderna', prices: 'priserna', policies: 'villkor och förberedelser' },
  es: { company: 'la empresa', services: 'los servicios', contact: 'contactos y enlaces', hours: 'los horarios', prices: 'los precios', policies: 'condiciones y preparación' },
  fa: { company: 'شرکت', services: 'خدمات', contact: 'اطلاعات تماس و لینک‌ها', hours: 'ساعات کاری', prices: 'قیمت‌ها', policies: 'شرایط و آمادگی' },
  ar: { company: 'الشركة', services: 'الخدمات', contact: 'بيانات الاتصال والروابط', hours: 'ساعات العمل', prices: 'الأسعار', policies: 'الشروط والتحضير' },
};
export function businessInformationSubject(text: string, language: string): string {
  const labels = topicLabels[language] || topicLabels.en;
  return businessInformationTopics(text).map(topic => labels[topic]).join(' / ');
}

export function isServiceCatalogQuestion(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw || !businessInformationTopics(raw).includes("services")) return false;

  return (
    /\b(?:what\s+(?:services?|offerings?)\s+do\s+you\s+(?:offer|have)|which\s+services?\s+do\s+you\s+(?:offer|have)|what\s+do\s+you\s+offer|services?\s+available)\b/iu.test(raw) ||
    /\b(?:welche\s+(?:dienstleistungen?|leistungen?)\s+(?:bieten|haben)\s+sie|was\s+bieten\s+sie\s+an)\b/iu.test(raw) ||
    /\b(?:vilka\s+tjänster\s+(?:erbjuder|har)\s+ni|vad\s+erbjuder\s+ni)\b/iu.test(raw) ||
    /\b(?:qué\s+servicios?\s+(?:ofrecen|tienen)|cuáles\s+son\s+sus\s+servicios)\b/iu.test(raw) ||
    /(?:چه|کدام)\s+(?:سرویس|خدمت|خدمات)(?:‌|\s)*(?:ها|هایی)?\s+(?:ارائه|دارید)/u.test(raw) ||
    /(?:ما|ما هي|ما هيَ|ما هيّ)\s+الخدمات\s+التي\s+(?:تقدمون|تقدمها|لديكم)/u.test(raw)
  );
}

export function formatConfiguredServiceOverview(names: string[], language: string): string {
  const prefix: Record<string, string> = {
    en: 'The configured bookable services are', de: 'Die buchbaren Dienstleistungen sind',
    sv: 'De bokningsbara tjänsterna är', es: 'Los servicios disponibles para reservar son',
    fa: 'خدمات قابل رزرو عبارت‌اند از', ar: 'الخدمات المتاحة للحجز هي',
  };
  return names.length ? `${prefix[language] || prefix.en}: ${names.join(', ')}.` : '';
}
