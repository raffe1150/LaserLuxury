import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsMetadata,
  type AnalyticsEventName,
  type BigintIdentifier,
  type RecordableAnalyticsEvent,
  type ValidatedAnalyticsEvent,
} from './event-types';

const APPROVED_EVENT_NAMES = new Set<AnalyticsEventName>([
  'conversation_started',
  'assistant_response_sent',
  'booking_started',
  'availability_requested',
  'slot_offered',
  'slot_selected',
  'booking_completed',
  'booking_failed',
  'booking_abandoned',
  'booking_created',
  'booking_cancelled',
  'booking_rescheduled',
  'customer_message_received',
  'human_message_sent',
  'conversation_resolved',
]);

const FORBIDDEN_METADATA_KEYS = new Set([
  'phone',
  'phone_number',
  'email',
  'name',
  'customer_name',
  'message',
  'message_text',
  'customer_message',
  'customer_message_text',
  'assistant_message',
  'assistant_message_text',
  'raw_customer_message',
  'raw_assistant_message',
  'text',
  'access_token',
  'token',
  'bot_token',
  'app_secret',
  'webhook_secret',
  'webhook_payload',
  'raw_payload',
]);

const TEXT_LIMITS = {
  event_name: 100,
  event_category: 50,
  source: 100,
  actor: 30,
  outcome: 30,
  idempotency_key: 255,
  conversation_id: 255,
  customer_key: 255,
  platform: 50,
  channel: 50,
  service_id: 255,
  service_name_snapshot: 255,
  language: 20,
  reason_code: 100,
} as const;

/** @internal */
export class AnalyticsValidationError extends Error {
  constructor() {
    super('Analytics event validation failed.');
    this.name = 'AnalyticsValidationError';
  }
}

function validationError(_field: string): never {
  throw new AnalyticsValidationError();
}

function requiredText(value: unknown, field: keyof typeof TEXT_LIMITS): string {
  if (typeof value !== 'string') validationError(field);

  const normalized = value.trim();
  if (!normalized || normalized.length > TEXT_LIMITS[field]) validationError(field);
  return normalized;
}

function optionalText(
  value: unknown,
  field: keyof typeof TEXT_LIMITS,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requiredText(value, field);
}

function bigintIdentifier(
  value: unknown,
  field: 'business_id' | 'booking_id',
): BigintIdentifier {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    validationError(field);
  }
  return value;
}

function optionalBigintIdentifier(value: unknown): BigintIdentifier | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return bigintIdentifier(value, 'booking_id');
}

function occurredAt(value: unknown): string {
  if (typeof value !== 'string') validationError('occurred_at');

  const normalized = value.trim();
  const hasTimeAndZone = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  if (!hasTimeAndZone || !Number.isFinite(Date.parse(normalized))) {
    validationError('occurred_at');
  }

  return normalized;
}

function normalizedMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isIntentionalOpaqueMetadataKey(key: string): boolean {
  return /(?:^|_)(?:id|uuid|hash|key|fingerprint|checksum)$/.test(key);
}

function isNormalAnalyticsDateOrTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/.test(value)
    || /^\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
}

function looksLikeObviousPhone(value: string, key: string): boolean {
  if (isNormalAnalyticsDateOrTime(value)) return false;
  if (!/^\+?[\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  const hasExplicitPhoneFormatting = value.startsWith('+') || /[\s().]/.test(value);
  return hasExplicitPhoneFormatting || !isIntentionalOpaqueMetadataKey(key);
}

function looksLikeObviousCredential(value: string): boolean {
  return /^Bearer\s+\S{16,}$/i.test(value)
    || /^(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|ya29\.|sb_(?:secret|publishable)_)[A-Za-z0-9._-]{12,}$/.test(value)
    || /^AKIA[0-9A-Z]{16}$/.test(value)
    || /^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(value)
    || /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(value)
    || /(?:token|secret|api[_ -]?key|password)\s*[:=]\s*\S{8,}/i.test(value);
}

function validateMetadataString(value: string, key: string): void {
  const normalized = value.trim();
  if (
    looksLikeObviousPhone(normalized, key)
    || looksLikeObviousCredential(normalized)
  ) {
    validationError('metadata_sensitive_value');
  }
}

function validateMetadataValue(
  value: unknown,
  visited: WeakSet<object>,
  containingKey = '',
): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    validateMetadataString(value, containingKey);
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) validationError('metadata');
    return;
  }

  if (typeof value !== 'object') validationError('metadata');
  if (visited.has(value)) validationError('metadata');
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) validateMetadataValue(item, visited, containingKey);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) validationError('metadata');

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = normalizedMetadataKey(key);
    if (FORBIDDEN_METADATA_KEYS.has(normalizedKey)) {
      validationError('metadata_forbidden_key');
    }
    validateMetadataValue(nestedValue, visited, normalizedKey);
  }
}

function metadataObject(value: unknown): AnalyticsMetadata {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    validationError('metadata');
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) validationError('metadata');

  validateMetadataValue(value, new WeakSet<object>());

  return value as AnalyticsMetadata;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || Math.abs(value) >= 100_000_000_000_000
    || !Number.isInteger(value * 10_000)
  ) {
    validationError('numeric_value');
  }
  return value;
}

function optionalCurrency(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') validationError('currency');

  const normalized = value.trim();
  if (!/^[A-Z]{3}$/.test(normalized)) validationError('currency');
  return normalized;
}

function optionalCustomerKey(value: unknown): string | null | undefined {
  const customerKey = optionalText(value, 'customer_key');
  if (customerKey && !/^[a-f0-9]{64}$/.test(customerKey)) {
    validationError('customer_key');
  }
  return customerKey;
}

const CHANNEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  telegram_polling: 'telegram',
  telegram_webhook: 'telegram',
  telegram: 'telegram',
  whatsapp_webhook: 'whatsapp',
  whatsapp: 'whatsapp',
  instagram_webhook: 'instagram',
  instagram: 'instagram',
  facebook_messenger: 'messenger',
  messenger_webhook: 'messenger',
  messenger: 'messenger',
  web: 'website',
  web_chat: 'website',
  website_chat: 'website',
  website: 'website',
});

/** @internal */
export function normalizeAnalyticsChannel(
  value: unknown,
  fallbackPlatform?: unknown,
): string | null | undefined {
  if (value === undefined && fallbackPlatform === undefined) return undefined;
  if (value === null && fallbackPlatform === undefined) return null;

  const candidate = String(value === null || value === undefined || value === 'messaging'
    ? fallbackPlatform ?? ''
    : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!candidate || candidate.length > TEXT_LIMITS.channel) validationError('channel');

  const normalized = CHANNEL_ALIASES[candidate] || candidate;
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) validationError('channel');
  return normalized;
}

/** @internal */
export function validateAnalyticsEvent(value: unknown): ValidatedAnalyticsEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    validationError('event');
  }

  const event = value as Record<string, unknown>;
  const eventName = requiredText(event.event_name, 'event_name');
  if (!APPROVED_EVENT_NAMES.has(eventName as AnalyticsEventName)) {
    validationError('event_name');
  }

  if (event.schema_version !== ANALYTICS_SCHEMA_VERSION) {
    validationError('schema_version');
  }

  return {
    business_id: bigintIdentifier(event.business_id, 'business_id'),
    event_name: eventName,
    event_category: requiredText(event.event_category, 'event_category'),
    occurred_at: occurredAt(event.occurred_at),
    schema_version: ANALYTICS_SCHEMA_VERSION,
    source: requiredText(event.source, 'source'),
    actor: requiredText(event.actor, 'actor'),
    outcome: requiredText(event.outcome, 'outcome'),
    idempotency_key: requiredText(event.idempotency_key, 'idempotency_key'),
    conversation_id: optionalText(event.conversation_id, 'conversation_id'),
    booking_id: optionalBigintIdentifier(event.booking_id),
    customer_key: optionalCustomerKey(event.customer_key),
    platform: optionalText(event.platform, 'platform'),
    channel: normalizeAnalyticsChannel(event.channel, event.platform),
    service_id: optionalText(event.service_id, 'service_id'),
    service_name_snapshot: optionalText(
      event.service_name_snapshot,
      'service_name_snapshot',
    ),
    language: optionalText(event.language, 'language'),
    reason_code: optionalText(event.reason_code, 'reason_code'),
    numeric_value: optionalNumber(event.numeric_value),
    currency: optionalCurrency(event.currency),
    metadata: metadataObject(event.metadata),
  } as ValidatedAnalyticsEvent;
}
