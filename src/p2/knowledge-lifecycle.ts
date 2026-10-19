import { createHash } from 'node:crypto';

/** An inactive persistence contract. No runner, provider, Booking or transport imports. */
export const KNOWLEDGE_LIFECYCLE_VERSION = 1;
export type KnowledgeScope = Readonly<{
  businessId: number; channel: 'whatsapp' | 'telegram' | 'instagram' | 'messenger';
  providerAccount: string; conversationId: string;
}>;
export type KnowledgeInput = Readonly<{
  question: string; language: string;
  history: readonly Readonly<{ role: 'user' | 'assistant'; content: string }>[];
}>;
export type ProcessingState = 'ACCEPTED' | 'RUNNING' | 'VERIFIED' | 'FINALIZED' | 'FAILED' | 'EXPIRED' | 'SUPERSEDED';
export type DeliveryState = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'EXPIRED' | 'SUPERSEDED' | 'UNCERTAIN';
export type Checkpoint = 'planning' | 'retrieval' | 'extraction';
export type Lease = Readonly<{ owner: string; fence: number; until: number }>;
export type VerifiedKnowledge = Readonly<{
  protocol: 'evidence-first-v2'; independentlyVerified: true; completeRequiredFacts: true;
  text: string; sources: readonly Readonly<{ id: string; revision: string }>[];
}>;
export type KnowledgeTask = Readonly<{
  id: string; turnId: string; eventId: string; scope: KnowledgeScope; sequence: number;
  acceptedAt: number; expiresAt: number; input: KnowledgeInput;
  state: ProcessingState; revision: number; fence: number; lease: Lease | null;
  runAttempts: number; maxRunAttempts: number; modelAttempts: number; maxModelAttempts: number;
  checkpoint: Checkpoint | null; result: VerifiedKnowledge | null; resultDigest: string | null;
}>;
export type KnowledgeDelivery = Readonly<{
  id: string; taskId: string; kind: 'final' | 'progress'; key: string; text: string;
  state: DeliveryState; fence: number; lease: Lease | null; attempts: number; maxAttempts: number;
  providerMessageId: string | null; customerDelivery: 'UNCONFIRMED';
}>;
export type TurnIdentity = Readonly<{ turnId: string; eventId: string; sequence: number; acceptedAt: number; expiresAt: number; taskId: string | null }>;
export type Acceptance = Readonly<{ identity: TurnIdentity; task: KnowledgeTask | null; inserted: boolean }>;
export type TaskToken = Readonly<{ taskId: string; owner: string; fence: number }>;
export type DeliveryToken = Readonly<{ deliveryId: string; owner: string; fence: number }>;
export type DeliveryOutcome =
  | Readonly<{ kind: 'API_ACCEPTED'; providerMessageId: string }>
  | Readonly<{ kind: 'DEFINITIVELY_UNSENT'; retryable: boolean }>
  | Readonly<{ kind: 'AMBIGUOUS' }>;

/** Trusted server-side reauthorization port, NOT a customer-supplied proof.
 * Must validate live tenant/provider scope, every captured source revision and
 * publication/channel eligibility. Called anew for finalization AND delivery.
 * The repository must recheck fencing/expiry/watermark after this async read.
 */
export type KnowledgeAuthority = (task: KnowledgeTask, phase: 'finalize' | 'send') => Promise<boolean>;

/** Each mutator is one transaction/CAS, serialized against the conversation's
 * acceptance watermark. A production adapter must not implement read-then-write.
 * Time is repository/database time; caller clocks cannot extend expiry/leases.
 */
export interface KnowledgeLifecycleRepository {
  /** Without input: durable ingress only. A later call with input may attach
   * the single Knowledge task after the FOREGROUND action branch completes.
   * It must retain the original turn, sequence, acceptance time and expiry.
   * This API does not authorize or replay that action branch.
   */
  accept(scope: KnowledgeScope, eventId: string, knowledge?: KnowledgeInput,
    limits?: { executionMs?: number; maxRunAttempts?: number; maxModelAttempts?: number }): Promise<Acceptance>;
  get(scope: KnowledgeScope, taskId: string): Promise<KnowledgeTask | null>;
  claim(scope: KnowledgeScope, taskId: string, owner: string, leaseMs: number): Promise<KnowledgeTask | null>;
  renew(scope: KnowledgeScope, token: TaskToken, leaseMs: number): Promise<boolean>;
  reserveModelAttempt(scope: KnowledgeScope, token: TaskToken): Promise<boolean>;
  checkpoint(scope: KnowledgeScope, token: TaskToken, checkpoint: Checkpoint): Promise<boolean>;
  verified(scope: KnowledgeScope, token: TaskToken, result: VerifiedKnowledge): Promise<boolean>;
  fail(scope: KnowledgeScope, token: TaskToken): Promise<boolean>;
  finalize(scope: KnowledgeScope, token: TaskToken): Promise<KnowledgeDelivery | null>;
  enqueueProgress(scope: KnowledgeScope, taskId: string, text: string): Promise<KnowledgeDelivery | null>;
  claimDelivery(scope: KnowledgeScope, deliveryId: string, owner: string, leaseMs: number): Promise<KnowledgeDelivery | null>;
  settleDelivery(scope: KnowledgeScope, token: DeliveryToken, outcome: DeliveryOutcome): Promise<boolean>;
  recover(scope: KnowledgeScope): Promise<readonly KnowledgeTask[]>;
}

export function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/u.test(value)) throw new Error('knowledge_invalid_id');
}
/** Provider event/message IDs are opaque (e.g. WhatsApp wamid with base64).
 * Retain their exact bounded identity; never turn a lossy sanitized value into
 * a deduplication key. These values must not be emitted as diagnostic fields.
 */
export function requireProviderId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_.=+/-]{1,256}$/u.test(value)) throw new Error('knowledge_invalid_provider_id');
}
export function validateScope(scope: KnowledgeScope): void {
  if (!scope || !Number.isSafeInteger(scope.businessId) || scope.businessId <= 0 ||
      !['whatsapp', 'telegram', 'instagram', 'messenger'].includes(scope.channel)) throw new Error('knowledge_invalid_scope');
  requireId(scope.providerAccount); requireId(scope.conversationId);
}
export function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('knowledge_invalid_limit');
  return value;
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('knowledge_invalid_text');
}
export function captureInput(input: KnowledgeInput): KnowledgeInput {
  text(input.question, 4000);
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/u.test(input.language) || !Array.isArray(input.history) || input.history.length > 4)
    throw new Error('knowledge_invalid_input');
  // Reconstruct only allowlisted fields. No config, credentials or arbitrary metadata.
  return snapshot({ question: input.question, language: input.language, history: input.history.map(h => {
    if (!['user', 'assistant'].includes(h.role)) throw new Error('knowledge_invalid_history');
    text(h.content, 1200); return { role: h.role, content: h.content };
  }) });
}
export function captureVerified(result: VerifiedKnowledge): VerifiedKnowledge {
  if (result.protocol !== 'evidence-first-v2' || result.independentlyVerified !== true || result.completeRequiredFacts !== true ||
      !Array.isArray(result.sources) || !result.sources.length || result.sources.length > 10) throw new Error('knowledge_unverified_result');
  text(result.text, 6000);
  const sources = result.sources.map(s => { requireId(s.id); requireId(s.revision); return { id: s.id, revision: s.revision }; });
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('knowledge_duplicate_source');
  return snapshot({ protocol: result.protocol, independentlyVerified: true, completeRequiredFacts: true, text: result.text, sources });
}
export function resultDigest(result: VerifiedKnowledge): string {
  // Length-framed UTF-8, independent of JSON object key ordering/whitespace.
  // Matches the SQL draft. Flags/protocol are validated before persistence.
  const frame = `${result.protocol}\n${Buffer.byteLength(result.text, 'utf8')}:${result.text}\n${result.sources.length}\n` +
    result.sources.map(s => `${s.id.length}:${s.id}${s.revision.length}:${s.revision}`).join('\n');
  return createHash('sha256').update(frame).digest('hex');
}
export function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: any) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(copy); return copy;
}
export function scopeKey(scope: KnowledgeScope): string {
  return JSON.stringify([scope.businessId, scope.channel, scope.providerAccount, scope.conversationId]);
}
