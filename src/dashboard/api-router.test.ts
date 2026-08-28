import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import type { AuthenticatedRequest } from '../auth/types';
import { aggregateBusinessAnalytics } from '../analytics/queries/business-summary';
import { resolveAnalyticsWindow } from '../analytics/queries/windows';
import { createDashboardSummaryRouter } from './api-router';

async function runTests(): Promise<void> {
  const seenBusinessIds: number[] = [];
  let fail = false;
  const app = express();
  app.use('/api/businesses', createDashboardSummaryRouter({
    requireAuth: (request, _response, next) => {
      (request as AuthenticatedRequest).auth = { userId: 'user-7' };
      next();
    },
    requireAnalyticsPermission: (request, _response, next) => {
      (request as AuthenticatedRequest).businessAccess = {
        businessId: 7,
        role: 'viewer',
      };
      next();
    },
    loadAnalyticsSummary: async (request) => {
      if (fail) throw new Error('private database failure');
      seenBusinessIds.push(request.businessId);
      assert.deepEqual(request.window, { preset: 'today' });
      return aggregateBusinessAnalytics({
        scope: resolveAnalyticsWindow({
          businessId: request.businessId,
          timezone: 'Europe/Stockholm',
          window: request.window,
          now: new Date('2026-08-24T12:00:00.000Z'),
        }),
        events: [],
        appointments: [],
        services: [],
        eventsTruncated: false,
        appointmentsTruncated: false,
      });
    },
    loadOperationalSources: async (businessId) => {
      assert.equal(businessId, 7);
      return { health: null, activeNotificationCount: null };
    },
  }));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/businesses`;

  try {
    const response = await fetch(`${base}/999/dashboard/summary`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scope.businessId, 7);
    assert.equal(body.scope.preset, 'today');
    assert.equal(body.conversationsToday.value, 0);
    assert.equal(body.operationalStatus.state, 'unavailable');
    assert.deepEqual(seenBusinessIds, [7]);

    fail = true;
    const failed = await fetch(`${base}/7/dashboard/summary`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'dashboard_summary_unavailable' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log('Dashboard authenticated summary API tests passed.');
}

void runTests();
