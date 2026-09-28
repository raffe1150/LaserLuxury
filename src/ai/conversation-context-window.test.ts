import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecentConversationHistory } from './conversation-context-window';

test('conversation context keeps only the latest 20 messages', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index + 1}`,
  }));

  const result = buildRecentConversationHistory(history);

  assert.equal(result.length, 20);
  assert.equal(result[0].content, 'message-11');
  assert.equal(result[19].content, 'message-30');
});

test('conversation context leaves short histories intact without mutating input', () => {
  const history = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];

  const snapshot = structuredClone(history);
  const result = buildRecentConversationHistory(history);

  assert.deepEqual(result, snapshot);
  assert.deepEqual(history, snapshot);
  assert.notEqual(result, history);
});
