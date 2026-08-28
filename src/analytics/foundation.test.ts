import assert from 'node:assert/strict';
import type { ValidatedAnalyticsEvent } from './event-types';
import { createAnalyticsRecorder } from './analytics';
import { createAnalyticsCorrelationId } from './hash';
import { createIdempotencyKey } from './idempotency';
import { recordBookingOutcome } from './runtime-events';
import { AnalyticsValidationError, validateAnalyticsEvent } from './validators';

function event(overrides: Record<string, unknown> = {}) {
  return {
    business_id: 7,
    event_name: 'availability_requested',
    event_category: 'booking',
    occurred_at: '2026-08-23T10:00:00.000Z',
    schema_version: 1,
    source: 'test_runtime',
    actor: 'system',
    outcome: 'requested',
    idempotency_key: 'test-key',
    platform: 'telegram-webhook',
    channel: 'messaging',
    metadata: {},
    ...overrides,
  } as any;
}

async function runTests(): Promise<void> {
  const canonical = validateAnalyticsEvent(event());
  assert.equal(canonical.schema_version, 1);
  assert.equal(canonical.channel, 'telegram');

  assert.throws(
    () => validateAnalyticsEvent(event({ schema_version: 2 })),
    AnalyticsValidationError,
  );
  assert.throws(
    () => validateAnalyticsEvent(event({ business_id: 0 })),
    AnalyticsValidationError,
  );
  assert.equal(
    validateAnalyticsEvent(event({ platform: 'web-chat', channel: undefined })).channel,
    'website',
  );
  assert.equal(
    validateAnalyticsEvent(event({ platform: 'future-provider', channel: 'future-channel' })).channel,
    'future_channel',
  );

  const withReferences = validateAnalyticsEvent(event({
    service_id: 'service-42',
    service_name_snapshot: 'Consultation',
    booking_id: 91,
  }));
  assert.equal(withReferences.service_id, 'service-42');
  assert.equal(withReferences.booking_id, 91);
  assert.equal(validateAnalyticsEvent(event()).booking_id, undefined);

  for (const metadata of [
    { message: 'raw customer text' },
    { nested: { assistantMessageText: 'raw assistant text' } },
    { payload: { phoneNumber: '+46700000000' } },
    { accessToken: 'secret' },
  ]) {
    assert.throws(
      () => validateAnalyticsEvent(event({ metadata })),
      AnalyticsValidationError,
    );
  }

  for (const metadata of [
    { diagnostic: '+46 70 123 45 67' },
    { diagnostic: '0701234567' },
    { external_id: '+46 70 123 45 67' },
    { diagnostic: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-value' },
    { diagnostic: 'sk-proj-1234567890abcdefghijklmnop' },
    { diagnostic: 'api_key=obvious-secret-value' },
  ]) {
    assert.throws(
      () => validateAnalyticsEvent(event({ metadata })),
      AnalyticsValidationError,
    );
  }

  const normalMetadata = {
    message_type: 'voice',
    service: 'Consultation',
    channel: 'telegram',
    constraint_kind: 'exact_time',
    requested_start_date: '2026-08-23',
    requested_end_date: '2026-08-24',
    selected_time: '14:30',
    new_start_time: '2026-08-23T14:30:00.000Z',
    reason_code: 'no_availability',
    slot_count: 3,
    operation_id: '1234567890',
    request_hash: 'a'.repeat(64),
  };
  assert.deepEqual(
    validateAnalyticsEvent(event({ metadata: normalMetadata })).metadata,
    normalMetadata,
  );

  const retryKey = createIdempotencyKey({
    businessId: 7,
    eventName: 'slot_selected',
    source: 'test_runtime',
    sourceEventId: 'provider-message-1:slot-1',
  });
  assert.equal(retryKey, createIdempotencyKey({
    businessId: 7,
    eventName: 'slot_selected',
    source: 'test_runtime',
    sourceEventId: 'provider-message-1:slot-1',
  }));
  assert.notEqual(retryKey, createIdempotencyKey({
    businessId: 8,
    eventName: 'slot_selected',
    source: 'test_runtime',
    sourceEventId: 'provider-message-1:slot-1',
  }));

  const previousSecret = process.env.ANALYTICS_HASH_SECRET;
  process.env.ANALYTICS_HASH_SECRET = '0123456789abcdef0123456789abcdef';
  const tenantSevenCorrelation = createAnalyticsCorrelationId({ businessId: 7, identifier: 'raw-session' });
  const tenantEightCorrelation = createAnalyticsCorrelationId({ businessId: 8, identifier: 'raw-session' });
  assert.match(tenantSevenCorrelation || '', /^[a-f0-9]{64}$/);
  assert.notEqual(tenantSevenCorrelation, tenantEightCorrelation);
  assert.notEqual(tenantSevenCorrelation, 'raw-session');
  if (previousSecret === undefined) delete process.env.ANALYTICS_HASH_SECRET;
  else process.env.ANALYTICS_HASH_SECRET = previousSecret;

  const persistenceErrors: Record<string, unknown>[] = [];
  const failingRecorder = createAnalyticsRecorder({
    persist: async () => { throw new Error('database unavailable'); },
    timeoutMs: 10,
    reportError: (_message, context) => persistenceErrors.push(context),
  });
  const operationalResult = Object.freeze({ ok: true, bookingId: 91 });
  async function operationalBooking() {
    await recordBookingOutcome({
      businessId: 7,
      channel: 'telegram',
      source: 'test_runtime',
      sourceEventId: 91,
      bookingId: 91,
      serviceName: 'Consultation',
      succeeded: true,
    }, failingRecorder);
    return operationalResult;
  }
  assert.equal(await operationalBooking(), operationalResult);
  assert.equal(persistenceErrors.length, 1);

  assert.doesNotThrow(() => {
    void recordBookingOutcome({
      businessId: 7,
      channel: 'telegram',
      source: 'test_runtime',
      sourceEventId: '',
      succeeded: false,
      reasonCode: 'malformed_optional_context',
    }, failingRecorder);
  });

  const timeoutErrors: Record<string, unknown>[] = [];
  const timeoutRecorder = createAnalyticsRecorder({
    persist: () => new Promise<void>(() => undefined),
    timeoutMs: 5,
    reportError: (_message, context) => timeoutErrors.push(context),
  });
  await timeoutRecorder.record(event());
  assert.equal(timeoutErrors[0]?.reason, 'database_error');
  assert.equal(timeoutErrors[0]?.error_code, 'timeout');

  const outcomes: ValidatedAnalyticsEvent[] = [];
  const captureRecorder = createAnalyticsRecorder({
    persist: async (value) => { outcomes.push(value); },
    reportError: () => assert.fail('valid outcome event should persist'),
  });
  await recordBookingOutcome({
    businessId: 7,
    channel: 'whatsapp',
    source: 'test_runtime',
    sourceEventId: 'failure-1',
    serviceName: 'Consultation',
    succeeded: false,
    reasonCode: 'no_availability',
  }, captureRecorder);
  assert.deepEqual(outcomes.map((value) => value.event_name), ['booking_failed']);
  assert.equal(outcomes[0].reason_code, 'no_availability');
  assert.equal(outcomes.some((value) => value.event_name === 'booking_completed'), false);

  outcomes.length = 0;
  await recordBookingOutcome({
    businessId: 7,
    channel: 'whatsapp',
    source: 'test_runtime',
    sourceEventId: 92,
    bookingId: 92,
    serviceName: 'Consultation',
    succeeded: true,
  }, captureRecorder);
  assert.deepEqual(outcomes.map((value) => value.event_name), ['booking_completed']);
  assert.equal(outcomes[0].outcome, 'success');

  console.log('Analytics foundation tests passed.');
}

void runTests();
