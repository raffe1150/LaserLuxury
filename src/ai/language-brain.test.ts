import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveLanguageBrain,
  type SemanticLanguageDecision,
} from './language-brain';

function semantic(
  value: SemanticLanguageDecision,
  calls: string[],
) {
  return async (text: string) => {
    calls.push(text);
    return value;
  };
}

test('explicit language switch is authoritative and skips semantic detection', async () => {
  const calls: string[] = [];

  const result = await resolveLanguageBrain({
    text: 'Could you speak Swedish with me?',
    previousLanguage: 'en',
    businessFallback: 'en',
    explicitSwitch: 'sv',
    deterministicLanguage: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: semantic(
      { language: 'en', confidence: 0.99 },
      calls,
    ),
  });

  assert.deepEqual(result, {
    language: 'sv',
    source: 'explicit_switch',
  });

  assert.deepEqual(calls, []);
});

test('protected short or structural turns preserve established language', async () => {
  for (const text of [
    'ok',
    'ja',
    'Raffe',
    '0761234567',
    '16:30',
    '25/9',
  ]) {
    const calls: string[] = [];

    const result = await resolveLanguageBrain({
      text,
      previousLanguage: 'sv',
      businessFallback: 'en',
      preservePrevious: true,
      semanticEligible: true,
      semanticResolver: semantic(
        { language: 'en', confidence: 0.99 },
        calls,
      ),
    });

    assert.equal(result.language, 'sv', text);
    assert.equal(result.source, 'protected_previous', text);
    assert.deepEqual(calls, [], text);
  }
});

test('strong deterministic language evidence skips semantic detection', async () => {
  const calls: string[] = [];

  const result = await resolveLanguageBrain({
    text: 'Hola, quiero reservar una cita.',
    previousLanguage: 'en',
    businessFallback: 'en',
    deterministicLanguage: 'es',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: semantic(
      { language: 'de', confidence: 0.99 },
      calls,
    ),
  });

  assert.deepEqual(result, {
    language: 'es',
    source: 'deterministic',
  });

  assert.deepEqual(calls, []);
});

test('semantic fallback resolves an unsupported Swedish greeting', async () => {
  const calls: string[] = [];

  const result = await resolveLanguageBrain({
    text: 'Tjena',
    previousLanguage: null,
    businessFallback: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: semantic(
      { language: 'sv', confidence: 0.98 },
      calls,
    ),
  });

  assert.deepEqual(result, {
    language: 'sv',
    source: 'semantic_language',
  });

  assert.deepEqual(calls, ['Tjena']);
});

test('semantic language may replace a stale previous language when confidence is high', async () => {
  const calls: string[] = [];

  const result = await resolveLanguageBrain({
    text: 'Ja prata svenska med mig',
    previousLanguage: 'en',
    businessFallback: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: semantic(
      { language: 'sv', confidence: 0.97 },
      calls,
    ),
  });

  assert.deepEqual(result, {
    language: 'sv',
    source: 'semantic_language',
  });
});

test('semantic requested reply language takes priority over message language', async () => {
  const result = await resolveLanguageBrain({
    text: 'I would rather continue in Swedish.',
    previousLanguage: 'en',
    businessFallback: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => ({
      language: 'en',
      requestedReplyLanguage: 'sv',
      confidence: 0.99,
    }),
  });

  assert.deepEqual(result, {
    language: 'sv',
    source: 'semantic_requested_reply',
  });
});

test('semantic requested reply language works across all six supported languages', async () => {
  for (const language of ['sv', 'en', 'de', 'es', 'fa', 'ar'] as const) {
    const result = await resolveLanguageBrain({
      text: `semantic-switch-${language}`,
      previousLanguage: language === 'en' ? 'sv' : 'en',
      businessFallback: 'en',
      preservePrevious: false,
      semanticEligible: true,
      semanticResolver: async () => ({
        language: 'en',
        requestedReplyLanguage: language,
        confidence: 0.99,
      }),
    });

    assert.equal(result.language, language);
    assert.equal(result.source, 'semantic_requested_reply');
  }
});

test('low-confidence semantic result cannot overwrite established language', async () => {
  const result = await resolveLanguageBrain({
    text: 'Ambiguous message',
    previousLanguage: 'de',
    businessFallback: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => ({
      language: 'sv',
      confidence: 0.72,
    }),
  });

  assert.deepEqual(result, {
    language: 'de',
    source: 'previous',
  });
});

test('unsupported semantic language cannot enter conversation state', async () => {
  const result = await resolveLanguageBrain({
    text: 'Bonjour',
    previousLanguage: 'es',
    businessFallback: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => ({
      language: 'fr',
      confidence: 0.99,
    }),
  });

  assert.deepEqual(result, {
    language: 'es',
    source: 'previous',
  });
});

test('semantic provider failure safely preserves deterministic fallback behavior', async () => {
  const result = await resolveLanguageBrain({
    text: 'Unknown natural language input',
    previousLanguage: 'fa',
    businessFallback: 'en',
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => {
      throw new Error('provider unavailable');
    },
  });

  assert.deepEqual(result, {
    language: 'fa',
    source: 'previous',
  });
});

test('business language is only fallback when no customer language is available', async () => {
  const result = await resolveLanguageBrain({
    text: '',
    previousLanguage: null,
    businessFallback: 'sv',
    preservePrevious: false,
    semanticEligible: false,
  });

  assert.deepEqual(result, {
    language: 'sv',
    source: 'business_fallback',
  });
});

test("production regression: Persian to German switch survives short German acknowledgement", async () => {
  let calls = 0;

  const switchResult = await resolveLanguageBrain({
    text: "میشه از اینجا به بعد آلمانی صحبت کنیم؟",
    previousLanguage: "fa",
    businessFallback: "sv",
    explicitSwitch: null,
    deterministicLanguage: null,
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => {
      calls++;
      return {
        language: "fa",
        requestedReplyLanguage: "de",
        confidence: 0.99,
      };
    },
  });

  assert.equal(switchResult.language, "de");
  assert.equal(switchResult.source, "semantic_requested_reply");
  assert.equal(calls, 1);

  const shortReplyResult = await resolveLanguageBrain({
    text: "Passt.",
    previousLanguage: "de",
    businessFallback: "sv",
    explicitSwitch: null,
    deterministicLanguage: null,
    preservePrevious: true,
    semanticEligible: false,
  });

  assert.equal(shortReplyResult.language, "de");
  assert.equal(shortReplyResult.source, "protected_previous");
});

test("production regression: Spanish request to continue in Persian prefers requested language", async () => {
  const result = await resolveLanguageBrain({
    text: "¿Podemos seguir hablando en persa?",
    previousLanguage: "es",
    businessFallback: "sv",
    explicitSwitch: null,
    deterministicLanguage: null,
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => ({
      language: "es",
      requestedReplyLanguage: "fa",
      confidence: 0.99,
    }),
  });

  assert.equal(result.language, "fa");
  assert.equal(result.source, "semantic_requested_reply");
});

test("production regression: Arabic request to continue in Spanish prefers requested language", async () => {
  const result = await resolveLanguageBrain({
    text: "هل يمكننا متابعة الحديث بالإسبانية؟",
    previousLanguage: "ar",
    businessFallback: "sv",
    explicitSwitch: null,
    deterministicLanguage: null,
    preservePrevious: false,
    semanticEligible: true,
    semanticResolver: async () => ({
      language: "ar",
      requestedReplyLanguage: "es",
      confidence: 0.99,
    }),
  });

  assert.equal(result.language, "es");
  assert.equal(result.source, "semantic_requested_reply");
});
