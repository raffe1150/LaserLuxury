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
  if (!raw) return false;

  const topics = businessInformationTopics(raw);
  if (!topics.includes("services")) return false;

  // If the customer is actually asking about prices, policies, contact details,
  // or opening hours, a plain service catalog is not sufficient.
  if (topics.some((topic) =>
    ["prices", "policies", "contact", "hours"].includes(topic)
  )) {
    return false;
  }

  if (!isBusinessInformationQuestion(raw)) return false;

  // A catalog request asks about the service collection itself, not merely
  // whether one named service is offered.
  const mentionsServiceCollection =
    /\b(?:services?|offerings?|dienstleistungen?|leistungen?|serviceportfolio|leistungskatalog|tjänster|utbud|servicios?|paquetes?)\b|خدمات|سرویس(?:‌|\s)*(?:ها|هایی)|الخدمات/iu.test(raw);

  if (!mentionsServiceCollection) return false;

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

  const minuteLabel: Record<string, string> = {
    en: "minutes",
    sv: "minuter",
    de: "Minuten",
    es: "minutos",
    fa: "دقیقه",
    ar: "دقيقة",
  };

  const rows = plan.displayedServices.map((service) => {
    const details: string[] = [];

    if (service.durationMinutes !== null) {
      details.push(`${service.durationMinutes} ${minuteLabel[lang]}`);
    }

    if (service.price !== null) {
      details.push(
        service.currency
          ? `${service.price} ${service.currency}`
          : String(service.price),
      );
    }

    return details.length
      ? `• ${service.name} (${details.join(", ")})`
      : `• ${service.name}`;
  });

  if (!rows.length) return "";

  return [
    intro[lang],
    ...rows,
    ...(plan.hasMoreServices ? [more[lang]] : []),
  ].join("\n");
}

export function formatConfiguredServiceOverview(names: string[], language: string): string {
  const prefix: Record<string, string> = {
    en: 'The configured bookable services are', de: 'Die buchbaren Dienstleistungen sind',
    sv: 'De bokningsbara tjänsterna är', es: 'Los servicios disponibles para reservar son',
    fa: 'خدمات قابل رزرو عبارت‌اند از', ar: 'الخدمات المتاحة للحجز هي',
  };
  return names.length ? `${prefix[language] || prefix.en}: ${names.join(', ')}.` : '';
}
