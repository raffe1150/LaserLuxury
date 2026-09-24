import { google } from 'googleapis';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

function requiredEnv(name: 'GOOGLE_OAUTH_CLIENT_ID' | 'GOOGLE_OAUTH_CLIENT_SECRET'): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

export function createGoogleCalendarOAuthClient(redirectUri: string) {
  return new google.auth.OAuth2(
    requiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
    requiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri,
  );
}

export function buildGoogleCalendarAuthorizationUrl(
  state: string,
  redirectUri: string,
): string {
  const oauth = createGoogleCalendarOAuthClient(redirectUri);

  return oauth.generateAuthUrl({
    access_type: 'offline',
    include_granted_scopes: true,
    prompt: 'consent',
    state,
    scope: [...GOOGLE_CALENDAR_SCOPES],
  });
}

export async function revokeGoogleCalendarCredential(
  token: string,
  redirectUri: string,
): Promise<void> {
  const value = String(token || '').trim();
  if (!value) return;

  const oauth = createGoogleCalendarOAuthClient(redirectUri);
  await oauth.revokeToken(value);
}

export async function exchangeGoogleCalendarCode(
  code: string,
  redirectUri: string,
) {
  const oauth = createGoogleCalendarOAuthClient(redirectUri);

  const { tokens } = await oauth.getToken(code);

  if (!tokens.access_token) {
    throw new Error('google_calendar_access_token_missing');
  }

  oauth.setCredentials(tokens);

  const calendar = google.calendar({
    version: 'v3',
    auth: oauth,
  });

  const calendarList = await calendar.calendarList.list({
    maxResults: 250,
    minAccessRole: 'writer',
  });

  const calendars = (calendarList.data.items || [])
    .filter(item => item.id)
    .map(item => ({
      id: String(item.id),
      name: String(item.summaryOverride || item.summary || item.id),
      primary: Boolean(item.primary),
      accessRole: item.accessRole || null,
      timeZone: item.timeZone || null,
    }));

  if (!calendars.length) {
    throw new Error('google_calendar_no_writable_calendar');
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || undefined,
    tokenType: tokens.token_type || 'Bearer',
    expiresAt: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null,
    grantedScopes: String(tokens.scope || '')
      .split(/\s+/)
      .filter(Boolean),
    calendars,
  };
}
