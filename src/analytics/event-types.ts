export const ANALYTICS_SCHEMA_VERSION = 1 as const;

export type AnalyticsSchemaVersion = typeof ANALYTICS_SCHEMA_VERSION;
export type BigintIdentifier = number;
export type AnalyticsMetadata = Record<string, unknown>;

interface AnalyticsEventFields {
  business_id: BigintIdentifier;
  event_category: string;
  occurred_at: string;
  schema_version: AnalyticsSchemaVersion;
  source: string;
  actor: string;
  outcome: string;
  idempotency_key: string;
  conversation_id?: string | null;
  booking_id?: BigintIdentifier | null;
  customer_key?: string | null;
  platform?: string | null;
  channel?: string | null;
  service_id?: string | null;
  service_name_snapshot?: string | null;
  language?: string | null;
  reason_code?: string | null;
  numeric_value?: number | null;
  currency?: string | null;
  metadata?: AnalyticsMetadata;
}

export interface BookingCreated extends AnalyticsEventFields {
  event_name: 'booking_created';
}

export interface BookingCancelled extends AnalyticsEventFields {
  event_name: 'booking_cancelled';
}

export interface BookingRescheduled extends AnalyticsEventFields {
  event_name: 'booking_rescheduled';
}

/** Defined for future use; conversation lifecycle events remain postponed. */
export interface ConversationStarted extends AnalyticsEventFields {
  event_name: 'conversation_started';
}

/** Defined for future use; the accepted contract names completion "resolved". */
export interface ConversationCompleted extends AnalyticsEventFields {
  event_name: 'conversation_resolved';
}

export interface MessageReceived extends AnalyticsEventFields {
  event_name: 'customer_message_received';
}

export interface MessageSent extends AnalyticsEventFields {
  event_name: 'human_message_sent';
}

export type RecordableAnalyticsEvent =
  | BookingCreated
  | BookingCancelled
  | BookingRescheduled
  | MessageReceived
  | MessageSent;

export type AnalyticsEvent =
  | RecordableAnalyticsEvent
  | ConversationStarted
  | ConversationCompleted;

export type ValidatedAnalyticsEvent = RecordableAnalyticsEvent & {
  metadata: AnalyticsMetadata;
};
