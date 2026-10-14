import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiReliabilityError } from './reliability';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'synthetic-offline';
const { priority1hUnifiedEngineTestBoundary: b } = await import('../../server');

const cases = [
  ['sv', 'Vilken märkning har parkeringsgrinden för kundparkeringen?', 'Ursäkta, jag stötte på ett tekniskt problem. Försök gärna igen om några minuter.'],
  ['en', 'What marking is on the customer parking gate?', 'Sorry, a technical problem occurred. Please try again in a few minutes.'],
  ['de', 'Welche Kennzeichnung hat das Tor zum Kundenparkplatz?', 'Entschuldigung, es ist ein technisches Problem aufgetreten. Bitte versuchen Sie es in ein paar Minuten erneut.'],
  ['es', '¿Qué identificador tiene la puerta del aparcamiento para clientes?', 'Lo siento, ha ocurrido un problema técnico. Por favor, inténtalo de nuevo en unos minutos.'],
  ['fa', 'شناسه دروازه پارکینگ مشتریان چیست؟', 'متأسفم، در حال حاضر یک مشکل فنی پیش آمده است. لطفاً چند دقیقه دیگر دوباره تلاش کنید.'],
  ['ar', 'ما علامة بوابة موقف سيارات العملاء؟', 'عذرًا، حدثت مشكلة تقنية. يرجى المحاولة مرة أخرى بعد بضع دقائق.'],
] as const;

function fixture(t: any, language: string, category: 'PROVIDER_UNAVAILABLE' | 'TIMEOUT') {
  b.reset();
  t.after(() => b.reset());
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('External network forbidden in language fallback tests'); });
  let failures = 0;
  const forbidden = async () => { assert.fail('Knowledge error replies must not execute calendar, booking or analysis operations'); };
  b.configure({
    // No semantic language decision or model answer is supplied: exercise deterministic fallback.
    semanticLanguageResolver: async () => null,
    geminiGenerate: async () => {
      failures++;
      throw new AiReliabilityError(category, 'Synthetic offline provider failure');
    },
    knowledgeSearch: async () => [],
    semanticKnowledgeSearch: async () => [],
    calendarAdapter: { getEvents: forbidden, checkSlots: forbidden, insertAppointment: forbidden },
    recordAppointment: forbidden,
    postProcess: forbidden,
  });
  const config = {
    id: 750, businessName: 'Synthetic fallback studio', services: [],
    // Customer language must win over an unrelated business default.
    language: language === 'en' ? 'sv' : 'en',
  };
  return { config, failures: () => failures };
}

for (const [language, question, expected] of cases) {
  for (const category of ['PROVIDER_UNAVAILABLE', 'TIMEOUT'] as const) {
    test(`${language}: fresh Knowledge visitor gets localized ${category} error`, async t => {
      const { config, failures } = fixture(t, language, category);
      if (language === 'sv' || language === 'de') {
        assert.equal(b.detectStrongLanguage(question, config), language);
      }
      const result = await b.promptAuditWeb({ chatId: `fresh-${language}-${category}`, message: question }, config);
      assert.equal(result.status, category === 'PROVIDER_UNAVAILABLE' ? 200 : 500);
      assert.equal(result.body.text, expected);
      assert.ok(failures() > 0, 'Actual provider failure path must be exercised');
    });
  }

  test(`${language}: established customer language survives weak text and provider failure`, async t => {
    const { config, failures } = fixture(t, language, 'PROVIDER_UNAVAILABLE');
    const visitorId = `established-${language}`;
    const sessionId = b.promptAuditWebSession(visitorId, config);
    b.seedFlowLanguage(sessionId, language, 'service_info');
    const result = await b.promptAuditWeb({ chatId: visitorId, message: 'Parking?' }, config);
    assert.equal(result.status, 200);
    assert.equal(result.body.text, expected);
    assert.equal(b.conversationState(sessionId).language, language);
    assert.ok(failures() > 0);
  });
}

for (const quoted of [cases[0][1], cases[2][1]]) {
  test(`quoted foreign question does not override an English customer: ${quoted}`, t => {
    const { config } = fixture(t, 'en', 'PROVIDER_UNAVAILABLE');
    const text = `I would like to know what the phrase "${quoted}" means.`;
    assert.equal(b.resolveConversationLanguage('quoted-question', text, config), 'en');
  });
}
