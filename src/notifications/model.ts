import type { IntegrationHealth, IntegrationKey, NotificationItem } from '../types/dashboard';

export const ACTIONABLE_BOOKING_FAILURES = new Set([
  'calendar_create_failed',
  'calendar_id_mismatch',
  'calendar_time_mismatch',
  'calendar_owner_mismatch',
  'calendar_event_not_verified',
  'calendar_verification_failed',
  'calendar_unavailable',
  'database_insert_failed',
  'database_verification_failed',
  'idempotency_settlement_failed',
]);

export interface NotificationProjection {
  conditionKey: string;
  category: NotificationItem['category'];
  severity: NotificationItem['severity'];
  title: string;
  description: string;
  firstObservedAt: string;
  lastObservedAt: string;
  actionType: NotificationItem['actionType'];
  actionTarget: string;
  sourceType: 'integration_health' | 'booking_failure';
  reasonCode: string;
  resolvedAt: string | null;
}

export interface BookingAnalyticsRow {
  id: string;
  event_name: string;
  occurred_at: string;
  conversation_id?: string | null;
  reason_code?: string | null;
}

const INTEGRATION_LABELS: Record<IntegrationKey, string> = {
  instagram: 'Instagram',
  messenger: 'Facebook Messenger',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  google_calendar: 'Google Calendar',
};

export function healthConditionKey(integration: IntegrationKey) {
  return `integration:${integration}:authorization_invalid`;
}

export function projectHealthNotifications(health: IntegrationHealth[]): NotificationProjection[] {
  return health.flatMap((item) => {
    if (item.status !== 'disconnected' || item.reasonCode !== 'authorization_invalid' || !item.lastCheckedAt) return [];
    const label = INTEGRATION_LABELS[item.key];
    return [{
      conditionKey: healthConditionKey(item.key),
      category: 'integration' as const,
      severity: 'critical' as const,
      title: `${label} connection needs attention`,
      description: 'Authorization is invalid or has expired. Reconnect this integration to restore service.',
      firstObservedAt: item.lastCheckedAt,
      lastObservedAt: item.lastCheckedAt,
      actionType: 'open_health' as const,
      actionTarget: '#health',
      sourceType: 'integration_health' as const,
      reasonCode: 'authorization_invalid',
      resolvedAt: null,
    }];
  });
}

function bookingFailureCopy(reasonCode: string): Pick<NotificationProjection, 'title' | 'description'> {
  if (reasonCode.startsWith('calendar_')) {
    return {
      title: 'Booking could not be completed',
      description: 'The calendar operation failed or could not be verified. Review recent booking activity.',
    };
  }
  if (reasonCode.startsWith('database_')) {
    return {
      title: 'Booking persistence needs attention',
      description: 'The appointment could not be safely saved or verified. Review recent booking activity.',
    };
  }
  return {
    title: 'Booking settlement needs attention',
    description: 'The booking operation could not be safely settled. Review recent booking activity.',
  };
}

export function projectBookingFailureNotifications(rows: BookingAnalyticsRow[]): NotificationProjection[] {
  const completions = rows
    .filter((row) => row.event_name === 'booking_completed' && row.conversation_id)
    .map((row) => ({ conversationId: row.conversation_id!, at: Date.parse(row.occurred_at) }));

  return rows.flatMap((row) => {
    const reasonCode = String(row.reason_code || '').trim().toLowerCase();
    if (row.event_name !== 'booking_failed' || !ACTIONABLE_BOOKING_FAILURES.has(reasonCode)) return [];
    const completedAt = completions
      .filter((completion) => completion.conversationId === row.conversation_id && completion.at > Date.parse(row.occurred_at))
      .sort((a, b) => a.at - b.at)[0]?.at;
    const copy = bookingFailureCopy(reasonCode);
    return [{
      conditionKey: `booking_failure:${row.id}`,
      category: 'booking' as const,
      severity: 'attention' as const,
      ...copy,
      firstObservedAt: row.occurred_at,
      lastObservedAt: row.occurred_at,
      actionType: 'open_activity' as const,
      actionTarget: '#activity',
      sourceType: 'booking_failure' as const,
      reasonCode,
      resolvedAt: completedAt ? new Date(completedAt).toISOString() : null,
    }];
  });
}

export function resolvedHealthConditionKeys(health: IntegrationHealth[]): string[] {
  return health
    .filter((item) => item.status === 'connected' && item.reasonCode === 'verified')
    .map((item) => healthConditionKey(item.key));
}

export function groupNotificationsByRecency(items: NotificationItem[], now: Date, timezone: string) {
  const day = (value: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
  const today = day(now.toISOString());
  return [
    { key: 'today', label: 'Today', items: items.filter((item) => day(item.lastObservedAt) === today) },
    { key: 'earlier', label: 'Earlier', items: items.filter((item) => day(item.lastObservedAt) !== today) },
  ].filter((group) => group.items.length > 0);
}
