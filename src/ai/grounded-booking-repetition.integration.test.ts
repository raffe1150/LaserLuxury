import assert from 'node:assert/strict';
import type { BookingReplyFacts } from './grounded-booking-composition';
process.env.NODE_ENV = 'test';
const savedConsole = { ...console };
for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = () => undefined;
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const now = new Date('2026-09-01T09:00:00+02:00');
const texts = {
  en: ['I want to book Haircut tomorrow.', 'I want to book Golden video tomorrow.', 'My name is Alex Morgan and my phone number is +46700000001.', 'I want to book Golden video on September 3, 2026.', 'I want to book an appointment.'],
  sv: ['Jag vill boka Haircut imorgon.', 'Jag vill boka Golden video imorgon.', 'Jag heter Alex Morgan och mitt mobilnummer är +46700000001.', 'Jag vill boka Golden video den 3 september 2026.', 'Jag vill boka en tid.'],
  de: ['Ich möchte Haircut morgen buchen.', 'Ich möchte Golden video morgen buchen.', 'Mein Name ist Alex Morgan und meine Telefonnummer ist +46700000001.', 'Ich möchte Golden video am 3. September 2026 buchen.', 'Ich möchte einen Termin buchen.'],
  es: ['Quiero reservar Haircut mañana.', 'Quiero reservar Golden video mañana.', 'Mi nombre es Alex Morgan y mi teléfono es +46700000001.', 'Quiero reservar Golden video el 3 de septiembre de 2026.', 'Quiero reservar una cita.'],
  fa: ['می‌خواهم Haircut برای فردا رزرو کنم.', 'می‌خواهم Golden video برای فردا رزرو کنم.', 'نام من Alex Morgan است و شماره موبایل من +46700000001 است.', 'می‌خواهم Golden video برای 2026-09-03 رزرو کنم.', 'می‌خواهم وقت رزرو کنم.'],
  ar: ['أريد حجز Haircut غدًا.', 'أريد حجز Golden video غدًا.', 'اسمي Alex Morgan ورقم هاتفي +46700000001.', 'أريد حجز Golden video بتاريخ 2026-09-03.', 'أريد حجز موعد.'],
} as const;
const presentation = {
  en: { unsupported: (service: string) => `${service} is not bookable here. Which service would you like to choose: Video Consultation or Golden video?`, none: 'No available slots match the requested period. Please give me another date.', missing: 'Which service would you like to book?', date: 'What date would you like to book?', choose: 'Which time would you like?', again: 'I understand the request. ' },
  sv: { unsupported: (service: string) => `${service} är inte bokningsbar här. Vilken tjänst vill du välja: Video Consultation eller Golden video?`, none: 'Det finns inga lediga tider för den önskade perioden. Ange ett annat datum.', missing: 'Vilken tjänst vill du boka?', date: 'Vilket datum vill du boka?', choose: 'Vilken tid vill du välja?', again: 'Jag förstår önskemålet. ' },
  de: { unsupported: (service: string) => `${service} ist hier nicht buchbar. Welche Leistung möchten Sie wählen: Video Consultation oder Golden video?`, none: 'Es gibt keinen freien Termin im gewünschten Zeitraum. Bitte nennen Sie ein anderes Datum.', missing: 'Welche Leistung möchten Sie buchen?', date: 'Für welches Datum möchten Sie buchen?', choose: 'Welche Zeit möchten Sie wählen?', again: 'Ich verstehe Ihren Wunsch. ' },
  es: { unsupported: (service: string) => `${service} no es un servicio reservable aquí. ¿Qué servicio quieres elegir: Video Consultation o Golden video?`, none: 'No hay horas disponibles para el período solicitado. Dime otra fecha.', missing: '¿Qué servicio quieres reservar?', date: '¿Para qué fecha quieres reservar?', choose: '¿Qué hora quieres elegir?', again: 'Entiendo tu petición. ' },
  fa: { unsupported: (service: string) => `${service} اینجا قابل رزرو نیست. کدام سرویس را می‌خواهید انتخاب کنید: Video Consultation یا Golden video؟`, none: 'برای بازه درخواستی وقت خالی پیدا نکردم. لطفاً تاریخ دیگری بفرستید.', missing: 'کدام سرویس را می‌خواهید رزرو کنید؟', date: 'برای چه تاریخی می‌خواهید رزرو کنید؟', choose: 'کدام زمان را می‌خواهید انتخاب کنید؟', again: 'درخواست شما را متوجه شدم. ' },
  ar: { unsupported: (service: string) => `${service} ليست خدمة قابلة للحجز هنا. أي خدمة تريد اختيارها: Video Consultation أم Golden video؟`, none: 'لم أجد موعدًا متاحًا للفترة المطلوبة. أرسل تاريخًا آخر.', missing: 'أي خدمة تريد حجزها؟', date: 'ما التاريخ الذي تريد الحجز فيه؟', choose: 'أي وقت تريد اختياره؟', again: 'أفهم طلبك. ' },
};
let scenarios = 0;
try {
  for (const channel of ['telegram', 'instagram', 'whatsapp', 'messenger'] as const) for (const language of ['en', 'sv', 'es', 'de', 'fa', 'ar'] as const) {
    b.reset();
    const sessionId = `composition-${channel}-${language}`;
    const recipientUserId = channel === 'whatsapp' ? '46700000001' : sessionId;
    const businessConfig = { id: '7', businessName: 'Test Reception', language, timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-7',
      services: [{ name: 'Video Consultation', duration: 30 }, { name: 'Golden video', duration: 30 }],
      workingHours: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(day => [day, [{ start: '09:00', end: '17:00' }]])),
    };
    let reads = 0; let mutations = 0;
    const requests: Array<{ facts: BookingReplyFacts; memory: any; context: any }> = [];
    const diagnostics: Array<{ kind: string; source: string; repeated: boolean }> = [];
    b.configure({
      calendarAdapter: { getCalendarId: () => 'cal-7', checkSlots: async () => { throw Error('legacy slot path'); },
        getEvents: async () => { reads++; return [{ id: 'blocked', status: 'confirmed', start: { dateTime: '2026-09-02T00:00:00+02:00' }, end: { dateTime: '2026-09-03T00:00:00+02:00' } }]; },
        insertAppointment: async () => { mutations++; throw Error('unexpected booking creation'); },
      } as any,
      postProcess: async () => undefined,
      bookingPresentationDiagnostic: event => diagnostics.push(event),
      bookingPresentationGenerate: async request => {
        const facts: BookingReplyFacts = JSON.parse(request.systemInstruction!.match(/^AUTHORITATIVE_BOOKING_FACTS=(.*)$/m)![1]);
        const memory = JSON.parse(request.systemInstruction!.match(/^PRESENTATION_MEMORY=(.*)$/m)![1]);
        const context = JSON.parse(request.messages[0].content);
        requests.push({ facts, memory, context });
        assert.equal(request.tools, undefined);
        const wording = presentation[language];
        const reply = facts.kind === 'unsupported_service' ? wording.unsupported(facts.requestedService!)
          : facts.kind === 'missing_service' ? wording.missing
          : facts.kind === 'date' ? wording.date
          : facts.kind === 'availability' && !facts.slots?.length ? wording.none
          : facts.kind === 'availability' && facts.slots?.length ? `${facts.slots[0]}. ${wording.choose}` : wording.choose;
        return { text: JSON.stringify({ reply: (memory.repeatedOutcome ? wording.again : '') + reply }), functionCalls: [] };
      },
    });
    const turn = (text: string, overrides: any = {}) => b.turn({ sessionId, platformName: channel, recipientUserId, businessConfig, now, text, ...overrides });
    b.seedFlowLanguage(sessionId, language);
    const first = await turn(texts[language][0]);
    assert.equal(first.pending?.status, 'awaiting_service', `${channel}/${language}: unsupported service`);
    assert.equal(reads, 0);
    assert.equal(diagnostics.at(-1)?.source, 'openai', `${channel}/${language}: composition actually used`);
    const repeat = await turn('Haircut');
    assert.equal(repeat.pending?.status, 'awaiting_service');
    assert.ok(repeat.replies[0].includes('Haircut'), `${channel}/${language}: repeated unsupported label preserved ${JSON.stringify({reply:repeat.replies, pending:repeat.pending, req:requests.at(-1),diagnostic:diagnostics.at(-1)})}`);
    assert.notEqual(repeat.replies[0], first.replies[0]);
    assert.equal(requests.at(-1)?.memory.repeatedOutcome, true, JSON.stringify({ channel, language, first: requests[0], latest: requests.at(-1) }));
    assert.equal(diagnostics.at(-1)?.source, 'openai', `${channel}/${language}: repeat composition accepted`);
    assert.ok(requests.at(-1)?.context.recentConversation.some((message: any) => message.role === 'assistant'));
    const supported = await turn('Video Consultation');
    assert.equal(supported.pending?.service, 'Video Consultation');
    assert.notEqual(supported.pending?.status, 'awaiting_service');
    assert.equal(supported.pending?.language, language);
    scenarios += 2;

    const availabilitySession = `${sessionId}-availability`;
    b.seedFlowLanguage(availabilitySession, language);
    const availabilityTurn = (text: string) => turn(text, { sessionId: availabilitySession });
    const none = await availabilityTurn(texts[language][1]);
    assert.equal(none.pending?.service, 'Golden video');
    assert.equal(none.pending?.selectedDate, '2026-09-02');
    assert.deepEqual(none.pending?.offeredSlots, []);
    assert.equal(diagnostics.at(-1)?.source, 'openai', `${channel}/${language}: no availability composed`);
    const readsBefore = reads;
    const again = await availabilityTurn(texts[language][1]);
    assert.deepEqual(again.pending?.offeredSlots, []);
    assert.equal(again.pending?.selectedDate, '2026-09-02');
    assert.notEqual(again.replies[0], none.replies[0]);
    assert.equal(requests.at(-1)?.memory.repeatedOutcome, true, `${channel}/${language}: factual search outcome shared across formatter branches`);
    assert.ok(reads >= readsBefore, 'only deterministic calendar reads decide availability');
    const flexibleTexts = { en: 'Any available time tomorrow?', sv: 'Finns det någon ledig tid imorgon?', de: 'Gibt es morgen irgendeinen freien Termin?', es: '¿Hay alguna hora disponible mañana?', fa: 'برای فردا هر زمان خالی دارید؟', ar: 'هل يوجد أي وقت متاح غدًا؟' };
    const flexible = await availabilityTurn(flexibleTexts[language]);
    assert.equal(flexible.pending?.selectedDate, '2026-09-02', `${channel}/${language}: flexible time keeps the date`);
    assert.deepEqual(flexible.pending?.offeredSlots, []);
    assert.equal(flexible.pending?.language, language);
    assert.equal(mutations, 0);
    scenarios++;
    const contact = await availabilityTurn(texts[language][2]);
    assert.deepEqual(contact.pending?.offeredSlots, []);
    assert.equal(contact.pending?.selectedDate, '2026-09-02');
    assert.equal(contact.pending?.language, language);
    assert.equal(mutations, 0, 'contact cannot authorize a nonexistent slot');
    const changed = await availabilityTurn(texts[language][3]);
    assert.equal(changed.pending?.selectedDate, '2026-09-03', `${channel}/${language}: latest date wins`);
    assert.ok(changed.pending?.ownedOfferedSlots?.length > 0);
    assert.equal(changed.pending?.dateTime, null);
    assert.equal(changed.pending?.language, language);
    assert.equal(requests.at(-1)?.memory.repeatedOutcome, false);
    assert.equal(diagnostics.at(-1)?.source, 'openai', `${channel}/${language}: changed date slots composed`);
    scenarios += 3;

    const missingSession = `${sessionId}-missing`;
    b.seedFlowLanguage(missingSession, language);
    const missing = await turn(texts[language][4], { sessionId: missingSession });
    assert.equal(missing.pending?.status, 'awaiting_service', `${channel}/${language}: missing service`);
    const named = await turn('Haircut', { sessionId: missingSession });
    assert.equal(named.pending?.status, 'awaiting_service');
    assert.ok(named.replies[0].includes('Haircut'));
    assert.equal(diagnostics.at(-1)?.kind, 'unsupported_service');
    assert.equal(named.pending?.language, language);
    assert.equal(mutations, 0);
    scenarios++;
    const otherUnsupported = await turn('Acupuncture', { sessionId: missingSession });
    assert.equal(otherUnsupported.pending?.requestedService, 'Acupuncture');
    assert.ok(otherUnsupported.replies[0].includes('Acupuncture'));
    assert.equal(otherUnsupported.pending?.status, 'awaiting_service');
    assert.equal(otherUnsupported.pending?.language, language);
    assert.equal(mutations, 0);
    scenarios++;
  }
  // A failed delivery is not a previously explained outcome. Scope isolation
  // includes tenant/channel/recipient, even when session IDs happen to match.
  b.reset();
  const memories: boolean[] = [];
  b.configure({ postProcess: async () => undefined, bookingPresentationGenerate: async request => {
    memories.push(JSON.parse(request.systemInstruction!.match(/^PRESENTATION_MEMORY=(.*)$/m)![1]).repeatedOutcome);
    return { text: JSON.stringify({ reply: presentation.en.unsupported('Haircut') }), functionCalls: [] };
  } });
  const config = { id: '7', services: [{ name: 'Video Consultation', duration: 30 }, { name: 'Golden video', duration: 30 }] };
  const params = { sessionId: 'undelivered', platformName: 'messenger' as const, recipientUserId: 'customer', businessConfig: config, text: texts.en[0], now };
  await b.turn({ ...params, sendResult: false });
  await b.turn(params);
  assert.deepEqual(memories, [false, false]); scenarios++;
  // A residual AI tool can suggest an arbitrary service label. Its availability
  // result must not turn that label into a verified catalog fact.
  for (const platformName of ['telegram', 'instagram', 'whatsapp', 'messenger']) {
    const reply = await b.composeAdapterBookingReply({ sessionId: `adapter-${platformName}`, platformName, recipientUserId: 'customer', businessConfig: config,
      history: [], text: 'Haircut', service: 'Haircut', slots: ['Wednesday 09:00 (ISO: 2026-09-02T07:00:00.000Z)'], language: 'en' });
    assert.ok(reply.includes('Haircut'));
    assert.match(reply, /not bookable/);
    assert.doesNotMatch(reply, /09:00/);
    scenarios++;
  }
  savedConsole.log(`Grounded booking repetition: ${scenarios} state/conversation scenarios passed across four channels and six languages`);
} finally { b.reset(); Object.assign(console, savedConsole); }
