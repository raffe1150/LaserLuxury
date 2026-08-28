import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '../../../services/api';
import { aggregateBusinessAnalytics } from '../../../analytics/queries/business-summary';
import type { LoadedBusinessAnalyticsRows } from '../../../analytics/queries/contracts';
import { resolveAnalyticsWindow } from '../../../analytics/queries/windows';
import {
  AnalyticsDashboardView,
  AnalyticsError,
  AnalyticsLoading,
} from './AnalyticsPage';
import {
  analyticsRequestKey,
  analyticsWindowForSelection,
  createAnalyticsRequestGuard,
  getDashboardAnalytics,
} from './analytics-adapter';
import type { DashboardAnalyticsData } from './analytics-types';

const scope = resolveAnalyticsWindow({
  businessId: 42,
  timezone: 'Europe/Stockholm',
  window: { preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-02' },
});

function analyticsFixture(overrides: Partial<LoadedBusinessAnalyticsRows> = {}): DashboardAnalyticsData {
  return aggregateBusinessAnalytics({
    scope,
    events: [
      {
        business_id: 42,
        event_name: 'conversation_started',
        occurred_at: '2026-08-01T09:59:00.000Z',
        conversation_id: 'private-conversation',
        booking_id: null,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'started',
        reason_code: null,
        idempotency_key: 'private-conversation-key',
      },
      {
        business_id: 42,
        event_name: 'customer_message_received',
        occurred_at: '2026-08-01T10:00:00.000Z',
        conversation_id: 'private-conversation',
        booking_id: null,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'received',
        reason_code: null,
        idempotency_key: 'private-message-key',
      },
      {
        business_id: 42,
        event_name: 'booking_started',
        occurred_at: '2026-08-01T10:01:00.000Z',
        conversation_id: 'private-conversation',
        booking_id: null,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'started',
        reason_code: null,
        idempotency_key: 'private-start-key',
      },
      {
        business_id: 42,
        event_name: 'slot_offered',
        occurred_at: '2026-08-01T10:01:20.000Z',
        conversation_id: 'private-conversation',
        booking_id: null,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'available',
        reason_code: null,
        idempotency_key: 'private-offer-key',
      },
      {
        business_id: 42,
        event_name: 'slot_selected',
        occurred_at: '2026-08-01T10:01:40.000Z',
        conversation_id: 'private-conversation',
        booking_id: null,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'selected',
        reason_code: null,
        idempotency_key: 'private-selection-key',
      },
      {
        business_id: 42,
        event_name: 'booking_completed',
        occurred_at: '2026-08-01T10:02:00.000Z',
        conversation_id: 'private-conversation',
        booking_id: 100,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'success',
        reason_code: null,
        idempotency_key: 'private-completion-key',
      },
      {
        business_id: 42,
        event_name: 'booking_failed',
        occurred_at: '2026-08-01T10:03:00.000Z',
        conversation_id: 'private-conversation',
        booking_id: null,
        channel: 'telegram',
        platform: 'telegram',
        service_id: null,
        service_name_snapshot: 'Consultation',
        outcome: 'failed',
        reason_code: 'no_availability',
        idempotency_key: 'private-failure-key',
      },
    ],
    appointments: [
      { id: 100, business_id: 42, service: 'Consultation', platform: 'telegram', status: 'booked', created_at: '2026-08-01T11:00:00.000Z' },
      { id: 101, business_id: 42, service: 'Unknown price', platform: 'telegram', status: 'booked', created_at: '2026-08-01T12:00:00.000Z' },
    ],
    services: [
      { name: 'Consultation', price: 100, currency: 'SEK' },
      { name: 'Unknown price', price: null, currency: 'SEK' },
    ],
    eventsTruncated: true,
    appointmentsTruncated: false,
    ...overrides,
  });
}

function render(data: DashboardAnalyticsData): string {
  return renderToStaticMarkup(<AnalyticsDashboardView data={data} />);
}

async function runTests(): Promise<void> {
  assert.deepEqual(analyticsWindowForSelection('today'), { preset: 'today' });
  assert.deepEqual(analyticsWindowForSelection('7d'), { preset: 'last_7_days' });
  assert.deepEqual(analyticsWindowForSelection('30d'), { preset: 'last_30_days' });
  assert.equal(analyticsWindowForSelection('custom'), null);
  assert.deepEqual(analyticsWindowForSelection('custom', '2026-08-01', '2026-08-23'), {
    preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-23',
  });

  const data = analyticsFixture();
  const calls: Array<{ businessId: string; window: unknown; signal?: AbortSignal }> = [];
  const originalSummary = api.getBusinessAnalyticsSummary;
  api.getBusinessAnalyticsSummary = async (businessId, window, signal) => {
    calls.push({ businessId, window, signal });
    return data;
  };
  try {
    const windows = [
      { preset: 'today' as const },
      { preset: 'last_7_days' as const },
      { preset: 'last_30_days' as const },
      { preset: 'custom' as const, startDate: '2026-08-01', endDate: '2026-08-23' },
    ];
    const controller = new AbortController();
    for (const [index, window] of windows.entries()) {
      assert.equal(await getDashboardAnalytics(
        { businessId: '42', window },
        index === 0 ? controller.signal : undefined,
      ), data);
    }
    assert.deepEqual(calls.map((call) => call.businessId), ['42', '42', '42', '42']);
    assert.deepEqual(calls.map((call) => call.window), windows);
    assert.equal(calls[0].signal, controller.signal);
  } finally {
    api.getBusinessAnalyticsSummary = originalSummary;
  }

  const markup = render(data);
  for (const label of [
    'New conversations', 'Completed bookings', 'Estimated booking value',
    'Overview', 'Channels', 'Services',
  ]) assert.match(markup, new RegExp(label));
  assert.match(markup, /New conversations[\s\S]*?—[\s\S]*?Incomplete event coverage/);
  for (const removedLabel of [
    'Booking funnel', 'Booking started', 'Slot offered', 'Slot selected',
    'Booking conversion', 'Slot selection', 'Failed attempts', 'No availability',
  ]) assert.doesNotMatch(markup, new RegExp(removedLabel));
  assert.match(markup, /Partial data coverage/);
  assert.match(markup, /1 of 2 bookings priced/);
  assert.match(markup, /not payments/);
  assert.doesNotMatch(markup, /PERFORMANCE OVER TIME|Trend metric|<polyline|analytics-chart-wrap/);
  assert.doesNotMatch(markup, /Demo analytics|Sample data/);
  assert.doesNotMatch(markup, /previous period|vs\.?(?: last| previous)/i);
  assert.doesNotMatch(markup, /Net booking activity|Bookings per message|Reschedules|Cancellations/);

  const complete = structuredClone(data);
  complete.dataQuality.status = 'complete';
  complete.dataQuality.events = 'complete';
  complete.dataQuality.authoritativeAppointments = 'complete';
  complete.dataQuality.conversations = 'complete';
  assert.match(render(complete), /Complete data/);
  assert.match(render(complete), /New conversations[\s\S]*?1[\s\S]*?Conversation starts/);

  const conversationUnavailable = structuredClone(complete);
  conversationUnavailable.dataQuality.status = 'partial';
  conversationUnavailable.dataQuality.conversations = 'unavailable';
  assert.match(render(conversationUnavailable), /New conversations[\s\S]*?—[\s\S]*?Conversation data unavailable/);

  const channelMarkup = renderToStaticMarkup(<AnalyticsDashboardView data={data} initialTab="channels" />);
  assert.match(channelMarkup, /Where bookings come from/);
  assert.match(channelMarkup, /Channel[\s\S]*Conversations[\s\S]*Completed[\s\S]*Conversion[\s\S]*Needs attention/);
  assert.match(channelMarkup, /Telegram/);
  assert.match(channelMarkup, /Telegram[\s\S]*?<strong role="cell">—<\/strong>/);
  const completeChannelMarkup = renderToStaticMarkup(<AnalyticsDashboardView data={complete} initialTab="channels" />);
  assert.match(completeChannelMarkup, /Telegram[\s\S]*?<strong role="cell">1<\/strong>/);
  const serviceMarkup = renderToStaticMarkup(<AnalyticsDashboardView data={data} initialTab="services" />);
  assert.match(serviceMarkup, /What customers book/);
  assert.match(serviceMarkup, /Service[\s\S]*Demand[\s\S]*Started[\s\S]*Completed[\s\S]*Conversion/);
  assert.match(serviceMarkup, /Consultation/);
  assert.match(serviceMarkup, /Consultation[\s\S]*?<strong role="cell">—<\/strong>[\s\S]*?<strong role="cell">—<\/strong>/);
  assert.match(serviceMarkup, /does not currently attribute known-price estimates by service/);

  const backendRate = structuredClone(data);
  backendRate.funnel.bookingConversionRate = 0.37;
  backendRate.channels[0].conversionRate = 0.41;
  backendRate.services[0].conversionRate = 0.23;
  const rateMarkup = render(backendRate);
  assert.doesNotMatch(rateMarkup, /Booking conversion|37%/);
  assert.doesNotMatch(renderToStaticMarkup(<AnalyticsDashboardView data={backendRate} initialTab="channels" />), /41%/);
  const completeBackendRate = structuredClone(backendRate);
  completeBackendRate.dataQuality.status = 'complete';
  completeBackendRate.dataQuality.conversations = 'complete';
  assert.match(renderToStaticMarkup(<AnalyticsDashboardView data={completeBackendRate} initialTab="channels" />), /41%/);
  assert.doesNotMatch(renderToStaticMarkup(<AnalyticsDashboardView data={backendRate} initialTab="services" />), /23%/);
  assert.match(renderToStaticMarkup(<AnalyticsDashboardView data={completeBackendRate} initialTab="services" />), /23%/);

  const nullRate = structuredClone(data);
  nullRate.funnel.bookingConversionRate = null;
  nullRate.channels[0].conversionRate = null;
  nullRate.services[0].conversionRate = null;
  assert.doesNotMatch(render(nullRate), /Booking conversion/);
  assert.match(renderToStaticMarkup(<AnalyticsDashboardView data={nullRate} initialTab="channels" />), /Conversion[\s\S]*?—/);
  assert.match(renderToStaticMarkup(<AnalyticsDashboardView data={nullRate} initialTab="services" />), /Conversion[\s\S]*?—/);

  const unavailable = structuredClone(data);
  unavailable.dataQuality.status = 'unavailable';
  unavailable.revenue.coverage = 'unavailable';
  assert.match(render(unavailable), /Data unavailable/);
  assert.match(render(unavailable), /No zero-value performance claim is being made/);

  const empty = analyticsFixture({
    events: [], appointments: [], services: [], eventsTruncated: false,
  });
  assert.match(render(empty), /New conversations[\s\S]*?0[\s\S]*?Conversation starts/);
  assert.doesNotMatch(render(empty), /temporarily unavailable/);
  assert.match(renderToStaticMarkup(<AnalyticsLoading />), /Loading analytics/);
  assert.match(renderToStaticMarkup(<AnalyticsError message="Safe error" onRetry={() => undefined} />), /Try again/);

  const businessGuard = createAnalyticsRequestGuard();
  const businessA = businessGuard.begin();
  const businessB = businessGuard.begin();
  let displayedBusiness = '';
  if (businessB.isCurrent()) displayedBusiness = 'Business B';
  if (businessA.isCurrent()) displayedBusiness = 'Business A';
  assert.equal(businessA.isCurrent(), false);
  assert.equal(businessB.isCurrent(), true);
  assert.equal(displayedBusiness, 'Business B');
  const windowGuard = createAnalyticsRequestGuard();
  const thirtyDays = windowGuard.begin();
  const today = windowGuard.begin();
  let displayedWindow = '';
  if (today.isCurrent()) displayedWindow = 'today';
  if (thirtyDays.isCurrent()) displayedWindow = 'last_30_days';
  assert.equal(thirtyDays.isCurrent(), false);
  assert.equal(today.isCurrent(), true);
  assert.equal(displayedWindow, 'today');
  assert.notEqual(
    analyticsRequestKey({ businessId: '7', window: { preset: 'today' } }),
    analyticsRequestKey({ businessId: '8', window: { preset: 'today' } }),
  );
  assert.notEqual(
    analyticsRequestKey({ businessId: '7', window: { preset: 'today' } }),
    analyticsRequestKey({ businessId: '7', window: { preset: 'last_30_days' } }),
  );

  const serialized = JSON.stringify(data);
  for (const forbidden of [
    'private-conversation', 'private-message-key', 'idempotency_key',
    'conversation_id', 'customer_name', 'phone_number', 'metadata',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);

  const frontendSource = [
    'AnalyticsPage.tsx', 'analytics-adapter.ts', 'analytics-types.ts',
  ].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  assert.match(frontendSource, /api\.getBusinessAnalyticsSummary/);
  assert.doesNotMatch(frontendSource, /@supabase|analytics_events|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(frontendSource, /bookingCompleted\s*\/\s*bookingStarted|bookingStarted\s*\/\s*customerMessages/);
  assert.doesNotMatch(frontendSource, /previousPeriod|periodComparison|growthRate/);
  assert.doesNotMatch(frontendSource, /customer_key|conversation_id|idempotency_key|message content/i);

  console.log('Phase 4B.1 analytics UX tests passed.');
}

void runTests();
