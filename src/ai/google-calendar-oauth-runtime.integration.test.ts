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
