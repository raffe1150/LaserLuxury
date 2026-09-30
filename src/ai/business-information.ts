/** Read-only topic recognition. It does not choose services or authorize bookings. */
export type BusinessInformationTopic = 'company' | 'services' | 'contact' | 'hours' | 'prices' | 'policies' | 'parking';

const businessAddressPattern = /(?<![\p{L}\p{M}\p{N}_])(?:location|located|standort\w*|kundeneingang\w*|adresse|adress|kundentré\w*|ubicaci[oó]n|ubicad\w*|direcci[oó]n|befind\w*)(?![\p{L}\p{M}\p{N}_])|\b(?:your|our|business|street|postal|mailing|physical)\s+address\b|\b(?:what(?:['’]s|\s+is)|where(?:['’]s|\s+is))\s+(?:the\s+|your\s+|our\s+)?address\b|\bcustomer\s+entrance\b|\bentrance\s+(?:for\s+)?customers?\b|\bvar\s+ligger\b|\bentrada\s+(?:de\s+|para\s+)?clientes?\b|آدرس|ورودی\s+مشتری(?:ان)?|کجا\s+هست|عنوان(?:كم|ك|نا)|مدخل\s+العملاء|(?:أين|اين)\s+(?:يقع\s+)?(?:مكان|موقع)/iu;

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
    .filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}

export function isBusinessAddressQuestion(text: string): boolean {
  return businessAddressPattern.test(String(text || ''));
}

export function isBusinessRecommendationQuestion(text: string): boolean {
  return /\b(?:recommend(?:ation|ed)?|suggest(?:ion|ed)?|best\s+(?:service|option|choice)|first[- ]time|first\s+visit|new\s+customer|what\s+(?:service|option)\s+(?:should|would)\s+(?:i|you)|what\s+(?:should|would)\s+(?:i|you)\s+(?:choose|pick|book|try|get)|empfehl\w*|erstbesuch|zum\s+ersten\s+mal|rekommend\w*|första\s+gången|förstagångsbesök|recomiend\w*|recomend\w*|primera\s+vez)\b|پیشنهاد|توصیه|بار اول|لأول مرة|توصي|اقتراح/iu.test(String(text || ''));
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
  if (language === 'sv') return 'Vad vill du främst ha hjälp med, så kan jag hjälpa dig att välja bland de här verifierade tjänsterna?';
  if (language === 'de') return 'Wobei möchten Sie vor allem Unterstützung, damit ich Ihnen bei der Auswahl aus diesen bestätigten Leistungen helfen kann?';
  if (language === 'es') return '¿Qué te gustaría conseguir principalmente para que pueda ayudarte a elegir entre estos servicios verificados?';
  if (language === 'fa') return 'بیشتر برای چه هدفی کمک می‌خواهید تا از میان این خدمات تأییدشده انتخاب کنیم؟';
  if (language === 'ar') return 'ما الهدف الأساسي الذي تريد المساعدة فيه لكي أساعدك على الاختيار من هذه الخدمات المؤكدة؟';
  return 'What would you mainly like help with, so I can help you choose among these verified services?';
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
      if (part.type === 'literal' && part.value.trim()) labels.add(part.value.trim());
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
  const isCatalogSpan = (text: string): boolean => {
    let remainder = text;
    // An inline list may include its offering preamble before the first name.
    const colon = remainder.search(/[:：]/u);
    if (colon >= 0 && isCatalogHeading(remainder.slice(0, colon + 1))) remainder = remainder.slice(colon + 1);
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
  const canonicalProse = new Set(catalog.split(/\n+|(?<=[.!?؟。])\s+/u)
    .filter(part => !isCatalogSpan(part)));
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

  const minuteLabel: Record<string, string> = {
    en: "minutes",
    sv: "minuter",
    de: "Minuten",
    es: "minutos",
    fa: "دقیقه",
    ar: "دقيقة",
  };

  const rows = plan.displayedServices.slice(0, 3).map((service) => {
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

  return [intro[lang], ...rows].join("\n");
}

export function formatConfiguredServiceOverview(names: string[], language: string): string {
  const prefix: Record<string, string> = {
    en: 'The configured bookable services are', de: 'Die buchbaren Dienstleistungen sind',
    sv: 'De bokningsbara tjänsterna är', es: 'Los servicios disponibles para reservar son',
    fa: 'خدمات قابل رزرو عبارت‌اند از', ar: 'الخدمات المتاحة للحجز هي',
  };
  return names.length ? `${prefix[language] || prefix.en}: ${names.join(', ')}.` : '';
}
