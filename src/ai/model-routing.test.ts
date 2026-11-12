import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDefaultModelConfiguration, BASELINE_MODEL, DefaultModelConfigurationError, describeDefaultModel, managedKnowledgeDefault,
  modelStageFor, readDefaultModelConfiguration, routeDefaultModel, type ModelStage } from './model-routing';
import { readStructuredUnderstandingConfiguration } from './understanding/config';

const SOL = 'gpt-6.1-sol', LUNA = 'gpt-5.6-luna';
const SOL_DEFAULT = { ODINLINK_AI_DEFAULT_MODEL: SOL };
const METERED: ModelStage[] = ['knowledge_extraction', 'knowledge_re_extraction', 'knowledge_verification'];
const errors = (env: NodeJS.ProcessEnv) => { const r = readDefaultModelConfiguration(env); return r.ok ? [] : [...r.errors]; };

test('unset: exactly the previous resolver (OPENAI_MODEL, else Luna); nothing managed', () => {
  for (const stage of ['general', ...METERED] as ModelStage[]) assert.deepEqual(routeDefaultModel(stage, false, {}), { model: LUNA, stage, selected: LUNA });
  assert.equal(BASELINE_MODEL, LUNA);
  assert.equal(routeDefaultModel('general', false, { OPENAI_MODEL: 'gpt-4.1' }).model, 'gpt-4.1');
  assert.equal(routeDefaultModel('knowledge_extraction', false, { OPENAI_MODEL: 'unlisted' }).model, 'unlisted');
  assert.equal(managedKnowledgeDefault({}), false);
  assert.equal(managedKnowledgeDefault({ OPENAI_MODEL: SOL }), false, 'a legacy OPENAI_MODEL never enables managed Knowledge');
});

test('inherited legacy Sol never reaches a metered Knowledge stage without a permit (safety fix)', () => {
  const r = routeDefaultModel('knowledge_verification', false, { OPENAI_MODEL: SOL });
  assert.deepEqual([r.model, r.fallbackReason], [LUNA, 'financial_control_unavailable']);
});

test('Sol default: every non-metered stage on Sol; metered stages Sol only with an owner permit', () => {
  assert.equal(routeDefaultModel('general', false, SOL_DEFAULT).model, SOL);
  for (const stage of METERED) {
    assert.equal(routeDefaultModel(stage, true, SOL_DEFAULT).model, SOL);
    const r = routeDefaultModel(stage, false, SOL_DEFAULT);
    assert.deepEqual([r.model, r.selected, r.fallbackReason], [LUNA, SOL, 'financial_control_unavailable']);
  }
  assert.equal(managedKnowledgeDefault(SOL_DEFAULT), true);
});

test('unsupported model/provider or conflicting Sol flags are rejected at startup with content-free codes', () => {
  const cases: Array<[NodeJS.ProcessEnv, string]> = [
    [{ ODINLINK_AI_DEFAULT_MODEL: 'gpt-7-astra' }, 'default_unsupported_model'],
    [{ ODINLINK_AI_DEFAULT_MODEL: 'gpt-6-sol' }, 'default_unsupported_model'],
    [{ ODINLINK_AI_DEFAULT_MODEL: 'gemini-2.5-flash' }, 'default_unsupported_model'],
    [{ ODINLINK_AI_DEFAULT_MODEL: SOL, AI_PROVIDER: 'gemini' }, 'default_provider_mismatch'],
    [{ ...SOL_DEFAULT, ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'sol-low-v1' }, 'conflicting_legacy_knowledge_profile'],
    [{ ...SOL_DEFAULT, ODINLINK_SOL_EXTRACTION_MODE: 'active' }, 'conflicting_sol_extraction_canary'],
    [{ ...SOL_DEFAULT, ODINLINK_SOL_EXTRACTION_MODE: 'shadow' }, 'conflicting_sol_extraction_canary'],
  ];
  for (const [env, code] of cases) {
    assert.ok(errors(env).includes(code), `${JSON.stringify(env)} -> ${errors(env)}`);
    assert.throws(() => assertDefaultModelConfiguration(env), DefaultModelConfigurationError);
    assert.throws(() => routeDefaultModel('general', false, env), DefaultModelConfigurationError);
    assert.equal(managedKnowledgeDefault(env), false);
  }
  assert.deepEqual(errors({ ...SOL_DEFAULT, ODINLINK_SOL_EXTRACTION_MODE: 'off', ODINLINK_KNOWLEDGE_MODEL_PROFILE: 'off' }), []);
  assert.deepEqual(errors({ ODINLINK_AI_DEFAULT_MODEL: LUNA, ODINLINK_SOL_EXTRACTION_MODE: 'active' }), [], 'Luna default keeps the canary usable');
});

test('rollback: ODINLINK_AI_DEFAULT_MODEL=gpt-5.6-luna (or unset) returns every stage to Luna', () => {
  for (const env of [{ ODINLINK_AI_DEFAULT_MODEL: LUNA }, {}])
    for (const stage of ['general', ...METERED] as ModelStage[]) assert.equal(routeDefaultModel(stage, false, env).model, LUNA);
  assert.equal(managedKnowledgeDefault({ ODINLINK_AI_DEFAULT_MODEL: LUNA }), false);
});

test('host stage names and contracts map onto metered Knowledge stages; all else is general', () => {
  const map: Array<[string | undefined, string | undefined, ModelStage]> = [
    ['knowledge_units_extraction', undefined, 'knowledge_extraction'], ['knowledge_units_re_extraction', undefined, 'knowledge_re_extraction'],
    ['knowledge_units_verification', undefined, 'knowledge_verification'], ['knowledge_units_composition', undefined, 'general'],
    ['semantic_language_resolution', undefined, 'general'], ['conversation', 'odinlink_knowledge_extraction_v2', 'general'], [undefined, undefined, 'general'],
    [undefined, 'odinlink_knowledge_extraction_v2', 'knowledge_extraction'], [undefined, 'odinlink_knowledge_source_exhaustive_v2', 'knowledge_verification'],
    [undefined, 'odinlink_knowledge_verification_v2', 'knowledge_verification'], [undefined, 'odinlink_structured_understanding', 'general'],
  ];
  for (const [stage, schema, expected] of map) assert.equal(modelStageFor(stage, schema), expected, `${stage}/${schema}`);
});

test('structured understanding follows the configured default; explicit STRUCTURED_UNDERSTANDING_MODEL still wins', () => {
  // Without this, a Sol default would leave customer-turn understanding on Luna (it reads OPENAI_MODEL only).
  assert.equal(readStructuredUnderstandingConfiguration({}).model, LUNA);
  assert.equal(readStructuredUnderstandingConfiguration(SOL_DEFAULT).model, SOL);
  assert.equal(readStructuredUnderstandingConfiguration({ ...SOL_DEFAULT, STRUCTURED_UNDERSTANDING_MODEL: LUNA }).model, LUNA);
  assert.equal(readStructuredUnderstandingConfiguration({ ODINLINK_AI_DEFAULT_MODEL: LUNA, OPENAI_MODEL: SOL }).model, LUNA);
  assert.equal(readStructuredUnderstandingConfiguration({ OPENAI_MODEL: 'gpt-4.1' }).model, 'gpt-4.1');
});

test('startup summary is content-free', () => {
  const summary = describeDefaultModel({ ...SOL_DEFAULT, OPENAI_API_KEY: 'sk-secret-never-logged' });
  assert.deepEqual(summary, { status: 'ok', model: SOL, source: 'configured', managedKnowledge: true });
  assert.deepEqual(describeDefaultModel({ ODINLINK_AI_DEFAULT_MODEL: 'nope' }), { status: 'invalid', errors: ['default_unsupported_model'] });
});
