import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { captureKnowledgeModelProfile, configureKnowledgeBudgetOwner, knowledgeStageOptions, KNOWLEDGE_SOL_RATES } from './knowledge-model-policy';
import { ScriptedKnowledgeBudgetOwner } from '../../tests/helpers/knowledge-budget-owner';

const binding = { businessId: 77, turnId: 'one-native-turn', requestKey: 'a'.repeat(64) };
const input = { ...binding, provider: 'openai', nativeForeground: true, natural: false, durable: false,
  extractionProtocol: 'v2', verificationProtocol: 'v2', documentary: true, operational: false, current: async () => true };
const enabled = { ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'sol-low-v1', ODINLINK_KNOWLEDGE_SOL_TENANT_IDS: '77' };
afterEach(() => configureKnowledgeBudgetOwner());
test('disabled by default;model,language and retrieval globals are not changed', () => {
  const profile = captureKnowledgeModelProfile(input, {}); assert.equal(profile.id, 'default');
  assert.deepEqual(knowledgeStageOptions(profile, 'extraction', binding, Date.now() + 20000), {});
  assert.ok(Object.isFrozen(profile));
});
for (const [label, mutation] of Object.entries({ foreignTenant: { businessId: 88 }, noDocument: { documentary: false },
  ordinaryConversation: { nativeForeground: false }, natural: { natural: true }, durable: { durable: true },
  operational: { operational: true }, otherProvider: { provider: 'gemini' }, literal: { extractionProtocol: 'literal-evidence-v1' },
  witness: { verificationProtocol: 'coverage-witness-v1' }, compact: { verificationProtocol: 'compact-v1' } })) {
  test(`scope exclusion:${label}`, () => assert.equal(captureKnowledgeModelProfile({ ...input, ...mutation }, enabled).id, 'default'));
}
test('enable/enrollment alone cannot activateSol without approved production financial owner', () => {
  const p = captureKnowledgeModelProfile(input, enabled); assert.equal(p.activationBlock, 'budget_owner_unavailable');
  for (const stage of ['extraction', 'verification']) assert.throws(() => knowledgeStageOptions(p, stage, binding, Date.now() + 20000), /budget_owner_unavailable/u);
});
test('owner enrollment isindependent of profile tenant list', () => {
  const owner = new ScriptedKnowledgeBudgetOwner(); owner.businessIds = [88]; configureKnowledgeBudgetOwner(owner);
  const p = captureKnowledgeModelProfile(input, enabled); assert.equal(p.activationBlock, 'budget_owner_tenant');
});
test('missing backend source/current-message checker cannot activate profile', () => {
  configureKnowledgeBudgetOwner(new ScriptedKnowledgeBudgetOwner());
  const p = captureKnowledgeModelProfile({ ...input, current: undefined }, enabled);
  assert.equal(p.activationBlock, 'source_check_unavailable');
});
test('paired stage options are explicit,opaque and bound tosame immutable turn', () => {
  configureKnowledgeBudgetOwner(new ScriptedKnowledgeBudgetOwner()); const p = captureKnowledgeModelProfile(input, enabled);
  for (const stage of ['extraction', 'verification']) {
    const r = knowledgeStageOptions(p, stage, binding, Date.now() + 19000);
    assert.equal(r.model, 'gpt-6.1-sol'); assert.equal(r.reasoningEffort, 'low'); assert.equal(r.knowledgeExecution?.stage, stage);
    assert.ok(Object.isFrozen(r.knowledgeExecution));
    assert.throws(() => knowledgeStageOptions(p, stage, binding, Date.now() + 19000), /stage_already_closed/u);
  }
  for (const stage of ['language', 'planning', 'composition', 'presentation_verification', 'embedding'])
    assert.deepEqual(knowledgeStageOptions(p, stage, binding, Date.now() + 19000), {});
});
test('cross-tenant/turn/message use and copiedprofile objects fail before provider access', () => {
  configureKnowledgeBudgetOwner(new ScriptedKnowledgeBudgetOwner()); const p = captureKnowledgeModelProfile(input, enabled);
  for (const other of [{ ...binding, businessId: 88 }, { ...binding, turnId: 'other-turn' }, { ...binding, requestKey: 'b'.repeat(64) }])
    assert.throws(() => knowledgeStageOptions(p, 'extraction', other, Date.now() + 19000), /turn_binding/u);
  assert.throws(() => knowledgeStageOptions({ ...p }, 'extraction', binding, Date.now() + 19000), /turn_binding/u);
});
test('disable stops new selections;inflight capturedselection drains without changing model', () => {
  configureKnowledgeBudgetOwner(new ScriptedKnowledgeBudgetOwner()); const old = captureKnowledgeModelProfile(input, enabled);
  const fresh = captureKnowledgeModelProfile({ ...input, turnId: 'new-turn' }, { ...enabled, ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off' });
  assert.equal(fresh.id, 'default'); configureKnowledgeBudgetOwner();
  assert.equal(knowledgeStageOptions(old, 'extraction', binding, Date.now() + 19000).model, 'gpt-6.1-sol');
  assert.equal(knowledgeStageOptions(old, 'verification', binding, Date.now() + 19000).model, 'gpt-6.1-sol');
  assert.equal(captureKnowledgeModelProfile({ ...input, turnId: 'new-enabled-turn' }, enabled).activationBlock, 'budget_owner_unavailable');
});
test('unsupported enabled profile is blocked,not silently replaced withLuna', () => {
  const p = captureKnowledgeModelProfile(input, { ...enabled, ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'unsupported' });
  assert.equal(p.activationBlock, 'unsupported_profile'); assert.throws(() => knowledgeStageOptions(p, 'extraction', binding, Date.now() + 19000), /unsupported_profile/u);
});
test('owner limits/identity/rates requireexplicit backend configuration;no experimental policy is imported', () => {
  for (const [key, value] of [['approvalReference', ''], ['maximumRequestNanoUsd', 0], ['maximumTurnNanoUsd', 1], ['accounting', 'memory'], ['ratesVersion', 'Luna']]) {
    const o = new ScriptedKnowledgeBudgetOwner(); Reflect.set(o, key, value); assert.throws(() => configureKnowledgeBudgetOwner(o));
  }
  assert.equal(KNOWLEDGE_SOL_RATES.version, 'openai-sol-standard-30m-2026-10-28');
});
