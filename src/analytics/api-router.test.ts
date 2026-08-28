import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createRequireAuth } from '../auth/require-auth';
import { createRequireBusinessPermission } from '../auth/require-business-access';
import { createAnalyticsApiRouter } from './api-router';
import { aggregateBusinessAnalytics } from './queries/business-summary';
import type { BusinessAnalyticsRequest, LoadedBusinessAnalyticsRows } from './queries/contracts';
import { resolveAnalyticsWindow } from './queries/windows';
import type { AnalyticsReconciliationReport } from './reconciliation';

const authorizedBusinessId = 7;
const privateConversation = 'private-conversation-id';
const privateEvent = 'private-idempotency-key';

const fixtureScope = resolveAnalyticsWindow({
  businessId: authorizedBusinessId,
  timezone: 'Europe/Stockholm',
  window: { preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-02' },
});

const fixture: LoadedBusinessAnalyticsRows = {
  scope: fixtureScope,
  events: [
    {
      business_id: authorizedBusinessId,
      event_name: 'conversation_started',
      occurred_at: '2026-08-01T10:00:00.000Z',
      conversation_id: privateConversation,
      booking_id: null,
      channel: 'telegram',
      platform: 'telegram',
      service_id: null,
      service_name_snapshot: 'Known service',
      outcome: 'started',
      reason_code: null,
      idempotency_key: privateEvent,
    },
    {
      business_id: authorizedBusinessId,
      event_name: 'booking_started',
      occurred_at: '2026-08-01T10:01:00.000Z',
      conversation_id: privateConversation,
      booking_id: null,
      channel: 'telegram',
      platform: 'telegram',
      service_id: null,
      service_name_snapshot: 'Known service',
      outcome: 'started',
      reason_code: null,
      idempotency_key: 'private-booking-start-key',
    },
  ],
  appointments: [
    {
      id: 100,
      business_id: authorizedBusinessId,
      service: 'Known service',
      platform: 'telegram',
      status: 'booked',
      created_at: '2026-08-01T11:00:00.000Z',
    },
    {
      id: 101,
      business_id: authorizedBusinessId,
      service: 'Unknown price',
      platform: 'telegram',
      status: 'booked',
      created_at: '2026-08-01T12:00:00.000Z',
    },
  ],
  services: [
    { name: 'Known service', price: 250, currency: 'SEK' },
    { name: 'Unknown price', price: null, currency: 'SEK' },
  ],
  eventsTruncated: true,
  appointmentsTruncated: false,
};

const summary = aggregateBusinessAnalytics(fixture);
const reconciliation: AnalyticsReconciliationReport = {
  generatedAt: '2026-08-23T00:00:00.000Z',
  scope: {
    businessId: authorizedBusinessId,
    from: fixtureScope.from,
    to: fixtureScope.to,
    boundarySource: 'caller',
  },
  summary: {
    checkedEvents: 2,
    checkedAppointments: 2,
    scanTruncated: false,
    issueCount: 1,
    sampledIssueCount: 1,
    criticalCount: 1,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    issuesTruncated: false,
  },
  issueCounts: { COMPLETION_WITHOUT_AUTHORITATIVE_APPOINTMENT: 1 },
  issues: [{
    code: 'COMPLETION_WITHOUT_AUTHORITATIVE_APPOINTMENT',
    severity: 'critical',
    eventId: 'private-event-id',
    bookingId: 999,
  }],
  volume: [],
  coverage: {
    exactIdempotencyDuplicates: 'checked',
    bookingCreated: 'deferred_missing_appointment_index',
    bookingCompleted: 'checked',
    authoritativeAppointments: 'checked',
    funnelOrdering: 'checked_when_conversation_correlated',
    bookingCancelled: 'not_deterministically_reconcilable',
    bookingRescheduled: 'latest_event_only',
    customerMessageReceived: 'internal_quality_only',
  },
};

function authorizationClient(): SupabaseClient {
  return {
    from() {
      const filters = new Map<string, unknown>();
      const chain: any = {
        select() { return chain; },
        eq(column: string, value: unknown) { filters.set(column, value); return chain; },
        maybeSingle() {
          const allowed = Number(filters.get('business_id')) === authorizedBusinessId
            && filters.get('user_id') === 'user-7'
            && filters.get('status') === 'active';
          return Promise.resolve({
            data: allowed ? {
              business_id: authorizedBusinessId,
              user_id: 'user-7',
              role: 'viewer',
              status: 'active',
            } : null,
            error: null,
          });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

async function runTests(): Promise<void> {
  const seen: BusinessAnalyticsRequest[] = [];
  let reconciliationCalls = 0;
  let failSummary = false;
  const app = express();
  const authClient = {
    auth: {
      getUser: async (token: string) => token === 'valid-token'
        ? { data: { user: { id: 'user-7' } }, error: null }
        : { data: { user: null }, error: { message: 'invalid private token detail' } },
    },
  } as unknown as Pick<SupabaseClient, 'auth'>;
  app.use('/api/businesses', createAnalyticsApiRouter({
    requireAuth: createRequireAuth(authClient),
    requireAnalyticsPermission: createRequireBusinessPermission('analytics.read', {
      client: authorizationClient(),
    }),
    loadSummary: async (request) => {
      if (failSummary) throw new Error('private database and credential detail');
      resolveAnalyticsWindow({
        businessId: request.businessId,
        timezone: 'Europe/Stockholm',
        window: request.window,
      });
      seen.push(request);
      return summary;
    },
    loadScope: async (request) => resolveAnalyticsWindow({
      businessId: request.businessId,
      timezone: 'Europe/Stockholm',
      window: request.window,
    }),
    loadReconciliation: async () => {
      reconciliationCalls += 1;
      return reconciliation;
    },
  }));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/businesses`;
  const get = (path: string, authenticated = true) => fetch(`${base}${path}`, {
    headers: authenticated ? { authorization: 'Bearer valid-token' } : {},
  });

  try {
    assert.equal((await get('/7/analytics/summary?window=today', false)).status, 401);

    for (const window of ['today', 'last_7_days', 'last_30_days']) {
      const response = await get(`/7/analytics/summary?window=${window}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), summary);
    }
    const custom = await get('/7/analytics/summary?window=custom&startDate=2026-08-01&endDate=2026-08-02');
    assert.equal(custom.status, 200);
    const customBody = await custom.json();
    assert.deepEqual(customBody, summary);
    assert.equal(customBody.dataQuality.status, 'partial');
    assert.equal(customBody.revenue.revenueKnownCount, 1);
    assert.equal(customBody.revenue.revenueUnknownCount, 1);
    assert.equal(customBody.channels[0].channel, 'telegram');
    assert.equal(customBody.services[0].serviceName, 'Known service');

    const serialized = JSON.stringify(customBody);
    for (const forbidden of [
      privateConversation, privateEvent, 'idempotency_key', 'conversation_id',
      'customer_name', 'phone_number', 'metadata', 'credential',
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);

    const beforeForbidden = seen.length;
    assert.equal((await get('/8/analytics/summary?window=today')).status, 403);
    assert.equal(seen.length, beforeForbidden);
    assert.equal((await get('/not-a-number/analytics/summary?window=today')).status, 400);

    for (const query of [
      'window=unsupported',
      'window=custom&startDate=2026-08-02&endDate=2026-08-01',
      'window=custom&startDate=2026-02-30&endDate=2026-03-01',
      'window=custom&startDate=2025-01-01&endDate=2026-08-01',
      'window=today&startDate=2026-08-01',
      'window=today&group=channel',
    ]) assert.equal((await get(`/7/analytics/summary?${query}`)).status, 400, query);

    assert.equal(reconciliationCalls, 0);

    const reconciliationResponse = await get('/7/analytics/reconciliation?window=last_7_days');
    assert.equal(reconciliationResponse.status, 200);
    const reconciliationBody = await reconciliationResponse.json();
    assert.equal(reconciliationBody.summary.criticalCount, 1);
    assert.equal('issues' in reconciliationBody, false);
    assert.equal(JSON.stringify(reconciliationBody).includes('private-event-id'), false);
    assert.equal(reconciliationCalls, 1);
    assert.equal((await get('/8/analytics/reconciliation?window=today')).status, 403);

    failSummary = true;
    const failed = await get('/7/analytics/summary?window=today');
    assert.equal(failed.status, 500);
    const failedText = await failed.text();
    assert.equal(failedText.includes('private database'), false);
    assert.equal(failedText.includes('credential'), false);
    assert.deepEqual(JSON.parse(failedText), { error: 'analytics_unavailable' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  assert.deepEqual(seen.map((request) => request.window.preset), [
    'today', 'last_7_days', 'last_30_days', 'custom',
  ]);
  const routerSource = readFileSync(new URL('./api-router.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(routerSource, /booking_completed\s*\/\s*booking_started|slot_selected\s*\/\s*slot_offered/);
  assert.doesNotMatch(routerSource, /\.from\(['"]analytics_events|\.from\(['"]appointments/);
  console.log('Phase 3 authenticated analytics API tests passed.');
}

void runTests();
