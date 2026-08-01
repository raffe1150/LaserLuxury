import type { SupabaseClient } from '@supabase/supabase-js';

export type PasswordRecoveryResult =
  | { ok: true }
  | { ok: false; error: 'authentication_failed' };

export async function requestPasswordRecovery(
  client: Pick<SupabaseClient, 'auth'>,
  email: string,
  redirectTo: string,
): Promise<PasswordRecoveryResult> {
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  return error
    ? { ok: false, error: 'authentication_failed' }
    : { ok: true };
}
