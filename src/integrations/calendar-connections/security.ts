import {
  publicAppUrl,
  randomAuthorizationValue,
  hashAuthorizationValue,
  parseCookie,
} from '../../channels/connections/security';

export {
  randomAuthorizationValue,
  hashAuthorizationValue,
  parseCookie,
};

export const CALENDAR_AUTHORIZATION_TTL_MS = 10 * 60_000;
export const CALENDAR_AUTHORIZATION_COOKIE = 'odinlink_calendar_auth';

export function calendarAuthorizationCookie(
  value: string,
  maxAgeSeconds = 600,
): string {
  return `${CALENDAR_AUTHORIZATION_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/api/calendar-connections; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCalendarAuthorizationCookie(): string {
  return `${CALENDAR_AUTHORIZATION_COOKIE}=; Max-Age=0; Path=/api/calendar-connections; HttpOnly; Secure; SameSite=Lax`;
}

export function googleCalendarCallbackUrl(): string {
  return `${publicAppUrl()}/api/calendar-connections/google/callback`;
}

export function calendarDashboardReturnUrl(result: string): string {
  const url = new URL('/dashboard', `${publicAppUrl()}/`);
  url.searchParams.set('integration', 'google_calendar');
  url.searchParams.set('connection', result);
  return url.toString();
}
