import assert from 'node:assert/strict';
import test from 'node:test';
import { hasConversationReference, referenceClarificationReply } from './conversation-intent-continuity';

// Offline-only native continuity: scripted provider responses, isolated in-memory Knowledge.
// Moved unchanged from scripts/brain-v2-swedish-verification.test.ts (no runner dependency).
process.env.NODE_ENV = 'test';
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'ODINLINK_SHARED_PG']) delete process.env[key];

test('native continuity forwards its own preceding turns and clarifies an unresolved follow-up in the active language', async () => {
  const { HELD_OUT } = await import('./brain/phase4/held-out');
  const { runCustomerEntry } = await import('../../tests/helpers/brain-v2-swedish-customer');
  for (const [language, channel] of [['sv', 'telegram'], ['ar', 'whatsapp']] as const) {
    const [first, follow] = HELD_OUT.find(row => row.language === language)!.turns;
    let history: Array<{ role: string; content: string }> = [];
    let following = false;
    let followEvidenceCalls = 0;
    const result = await runCustomerEntry(async request => {
      const input = request.messages[0].content;
      if (request.systemInstruction?.includes('language-routing classifier')) {
        return { text: JSON.stringify({ language, confidence: 0.99, requestedReplyLanguage: null }), functionCalls: [] };
      }
      if (request.structuredOutput?.name === 'odinlink_knowledge_planning_v2') {
        const packet = JSON.parse(input);
        if (packet.question === follow.text.replace(/؟/gu, '?')) {
          following = true;
          history = packet.referenceHistory;
          return { text: JSON.stringify({ canonicalMeaning: packet.question, queries: [], queryLanguages: {},
            requestKind: 'BUSINESS_INFORMATION', referenceResolution: 'UNRESOLVED', requestedFacets: [] }), functionCalls: [] };
        }
      }
      if (following) followEvidenceCalls++;
      throw Error('OFFLINE_NO_PROVIDER');
    }, { channel, conversation: [first.text, follow.text], foreign: true });
    assert.deepEqual(history, [{ role: 'user', content: first.text }, { role: 'assistant', content: result.replies[0] }]);
    assert.equal(followEvidenceCalls, 0);
    const stageDeadlines = result.events.filter(e => e.stage === 'planning' && e.eventType === 'transport');
    assert.ok(stageDeadlines.length > 0);
    assert.ok(stageDeadlines.every(e => e.timeoutMs === 2500));
    assert.match(result.candidate, language === 'sv' ? /Vad syftar du på/ : /ما المقصود/);
    assert.ok(result.sources.every(source => source.sourceId !== 'decoy'));
  }
});

test('native continuity carries the resolved referent and condition to scoped extraction', async () => {
  const { HELD_OUT } = await import('./brain/phase4/held-out');
  const { runCustomerEntry } = await import('../../tests/helpers/brain-v2-swedish-customer');
  for (const [language, channel, description, query] of [
    ['sv', 'telegram', 'Måste jag komma en kvart i förväg om jag redan har fyllt i blanketten?', 'fyllt i formuläret'],
    ['ar', 'whatsapp', 'هل يجب إحضار إيصال الدفع إذا دفع شخص آخر؟', 'betalningskvitto'],
  ] as const) {
    const [first, follow] = HELD_OUT.find(row => row.language === language)!.turns;
    let following = false;
    let extraction: any;
    const result = await runCustomerEntry(async request => {
      if (request.systemInstruction?.includes('language-routing classifier'))
        return { text: JSON.stringify({ language, confidence: 0.99, requestedReplyLanguage: null }), functionCalls: [] };
      if (request.structuredOutput?.name === 'odinlink_knowledge_planning_v2') {
        const input = JSON.parse(request.messages[0].content);
        if (input.question === follow.text.replace(/؟/gu, '?')) {
          following = true;
          return { text: JSON.stringify({ canonicalMeaning: description, queries: [query], queryLanguages: [{ query, language: 'sv' }],
            requestKind: 'BUSINESS_INFORMATION', referenceResolution: 'RESOLVED',
            requestedFacets: [{ subject: 'visit policy', attribute: description, questionType: 'requirement',
              obligations: [{ description, questionType: 'requirement' }] }] }), functionCalls: [] };
        }
      }
      if (following && request.structuredOutput?.name === 'odinlink_knowledge_extraction_v2')
        extraction = JSON.parse(request.messages[0].content);
      throw Error('OFFLINE_NO_PROVIDER');
    }, { channel, conversation: [first.text, follow.text], foreign: true });
    assert.equal(extraction?.requestedLanguage, language);
    assert.equal(extraction.facets[0].obligations[0].description, description);
    assert.equal(extraction.relevantHistory[0].content, first.text);
    assert.equal(extraction.relevantHistory[1].content, result.replies[0]);
    assert.ok(extraction.evidence.every((item: { businessId: number; text: string }) =>
      item.businessId === 77 && !item.text.includes('90 minuter')));
    assert.match(extraction.evidence.map((item: { text: string }) => item.text).join(' '), new RegExp(query, 'i'));
  }
});

test('reference clarification copy is specific to the missing referent and never repeats verbatim', async () => {
  const { HELD_OUT } = await import('./brain/phase4/held-out');
  const ar = HELD_OUT.find(row => row.language === 'ar')!.turns[1].text;
  const sv = HELD_OUT.find(row => row.language === 'sv')!.turns[1].text;
  // Arabic object suffix ("bring it") is a reference; the self-contained question is not.
  assert.equal(hasConversationReference(ar), true);
  assert.equal(hasConversationReference('هل يجب إحضار إيصال الدفع إذا دفع شخص آخر؟'), false);
  assert.equal(referenceClarificationReply('ar', false, ar), 'ما المقصود تحديدًا؟ ما الشيء الذي تسأل عنه؟');
  assert.equal(referenceClarificationReply('ar', true, ar), 'يرجى ذكر الشيء الذي تقصد إحضاره أو تقديمه.');
  assert.equal(referenceClarificationReply('sv', false, sv), 'Vad syftar du på? Vilken av frågorna menar du?');
  assert.equal(referenceClarificationReply('sv', true, sv), 'Ange vilken av frågorna du menar, så hjälper jag dig.');
  // Without those cues every language keeps its existing generic copy.
  for (const language of ['en', 'sv', 'de', 'es', 'fa', 'ar'])
    for (const repeated of [false, true])
      assert.equal(referenceClarificationReply(language, repeated, 'Is it there?'), referenceClarificationReply(language, repeated));
  // A second clarification is a concrete instruction, never the same question again.
  for (const [language, text] of [['ar', ar], ['sv', sv], ['en', 'Is it there?']] as const)
    assert.notEqual(referenceClarificationReply(language, true, text), referenceClarificationReply(language, false, text));
});
