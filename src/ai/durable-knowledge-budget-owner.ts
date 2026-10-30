import { trialEnforced, reserveControlledSol } from '../runtime/controlled-knowledge-trial';
import { knowledgeOperation } from '../p2/knowledge-operation';
import { configureKnowledgeBudgetOwner, KNOWLEDGE_SOL_RATES,
  type KnowledgeBudgetOwner, type KnowledgeCostQuote, type KnowledgeUsage } from './knowledge-model-policy';

/** Service-side shared account client only. Never accepts a tenant API key. */
export type AiMoneyDatabase = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> &
    { abortSignal?: (signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }> };
};
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function requireValue(ok: unknown): asserts ok { if (!ok) throw Error('ai_money_invalid_configuration_or_receipt'); }

/** Explicit rational conversion. USD source units are nanoUSD; SEK units are ore.
 * Allowances round down, never grant credit through floating point rounding.
 * No FX rate, subscription price or allowance is supplied by this helper.
 */
export function approvedAllowanceNanoUsd(policy: {
  currency: 'USD' | 'SEK'; units: bigint; numerator: bigint; denominator: bigint; approvalReference: string;
}): bigint {
  const { currency, units, numerator, denominator, approvalReference } = policy;
  requireValue(units >= 0n && numerator > 0n && denominator > 0n && approvalReference.trim());
  requireValue(currency === 'SEK' || currency === 'USD' && numerator === 1n && denominator === 1n && approvalReference === 'USD_IDENTITY');
  const result = units * numerator / denominator;
  requireValue(result <= BigInt(Number.MAX_SAFE_INTEGER));
  return result;
}

/** Database authority is rechecked atomically on EVERY reserve. This snapshot
 * only bounds immutable per-turn selection; it cannot override revocations,
 * current entitlement/period limits, idempotency or aggregate account limits.
 * Construction does not approve missing financial policy or activate Sol.
 */
export class DurableKnowledgeBudgetOwner implements KnowledgeBudgetOwner {
  readonly accounting = 'atomic-durable' as const;
  readonly ratesVersion = KNOWLEDGE_SOL_RATES.version;
  private constructor(private readonly db: AiMoneyDatabase, private readonly account: string,
    readonly id: string, readonly approvalReference: string, readonly businessIds: readonly number[],
    readonly maximumRequestNanoUsd: number, readonly maximumTurnNanoUsd: number, readonly providerProjectId: string) {}

  private async transition(command: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return knowledgeOperation(async operationSignal => {
      const query = this.db.rpc('odin_ai_money_v1', {
        p_account: this.account, p_approval: this.approvalReference, p_command: command, p_payload: payload,
      });
      const { data, error } = await (query.abortSignal ? query.abortSignal(operationSignal) : query);
      // Never log RPC exception text, customer input, billing credentials or policy data.
      if (error) throw Error('ai_money_operation_failed');
      return data;
    }, { signal, independent: true, timeoutMs: 3000, factualResult: command === 'settle' });
  }

  static async prepare(db: AiMoneyDatabase, configuration: { accountId: string; approvalReference: string }): Promise<DurableKnowledgeBudgetOwner> {
    requireValue(configuration.accountId.trim() && configuration.approvalReference.trim());
    const probe = new DurableKnowledgeBudgetOwner(db, configuration.accountId, 'uninitialized', configuration.approvalReference, [], 1, 1, 'proj_uninitialized');
    const value = await probe.transition('configuration', {});
    requireValue(record(value) && typeof value.ownerId === 'string' && value.ownerId.trim() &&
      value.approvalReference === configuration.approvalReference && value.ratesVersion === KNOWLEDGE_SOL_RATES.version &&
      typeof value.providerProjectId === 'string' && /^proj_[A-Za-z0-9_-]+$/u.test(value.providerProjectId) &&
      value.billingProfile === 'openai-standard-nonregional-30m-v1' && positive(value.maximumRequestNanoUsd) &&
      positive(value.maximumTurnNanoUsd) && value.maximumTurnNanoUsd >= value.maximumRequestNanoUsd &&
      Array.isArray(value.businessIds) && value.businessIds.length && value.businessIds.every(positive));
    return new DurableKnowledgeBudgetOwner(db, configuration.accountId, value.ownerId, configuration.approvalReference,
      Object.freeze([...value.businessIds]), value.maximumRequestNanoUsd, value.maximumTurnNanoUsd, value.providerProjectId);
  }

  async reserve(quote: KnowledgeCostQuote, signal: AbortSignal) {
    signal.throwIfAborted();
    const value = trialEnforced() ? await reserveControlledSol(quote,signal) : await this.transition('reserve', { quote }, signal);
    if (value === null) return null;
    // Existing Knowledge failure classifier and safe localized fallback. No
    // balances, subscription terms or provider details enter customer prose.
    if (record(value) && value.denied === 'budget_exhausted') throw Error('information_budget_exhausted');
    requireValue(record(value) && typeof value.id === 'string' && /^[a-f0-9-]{36}$/iu.test(value.id) &&
      value.reservationKey === quote.reservationKey && value.maximumNanoUsd === quote.maximumNanoUsd);
    return Object.freeze({ id: value.id, reservationKey: quote.reservationKey, maximumNanoUsd: quote.maximumNanoUsd });
  }

  async settle(id: string, quote: KnowledgeCostQuote, usage: KnowledgeUsage): Promise<void> {
    // Raw identity and all billing fields were authenticated/validated by the
    // provider adapter. DB independently recomputes exact fixed-point cost.
    requireValue(typeof usage.providerResponseId === 'string' && /^resp_[A-Za-z0-9_-]+$/u.test(usage.providerResponseId));
    const value = await this.transition('settle', { id, quote, usage });
    requireValue(record(value) && value.settled === true);
  }

  async retainUnknown(quote: KnowledgeCostQuote, reservationId: string | null): Promise<void> {
    await this.transition('unknown', { id: reservationId, quote });
  }

  /** Backend reconciliation only: actual, adapter-validated late provider usage.
   * No timeout-based release, new dispatch permit, model retry or automatic TTL.
   * Repeated identical settlement is idempotent; conflicting receipts fail.
   */
  async reconcileLateReceipt(id: string, quote: KnowledgeCostQuote, usage: KnowledgeUsage): Promise<void> {
    await this.settle(id, quote, usage);
  }

  /** Administrative server use only. Caller MUST authorize requested tenant.
   * No public/customer route is installed by this module.
   */
  async administrativeStatus(businessId: number): Promise<unknown> {
    requireValue(positive(businessId) && this.businessIds.includes(businessId));
    return this.transition('status', { businessId });
  }
}

/** Optional backend bootstrap. No numeric defaults or experimental-ledger
 * imports. No financial setting means NO owner registration. A configured but
 * unavailable/invalid owner leaves selected Sol requests blocked, never Luna.
 */
let installationGeneration = 0;
export async function installConfiguredKnowledgeBudgetOwner(db: AiMoneyDatabase, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const generation = ++installationGeneration;
  configureKnowledgeBudgetOwner(); // new selections stop; captured turns retain their owner
  if (!env.ODINLINK_AI_MONEY_ACCOUNT && !env.ODINLINK_AI_MONEY_APPROVAL) return false;
  const owner = await DurableKnowledgeBudgetOwner.prepare(db, {
    accountId: env.ODINLINK_AI_MONEY_ACCOUNT ?? '', approvalReference: env.ODINLINK_AI_MONEY_APPROVAL ?? '',
  });
  if (generation !== installationGeneration) return false; // an older async read cannot undo a disable
  configureKnowledgeBudgetOwner(owner);
  return true;
}
