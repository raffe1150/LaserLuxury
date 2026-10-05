import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingLeadStore } from '../../tests/helpers/pending-lead-store';
import { CURRENT_BOOKING_STATE_VERSION } from './booking-operation-state';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

const languages = ['en', 'sv', 'de', 'es', 'fa', 'ar'] as const;
const languageNames = { en: 'English', sv: 'Swedish', de: 'German', es: 'Spanish', fa: 'Persian', ar: 'Arabic' };
const businessConfig = {
  id: '7', businessRecordId: '7', language: 'sv', timezone: 'Europe/Stockholm',
  calendarProvider: 'custom', defaultBookingService: 'Video Consultation',
  services: ['Video Consultation', 'Golden video', 'Swedish Consultation', 'Beratung Premium',
    'Consulta Premium', 'مشاوره آنلاین', 'استشارة فيديو'].map(name => ({ name, duration: 30 })),
};
const start = '2026-10-13T18:00:00+02:00';
const end = '2026-10-13T18:30:00+02:00';
const now = new Date('2026-10-12T12:00:00+02:00');

function fixture(t: any, language: typeof languages[number], foreign: typeof languages[number]) {
  b.reset();
  t.after(() => b.reset());
  for (const key of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, key, () => undefined);
  const store = new PendingLeadStore();
  const semanticCalls: string[] = [];
  const sessionId = `continuation-${language}`;
  b.configure({
    supabaseClient: store as any,
    semanticLanguageResolver: async text => {
      semanticCalls.push(text);
      return { language: foreign, requestedReplyLanguage: null, confidence: 0.99 };
    },
    calendarAdapter: {
      getEvents: async () => [],
      checkSlots: () => ({ available_slots_string: '' }),
      insertAppointment: async () => { assert.fail('language resolution must not create an appointment'); },
    },
    postProcess: async () => undefined,
    bookingPresentationGenerate: undefined,
  });
  b.seedFlowLanguage(sessionId, language, 'booking');
  b.seedPending(sessionId, {
    bookingStateVersion: CURRENT_BOOKING_STATE_VERSION,
    businessId: '7', businessConfig, platform: 'telegram', userId: sessionId, sessionId,
    operation: 'new_booking', status: 'awaiting_time_selection', expectedInput: 'slot_selection',
    language, service: 'Video Consultation', durationMinutes: 30, selectedDate: '2026-10-13',
    offeredSlots: [`Tuesday at 18:00 (ISO: ${start})`],
    ownedOfferedSlots: [{ start, end, durationMinutes: 30, service: 'Video Consultation',
      businessId: '7', platform: 'telegram', userId: sessionId, generatedAt: Date.now(),
      searchStartDate: '2026-10-13', searchEndDate: '2026-10-13' }],
    dateTime: null, selectedSlotEnd: null,
  });
  b.seedAvailabilitySearchContext(sessionId, { language, businessId: '7', service: 'Video Consultation' });
  const prepare = (text: string) => b.prepareConversationLanguage(sessionId, text, businessConfig);
  const turn = (text: string) => b.turn({ sessionId, recipientUserId: sessionId,
    platformName: 'telegram', text, businessConfig, now });
  return { store, semanticCalls, sessionId, prepare, turn };
}

test('production phrase keeps English through resolution, slot confirmation and durable reload', async t => {
  const { store, sessionId, prepare, turn, semanticCalls } = fixture(t, 'en', 'sv');
  const before = b.conversationState(sessionId);
  const text = 'kl 18:00 it works for me';
  assert.equal(await prepare(text), 'en');
  assert.deepEqual(b.conversationState(sessionId), before, 'preflight must not mutate booking or availability state');
  assert.deepEqual(semanticCalls, [], 'continuation is protected before semantic classification');
  const result = await turn(text);
  assert.equal(result.handled, true);
  assert.equal(result.pending?.language, 'en');
  assert.equal(b.conversationState(sessionId).language, 'en');
  assert.equal(result.pending?.dateTime, start);
  assert.equal(result.pending?.service, 'Video Consultation');
  assert.equal(result.pending?.businessId, '7');
  assert.equal(result.pending?.platform, 'telegram');
  assert.match(result.replies[0], /Would you like me to (?:confirm|book)|You have selected/iu);
  assert.doesNotMatch(result.replies[0], /Bra!|Du har valt|Vill du|bekräfta|bokningen/iu);
  assert.equal(JSON.parse(store.rows[0].ai_summary!).language, 'en');
  b.dropBookingSessionMemory(sessionId);
  const restored = await b.stateAuditRestore(sessionId, 'telegram', businessConfig);
  assert.equal(restored.language, 'en');
  assert.equal(await prepare('ok'), 'en');
  assert.equal(b.conversationState(sessionId).language, 'en');
});

const mixed = {
  en: ['sv', 'kl 18:00 it works for me'],
  sv: ['en', '18:00 works for me'],
  de: ['sv', 'kl 18:00 passt gut'],
  es: ['en', 'Video Consultation 18:00'],
  fa: ['en', 'saat 18:00 works for me'],
  ar: ['fa', 'ساعت 18:00 مناسب'],
} as const;

for (const language of languages) {
  test(`${language}: continuation matrix preserves state and saved language despite foreign semantic evidence`, async t => {
    const [foreign, mixedText] = mixed[language];
    const { sessionId, prepare, store, semanticCalls } = fixture(t, language, foreign);
    const before = b.conversationState(sessionId);
    for (const text of [mixedText, 'ok', 'yes', 'ja tack', '18:00', '2', ...businessConfig.services.map(service => service.name),
      'Alex Testsson', 'محمد علي', '0701234567', 'Alex Testsson, 0701234567']) {
      assert.equal(await prepare(text), language, text);
      assert.deepEqual(b.conversationState(sessionId), before, text);
    }
    b.seedPending(sessionId, { ...before.pending, status: 'awaiting_contact', expectedInput: 'contact',
      dateTime: start, selectedSlotEnd: end });
    const contactBefore = b.conversationState(sessionId);
    for (const text of ['My name is Alex Testsson', 'اسمي محمد علي', 'نام من علی است', 'my phone is 0701234567']) {
      assert.equal(await prepare(text), language, text);
      assert.deepEqual(b.conversationState(sessionId), contactBefore, text);
    }
    assert.deepEqual(semanticCalls, []);
    await b.stateAuditPersist(sessionId, 'telegram', b.pendingStateSnapshot(sessionId));
    assert.equal(JSON.parse(store.rows[0].ai_summary!).language, language);
    b.dropBookingSessionMemory(sessionId);
    const restored = await b.stateAuditRestore(sessionId, 'telegram', businessConfig);
    assert.equal(restored.language, language);
    assert.equal(await prepare(mixedText), language);
    assert.equal(b.conversationState(sessionId).language, language);
    assert.equal(b.pendingStateSnapshot(sessionId).language, language);
  });

  test(`${language}: mixed slot selection is presented and persisted in the established language`, async t => {
    const { sessionId, prepare, turn, store } = fixture(t, language, mixed[language][0]);
    const text = mixed[language][1];
    assert.equal(await prepare(text), language);
    const result = await turn(text);
    assert.equal(result.pending?.language, language);
    assert.equal(b.conversationState(sessionId).language, language);
    assert.equal(result.pending?.dateTime, start);
    assert.ok(b.bookingPresentationLanguageMatches(result.replies[0], language, ['Video Consultation']));
    assert.equal(JSON.parse(store.rows[0].ai_summary!).language, language);
  });

  test(`${language}: explicit requests can switch to every other supported language`, async t => {
    const { sessionId, prepare, semanticCalls } = fixture(t, language, mixed[language][0]);
    const before = b.conversationState(sessionId);
    for (const target of languages.filter(candidate => candidate !== language)) {
      b.seedFlowLanguage(sessionId, language, 'booking');
      b.seedPending(sessionId, before.pending);
      b.seedAvailabilitySearchContext(sessionId, before.availability!);
      assert.equal(await prepare(`Please continue in ${languageNames[target]}`), target);
      const state = b.conversationState(sessionId);
      assert.equal(state.language, target);
      assert.equal(state.pending?.language, target);
      assert.equal(state.availability?.language, target);
      assert.deepEqual(state.pending, { ...before.pending, language: target });
      assert.deepEqual(state.availability, { ...before.availability, language: target });
    }
    assert.deepEqual(semanticCalls, [], 'explicit switches bypass semantic classification');
  });
}

test('meaningful full messages still switch an active booking across all six languages', async t => {
  const { sessionId, prepare } = fixture(t, 'ar', 'en');
  const requests = {
    en: 'Hello, I want to know what services you offer and book an appointment.',
    sv: 'Hej, jag vill boka en tid imorgon och veta vilka tjänster ni erbjuder.',
    de: 'Hallo, ich möchte wissen, welche Dienstleistungen Sie anbieten.',
    es: 'Hola, quiero saber qué servicios ofrecen y reservar una cita.',
    fa: 'سلام، می‌خواهم برای فردا یک وقت مشاوره رزرو کنم.',
    ar: 'مرحبا، أريد حجز موعد غداً ومعرفة الخدمات المتاحة.',
  };
  for (const language of languages) {
    b.configure({ semanticLanguageResolver: async () => ({ language, requestedReplyLanguage: null, confidence: 0.99 }) });
    assert.equal(await prepare(requests[language]), language);
    assert.equal(b.conversationState(sessionId).language, language);
    assert.equal(b.pendingStateSnapshot(sessionId).language, language);
  }
});

test('semantic requested reply language remains authoritative for natural language requests', async t => {
  const { sessionId, prepare } = fixture(t, 'en', 'sv');
  b.configure({ semanticLanguageResolver: async () => ({ language: 'en', requestedReplyLanguage: 'sv', confidence: 0.99 }) });
  assert.equal(await prepare('I would feel more comfortable chatting in Swedish.'), 'sv');
  assert.equal(b.pendingStateSnapshot(sessionId).language, 'sv');
});

test('semantic-only meaningful switching outside a booking remains supported', async t => {
  const { sessionId, prepare, semanticCalls } = fixture(t, 'de', 'en');
  b.dropBookingSessionMemory(sessionId);
  b.seedFlowLanguage(sessionId, 'de', 'booking');
  assert.equal(await prepare('Is the entrance wheelchair accessible?'), 'en');
  assert.ok(semanticCalls.length > 0);
});

test('a meaningful informational detour during a booking retains semantic-only switching', async t => {
  const { sessionId, prepare, semanticCalls } = fixture(t, 'de', 'en');
  assert.equal(await prepare('Is the entrance wheelchair accessible?'), 'en');
  assert.ok(semanticCalls.length > 0);
  assert.equal(b.conversationState(sessionId).language, 'en');
  assert.equal(b.pendingStateSnapshot(sessionId).language, 'en');
});
