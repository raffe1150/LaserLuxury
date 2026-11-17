/** Tier B natural composer: pre-dispatch financial admission (shadow only, 2026-11-17).
 *
 * Every Tier B provider request is priced at a conservative worst case, fully
 * reserved in a protected ledger BEFORE dispatch, and dispatched exactly once
 * through a single-use admission the OpenAI adapter verifies (no admission, no
 * dispatch). Owner limits: USD 0.15 per provider request; USD 4.00 cumulative
 * including historical and unknown-retained exposure (enforced atomically by
 * the ledger, which alone sees history). No retries. Timeouts, aborts, missing
 * or over-reservation usage retain the FULL reservation as unknown exposure.
 *
 * This is not a competing budget system: it prices requests and adapts to the
 * existing ledgers. Server-side execution requires a durable cross-instance
 * owner; none is authorised for Tier B stages yet, so the server fails closed. */
import { createHash } from 'node:crypto';
import { KNOWLEDGE_SOL_RATES } from './knowledge-model-policy';
import type { NaturalComposerStage } from './model-routing';
import type { UnifiedAiGenerationRequest } from './providers/provider';

/** Rate cards in integer nanoUSD per token (= USD per 1M tokens x 1000).
 * Conservative input rate = max(uncached input, cache write); cache reads are
 * never assumed. Version strings are what ledgers approve. */
export type NaturalRateCard = Readonly<{ version: string; inputNanoPerToken: number; cacheWriteNanoPerToken: number; outputNanoPerToken: number;
  verification: string }>;
export const NATURAL_COMPOSER_RATE_CARDS: Readonly<Record<string, NaturalRateCard>> = Object.freeze({
  // Same version/rates as the durable Knowledge owner (KNOWLEDGE_SOL_RATES); first-party re-verification pending.
  'gpt-6.1-sol': Object.freeze({ version: KNOWLEDGE_SOL_RATES.version, inputNanoPerToken: KNOWLEDGE_SOL_RATES.input * 1000,
    cacheWriteNanoPerToken: KNOWLEDGE_SOL_RATES.cacheWrite * 1000, outputNanoPerToken: KNOWLEDGE_SOL_RATES.output * 1000,
    verification: 'repo-knowledge-owner-rates; first-party page not re-verified 2026-11-17' }),
  // Input/output: OpenAI announcement, effective 2026-07-30. Cache write 0.25 is an unverified conservative
  // assumption used only as the max input rate (raises, never lowers, the ceiling).
  'gpt-5.6-luna': Object.freeze({ version: 'openai-luna-standard-2026-07-30', inputNanoPerToken: 200, cacheWriteNanoPerToken: 250,
    outputNanoPerToken: 1200, verification: 'input/output first-party (openai.com 2026-07-30); cache-write assumed' }),
});

export const NATURAL_COMPOSER_BUDGET_LIMITS = Object.freeze({
  perRequestNanoUsd: 150_000_000,          // USD 0.15
  cumulativeNanoUsd: 4_000_000_000,        // USD 4.00 (ledger-enforced; includes history and unknown exposure)
  framingTokens: 4096,                     // provider framing/system overhead allowance
  composer: Object.freeze({ maxOutputTokens: 2000, maxRequestBytes: 16_000 }),
  validator: Object.freeze({ maxOutputTokens: 1200, maxRequestBytes: 24_000 }),
});

export type NaturalRole = 'composer' | 'validator';
export const NATURAL_ROLE_STAGE: Readonly<Record<NaturalRole, NaturalComposerStage>> =
  Object.freeze({ composer: 'knowledge_natural_composition', validator: 'knowledge_natural_validation' });

/** Canonical priced material: everything the adapter sends that is billed as input. */
export function naturalRequestMaterial(request: Pick<UnifiedAiGenerationRequest, 'model' | 'systemInstruction' | 'messages' | 'structuredOutput' | 'maxOutputTokens' | 'routingStage'>): string {
  return JSON.stringify({ model: request.model, routingStage: request.routingStage, maxOutputTokens: request.maxOutputTokens,
    instructions: request.systemInstruction ?? null, input: request.messages, schema: request.structuredOutput ?? null });
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type NaturalQuote = Readonly<{ requestId: string; turnId: string; businessId: number; role: NaturalRole; stage: NaturalComposerStage;
  model: string; rateVersion: string; requestBytes: number; maxInputTokens: number; maxOutputTokens: number;
  inputRateNanoPerToken: number; outputRateNanoPerToken: number; ceilingNanoUsd: number; requestSha256: string; dependencySha256?: string }>;

/** Worst case = (UTF-8 bytes of the priced material + framing) input tokens at
 * the max input rate + maxOutputTokens (which on the Responses API bounds
 * visible AND reasoning output) at the output rate. Integer nanoUSD. */
export function quoteNaturalRequest(input: Readonly<{ request: UnifiedAiGenerationRequest; role: NaturalRole; turnId: string; businessId: number;
  dependencySha256?: string }>): Readonly<{ ok: true; quote: NaturalQuote }> | Readonly<{ ok: false; reason: string }> {
  const { request, role } = input, limits = NATURAL_COMPOSER_BUDGET_LIMITS[role], card = request.model ? NATURAL_COMPOSER_RATE_CARDS[request.model] : undefined;
  if (!card) return { ok: false, reason: 'RATE_CARD_MISSING' };
  if (request.routingStage !== NATURAL_ROLE_STAGE[role] || request.maxOutputTokens !== limits.maxOutputTokens) return { ok: false, reason: 'REQUEST_UNBOUNDED' };
  const material = naturalRequestMaterial(request), requestBytes = Buffer.byteLength(material, 'utf8');
  if (requestBytes > limits.maxRequestBytes) return { ok: false, reason: 'REQUEST_TOO_LARGE' };
  const maxInputTokens = requestBytes + NATURAL_COMPOSER_BUDGET_LIMITS.framingTokens;
  const inputRate = Math.max(card.inputNanoPerToken, card.cacheWriteNanoPerToken);
  const ceilingNanoUsd = maxInputTokens * inputRate + limits.maxOutputTokens * card.outputNanoPerToken;
  if (!Number.isSafeInteger(ceilingNanoUsd) || ceilingNanoUsd <= 0 || ceilingNanoUsd > NATURAL_COMPOSER_BUDGET_LIMITS.perRequestNanoUsd)
    return { ok: false, reason: 'REQUEST_CEILING' };
  return { ok: true, quote: Object.freeze({ requestId: `tierb:${input.turnId}:${role}`, turnId: input.turnId, businessId: input.businessId, role,
    stage: NATURAL_ROLE_STAGE[role], model: request.model!, rateVersion: card.version, requestBytes, maxInputTokens, maxOutputTokens: limits.maxOutputTokens,
    inputRateNanoPerToken: inputRate, outputRateNanoPerToken: card.outputNanoPerToken, ceilingNanoUsd, requestSha256: sha256(material),
    ...(input.dependencySha256 ? { dependencySha256: input.dependencySha256 } : {}) }) };
}

/** Upper-bound cost from reported usage (no cache discount assumed). null => unknown. */
export function naturalUsageNanoUsd(quote: NaturalQuote, usage: { inputTokens: number; outputTokens: number } | undefined): number | null {
  if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens < 0 || usage.outputTokens < 0) return null;
  const nano = usage.inputTokens * quote.inputRateNanoPerToken + usage.outputTokens * quote.outputRateNanoPerToken;
  return Number.isSafeInteger(nano) ? nano : null;
}

/** A protected ledger. reserve() must atomically enforce the per-request and
 * cumulative limits (including history and unknown exposure) and resolve null
 * on denial; a throw means "state unknown" and also blocks dispatch. */
export interface NaturalComposerBudget {
  readonly id: string;
  readonly accounting: 'durable-cross-instance' | 'experiment-ledger-single-host' | 'test';
  readonly approvedRateVersions: readonly string[];
  reserve(quote: NaturalQuote): Promise<Readonly<{ reservationId: string }> | null>;
  settle(reservationId: string, quote: NaturalQuote, actualNanoUsd: number): Promise<void>;
  /** Full reservation stays counted forever. */
  retainUnknown(reservationId: string, quote: NaturalQuote, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Single-use dispatch admission. Only this module can mint one; the OpenAI
// adapter consumes it before any SDK call. It is bound to the exact priced
// request (model, stage, output bound, content hash), so it cannot be reused,
// replayed as a retry, or attached to a larger request.
export type NaturalComposerAdmission = Readonly<{ kind: 'tierb-admission'; requestId: string; reservationId: string }>;
const minted = new WeakMap<object, { quote: NaturalQuote; consumed: boolean }>();
export function mintNaturalAdmission(quote: NaturalQuote, reservationId: string): NaturalComposerAdmission {
  const admission = Object.freeze({ kind: 'tierb-admission' as const, requestId: quote.requestId, reservationId });
  minted.set(admission, { quote, consumed: false });
  return admission;
}
/** Throws (before any dispatch) unless the request carries a fresh admission for exactly this request. */
export function consumeNaturalAdmission(request: UnifiedAiGenerationRequest): NaturalQuote {
  const entry = request.naturalComposerAdmission ? minted.get(request.naturalComposerAdmission) : undefined;
  if (!entry) throw new Error('tierb_unreserved_dispatch');
  if (entry.consumed) throw new Error('tierb_admission_reused');
  const q = entry.quote;
  if (request.model !== q.model || request.routingStage !== q.stage || request.maxOutputTokens !== q.maxOutputTokens ||
      (request.tools?.length ?? 0) !== 0 || sha256(naturalRequestMaterial(request)) !== q.requestSha256) throw new Error('tierb_admission_mismatch');
  entry.consumed = true;
  return q;
}

// ---------------------------------------------------------------------------
// Ledger adapters.

/** Structural port of scripts/experiment-accounting.ts ExperimentLedger (not
 * imported: the experimental script is not a production dependency). The
 * caller must hold its exclusive writer lock (acquire()). Single host only:
 * offline evaluation, never server-side. */
export type ExperimentLedgerPort = {
  reserve(request: { requestId: string; caseId: string; stage: string; model: string; requestSha256: string; ceilingUsd: number; dependencySha256?: string }): void;
  settle(requestId: string, outcome: { status: 'SETTLED' | 'UNKNOWN_RETAINED' | 'NOT_DISPATCHED_RELEASED'; estimatedUsd?: number } & Record<string, unknown>): void;
};
const LEDGER_DENIALS = new Set(['PER_REQUEST_CEILING_EXCEEDED', 'CUMULATIVE_CEILING_EXCEEDED', 'DUPLICATE_REQUEST_ID']);
export function experimentLedgerNaturalBudget(ledger: ExperimentLedgerPort, authorization: Readonly<{ id: string; approvedRateVersions: readonly string[] }>): NaturalComposerBudget {
  if (!authorization.id.trim() || !authorization.approvedRateVersions.length) throw new Error('tierb_ledger_authorization_invalid');
  return Object.freeze({
    id: `experiment-ledger:${authorization.id}`, accounting: 'experiment-ledger-single-host' as const,
    approvedRateVersions: Object.freeze([...authorization.approvedRateVersions]),
    async reserve(quote: NaturalQuote) {
      if (!authorization.approvedRateVersions.includes(quote.rateVersion) || quote.ceilingNanoUsd > NATURAL_COMPOSER_BUDGET_LIMITS.perRequestNanoUsd) return null;
      try {
        ledger.reserve({ requestId: quote.requestId, caseId: `tierb:${quote.businessId}`, stage: quote.stage, model: quote.model,
          requestSha256: quote.requestSha256, ceilingUsd: quote.ceilingNanoUsd / 1e9, ...(quote.dependencySha256 ? { dependencySha256: quote.dependencySha256 } : {}) });
      } catch (error: any) {
        if (LEDGER_DENIALS.has(error?.message)) return null;
        throw error;                                   // unknown ledger state: caller makes zero calls
      }
      return Object.freeze({ reservationId: quote.requestId });
    },
    async settle(reservationId: string, quote: NaturalQuote, actualNanoUsd: number) {
      ledger.settle(reservationId, { status: 'SETTLED', estimatedUsd: actualNanoUsd / 1e9, rateVersion: quote.rateVersion, pricing: 'upper-bound-no-cache-discount' });
    },
    async retainUnknown(reservationId: string, quote: NaturalQuote, reason: string) {
      ledger.settle(reservationId, { status: 'UNKNOWN_RETAINED', reason, rateVersion: quote.rateVersion });
    },
  });
}

/** Server-side Tier B budget. The durable ai_money owner (Postgres, row-locked,
 * cross-instance) only admits gpt-6.1-sol Knowledge extraction/re-extraction/
 * verification under KNOWLEDGE_SOL_RATES; Tier B stages, Luna rates and a
 * Tier B account/approval are NOT authorised there. Until an owner-approved
 * migration and approval exist this resolves to no budget: zero model calls. */
export function serverNaturalComposerBudget(): Readonly<{ budget?: NaturalComposerBudget; reason: 'DURABLE_TIERB_ACCOUNT_UNAVAILABLE' }> {
  return Object.freeze({ reason: 'DURABLE_TIERB_ACCOUNT_UNAVAILABLE' as const });
}
