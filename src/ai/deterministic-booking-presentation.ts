import {
  type BusinessToneConfig,
  normalizeBusinessToneConfig,
} from './tone-controls';

export const BOOKING_PRESENTATION_LANGUAGES = ['sv', 'en', 'fa', 'de', 'es', 'ar'] as const;
export type BookingPresentationLanguage = (typeof BOOKING_PRESENTATION_LANGUAGES)[number];

type AvailabilityFacts =
  | { kind: 'available_exact'; date: string; time: string }
  | { kind: 'none' }
  | { kind: 'busy_none'; requestedTime: string }
  | { kind: 'busy_alternatives'; requestedTime: string; slots: string }
  | { kind: 'found'; slots: string };

type MissingDetailsFacts = {
  missing: Array<'name' | 'phone' | 'service'>;
};

type ConfirmationFacts = {
  name: string;
  service: string;
  date: string;
  time: string;
};

type LocalizedPresentation = {
  availability: {
    balanced: (facts: AvailabilityFacts) => string;
    short: (facts: AvailabilityFacts) => string;
    detailedTail: string;
  };
  details: {
    balanced: (facts: MissingDetailsFacts) => string;
    short: (facts: MissingDetailsFacts) => string;
    detailedTail: string;
  };
  confirmation: {
    balanced: (facts: ConfirmationFacts) => string;
    short: (facts: ConfirmationFacts) => string;
    detailedTail: string;
  };
};

type TonePhrases = Record<BusinessToneConfig['tonePreset'], readonly [string, string]>;
type NaturalToneLexicon = {
  availabilityFound: TonePhrases;
  availabilityQuestion: Record<BusinessToneConfig['formality'], readonly [string, string]>;
  details: TonePhrases;
  detailFields: (missing: MissingDetailsFacts['missing']) => string;
  confirmation: TonePhrases;
};

function availabilityEnglish(facts: AvailabilityFacts, short = false): string {
  if (facts.kind === 'available_exact') return short
    ? `${facts.date} at ${facts.time} is available. Book it?`
    : `Yes, ${facts.date} at ${facts.time} is available. Would you like me to book it?`;
  if (facts.kind === 'none') return short
    ? 'No available times were found. Would another date work?'
    : 'Sorry, I couldn’t find any available times for that period. Do you have another date in mind?';
  if (facts.kind === 'busy_none') return short
    ? `${facts.requestedTime} is unavailable, with no alternatives found. Another date?`
    : `Sorry, ${facts.requestedTime} is already booked and I couldn’t find other available times. Do you have another date?`;
  if (facts.kind === 'busy_alternatives') return short
    ? `${facts.requestedTime} is unavailable. Available: ${facts.slots}. Which works?`
    : `Sorry, ${facts.requestedTime} is not available. I found these times: ${facts.slots}. Which one suits you best?`;
  return short
    ? `Available: ${facts.slots}. Which works best?`
    : `I found these available times: ${facts.slots}. Which one suits you best?`;
}

function availabilitySwedish(facts: AvailabilityFacts, short = false): string {
  if (facts.kind === 'available_exact') return short ? `${facts.date} kl ${facts.time} är ledig. Boka?` : `Ja, ${facts.date} kl ${facts.time} är ledig! Ska jag boka den åt dig?`;
  if (facts.kind === 'none') return short ? 'Inga lediga tider hittades. Passar ett annat datum?' : 'Jag hittade tyvärr inga lediga tider för den perioden. Har du något annat datum i åtanke?';
  if (facts.kind === 'busy_none') return short ? `Kl ${facts.requestedTime} är upptagen och inga alternativ hittades. Ett annat datum?` : `Tyvärr är kl ${facts.requestedTime} redan bokat, och jag hittade inga andra lediga tider för den perioden. Har du något annat datum i åtanke?`;
  if (facts.kind === 'busy_alternatives') return short ? `Kl ${facts.requestedTime} är upptagen. Ledigt: ${facts.slots}. Vilken passar?` : `Tyvärr är kl ${facts.requestedTime} inte ledig. Men jag hittade lediga tider ${facts.slots}. Vilken passar dig bäst?`;
  return short ? `Ledigt: ${facts.slots}. Vilken passar bäst?` : `Jag hittade lediga tider ${facts.slots}. Vilken av dessa tider passar dig bäst?`;
}

function availabilityPersian(facts: AvailabilityFacts, short = false): string {
  if (facts.kind === 'available_exact') return short ? `${facts.date} ساعت ${facts.time} خالی است. رزرو کنم؟` : `بله، ${facts.date} ساعت ${facts.time} خالی است. می‌خواهید برایتان رزرو کنم؟`;
  if (facts.kind === 'none') return short ? 'زمان خالی پیدا نشد. تاریخ دیگری مناسب است؟' : 'متأسفانه برای این بازه زمان خالی پیدا نکردم. تاریخ دیگری مدنظرتان هست؟';
  if (facts.kind === 'busy_none') return short ? `ساعت ${facts.requestedTime} پر است و جایگزینی پیدا نشد. تاریخ دیگری؟` : `متأسفانه ساعت ${facts.requestedTime} پر است و زمان خالی دیگری پیدا نکردم. تاریخ دیگری مدنظرتان هست؟`;
  if (facts.kind === 'busy_alternatives') return short ? `ساعت ${facts.requestedTime} خالی نیست. زمان‌های خالی: ${facts.slots}. کدام مناسب است؟` : `متأسفانه ساعت ${facts.requestedTime} خالی نیست. این زمان‌ها خالی هستند: ${facts.slots}. کدام مناسب شماست؟`;
  return short ? `زمان‌های خالی: ${facts.slots}. کدام مناسب است؟` : `این زمان‌ها خالی هستند: ${facts.slots}. کدام برای شما مناسب‌تر است؟`;
}

function availabilityGerman(facts: AvailabilityFacts, short = false): string {
  if (facts.kind === 'available_exact') return short ? `${facts.date} um ${facts.time} Uhr ist verfügbar. Buchen?` : `Ja, ${facts.date} um ${facts.time} Uhr ist verfügbar. Möchten Sie den Termin buchen?`;
  if (facts.kind === 'none') return short ? 'Keine freien Zeiten gefunden. Passt ein anderes Datum?' : 'Leider habe ich für diesen Zeitraum keine freien Zeiten gefunden. Haben Sie ein anderes Datum im Sinn?';
  if (facts.kind === 'busy_none') return short ? `${facts.requestedTime} Uhr ist belegt; keine Alternativen gefunden. Anderes Datum?` : `Leider ist ${facts.requestedTime} Uhr nicht verfügbar und ich habe keine anderen freien Zeiten gefunden. Haben Sie ein anderes Datum im Sinn?`;
  if (facts.kind === 'busy_alternatives') return short ? `${facts.requestedTime} Uhr ist belegt. Frei: ${facts.slots}. Welche passt?` : `Leider ist ${facts.requestedTime} Uhr nicht verfügbar. Ich habe diese freien Zeiten gefunden: ${facts.slots}. Welche passt Ihnen am besten?`;
  return short ? `Frei: ${facts.slots}. Welche passt am besten?` : `Ich habe diese freien Zeiten gefunden: ${facts.slots}. Welche passt Ihnen am besten?`;
}

function availabilitySpanish(facts: AvailabilityFacts, short = false): string {
  if (facts.kind === 'available_exact') return short ? `${facts.date} a las ${facts.time} está libre. ¿Reservar?` : `Sí, ${facts.date} a las ${facts.time} está libre. ¿Quieres que lo reserve?`;
  if (facts.kind === 'none') return short ? 'No encontré horas libres. ¿Te sirve otra fecha?' : 'Lo siento, no encontré horas libres en ese período. ¿Tienes otra fecha en mente?';
  if (facts.kind === 'busy_none') return short ? `Las ${facts.requestedTime} están ocupadas y no hay alternativas. ¿Otra fecha?` : `Lo siento, las ${facts.requestedTime} ya están ocupadas y no encontré otras horas libres. ¿Tienes otra fecha?`;
  if (facts.kind === 'busy_alternatives') return short ? `Las ${facts.requestedTime} no están libres. Disponibles: ${facts.slots}. ¿Cuál prefieres?` : `Lo siento, las ${facts.requestedTime} no están libres. Tengo estas horas: ${facts.slots}. ¿Cuál te va mejor?`;
  return short ? `Disponibles: ${facts.slots}. ¿Cuál prefieres?` : `Tengo estas horas libres: ${facts.slots}. ¿Cuál te va mejor?`;
}

function availabilityArabic(facts: AvailabilityFacts, short = false): string {
  if (facts.kind === 'available_exact') return short ? `${facts.date} الساعة ${facts.time} متاح. هل أحجزه؟` : `نعم، ${facts.date} الساعة ${facts.time} متاح. هل تريد أن أحجزه لك؟`;
  if (facts.kind === 'none') return short ? 'لم أجد موعدًا متاحًا. هل يناسبك تاريخ آخر؟' : 'للأسف لم أجد مواعيد متاحة في هذه الفترة. هل لديك تاريخ آخر؟';
  if (facts.kind === 'busy_none') return short ? `الساعة ${facts.requestedTime} غير متاحة ولا توجد بدائل. تاريخ آخر؟` : `للأسف الساعة ${facts.requestedTime} غير متاحة ولم أجد مواعيد أخرى. هل لديك تاريخ آخر؟`;
  if (facts.kind === 'busy_alternatives') return short ? `الساعة ${facts.requestedTime} غير متاحة. المتاح: ${facts.slots}. أيها يناسبك؟` : `للأسف الساعة ${facts.requestedTime} غير متاحة. هذه المواعيد متاحة: ${facts.slots}. أي وقت يناسبك؟`;
  return short ? `المتاح: ${facts.slots}. أيها يناسبك؟` : `هذه المواعيد متاحة: ${facts.slots}. أي وقت يناسبك؟`;
}

const presentations: Record<BookingPresentationLanguage, LocalizedPresentation> = {
  en: {
    availability: { balanced: (f) => availabilityEnglish(f), short: (f) => availabilityEnglish(f, true), detailedTail: ' Reply with the time you prefer, and I’ll help with the next step.' },
    details: {
      balanced: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'To finish the booking, I only need your name and mobile number.' : missing.includes('name') ? 'I only need your name to finish the booking.' : missing.includes('phone') ? 'I only need your mobile number to finish the booking.' : missing.includes('service') ? 'Which service would you like to book?' : 'I have everything needed to finish the booking.',
      short: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'Please send your name and mobile number.' : missing.includes('name') ? 'Please send your name.' : missing.includes('phone') ? 'Please send your mobile number.' : missing.includes('service') ? 'Which service would you like?' : 'Everything needed is ready.',
      detailedTail: ' Once received, I can safely continue the booking.',
    },
    confirmation: { balanced: (f) => `${f.name}, your appointment for ${f.service} is booked on ${f.date} at ${f.time}.`, short: (f) => `${f.name}, ${f.service} is booked for ${f.date} at ${f.time}.`, detailedTail: ' Your booking is confirmed.' },
  },
  sv: {
    availability: { balanced: (f) => availabilitySwedish(f), short: (f) => availabilitySwedish(f, true), detailedTail: ' Svara med tiden du föredrar, så hjälper jag dig vidare.' },
    details: {
      balanced: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'För att slutföra bokningen behöver jag bara ditt namn och mobilnummer.' : missing.includes('name') ? 'Jag behöver bara ditt namn för att slutföra bokningen.' : missing.includes('phone') ? 'Jag behöver bara ditt mobilnummer för att slutföra bokningen.' : missing.includes('service') ? 'Vilken tjänst vill du boka?' : 'Jag har allt jag behöver för att slutföra bokningen.',
      short: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'Skicka namn och mobilnummer.' : missing.includes('name') ? 'Skicka ditt namn.' : missing.includes('phone') ? 'Skicka ditt mobilnummer.' : missing.includes('service') ? 'Vilken tjänst vill du ha?' : 'Allt som behövs är klart.',
      detailedTail: ' När jag har uppgifterna kan jag fortsätta bokningen på ett säkert sätt.',
    },
    confirmation: { balanced: (f) => `${f.name}, din tid för ${f.service} är bokad ${f.date} kl ${f.time}.`, short: (f) => `${f.name}, ${f.service} är bokad ${f.date} kl ${f.time}.`, detailedTail: ' Din bokning är bekräftad.' },
  },
  fa: {
    availability: { balanced: (f) => availabilityPersian(f), short: (f) => availabilityPersian(f, true), detailedTail: ' زمان دلخواهتان را بفرستید تا مرحله بعد را انجام دهم.' },
    details: {
      balanced: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'برای نهایی‌کردن رزرو فقط نام و شماره موبایل‌تان را بفرستید.' : missing.includes('name') ? 'فقط نام‌تان را بفرستید تا رزرو را نهایی کنم.' : missing.includes('phone') ? 'فقط شماره موبایل‌تان را بفرستید تا رزرو را نهایی کنم.' : missing.includes('service') ? 'لطفاً بفرمایید کدام خدمت را می‌خواهید رزرو کنید.' : 'همه اطلاعات لازم برای تکمیل رزرو آماده است.',
      short: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'نام و شماره موبایل‌تان را بفرستید.' : missing.includes('name') ? 'نام‌تان را بفرستید.' : missing.includes('phone') ? 'شماره موبایل‌تان را بفرستید.' : missing.includes('service') ? 'کدام خدمت را می‌خواهید؟' : 'همه اطلاعات آماده است.',
      detailedTail: ' پس از دریافت اطلاعات، رزرو را با اطمینان ادامه می‌دهم.',
    },
    confirmation: { balanced: (f) => `${f.name}، وقت شما برای ${f.service} در ${f.date} ساعت ${f.time} رزرو شد.`, short: (f) => `${f.name}، ${f.service} برای ${f.date} ساعت ${f.time} رزرو شد.`, detailedTail: ' رزرو شما تأیید شده است.' },
  },
  de: {
    availability: { balanced: (f) => availabilityGerman(f), short: (f) => availabilityGerman(f, true), detailedTail: ' Antworten Sie mit Ihrer bevorzugten Zeit, dann helfe ich beim nächsten Schritt.' },
    details: {
      balanced: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'Zum Abschluss brauche ich nur Ihren Namen und Ihre Mobilnummer.' : missing.includes('name') ? 'Ich brauche nur noch Ihren Namen.' : missing.includes('phone') ? 'Ich brauche nur noch Ihre Mobilnummer.' : missing.includes('service') ? 'Welche Behandlung möchten Sie buchen?' : 'Alle erforderlichen Angaben sind vollständig.',
      short: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'Bitte senden Sie Name und Mobilnummer.' : missing.includes('name') ? 'Bitte senden Sie Ihren Namen.' : missing.includes('phone') ? 'Bitte senden Sie Ihre Mobilnummer.' : missing.includes('service') ? 'Welche Behandlung möchten Sie?' : 'Alle Angaben sind vollständig.',
      detailedTail: ' Danach kann ich die Buchung sicher fortsetzen.',
    },
    confirmation: { balanced: (f) => `${f.name}, Ihr Termin für ${f.service} ist am ${f.date} um ${f.time} gebucht.`, short: (f) => `${f.name}, ${f.service} ist am ${f.date} um ${f.time} gebucht.`, detailedTail: ' Ihre Buchung ist bestätigt.' },
  },
  es: {
    availability: { balanced: (f) => availabilitySpanish(f), short: (f) => availabilitySpanish(f, true), detailedTail: ' Responde con la hora que prefieras y te ayudaré con el siguiente paso.' },
    details: {
      balanced: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'Para finalizar, solo necesito tu nombre y número de móvil.' : missing.includes('name') ? 'Solo necesito tu nombre para finalizar la reserva.' : missing.includes('phone') ? 'Solo necesito tu número de móvil para finalizar la reserva.' : missing.includes('service') ? '¿Qué servicio quieres reservar?' : 'Ya tengo todo lo necesario para finalizar la reserva.',
      short: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'Envía tu nombre y número de móvil.' : missing.includes('name') ? 'Envía tu nombre.' : missing.includes('phone') ? 'Envía tu número de móvil.' : missing.includes('service') ? '¿Qué servicio quieres?' : 'Todo está listo.',
      detailedTail: ' Cuando los reciba, podré continuar la reserva de forma segura.',
    },
    confirmation: { balanced: (f) => `${f.name}, tu cita para ${f.service} está reservada el ${f.date} a las ${f.time}.`, short: (f) => `${f.name}, ${f.service} está reservado el ${f.date} a las ${f.time}.`, detailedTail: ' Tu reserva está confirmada.' },
  },
  ar: {
    availability: { balanced: (f) => availabilityArabic(f), short: (f) => availabilityArabic(f, true), detailedTail: ' أرسل الوقت الذي تفضله وسأساعدك في الخطوة التالية.' },
    details: {
      balanced: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'لإتمام الحجز، أحتاج فقط اسمك ورقم هاتفك.' : missing.includes('name') ? 'أحتاج فقط اسمك لإتمام الحجز.' : missing.includes('phone') ? 'أحتاج فقط رقم هاتفك لإتمام الحجز.' : missing.includes('service') ? 'ما الخدمة التي تريد حجزها؟' : 'لدي كل المعلومات اللازمة لإتمام الحجز.',
      short: ({ missing }) => missing.includes('name') && missing.includes('phone') ? 'أرسل اسمك ورقم هاتفك.' : missing.includes('name') ? 'أرسل اسمك.' : missing.includes('phone') ? 'أرسل رقم هاتفك.' : missing.includes('service') ? 'ما الخدمة التي تريدها؟' : 'كل المعلومات جاهزة.',
      detailedTail: ' بعد استلامها، يمكنني متابعة الحجز بأمان.',
    },
    confirmation: { balanced: (f) => `${f.name}، تم حجز موعدك لـ ${f.service} يوم ${f.date} الساعة ${f.time}.`, short: (f) => `${f.name}، تم حجز ${f.service} يوم ${f.date} الساعة ${f.time}.`, detailedTail: ' تم تأكيد حجزك.' },
  },
};

const naturalToneLexicons: Record<BookingPresentationLanguage, NaturalToneLexicon> = {
  en: {
    availabilityFound: {
      professional: ['The following times are available: ', 'Current availability includes: '],
      friendly: ['I found a few times that could work: ', 'Here are some available times for you: '],
      warm: ['I’d be happy to help. These times are available: ', 'Here are the available times I found for you: '],
      casual: ['Sure — here are the available times: ', 'Here’s what’s open: '],
      concise: ['Available: ', 'Open times: '],
      custom: ['These times are available: ', 'Current available times: '],
    },
    availabilityQuestion: {
      formal: [' Which time would you prefer?', ' Please select the time that suits you best.'],
      balanced: [' Which one suits you best?', ' Which time works best for you?'],
      casual: [' Which works for you?', ' Which one should we go with?'],
    },
    details: {
      professional: ['To complete the booking, please provide {fields}.', 'Please provide {fields} to complete the booking.'],
      friendly: ['Great — I just need {fields} to finish the booking.', 'We’re nearly done. Send {fields}, and I can finish the booking.'],
      warm: ['Of course. I only need {fields} to complete the booking.', 'Whenever you’re ready, send {fields} and I can complete the booking.'],
      casual: ['Almost there — just send {fields}.', 'Just send {fields}, and we’re good to continue.'],
      concise: ['Send {fields}.', 'Needed: {fields}.'],
      custom: ['To continue, please provide {fields}.', 'Please send {fields} so the booking can continue.'],
    },
    detailFields: (missing) => missing.includes('name') && missing.includes('phone') ? 'your name and mobile number' : missing.includes('name') ? 'your name' : missing.includes('phone') ? 'your mobile number' : missing.includes('service') ? 'the service you would like' : 'the remaining details',
    confirmation: {
      professional: ['{facts}', 'Booking confirmed: {facts}'],
      friendly: ['You’re all set — {facts}', 'Great, everything is booked. {facts}'],
      warm: ['Everything is set. {facts}', 'Your booking is all taken care of. {facts}'],
      casual: ['All set — {facts}', 'Done — {facts}'],
      concise: ['{facts}', 'Confirmed: {facts}'],
      custom: ['{facts}', 'Booking complete: {facts}'],
    },
  },
  sv: {
    availabilityFound: {
      professional: ['Följande tider är lediga: ', 'Nuvarande tillgänglighet är: '],
      friendly: ['Jag hittade några tider som kan passa: ', 'Här är några lediga tider för dig: '],
      warm: ['Jag hjälper gärna till. De här tiderna är lediga: ', 'Här är tiderna jag hittade åt dig: '],
      casual: ['Absolut — här är de lediga tiderna: ', 'Det här finns ledigt: '],
      concise: ['Ledigt: ', 'Lediga tider: '],
      custom: ['De här tiderna är lediga: ', 'Aktuella lediga tider: '],
    },
    availabilityQuestion: {
      formal: [' Vilken tid föredrar du?', ' Vänligen välj den tid som passar bäst.'],
      balanced: [' Vilken passar dig bäst?', ' Vilken tid fungerar bäst för dig?'],
      casual: [' Vilken funkar för dig?', ' Vilken kör vi på?'],
    },
    details: {
      professional: ['För att slutföra bokningen, vänligen skicka {fields}.', 'Vänligen skicka {fields} för att slutföra bokningen.'],
      friendly: ['Toppen — jag behöver bara {fields} för att slutföra bokningen.', 'Vi är nästan klara. Skicka {fields}, så slutför jag bokningen.'],
      warm: ['Självklart. Jag behöver bara {fields} för att slutföra bokningen.', 'När du är redo kan du skicka {fields}, så tar jag bokningen vidare.'],
      casual: ['Nästan klart — skicka bara {fields}.', 'Skicka bara {fields}, så fortsätter vi.'],
      concise: ['Skicka {fields}.', 'Behövs: {fields}.'],
      custom: ['För att fortsätta, skicka {fields}.', 'Skicka {fields}, så kan bokningen fortsätta.'],
    },
    detailFields: (missing) => missing.includes('name') && missing.includes('phone') ? 'ditt namn och mobilnummer' : missing.includes('name') ? 'ditt namn' : missing.includes('phone') ? 'ditt mobilnummer' : missing.includes('service') ? 'vilken tjänst du vill boka' : 'de återstående uppgifterna',
    confirmation: {
      professional: ['{facts}', 'Bokningen är bekräftad: {facts}'],
      friendly: ['Allt är klart — {facts}', 'Toppen, bokningen är klar. {facts}'],
      warm: ['Allt är ordnat. {facts}', 'Din bokning är omhändertagen. {facts}'],
      casual: ['Klart — {facts}', 'Fixat — {facts}'],
      concise: ['{facts}', 'Bekräftat: {facts}'],
      custom: ['{facts}', 'Bokningen är klar: {facts}'],
    },
  },
  es: {
    availabilityFound: {
      professional: ['Los siguientes horarios están disponibles: ', 'La disponibilidad actual incluye: '],
      friendly: ['Encontré algunos horarios que podrían servirte: ', 'Aquí tienes algunos horarios disponibles: '],
      warm: ['Con gusto te ayudo. Estos horarios están disponibles: ', 'Estos son los horarios que encontré para ti: '],
      casual: ['Claro — estos son los horarios libres: ', 'Esto es lo que hay disponible: '],
      concise: ['Disponibles: ', 'Horarios libres: '],
      custom: ['Estos horarios están disponibles: ', 'Horarios disponibles actualmente: '],
    },
    availabilityQuestion: {
      formal: [' ¿Qué horario prefiere?', ' Elija el horario que más le convenga.'],
      balanced: [' ¿Cuál te va mejor?', ' ¿Qué horario te viene mejor?'],
      casual: [' ¿Cuál te sirve?', ' ¿Con cuál nos quedamos?'],
    },
    details: {
      professional: ['Para completar la reserva, envíe {fields}.', 'Envíe {fields} para completar la reserva.'],
      friendly: ['Genial — solo necesito {fields} para terminar la reserva.', 'Ya casi está. Envíame {fields} y termino la reserva.'],
      warm: ['Por supuesto. Solo necesito {fields} para completar la reserva.', 'Cuando quieras, envíame {fields} y completaré la reserva.'],
      casual: ['Ya casi — solo envía {fields}.', 'Mándame {fields} y seguimos.'],
      concise: ['Envía {fields}.', 'Falta: {fields}.'],
      custom: ['Para continuar, envía {fields}.', 'Envía {fields} para continuar con la reserva.'],
    },
    detailFields: (missing) => missing.includes('name') && missing.includes('phone') ? 'tu nombre y número de móvil' : missing.includes('name') ? 'tu nombre' : missing.includes('phone') ? 'tu número de móvil' : missing.includes('service') ? 'el servicio que quieres reservar' : 'los datos restantes',
    confirmation: {
      professional: ['{facts}', 'Reserva confirmada: {facts}'],
      friendly: ['Todo listo — {facts}', 'Genial, la reserva está hecha. {facts}'],
      warm: ['Todo está preparado. {facts}', 'Tu reserva está lista. {facts}'],
      casual: ['Listo — {facts}', 'Hecho — {facts}'],
      concise: ['{facts}', 'Confirmado: {facts}'],
      custom: ['{facts}', 'Reserva completada: {facts}'],
    },
  },
  de: {
    availabilityFound: {
      professional: ['Folgende Zeiten sind verfügbar: ', 'Aktuell sind diese Zeiten verfügbar: '],
      friendly: ['Ich habe einige passende freie Zeiten gefunden: ', 'Hier sind einige verfügbare Zeiten für Sie: '],
      warm: ['Ich helfe Ihnen gern. Diese Zeiten sind verfügbar: ', 'Diese freien Zeiten habe ich für Sie gefunden: '],
      casual: ['Gerne — hier sind die freien Zeiten: ', 'Das ist aktuell frei: '],
      concise: ['Verfügbar: ', 'Freie Zeiten: '],
      custom: ['Diese Zeiten sind verfügbar: ', 'Aktuell verfügbare Zeiten: '],
    },
    availabilityQuestion: {
      formal: [' Welche Zeit bevorzugen Sie?', ' Bitte wählen Sie die passende Zeit.'],
      balanced: [' Welche passt Ihnen am besten?', ' Welche Zeit passt am besten?'],
      casual: [' Welche passt dir?', ' Welche nehmen wir?'],
    },
    details: {
      professional: ['Zum Abschluss der Buchung senden Sie bitte {fields}.', 'Bitte senden Sie {fields}, um die Buchung abzuschließen.'],
      friendly: ['Prima — ich brauche nur noch {fields}, dann ist die Buchung vollständig.', 'Fast geschafft. Senden Sie {fields}, dann schließe ich die Buchung ab.'],
      warm: ['Sehr gern. Ich brauche nur noch {fields}, um die Buchung abzuschließen.', 'Wenn Sie bereit sind, senden Sie {fields}, dann kümmere ich mich um den Rest.'],
      casual: ['Fast fertig — schick einfach {fields}.', 'Schick mir {fields}, dann machen wir weiter.'],
      concise: ['Senden Sie {fields}.', 'Benötigt: {fields}.'],
      custom: ['Zum Fortfahren senden Sie bitte {fields}.', 'Bitte senden Sie {fields}, damit die Buchung fortgesetzt werden kann.'],
    },
    detailFields: (missing) => missing.includes('name') && missing.includes('phone') ? 'Ihren Namen und Ihre Mobilnummer' : missing.includes('name') ? 'Ihren Namen' : missing.includes('phone') ? 'Ihre Mobilnummer' : missing.includes('service') ? 'die gewünschte Behandlung' : 'die restlichen Angaben',
    confirmation: {
      professional: ['{facts}', 'Buchung bestätigt: {facts}'],
      friendly: ['Alles erledigt — {facts}', 'Prima, alles ist gebucht. {facts}'],
      warm: ['Alles ist vorbereitet. {facts}', 'Ihre Buchung ist vollständig erledigt. {facts}'],
      casual: ['Alles klar — {facts}', 'Erledigt — {facts}'],
      concise: ['{facts}', 'Bestätigt: {facts}'],
      custom: ['{facts}', 'Buchung abgeschlossen: {facts}'],
    },
  },
  fa: {
    availabilityFound: {
      professional: ['زمان‌های زیر خالی هستند: ', 'در حال حاضر این زمان‌ها خالی هستند: '],
      friendly: ['چند زمان مناسب پیدا کردم: ', 'این زمان‌های خالی می‌توانند مناسب باشند: '],
      warm: ['با کمال میل کمکتان می‌کنم. این زمان‌ها خالی هستند: ', 'این زمان‌های خالی را برایتان پیدا کردم: '],
      casual: ['حتماً — این زمان‌ها خالی‌اند: ', 'این زمان‌ها فعلاً خالی‌اند: '],
      concise: ['زمان‌های خالی: ', 'خالی: '],
      custom: ['این زمان‌ها خالی هستند: ', 'زمان‌های خالی فعلی: '],
    },
    availabilityQuestion: {
      formal: [' کدام زمان را ترجیح می‌دهید؟', ' لطفاً زمان مناسب را انتخاب بفرمایید.'],
      balanced: [' کدام برایتان مناسب‌تر است؟', ' کدام زمان مناسب شماست؟'],
      casual: [' کدام به شما می‌خورد؟', ' کدام را انتخاب کنیم؟'],
    },
    details: {
      professional: ['برای تکمیل رزرو، لطفاً {fields} را بفرستید.', 'لطفاً {fields} را برای تکمیل رزرو ارسال کنید.'],
      friendly: ['عالیه — فقط {fields} را لازم دارم تا رزرو کامل شود.', 'تقریباً تمام است. {fields} را بفرستید تا رزرو را کامل کنم.'],
      warm: ['حتماً. فقط {fields} را لازم دارم تا رزرو کامل شود.', 'هر وقت آماده بودید، {fields} را بفرستید تا رزرو را کامل کنم.'],
      casual: ['تقریباً تمامه — فقط {fields} را بفرستید.', '{fields} را بفرستید تا ادامه بدهیم.'],
      concise: ['{fields} را بفرستید.', 'لازم است: {fields}.'],
      custom: ['برای ادامه، لطفاً {fields} را بفرستید.', '{fields} را بفرستید تا رزرو ادامه پیدا کند.'],
    },
    detailFields: (missing) => missing.includes('name') && missing.includes('phone') ? 'نام و شماره موبایل‌تان' : missing.includes('name') ? 'نام‌تان' : missing.includes('phone') ? 'شماره موبایل‌تان' : missing.includes('service') ? 'خدمت موردنظرتان' : 'اطلاعات باقی‌مانده',
    confirmation: {
      professional: ['{facts}', 'رزرو تأیید شد: {facts}'],
      friendly: ['همه‌چیز آماده است — {facts}', 'عالیه، رزرو انجام شد. {facts}'],
      warm: ['همه‌چیز مرتب است. {facts}', 'رزروتان با خیال راحت انجام شد. {facts}'],
      casual: ['انجام شد — {facts}', 'تمام — {facts}'],
      concise: ['{facts}', 'تأیید شد: {facts}'],
      custom: ['{facts}', 'رزرو کامل شد: {facts}'],
    },
  },
  ar: {
    availabilityFound: {
      professional: ['المواعيد التالية متاحة: ', 'المتاح حاليًا يشمل: '],
      friendly: ['وجدت بعض المواعيد المناسبة: ', 'إليك بعض المواعيد المتاحة: '],
      warm: ['يسعدني مساعدتك. هذه المواعيد متاحة: ', 'هذه المواعيد المتاحة التي وجدتها لك: '],
      casual: ['بالتأكيد — هذه المواعيد المتاحة: ', 'هذا هو المتاح حاليًا: '],
      concise: ['المتاح: ', 'مواعيد متاحة: '],
      custom: ['هذه المواعيد متاحة: ', 'المواعيد المتاحة حاليًا: '],
    },
    availabilityQuestion: {
      formal: [' أي موعد تفضل؟', ' يرجى اختيار الموعد الأنسب.'],
      balanced: [' أيها يناسبك أكثر؟', ' أي موعد يناسبك؟'],
      casual: [' أي واحد يناسبك؟', ' أي موعد نختار؟'],
    },
    details: {
      professional: ['لإكمال الحجز، يرجى إرسال {fields}.', 'يرجى إرسال {fields} لإكمال الحجز.'],
      friendly: ['رائع — أحتاج فقط إلى {fields} لإكمال الحجز.', 'أوشكنا على الانتهاء. أرسل {fields} وسأكمل الحجز.'],
      warm: ['بكل سرور. أحتاج فقط إلى {fields} لإكمال الحجز.', 'عندما تكون مستعدًا، أرسل {fields} وسأكمل الحجز.'],
      casual: ['بقي القليل — أرسل فقط {fields}.', 'أرسل {fields} ونكمل.'],
      concise: ['أرسل {fields}.', 'المطلوب: {fields}.'],
      custom: ['للمتابعة، يرجى إرسال {fields}.', 'أرسل {fields} لمتابعة الحجز.'],
    },
    detailFields: (missing) => missing.includes('name') && missing.includes('phone') ? 'اسمك ورقم هاتفك' : missing.includes('name') ? 'اسمك' : missing.includes('phone') ? 'رقم هاتفك' : missing.includes('service') ? 'الخدمة التي تريد حجزها' : 'البيانات المتبقية',
    confirmation: {
      professional: ['{facts}', 'تم تأكيد الحجز: {facts}'],
      friendly: ['تم كل شيء — {facts}', 'رائع، تم الحجز. {facts}'],
      warm: ['كل شيء جاهز. {facts}', 'تم ترتيب حجزك بالكامل. {facts}'],
      casual: ['تم — {facts}', 'انتهينا — {facts}'],
      concise: ['{facts}', 'مؤكد: {facts}'],
      custom: ['{facts}', 'اكتمل الحجز: {facts}'],
    },
  },
};

const emojiPattern = /(?:\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?)*)|(?:[\u{1F1E6}-\u{1F1FF}]{2})/gu;

export function containsEmoji(value: string): boolean {
  emojiPattern.lastIndex = 0;
  return emojiPattern.test(value);
}

function applyEmojiPolicy(value: string, config: BusinessToneConfig): string {
  emojiPattern.lastIndex = 0;
  const withoutEmoji = value.replace(emojiPattern, '').replace(/[\uFE0E\uFE0F\u200D]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (config.emojiUsage === 'none') return withoutEmoji;
  if (config.emojiUsage === 'light') return `${withoutEmoji} 😊`;
  return `${withoutEmoji} 😊✨`;
}

function normalizedLanguage(language: string): BookingPresentationLanguage {
  return BOOKING_PRESENTATION_LANGUAGES.includes(language as BookingPresentationLanguage)
    ? language as BookingPresentationLanguage
    : 'en';
}

function stableVariantIndex(parts: readonly string[], variantCount: number): number {
  let hash = 2166136261;
  for (const char of parts.join('|')) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, variantCount);
}

function selectVariant(
  variants: readonly [string, string],
  messageType: 'availability' | 'details' | 'confirmation',
  language: BookingPresentationLanguage,
  tone: BusinessToneConfig,
  stableFacts: string,
): string {
  return variants[stableVariantIndex([
    messageType,
    language,
    tone.tonePreset,
    tone.responseLength,
    tone.formality,
    stableFacts,
  ], variants.length)];
}

function applyFormality(
  value: string,
  language: BookingPresentationLanguage,
  formality: BusinessToneConfig['formality'],
): string {
  if (formality === 'balanced') return value;
  if (language === 'en') {
    return formality === 'formal'
      ? value.replaceAll('I’d', 'I would').replaceAll('I’m', 'I am').replaceAll('Here’s', 'Here is').replaceAll('We’re', 'We are').replaceAll('You’re', 'You are').replaceAll('we’re', 'we are').replace(/just send/gi, 'please provide').replace(/^Please provide/, 'Kindly provide').replace(/^To complete the booking, please provide/, 'To complete the booking, kindly provide')
      : value.replace(/Please provide/gi, 'Just send').replace(/Please select/gi, 'Pick').replace(/has been confirmed/gi, 'is confirmed');
  }
  if (language === 'es') {
    return formality === 'formal'
      ? value.replaceAll('tu nombre', 'su nombre').replaceAll('tu número', 'su número').replaceAll('tu cita', 'su cita').replaceAll('Tu reserva', 'Su reserva').replaceAll('te ', 'le ').replaceAll('Envíame', 'Envíeme').replaceAll('envíame', 'envíeme').replaceAll('quieres', 'quiere').replaceAll('prefieres', 'prefiere')
      : value.replaceAll('envíe', 'envía').replaceAll('Envíe', 'Envía').replaceAll('le convenga', 'te venga bien').replaceAll('prefiere', 'prefieres');
  }
  if (language === 'de') {
    return formality === 'formal'
      ? value.replaceAll('schick ', 'senden Sie ').replaceAll('Schick ', 'Senden Sie ').replaceAll('dir', 'Ihnen').replaceAll('deinen', 'Ihren').replaceAll('deine', 'Ihre')
      : value.replaceAll('Möchten Sie', 'Möchtest du').replaceAll('Antworten Sie', 'Antworte').replaceAll('Wenn Sie bereit sind', 'Wenn du bereit bist').replaceAll('Wenn Sie', 'Wenn du').replaceAll('für Sie', 'für dich').replaceAll('Bitte wählen Sie', 'Wähl').replaceAll('Senden Sie', 'Schick').replaceAll('senden Sie', 'schick').replaceAll('Ihnen', 'dir').replaceAll('Ihren', 'deinen').replaceAll('Ihre Buchung', 'Deine Buchung').replaceAll('Ihr Termin', 'dein Termin').replaceAll('Ihre', 'deine').replaceAll('Sie?', 'du?');
  }
  if (language === 'sv') {
    if (formality === 'formal') {
      const formal = value.replace('Vilken funkar', 'Vilken tid passar');
      return /vänligen/i.test(formal)
        ? formal
        : formal.replace(/\b[Ss]kicka\b/, 'vänligen skicka');
    }
    return value.replaceAll('Vänligen ', '').replaceAll('vänligen ', '').replace('Vilken tid föredrar du?', 'Vilken funkar för dig?');
  }
  if (language === 'fa') {
    return formality === 'formal'
      ? value.replaceAll(' را بفرستید', ' را ارسال بفرمایید').replaceAll('انتخاب کنیم', 'انتخاب بفرمایید')
      : value.replaceAll('لطفاً ', '').replaceAll('ارسال بفرمایید', 'بفرستید').replaceAll('انتخاب بفرمایید', 'انتخاب کنیم');
  }
  return formality === 'formal'
    ? value.replaceAll('أرسل ', 'يرجى إرسال ').replaceAll('نختار', 'تفضل')
    : value.replaceAll('يرجى إرسال ', 'أرسل ').replaceAll('يرجى اختيار', 'اختر');
}

function finishPresentation(
  body: string,
  detailedTail: string,
  tone: BusinessToneConfig,
  language: BookingPresentationLanguage,
): string {
  const tail = tone.responseLength === 'detailed' && tone.tonePreset !== 'concise' ? detailedTail : '';
  return applyEmojiPolicy(applyFormality(`${body}${tail}`, language, tone.formality), tone);
}

export function renderDeterministicAvailabilityReply(
  language: string,
  facts: AvailabilityFacts,
  toneConfig: unknown,
): string {
  const tone = normalizeBusinessToneConfig(toneConfig);
  const lang = normalizedLanguage(language);
  const localized = presentations[lang].availability;
  const shortest = tone.responseLength === 'short' || tone.tonePreset === 'concise';
  if (shortest) return finishPresentation(localized.short(facts), '', tone, lang);
  if (facts.kind !== 'found') {
    return finishPresentation(localized.balanced(facts), '', tone, lang);
  }
  const lexicon = naturalToneLexicons[lang];
  const stableFacts = JSON.stringify(facts);
  const opening = selectVariant(lexicon.availabilityFound[tone.tonePreset], 'availability', lang, tone, stableFacts);
  const question = selectVariant(lexicon.availabilityQuestion[tone.formality], 'availability', lang, tone, `${stableFacts}:question`);
  return finishPresentation(`${opening}${facts.slots}.${question}`, localized.detailedTail, tone, lang);
}

export function renderDeterministicMissingDetailsReply(
  language: string,
  missing: Array<'name' | 'phone' | 'service'>,
  toneConfig: unknown,
): string {
  const tone = normalizeBusinessToneConfig(toneConfig);
  const lang = normalizedLanguage(language);
  const localized = presentations[lang].details;
  const shortest = tone.responseLength === 'short' || tone.tonePreset === 'concise';
  if (shortest || missing.length === 0) {
    return finishPresentation(shortest ? localized.short({ missing }) : localized.balanced({ missing }), shortest ? '' : localized.detailedTail, tone, lang);
  }
  const lexicon = naturalToneLexicons[lang];
  const stableFacts = JSON.stringify(missing);
  const template = selectVariant(lexicon.details[tone.tonePreset], 'details', lang, tone, stableFacts);
  const body = template.replace('{fields}', lexicon.detailFields(missing));
  return finishPresentation(body, localized.detailedTail, tone, lang);
}

export function renderDeterministicBookingConfirmation(
  language: string,
  facts: ConfirmationFacts,
  toneConfig: unknown,
): string {
  const tone = normalizeBusinessToneConfig(toneConfig);
  const lang = normalizedLanguage(language);
  const localized = presentations[lang].confirmation;
  const shortest = tone.responseLength === 'short' || tone.tonePreset === 'concise';
  if (shortest) return finishPresentation(localized.short(facts), '', tone, lang);
  const stableFacts = JSON.stringify(facts);
  const template = selectVariant(naturalToneLexicons[lang].confirmation[tone.tonePreset], 'confirmation', lang, tone, stableFacts);
  const body = template.replace('{facts}', localized.balanced(facts));
  return finishPresentation(body, localized.detailedTail, tone, lang);
}
