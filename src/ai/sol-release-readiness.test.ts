/** Release gates: global accuracy-first eligibility (scales to any number of
 * businesses) stays independent of bounded admission, and the financial owner's
 * tenant set refreshes without a restart while failing safe. */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyFirstEnabled, knowledgeAdmission } from './knowledge-timing-policy';
import { AiRequestQueue } from './request-queue';
import { knowledgeBudgetOwnerRefreshMs, refreshConfiguredKnowledgeBudgetOwner, type AiMoneyDatabase } from './durable-knowledge-budget-owner';
import { captureKnowledgeModelProfile, configureKnowledgeBudgetOwner, KNOWLEDGE_SOL_PRODUCTION_PROFILE, KNOWLEDGE_SOL_RATES } from './knowledge-model-policy';

const GLOBAL = { ODINLINK_KNOWLEDGE_TIMING_POLICY: 'accuracy-first-v1', ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: 'all' };
afterEach(() => configureKnowledgeBudgetOwner());

test('global eligibility: every valid business (500+, newly onboarded) without a list; policy gate still applies', () => {
  for (const id of [1, 3, 77, 500, 501, 123_456]) assert.equal(accuracyFirstEnabled(id, GLOBAL), true, String(id));
  for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(accuracyFirstEnabled(id, GLOBAL), false, String(id));
  assert.equal(accuracyFirstEnabled(3, { ...GLOBAL, ODINLINK_KNOWLEDGE_TIMING_POLICY: 'off' }), false);
  assert.equal(accuracyFirstEnabled(3, { ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: 'all' }), false);
  for (const value of ['ALL', ' all', 'all,3', '*']) assert.equal(accuracyFirstEnabled(3, { ...GLOBAL, ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: value }), false, value);
  // Explicit lists keep their existing bounded semantics.
  assert.equal(accuracyFirstEnabled(3, { ...GLOBAL, ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3,8' }), true);
  assert.equal(accuracyFirstEnabled(4, { ...GLOBAL, ODINLINK_KNOWLEDGE_TIMING_TENANT_IDS: '3,8' }), false);
});

test('eligibility never widens admission: bounded active/waiting slots, fail-fast overload, cancellation frees a waiter', async () => {
  const saved = { a: process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS, w: process.env.KNOWLEDGE_MAX_WAITING_REQUESTS };
  try {
    delete process.env.KNOWLEDGE_MAX_ACTIVE_REQUESTS; delete process.env.KNOWLEDGE_MAX_WAITING_REQUESTS;
    const queue = knowledgeAdmission();
    assert.deepEqual([queue.snapshot().concurrency, queue.snapshot().maxWaiting], [1, 3]);
    Object.assign(process.env, { KNOWLEDGE_MAX_ACTIVE_REQUESTS: '500', KNOWLEDGE_MAX_WAITING_REQUESTS: '500' });
    const capped = knowledgeAdmission();
    assert.deepEqual([capped.snapshot().concurrency, capped.snapshot().maxWaiting], [3, 12], 'hard caps hold whatever the tenant count');
  } finally {
    for (const [k, v] of [['KNOWLEDGE_MAX_ACTIVE_REQUESTS', saved.a], ['KNOWLEDGE_MAX_WAITING_REQUESTS', saved.w]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  // 500 simultaneous eligible turns against a 1-active/3-waiting queue.
  const queue = new AiRequestQueue(1, 3);
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const cancel = new AbortController();
  const results = Array.from({ length: 500 }, (_, i) => queue.run(() => gate, undefined, i === 2 ? cancel.signal : undefined)
    .then(() => 'done', (e: Error) => e?.message ?? 'aborted'));
  await Promise.resolve();
  assert.deepEqual(queue.snapshot(), { active: 1, waiting: 3, concurrency: 1, maxWaiting: 3 });
  cancel.abort(new Error('turn_deadline'));
  await Promise.resolve();
  assert.equal(queue.snapshot().waiting, 2, 'a cancelled waiter leaves immediately');
  release();
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(o => o === 'done').length, 3);
  assert.equal(outcomes.filter(o => o === 'knowledge_admission_overload').length, 496, 'overflow fails fast, never queues unboundedly');
  assert.equal(outcomes[2], 'turn_deadline');
  assert.deepEqual(queue.snapshot(), { active: 0, waiting: 0, concurrency: 1, maxWaiting: 3 });
});

function moneyDb(state: { businessIds: number[] | null; pending?: Promise<void>; calls: number }): AiMoneyDatabase {
  return { rpc(_name, args) {
    state.calls++;
    assert.equal(args.p_command, 'configuration');
    const result = (async () => {
      await state.pending;
      return { data: state.businessIds === null ? null : { ownerId: 'owner-1', approvalReference: 'APPROVAL-1', ratesVersion: KNOWLEDGE_SOL_RATES.version,
        providerProjectId: 'proj_offlineTest', billingProfile: 'openai-standard-nonregional-30m-v1', maximumRequestNanoUsd: 300_000_000,
        maximumTurnNanoUsd: 900_000_000, businessIds: state.businessIds }, error: null };
    })();
    return result as never;
  } };
}
const ENV = { ODINLINK_AI_MONEY_ACCOUNT: 'acct-1', ODINLINK_AI_MONEY_APPROVAL: 'APPROVAL-1' };
const PROD = { ODINLINK_AI_DEFAULT_MODEL: 'gpt-6.1-sol' };
const turn = (businessId: number, turnId = 't-' + businessId) => ({ businessId, turnId, requestKey: 'a'.repeat(64), provider: 'openai', nativeForeground: true,
  natural: false, durable: false, extractionProtocol: 'v2', verificationProtocol: 'source-exhaustive-v2', documentary: true, operational: false, current: async () => true });

test('owner refresh: a newly entitled business gets Sol without a restart; revocation fails safe', async () => {
  const state: { businessIds: number[] | null; pending?: Promise<void>; calls: number } = { businessIds: [3], calls: 0 };
  const db = moneyDb(state);
  assert.equal(await refreshConfiguredKnowledgeBudgetOwner(db, ENV), true);
  assert.equal(captureKnowledgeModelProfile(turn(3), PROD).id, KNOWLEDGE_SOL_PRODUCTION_PROFILE);
  assert.deepEqual(captureKnowledgeModelProfile(turn(501), PROD), { id: 'default', managedFallback: 'budget_owner_tenant' });
  state.businessIds = [3, 501];   // onboarding: entitlement row inserted in the database
  assert.equal(await refreshConfiguredKnowledgeBudgetOwner(db, ENV), true);
  assert.equal(captureKnowledgeModelProfile(turn(501, 'after-refresh'), PROD).id, KNOWLEDGE_SOL_PRODUCTION_PROFILE);
  // While a refresh is pending the current owner stays selectable (no flapping to Luna).
  let unblock!: () => void; state.pending = new Promise<void>(r => { unblock = r; });
  const pending = refreshConfiguredKnowledgeBudgetOwner(db, ENV);
  assert.equal(captureKnowledgeModelProfile(turn(3, 'during-refresh'), PROD).id, KNOWLEDGE_SOL_PRODUCTION_PROFILE);
  unblock(); await pending; state.pending = undefined;
  // Operator disabled / authority revoked: configuration returns null -> no owner.
  state.businessIds = null;
  await assert.rejects(refreshConfiguredKnowledgeBudgetOwner(db, ENV));
  assert.deepEqual(captureKnowledgeModelProfile(turn(3, 'after-revoke'), PROD), { id: 'default', managedFallback: 'budget_owner_unavailable' });
  // Financial settings removed: owner uninstalled, no RPC.
  state.businessIds = [3]; await refreshConfiguredKnowledgeBudgetOwner(db, ENV);
  const before = state.calls;
  assert.equal(await refreshConfiguredKnowledgeBudgetOwner(db, {}), false);
  assert.equal(state.calls, before);
  assert.deepEqual(captureKnowledgeModelProfile(turn(3, 'no-env'), PROD), { id: 'default', managedFallback: 'budget_owner_unavailable' });
});

test('an older slow refresh can never overwrite a newer decision', async () => {
  const slow = { businessIds: [3, 9] as number[] | null, calls: 0 } as { businessIds: number[] | null; pending?: Promise<void>; calls: number };
  let unblock!: () => void; slow.pending = new Promise<void>(r => { unblock = r; });
  const older = refreshConfiguredKnowledgeBudgetOwner(moneyDb(slow), ENV);
  assert.equal(await refreshConfiguredKnowledgeBudgetOwner(moneyDb({ businessIds: [3], calls: 0 }), {}), false);
  unblock();
  assert.equal(await older, false);
  assert.deepEqual(captureKnowledgeModelProfile(turn(9), PROD), { id: 'default', managedFallback: 'budget_owner_unavailable' });
});

test('refresh interval is bounded', () => {
  assert.equal(knowledgeBudgetOwnerRefreshMs(undefined), 300_000);
  assert.equal(knowledgeBudgetOwnerRefreshMs('1000'), 60_000);
  assert.equal(knowledgeBudgetOwnerRefreshMs('99999999'), 3_600_000);
  assert.equal(knowledgeBudgetOwnerRefreshMs('5m'), 300_000);
});
