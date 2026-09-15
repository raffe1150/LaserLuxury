import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

let verificationClient: SupabaseClient | null = null;
let authorizationClient: SupabaseClient | null = null;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('auth_configuration_error');
  return value;
}

export function getAuthVerificationClient(): SupabaseClient {
  if (verificationClient) return verificationClient;
  verificationClient = createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_ANON_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return verificationClient;
}

export function getAuthorizationClient(): SupabaseClient {
  if (authorizationClient) return authorizationClient;
  authorizationClient = createClient(
    requiredEnvironment('SUPABASE_URL'),
    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return authorizationClient;
}

export type TokenVerification =
  | { ok: true; user: User }
  | { ok: false; code: 'invalid_credentials' | 'expired_credentials' | 'verification_unavailable' };

export function classifyVerificationError(error: unknown): TokenVerification & { ok: false } {
  const detail = error as { status?: number; code?: string; name?: string } | null;
  if (!detail || detail.name === 'AuthRetryableFetchError' || !detail.status || detail.status >= 500 || detail.status === 429) {
    return { ok: false, code: 'verification_unavailable' };
  }
  if (detail.code === 'session_not_found' || detail.code === 'refresh_token_not_found') {
    return { ok: false, code: 'expired_credentials' };
  }
  if (detail.status === 401 || detail.status === 403 || detail.code === 'bad_jwt') {
    return { ok: false, code: 'invalid_credentials' };
  }
  return { ok: false, code: 'verification_unavailable' };
}

export async function verifyAccessToken(
  token: string,
  client: Pick<SupabaseClient, 'auth'> = getAuthVerificationClient(),
): Promise<TokenVerification> {
  try {
    const { data, error } = await client.auth.getUser(token);
    if (error) return classifyVerificationError(error);
    return data.user ? { ok: true, user: data.user } : { ok: false, code: 'verification_unavailable' };
  } catch {
    return { ok: false, code: 'verification_unavailable' };
  }
}
