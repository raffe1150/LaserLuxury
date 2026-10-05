export type BackendSupabaseEnvironment = Readonly<Record<string, string | undefined>>;

// This detects configuration mistakes, not JWT authenticity. Supabase verifies
// the credential on each request. Never use these decoded claims for user auth.
function isPrivilegedCredential(key: string): boolean {
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}

export function getBackendSupabaseConfiguration(env: BackendSupabaseEnvironment = process.env) {
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new Error('backend_supabase_service_configuration_missing');
  if (!isPrivilegedCredential(serviceRoleKey)) throw new Error('backend_supabase_service_credential_invalid');
  return { url, serviceRoleKey };
}
