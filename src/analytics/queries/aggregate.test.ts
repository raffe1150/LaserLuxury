import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { aggregateAnalyticsMetrics } from './aggregate';
import { getAnalyticsMetrics } from './index';
import { loadAnalyticsMetricRows } from './loader';
import type {
  AnalyticsMetricEventRow,
  AnalyticsMetricsOptions,
  LoadedAnalyticsMetricRows,
} from './types';
import {
  AnalyticsMetricsError,
  validateAnalyticsMetricsOptions,
} from './validation';

const OPTIONS: AnalyticsMetricsOptions = {
  businessId: 7,
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-04T00:00:00.000Z',
};

function event(
  eventName: string,
  overrides: Partial<AnalyticsMetricEventRow> = {},
): AnalyticsMetricEventRow {
  return {
    event_name: eventName,
    occurred_at: '2026-01-01T12:00:00.000Z',
    platform: 'telegram',
    service_name_snapshot: null,
    ...overrides,
  };
}

function aggregate(
  events: AnalyticsMetricEventRow[],
  overrides: Partial<AnalyticsMetricsOptions> = {},
  truncated = false,
) {
  const options = validateAnalyticsMetricsOptions({ ...OPTIONS, ...overrides });
  return aggregateAnalyticsMetrics({ options, events, truncated });
}

type QueryTrace = {
  table: string;
  columns?: string;
  selectOptions?: unknown;
  businessId?: unknown;
  from?: unknown;
  to?: unknown;
  range?: [number, number];
};

function fakeClient(rows: AnalyticsMetricEventRow[], fail = false): {
  client: SupabaseClient;
  queries: QueryTrace[];
} {
  const queries: QueryTrace[] = [];
  const client = {
    from(table: string) {
      let filtered = [...rows];
      const trace: QueryTrace = { table };
      queries.push(trace);
      const chain: any = {
        select(columns: string, options?: unknown) {
          trace.columns = columns;
          trace.selectOptions = options;
          return chain;
        },
        eq(column: string, value: unknown) {
          if (column === 'business_id') trace.businessId = value;
          return chain;
        },
        in(column: string, values: readonly unknown[]) {
          if (column === 'event_name') {
            const allowed = new Set(values);
            filtered = filtered.filter((row) => allowed.has(row.event_name));
          }
          return chain;
        },
        gte(column: string, value: unknown) {
          if (column === 'occurred_at') {
            trace.from = value;
            filtered = filtered.filter((row) => Date.parse(String(row.occurred_at)) >= Date.parse(String(value)));
          }
          return chain;
        },
        lt(column: string, value: unknown) {
          if (column === 'occurred_at') {
            trace.to = value;
            filtered = filtered.filter((row) => Date.parse(String(row.occurred_at)) < Date.parse(String(value)));
          }
          return chain;
        },
        order() { return chain; },
        range(from: number, to: number) {
          trace.range = [from, to];
          return Promise.resolve(fail
            ? { data: null, error: { message: 'sensitive database detail' } }
            : { data: filtered.slice(from, to + 1), error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

async function runTests(): Promise<void> {
  const invalidCases: Array<[Partial<AnalyticsMetricsOptions> | null, string]> = [
    [null, 'business_id_required'],
    [{ businessId: 0 }, 'business_id_required'],
    [{ businessId: 1, from: '', to: OPTIONS.to }, 'invalid_time_range'],
    [{ businessId: 1, from: OPTIONS.from }, 'invalid_time_range'],
    [{ businessId: 1, from: '2026-01-01T00:00:00', to: OPTIONS.to }, 'invalid_time_range'],
    [{ businessId: 1, from: OPTIONS.to, to: OPTIONS.from }, 'invalid_time_range'],
    [{ businessId: 1, from: OPTIONS.from, to: '2027-01-03T00:00:00Z' }, 'time_range_too_large'],
    [{ ...OPTIONS, pageSize: 1_001 }, 'invalid_query_limit'],
    [{ ...OPTIONS, maxEvents: 50_001 }, 'invalid_query_limit'],
    [{ ...OPTIONS, maxServices: 101 }, 'invalid_query_limit'],
  ];
  for (const [options, code] of invalidCases) {
    await assert.rejects(
      getAnalyticsMetrics(options as AnalyticsMetricsOptions),
      (error: unknown) => error instanceof AnalyticsMetricsError && error.code === code,
      code,
    );
  }
  assert.equal(validateAnalyticsMetricsOptions({
    ...OPTIONS, pageSize: 1_000, maxEvents: 50_000, maxServices: 100,
  }).maxEvents, 50_000);

  const empty = aggregate([]);
  assert.deepEqual(empty.summary, {
    messagesReceived: 0,
    bookingsCreated: 0,
    bookingsRescheduled: 0,
    bookingsCancelled: 0,
    netBookingActivity: 0,
    bookingMessageRatio: null,
  });
  assert.equal(empty.daily.length, 3);
  assert.ok(empty.daily.every((day) => day.messagesReceived === 0));
  assert.equal(empty.platforms.length, 4);

  const complete = aggregate([
    event('customer_message_received'),
    event('booking_completed', { service_name_snapshot: 'Consultation' }),
    event('booking_rescheduled', { service_name_snapshot: 'Consultation' }),
    event('booking_rescheduled', { service_name_snapshot: 'Consultation' }),
    event('booking_cancelled'),
  ]);
  assert.deepEqual(complete.summary, {
    messagesReceived: 1,
    bookingsCreated: 1,
    bookingsRescheduled: 2,
    bookingsCancelled: 1,
    netBookingActivity: 0,
    bookingMessageRatio: 1,
  });
  assert.deepEqual(complete.services.rows[0], {
    serviceName: 'Consultation',
    bookingsCreated: 1,
    bookingsRescheduled: 2,
    bookingsCancelled: 0,
  });
  assert.equal(complete.services.unattributed.bookingsCancelled, 1);
  assert.equal(complete.platforms[0].bookingsRescheduled, 2);

  const canonicalPlatforms = ['telegram', 'whatsapp', 'messenger', 'instagram'] as const;
  const platformReport = aggregate(canonicalPlatforms.flatMap((platform) => [
    event('customer_message_received', { platform }),
    event('booking_created', { platform }),
  ]));
  for (const platform of platformReport.platforms) {
    assert.equal(platform.messagesReceived, 1);
    assert.equal(platform.bookingsCreated, 1);
    assert.equal(platform.bookingMessageRatio, 1);
  }

  const ratio = aggregate([
    event('customer_message_received'),
    event('customer_message_received'),
    event('booking_created'),
    event('booking_created', { platform: 'unexpected' }),
  ]);
  assert.equal(ratio.summary.bookingMessageRatio, 1);
  assert.equal(ratio.platforms.find((row) => row.platform === 'telegram')?.bookingMessageRatio, 0.5);
  assert.equal(ratio.platforms.some((row) => String(row.platform) === 'unexpected'), false);

  const services = aggregate([
    event('booking_created', { service_name_snapshot: 'Beta' }),
    event('booking_created', { service_name_snapshot: 'Alpha' }),
    event('booking_cancelled', { service_name_snapshot: 'Alpha' }),
    event('booking_created', { service_name_snapshot: '  ' }),
  ], { maxServices: 1 });
  assert.equal(services.services.rows[0].serviceName, 'Alpha');
  assert.equal(services.services.truncated, true);
  assert.equal(services.services.unattributed.bookingsCreated, 1);

  const daily = aggregate([
    event('customer_message_received', { occurred_at: '2026-01-01T23:30:00-02:00' }),
    event('booking_created', { occurred_at: '2026-01-03T10:00:00Z' }),
  ]);
  assert.equal(daily.daily[0].messagesReceived, 0);
  assert.equal(daily.daily[1].messagesReceived, 1);
  assert.equal(daily.daily[2].bookingsCreated, 1);

  const pagedRows = Array.from({ length: 5 }, (_, index) => event(
    index % 2 === 0 ? 'customer_message_received' : 'booking_created',
  ));
  const fake = fakeClient(pagedRows);
  const loaded = await loadAnalyticsMetricRows({
    ...OPTIONS, pageSize: 2, maxEvents: 3,
  }, fake.client);
  assert.equal(loaded.events.length, 3);
  assert.equal(loaded.truncated, true);
  assert.equal(fake.queries.length, 2);
  assert.deepEqual(fake.queries.map((query) => query.range), [[0, 1], [2, 3]]);
  for (const query of fake.queries) {
    assert.equal(query.table, 'analytics_events');
    assert.equal(query.businessId, OPTIONS.businessId);
    assert.equal(query.from, OPTIONS.from);
    assert.equal(query.to, OPTIONS.to);
    assert.equal(query.columns, 'event_name,occurred_at,platform,service_name_snapshot');
    assert.equal(query.selectOptions, undefined);
  }
  const partial = aggregateAnalyticsMetrics(loaded as LoadedAnalyticsMetricRows);
  assert.equal(partial.completeness.truncated, true);
  assert.equal(partial.completeness.checkedEvents, 3);

  const failure = fakeClient([], true);
  await assert.rejects(
    loadAnalyticsMetricRows(OPTIONS, failure.client),
    (error: unknown) => error instanceof AnalyticsMetricsError
      && error.code === 'analytics_query_failed'
      && !error.message.includes('sensitive database detail'),
  );

  const loaderSource = readFileSync(new URL('./loader.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(loaderSource, /customer_key|conversation_id|idempotency_key|metadata/);
  assert.doesNotMatch(loaderSource, /count\s*:\s*['"]exact|\.(insert|update|upsert|delete|rpc)\s*\(/);
  assert.doesNotMatch(loaderSource, /\.from\(['"](appointments|chat_history|businesses)['"]\)/);
  const runtimeSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runtimeSource, /analytics\/queries|getAnalyticsMetrics/);

  console.log('Analytics metrics query tests passed.');
}

void runTests();
