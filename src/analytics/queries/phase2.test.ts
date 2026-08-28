import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadBusinessAnalyticsRows } from './business-loader';
import { aggregateBusinessAnalytics } from './business-summary';
import type {
  BusinessMetricAppointmentRow,
  BusinessMetricEventRow,
  LoadedBusinessAnalyticsRows,
} from './contracts';
import { resolveAnalyticsWindow } from './windows';

const scope = resolveAnalyticsWindow({
  businessId: 7,
  timezone: 'Europe/Stockholm',
  window: { preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-02' },
});

function event(
  eventName: string,
  id: string,
  overrides: Partial<BusinessMetricEventRow> = {},
): BusinessMetricEventRow {
  return {
    business_id: 7,
    event_name: eventName,
    occurred_at: '2026-08-01T10:00:00.000Z',
    conversation_id: 'private-correlation-must-not-return',
    booking_id: null,
    channel: 'telegram',
    platform: 'telegram',
    service_id: null,
    service_name_snapshot: 'Consultation',
    outcome: 'observed',
    reason_code: null,
    idempotency_key: id,
    ...overrides,
  };
}

function appointment(
  id: number,
  service: string,
  overrides: Partial<BusinessMetricAppointmentRow> = {},
): BusinessMetricAppointmentRow {
  return {
    id,
    business_id: 7,
    service,
    platform: 'telegram',
    status: 'booked',
    created_at: '2026-08-01T11:00:00.000Z',
    ...overrides,
  };
}

function loaded(overrides: Partial<LoadedBusinessAnalyticsRows> = {}): LoadedBusinessAnalyticsRows {
  return {
    scope,
    events: [],
    appointments: [],
    services: [],
    eventsTruncated: false,
    appointmentsTruncated: false,
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  const today = resolveAnalyticsWindow({
    businessId: 7,
    timezone: 'Europe/Stockholm',
    window: { preset: 'today' },
    now: new Date('2026-03-29T12:00:00.000Z'),
  });
  assert.equal(today.from, '2026-03-28T23:00:00.000Z');
  assert.equal(today.to, '2026-03-29T22:00:00.000Z');
  assert.equal(today.toMs - today.fromMs, 23 * 60 * 60 * 1_000);
  const sevenDays = resolveAnalyticsWindow({
    businessId: 7,
    timezone: 'Europe/Stockholm',
    window: { preset: 'last_7_days' },
    now: new Date('2026-08-23T12:00:00.000Z'),
  });
  assert.equal(sevenDays.startDate, '2026-08-17');
  assert.equal(sevenDays.endDate, '2026-08-23');
  assert.equal(scope.from, '2026-07-31T22:00:00.000Z');
  assert.equal(scope.to, '2026-08-02T22:00:00.000Z');

  const events: BusinessMetricEventRow[] = [
    event('conversation_started', 'conversation-1'),
    event('conversation_started', 'conversation-2', { conversation_id: 'conversation-2', channel: 'whatsapp', platform: 'whatsapp' }),
    event('customer_message_received', 'message-1'),
    event('customer_message_received', 'message-2', { conversation_id: 'conversation-2', channel: 'whatsapp', platform: 'whatsapp' }),
    event('booking_started', 'start-1'),
    event('booking_started', 'start-1'),
    event('availability_requested', 'availability-1'),
    event('slot_offered', 'offer-1'),
    event('slot_selected', 'selection-1'),
    event('booking_completed', 'completion-1', { booking_id: 101 }),
    event('booking_completed', 'completion-duplicate-key', { booking_id: 101 }),
    event('booking_failed', 'failure-1', { reason_code: 'no_availability', channel: 'whatsapp', platform: 'whatsapp' }),
    event('booking_failed', 'failure-2', { reason_code: 'calendar_create_failed', service_name_snapshot: 'Other' }),
    event('booking_started', 'other-tenant', { business_id: 8 }),
    event('booking_started', 'outside-window', { occurred_at: scope.to }),
  ];
  const result = aggregateBusinessAnalytics(loaded({
    events,
    appointments: [
      appointment(101, 'Consultation'),
      appointment(102, 'Unknown service'),
      appointment(103, 'Euro service'),
      appointment(104, 'Consultation', { business_id: 8 }),
      appointment(105, 'Consultation', { created_at: scope.to }),
    ],
    services: [
      { name: 'Consultation', price: 100, currency: 'SEK' },
      { name: 'Unknown service', price: null, currency: 'SEK' },
      { name: 'Euro service', price: 50, currency: 'EUR' },
    ],
  }));

  assert.deepEqual(result.conversations, {
    totalConversations: 2,
    customerMessages: 2,
    activeConversations: 2,
    activeConversationDefinition: 'distinct_correlated_conversations_with_customer_message_in_window',
  });
  assert.equal(result.funnel.bookingStarted, 1);
  assert.equal(result.funnel.availabilityRequested, 1);
  assert.equal(result.funnel.slotOffered, 1);
  assert.equal(result.funnel.slotSelected, 1);
  assert.equal(result.funnel.bookingCompleted, 1);
  assert.equal(result.funnel.bookingFailed, 2);
  assert.equal(result.funnel.bookingAbandoned, null);
  assert.equal(result.funnel.bookingConversionRate, 1);
  assert.equal(result.funnel.slotSelectionRate, 1);
  assert.equal(result.funnel.bookingFailureRate, 2);
  assert.equal(result.funnel.noAvailabilityRate, 1);
  assert.equal(result.funnel.rateDefinitions.zeroDenominator, 'null');
  assert.equal(result.outcomes.noAvailability, 1);
  assert.deepEqual(result.outcomes.failuresByReason, [
    { reasonCode: 'calendar_create_failed', count: 1 },
    { reasonCode: 'no_availability', count: 1 },
  ]);
  assert.equal(result.channels.find((row) => row.channel === 'telegram')?.bookingCompleted, 1);
  assert.equal(result.channels.find((row) => row.channel === 'whatsapp')?.noAvailability, 1);
  assert.equal(result.services.find((row) => row.serviceName === 'Consultation')?.bookingCompleted, 1);
  assert.equal(result.services.find((row) => row.serviceName === 'Other')?.failures, 1);

  assert.equal(result.authoritativeBookings.completedBookingCount, 3);
  assert.equal(result.revenue.revenueKnownCount, 2);
  assert.equal(result.revenue.revenueUnknownCount, 1);
  assert.equal(result.revenue.priceCoverageRate, 2 / 3);
  assert.equal(result.revenue.coverage, 'partial');
  assert.deepEqual(result.revenue.estimatedRevenueFromKnownPrices, [
    { currency: 'EUR', amount: 50 },
    { currency: 'SEK', amount: 100 },
  ]);

  const canonicalChannels = aggregateBusinessAnalytics(loaded({
    events: [
      event('conversation_started', 'legacy-telegram', {
        channel: 'messaging', platform: 'telegram', conversation_id: 'telegram-conversation',
      }),
      event('conversation_started', 'legacy-telegram', {
        channel: 'messaging', platform: 'telegram', conversation_id: 'telegram-conversation',
      }),
      event('conversation_started', 'legacy-unattributed', {
        channel: 'messaging', platform: null, conversation_id: 'unknown-conversation',
      }),
      event('conversation_started', 'other-tenant-channel', {
        business_id: 8, channel: 'messaging', platform: 'whatsapp',
      }),
    ],
  }));
  assert.equal(canonicalChannels.channels.find((row) => row.channel === 'telegram')?.conversations, 1);
  assert.equal(canonicalChannels.channels.find((row) => row.channel === 'unattributed')?.conversations, 1);
  assert.equal(canonicalChannels.channels.some((row) => row.channel === 'messaging'), false);
  assert.equal(canonicalChannels.channels.some((row) => row.channel === 'whatsapp'), false);

  const canonicalServiceMetrics = aggregateBusinessAnalytics(loaded({
    events: [
      event('booking_completed', 'canonical-service-1', {
        booking_id: 501, service_name_snapshot: 'Konsultation',
      }),
      event('booking_completed', 'canonical-service-2', {
        booking_id: 502, service_name_snapshot: 'Video Consultation',
      }),
      event('booking_completed', 'unrelated-service', {
        booking_id: 503, service_name_snapshot: 'Benbehandling',
      }),
      event('booking_completed', 'other-tenant-service', {
        business_id: 8, booking_id: 504, service_name_snapshot: 'Konsultation',
      }),
    ],
    services: [{ name: 'Video Consultation', price: 300, currency: 'SEK' }],
  }));
  assert.equal(canonicalServiceMetrics.services.find((row) => row.serviceName === 'Video Consultation')?.bookingCompleted, 2);
  assert.equal(canonicalServiceMetrics.services.find((row) => row.serviceName === 'Benbehandling')?.bookingCompleted, 1);
  assert.equal(canonicalServiceMetrics.services.some((row) => row.serviceName === 'Konsultation'), false);
  assert.equal(canonicalServiceMetrics.services.some((row) => row.serviceName === null), false);

  const normalizedConsultationValue = aggregateBusinessAnalytics(loaded({
    appointments: [
      appointment(201, 'Konsultation'),
      appointment(202, 'Unpriced service'),
      appointment(203, 'Konsultation', { business_id: 8 }),
    ],
    services: [
      { name: 'Video Consultation', price: 300, currency: 'SEK' },
      { name: 'Unpriced service', price: null, currency: 'SEK' },
    ],
  }));
  assert.equal(normalizedConsultationValue.authoritativeBookings.completedBookingCount, 2);
  assert.equal(normalizedConsultationValue.revenue.revenueKnownCount, 1);
  assert.equal(normalizedConsultationValue.revenue.revenueUnknownCount, 1);
  assert.equal(normalizedConsultationValue.revenue.coverage, 'partial');
  assert.deepEqual(normalizedConsultationValue.revenue.estimatedRevenueFromKnownPrices, [
    { currency: 'SEK', amount: 300 },
  ]);

  const ambiguousHistoricalConsultation = aggregateBusinessAnalytics(loaded({
    appointments: [appointment(204, 'Konsultation')],
    services: [
      { name: 'Video Consultation', price: 300, currency: 'SEK' },
      { name: 'Initial Consultation', price: 500, currency: 'SEK' },
    ],
  }));
  assert.equal(ambiguousHistoricalConsultation.revenue.coverage, 'unavailable');
  assert.equal(ambiguousHistoricalConsultation.revenue.revenueKnownCount, 0);
  assert.equal(ambiguousHistoricalConsultation.revenue.revenueUnknownCount, 1);
  const ambiguousServiceMetrics = aggregateBusinessAnalytics(loaded({
    events: [event('booking_completed', 'ambiguous-service', {
      booking_id: 505, service_name_snapshot: 'Konsultation',
    })],
    services: [
      { name: 'Video Consultation', price: 300, currency: 'SEK' },
      { name: 'Initial Consultation', price: 500, currency: 'SEK' },
    ],
  }));
  assert.equal(ambiguousServiceMetrics.services[0]?.serviceName, 'Konsultation');

  const zero = aggregateBusinessAnalytics(loaded());
  assert.equal(zero.funnel.bookingConversionRate, null);
  assert.equal(zero.funnel.slotSelectionRate, null);
  assert.equal(zero.funnel.bookingFailureRate, null);
  assert.equal(zero.funnel.noAvailabilityRate, null);
  assert.equal(zero.revenue.priceCoverageRate, null);
  assert.equal(zero.revenue.coverage, 'complete');

  const unavailableRevenue = aggregateBusinessAnalytics(loaded({
    appointments: [appointment(205, 'Missing price')],
  }));
  assert.equal(unavailableRevenue.revenue.coverage, 'unavailable');
  assert.equal(unavailableRevenue.revenue.revenueUnknownCount, 1);
  assert.deepEqual(unavailableRevenue.revenue.estimatedRevenueFromKnownPrices, []);

  const partial = aggregateBusinessAnalytics(loaded({
    events: [event('customer_message_received', 'uncorrelated', { conversation_id: null })],
    eventsTruncated: true,
  }));
  assert.equal(partial.dataQuality.status, 'partial');
  assert.equal(partial.dataQuality.conversations, 'partial');

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'private-correlation-must-not-return', 'completion-1', 'idempotency_key',
    'conversation_id', 'metadata', 'customer_name', 'phone_number',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);

  const loaderSource = readFileSync(new URL('./business-loader.ts', import.meta.url), 'utf8');
  assert.match(loaderSource, /\.eq\('business_id', input\.businessId\)/);
  assert.doesNotMatch(loaderSource, /customer_name|phone_number|metadata|message_text/);
  assert.doesNotMatch(loaderSource, /\.(insert|update|upsert|delete|rpc)\s*\(/);

  const calls: Array<{ table: string; method: string; column?: string; value?: unknown; columns?: string }> = [];
  const tables: Record<string, any[]> = {
    businesses: [{ id: 7, timezone: 'Europe/Stockholm', services: [] }, { id: 8, timezone: 'UTC', services: [] }],
    analytics_events: [event('booking_started', 'tenant-7'), event('booking_started', 'tenant-8', { business_id: 8 })],
    appointments: [appointment(301, 'Consultation'), appointment(302, 'Consultation', { business_id: 8 })],
  };
  const fakeClient = {
    from(table: string) {
      let rows = [...(tables[table] || [])];
      const chain: any = {
        select(columns: string) { calls.push({ table, method: 'select', columns }); return chain; },
        eq(column: string, value: unknown) {
          calls.push({ table, method: 'eq', column, value });
          rows = rows.filter((row) => String(row[column]) === String(value));
          return chain;
        },
        in(column: string, values: readonly unknown[]) {
          const allowed = new Set(values.map(String));
          rows = rows.filter((row) => allowed.has(String(row[column])));
          return chain;
        },
        gte(column: string, value: string) {
          rows = rows.filter((row) => Date.parse(String(row[column])) >= Date.parse(value));
          return chain;
        },
        lt(column: string, value: string) {
          rows = rows.filter((row) => Date.parse(String(row[column])) < Date.parse(value));
          return chain;
        },
        order() { return chain; },
        range(from: number, to: number) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  const tenantRows = await loadBusinessAnalyticsRows({
    businessId: 7,
    window: { preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-02' },
  }, fakeClient);
  assert.equal(tenantRows.events.length, 1);
  assert.equal(tenantRows.appointments.length, 1);
  assert.ok(calls.some((call) => call.table === 'businesses' && call.method === 'eq' && call.column === 'id' && call.value === 7));
  for (const table of ['analytics_events', 'appointments']) {
    assert.ok(calls.some((call) => call.table === table && call.method === 'eq'
      && call.column === 'business_id' && call.value === 7));
  }
  assert.ok(calls.filter((call) => call.method === 'select').every((call) =>
    !/customer_name|phone_number|metadata|message_text/.test(call.columns || '')));

  console.log('Phase 2 business analytics contract tests passed.');
}

void runTests();
