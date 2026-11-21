/** Tenant-scoped 75 s async window and the host tick bound (offline, no database). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeAsyncControls, nativeExecutionMsFor, nativeMaxExecutionMs } from './native-knowledge-runtime';
import { knowledgeCycleTimeoutMs, knowledgeExecutionDeadline, KNOWLEDGE_OPERATION_LIMITS } from './knowledge-operation';

test('extended window: absent by default; only 75000 with an explicit tenant list; other tenants keep the global window', () => {
  const base = nativeAsyncControls({});
  assert.equal(base.extended, undefined); assert.equal(nativeExecutionMsFor(base, 3), 20000); assert.equal(nativeMaxExecutionMs(base), 20000);
  const env = { ODINLINK_ASYNC_KNOWLEDGE_EXECUTION_MS: '40000', ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS: '75000', ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_TENANTS: '3' };
  const c = nativeAsyncControls(env);
  assert.deepEqual([nativeExecutionMsFor(c, 3), nativeExecutionMsFor(c, 4), nativeMaxExecutionMs(c)], [75000, 40000, 75000]);
  assert.equal(nativeAsyncControls({ ...env, ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_TENANTS: '' }).extended, undefined, 'no tenant list => OFF');
  for (const bad of ['60000', '120000', '75001', 'x']) assert.throws(() => nativeAsyncControls({ ...env, ODINLINK_ASYNC_KNOWLEDGE_EXTENDED_EXECUTION_MS: bad }), /knowledge_invalid_execution_limit/u);
  assert.throws(() => nativeAsyncControls({ ODINLINK_ASYNC_KNOWLEDGE_EXECUTION_MS: '75000' }), /knowledge_invalid_execution_limit/u, 'global allow-list unchanged');
});

test('75 s budget: 15 s lifecycle reserve kept outside compute; tick bound contains the whole lifecycle', () => {
  const acceptedAt = 1_000_000, expiresAt = acceptedAt + 75_000;
  assert.equal(knowledgeExecutionDeadline({ acceptedAt, expiresAt }) - acceptedAt, 60_000, 'compute window');
  assert.equal(expiresAt - knowledgeExecutionDeadline({ acceptedAt, expiresAt }), 15_000, 'lifecycle/delivery reserve, unchanged');
  assert.equal(knowledgeCycleTimeoutMs(75_000), 75_000 + 2 * KNOWLEDGE_OPERATION_LIMITS.databaseMs + 1000);
  for (const ms of [20_000, 30_000, 35_000, 40_000]) assert.equal(knowledgeCycleTimeoutMs(ms), KNOWLEDGE_OPERATION_LIMITS.cycleMs, 'existing windows: unchanged 60 s tick');
  assert.throws(() => knowledgeCycleTimeoutMs(120_001), /knowledge_invalid_execution_limit/u);
});
