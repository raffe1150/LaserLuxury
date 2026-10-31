import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyFirstEnabled } from './knowledge-timing-policy';

const env = {
  ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1',
  ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3',
} as NodeJS.ProcessEnv;

test('verified tenant 3 is eligible for accuracy-first timing', () => {
  assert.equal(accuracyFirstEnabled(3, env), true);
});

test('unknown and other tenants cannot enroll', () => {
  for (const id of [0, 4, NaN, -1]) {
    assert.equal(accuracyFirstEnabled(id, env), false);
  }
});

test('invalid enrollment fails closed', () => {
  assert.equal(accuracyFirstEnabled(3, {
    ...env,
    ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3,invalid',
  }), false);
});
