/** S1 contextual Knowledge fallback: pure, offline, deterministic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKnowledgeFallback, contextualKnowledgeFallback, previousAssistantReply, quotableQuestion, type KnowledgeFallbackCategory } from './knowledge-fallback';
import { formatBusinessSupportVerificationUnavailable } from './business-information';

const LANGS = ['fa', 'ar', 'sv', 'en', 'de', 'es'] as const;
const CATEGORIES: KnowledgeFallbackCategory[] = ['VERIFICATION', 'NO_EVIDENCE', 'TIMEOUT', 'TECHNICAL'];

test('classification uses backend signals only; unknown or ambiguous causes stay VERIFICATION', () => {
  assert.equal(classifyKnowledgeFallback({ timingFailure: true }), 'TIMEOUT');
  assert.equal(classifyKnowledgeFallback({ freshnessFailure: 'DEADLINE' }), 'TIMEOUT');
  assert.equal(classifyKnowledgeFallback({ fallbackReason: 'DEADLINE' }), 'TIMEOUT');
  assert.equal(classifyKnowledgeFallback({ fallbackReason: 'MALFORMED_JSON' }), 'TECHNICAL');
  assert.equal(classifyKnowledgeFallback({ retrievalStatus: 'failed', fallbackReason: 'NO_EVIDENCE' }), 'TECHNICAL', 'failed retrieval is never "nothing found"');
  assert.equal(classifyKnowledgeFallback({ retrievalStatus: 'empty', fallbackReason: 'NO_EVIDENCE' }), 'NO_EVIDENCE');
  // "Nothing found" needs BOTH a completed empty retrieval and a NO_EVIDENCE stop.
  assert.equal(classifyKnowledgeFallback({ fallbackReason: 'NO_EVIDENCE' }), 'VERIFICATION');
  assert.equal(classifyKnowledgeFallback({ retrievalStatus: 'empty', fallbackReason: 'NO_VERIFIED_UNITS' }), 'VERIFICATION');
  for (const reason of ['INVALID_COVERAGE', 'MATERIAL_FACTS_MISSING', 'CONTRADICTED', 'NO_VERIFIED_UNITS', 'CONTEXT_INVALID', 'SOURCE_INVALID',
    'PROVIDER_FAILURE', 'BUDGET_EXHAUSTED', 'STAGE_ADMISSION', 'REFUSAL', 'BLOCKED', null])
    assert.equal(classifyKnowledgeFallback({ fallbackReason: reason, retrievalStatus: 'matched' }), 'VERIFICATION', String(reason));
});

test('quoting: short single questions only; RTL punctuation restored; risky text never echoed', () => {
  assert.equal(quotableQuestion('How early should I arrive?', 'en'), 'How early should I arrive?');
  assert.equal(quotableQuestion('چقدر زودتر باید برسم?', 'fa'), 'چقدر زودتر باید برسم؟');
  assert.equal(quotableQuestion('متى يجب أن أصل, تقريبًا?', 'ar'), 'متى يجب أن أصل، تقريبًا؟');
  for (const q of ['Hi', 'x'.repeat(91), 'First sentence. Second question?', 'What? And why?', 'Is it free? ok',
    'See https://example.com?', 'Is 2026 ok?', 'Line\nbreak?', 'Use "quotes"?', '<b>bold</b>?', 'Price: 10?'])
    assert.equal(quotableQuestion(q, 'en'), null, q);
});

test('six languages x four categories: deterministic, fact-free, never claims absence after a failure', () => {
  for (const language of LANGS) for (const category of CATEGORIES) for (const question of [null, 'How early should I arrive?']) {
    const a = contextualKnowledgeFallback({ language, question, category }), b = contextualKnowledgeFallback({ language, question, category });
    assert.equal(a.text, b.text, 'deterministic');
    assert.equal(a.repeated, false);
    assert.doesNotMatch(a.text.replace(/[“”„«»][^“”„«»]*[“”«»]/gu, ''), /\p{N}/u, `${language}/${category}: no quantities`);
    if (category !== 'NO_EVIDENCE')
      assert.doesNotMatch(a.text, /does not exist|is not available|not offered|no such|finns inte|gibt es nicht|no existe|وجود ندارد|غير موجود|لا يوجد/iu, `${language}/${category}`);
  }
  // VERIFICATION with an unquotable question is byte-identical to the previous wording.
  for (const language of LANGS) {
    const generic = ({ en: 'the requested details', sv: 'de efterfrågade uppgifterna', de: 'die angefragten Einzelheiten', es: 'los detalles solicitados',
      fa: 'جزئیات درخواست‌شده', ar: 'التفاصيل المطلوبة' } as const)[language];
    assert.equal(contextualKnowledgeFallback({ language, question: 'First sentence. And then a long second question that cannot be quoted?', category: 'VERIFICATION' }).text,
      formatBusinessSupportVerificationUnavailable(language, generic));
  }
});

test('the customer question is quoted with language-appropriate marks', () => {
  assert.equal(contextualKnowledgeFallback({ language: 'en', question: 'How early should I arrive?', category: 'TIMEOUT' }).text,
    'Checking “How early should I arrive?” is taking longer than expected, so I can’t give a verified answer right now. Please send your question again in a moment.');
  assert.match(contextualKnowledgeFallback({ language: 'de', question: 'Wie früh sollte ich kommen?', category: 'TIMEOUT' }).text, /„Wie früh sollte ich kommen\?“/u);
  assert.match(contextualKnowledgeFallback({ language: 'fa', question: 'چقدر زودتر باید برسم?', category: 'VERIFICATION' }).text, /«چقدر زودتر باید برسم؟»/u);
});

test('repeat detection: previous assistant turn only, same fallback only, no escalation loop', () => {
  const q = 'How early should I arrive?';
  const first = contextualKnowledgeFallback({ language: 'en', question: q, category: 'VERIFICATION' });
  const history = [{ role: 'user', content: q }, { role: 'assistant', content: first.text }, { role: 'user', content: q }];
  const second = contextualKnowledgeFallback({ language: 'en', question: q, category: 'VERIFICATION', previousAssistantReply: previousAssistantReply(history) });
  assert.equal(second.repeated, true);
  assert.equal(second.text, 'I still can’t confirm “How early should I arrive?” from the information available to me, so it’s best to ask the business directly.');
  assert.doesNotMatch(second.text, /sorry|apolog/iu);
  // Third time: the same repeat wording, no growing chain.
  const third = contextualKnowledgeFallback({ language: 'en', question: q, category: 'VERIFICATION', previousAssistantReply: second.text });
  assert.equal(third.text, second.text);
  // A different question or category is not a repeat.
  assert.equal(contextualKnowledgeFallback({ language: 'en', question: 'Is there parking?', category: 'VERIFICATION', previousAssistantReply: first.text }).repeated, false);
  assert.equal(contextualKnowledgeFallback({ language: 'en', question: q, category: 'TIMEOUT', previousAssistantReply: first.text }).repeated, false);
  // Timeouts repeat with a "try later / ask directly" next step.
  const t1 = contextualKnowledgeFallback({ language: 'sv', question: q, category: 'TIMEOUT' });
  assert.match(contextualKnowledgeFallback({ language: 'sv', question: q, category: 'TIMEOUT', previousAssistantReply: t1.text }).text, /fortfarande/u);
});

test('previousAssistantReply ignores the current turn placeholder and non-adjacent history', () => {
  assert.equal(previousAssistantReply([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'current' }]), undefined);
  assert.equal(previousAssistantReply([{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'current' }]), 'prev');
  assert.equal(previousAssistantReply([{ role: 'assistant', content: 'old' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }]), undefined);
  assert.equal(previousAssistantReply(undefined), undefined);
});

test('unsupported language falls back to English wording, never throws', () => {
  assert.equal(contextualKnowledgeFallback({ language: 'fr', question: null, category: 'TECHNICAL' }).text,
    contextualKnowledgeFallback({ language: 'en', question: null, category: 'TECHNICAL' }).text);
});
