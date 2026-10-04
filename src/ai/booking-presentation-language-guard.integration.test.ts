import assert from 'node:assert/strict';
import { bookingReplyLanguageEvidence, composeGroundedBookingReply, validateGroundedBookingReplyDetailed, type BookingReplyFacts } from './grounded-booking-composition';

process.env.NODE_ENV = 'test';
process.env.STRUCTURED_UNDERSTANDING_ENABLED = 'false';
const savedConsole = { ...console };
const warnings: any[] = [];
for (const key of ['log', 'info', 'error'] as const) console[key] = () => undefined;
console.warn = (marker, event) => { if (marker === '[CustomerReplyGuard]') warnings.push(event); };
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

const replies = {
  en: 'Haircut is not bookable here. Which service would you like to choose: Video Consultation or Golden video?',
  sv: 'Haircut är inte bokningsbar här. Vilken tjänst vill du välja: Video Consultation eller Golden video?',
  de: 'Haircut ist hier nicht buchbar. Welche Leistung möchten Sie wählen: Video Consultation oder Golden video?',
  es: 'Haircut no es un servicio reservable aquí. ¿Qué servicio quieres elegir: Video Consultation o Golden video?',
  fa: 'Haircut اینجا قابل رزرو نیست. کدام سرویس را می‌خواهید انتخاب کنید: Video Consultation یا Golden video؟',
  ar: 'Haircut ليست خدمة قابلة للحجز هنا. أي خدمة تريد اختيارها: Video Consultation أم Golden video؟',
};
let checks = 0;
try {
  b.reset();
  const diagnostics: any[] = [];
  let calls = 0;
  b.configure({
    postProcess: async () => undefined,
    bookingPresentationDiagnostic: event => diagnostics.push(event),
    bookingPresentationGenerate: async () => ({ text: JSON.stringify({ reply: ++calls === 1
      ? 'klippning är inte bokningsbar här. Vilken tjänst vill du välja?'
      : 'Jag förstår. klippning erbjuds inte. Önskar du en annan tjänst? Sorry.' }), functionCalls: [] }),
  });
  const params = { sessionId: 'messenger-sv-repeat', platformName: 'messenger' as const, recipientUserId: 'test-customer',
    businessConfig: { id: 'language-guard', language: 'sv', services: [{ name: 'Video Consultation', duration: 30 }] },
    now: new Date('2026-09-01T09:00:00+02:00') };
  const first = await b.turn({ ...params, text: 'Hej, jag vill boka en klippning.' });
  assert.equal(first.pending?.status, 'awaiting_service');
  assert.equal(diagnostics.at(-1)?.source, 'openai');
  const repeated = await b.turn({ ...params, text: 'klippning' });
  assert.equal(repeated.pending?.status, 'awaiting_service');
  assert.equal(repeated.pending?.requestedService, 'klippning');
  assert.equal(repeated.pending?.language, 'sv');
  assert.equal(diagnostics.at(-1)?.repeated, true);
  assert.equal(diagnostics.at(-1)?.source, 'deterministic');
  assert.equal(diagnostics.at(-1)?.validationReason, 'language_mismatch');
  assert.match(repeated.replies[0], /klippning.*inte bokningsbar/su, 'language recovery must retain unsupported-service fact');
  assert.match(repeated.replies[0], /välja.*tjänst/su, 'language recovery must retain service choice');
  assert.doesNotMatch(repeated.replies[0], /Sorry|Vad vill du veta/iu);
  checks++;
  const validRepeat = 'Jag förstår. klippning erbjuds inte. Önskar du en annan tjänst?';
  b.configure({ postProcess: async () => undefined, bookingPresentationDiagnostic: event => diagnostics.push(event),
    bookingPresentationGenerate: async () => ({ text: JSON.stringify({ reply: validRepeat }), functionCalls: [] }) });
  const resumed = await b.turn({ ...params, text: 'klippning' });
  assert.equal(diagnostics.at(-1)?.source, 'openai');
  assert.equal(diagnostics.at(-1)?.repeated, true);
  assert.equal(resumed.replies[0], validRepeat, 'natural Swedish with few marker words must remain accepted');
  assert.equal(resumed.pending?.status, 'awaiting_service');
  checks++;

  // Exercise composition, final guarding and delivery through the real shared
  // engine for every customer channel, with identical authoritative state.
  let channelLanguageScenarios = 0;
  for (const platformName of ['messenger', 'instagram', 'whatsapp', 'telegram'] as const) {
    for (const language of Object.keys(replies) as Array<keyof typeof replies>) {
      const sessionId = platformName === 'whatsapp' ? 'whatsapp:46700000001' : `unified-language-guard-${platformName}-${language}`;
      const turnParams = { sessionId, platformName,
        recipientUserId: platformName === 'whatsapp' ? '46700000001' : sessionId,
        businessConfig: { id: 'language-guard', language, services: [
          { name: 'Video Consultation', duration: 30 }, { name: 'Golden video', duration: 30 },
        ] }, now: new Date('2026-09-01T09:00:00+02:00'), text: 'Haircut' };
      let deterministicFallback = '';
      for (const mode of ['baseline', 'valid', 'mixed'] as const) {
        b.reset();
        b.seedFlowLanguage(sessionId, language, 'booking');
        b.seedPending(sessionId, { status: 'awaiting_service', operation: 'new_booking', expectedInput: 'service',
          businessId: 'language-guard', businessConfig: turnParams.businessConfig, platform: platformName,
          userId: turnParams.recipientUserId, sessionId,
          language, requestedService: 'Haircut', service: 'Bokning', selectedDate: '2026-09-03', requestedTime: '16:00' });
        const events: any[] = [];
        let beforePresentation: ReturnType<typeof b.conversationState> | undefined;
        let presentationFacts: BookingReplyFacts | undefined;
        const valid = replies[language];
        const candidate = mode === 'mixed' ? `${valid} ${language === 'en' ? 'Vill du prova igen?' : 'Sorry.'}` : valid;
        b.configure({ postProcess: async () => undefined, bookingPresentationDiagnostic: event => events.push(event),
          ...(mode !== 'baseline' ? { bookingPresentationGenerate: async request => {
            beforePresentation = b.conversationState(sessionId);
            presentationFacts = JSON.parse(request.systemInstruction!.match(/^AUTHORITATIVE_BOOKING_FACTS=(.*)$/m)![1]);
            return { text: JSON.stringify({ reply: candidate }), functionCalls: [] };
          } } : {}),
        });
        warnings.length = 0;
        const result = await b.turn(turnParams);
        const label = `${platformName}/${language}/${mode}`;
        assert.equal(result.handled, true, label);
        assert.equal(result.replies.length, 1, label);
        assert.equal(result.pending?.status, 'awaiting_service', label);
        assert.equal(result.pending?.language, language, label);
        assert.equal(result.pending?.requestedService, 'Haircut', label);
        assert.equal(result.pending?.service, 'Bokning', label);
        assert.equal(result.pending?.selectedDate, '2026-09-03', label);
        assert.equal(result.pending?.requestedTime, '16:00', label);
        assert.equal(events.length, 1, label);
        assert.equal(events[0].kind, 'unsupported_service', label);
        if (mode === 'baseline') {
          assert.equal(events[0].source, 'deterministic', label);
          deterministicFallback = result.replies[0];
          for (const service of ['Haircut', 'Video Consultation', 'Golden video']) {
            assert.ok(deterministicFallback.includes(service), `${label}: recovery retains the requested service and valid choices`);
          }
        } else {
          assert.ok(beforePresentation, `${label}: real composer was invoked`);
          assert.deepEqual(b.conversationState(sessionId), beforePresentation, `${label}: presentation and final guard preserve booking state`);
          assert.equal(events[0].source, mode === 'valid' ? 'openai' : 'deterministic', label);
          assert.equal(result.replies[0], mode === 'valid' ? valid : deterministicFallback, label);
          if (mode === 'mixed') {
            assert.equal(events[0].validationReason, 'language_mismatch', label);
            assert.notEqual(result.replies[0], candidate, `${label}: mixed reply never reaches delivery`);
          }
          assert.equal(warnings.length, 0, `${label}: safe delivered presentation survives the final guard`);
          if (mode === 'mixed') {
            assert.ok(presentationFacts, label);
            assert.equal(b.guardReply(sessionId, candidate, language, undefined,
              { facts: presentationFacts, fallback: deterministicFallback }), deterministicFallback,
              `${label}: final safety layer independently returns the exact booking fallback`);
            assert.equal(warnings.length, 1, `${label}: final safety layer blocks mixed language`);
            assert.deepEqual(b.conversationState(sessionId), beforePresentation, `${label}: final rejection preserves booking state`);
          }
        }
      }
      channelLanguageScenarios++;
      checks++;
    }
  }
  assert.equal(channelLanguageScenarios, 24);

  for (const language of Object.keys(replies) as Array<keyof typeof replies>) {
    b.reset();
    const sessionId = `final-guard-${language}`;
    b.seedFlowLanguage(sessionId, language, 'booking');
    b.seedPending(sessionId, { status: 'awaiting_service', operation: 'new_booking', expectedInput: 'service',
      language, requestedService: 'Haircut', service: 'Bokning', selectedDate: '2026-09-03', requestedTime: '16:00' });
    const state = b.conversationState(sessionId);
    const facts: BookingReplyFacts = { kind: 'unsupported_service', language, requestedService: 'Haircut', services: ['Video Consultation', 'Golden video'] };
    const snapshot = structuredClone(facts);
    const fallback = replies[language];
    const matches = (prose: string) => b.bookingPresentationLanguageMatches(prose, language);
    const accepted = await composeGroundedBookingReply({ scope: `valid-${language}`, facts, fallback, history: [], latestText: 'Haircut', languageMatches: matches,
      generate: async () => ({ text: JSON.stringify({ reply: fallback }), functionCalls: [] }) });
    assert.equal(accepted.source, 'openai', `${language}: valid single-language composition`);
    warnings.length = 0;
    assert.equal(b.guardReply(sessionId, accepted.text, language, undefined, { facts, fallback }), accepted.text);
    assert.equal(warnings.length, 0, `${language}: composer-accepted reply survives final safety layer`);
    checks++;

    // A small foreign phrase must be a veto even with many own-language markers.
    const mixed = `${fallback} ${language === 'en' ? 'Vill du prova igen?' : 'Sorry.'}`;
    assert.deepEqual(validateGroundedBookingReplyDetailed(mixed, facts, matches), { valid: false, reason: 'language_mismatch' });
    const rejected = await composeGroundedBookingReply({ scope: `mixed-${language}`, facts, fallback, history: [], latestText: 'Haircut', languageMatches: matches,
      generate: async () => ({ text: JSON.stringify({ reply: mixed }), functionCalls: [] }) });
    assert.equal(rejected.source, 'deterministic');
    assert.equal(rejected.validationReason, 'language_mismatch');
    assert.equal(rejected.text, fallback);
    warnings.length = 0;
    assert.equal(b.guardReply(sessionId, mixed, language, undefined, { facts, fallback }), fallback,
      `${language}: final guard returns booking-specific unsupported-service recovery`);
    assert.equal(warnings.length, 1);
    assert.deepEqual(Object.keys(warnings[0]).sort(), ['language', 'mixedLanguageBlocked', 'stateType']);
    checks++;

    // Dominant language drift, including FA/AR in both directions, also recovers
    // the exact booking presentation rather than a general language-help prompt.
    for (const foreign of Object.keys(replies) as Array<keyof typeof replies>) {
      if (foreign === language) continue;
      assert.equal(matches(bookingReplyLanguageEvidence(replies[foreign], facts)), false, `${language}/${foreign}: composer drift blocked`);
      warnings.length = 0;
      assert.equal(b.guardReply(sessionId, replies[foreign], language, undefined, { facts, fallback }), fallback);
      assert.equal(warnings.length, 1, `${language}/${foreign}: final drift blocked`);
      checks++;
    }

    // Exact facts are excluded from language evidence, longest values first.
    // Even names that resemble guard phrases remain immutable catalog facts.
    const entityFacts = { ...facts, requestedService: 'Haircut', services: ['Sorry', 'Please choose', 'Please choose Deluxe'] };
    const entityReply = fallback.replace('Video Consultation or Golden video', 'Sorry, Please choose, Please choose Deluxe')
      .replace('Video Consultation eller Golden video', 'Sorry, Please choose, Please choose Deluxe')
      .replace('Video Consultation oder Golden video', 'Sorry, Please choose, Please choose Deluxe')
      .replace('Video Consultation o Golden video', 'Sorry, Please choose, Please choose Deluxe')
      .replace('Video Consultation یا Golden video', 'Sorry, Please choose, Please choose Deluxe')
      .replace('Video Consultation أم Golden video', 'Sorry, Please choose, Please choose Deluxe');
    assert.equal(b.guardReply(sessionId, entityReply, language, undefined, { facts: entityFacts, fallback }), entityReply);
    assert.deepEqual(validateGroundedBookingReplyDetailed(entityReply, entityFacts, matches), { valid: true });
    assert.equal(b.guardReply(sessionId, `${entityReply} ${language === 'en' ? 'Vill du prova igen?' : 'Sorry.'}`, language, undefined,
      { facts, fallback }), fallback, 'unregistered foreign phrases are still blocked');
    checks++;

    assert.deepEqual(facts, snapshot, `${language}: presentation facts do not mutate`);
    assert.deepEqual(b.conversationState(sessionId), state, `${language}: date/time/service and booking state do not mutate`);
  }

  // Recovery uses the formatter's complete output for every presentation kind;
  // it must not reconstruct slots, constraints or contact needs from prose/state.
  for (const kind of ['missing_service', 'service_date', 'ambiguous_service', 'availability', 'choose_slot', 'confirm_slot', 'missing_contact', 'date', 'time'] as const) {
    const facts: BookingReplyFacts = { kind, language: 'sv', operation: 'reschedule', service: 'Video Consultation',
      slots: ['2026-09-03 16:00'], selectedStart: '2026-09-03T16:00:00+02:00', missing: ['name', 'phone'],
      constraint: { kind: 'exact_time', exactTime: '16:00', startDate: '2026-09-03' } };
    const recoveries = {
      missing_service: 'Vilken tjänst vill du boka?',
      service_date: 'Vilken tjänst och vilket datum vill du välja för en ny bokning?',
      ambiguous_service: 'Video Consultation kan avse flera tjänster. Vilken menar du?',
      availability: 'Ledig tid för Video Consultation: 2026-09-03 16:00. Vilken tid vill du välja?',
      choose_slot: 'Vilken av de föreslagna tiderna vill du välja: 2026-09-03 16:00?',
      confirm_slot: 'Video Consultation: 2026-09-03 16:00. Vill du flytta bokningen till den valda tiden?',
      missing_contact: 'Vad heter du och vilket mobilnummer har du?',
      date: 'Jag har valt Video Consultation. Vilket datum vill du välja?',
      time: 'Vilken tid vill du välja för Video Consultation?',
    };
    const fallback = recoveries[kind];
    assert.equal(b.guardReply(`recovery-${kind}`, 'Sorry. Please choose.', 'sv', undefined, { facts, fallback }), fallback, kind);
    checks++;
  }

  // Adapter/send-only guard callers obtain metadata only from an exact staged
  // presentation. Configured English wording must survive those paths as well.
  for (const language of Object.keys(replies) as Array<keyof typeof replies>) {
    b.reset();
    b.configure({ postProcess: async () => undefined });
    const sessionId = `adapter-guard-${language}`;
    const staged = await b.composeAdapterBookingReply({ sessionId, platformName: 'messenger', recipientUserId: 'test-customer',
      businessConfig: { id: 'language-guard', services: [{ name: 'Please choose', duration: 30 }] },
      history: [], text: 'Haircut', service: 'Haircut', slots: [], language });
    warnings.length = 0;
    assert.equal(b.guardReply(sessionId, staged, language), staged, `${language}: adapter exact entities survive final guard`);
    assert.equal(warnings.length, 0);
    assert.equal(b.guardReply(sessionId, 'Sorry. Please choose.', 'sv'), 'Jag hjälper dig gärna på svenska. Vad vill du veta?',
      'an unrelated reply cannot borrow staged facts');
    checks++;
  }
  savedConsole.log(`Booking presentation language guard: ${checks} regression scenarios passed; ${channelLanguageScenarios} channel/language combinations, 72 unified-engine matrix turns across four channels and six languages`);
} finally { b.reset(); Object.assign(console, savedConsole); }
