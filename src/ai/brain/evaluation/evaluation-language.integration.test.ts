/** Server-side reply-language authority, exercised through the existing
 * test-only boundary. The semantic LLM resolver is withheld and counted. */
process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS } from './corpus';
import { evaluateServerLanguage } from './tier1-language';

test('language: model-dependent resolution is never graded PASS; multi-turn sessions replay earlier turns', async t => {
  for (const k of ['log', 'info', 'warn', 'debug'] as const) t.mock.method(console, k, () => {});
  const cases = CORPUS.filter(c => ['dir-28', 'dir-05', 'mt-26', 'mix-09', 'act-04'].includes(c.id));
  const results = await evaluateServerLanguage(cases);
  assert.equal(results.size, cases.length);
  for (const [id, r] of results) {
    const ev = r.evidence as any;
    if (ev.semanticResolverConsulted) assert.equal(r.grade, 'INDETERMINATE', id);
    else assert.ok(['PASS', 'FAIL'].includes(r.grade), id);
    assert.ok(r.exercised!.some(x => x.startsWith('server.prepareConversationLanguageForTurn')));
  }
});
