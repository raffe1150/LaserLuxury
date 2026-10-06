import { randomUUID } from 'node:crypto';
import type { ChannelProvider } from '../connections/contracts';

export type ProvisioningTarget = { provider: ChannelProvider; business_id: number; asset_id: string; identity_id: string;
  app_id: string; authorizing_user_id: string; expected_portfolio_id?: string; authorization_version?: string };
export type ProvisioningLease = { resource_key: string; owner: string; fence: string };
export type CreationIntent = { key: string; state: 'reserved' | 'submitted' | 'uncertain' | 'retryable' | 'failed';
  code: string; asset_id: string | null; retry_at: number | null; provider_code: number | null };

// Production implementations must enforce these operations atomically in shared
// durable storage. A process-local mutex is deliberately not a production fallback.
export interface ProvisioningStore<State> {
  acquire(resourceKey: string, owner: string, ttlMs: number): Promise<ProvisioningLease | null>;
  renew(lease: ProvisioningLease, ttlMs: number): Promise<boolean>;
  release(lease: ProvisioningLease): Promise<void>;
  load(target: ProvisioningTarget): Promise<State | null>;
  enqueue(target: ProvisioningTarget, state: State): Promise<void>;
  save(target: ProvisioningTarget, state: State, lease: ProvisioningLease): Promise<void>;
  targetsDue(provider: ChannelProvider, now: number, limit: number): Promise<ProvisioningTarget[]>;
  targetsForAsset(provider: ChannelProvider, assetId: string): Promise<ProvisioningTarget[]>;
  intent(key: string): Promise<CreationIntent | null>;
  claim(key: string, lease: ProvisioningLease, now: number): Promise<{ claimed: boolean; intent: CreationIntent }>;
  settle(intent: CreationIntent, lease: ProvisioningLease): Promise<void>;
}
export const provisioningTargetKey = (target: ProvisioningTarget) =>
  JSON.stringify([target.provider, target.business_id, target.asset_id, target.identity_id, target.app_id]);
export const provisioningResourceKey = (target: ProvisioningTarget) => `${target.provider}:${target.asset_id}`;

export async function withProvisioningLease<State, Result>(store: ProvisioningStore<State>, target: ProvisioningTarget,
  work: (lease: ProvisioningLease) => Promise<Result>): Promise<Result | null> {
  const lease = await store.acquire(provisioningResourceKey(target), randomUUID(), 180_000);
  if (!lease) return null;
  try { return await work(lease); }
  finally { await store.release(lease); }
}

// A durable intent is committed BEFORE the side effect. A transport failure,
// crash, or 5xx never reclaims this intent automatically. Only a definitive
// rate-limit refusal may retry, after cooldown AND a fresh provider inventory.
export async function submitProvisioningItem<State>(store: ProvisioningStore<State>, lease: ProvisioningLease,
  key: string, now: number, submit: () => Promise<Omit<CreationIntent, 'key'>>): Promise<{ intent: CreationIntent; submitted: boolean }> {
  if (!await store.renew(lease, 180_000)) throw new Error('provisioning_lease_lost');
  const claim = await store.claim(key, lease, now);
  if (!claim.claimed) return { intent: claim.intent, submitted: false };
  const intent = { key, ...await submit() };
  await store.settle(intent, lease);
  return { intent, submitted: true };
}
