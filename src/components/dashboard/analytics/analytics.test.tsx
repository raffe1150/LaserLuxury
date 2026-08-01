import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AnalyticsDashboardView,
  AnalyticsError,
  AnalyticsLoading,
} from './AnalyticsPage';
import { buildAnalyticsDateRange, getDashboardAnalytics } from './analytics-adapter';
import { createDemoAnalyticsData } from './analytics-demo-data';
import type { DashboardAnalyticsData } from './analytics-types';

const REQUEST = {
  businessId: 42,
  from: '2026-06-01T00:00:00.000Z',
  to: '2026-06-08T00:00:00.000Z',
};

function render(data: DashboardAnalyticsData): string {
  return renderToStaticMarkup(<AnalyticsDashboardView data={data} />);
}

async function runTests(): Promise<void> {
  const now = new Date('2026-08-01T15:30:00.000Z');
  const ranges = [
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const;
  for (const [preset, maximumDays] of ranges) {
    const range = buildAnalyticsDateRange(preset, now);
    const duration = Date.parse(range.to) - Date.parse(range.from);
    assert.ok(duration > 0 && duration <= maximumDays * 86_400_000, preset);
    assert.match(range.from, /Z$/);
    assert.match(range.to, /Z$/);
  }

  const data = await getDashboardAnalytics(REQUEST);
  assert.equal(data.scope.businessId, 42);
  assert.equal(data.completeness.truncated, false);
  assert.equal(data.platforms.length, 4);
  assert.equal(data.services.rows.length >= 3, true);
  assert.deepEqual(data.services.rows.map((service) => service.serviceName), ['Consultation', 'Signature treatment', 'Follow-up']);
  assert.equal(data.daily.length, 7);
  assert.equal(data.daily.some((day) => Object.values(day).filter(Number.isFinite).every((value) => value === 0)), true);
  assert.equal(data.summary.bookingMessageRatio, data.summary.bookingsCreated / data.summary.messagesReceived);
  assert.equal(data.summary.messagesReceived, data.daily.reduce((sum, day) => sum + day.messagesReceived, 0));
  assert.equal(data.summary.bookingsCreated, data.daily.reduce((sum, day) => sum + day.bookingsCreated, 0));
  await assert.rejects(getDashboardAnalytics({ ...REQUEST, businessId: 0 }), /selected business/);

  const markup = render(data);
  for (const label of [
    'Messages received', 'Bookings created', 'Reschedules', 'Cancellations',
    'Net booking activity', 'Bookings per message',
  ]) assert.match(markup, new RegExp(label));
  for (const platform of ['Telegram', 'WhatsApp', 'Messenger', 'Instagram']) {
    assert.match(markup, new RegExp(platform));
  }
  assert.match(markup, /Demo analytics/);
  assert.match(markup, /Unattributed/);
  assert.match(markup, /not a customer-level conversion rate/);
  assert.match(renderToStaticMarkup(<AnalyticsDashboardView data={data} mode="live" />), /Complete/);

  const unknownPlatform = structuredClone(data);
  unknownPlatform.platforms.push({
    platform: 'tiktok' as never,
    messagesReceived: 999,
    bookingsCreated: 999,
    bookingsRescheduled: 999,
    bookingsCancelled: 999,
    bookingMessageRatio: 1,
  });
  assert.doesNotMatch(render(unknownPlatform), /tiktok/i);

  const nullRatio = structuredClone(data);
  nullRatio.summary.bookingMessageRatio = null;
  assert.match(render(nullRatio), /Bookings per message[\s\S]*?—/);

  const partial = structuredClone(data);
  partial.completeness.truncated = true;
  assert.match(render(partial), /partial data for the selected period/);

  const truncatedServices = structuredClone(data);
  truncatedServices.services.truncated = true;
  assert.match(render(truncatedServices), /Showing top services for this period/);

  const empty = createDemoAnalyticsData(REQUEST);
  empty.summary = {
    messagesReceived: 0,
    bookingsCreated: 0,
    bookingsRescheduled: 0,
    bookingsCancelled: 0,
    netBookingActivity: 0,
    bookingMessageRatio: null,
  };
  assert.match(render(empty), /No analytics activity was recorded for this period/);
  assert.match(renderToStaticMarkup(<AnalyticsLoading />), /Loading analytics/);
  assert.match(renderToStaticMarkup(<AnalyticsError message="Safe error" onRetry={() => undefined} />), /Try again/);

  const frontendSource = [
    'AnalyticsPage.tsx',
    'analytics-adapter.ts',
    'analytics-demo-data.ts',
    'analytics-types.ts',
  ].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(frontendSource, /@supabase|analytics_events|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(frontendSource, /customer_key|conversation_id|idempotency_key|message content/i);

  console.log('Dashboard analytics UI tests passed.');
}

void runTests();
