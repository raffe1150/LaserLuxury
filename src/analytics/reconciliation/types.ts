export type AnalyticsReconciliationOptions = {
  businessId: number;
  from?: string;
  to?: string;
  pageSize?: number;
  maxRows?: number;
  issueSampleLimit?: number;
  futureToleranceMs?: number;
  suspiciousFutureMs?: number;
  delayedWarningMs?: number;
  delayedErrorMs?: number;
  metadataSizeWarningBytes?: number;
};

export type AnalyticsReconciliationReport = {
  generatedAt: string;
  scope: {
    businessId: number;
    from: string;
    to: string;
    boundarySource: 'caller' | 'environment';
  };
  summary: {
    checkedEvents: number;
    checkedAppointments: number;
    scanTruncated: boolean;
    issueCount: number;
    sampledIssueCount: number;
    criticalCount: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    issuesTruncated: boolean;
  };
  issueCounts: Record<string, number>;
  issues: ReconciliationIssue[];
  volume: ReconciliationVolumeBucket[];
  coverage: {
    exactIdempotencyDuplicates: 'checked' | 'partial_scan';
    bookingCreated: 'deferred_missing_appointment_index';
    bookingCancelled: 'not_deterministically_reconcilable';
    bookingRescheduled: 'latest_event_only';
    customerMessageReceived: 'internal_quality_only';
  };
};

export type ReconciliationIssue = {
  code: string;
  severity: ReconciliationSeverity;
  eventName?: string;
  businessId?: number;
  bookingId?: number;
  eventId?: string;
  occurredAt?: string;
  safeContext?: Record<string, string | number | boolean | null>;
};

export type ReconciliationSeverity = 'info' | 'warning' | 'error' | 'critical';

export type ReconciliationVolumeBucket = {
  businessId: number;
  eventName: string;
  platform: string | null;
  utcDate: string;
  count: number;
};

export type ReconciliationAnalyticsEventRow = {
  id: unknown;
  business_id: unknown;
  event_name: unknown;
  event_category: unknown;
  occurred_at: unknown;
  recorded_at: unknown;
  conversation_id: unknown;
  booking_id: unknown;
  customer_key: unknown;
  platform: unknown;
  channel: unknown;
  service_id: unknown;
  service_name_snapshot: unknown;
  language: unknown;
  source: unknown;
  actor: unknown;
  outcome: unknown;
  reason_code: unknown;
  currency: unknown;
  metadata: unknown;
  schema_version: unknown;
  idempotency_key: unknown;
};

export type ReconciliationAppointmentRow = {
  id: unknown;
  business_id: unknown;
  start_time: unknown;
};

export type ReconciliationCheckInput = {
  events: ReconciliationAnalyticsEventRow[];
  appointments: ReconciliationAppointmentRow[];
  scope: AnalyticsReconciliationReport['scope'];
  scanTruncated: boolean;
  issueSampleLimit: number;
  thresholds: {
    futureToleranceMs: number;
    suspiciousFutureMs: number;
    delayedWarningMs: number;
    delayedErrorMs: number;
    metadataSizeWarningBytes: number;
  };
};
