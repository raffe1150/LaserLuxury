import crypto from 'node:crypto';

export const AUTHORIZATION_TTL_MS = 10 * 60_000;
export const AUTHORIZATION_COOKIE = 'odinlink_channel_auth';

export function randomAuthorizationValue(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashAuthorizationValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseCookie(header: string | undefined, name: string): string | null {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function authorizationCookie(value: string, maxAgeSeconds = 600): string {
  return `${AUTHORIZATION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/api/channel-connections; HttpOnly; Secure; SameSite=Lax`;
}

export function clearAuthorizationCookie(): string {
  return `${AUTHORIZATION_COOKIE}=; Max-Age=0; Path=/api/channel-connections; HttpOnly; Secure; SameSite=Lax`;
}

export function publicAppUrl(): string {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (!configured) throw new Error('public_app_url_missing');
  const url = new URL(configured);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('public_app_url_insecure');
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function callbackUrl(provider: string): string {
  return `${publicAppUrl()}/api/channel-connections/${encodeURIComponent(provider)}/callback`;
}

export function dashboardReturnUrl(provider: string, result: string): string {
  const url = new URL('/dashboard', `${publicAppUrl()}/`);
  url.searchParams.set('channel', provider);
  url.searchParams.set('connection', result);
  return url.toString();
}
