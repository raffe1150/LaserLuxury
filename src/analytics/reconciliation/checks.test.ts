import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAnalyticsReconciliationReport } from './checks';
import { runAnalyticsReconciliation } from './index';
import { AnalyticsReconciliationError, loadReconciliationRows } from './queries';
import type { ReconciliationAnalyticsEventRow, ReconciliationAppointmentRow, ReconciliationCheckInput } from './types';

const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-01T12:00:00.000Z';

function event(overrides: Partial<ReconciliationAnalyticsEventRow> = {}): ReconciliationAnalyticsEventRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    business_id: 1,
    event_name: 'booking_created',
    event_category: 'booking',
    occurred_at: '2020-08-01T10:00:00.000Z',
    recorded_at: '2020-08-01T10:00:01.000Z',
    conversation_id: null,
    booking_id: 10,
    customer_key: null,
    platform: 'telegram',
    channel: 'telegram',
    service_id: null,
    service_name_snapshot: 'Consultation',
    language: 'en',
    source: 'unified_booking_engine',
    actor: 'ai',
    outcome: 'success',
    reason_code: null,
    currency: null,
    metadata: {},
    schema_version: 1,
    idempotency_key: 'booking-created:v1:10',
    ...overrides,
  };
}

function appointment(overrides: Partial<ReconciliationAppointmentRow> = {}): ReconciliationAppointmentRow {
  return {
    id: 10, business_id: 1, service: 'Consultation', platform: 'telegram',
    status: 'booked', created_at: '2026-08-01T10:00:00.000Z',
    start_time: '2026-08-02T10:00:00.000Z', ...overrides,
  };
}

function report(input: Partial<ReconciliationCheckInput> = {}) {
  const events = input.events || [];
  const appointments = input.appointments || [];
  return buildAnalyticsReconciliationReport({
    events,
    appointments,
    scope: input.scope || {
      businessId: 1,
      from: FROM,
      to: TO,
      boundarySource: 'caller',
    },
    scanTruncated: input.scanTruncated || false,
    issueSampleLimit: input.issueSampleLimit || 200,
    thresholds: input.thresholds || {
      futureToleranceMs: 300_000, suspiciousFutureMs: 86_400_000,
      delayedWarningMs: 300_000, delayedErrorMs: 86_400_000,
      metadataSizeWarningBytes: 8_192,
    },
  });
}

function hasCode(result: ReturnType<typeof report>, code: string): boolean {
  return Boolean(result.issueCounts[code]);
}

async function runTests(): Promise<void> {
{
  const querySource = readFileSync(new URL('./queries.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(querySource, /\.(insert|update|upsert|delete|rpc)\s*\(/);
  const runtimeSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(runtimeSource, /analytics\/reconciliation|runAnalyticsReconciliation/);
}

{
  const result = report({ events: [event()], appointments: [appointment()] });
  assert.equal(result.summary.issueCount, 0);
  assert.equal(result.volume[0]?.count, 1);
  assert.equal(result.coverage.bookingCreated, 'deferred_missing_appointment_index');
}

{
  const exact = event({ id: '00000000-0000-4000-8000-000000000002' });
  const cancelled = (id: string, key: string) => event({
    id, event_name: 'booking_cancelled', source: 'unified_cancellation_engine', idempotency_key: key,
  });
  const rescheduled = (id: string, key: string) => event({
    id, event_name: 'booking_rescheduled', source: 'unified_reschedule_engine',
    idempotency_key: key, metadata: { new_start_time: '2026-08-02T10:00:00.000Z' },
  });
  const result = report({
    events: [
      event(), exact,
      cancelled('00000000-0000-4000-8000-000000000003', 'cancel:1'),
      cancelled('00000000-0000-4000-8000-000000000004', 'cancel:2'),
      rescheduled('00000000-0000-4000-8000-000000000005', 'move:1'),
      rescheduled('00000000-0000-4000-8000-000000000006', 'move:2'),
    ],
    appointments: [appointment()],
  });
  for (const code of [
    'EXACT_IDEMPOTENCY_DUPLICATE',
    'DUPLICATE_BOOKING_CREATED',
    'DUPLICATE_BOOKING_CANCELLED',
    'DUPLICATE_BOOKING_RESCHEDULED',
  ]) assert.ok(hasCode(result, code), code);
}

{
  const mismatch = report({ events: [event({ business_id: 2 })], appointments: [appointment()] });
  assert.ok(hasCode(mismatch, 'BOOKING_BUSINESS_MISMATCH'));
  assert.equal(mismatch.summary.criticalCount > 0, true);

  const orphan = report({ events: [event()], appointments: [] });
  assert.ok(hasCode(orphan, 'COMPLETION_WITHOUT_AUTHORITATIVE_APPOINTMENT'));
}

{
  const move = (id: string, occurredAt: string, newStart: string) => event({
    id, event_name: 'booking_rescheduled', source: 'unified_reschedule_engine',
    occurred_at: occurredAt, recorded_at: occurredAt, idempotency_key: `move:${id}`,
    metadata: { new_start_time: newStart },
  });
  const result = report({
    events: [
      move('00000000-0000-4000-8000-000000000007', '2026-08-01T09:00:00.000Z', '2026-08-02T09:00:00.000Z'),
      move('00000000-0000-4000-8000-000000000008', '2026-08-01T11:00:00.000Z', '2026-08-02T10:00:00.000Z'),
    ],
    appointments: [appointment()],
  });
  assert.equal(hasCode(result, 'LATEST_RESCHEDULE_START_MISMATCH'), false);
}

{
  const message = {
    event_name: 'customer_message_received', event_category: 'conversation', booking_id: null,
    source: 'telegram_provider_update', actor: 'customer', outcome: 'received',
    channel: 'telegram', idempotency_key: 'message:1',
  } satisfies Partial<ReconciliationAnalyticsEventRow>;
  const cases: Array<[string, Partial<ReconciliationAnalyticsEventRow>]> = [
    ['UNSUPPORTED_SCHEMA_VERSION', { schema_version: 2 }],
    ['EVENT_CATEGORY_DRIFT', { event_category: 'wrong' }],
    ['ACTOR_DRIFT', { actor: 'ai' }],
    ['OUTCOME_DRIFT', { outcome: 'wrong' }],
    ['SOURCE_DRIFT', { source: 'wrong' }],
    ['NON_CANONICAL_PLATFORM', { platform: 'facebook' }],
    ['MESSAGE_PLATFORM_INVALID', { platform: '   ' }],
    ['MESSAGE_CHANNEL_INVALID', { channel: '   ' }],
    ['UNSUPPORTED_EVENT_NAME', { event_name: 'unknown_event' }],
  ];
  for (const [code, overrides] of cases) {
    const result = report({ events: [event({ ...message, ...overrides })] });
    assert.ok(hasCode(result, code), code);
  }
}

{
  const secret = 'must-not-appear@example.invalid';
  const forbidden = report({ events: [event({ metadata: { email: secret } })] });
  assert.ok(hasCode(forbidden, 'FORBIDDEN_METADATA_KEY'));
  assert.equal(hasCode(forbidden, 'PROBABLE_PII_IN_METADATA'), false);
  assert.equal(JSON.stringify(forbidden).includes(secret), false);

  const probable = report({ events: [event({ metadata: { opaque_hint: secret } })] });
  assert.ok(hasCode(probable, 'PROBABLE_PII_IN_METADATA'));
  assert.equal(JSON.stringify(probable).includes(secret), false);
}

{
  const future = report({ events: [event({ occurred_at: '2099-08-03T12:00:00.000Z' })] });
  assert.ok(hasCode(future, 'TIMESTAMP_FAR_FUTURE'));
  const delayed = report({ events: [event({
    occurred_at: '2026-07-30T10:00:00.000Z', recorded_at: '2026-08-01T11:00:00.000Z',
  })] });
  assert.ok(hasCode(delayed, 'RECORDING_EXTREMELY_DELAYED'));
}

type FakeCall = { table: string; method: string; column?: string; value?: unknown };

function fakeClient(input: {
  events?: ReconciliationAnalyticsEventRow[]; appointments?: ReconciliationAppointmentRow[]; fail?: boolean;
}): { client: SupabaseClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const tables: Record<string, unknown[]> = {
    analytics_events: input.events || [],
    appointments: input.appointments || [],
  };
  const client = {
    from(table: string) {
      let rows = [...(tables[table] || [])];
      const chain: any = {
        select() { calls.push({ table, method: 'select' }); return chain; },
        eq(column: string, value: unknown) {
          calls.push({ table, method: 'eq', column, value });
          rows = rows.filter((row: any) => String(row[column]) === String(value));
          return chain;
        },
        gte() { return chain; },
        lte() { return chain; },
        lt() { return chain; },
        order() { return chain; },
        in(column: string, values: unknown[]) {
          calls.push({ table, method: 'in', column });
          const allowed = new Set(values.map(String));
          rows = rows.filter((row: any) => allowed.has(String(row[column])));
          return chain;
        },
        limit(length: number) {
          return Promise.resolve(input.fail
            ? { data: null, error: { code: 'secret_test_error' } }
            : { data: rows.slice(0, length), error: null });
        },
        range(from: number, to: number) {
          calls.push({ table, method: 'range', value: [from, to] });
          return Promise.resolve(input.fail
            ? { data: null, error: { code: 'secret_test_error' } }
            : { data: rows.slice(from, to + 1), error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

{
  const completed = (id: string, bookingId = 10) => event({
    id,
    event_name: 'booking_completed',
    actor: 'system',
    booking_id: bookingId,
    idempotency_key: `completed:${id}`,
  });
  const duplicate = report({
    events: [
      completed('00000000-0000-4000-8000-000000000101'),
      completed('00000000-0000-4000-8000-000000000102'),
    ],
    appointments: [appointment()],
  });
  assert.ok(hasCode(duplicate, 'DUPLICATE_BOOKING_COMPLETION'));

  const missing = report({ appointments: [appointment()] });
  assert.ok(hasCode(missing, 'AUTHORITATIVE_APPOINTMENT_MISSING_COMPLETION'));

  const mismatch = report({
    events: [completed('00000000-0000-4000-8000-000000000103')],
    appointments: [appointment({ service: 'Other', platform: 'whatsapp' })],
  });
  assert.ok(hasCode(mismatch, 'COMPLETION_SERVICE_MISMATCH'));
  assert.ok(hasCode(mismatch, 'COMPLETION_CHANNEL_MISMATCH'));
}

{
  const funnel = (name: string, occurredAt: string, id: number) => event({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    event_name: name,
    booking_id: name === 'booking_completed' ? 10 : null,
    actor: 'system',
    outcome: name === 'booking_started' ? 'started'
      : name === 'availability_requested' ? 'requested'
        : name === 'slot_offered' ? 'available'
          : name === 'slot_selected' ? 'selected'
            : 'success',
    conversation_id: 'correlated-conversation',
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    idempotency_key: `funnel:${id}`,
  });
  const impossible = report({
    events: [
      funnel('booking_started', '2026-08-01T10:00:00.000Z', 201),
      funnel('slot_offered', '2026-08-01T09:00:00.000Z', 202),
    ],
  });
  assert.ok(hasCode(impossible, 'IMPOSSIBLE_FUNNEL_ORDER'));
}

{
  const previousBoundary = process.env.ANALYTICS_RECONCILIATION_FROM;
  delete process.env.ANALYTICS_RECONCILIATION_FROM;
  await assert.rejects(
    runAnalyticsReconciliation({ businessId: 0, from: FROM }),
    (error: unknown) => error instanceof AnalyticsReconciliationError
      && error.code === 'business_id_required',
  );
  await assert.rejects(
    runAnalyticsReconciliation({ businessId: 1 }),
    (error: unknown) => error instanceof AnalyticsReconciliationError
      && error.code === 'boundary_required',
  );
  if (previousBoundary === undefined) delete process.env.ANALYTICS_RECONCILIATION_FROM;
  else process.env.ANALYTICS_RECONCILIATION_FROM = previousBoundary;
}

{
  const messages = Array.from({ length: 5 }, (_, index) => event({
    id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
    event_name: 'customer_message_received',
    event_category: 'conversation',
    booking_id: null,
    source: 'telegram_webhook',
    actor: 'customer',
    outcome: 'received',
    idempotency_key: `message:${index}`,
  }));
  const fake = fakeClient({ events: messages });
  const loaded = await loadReconciliationRows({
    businessId: 1,
    from: FROM,
    to: TO,
    pageSize: 2,
    maxRows: 3,
  }, fake.client);
  assert.equal(loaded.events.length, 3);
  assert.equal(loaded.scanTruncated, true);
  assert.equal(fake.calls.filter((call) => call.method === 'range').length, 3);
  assert.equal(fake.calls.filter((call) => call.method === 'eq' && call.column === 'business_id').length, 3);
}

{
  const failing = fakeClient({ fail: true });
  await assert.rejects(
    loadReconciliationRows({ businessId: 1, from: FROM, to: TO }, failing.client),
    (error: unknown) => error instanceof AnalyticsReconciliationError
      && error.code === 'query_failed'
      && !error.message.includes('secret_test_error'),
  );
}

{
  const empty = report();
  assert.equal(empty.summary.issueCount, 0);
  assert.deepEqual(empty.volume, []);
  const partial = report({ scanTruncated: true, appointments: [appointment()] });
  assert.ok(hasCode(partial, 'SCAN_LIMIT_REACHED'));
  assert.ok(hasCode(partial, 'APPOINTMENT_COMPLETION_UNVERIFIED_PARTIAL_SCAN'));
  assert.equal(hasCode(partial, 'AUTHORITATIVE_APPOINTMENT_MISSING_COMPLETION'), false);
  assert.equal(partial.coverage.exactIdempotencyDuplicates, 'partial_scan');
}

console.log('Analytics reconciliation checks passed.');
}

void runTests();
