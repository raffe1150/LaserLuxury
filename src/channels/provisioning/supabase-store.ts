import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelProvider } from '../connections/contracts';
import type { CreationIntent, ProvisioningLease, ProvisioningStore, ProvisioningTarget } from './orchestration';

// Dormant until the service-role-only RPC/storage migration has been reviewed
// and deployed. Database errors are never forwarded into onboarding responses.
export class SupabaseProvisioningStore<State> implements ProvisioningStore<State> {
  constructor(private readonly client: SupabaseClient) {}
  private async call<T>(operation: string, payload: unknown): Promise<T> {
    try {
      const { data, error } = await this.client.rpc('channel_provisioning_store', { p_operation: operation, p_payload: payload });
      if (error) throw error;
      return data as T;
    } catch { throw new Error('provisioning_storage_unavailable'); }
  }
  acquire(resourceKey: string, owner: string, ttlMs: number) {
    return this.call<ProvisioningLease | null>('acquire', { resource_key: resourceKey, owner, ttl_ms: ttlMs });
  }
  renew(lease: ProvisioningLease, ttlMs: number) { return this.call<boolean>('renew', { lease, ttl_ms: ttlMs }); }
  release(lease: ProvisioningLease) { return this.call<void>('release', { lease }); }
  load(target: ProvisioningTarget) { return this.call<State | null>('load', { target }); }
  enqueue(target: ProvisioningTarget, state: State) { return this.call<void>('queue', { target, state }); }
  save(target: ProvisioningTarget, state: State, lease: ProvisioningLease) { return this.call<void>('save', { target, state, lease }); }
  targetsDue(provider: ChannelProvider, now: number, limit: number) {
    return this.call<ProvisioningTarget[]>('targets_due', { provider, now, limit });
  }
  targetsForAsset(provider: ChannelProvider, assetId: string) {
    return this.call<ProvisioningTarget[]>('targets_for_asset', { provider, asset_id: assetId });
  }
  intent(key: string) { return this.call<CreationIntent | null>('intent', { key }); }
  claim(key: string, lease: ProvisioningLease, now: number) {
    return this.call<{ claimed: boolean; intent: CreationIntent }>('claim', { key, lease, now });
  }
  settle(intent: CreationIntent, lease: ProvisioningLease) { return this.call<void>('settle', { intent, lease }); }
}
