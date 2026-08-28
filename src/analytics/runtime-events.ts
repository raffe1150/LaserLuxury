import { analytics, type AnalyticsRecorder } from './analytics';
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsMetadata, type AnalyticsEventName } from './event-types';
import { createAnalyticsCorrelationId, sha256 } from './hash';
import { createIdempotencyKey } from './idempotency';

export type RuntimeAnalyticsContext = {
  businessId: number;
  channel: string;
  source: string;
  sourceEventId: string | number;
  sessionId?: string;
  occurredAt?: string;
  serviceId?: string | null;
  serviceName?: string | null;
  bookingId?: number | null;
  language?: string | null;
  metadata?: AnalyticsMetadata;
};

export type InboundMessageAnalyticsIdentity = Readonly<{
  source: string;
  sourceEventId: string;
}>;

function encodeIdentityParts(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

/**
 * Telegram delivery transport is deliberately excluded from its logical event
 * identity. The bot fingerprint retains account scope while update ID retains
 * provider-message scope. Other channels keep their existing source behavior.
 */
export function createInboundMessageAnalyticsIdentity(input: {
  channel: string;
  transportSource: string;
  providerMessageId: string | number;
  providerScope?: string;
}): InboundMessageAnalyticsIdentity | null {
  try {
    const channel = String(input.channel || '').trim().toLowerCase();
    const transportSource = String(input.transportSource || '').trim();
    const providerMessageId = String(input.providerMessageId ?? '').trim();
    if (!channel || !transportSource || !providerMessageId) return null;

    if (channel !== 'telegram') {
      return {
        source: transportSource,
        sourceEventId: sha256(providerMessageId),
      };
    }

    const providerScope = String(input.providerScope || '').trim();
    if (!providerScope) return null;
    return {
      source: 'telegram_provider_update',
      sourceEventId: sha256(encodeIdentityParts([
        'telegram',
        providerScope,
        providerMessageId,
      ])),
    };
  } catch {
    return null;
  }
}

/**
 * Narrow runtime adapter: operational code supplies deterministic facts while
 * the analytics package owns correlation, idempotency and fail-open recording.
 */
export function recordRuntimeAnalyticsEvent(
  eventName: AnalyticsEventName,
  category: 'conversation' | 'booking' | 'channel' | 'service',
  outcome: string,
  context: RuntimeAnalyticsContext & { reasonCode?: string | null },
  recorder: AnalyticsRecorder = analytics,
): Promise<void> {
  try {
    const conversationId = context.sessionId
      ? createAnalyticsCorrelationId({
          businessId: context.businessId,
          identifier: context.sessionId,
        })
      : null;

    return recorder.record({
      business_id: context.businessId,
      event_name: eventName,
      event_category: category,
      occurred_at: context.occurredAt || new Date().toISOString(),
      schema_version: ANALYTICS_SCHEMA_VERSION,
      source: context.source,
      actor: category === 'conversation' && eventName === 'customer_message_received'
        ? 'customer'
        : 'system',
      outcome,
      idempotency_key: createIdempotencyKey({
        businessId: context.businessId,
        eventName,
        source: context.source,
        sourceEventId: context.sourceEventId,
      }),
      platform: context.channel,
      channel: context.channel,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(context.bookingId ? { booking_id: context.bookingId } : {}),
      ...(context.serviceId ? { service_id: context.serviceId } : {}),
      ...(context.serviceName ? { service_name_snapshot: context.serviceName } : {}),
      ...(context.language ? { language: context.language } : {}),
      ...(context.reasonCode ? { reason_code: context.reasonCode } : {}),
      metadata: context.metadata || {},
    });
  } catch {
    // Event construction/idempotency failures are analytics failures too.
    return Promise.resolve();
  }
}

export function recordBookingOutcome(
  context: RuntimeAnalyticsContext & {
    succeeded: boolean;
    reasonCode?: string | null;
  },
  recorder: AnalyticsRecorder = analytics,
): Promise<void> {
  return recordRuntimeAnalyticsEvent(
    context.succeeded ? 'booking_completed' : 'booking_failed',
    'booking',
    context.succeeded ? 'success' : 'failure',
    context,
    recorder,
  );
}
