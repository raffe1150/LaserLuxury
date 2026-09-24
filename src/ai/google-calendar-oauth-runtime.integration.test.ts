import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

process.env.GOOGLE_CLIENT_EMAIL = 'legacy-service-account@example.test';
process.env.GOOGLE_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';
process.env.GOOGLE_CALENDAR_ID = 'legacy-calendar@example.test';

const {
  priority1hUnifiedEngineTestBoundary: boundary,
} = await import('../../server');

test('legacy Google Calendar config still resolves through service-account adapter', () => {
  boundary.reset();

  const adapter = boundary.calendarAdapterForConfig({
    businessRecordId: 7,
    businessName: 'Legacy Business',
    calendarProvider: 'google',
    googleCalendarId: 'legacy-calendar@example.test',
    googleClientEmail: 'legacy-service-account@example.test',
    googlePrivateKey:
      '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----',
  });

  assert.equal(
    adapter.getCalendarId(),
    'legacy-calendar@example.test',
  );
});

test('self-service Google Calendar never falls back to global service-account credentials when OAuth credentials are incomplete', () => {
  boundary.reset();

  assert.throws(
    () =>
      boundary.calendarAdapterForConfig({
        businessRecordId: 8,
        businessName: 'OAuth Business',
        calendarProvider: 'google',
        googleCalendarId: 'oauth-calendar@example.test',
        googleCalendarConnectionSource: 'self_service',
        googleCalendarOAuthAccessToken: 'oauth-access-token',
        googleCalendarOAuthRefreshToken: '',
      }),
    /Google Calendar OAuth connection is incomplete/,
  );
});

test('Google OAuth refresh preserves the existing refresh token when Google only returns a new access token', () => {
  const refreshed =
    boundary.normalizeCalendarOAuthRefreshForTest(
      {
        access_token: 'new-access-token',
        expiry_date: 1790000000000,
      },
      'existing-refresh-token',
      'Bearer',
    );

  assert.equal(
    refreshed.accessToken,
    'new-access-token',
  );

  assert.equal(
    refreshed.refreshToken,
    'existing-refresh-token',
  );

  assert.equal(
    refreshed.tokenType,
    'Bearer',
  );

  assert.equal(
    refreshed.tokenExpiresAt,
    new Date(1790000000000).toISOString(),
  );
});

test('Google OAuth refresh uses a newly issued refresh token when Google provides one', () => {
  const refreshed =
    boundary.normalizeCalendarOAuthRefreshForTest(
      {
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        token_type: 'Bearer',
      },
      'existing-refresh-token',
      'Bearer',
    );

  assert.equal(
    refreshed.refreshToken,
    'rotated-refresh-token',
  );
});
