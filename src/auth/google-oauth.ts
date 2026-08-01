import type { SupabaseClient } from '@supabase/supabase-js';

export type GoogleOAuthResult =
  | { ok: true }
  | { ok: false; error: 'authentication_failed' };

const OAUTH_ERROR_PARAMETERS = [
  'error',
  'error_code',
  'error_description',
  'error_uri',
] as const;

export async function startGoogleOAuth(
  client: Pick<SupabaseClient, 'auth'>,
  origin: string,
): Promise<GoogleOAuthResult> {
  const redirectTo = new URL('/login', origin).toString();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });

  return error
    ? { ok: false, error: 'authentication_failed' }
    : { ok: true };
}

export function safePathAfterOAuthFailure(href: string): string | null {
  const url = new URL(href);
  const searchHasError = OAUTH_ERROR_PARAMETERS.some((key) => url.searchParams.has(key));
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const hashHasError = OAUTH_ERROR_PARAMETERS.some((key) => hash.has(key));

  if (!searchHasError && !hashHasError) return null;

  for (const key of [...OAUTH_ERROR_PARAMETERS, 'code']) {
    url.searchParams.delete(key);
  }
  url.hash = '';

  return `${url.pathname}${url.search}`;
}
