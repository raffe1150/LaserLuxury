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

export async function verifyAccessToken(
  token: string,
  client: Pick<SupabaseClient, 'auth'> = getAuthVerificationClient(),
): Promise<User | null> {
  try {
    const { data, error } = await client.auth.getUser(token);
    return error || !data.user ? null : data.user;
  } catch {
    return null;
  }
}
