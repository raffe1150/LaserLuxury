import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateBusinessAnalytics } from '../analytics/queries/business-summary';
import type {
  BusinessMetricAppointmentRow,
  BusinessMetricEventRow,
  LoadedBusinessAnalyticsRows,
} from '../analytics/queries/contracts';
import { resolveAnalyticsWindow } from '../analytics/queries/windows';
import type { IntegrationHealth } from '../types/dashboard';
import { buildDashboardTodaySummary, resolveDashboardOperationalStatus } from './summary';

const scope = resolveAnalyticsWindow({
  businessId: 7,
  timezone: 'Europe/Stockholm',
  window: { preset: 'today' },
  now: new Date('2026-08-24T12:00:00.000Z'),
});

function event(
  name: string,
  id: string,
  overrides: Partial<BusinessMetricEventRow> = {},
): BusinessMetricEventRow {
  return {
    business_id: 7,
    event_name: name,
    occurred_at: '2026-08-24T10:00:00.000Z',
    conversation_id: `conversation-${id}`,
    booking_id: null,
    channel: 'telegram',
    platform: 'telegram',
    service_id: null,
    service_name_snapshot: null,
    outcome: 'observed',
    reason_code: null,
    idempotency_key: id,
    ...overrides,
  };
}

function appointment(
  id: number,
  status: string,
  service: string,
  overrides: Partial<BusinessMetricAppointmentRow> = {},
): BusinessMetricAppointmentRow {
  return {
    id,
    business_id: 7,
    status,
    service,
    platform: 'telegram',
    created_at: '2026-08-24T11:00:00.000Z',
    ...overrides,
  };
}

const verifiedHealth: IntegrationHealth[] = [{
  key: 'telegram',
  label: 'Telegram',
  status: 'connected',
  detail: 'Connection verified.',
  lastCheckedAt: '2026-08-24T11:59:00.000Z',
  stale: false,
  reasonCode: 'verified',
}];

function aggregate(overrides: Partial<LoadedBusinessAnalyticsRows> = {}) {
  return aggregateBusinessAnalytics({
    scope,
    events: [],
    appointments: [],
    services: [],
    eventsTruncated: false,
    appointmentsTruncated: false,
    ...overrides,
  });
}

async function runTests(): Promise<void> {
  assert.equal(scope.from, '2026-08-23T22:00:00.000Z');
  assert.equal(scope.to, '2026-08-24T22:00:00.000Z');
  assert.equal(scope.timezone, 'Europe/Stockholm');

  const analytics = aggregate({
    events: [
      event('conversation_started', 'inside'),
      event('conversation_started', 'before', { occurred_at: '2026-08-23T21:59:59.999Z' }),
      event('conversation_started', 'exclusive-end', { occurred_at: scope.to }),
      event('customer_message_received', 'message-1', { conversation_id: 'canonical-conversation' }),
      event('customer_message_received', 'message-2', { conversation_id: 'canonical-conversation' }),
    ],
    appointments: [
      appointment(1, 'booked', 'Known'),
      appointment(2, 'completed', 'Missing'),
      appointment(3, 'cancelled', 'Known'),
      appointment(4, 'pending', 'Known'),
      appointment(5, 'unknown', 'Known'),
      appointment(6, 'booked', 'Known', { created_at: scope.to }),
      appointment(7, 'booked', 'Known', { business_id: 8 }),
    ],
    services: [{ name: 'Known', price: 250, currency: 'SEK' }],
  });
  const dashboard = buildDashboardTodaySummary(analytics, {
    health: verifiedHealth,
    activeNotificationCount: 0,
  });

  assert.equal(dashboard.scope.preset, 'today');
  assert.equal(dashboard.scope.timezone, 'Europe/Stockholm');
  assert.equal(dashboard.conversationsToday.value, 1);
  assert.equal(dashboard.conversationsToday.quality, 'available');
  assert.match(dashboard.conversationsToday.source, /customer_message_received/);
  assert.equal(dashboard.completedBookingsToday.value, 2);
  assert.equal(dashboard.completedBookingsToday.source, 'appointments_booked_or_completed_by_created_at');
  assert.deepEqual(dashboard.estimatedBookingValue.amounts, [{ currency: 'SEK', amount: 250 }]);
  assert.equal(dashboard.estimatedBookingValue.quality, 'partial');
  assert.equal(dashboard.estimatedBookingValue.knownPriceCount, 1);
  assert.equal(dashboard.estimatedBookingValue.unknownPriceCount, 1);
  assert.equal(dashboard.operationalStatus.state, 'operational');

  const noKnownPrices = buildDashboardTodaySummary(aggregate({
    appointments: [appointment(20, 'booked', 'Missing')],
  }), { health: verifiedHealth, activeNotificationCount: 0 });
  assert.equal(noKnownPrices.estimatedBookingValue.quality, 'unavailable');
  assert.deepEqual(noKnownPrices.estimatedBookingValue.amounts, []);
  assert.equal(noKnownPrices.estimatedBookingValue.completedBookingCount, 1);

  const realZero = buildDashboardTodaySummary(aggregate(), {
    health: verifiedHealth,
    activeNotificationCount: 0,
  });
  assert.equal(realZero.conversationsToday.value, 0);
  assert.equal(realZero.completedBookingsToday.value, 0);
  assert.equal(realZero.estimatedBookingValue.quality, 'available');

  assert.equal(resolveDashboardOperationalStatus({
    health: verifiedHealth,
    activeNotificationCount: 2,
  }).state, 'attention');
  assert.equal(resolveDashboardOperationalStatus({
    health: null,
    activeNotificationCount: null,
  }).state, 'unavailable');
  const healthUnavailable = buildDashboardTodaySummary(analytics, {
    health: null,
    activeNotificationCount: 0,
  });
  assert.equal(healthUnavailable.operationalStatus.state, 'unavailable');
  assert.equal(healthUnavailable.conversationsToday.value, 1);
  assert.equal(healthUnavailable.completedBookingsToday.value, 2);
  const notificationsUnavailable = buildDashboardTodaySummary(analytics, {
    health: verifiedHealth,
    activeNotificationCount: null,
  });
  assert.equal(notificationsUnavailable.operationalStatus.state, 'unavailable');
  assert.equal(notificationsUnavailable.conversationsToday.value, 1);
  assert.equal(notificationsUnavailable.completedBookingsToday.value, 2);
  assert.equal(resolveDashboardOperationalStatus({
    health: [{ ...verifiedHealth[0], stale: true }],
    activeNotificationCount: 0,
  }).state, 'unavailable');

  const pageSource = readFileSync(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(pageSource, /data\.bookings\.length/);
  assert.doesNotMatch(pageSource, /Customers helped today|Saved for your team|AUTOMATION SCORE/);
  assert.doesNotMatch(pageSource, /Everything is running smoothly|Created directly by OdinLink|hourly value/);
  assert.doesNotMatch(pageSource, /estimatedMinutesSaved|automationRate|\*\s*4|\*\s*300/);
  assert.doesNotMatch(pageSource, /mission-impact-card|action-center|<ImpactMetric/);
  assert.match(pageSource, /className=\{`mission-status-indicator \$\{statusClass\}`\}/);
  assert.match(pageSource, /<span>\{t\(operationalStatus\.title\)\}<\/span>/);
  assert.match(pageSource, /icon="customers"[\s\S]*icon="bookings"[\s\S]*icon="value"/);
  assert.equal((pageSource.match(/metricLabel\('Conversations today'/g) || []).length, 1);
  assert.equal((pageSource.match(/metricLabel\('Completed bookings today'/g) || []).length, 1);
  assert.match(pageSource, /metric && metric\.value !== null \? new Intl\.NumberFormat\(locale\)\.format\(metric\.value\) : '—'/);
  assert.match(pageSource, /t\('\{label\} · partial', \{ label: t\('Estimated booking value today'\) \}\)/);
  assert.match(pageSource, /const canonicalBookingMetric = summary\?\.completedBookingsToday/);
  assert.equal((pageSource.match(/summary\?\.completedBookingsToday/g) || []).length, 1);
  assert.match(pageSource, /if \(!active\) return/);
  assert.match(pageSource, /current\.selectedBusiness\?\.id !== selectedBusiness\.id/);
  assert.match(
    pageSource,
    /setNotificationRefreshKey\(\(value\) => value \+ 1\);\s*setRefreshKey\(\(value\) => value \+ 1\);/,
    'verified Health and synchronized Notifications refresh the canonical dashboard summary',
  );

  const apiSource = readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /getDashboardSummary\(selectedBusiness\.id\)/);
  assert.match(apiSource, /catch\(\(\) => \(\{ status: 'unavailable' as const \}\)\)/);
  assert.doesNotMatch(apiSource, /getDashboardSummary[\s\S]{0,300}catch\(\(\) => 0\)/);

  const cssSource = readFileSync(new URL('../styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(cssSource, /hero-result-grid\.dashboard-primary-kpis\{\s*grid-template-columns:repeat\(3/);
  assert.match(cssSource, /@media\(max-width:900px\)[\s\S]*dashboard-primary-kpis[\s\S]*repeat\(2/);
  assert.match(cssSource, /@media\(max-width:600px\)[\s\S]*dashboard-primary-kpis[\s\S]*grid-template-columns:1fr/);

  console.log('Dashboard authoritative today summary tests passed.');
}

void runTests();
