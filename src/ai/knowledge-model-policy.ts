import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { knowledgeStructuredOutput } from './knowledge-answer-protocol';
import { isSourceExhaustiveProtocol } from './source-exhaustive-coverage';
import type { UnifiedAiGenerationRequest } from './providers/provider';
import { managedKnowledgeDefault } from './model-routing';

export const KNOWLEDGE_SOL_PROFILE = 'sol-low-v1' as const;
/** Extraction-only canary: Sol for extraction and one budget-owned re_extraction;
 * verification stays on the default (Luna) source-exhaustive verifier. */
export const KNOWLEDGE_SOL_EXTRACTION_PROFILE = 'sol-extraction-v1' as const;
/** Production-wide managed Knowledge profile, selected by central model routing
 * (no tenant model allowlist). Stage set, verifier protocol and owner are
 * captured pre-turn; supports the source-exhaustive verifier. */
export const KNOWLEDGE_SOL_PRODUCTION_PROFILE = 'sol-knowledge-v2' as const;
type SolProfile = typeof KNOWLEDGE_SOL_PROFILE | typeof KNOWLEDGE_SOL_EXTRACTION_PROFILE | typeof KNOWLEDGE_SOL_PRODUCTION_PROFILE;
export const KNOWLEDGE_SOL_RATES = Object.freeze({
  version: 'openai-sol-standard-30m-2026-10-28', input: 2, cacheRead: .1, cacheWrite: 2.5, output: 10,
});
type Stage = 'extraction' | 're_extraction' | 'verification';
export type KnowledgeSolStage = Stage;
export type KnowledgeModelBinding = Readonly<{ businessId: number; turnId: string; requestKey: string }>;
export type KnowledgeCostQuote = KnowledgeModelBinding & Readonly<{
  stage: Stage; model: 'gpt-6.1-sol'; requestSha256: string; reservationKey: string;
  inputTokenProxy: number; outputTokenLimit: 8192; maximumNanoUsd: number; ratesVersion: string;
  providerProjectId?: string;
  ownerId: string; approvalReference: string; maximumRequestNanoUsd: number; maximumTurnNanoUsd: number;
}>;
export type KnowledgeUsage = Readonly<{
  model: 'gpt-6.1-sol'; ownerId: string; ratesVersion: string; requestSha256: string;
  inputTokens: number; outputTokens: number; reasoningTokens: number;
  cachedTokens: number; cacheWriteTokens: number; estimatedNanoUsd: number;
  /** Authentic provider receipt identity; required by the durable owner. */
  providerResponseId?: string; providerProjectId?: string;
}>;
/** REQUIRED external trust boundary, not an implementation of durable accounting.
 * reserve must atomically enforce approved aggregate/operator/tenant/turn limits
 * and unique reservationKey across workers. Null means no hold/no admission.
 * A thrown/uncertain reserve must retain any possible hold on the owner's side.
 * settle must be atomic/idempotent; retainUnknown must NEVER release a hold.
 * No production implementation or financial approval is installed by default.
 */
export interface KnowledgeBudgetOwner {
  readonly id: string;
  readonly approvalReference: string;
  readonly accounting: 'atomic-durable';
  readonly ratesVersion: string;
  /** Approved centrally owned provider project; never a per-customer API key. */
  readonly providerProjectId?: string;
  readonly businessIds: readonly number[];
  readonly maximumRequestNanoUsd: number;
  readonly maximumTurnNanoUsd: number;
  reserve(quote: KnowledgeCostQuote, signal: AbortSignal): Promise<Readonly<{ id: string; reservationKey: string; maximumNanoUsd: number }> | null>;
  settle(id: string, quote: KnowledgeCostQuote, usage: KnowledgeUsage): Promise<void>;
  retainUnknown(quote: KnowledgeCostQuote, reservationId: string | null): Promise<void>;
}
type Owner = Readonly<KnowledgeBudgetOwner>;
let installedOwner: Owner | undefined;
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(`knowledge_sol_${code}`); }
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function withinSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('knowledge_sol_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Backend bootstrap only. No HTTP/customer/model caller; no owner is installed
 * in server.ts. A type/approval label is not proof of an owner's durability.
 * Installing a real owner requires separate operational review and limits.
 */
export function configureKnowledgeBudgetOwner(owner?: KnowledgeBudgetOwner): void {
  if (!owner) { installedOwner = undefined; return; }
  check(owner.id.trim() && owner.approvalReference.trim() && owner.accounting === 'atomic-durable', 'owner_identity');
  check(owner.ratesVersion === KNOWLEDGE_SOL_RATES.version, 'owner_rates');
  check(owner.providerProjectId === undefined || /^proj_[A-Za-z0-9_-]+$/u.test(owner.providerProjectId), 'owner_project');
  check(integer(owner.maximumRequestNanoUsd) && owner.maximumRequestNanoUsd > 0 &&
    integer(owner.maximumTurnNanoUsd) && owner.maximumTurnNanoUsd >= owner.maximumRequestNanoUsd, 'owner_limits');
  check(owner.businessIds.length && owner.businessIds.every(id => integer(id) && id > 0), 'owner_tenants');
  installedOwner = Object.freeze({ id: owner.id, approvalReference: owner.approvalReference, accounting: owner.accounting,
    ratesVersion: owner.ratesVersion, ...(owner.providerProjectId ? { providerProjectId: owner.providerProjectId } : {}), businessIds: Object.freeze([...owner.businessIds]),
    maximumRequestNanoUsd: owner.maximumRequestNanoUsd, maximumTurnNanoUsd: owner.maximumTurnNanoUsd,
    reserve: owner.reserve.bind(owner), settle: owner.settle.bind(owner), retainUnknown: owner.retainUnknown.bind(owner) });
}
export type KnowledgeModelProfile = Readonly<{ id: 'default' | SolProfile; activationBlock?: string;
  /** Pre-turn canary fallback reason (content-free). The turn runs entirely on Luna. */ canaryFallback?: string;
  /** Pre-turn production-routing fallback reason (content-free). Every Knowledge
   * stage of the turn then runs on the routing fallback model. */ managedFallback?: string }>;
/** The evidence a Sol request actually carries (id, tenant, exact text). */
export type KnowledgeRequestEvidence = Readonly<{ id: string; businessId: number; text: string }>;
type CurrentCheck = (sent: readonly KnowledgeRequestEvidence[]) => Promise<boolean>;
/** Post-reservation freshness contract. Every evidence item SENT must be one the
 * host captured for this tenant, byte-identical (tenant, text) to it, and still
 * present with the identical [tenant, source, chunk, version, text] in a fresh
 * revalidation. Sources excluded before the reservation are simply not sent and
 * therefore cannot fail the request; nothing outside the captured set can pass. */
export function sentEvidenceCurrent(sent: readonly KnowledgeRequestEvidence[], captured: readonly Readonly<{ id: string; businessId: number;
  sourceId: string; chunkId: string; version: string; text: string }>[], fresh: typeof captured, businessId: number): boolean {
  const key = (e: typeof captured[number]) => JSON.stringify([e.businessId, e.sourceId, e.chunkId, e.version, e.text]);
  const capturedById = new Map(captured.map(e => [e.id, e])), freshById = new Map(fresh.map(e => [e.id, key(e)]));
  return sent.length > 0 && new Set(sent.map(e => e.id)).size === sent.length && sent.every(item => {
    const original = capturedById.get(item.id);
    return !!original && original.businessId === businessId && item.businessId === businessId && item.text === original.text &&
      freshById.get(item.id) === key(original);
  });
}
type Selection = { binding: KnowledgeModelBinding; owner?: Owner; current?: CurrentCheck; used: Set<Stage>; settled: Set<Stage>; failed: boolean;
  /** Stages this profile dispatches on Sol through owner permits; captured once. */ managed: ReadonlySet<Stage>;
  /** Captured verifier protocol; the Sol verifier schema must match it exactly. */ verificationProtocol: string };
const LEGACY_STAGES: ReadonlySet<Stage> = new Set(['extraction', 'verification']);
const CANARY_STAGES: ReadonlySet<Stage> = new Set(['extraction', 're_extraction']);
const profiles = new WeakMap<KnowledgeModelProfile, Selection>();
const defaultProfile: KnowledgeModelProfile = Object.freeze({ id: 'default' });
export function captureKnowledgeModelProfile(input: KnowledgeModelBinding & {
  provider: string; nativeForeground: boolean; natural: boolean; durable: boolean;
  extractionProtocol: string; verificationProtocol: string; documentary: boolean; operational: boolean;
  current?: CurrentCheck;
}, env: NodeJS.ProcessEnv = process.env): KnowledgeModelProfile {
  if ((!env.ODINLINK_KNOWLEDGE_MODEL_PROFILE || env.ODINLINK_KNOWLEDGE_MODEL_PROFILE === 'off') &&
    solExtractionMode(input.businessId, env) === 'active') return captureSolExtraction(input);
  if (!env.ODINLINK_KNOWLEDGE_MODEL_PROFILE || env.ODINLINK_KNOWLEDGE_MODEL_PROFILE === 'off') {
    if (managedKnowledgeDefault(env)) return captureSolProduction(input);
  }
  if (!env.ODINLINK_KNOWLEDGE_MODEL_PROFILE || env.ODINLINK_KNOWLEDGE_MODEL_PROFILE === 'off' ||
    input.provider !== 'openai' || !input.nativeForeground || input.natural || input.durable || !input.documentary || input.operational ||
    input.extractionProtocol !== 'v2' || input.verificationProtocol !== 'v2') return defaultProfile;
  const tenants = (env.ODINLINK_KNOWLEDGE_SOL_TENANT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!tenants.includes(String(input.businessId))) return defaultProfile;
  check(integer(input.businessId) && input.businessId > 0 && input.turnId.length && /^[a-f0-9]{64}$/u.test(input.requestKey), 'turn_binding');
  const owner = installedOwner;
  const activationBlock = env.ODINLINK_KNOWLEDGE_MODEL_PROFILE !== KNOWLEDGE_SOL_PROFILE ? 'unsupported_profile' :
    !owner ? 'budget_owner_unavailable' : !owner.businessIds.includes(input.businessId) ? 'budget_owner_tenant' :
    typeof input.current !== 'function' ? 'source_check_unavailable' : undefined;
  const profile = Object.freeze({ id: KNOWLEDGE_SOL_PROFILE, ...(activationBlock ? { activationBlock } : {}) });
  profiles.set(profile, { binding: Object.freeze({ businessId: input.businessId, turnId: input.turnId, requestKey: input.requestKey }), owner,
    current: input.current, used: new Set(), settled: new Set(), failed: false, managed: LEGACY_STAGES, verificationProtocol: input.verificationProtocol });
  return profile;
}

const TENANT_LIST = /^[1-9][0-9]{0,15}$/u;
/** Backend configuration only, default OFF. Separate from the legacy managed
 * profile: ODINLINK_KNOWLEDGE_MODEL_PROFILE must stay unset/off (it is
 * process-wide incompatible with the source-exhaustive verifier). Unknown modes,
 * malformed or oversized tenant lists and non-allowlisted tenants are OFF. */
export function solExtractionMode(businessId: number, env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' | 'active' {
  const mode = env.ODINLINK_SOL_EXTRACTION_MODE;
  if ((mode !== 'shadow' && mode !== 'active') || (env.ODINLINK_KNOWLEDGE_MODEL_PROFILE && env.ODINLINK_KNOWLEDGE_MODEL_PROFILE !== 'off') ||
    !Number.isSafeInteger(businessId) || businessId <= 0) return 'off';
  const tenants = (env.ODINLINK_SOL_EXTRACTION_TENANT_IDS ?? '').split(',').map(s => s.trim());
  if (!tenants.length || tenants.length > 10 || !tenants.every(id => TENANT_LIST.test(id) && Number.isSafeInteger(Number(id)))) return 'off';
  return tenants.includes(String(businessId)) ? mode : 'off';
}
/** Canary eligibility: customer-facing native Knowledge document questions only. */
export function solExtractionEligible(input: { provider: string; nativeForeground: boolean; natural: boolean; durable: boolean;
  extractionProtocol: string; verificationProtocol: string; documentary: boolean; operational: boolean }): boolean {
  return input.provider === 'openai' && input.nativeForeground && !input.natural && !input.durable && input.documentary && !input.operational &&
    input.extractionProtocol === 'v2' && input.verificationProtocol === 'source-exhaustive-v2' && isSourceExhaustiveProtocol(input.verificationProtocol);
}
/** Pre-turn decision only. Any unavailable authority selects the unchanged
 * default (Luna) profile for the WHOLE turn; once Sol is selected, a later
 * failure fails closed and never switches models mid-turn. */
function captureSolExtraction(input: Parameters<typeof captureKnowledgeModelProfile>[0]): KnowledgeModelProfile {
  const fallback = (reason: string): KnowledgeModelProfile => Object.freeze({ id: 'default', canaryFallback: reason });
  if (!solExtractionEligible(input)) return defaultProfile;
  if (!(integer(input.businessId) && input.businessId > 0 && input.turnId.length && /^[a-f0-9]{64}$/u.test(input.requestKey))) return fallback('turn_binding');
  const owner = installedOwner;
  if (!owner) return fallback('budget_owner_unavailable');
  if (!owner.businessIds.includes(input.businessId)) return fallback('budget_owner_tenant');
  if (typeof input.current !== 'function') return fallback('source_check_unavailable');
  const profile: KnowledgeModelProfile = Object.freeze({ id: KNOWLEDGE_SOL_EXTRACTION_PROFILE });
  profiles.set(profile, { binding: Object.freeze({ businessId: input.businessId, turnId: input.turnId, requestKey: input.requestKey }), owner,
    current: input.current, used: new Set(), settled: new Set(), failed: false, managed: CANARY_STAGES, verificationProtocol: input.verificationProtocol });
  return profile;
}
const PRODUCTION_STAGES: ReadonlySet<Stage> = new Set(['extraction', 're_extraction', 'verification']);
/** Production eligibility: the native, accuracy-first, documentary Knowledge
 * path whose strict v2 extraction and v2 / source-exhaustive verifier
 * contracts are validated for owner-metered Sol dispatch. */
export function solProductionEligible(input: { provider: string; nativeForeground: boolean; natural: boolean; durable: boolean;
  extractionProtocol: string; verificationProtocol: string; documentary: boolean; operational: boolean }): boolean {
  return input.provider === 'openai' && input.nativeForeground && !input.natural && !input.durable && input.documentary && !input.operational &&
    input.extractionProtocol === 'v2' && (input.verificationProtocol === 'v2' || isSourceExhaustiveProtocol(input.verificationProtocol));
}
/** Pre-turn decision. Any unavailable authority or ineligible scope selects the
 * routing fallback for the WHOLE turn (never a mid-turn switch); once Sol is
 * selected a later failure fails closed. */
function captureSolProduction(input: Parameters<typeof captureKnowledgeModelProfile>[0]): KnowledgeModelProfile {
  const fallback = (reason: string): KnowledgeModelProfile => Object.freeze({ id: 'default', managedFallback: reason });
  if (!solProductionEligible(input)) return fallback('scope_ineligible');
  if (!(integer(input.businessId) && input.businessId > 0 && input.turnId.length && /^[a-f0-9]{64}$/u.test(input.requestKey))) return fallback('turn_binding');
  const owner = installedOwner;
  if (!owner) return fallback('budget_owner_unavailable');
  if (!owner.businessIds.includes(input.businessId)) return fallback('budget_owner_tenant');
  if (typeof input.current !== 'function') return fallback('source_check_unavailable');
  const profile: KnowledgeModelProfile = Object.freeze({ id: KNOWLEDGE_SOL_PRODUCTION_PROFILE });
  profiles.set(profile, { binding: Object.freeze({ businessId: input.businessId, turnId: input.turnId, requestKey: input.requestKey }), owner,
    current: input.current, used: new Set(), settled: new Set(), failed: false, managed: PRODUCTION_STAGES,
    verificationProtocol: input.verificationProtocol });
  return profile;
}
/** Stages a captured profile dispatches on Sol (content-free diagnostics). */
export function knowledgeManagedStages(profile: KnowledgeModelProfile | undefined): readonly Stage[] {
  const selection = profile && profiles.get(profile);
  return selection ? Object.freeze([...selection.managed]) : Object.freeze([]);
}
/** Shadow mode only: the reply turn stays on the default profile; this captures
 * a SEPARATE Sol selection for a detached, never-published extraction replay
 * of the same message (same request key, so the same per-message limits). */
export function captureSolExtractionShadow(input: Parameters<typeof captureKnowledgeModelProfile>[0], env: NodeJS.ProcessEnv = process.env): KnowledgeModelProfile {
  return solExtractionMode(input.businessId, env) === 'shadow' ? captureSolExtraction(input) : defaultProfile;
}
/** Re-extraction admission for the host: Sol extraction must have settled and
 * no stage of this turn may have failed. Never consumes or creates a permit. */
export function knowledgeReExtractionAvailable(profile: KnowledgeModelProfile | undefined): boolean {
  const selection = profile && profile.id !== 'default' ? profiles.get(profile) : undefined;
  return !!selection && selection.managed.has('re_extraction') && !selection.failed && selection.settled.has('extraction') && !selection.used.has('re_extraction');
}
export type KnowledgeExecutionPermit = Readonly<{ profile: SolProfile; stage: Stage }>;
type Permit = { selection: Selection; stage: Stage; deadlineAt: number; attempted: boolean };
const permits = new WeakMap<KnowledgeExecutionPermit, Permit>();
export function knowledgeStageOptions(profile: KnowledgeModelProfile, stage: string, binding: KnowledgeModelBinding, deadlineAt: number):
  Partial<Pick<UnifiedAiGenerationRequest, 'model' | 'reasoningEffort' | 'knowledgeExecution'>> {
  if (profile.id === 'default' || (stage !== 'extraction' && stage !== 'verification' && stage !== 're_extraction')) return {};
  const selection = profiles.get(profile);
  // Unmanaged stages keep the routing default (e.g. the extraction-only
  // canary's unchanged verifier, or an explicit stage pin to Luna).
  if (selection && stage !== 're_extraction' && !selection.managed.has(stage)) return {};
  check(selection && isDeepStrictEqual(selection.binding, binding), 'turn_binding');
  check(!profile.activationBlock && selection.owner, profile.activationBlock ?? 'budget_owner_unavailable');
  check(stage !== 're_extraction' || selection.managed.has('re_extraction'), 'stage_unsupported');
  check(!selection.failed && !selection.used.has(stage as Stage), 'stage_already_closed');
  check(stage !== 're_extraction' || selection.settled.has('extraction'), 're_extraction_without_extraction');
  check(Number.isFinite(deadlineAt) && deadlineAt > Date.now(), 'deadline');
  selection.used.add(stage as Stage);
  const permit = Object.freeze({ profile: profile.id, stage: stage as Stage });
  permits.set(permit, { selection, stage, deadlineAt, attempted: false });
  return { model: 'gpt-6.1-sol', reasoningEffort: 'low', knowledgeExecution: permit };
}
function validRequest(request: UnifiedAiGenerationRequest, state: Permit) {
  check(request.model === 'gpt-6.1-sol' && request.reasoningEffort === 'low', 'model_identity');
  const schema = request.structuredOutput;
  check(schema?.strict === true, 'strict_schema');
  const units = object(schema.schema.properties) && schema.schema.properties.units;
  const item = object(units) && object(units.items) && units.items;
  const props = object(item) && object(item.properties) && item.properties;
  const facetIds = object(props) && object(props.facetIds) && props.facetIds;
  const ids = object(facetIds) && object(facetIds.items) && facetIds.items.enum;
  const allowedIds = Array.isArray(ids) && ids.every(id => typeof id === 'string') ? ids : undefined;
  const max = object(units) && typeof units.maxItems === 'number' ? units.maxItems : 6;
  // A re-extraction is a complete fresh extraction under the same schema.
  const schemaStage = state.stage === 'verification' ? 'verification' : 'extraction';
  if (schemaStage === 'extraction') check(allowedIds && (max === 5 || max === 6), 'bounded_extraction');
  // The verifier contract is the turn's CAPTURED protocol (v2 or
  // source-exhaustive); any other schema, natural mode or witness fails closed.
  check(isDeepStrictEqual(schema, schemaStage === 'verification'
    ? knowledgeStructuredOutput('verification', false, undefined, 6, state.selection.verificationProtocol as never)
    : knowledgeStructuredOutput('extraction', false, allowedIds, max, 'v2')), 'strict_schema');
  check(!request.tools?.length && request.messages.length === 1 && request.messages[0].role === 'user', 'request_scope');
  const data: unknown = JSON.parse(request.messages[0].content);
  check(object(data) && Array.isArray(data.evidence) && data.evidence.length &&
    data.evidence.every(e => object(e) && e.businessId === state.selection.binding.businessId), 'evidence_tenant');
}
function usageOf(raw: unknown, quote: KnowledgeCostQuote, owner: Owner): KnowledgeUsage {
  check(object(raw) && raw.model === quote.model && raw.service_tier === 'default', 'receipt_identity');
  check(isDeepStrictEqual(raw.reasoning && object(raw.reasoning) ? { effort: raw.reasoning.effort } : null, { effort: 'low' }) &&
    isDeepStrictEqual(raw.prompt_cache_options, { mode: 'implicit', ttl: '30m' }), 'receipt_billing');
  const u = raw.usage; check(object(u), 'usage_missing');
  const input = u.input_tokens, output = u.output_tokens;
  check(integer(input) && input <= quote.inputTokenProxy && integer(output) && output <= 8192, 'usage_bounds');
  const detail = object(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = detail.cached_tokens, writes = detail.cache_write_tokens;
  check(integer(cached) && integer(writes) && cached + writes <= input, 'cache_usage');
  const ttl = detail.cache_write_tokens_details;
  check(!object(ttl) || !ttl.ttl_12h_tokens, 'cache_ttl');
  const reasoning = object(u.output_tokens_details) ? u.output_tokens_details.reasoning_tokens ?? 0 : 0;
  check(integer(reasoning) && reasoning <= output, 'reasoning_usage');
  // NanoUSD are exact integers. Missing billing breakdown fails closed and
  // retains the full hold; do not manufacture cache usage or use Luna rates.
  const cost = (input - cached - writes) * 2000 + cached * 100 + writes * 2500 + output * 10000;
  check(integer(cost) && cost <= quote.maximumNanoUsd, 'receipt_cost');
  return Object.freeze({ model: quote.model, ownerId: owner.id, ratesVersion: quote.ratesVersion,
    requestSha256: quote.requestSha256, inputTokens: input, outputTokens: output, reasoningTokens: reasoning,
    cachedTokens: cached, cacheWriteTokens: writes, estimatedNanoUsd: cost,
    ...(quote.providerProjectId ? { providerProjectId: quote.providerProjectId } : {}),
    ...(typeof raw.id === 'string' && /^resp_[A-Za-z0-9_-]+$/u.test(raw.id) ? { providerResponseId: raw.id } : {}) });
}
/** Only the OpenAI adapter calls this with the complete final SDK request. No
 * reserve owner means no SDK dispatch. This is not a replacement budget ledger.
 */
export async function executeKnowledgeGeneration<T>(request: UnifiedAiGenerationRequest, params: Record<string, unknown>,
  send: (wire: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, projectId?: string) => Promise<T>): Promise<{ response: T; usage: KnowledgeUsage }> {
  const state = request.knowledgeExecution && permits.get(request.knowledgeExecution);
  check(state && !state.attempted && !state.selection.failed, 'unowned_or_consumed_permit');
  state.attempted = true;
  const owner = state.selection.owner; check(owner, 'budget_owner_unavailable');
  let quote: KnowledgeCostQuote | undefined, reservationId: string | null = null, settled = false, denied = false;
  try {
    validRequest(request, state);
    check(!owner.providerProjectId || !process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT_ID === owner.providerProjectId, 'provider_project_mismatch');
    check(request.signal && !request.signal.aborted, 'cancellation');
    const deadlineAt = Math.min(state.deadlineAt, Date.now() + (state.stage === 'verification' ? 19999 : 20000));
    check(deadlineAt - Date.now() >= (state.stage === 'verification' ? 10000 : 1), 'dispatch_allowance');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
    check((params.max_output_tokens === undefined || params.max_output_tokens === 8192) &&
      (params.service_tier === undefined || params.service_tier === 'default') &&
      (params.prompt_cache_options === undefined || isDeepStrictEqual(params.prompt_cache_options, { mode: 'implicit', ttl: '30m' })), 'wire_billing');
    check(isDeepStrictEqual(params.text, { format: { type: 'json_schema', ...request.structuredOutput } }), 'wire_schema');
    check(params.instructions === request.systemInstruction && isDeepStrictEqual(params.input,
      [{ role: 'user', content: request.messages[0].content }]) && (!Array.isArray(params.tools) || !params.tools.length), 'wire_content');
    const wire: Record<string, unknown> = JSON.parse(JSON.stringify({ ...params,
      max_output_tokens: 8192, service_tier: 'default', prompt_cache_options: { mode: 'implicit', ttl: '30m' } }));
    check(wire.model === 'gpt-6.1-sol' && isDeepStrictEqual(wire.reasoning, { effort: 'low' }), 'wire_model');
    const serialized = JSON.stringify(wire), inputTokenProxy = Buffer.byteLength(serialized, 'utf8') + 2048;
    check(inputTokenProxy <= 272000, 'unsupported_long_context');
    const maximumNanoUsd = inputTokenProxy * 2500 + 8192 * 10000;
    check(maximumNanoUsd <= owner.maximumRequestNanoUsd && maximumNanoUsd <= owner.maximumTurnNanoUsd, 'request_budget');
    // Stable message key rather than random processing-turn ID prevents an
    // owner from admitting a duplicate message stage in another worker.
    const requestSha256 = digest(serialized), reservationKey = digest(JSON.stringify([
      state.selection.binding.businessId, state.selection.binding.requestKey, state.stage]));
    quote = Object.freeze({ ...state.selection.binding, stage: state.stage, model: 'gpt-6.1-sol',
      requestSha256, reservationKey, inputTokenProxy, outputTokenLimit: 8192, maximumNanoUsd, ratesVersion: KNOWLEDGE_SOL_RATES.version,
      ownerId: owner.id, approvalReference: owner.approvalReference,
      ...(owner.providerProjectId ? { providerProjectId: owner.providerProjectId } : {}),
      maximumRequestNanoUsd: owner.maximumRequestNanoUsd, maximumTurnNanoUsd: owner.maximumTurnNanoUsd });
    signal.throwIfAborted();
    const receipt = await withinSignal(owner.reserve(quote, signal), signal);
    denied = receipt === null;
    check(receipt, 'reservation_denied'); reservationId = receipt.id;
    check(typeof receipt.id === 'string' && receipt.id.length && receipt.reservationKey === quote.reservationKey && receipt.maximumNanoUsd === maximumNanoUsd, 'reservation_identity');
    signal.throwIfAborted();
    // A monetary reserve is a NEW asynchronous boundary. Recheck the exact
    // evidence this request carries (tenant/source/chunk/version/text) before
    // sending its contents to a model.
    const sent: readonly KnowledgeRequestEvidence[] = Object.freeze((JSON.parse(request.messages[0].content).evidence as any[]).map(e =>
      Object.freeze({ id: String(e.id), businessId: e.businessId, text: String(e.text) })));
    check(state.selection.current && await withinSignal(state.selection.current(sent), signal), 'source_or_turn_changed');
    signal.throwIfAborted();
    check(deadlineAt - Date.now() >= (state.stage === 'verification' ? 10000 : 1), 'dispatch_allowance');
    check(sha256Wire(wire) === requestSha256, 'wire_mutated');
    const admittedQuote = quote, admittedReservationId = reservationId;
    const pendingResponse = send(wire, signal, deadlineAt - Date.now(), owner.providerProjectId);
    // A late authentic receipt is a monetary fact only. Reconcile it outside
    // the expired customer operation; never revive the answer or permit a retry.
    // An uncertain/invalid late receipt keeps the full durable exposure.
    void pendingResponse.then(async late => {
      if (!signal.aborted) return;
      try { await owner.settle(admittedReservationId, admittedQuote, usageOf(late, admittedQuote, owner)); }
      catch { try { await owner.retainUnknown(admittedQuote, admittedReservationId); } catch { /* Durable hold remains. */ } }
    }, () => {});
    const response = await withinSignal(pendingResponse, signal);
    signal.throwIfAborted();
    const usage = usageOf(response, quote, owner);
    await withinSignal(owner.settle(reservationId, quote, usage), signal);
    settled = true;
    signal.throwIfAborted();
    state.selection.settled.add(state.stage);
    return { response, usage };
  } catch (error) {
    state.selection.failed = true;
    if (quote && !settled && !denied) await owner.retainUnknown(quote, reservationId);
    throw error;
  }
}
const sha256Wire = (wire: Record<string, unknown>) => digest(JSON.stringify(wire));
