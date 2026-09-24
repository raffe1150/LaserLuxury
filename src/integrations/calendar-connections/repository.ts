import type { SupabaseClient } from '@supabase/supabase-js';

import {
  credentialKeyId,
  decryptCredential,
  encryptCredential,
} from '../../channels/connections/credential-crypto';

import type { StoredCredential } from '../../channels/connections/contracts';

import type {
  CalendarConnection,
  ResolvedCalendarConnection,
} from './contracts';

function toConnection(row: any): CalendarConnection {
  return {
    id: String(row.id),
    businessId: Number(row.business_id),
    provider: 'google',
    providerAccountId: row.provider_account_id
      ? String(row.provider_account_id)
      : null,
    calendarId: String(row.calendar_id),
    tokenExpiresAt: row.token_expires_at || null,
    grantedScopes: Array.isArray(row.granted_scopes)
      ? row.granted_scopes
      : [],
    status: row.status,
    connectedAt: row.connected_at || null,
    lastVerifiedAt: row.last_verified_at || null,
    reconnectRequired: Boolean(row.reconnect_required),
  };
}

export async function saveCalendarConnection(
  client: SupabaseClient,
  input: {
    businessId: number;
    providerAccountId?: string | null;
    calendarId: string;
    credential: StoredCredential;
    tokenExpiresAt?: string | null;
    grantedScopes?: string[];
    metadata?: Record<string, unknown>;
  },
): Promise<CalendarConnection> {
  const now = new Date().toISOString();

  const row = {
    business_id: input.businessId,
    provider: 'google',
    provider_account_id: input.providerAccountId || null,
    calendar_id: input.calendarId,
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
  };

  const { data, error } = await client
    .from('calendar_connections')
    .upsert(row, { onConflict: 'business_id,provider' })
    .select('*')
    .single();

  if (error) throw error;

  return toConnection(data);
}

export async function getCalendarConnection(
  client: SupabaseClient,
  businessId: number,
): Promise<CalendarConnection | null> {
  const { data, error } = await client
    .from('calendar_connections')
    .select(
      'id,business_id,provider,provider_account_id,calendar_id,token_expires_at,granted_scopes,status,connected_at,last_verified_at,reconnect_required',
    )
    .eq('business_id', businessId)
    .eq('provider', 'google')
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return toConnection(data);
}

export async function resolveCalendarConnectionForBusiness(
  client: SupabaseClient,
  businessId: number,
): Promise<ResolvedCalendarConnection | null> {
  const { data, error } = await client
    .from('calendar_connections')
    .select('*')
    .eq('business_id', businessId)
    .eq('provider', 'google')
    .eq('status', 'connected')
    .eq('reconnect_required', false)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    ...toConnection(data),
    credential: decryptCredential(data.credential_ciphertext),
    metadata: data.metadata || {},
  };
}

export async function disconnectCalendarConnection(
  client: SupabaseClient,
  businessId: number,
): Promise<boolean> {
  const { data, error } = await client
    .from('calendar_connections')
    .update({
      status: 'disconnected',
      reconnect_required: false,
      disconnected_at: new Date().toISOString(),
    })
    .eq('business_id', businessId)
    .eq('provider', 'google')
    .neq('status', 'disconnected')
    .select('id');

  if (error) throw error;

  return Boolean(data?.length);
}

export async function persistCalendarOAuthTokens(
  client: SupabaseClient,
  input: {
    connectionId: string;
    accessToken: string;
    refreshToken: string;
    tokenType?: string;
    tokenExpiresAt?: string | null;
  },
): Promise<void> {
  const credential: StoredCredential = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenType: input.tokenType || 'Bearer',
  };

  const { error } = await client
    .from('calendar_connections')
    .update({
      credential_ciphertext: encryptCredential(credential),
      credential_key_id: credentialKeyId(),
      token_expires_at: input.tokenExpiresAt || null,
      status: 'connected',
      reconnect_required: false,
    })
    .eq('id', input.connectionId)
    .eq('provider', 'google');

  if (error) throw error;
}

export async function markCalendarReconnectRequired(
  client: SupabaseClient,
  connectionId: string,
): Promise<void> {
  const { error } = await client
    .from('calendar_connections')
    .update({
      status: 'reconnect_required',
      reconnect_required: true,
    })
    .eq('id', connectionId);

  if (error) throw error;
}
