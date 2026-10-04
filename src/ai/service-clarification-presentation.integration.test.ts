import assert from 'node:assert/strict';
import { composeGroundedBookingReply, recordDeliveredBookingPresentation, resetBookingPresentationMemory, validateGroundedBookingReply, validateGroundedBookingReplyDetailed, runBookingPresentationScope, registerBookingPresentation, getBookingPresentationFacts, type BookingReplyFacts, type BookingValidationReason } from './grounded-booking-composition';
process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

const replies = {
  en: ['Haircut is not a bookable service here. Would you like to choose Video Consultation or Golden video?', 'No available slots match the requested period. Please give me another date.'],
  sv: ['Haircut är inte en bokningsbar tjänst här. Vilken tjänst vill du välja: Video Consultation eller Golden video?', 'Det finns inga lediga tider för den önskade perioden. Ange ett annat datum.'],
  es: ['Haircut no es un servicio reservable aquí. ¿Qué servicio quieres elegir: Video Consultation o Golden video?', 'No hay horas disponibles para el período solicitado. Dime otra fecha.'],
  de: ['Haircut ist hier nicht buchbar. Welche Leistung möchten Sie wählen: Video Consultation oder Golden video?', 'Es gibt keinen freien Termin im gewünschten Zeitraum. Bitte nennen Sie ein anderes Datum.'],
  fa: ['Haircut اینجا قابل رزرو نیست. کدام سرویس را می‌خواهید انتخاب کنید: Video Consultation یا Golden video؟', 'برای بازه درخواستی وقت خالی پیدا نکردم. لطفاً تاریخ دیگری بفرستید.'],
  ar: ['Haircut ليست خدمة قابلة للحجز هنا. أي خدمة تريد اختيارها: Video Consultation أم Golden video؟', 'لم أجد موعدًا متاحًا للفترة المطلوبة. أرسل تاريخًا آخر.'],
};
const response = (reply: string) => ({ text: JSON.stringify({ reply }), functionCalls: [] });
const unsupportedMentions = {
  en: { acknowledgement: "I understand you're still looking for a Haircut.", available: 'Haircut is available.', bookable: 'I can book Haircut.', offered: 'We offer Haircut.', choice: 'Which service would you like to choose?' },
  sv: { acknowledgement: 'Jag förstår att du fortfarande vill ha Haircut.', available: 'Haircut är tillgänglig.', bookable: 'Vi kan boka Haircut.', offered: 'Vi erbjuder Haircut.', choice: 'Vilken tjänst vill du välja?' },
  de: { acknowledgement: 'Ich verstehe, dass Sie weiterhin Haircut möchten.', available: 'Haircut ist verfügbar.', bookable: 'Wir können Haircut buchen.', offered: 'Wir bieten Haircut an.', choice: 'Welche Leistung möchten Sie wählen?' },
  es: { acknowledgement: 'Entiendo que sigues buscando Haircut.', available: 'Haircut está disponible.', bookable: 'Puedo reservar Haircut.', offered: 'Ofrecemos Haircut.', choice: '¿Qué servicio quieres elegir?' },
  fa: { acknowledgement: 'می‌دانم که هنوز Haircut می‌خواهید.', available: 'Haircut قابل رزرو است.', bookable: 'می‌توانم Haircut رزرو کنم.', offered: 'ما Haircut ارائه می‌دهیم.', choice: 'کدام سرویس را می‌خواهید انتخاب کنید؟' },
  ar: { acknowledgement: 'أفهم طلبك المتكرر بشأن Haircut.', available: 'Haircut متاح للحجز.', bookable: 'يمكنني حجز Haircut.', offered: 'نقدم Haircut.', choice: 'أي خدمة تريد اختيارها؟' },
};
const negativeCatalogMembership = {
  en: 'Haircut is not one of our services.', sv: 'Haircut är inte en av våra tjänster.', de: 'Haircut ist keine unserer Leistungen.',
  es: 'Haircut no es uno de nuestros servicios.', fa: 'Haircut جزو خدمات ما نیست.', ar: 'Haircut ليست من خدماتنا.',
};
const unrelatedServiceNegations = {
  en: ["I'm not ignoring your Haircut booking request.", "I don't want to misunderstand your Haircut service request.", "I'm not confused about whether Haircut is available."],
  sv: ['Jag ignorerar inte din Haircut bokningsförfrågan.', 'Jag vill inte missförstå din förfrågan om tjänsten Haircut.'],
  de: ['Ich ignoriere Ihre Haircut Buchungsanfrage nicht.', 'Ich möchte Ihre Anfrage zur Leistung Haircut nicht missverstehen.'],
  es: ['No estoy ignorando tu solicitud de reserva de Haircut.', 'No quiero malinterpretar tu solicitud del servicio Haircut.'],
  fa: ['درخواست رزرو Haircut شما را نادیده نمی‌گیرم.', 'نمی‌خواهم درخواست سرویس Haircut شما را اشتباه بفهمم.'],
  ar: ['لا أتجاهل طلب حجز Haircut.', 'لا أريد أن أسيء فهم طلب خدمة Haircut.'],
};
const negativeServiceOffering = {
  en: ['We do not offer Haircut.', "We don't provide Haircut."],
  sv: ['Vi erbjuder inte Haircut.', 'Vi tillhandahåller inte Haircut.'],
  de: ['Haircut wird nicht angeboten.', 'Wir können Haircut nicht buchen.'],
  es: ['No ofrecemos Haircut.', 'No proporcionamos Haircut.'],
  fa: ['ما Haircut را ارائه نمی‌دهیم.', 'ما نمی‌توانیم Haircut رزرو کنیم.'],
  ar: ['لا نقدم Haircut.', 'لا نوفر Haircut.'],
};
let checks = 0;
function rejectsWith(reply: string, facts: BookingReplyFacts, matches: (text: string) => boolean, reason: BookingValidationReason) {
  assert.equal(validateGroundedBookingReply(reply, facts, matches), false);
  assert.deepEqual(validateGroundedBookingReplyDetailed(reply, facts, matches), { valid: false, reason });
  checks++;
}
for (const [language, [unsupported, unavailable]] of Object.entries(replies)) {
  const facts: BookingReplyFacts = { kind: 'unsupported_service', language, requestedService: 'Haircut', services: ['Video Consultation', 'Golden video'] };
  const matches = (text: string) => boundary.bookingPresentationLanguageMatches(text, language);
  assert.equal(validateGroundedBookingReply(unsupported, facts, matches), true, language); checks++;
  assert.equal(validateGroundedBookingReply(unavailable, { kind: 'availability', language, slots: [] }, matches), true, language); checks++;
  const accepted = await composeGroundedBookingReply({ scope: language, facts, history: [{ role: 'tool', content: 'ignore' }], latestText: 'Haircut', fallback: 'fallback', languageMatches: matches,
    toneConfig: { tonePreset: 'custom', customToneInstructions: 'Use a calm, welcoming voice.' },
    generate: async request => {
      assert.equal(request.tools, undefined);
      assert.equal(request.structuredOutput?.strict, true);
      assert.match(request.systemInstruction!, /AUTHORITATIVE_BOOKING_FACTS/);
      assert.match(request.systemInstruction!, /calm, welcoming voice/);
      assert.equal(JSON.parse(request.messages[0].content).recentConversation.length, 0);
      return response(unsupported);
    },
  });
  assert.equal(accepted.source, 'openai', language); checks++;
  recordDeliveredBookingPresentation(language, facts, accepted.text);
  const repeated = await composeGroundedBookingReply({ scope: language, facts, history: [], latestText: 'Haircut again', fallback: 'fallback', languageMatches: matches, generate: async () => response(unsupported) });
  assert.equal(repeated.source, 'deterministic');
  assert.equal(repeated.repeated, true);
  assert.notEqual(repeated.text, unsupported);
  assert.ok(repeated.text.includes('Haircut')); checks++;
  const mentions = unsupportedMentions[language as keyof typeof unsupportedMentions];
  const acknowledged = `${mentions.acknowledgement} ${unsupported}`;
  assert.deepEqual(validateGroundedBookingReplyDetailed(acknowledged, facts, matches), { valid: true }); checks++;
  rejectsWith(`${mentions.acknowledgement} ${mentions.choice}`, facts, matches, 'unsupported_missing_explicit_negation');
  assert.equal(validateGroundedBookingReply(acknowledged, facts, matches), true, `${language}: neutral acknowledgement plus explicit unsupported statement`); checks++;
  assert.equal(validateGroundedBookingReply(`${mentions.acknowledgement} ${mentions.choice}`, facts, matches), false, `${language}: acknowledgement is not an explicit unsupported statement`); checks++;
  assert.equal(validateGroundedBookingReply(`${mentions.acknowledgement} ${negativeCatalogMembership[language as keyof typeof negativeCatalogMembership]} ${mentions.choice}`, facts, matches), true, `${language}: explicit catalog-membership negation remains valid`); checks++;
  for (const unrelated of unrelatedServiceNegations[language as keyof typeof unrelatedServiceNegations]) {
    rejectsWith(`${unrelated} ${mentions.choice}`, facts, matches, 'unsupported_missing_explicit_negation');
    rejectsWith(`${unsupported} ${unrelated}`, facts, matches, 'unsupported_non_neutral_extra_mention');
    assert.equal(validateGroundedBookingReply(`${unrelated} ${mentions.choice}`, facts, matches), false, `${language}: negation of an acknowledgement/request cannot establish unsupported service`); checks++;
  }
  for (const negative of negativeServiceOffering[language as keyof typeof negativeServiceOffering]) {
    assert.equal(validateGroundedBookingReply(`${mentions.acknowledgement} ${negative} ${mentions.choice}`, facts, matches), true, `${language}: actual negative service offering remains valid`); checks++;
    for (const positive of [mentions.available, mentions.bookable, mentions.offered]) {
      assert.equal(validateGroundedBookingReply(`${negative} ${positive} ${mentions.choice}`, facts, matches), false, `${language}: negative offering cannot authorize a contradictory claim`); checks++;
    }
  }
  for (const positive of [mentions.available, mentions.bookable, mentions.offered]) {
    rejectsWith(`${positive} ${mentions.choice}`, facts, matches, 'unsupported_missing_explicit_negation');
    rejectsWith(`${acknowledged} ${positive}`, facts, matches, 'unsupported_non_neutral_extra_mention');
    assert.equal(validateGroundedBookingReply(`${positive} ${mentions.choice}`, facts, matches), false, `${language}: unsupported positive claim`); checks++;
    assert.equal(validateGroundedBookingReply(`${acknowledged} ${positive}`, facts, matches), false, `${language}: a negative statement cannot excuse a contradictory claim`); checks++;
  }
  assert.equal(validateGroundedBookingReply(`${acknowledged} ${mentions.available.replace('Haircut', 'Acupuncture')}`, facts, matches), false, `${language}: unknown-service guard remains active`); checks++;
  const naturalRepeat = await composeGroundedBookingReply({ scope: language, facts,
    history: [{ role: 'user', content: 'Haircut' }, { role: 'assistant', content: accepted.text }], latestText: 'Haircut',
    fallback: 'fallback', languageMatches: matches, generate: async request => {
      assert.equal(JSON.parse(request.systemInstruction!.match(/^PRESENTATION_MEMORY=(.*)$/m)![1]).repeatedOutcome, true);
      return response(acknowledged);
    },
  });
  assert.equal(naturalRepeat.source, 'openai', `${language}: grounded natural repetition must not fall back`);
  assert.equal(naturalRepeat.repeated, true);
  assert.equal(naturalRepeat.fallbackReason, undefined);
  assert.equal(Object.hasOwn(naturalRepeat, 'validationReason'), false);
  assert.equal(naturalRepeat.text, acknowledged);
  assert.notEqual(naturalRepeat.text, accepted.text); checks++;
  const rejectedRepeat = await composeGroundedBookingReply({ scope: language, facts, history: [], latestText: 'Haircut',
    fallback: 'fallback', languageMatches: matches, generate: async () => response(`${acknowledged} ${mentions.bookable}`),
  });
  assert.equal(rejectedRepeat.source, 'deterministic');
  assert.equal(rejectedRepeat.repeated, true);
  assert.equal(rejectedRepeat.fallbackReason, 'grounding_or_language_rejected');
  assert.equal(rejectedRepeat.validationReason, 'unsupported_non_neutral_extra_mention');
  assert.equal(rejectedRepeat.text, repeated.text, 'diagnostic metadata must not change repeat fallback wording'); checks++;
}
const en = (text: string) => boundary.bookingPresentationLanguageMatches(text, 'en');
const unavailableFacts: BookingReplyFacts = { kind: 'availability', language: 'en', slots: [], constraint: { startDate: '2026-09-02', endDate: '2026-09-02' } };
const unsupportedFacts: BookingReplyFacts = { kind: 'unsupported_service', language: 'en', requestedService: 'Haircut', services: ['Video Consultation'] };
assert.equal(validateGroundedBookingReply("I'm not ignoring your request for Haircut. Which service would you like?", unsupportedFacts, en), false, 'unrelated negation is not an unsupported-service fact'); checks++;
assert.equal(validateGroundedBookingReply('أفهم أنك لا تزال تريد Haircut. أي خدمة تريد اختيارها؟', { ...unsupportedFacts, language: 'ar' }, text => boundary.bookingPresentationLanguageMatches(text, 'ar')), false, 'Arabic still-want acknowledgement is not an unsupported-service negation'); checks++;
assert.equal(validateGroundedBookingReply('أفهم أنك لا تزال تريد خدمة Haircut. أي خدمة تريد اختيارها؟', { ...unsupportedFacts, language: 'ar' }, text => boundary.bookingPresentationLanguageMatches(text, 'ar')), false, 'Arabic service request with still-want wording also needs an unsupported-service statement'); checks++;
for (const candidate of [
  'No slots are available. Your appointment is confirmed. Please give me another date.',
  'No slots are available. There is a free slot at 15:00. Please give me another date.',
  'No slots are available, but there is an available slot. Please give me another date.',
  'No slots are available. We are fully booked. Please give me another date.',
  'No slots are available. We are closed. Please give me another date.',
  'No slots are available. The price is 300 SEK. Please give me another date.',
  'No slots are available. Cancellation is free of charge. Please give me another date.',
  'No slots are available on 2026-09-03. Please give me another date.',
  'No slots are available tomorrow. Please give me another date.',
  'We offer massage. Please give me another date.',
  'Please give me another date.',
  'No slots are available.',
]) { assert.equal(validateGroundedBookingReply(candidate, unavailableFacts, en), false, candidate); checks++; }
for (const candidate of [
  'Haircut is bookable. Which service would you like?',
  'Haircut is bookable. Choose another service if you prefer.',
  'Haircut is not bookable. Haircut is available. Which service would you like?',
  'Haircut is not bookable, but I can book Haircut. Which service would you like?',
  'Haircut is not bookable and it is available. Which service would you like?',
  'Haircut is not bookable. We offer Acupuncture. Which service would you like?',
  'Haircut is not bookable. We have acupuncture. Which service would you like?',
  'Haircut is not bookable. Acupuncture is available. Which service would you like?',
  'Haircut is not bookable. You can choose Acupuncture. Which service would you like?',
  'Haircut is not bookable. Your appointment is booked. Which service would you like?',
  'Which service would you like?',
  'Haircut is not bookable.',
]) { assert.equal(validateGroundedBookingReply(candidate, unsupportedFacts, en), false, candidate); checks++; }
// Codes report the first failing rule; other simultaneous failures are not evaluated.
rejectsWith('Haircut is available.', unsupportedFacts, en, 'required_next_action_missing');
rejectsWith(replies.sv[0], unsupportedFacts, en, 'language_mismatch');
rejectsWith('Haircut is not bookable. The price is 300 SEK. Which service would you like?', unsupportedFacts, en, 'policy_or_price');
rejectsWith('Haircut is not bookable. Your booking is cancelled. Which service would you like?', unsupportedFacts, en, 'mutation_claim');
rejectsWith('Haircut is not bookable tomorrow. Which service would you like?', unsupportedFacts, en, 'relative_date');
rejectsWith('Haircut is not bookable. Please call 987654321. Which service would you like?', unsupportedFacts, en, 'unknown_number');
rejectsWith('Haircut is not bookable. Your appointment is confirmed. Which service would you like?', unsupportedFacts, en, 'unverified_success');
rejectsWith('No slots are available, but there is an available slot. Please give me another date.', unavailableFacts, en, 'availability_grounding');
rejectsWith('Haircut is not bookable. You can choose Acupuncture. Which service would you like?', unsupportedFacts, en, 'unknown_catalog_or_entity_claim');
rejectsWith('', unsupportedFacts, en, 'other_grounding_rejection');
let languageCalls = 0;
rejectsWith('Haircut is not bookable. The price is 300 SEK. Which service would you like?', unsupportedFacts, () => { languageCalls++; return false; }, 'language_mismatch');
assert.equal(languageCalls, 2, 'each validator invocation calls the language callback once and stops at its rejection'); checks++;
const base = { scope: 'failure', facts: unavailableFacts, history: [], latestText: 'book it', fallback: 'No slots are available. Another date?', languageMatches: en };
for (const generate of [
  async () => { throw Error('provider failure'); },
  async () => ({ text: 'invalid JSON', functionCalls: [] }),
  async () => ({ text: JSON.stringify({ reply: 'No slots are available. Another date?', state: 'confirmed' }), functionCalls: [] }),
  async () => ({ ...response('No slots are available. Another date?'), functionCalls: [{ id: 'bad', function: { name: 'insertAppointment', arguments: '{}' } }] }),
]) { assert.equal((await composeGroundedBookingReply({ ...base, generate })).source, 'deterministic'); checks++; }
let aborted = false;
const timed = await composeGroundedBookingReply({ ...base, timeoutMs: 15, generate: async request => new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); })) });
assert.equal(timed.source, 'deterministic'); assert.equal(aborted, true); checks++;
const contact: BookingReplyFacts = { kind: 'missing_contact', language: 'en', missing: ['name', 'phone'] };
assert.equal(validateGroundedBookingReply('Please send your name.', contact, en), false); checks++;
assert.equal(validateGroundedBookingReply('Please send your name and phone number.', contact, en), true); checks++;
assert.equal(validateGroundedBookingReply('Your name and phone number are saved.', contact, en), false); checks++;
const ambiguous: BookingReplyFacts = { kind: 'ambiguous_service', language: 'en', services: ['Golden video', 'Video Consultation'] };
assert.equal(validateGroundedBookingReply('Which service would you like: Golden video?', ambiguous, en), false); checks++;
const slots: BookingReplyFacts = { kind: 'availability', language: 'en', slots: ['2026-09-02 09:00', '2026-09-02 10:30'] };
assert.equal(validateGroundedBookingReply('Available: 2026-09-02 09:00. Which time would you like?', slots, en), true); checks++;
assert.equal(validateGroundedBookingReply('Available: 2026-09-02 09:30. Which time would you like?', slots, en), false); checks++;
rejectsWith('Available: 2026-09-02 09:30. Which time would you like?', slots, en, 'slot_or_datetime_grounding');
assert.equal(validateGroundedBookingReply('Available: 2026-09-02 09:00 and 2026-09-03 09:00. Which time would you like?', { ...slots, slots: ['2026-09-02 09:00', '2026-09-03 10:30'] }, en), false); checks++;
for (const separator of [' at ', ', ', ' — ']) {
  assert.equal(validateGroundedBookingReply(`Available: 2026-09-02 09:00. Another slot is available on 2026-09-03${separator}09:00. Which time would you like?`, { ...slots, slots: ['2026-09-02 09:00', '2026-09-03 10:30'] }, en), false); checks++;
}
const confirmation: BookingReplyFacts = { kind: 'confirmed', language: 'en', verified: true, service: 'Golden video', name: 'Alex', phone: '+46700000000', dateLabel: '2 September 2026', timeLabel: '09:00' };
const confirmed = 'Your booking is confirmed: Golden video, 2 September 2026 at 09:00, Alex, +46700000000.';
assert.equal(validateGroundedBookingReply(confirmed, confirmation, en), true); checks++;
assert.equal(validateGroundedBookingReply(confirmed, { ...confirmation, verified: false }, en), false); checks++;
assert.equal(validateGroundedBookingReply(confirmed.replace('09:00', '10:00'), confirmation, en), false); checks++;
assert.equal(validateGroundedBookingReply(replies.sv[1], unavailableFacts, en), false); checks++;
assert.equal(validateGroundedBookingReply(confirmed.replace('is confirmed', 'is not confirmed'), confirmation, en), false); checks++;
assert.equal(validateGroundedBookingReply('No slots are available all day. Please give me another date.', { ...unavailableFacts, requestedTime: '09:00', constraint: { kind: 'exact_time' } }, en), false); checks++;
assert.equal(validateGroundedBookingReply('Which service and date would you like for a new booking?', { kind: 'service_date', language: 'en' }, en), true); checks++;
assert.equal(validateGroundedBookingReply('Which service would you like?', { kind: 'service_date', language: 'en' }, en), false); checks++;
assert.equal(validateGroundedBookingReply('A slot is available. Would you like to book it?', { kind: 'confirm_slot', language: 'en' }, en), false); checks++;
recordDeliveredBookingPresentation('tenant-a/telegram/customer', unsupportedFacts, replies.en[0]);
for (const scope of ['tenant-b/telegram/customer', 'tenant-a/instagram/customer', 'tenant-a/telegram/other']) {
  const isolated = await composeGroundedBookingReply({ scope, facts: unsupportedFacts, history: [], latestText: 'Haircut', fallback: 'fallback', languageMatches: en });
  assert.equal(isolated.repeated, false); checks++;
}
const scopes = await Promise.all(['Haircut', 'Massage'].map(requestedService => runBookingPresentationScope(async () => {
  registerBookingPresentation('same fallback', { ...unsupportedFacts, requestedService });
  await Promise.resolve();
  return getBookingPresentationFacts('same fallback')?.requestedService;
})));
assert.deepEqual(scopes, ['Haircut', 'Massage'], 'parallel turns cannot exchange formatter facts'); checks++;
// Exercise the Messenger diagnostic path and the exact production log allowlist.
boundary.reset();
const diagnostics: Array<Record<string, unknown>> = [];
const loggedDiagnostics: Array<Record<string, unknown>> = [];
const savedInfo = console.info;
let generationCount = 0;
console.info = (...args: any[]) => { if (args[0] === '[BookingPresentation]') loggedDiagnostics.push(args[1]); };
try {
  boundary.configure({
    postProcess: async () => undefined,
    bookingPresentationDiagnostic: event => diagnostics.push(event),
    bookingPresentationGenerate: async () => response(++generationCount === 1 ? replies.en[0] : `${replies.en[0]} I can book Haircut.`),
  });
  const turn = (text: string) => boundary.turn({ sessionId: 'validation-diagnostics-messenger', platformName: 'messenger',
    recipientUserId: 'private-recipient', now: new Date('2026-09-01T09:00:00+02:00'), text,
    businessConfig: { id: '7', language: 'en', timezone: 'Europe/Stockholm', services: [{ name: 'Video Consultation', duration: 30 }, { name: 'Golden video', duration: 30 }] },
  });
  const first = await turn('I want to book Haircut.');
  const second = await turn('Haircut');
  assert.equal(first.pending?.status, 'awaiting_service');
  assert.equal(second.pending?.status, 'awaiting_service');
  assert.equal(diagnostics[0].source, 'openai');
  assert.equal(Object.hasOwn(diagnostics[0], 'validationReason'), false);
  assert.deepEqual(diagnostics[1], { kind: 'unsupported_service', source: 'deterministic', repeated: true,
    fallbackReason: 'grounding_or_language_rejected', validationReason: 'unsupported_non_neutral_extra_mention' });
  assert.deepEqual(loggedDiagnostics, diagnostics.map(event => ({ ...event, channel: 'messenger' })));
  assert.deepEqual(Object.keys(loggedDiagnostics[1]).sort(), ['channel', 'fallbackReason', 'kind', 'repeated', 'source', 'validationReason']);
  assert.doesNotMatch(JSON.stringify(loggedDiagnostics), /Haircut|private-recipient|Video Consultation|Golden video/);
  checks++;
} finally { console.info = savedInfo; resetBookingPresentationMemory(); boundary.reset(); }
console.log(`Grounded booking composition: ${checks} semantic/grounding checks passed (six languages)`);
