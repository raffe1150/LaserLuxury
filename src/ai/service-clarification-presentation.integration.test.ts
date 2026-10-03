import assert from 'node:assert/strict';
import { composeGroundedBookingReply, recordDeliveredBookingPresentation, resetBookingPresentationMemory, validateGroundedBookingReply, runBookingPresentationScope, registerBookingPresentation, getBookingPresentationFacts, type BookingReplyFacts } from './grounded-booking-composition';
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
let checks = 0;
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
}
const en = (text: string) => boundary.bookingPresentationLanguageMatches(text, 'en');
const unavailableFacts: BookingReplyFacts = { kind: 'availability', language: 'en', slots: [], constraint: { startDate: '2026-09-02', endDate: '2026-09-02' } };
const unsupportedFacts: BookingReplyFacts = { kind: 'unsupported_service', language: 'en', requestedService: 'Haircut', services: ['Video Consultation'] };
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
resetBookingPresentationMemory(); boundary.reset();
console.log(`Grounded booking composition: ${checks} semantic/grounding checks passed (six languages)`);
