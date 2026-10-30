/** SCRIPTED TEST OWNER ONLY. In-memory state does not establish durable
 * production accounting, approval, operational budgets or billing behavior. */
import type { KnowledgeBudgetOwner, KnowledgeCostQuote, KnowledgeUsage } from '../../src/ai/knowledge-model-policy';
import { KNOWLEDGE_SOL_RATES } from '../../src/ai/knowledge-model-policy';
export class ScriptedKnowledgeBudgetOwner implements KnowledgeBudgetOwner {
  readonly id = 'scripted-offline-owner';
  readonly approvalReference = 'TEST_FIXTURE_NOT_PRODUCTION_APPROVAL';
  readonly accounting = 'atomic-durable' as const;
  readonly ratesVersion = KNOWLEDGE_SOL_RATES.version;
  businessIds = [77];
  maximumRequestNanoUsd = 200_000_000;
  maximumTurnNanoUsd = 500_000_000;
  readonly reservations = new Map<string, { quote: KnowledgeCostQuote; cost?: number; unknown?: boolean }>();
  readonly events: string[] = [];
  mode: 'ok' | 'deny' | 'reserve-error' | 'receipt-mismatch' | 'settle-error' = 'ok';
  async reserve(quote: KnowledgeCostQuote, signal: AbortSignal) {
    this.events.push('reserve'); signal.throwIfAborted();
    if (this.mode === 'reserve-error') throw Error('SCRIPTED_RESERVATION_ERROR');
    const used = [...this.reservations.values()].filter(r => r.quote.businessId === quote.businessId && r.quote.requestKey === quote.requestKey)
      .reduce((n, r) => n + (r.cost ?? r.quote.maximumNanoUsd), 0);
    // No await between the fixture's check and insertion. Production MUST use
    // an actual durable atomic owner; this only tests the dispatch contract.
    if (this.mode === 'deny' || this.reservations.has(quote.reservationKey) ||
      used + quote.maximumNanoUsd > Math.min(this.maximumTurnNanoUsd, quote.maximumTurnNanoUsd)) return null;
    this.reservations.set(quote.reservationKey, { quote });
    return { id: quote.reservationKey, reservationKey: this.mode === 'receipt-mismatch' ? 'wrong' : quote.reservationKey, maximumNanoUsd: quote.maximumNanoUsd };
  }
  async settle(id: string, _quote: KnowledgeCostQuote, usage: KnowledgeUsage) {
    this.events.push('settle'); if (this.mode === 'settle-error') throw Error('SCRIPTED_SETTLEMENT_ERROR');
    const r = this.reservations.get(id); if (!r) throw Error('UNKNOWN_TEST_RESERVATION'); r.cost = usage.estimatedNanoUsd;
  }
  async retainUnknown(quote: KnowledgeCostQuote, _id: string | null) {
    this.events.push('retainUnknown'); const r = this.reservations.get(quote.reservationKey); if (r) r.unknown = true;
  }
}
