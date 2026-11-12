// Configurable production default model (minimal, provider-agnostic).
//
// Reuses the existing provider abstraction (providers/router.ts + adapters).
// This module only answers: which already-validated model is the default, and
// may it serve a metered Knowledge stage without a budget-owner permit?
// With no new configuration, behavior is exactly as before (OPENAI_MODEL, else Luna).

export type AiRoutingProvider = 'openai' | 'gemini';

/** Metered evidence-first Knowledge stages vs. everything else. */
export type ModelStage = 'general' | 'knowledge_extraction' | 'knowledge_re_extraction' | 'knowledge_verification';
export const FINANCIALLY_CONTROLLED_STAGES: ReadonlySet<ModelStage> =
  new Set(['knowledge_extraction', 'knowledge_re_extraction', 'knowledge_verification']);

export type ModelDescriptor = Readonly<{
  id: string;
  provider: AiRoutingProvider;
  /** Model controls the adapter has been validated to send for this model. */
  capabilities: Readonly<{ toolCalling: boolean; strictStructuredOutput: boolean; reasoningEffortLow: boolean }>;
  /** 'knowledge-budget-owner': metered Knowledge stages on this model are
   * dispatchable ONLY through a captured, owner-reserved permit. */
  knowledgeFinancialControl: 'none' | 'knowledge-budget-owner';
}>;

/** Models proven compatible with the production adapters. Supporting another
 * model or provider = one validated entry here (+ its adapter tests). */
export const MODEL_CATALOG: Readonly<Record<string, ModelDescriptor>> = Object.freeze({
  'gpt-5.6-luna': Object.freeze({ id: 'gpt-5.6-luna', provider: 'openai',
    capabilities: Object.freeze({ toolCalling: true, strictStructuredOutput: true, reasoningEffortLow: true }), knowledgeFinancialControl: 'none' }),
  'gpt-6.1-sol': Object.freeze({ id: 'gpt-6.1-sol', provider: 'openai',
    capabilities: Object.freeze({ toolCalling: true, strictStructuredOutput: true, reasoningEffortLow: true }), knowledgeFinancialControl: 'knowledge-budget-owner' }),
} as const);

/** Known-good model: the unset default, the rollback target and the only
 * permit-free substitute for a metered Knowledge stage. */
export const BASELINE_MODEL = 'gpt-5.6-luna';
/** The only model the durable Knowledge owner's rates/receipts cover. */
export const MANAGED_KNOWLEDGE_MODEL = 'gpt-6.1-sol';

export type DefaultModelConfiguration = Readonly<{ model: string; source: 'configured' | 'legacy_env' | 'baseline' }>;
export type DefaultModelResult = Readonly<{ ok: true; config: DefaultModelConfiguration }> | Readonly<{ ok: false; errors: readonly string[] }>;

/** Pure, content-free validation of ODINLINK_AI_DEFAULT_MODEL. */
export function readDefaultModelConfiguration(env: NodeJS.ProcessEnv = process.env): DefaultModelResult {
  const configured = String(env.ODINLINK_AI_DEFAULT_MODEL ?? '').trim();
  const provider = String(env.AI_PROVIDER ?? '').trim().toLowerCase() || 'openai';
  if (!configured) {
    // Previous behavior, unchanged and unvalidated: deploying this code can never alter or block the current model.
    const legacy = String(env.OPENAI_MODEL ?? '').trim();
    return Object.freeze({ ok: true, config: Object.freeze(legacy ? { model: legacy, source: 'legacy_env' as const } : { model: BASELINE_MODEL, source: 'baseline' as const }) });
  }
  const errors: string[] = [];
  const model = MODEL_CATALOG[configured];
  if (!model) errors.push('default_unsupported_model');
  else if (model.provider !== provider) errors.push('default_provider_mismatch');
  // The legacy managed profile and the tenant canary are alternatives to a Sol default; both at once is ambiguous.
  if (model?.knowledgeFinancialControl === 'knowledge-budget-owner') {
    if (env.ODINLINK_KNOWLEDGE_MODEL_PROFILE && env.ODINLINK_KNOWLEDGE_MODEL_PROFILE !== 'off') errors.push('conflicting_legacy_knowledge_profile');
    if (env.ODINLINK_SOL_EXTRACTION_MODE === 'active' || env.ODINLINK_SOL_EXTRACTION_MODE === 'shadow') errors.push('conflicting_sol_extraction_canary');
  }
  if (errors.length) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  return Object.freeze({ ok: true, config: Object.freeze({ model: configured, source: 'configured' as const }) });
}

export class DefaultModelConfigurationError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`ai_default_model_invalid_configuration: ${codes.join(',')}`);
    this.name = 'DefaultModelConfigurationError';
  }
}

/** Boot gate: an invalid default refuses to start the process (the previous
 * healthy instance keeps serving) instead of guessing a model. */
export function assertDefaultModelConfiguration(env: NodeJS.ProcessEnv = process.env): DefaultModelConfiguration {
  const result = readDefaultModelConfiguration(env);
  if (!result.ok) throw new DefaultModelConfigurationError(result.errors);
  return result.config;
}

/** Maps the host's existing stage names (or, when absent, the structured-output
 * contract) onto the metered Knowledge stages. Everything else is 'general'. */
export function modelStageFor(contextStage?: string, structuredOutputName?: string): ModelStage {
  const stage = String(contextStage ?? '').trim();
  if (stage === 'knowledge_units_extraction') return 'knowledge_extraction';
  if (stage === 'knowledge_units_re_extraction') return 'knowledge_re_extraction';
  if (stage === 'knowledge_units_verification') return 'knowledge_verification';
  if (stage) return 'general';
  const name = String(structuredOutputName ?? '').trim();
  if (/^odinlink_knowledge_(?:extraction|documentary_partition)|^odinlink_natural_extraction/u.test(name)) return 'knowledge_extraction';
  if (/^odinlink_knowledge_(?:verification|source_exhaustive)/u.test(name)) return 'knowledge_verification';
  return 'general';
}

/** Knowledge stage contracts (extraction / verification schema families). */
export function isKnowledgeStageSchema(name?: string): boolean {
  return /^odinlink_knowledge_|^odinlink_natural_extraction/u.test(String(name ?? '').trim());
}

export type ModelRoute = Readonly<{ model: string; stage: ModelStage; selected: string; fallbackReason?: 'financial_control_unavailable' }>;

/** Pre-dispatch selection only; a provider failure never re-sends on another model.
 * A financially controlled default reaches a metered Knowledge stage only with
 * an owner permit; otherwise that request uses the baseline (Luna). */
export function routeDefaultModel(stage: ModelStage = 'general', financialPermit = false, env: NodeJS.ProcessEnv = process.env): ModelRoute {
  const result = readDefaultModelConfiguration(env);
  if (!result.ok) throw new DefaultModelConfigurationError(result.errors);
  const selected = result.config.model;
  if (FINANCIALLY_CONTROLLED_STAGES.has(stage) && !financialPermit &&
      MODEL_CATALOG[selected]?.knowledgeFinancialControl === 'knowledge-budget-owner')
    return Object.freeze({ model: BASELINE_MODEL, stage, selected, fallbackReason: 'financial_control_unavailable' as const });
  return Object.freeze({ model: selected, stage, selected });
}

/** True when ODINLINK_AI_DEFAULT_MODEL explicitly selects the owner-metered
 * model, i.e. the production managed Knowledge profile may be captured. A
 * legacy OPENAI_MODEL never enables it. */
export function managedKnowledgeDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const result = readDefaultModelConfiguration(env);
  return result.ok && result.config.source === 'configured' && result.config.model === MANAGED_KNOWLEDGE_MODEL;
}

export function modelDescriptor(id: string): ModelDescriptor | undefined {
  return MODEL_CATALOG[id];
}

/** Content-free startup summary. */
export function describeDefaultModel(env: NodeJS.ProcessEnv = process.env) {
  const result = readDefaultModelConfiguration(env);
  return result.ok
    ? Object.freeze({ status: 'ok' as const, model: result.config.model, source: result.config.source, managedKnowledge: managedKnowledgeDefault(env) })
    : Object.freeze({ status: 'invalid' as const, errors: result.errors });
}
