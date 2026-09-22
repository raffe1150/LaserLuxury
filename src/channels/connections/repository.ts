import type { SupabaseClient } from '@supabase/supabase-js';
import { credentialKeyId, decryptCredential, encryptCredential } from './credential-crypto';
import type { ChannelConnection, ChannelProvider, ResolvedChannelConnection, StoredCredential } from './contracts';

function toConnection(row: any): ChannelConnection {
  return {
    id: String(row.id),
    businessId: Number(row.business_id),
    provider: row.provider,
    providerAccountId: String(row.provider_account_id),
    providerConnectionId: row.provider_connection_id ? String(row.provider_connection_id) : null,
    tokenExpiresAt: row.token_expires_at || null,
    grantedScopes: Array.isArray(row.granted_scopes) ? row.granted_scopes : [],
    status: row.status,
    connectedAt: row.connected_at || null,
    lastVerifiedAt: row.last_verified_at || null,
    reconnectRequired: Boolean(row.reconnect_required),
    displayName: typeof row.metadata?.display_name === 'string' ? row.metadata.display_name : null,
    source: row.source,
  };
}

export async function listConnections(client: SupabaseClient, businessId: number): Promise<ChannelConnection[]> {
  const { data, error } = await client
    .from('channel_connections')
    .select('id,business_id,provider,provider_account_id,provider_connection_id,token_expires_at,granted_scopes,status,connected_at,last_verified_at,reconnect_required,metadata,source')
    .eq('business_id', businessId);
  if (error) throw error;
  return (data || []).map(toConnection);
}

export async function saveConnection(client: SupabaseClient, input: {
  businessId: number;
  provider: ChannelProvider;
  providerAccountId: string;
  providerConnectionId?: string | null;
  credential: StoredCredential;
  tokenExpiresAt?: string | null;
  grantedScopes?: string[];
  metadata?: Record<string, unknown>;
}): Promise<ChannelConnection> {
  const now = new Date().toISOString();
  const row = {
    business_id: input.businessId,
    provider: input.provider,
    provider_account_id: input.providerAccountId,
    provider_connection_id: input.providerConnectionId || null,
    credential_ciphertext: encryptCredential(input.credential),
    credential_key_id: credentialKeyId(),
    token_expires_at: input.tokenExpiresAt || null,
    granted_scopes: input.grantedScopes || [],
    status: 'connected',
    connected_at: now,
    last_verified_at: now,
    reconnect_required: false,
    disconnected_at: null,
    metadata: input.metadata || {},
    source: 'self_service',
  };
  const { data, error } = await client
    .from('channel_connections')
    .upsert(row, { onConflict: 'business_id,provider' })
    .select('*')
    .single();
  if (error) throw error;
  return toConnection(data);
}

export async function resolveConnectionByIdentity(
  client: SupabaseClient,
  provider: ChannelProvider,
  identity: string,
): Promise<ResolvedChannelConnection | null> {
  const select = () => client.from('channel_connections').select('*')
    .eq('provider', provider).eq('status', 'connected').eq('reconnect_required', false);
  let result = await select().eq('provider_account_id', identity).maybeSingle();
  if (!result.data && !result.error) {
    result = await select().eq('provider_connection_id', identity).maybeSingle();
  }
  if (result.error) throw result.error;
  if (!result.data) return null;
  return { ...toConnection(result.data), credential: decryptCredential(result.data.credential_ciphertext), metadata: result.data.metadata || {} };
}

export async function resolveConnectionForBusiness(
  client: SupabaseClient,
  businessId: number,
  provider: ChannelProvider,
): Promise<ResolvedChannelConnection | null> {
  const { data, error } = await client.from('channel_connections').select('*')
    .eq('business_id', businessId).eq('provider', provider)
    .eq('status', 'connected').eq('reconnect_required', false).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { ...toConnection(data), credential: decryptCredential(data.credential_ciphertext), metadata: data.metadata || {} };
}

export async function disconnectConnection(
  client: SupabaseClient,
  businessId: number,
  provider: ChannelProvider,
): Promise<boolean> {
  const { data, error } = await client.from('channel_connections').update({
    status: 'disconnected', reconnect_required: false, disconnected_at: new Date().toISOString(),
  }).eq('business_id', businessId).eq('provider', provider).neq('status', 'disconnected').select('id');
  if (error) throw error;
  return Boolean(data?.length);
}

export async function markReconnectRequired(
  client: SupabaseClient,
  connectionId: string,
): Promise<void> {
  const { error } = await client.from('channel_connections').update({
    status: 'reconnect_required', reconnect_required: true,
  }).eq('id', connectionId);
  if (error) throw error;
}
