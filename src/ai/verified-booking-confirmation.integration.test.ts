import assert from 'node:assert/strict';
import test from 'node:test';
import { composeGroundedBookingReply, validateGroundedBookingReply, type BookingReplyFacts } from './grounded-booking-composition';
import { renderDeterministicBookingConfirmation } from './deterministic-booking-presentation';
import { TONE_PRESETS, RESPONSE_LENGTHS } from './tone-controls';
import { PendingLeadStore } from '../../tests/helpers/pending-lead-store';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');
const now = new Date('2027-10-04T10:00:00Z');
const platforms = ['telegram', 'whatsapp', 'instagram', 'messenger'] as const;
const wording = {
  en: { initial: 'I want to book an appointment', date: 'tomorrow', confirm: 'Yes, please book it.', marker: /available|Which one|times/iu },
  sv: { initial: 'Jag vill boka en tid', date: 'imorgon', confirm: 'Ja tack, boka den.', marker: /ledig|tider|passar/iu },
  de: { initial: 'Ich möchte einen Termin buchen', date: 'morgen', confirm: 'Ja, bitte buchen Sie diese Zeit.', marker: /verfügbar|Zeit|Termin/iu },
  es: { initial: 'Quiero reservar una cita', date: 'mañana', confirm: 'Sí, por favor reserva esa hora.', marker: /hora|libre|reserv/iu },
  fa: { initial: 'سلام، می‌خواهم وقت رزرو کنم', date: 'فردا', confirm: 'بله، لطفاً همان ساعت را رزرو کنید.', marker: /وقت|زمان|رزرو|خالی/u },
  ar: { initial: 'أريد حجز موعد', date: 'غدًا', confirm: 'نعم، احجز ذلك الموعد من فضلك.', marker: /وقت|موعد|متاح|مواعيد/u },
} as const;
type Language = keyof typeof wording;
type Platform = typeof platforms[number];

function fixture(t: any, language: Language = 'en', platform: Platform = 'telegram', extra: any = {}) {
  b.reset();
  t.after(() => b.reset());
  for (const key of ['log', 'info', 'error', 'warn'] as const) t.mock.method(console, key, () => undefined);
  const store = new PendingLeadStore();
  const events = new Map<string, any>();
  const writes = { calendar: 0, database: 0, reads: 0, scans: 0 };
  const config = {
    id: '7', businessRecordId: '7', business_id: '7', businessName: 'Confirmation Clinic',
    language, timezone: 'Europe/Stockholm', calendarProvider: 'custom', googleCalendarId: 'cal-7',
    services: [{ id: 'video', name: 'Video Consultation', duration: 30 }, { id: 'premium', name: 'Premium Consultation', duration: 60 }],
    workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      .map(day => [day, [{ start: '09:00', end: '20:00' }]])),
    ...extra.businessConfig,
  };
  const userId = platform === 'whatsapp' ? '46700000001' : `final-confirmation-${platform}-${language}`;
  const sessionId = platform === 'telegram' ? userId : b.channelSessionId(platform, userId, config, 'confirmation-test');
  let saved: { name: string; phone: string; service: string; start: string } | undefined;
  const dependencies = {
    supabaseClient: store as any,
    semanticLanguageResolver: async () => null,
    availabilityDiagnostic: () => { writes.scans++; },
    calendarAdapter: {
      getCalendarId: () => 'cal-7',
      getEvents: async () => { writes.reads++; return [...events.values()]; },
      checkSlots: () => { assert.fail('legacy availability must not run'); },
      insertAppointment: async (name: string, phone: string, service: string, start: string, duration: number, marker: string) => {
        writes.calendar++;
        saved = { name, phone, service, start };
        const event = { id: `event-${writes.calendar}`, status: 'confirmed', summary: `${name} - ${phone}`,
          start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(new Date(start).getTime() + duration * 60_000).toISOString() },
          description: `BusinessId: 7\nPlatform: ${platform}\nUserId: ${marker}`,
          extendedProperties: { private: { businessId: '7', platform, userId: marker } } };
        events.set(event.id, event);
        return { success: true, event };
      },
      getEventById: async (id: string) => events.get(id) || null,
      cancelAppointment: async (id: string) => { events.delete(id); return { success: true }; },
      verifyEventDeleted: async (id: string) => !events.has(id),
    },
    postProcess: async () => undefined,
    incrementUsage: async () => ({ allowed: true, count: 1, limit: 100 }),
    notifyBooking: async () => true,
    validateAppointment: async (appointment: any) => appointment,
    recordAppointment: async (params: any) => ({ id: ++writes.database, business_id: '7', platform, user_id: userId,
      service: params.service, start_time: new Date(params.dateTime).toISOString(),
      end_time: new Date(new Date(params.dateTime).getTime() + params.durationMinutes * 60_000).toISOString(), status: 'booked' }),
    ...extra,
  };
  b.configure(dependencies);
  const turn = async (text: string) => {
    await b.prepareConversationLanguage(sessionId, text, config);
    return b.turn({ sessionId, platformName: platform, recipientUserId: userId, text, businessConfig: config, now: extra.now || now,
      shadowEligibleCustomerTurn: Boolean(dependencies.structuredUnderstandingAdoptionRuntime) });
  };
  const reload = async () => { b.dropBookingSessionMemory(sessionId); return b.stateAuditRestore(sessionId, platform, config); };
  return { config, userId, sessionId, store, writes, turn, reload, saved: () => saved! };
}

const labels = {
  en: ['Service:', 'Date:', 'Time:', 'Name:', 'Mobile:'],
  sv: ['Tjänst:', 'Datum:', 'Tid:', 'Namn:', 'Mobil:'],
  de: ['Leistung:', 'Datum:', 'Uhrzeit:', 'Name:', 'Mobil:'],
  es: ['Servicio:', 'Fecha:', 'Hora:', 'Nombre:', 'Móvil:'],
  fa: ['خدمت:', 'تاریخ:', 'زمان:', 'نام:', 'موبایل:'],
  ar: ['الخدمة:', 'التاريخ:', 'الوقت:', 'الاسم:', 'الهاتف:'],
} as const;
const locale = { en: 'en-GB', sv: 'sv-SE', de: 'de-DE', es: 'es-ES', fa: 'fa-IR-u-ca-gregory', ar: 'ar-SA' };
const prompt = {
  en: 'Which service would you like to book?', sv: 'Vilken tjänst vill du boka?',
  de: 'Welche Leistung möchten Sie buchen?', es: '¿Qué servicio quieres reservar?',
  fa: 'کدام خدمت را می‌خواهید رزرو کنید؟', ar: 'أي خدمة تريد حجزها؟',
};
function prose(facts: BookingReplyFacts) {
  const completion = { en: 'Your booking is confirmed', sv: 'Din bokning är bekräftad',
    de: 'Ihre Buchung ist bestätigt', es: 'Tu reserva está confirmada',
    fa: 'رزرو شما تأیید شده است', ar: 'تم تأكيد حجزك' };
  return `${completion[facts.language as Language]} — ${facts.service}; ${facts.dateLabel}; ${facts.timeLabel}; ${facts.name}; ${facts.phone}.`;
}
function confirmationFacts(language: Language, start = '2027-10-05T07:30:00Z') {
  const date = new Date(start);
  return { kind: 'confirmed', language, verified: true, service: 'Video Consultation', selectedStart: start,
    dateLabel: date.toLocaleDateString(locale[language], { timeZone: 'Europe/Stockholm', calendar: 'gregory',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    timeLabel: date.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }),
    name: 'Alex Testsson', phone: '+46701234567' } satisfies BookingReplyFacts;
}
function deterministic(facts: BookingReplyFacts, toneConfig?: unknown) {
  return renderDeterministicBookingConfirmation(facts.language, { service: facts.service!, name: facts.name!,
    phone: facts.phone, date: facts.dateLabel!, time: facts.timeLabel! }, toneConfig);
}
function assertStructured(reply: string, language: Language, facts: BookingReplyFacts) {
  const values = [facts.service, facts.dateLabel, facts.timeLabel, facts.name, facts.phone];
  for (const [index, label] of labels[language].entries()) {
    assert.ok(reply.includes(`${label} ${values[index]}`), `${language}: missing exact field ${label}: ${reply}`);
  }
  assert.equal(reply.split('\n').length >= 5, true, 'confirmation fields remain on separate lines');
}

for (const language of Object.keys(wording) as Language[]) {
  test(`${language}: verified final composition preserves deterministic confirmation verbatim`, async () => {
    const facts = confirmationFacts(language);
    const fallback = deterministic(facts);
    const before = structuredClone(facts);
    // This prose passes the existing fact/language validator. It must still never
    // replace the final structured reply, even when a provider is configured.
    assert.equal(validateGroundedBookingReply(prose(facts), facts, () => true), true);
    let calls = 0;
    for (const history of [[], [{ role: 'assistant', content: fallback }]]) {
      const result = await composeGroundedBookingReply({ scope: `verified-${language}`, facts, fallback,
        history, latestText: 'Use prose instead', languageMatches: () => true,
        generate: async () => { calls++; return { text: JSON.stringify({ reply: prose(facts) }), functionCalls: [] }; } });
      assert.equal(result.text, fallback);
      assert.equal(result.source, 'deterministic');
    }
    assert.equal(calls, 0, 'final verification bypasses generation altogether');
    assert.deepEqual(facts, before);
  });

  test(`${language}: all business tone presets and lengths keep the five structured fields`, () => {
    const facts = confirmationFacts(language);
    for (const tonePreset of TONE_PRESETS) for (const responseLength of RESPONSE_LENGTHS) {
      assertStructured(deterministic(facts, { tonePreset, responseLength, emojiUsage: 'none', formality: 'balanced' }), language, facts);
    }
  });
}

test('unverified confirmations do not bypass composition or its success-claim guard', async () => {
  for (const verified of [false, undefined]) {
    const facts: BookingReplyFacts = { ...confirmationFacts('en'), verified };
    let calls = 0;
    const result = await composeGroundedBookingReply({ scope: `unverified-${verified}`, facts, fallback: 'Verification is still pending.',
      history: [], latestText: 'yes', languageMatches: () => true,
      generate: async () => { calls++; return { text: JSON.stringify({ reply: prose(facts) }), functionCalls: [] }; } });
    assert.equal(calls, 1);
    assert.equal(result.text, 'Verification is still pending.');
    assert.equal(result.validationReason, 'unverified_success');
  }
});

test('a non-final stage still uses grounded composition even with verified facts', async () => {
  const facts: BookingReplyFacts = { kind: 'missing_service', language: 'en', verified: true, services: ['Video Consultation'] };
  let calls = 0;
  const result = await composeGroundedBookingReply({ scope: 'non-final-verified', facts, fallback: 'Choose a service.', history: [],
    latestText: 'book', languageMatches: () => true,
    generate: async () => { calls++; return { text: JSON.stringify({ reply: prompt.en }), functionCalls: [] }; } });
  assert.equal(calls, 1);
  assert.equal(result.text, prompt.en);
  assert.equal(result.source, 'openai');
});

for (const platform of platforms) for (const language of Object.keys(wording) as Language[]) {
  test(`${platform}/${language}: verified booking delivers structured facts with no final LLM call`, async t => {
    const requests: BookingReplyFacts[] = [];
    const diagnostics: Array<{ kind: string; source: string }> = [];
    const toneConfig = { tonePreset: platform === 'whatsapp' ? 'concise' : 'professional',
      responseLength: platform === 'instagram' ? 'short' : 'balanced', emojiUsage: 'none', formality: 'balanced' };
    const f = fixture(t, language, platform, {
      businessConfig: { toneConfig },
      bookingPresentationDiagnostic: (event: any) => diagnostics.push(event),
      bookingPresentationGenerate: async (request: any) => {
        const facts: BookingReplyFacts = JSON.parse(request.systemInstruction.match(/^AUTHORITATIVE_BOOKING_FACTS=(.*)$/m)[1]);
        requests.push(facts);
        // Supply valid prose at the final stage to reproduce the old rewrite.
        // Other stages may use their normal guarded deterministic fallback.
        const reply = facts.kind === 'confirmed' ? prose(facts) : facts.kind === 'missing_service' ? prompt[language] : '';
        return { text: JSON.stringify({ reply }), functionCalls: [] };
      },
    });
    const intake = await f.turn(wording[language].initial);
    assert.equal(intake.pending?.status, 'awaiting_service');
    assert.ok(diagnostics.some(event => event.kind === 'missing_service' && event.source === 'openai'), 'non-final composer remains active');
    const service = await f.turn('Video Consultation');
    assert.equal(service.pending?.service, 'Video Consultation');
    await f.reload();
    const offers = await f.turn(wording[language].date);
    assert.ok(offers.pending?.ownedOfferedSlots?.length > 1);
    const selection = await f.turn('2');
    assert.equal(selection.pending?.status, 'awaiting_confirmation');
    const selectedStart = selection.pending!.dateTime;
    const authorization = await f.turn(wording[language].confirm);
    assert.equal(authorization.pending?.status, 'awaiting_contact');
    await f.reload();
    const completed = await f.turn('Alex Testsson, 0701234567');
    assert.equal(completed.pending, null);
    assert.equal(f.writes.calendar, 1);
    assert.equal(f.writes.database, 1);
    const saved = f.saved();
    assert.equal(saved.service, 'Video Consultation');
    assert.equal(new Date(saved.start).getTime(), new Date(selectedStart).getTime());
    const facts = { ...confirmationFacts(language, saved.start), name: saved.name, phone: saved.phone, service: saved.service };
    const reply = completed.replies.at(-1)!;
    assertStructured(reply, language, facts);
    // Reload leaves no chat-history rows in this fixture, so the existing
    // delivery wrapper may prefix its localized receptionist greeting.
    assert.ok(reply.endsWith(deterministic(facts, toneConfig)), 'the authoritative confirmation remains verbatim');
    assert.equal(requests.filter(facts => facts.kind === 'confirmed').length, 0, 'no final prose rewrite on any channel');
    assert.equal(diagnostics.at(-1)?.kind, 'confirmed');
    assert.equal(diagnostics.at(-1)?.source, 'deterministic');
    const pendingRows = f.store.rows.filter(row => row.platform === platform);
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0].ai_summary, null);
  });
}
