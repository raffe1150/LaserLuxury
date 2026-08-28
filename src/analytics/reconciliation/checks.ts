import type {
  AnalyticsReconciliationReport,
  ReconciliationAnalyticsEventRow,
  ReconciliationAppointmentRow,
  ReconciliationCheckInput,
  ReconciliationIssue,
  ReconciliationSeverity,
  ReconciliationVolumeBucket,
} from './types';

const SUPPORTED_EVENT_NAMES = new Set([
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
  'booking_rescheduled',
  'booking_cancelled',
  'customer_message_received',
]);

const BOOKING_REFERENCE_EVENT_NAMES = new Set([
  'booking_completed',
  'booking_created',
  'booking_rescheduled',
  'booking_cancelled',
]);

const COMPLETION_EVENT_NAMES = new Set(['booking_completed', 'booking_created']);
const DEFERRED_EVENT_NAMES = new Set(['human_message_sent', 'conversation_resolved']);
const CANONICAL_PLATFORMS = new Set(['telegram', 'whatsapp', 'messenger', 'instagram', 'website']);
const OPTIONAL_TEXT_FIELDS = [
  'conversation_id',
  'customer_key',
  'service_id',
  'service_name_snapshot',
  'language',
  'reason_code',
] as const;
const FORBIDDEN_METADATA_KEYS = new Set([
  'phone',
  'phone_number',
  'email',
  'name',
  'customer_name',
  'message',
  'message_text',
  'text',
  'access_token',
  'refresh_token',
  'token',
  'bot_token',
  'app_secret',
  'webhook_secret',
  'webhook_payload',
  'raw_payload',
  'provider_id',
  'provider_user_id',
]);

const EVENT_CONTRACTS: Record<string, {
  category: string;
  actor: string;
  outcome: string;
  sources: ReadonlySet<string>;
}> = {
  conversation_started: {
    category: 'conversation', actor: 'system', outcome: 'started',
    sources: new Set(['telegram_provider_update', 'whatsapp_webhook', 'messenger_webhook', 'instagram_webhook']),
  },
  booking_started: {
    category: 'booking', actor: 'system', outcome: 'started', sources: new Set(['unified_booking_engine']),
  },
  availability_requested: {
    category: 'booking', actor: 'system', outcome: 'requested', sources: new Set(['unified_booking_engine']),
  },
  slot_offered: {
    category: 'booking', actor: 'system', outcome: 'available', sources: new Set(['unified_booking_engine']),
  },
  slot_selected: {
    category: 'booking', actor: 'system', outcome: 'selected', sources: new Set(['unified_booking_engine']),
  },
  booking_completed: {
    category: 'booking', actor: 'system', outcome: 'success', sources: new Set(['unified_booking_engine']),
  },
  booking_failed: {
    category: 'booking', actor: 'system', outcome: 'failure', sources: new Set(['unified_booking_engine']),
  },
  booking_created: {
    category: 'booking',
    actor: 'ai',
    outcome: 'success',
    sources: new Set(['unified_booking_engine']),
  },
  booking_rescheduled: {
    category: 'booking',
    actor: 'ai',
    outcome: 'success',
    sources: new Set(['unified_reschedule_engine']),
  },
  booking_cancelled: {
    category: 'booking',
    actor: 'ai',
    outcome: 'success',
    sources: new Set(['unified_cancellation_engine']),
  },
  customer_message_received: {
    category: 'conversation',
    actor: 'customer',
    outcome: 'received',
    sources: new Set([
      'telegram_polling',
      'telegram_webhook',
      'telegram_provider_update',
      'whatsapp_webhook',
      'messenger_webhook',
      'instagram_webhook',
    ]),
  },
};

type IssueCollector = {
  add: (issue: ReconciliationIssue) => void;
  result: () => Pick<AnalyticsReconciliationReport, 'issues' | 'issueCounts' | 'summary'>;
};

function createIssueCollector(sampleLimit: number): IssueCollector {
  const issues: ReconciliationIssue[] = [];
  const issueCounts: Record<string, number> = {};
  const severityCounts: Record<ReconciliationSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };

  return {
    add(issue) {
      issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
      severityCounts[issue.severity] += 1;
      if (issues.length < sampleLimit) issues.push(issue);
    },
    result() {
      const issueCount = Object.values(issueCounts).reduce((sum, count) => sum + count, 0);
      return {
        issues,
        issueCounts,
        summary: {
          checkedEvents: 0,
          checkedAppointments: 0,
          scanTruncated: false,
          issueCount,
          sampledIssueCount: issues.length,
          criticalCount: severityCounts.critical,
          errorCount: severityCounts.error,
          warningCount: severityCounts.warning,
          infoCount: severityCounts.info,
          issuesTruncated: issueCount > issues.length,
        },
      };
    },
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value || '').trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDateMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventContext(row: ReconciliationAnalyticsEventRow): Omit<ReconciliationIssue, 'code' | 'severity'> {
  const rawEventName = text(row.event_name).trim();
  const eventName = SUPPORTED_EVENT_NAMES.has(rawEventName) || DEFERRED_EVENT_NAMES.has(rawEventName)
    ? rawEventName
    : '';
  const businessId = positiveSafeInteger(row.business_id) || undefined;
  const bookingId = positiveSafeInteger(row.booking_id) || undefined;
  const eventId = text(row.id).trim() || undefined;
  const occurredAt = validDateMs(row.occurred_at) === null ? undefined : text(row.occurred_at);
  return { eventName: eventName || undefined, businessId, bookingId, eventId, occurredAt };
}

function normalizedMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function probableSensitiveString(value: string): 'email' | 'phone' | null {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return 'email';
  if (!/^[+()\d.\-\s]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? 'phone' : null;
}

function inspectMetadata(
  value: unknown,
  collector: IssueCollector,
  context: ReturnType<typeof eventContext>,
): void {
  if (!value || typeof value !== 'object') return;
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let forbiddenKeyFound = false;
  let probableEmailFound = false;
  let probablePhoneFound = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    for (const [key, nested] of Object.entries(current)) {
      if (FORBIDDEN_METADATA_KEYS.has(normalizedMetadataKey(key))) {
        forbiddenKeyFound = true;
        continue;
      }
      if (typeof nested === 'string') {
        const sensitiveCategory = probableSensitiveString(nested);
        if (sensitiveCategory === 'email') probableEmailFound = true;
        if (sensitiveCategory === 'phone') probablePhoneFound = true;
      } else if (nested && typeof nested === 'object') {
        stack.push(nested);
      }
    }
  }

  if (forbiddenKeyFound) {
    collector.add({
      code: 'FORBIDDEN_METADATA_KEY',
      severity: 'critical',
      ...context,
      safeContext: { forbiddenKeyPresent: true },
    });
  }
  if (probableEmailFound || probablePhoneFound) {
    collector.add({
      code: 'PROBABLE_PII_IN_METADATA',
      severity: 'critical',
      ...context,
      safeContext: {
        probableEmailPresent: probableEmailFound,
        probablePhonePresent: probablePhoneFound,
      },
    });
  }
}

function validateEventRows(input: ReconciliationCheckInput, collector: IssueCollector): void {
  const nowMs = Date.now();

  for (const row of input.events) {
    const context = eventContext(row);
    const eventName = text(row.event_name).trim();
    const businessId = positiveSafeInteger(row.business_id);
    const bookingId = positiveSafeInteger(row.booking_id);
    const occurredMs = validDateMs(row.occurred_at);
    const recordedMs = validDateMs(row.recorded_at);

    if (!eventName || (!SUPPORTED_EVENT_NAMES.has(eventName) && !DEFERRED_EVENT_NAMES.has(eventName))) {
      collector.add({ code: 'UNSUPPORTED_EVENT_NAME', severity: 'error', ...context });
    } else if (DEFERRED_EVENT_NAMES.has(eventName)) {
      collector.add({ code: 'DEFERRED_EVENT_PRESENT', severity: 'warning', ...context });
    }

    if (row.schema_version !== 1) {
      collector.add({ code: 'UNSUPPORTED_SCHEMA_VERSION', severity: 'critical', ...context });
    }
    if (!businessId) collector.add({ code: 'INVALID_BUSINESS_ID', severity: 'error', ...context });

    for (const field of ['event_name', 'event_category', 'source', 'actor', 'outcome', 'idempotency_key'] as const) {
      if (!text(row[field]).trim()) {
        collector.add({
          code: 'INVALID_REQUIRED_TEXT',
          severity: 'error',
          ...context,
          safeContext: { field },
        });
      }
    }

    for (const field of OPTIONAL_TEXT_FIELDS) {
      const value = row[field];
      if (typeof value === 'string' && !value.trim()) {
        collector.add({
          code: 'WHITESPACE_ONLY_OPTIONAL_TEXT',
          severity: 'error',
          ...context,
          safeContext: { field },
        });
      }
    }

    if (BOOKING_REFERENCE_EVENT_NAMES.has(eventName) && !bookingId) {
      collector.add({ code: 'INVALID_BOOKING_ID', severity: 'error', ...context });
    }

    const contract = EVENT_CONTRACTS[eventName];
    if (contract) {
      if (text(row.event_category).trim() !== contract.category) {
        collector.add({ code: 'EVENT_CATEGORY_DRIFT', severity: 'error', ...context });
      }
      if (text(row.actor).trim() !== contract.actor) {
        collector.add({ code: 'ACTOR_DRIFT', severity: 'error', ...context });
      }
      if (text(row.outcome).trim() !== contract.outcome) {
        collector.add({ code: 'OUTCOME_DRIFT', severity: 'error', ...context });
      }
      if (!contract.sources.has(text(row.source).trim())) {
        collector.add({ code: 'SOURCE_DRIFT', severity: 'error', ...context });
      }
    }

    const rawPlatform = text(row.platform);
    const platform = rawPlatform.trim();
    if (eventName === 'customer_message_received') {
      if (!platform) {
        collector.add({ code: 'MESSAGE_PLATFORM_INVALID', severity: 'error', ...context });
      } else if (!CANONICAL_PLATFORMS.has(platform)) {
        collector.add({ code: 'NON_CANONICAL_PLATFORM', severity: 'error', ...context });
      }
      if (text(row.channel).trim() !== platform) {
        collector.add({ code: 'MESSAGE_CHANNEL_INVALID', severity: 'error', ...context });
      }
    } else if (platform && !CANONICAL_PLATFORMS.has(platform)) {
      collector.add({ code: 'NON_CANONICAL_PLATFORM', severity: 'error', ...context });
    }

    if (occurredMs === null) collector.add({ code: 'INVALID_OCCURRED_AT', severity: 'error', ...context });
    if (recordedMs === null) collector.add({ code: 'INVALID_RECORDED_AT', severity: 'error', ...context });
    if (occurredMs !== null && Number.isFinite(nowMs)) {
      const futureMs = occurredMs - nowMs;
      if (futureMs > input.thresholds.suspiciousFutureMs) {
        collector.add({ code: 'TIMESTAMP_FAR_FUTURE', severity: 'error', ...context });
      } else if (futureMs > input.thresholds.futureToleranceMs) {
        collector.add({ code: 'TIMESTAMP_FUTURE', severity: 'warning', ...context });
      }
    }
    if (occurredMs !== null && recordedMs !== null) {
      const delayMs = recordedMs - occurredMs;
      if (delayMs < -input.thresholds.suspiciousFutureMs) {
        collector.add({ code: 'OCCURRED_AFTER_RECORDED_INVALID', severity: 'error', ...context });
      } else if (delayMs < -input.thresholds.futureToleranceMs) {
        collector.add({ code: 'OCCURRED_AFTER_RECORDED', severity: 'warning', ...context });
      } else if (delayMs > input.thresholds.delayedErrorMs) {
        collector.add({ code: 'RECORDING_EXTREMELY_DELAYED', severity: 'error', ...context });
      } else if (delayMs > input.thresholds.delayedWarningMs) {
        collector.add({ code: 'RECORDING_DELAYED', severity: 'warning', ...context });
      }
    }

    if (!row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) {
      collector.add({ code: 'METADATA_NOT_OBJECT', severity: 'error', ...context });
    } else {
      inspectMetadata(row.metadata, collector, context);
      const metadataBytes = Buffer.byteLength(JSON.stringify(row.metadata), 'utf8');
      if (metadataBytes > input.thresholds.metadataSizeWarningBytes) {
        collector.add({
          code: 'METADATA_UNUSUALLY_LARGE',
          severity: 'warning',
          ...context,
          safeContext: { metadataBytes },
        });
      }
    }

    const customerKey = text(row.customer_key).trim();
    if (customerKey && !/^[a-f0-9]{64}$/.test(customerKey)) {
      collector.add({ code: 'CUSTOMER_KEY_INVALID', severity: 'critical', ...context });
    }
    const currency = text(row.currency).trim();
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      collector.add({ code: 'CURRENCY_INVALID', severity: 'error', ...context });
    }
  }
}

function detectDuplicates(events: ReconciliationAnalyticsEventRow[], collector: IssueCollector): void {
  const exactKeys = new Map<string, ReconciliationAnalyticsEventRow>();
  const created = new Map<string, ReconciliationAnalyticsEventRow>();
  const completed = new Map<string, ReconciliationAnalyticsEventRow>();
  const cancelled = new Map<string, ReconciliationAnalyticsEventRow>();
  const rescheduled = new Map<string, ReconciliationAnalyticsEventRow>();

  for (const row of events) {
    const businessId = positiveSafeInteger(row.business_id);
    const bookingId = positiveSafeInteger(row.booking_id);
    const eventName = text(row.event_name).trim();
    const idempotencyKey = text(row.idempotency_key).trim();
    const context = eventContext(row);

    if (businessId && idempotencyKey) {
      const key = `${businessId}:${idempotencyKey}`;
      if (exactKeys.has(key)) {
        collector.add({ code: 'EXACT_IDEMPOTENCY_DUPLICATE', severity: 'critical', ...context });
      } else exactKeys.set(key, row);
    }
    if (!businessId || !bookingId) continue;

    const bookingKey = `${businessId}:${bookingId}`;
    if (COMPLETION_EVENT_NAMES.has(eventName)) {
      if (completed.has(bookingKey)) {
        collector.add({ code: 'DUPLICATE_BOOKING_COMPLETION', severity: 'critical', ...context });
      } else completed.set(bookingKey, row);
    }
    if (eventName === 'booking_created') {
      if (created.has(bookingKey)) {
        collector.add({ code: 'DUPLICATE_BOOKING_CREATED', severity: 'error', ...context });
      } else created.set(bookingKey, row);
    } else if (eventName === 'booking_cancelled') {
      if (cancelled.has(bookingKey)) {
        collector.add({ code: 'DUPLICATE_BOOKING_CANCELLED', severity: 'error', ...context });
      } else cancelled.set(bookingKey, row);
    } else if (eventName === 'booking_rescheduled') {
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      const newStartMs = validDateMs(metadata.new_start_time);
      if (newStartMs === null) continue;
      const logicalKey = `${bookingKey}:${new Date(newStartMs).toISOString()}`;
      if (rescheduled.has(logicalKey)) {
        collector.add({ code: 'DUPLICATE_BOOKING_RESCHEDULED', severity: 'error', ...context });
      } else rescheduled.set(logicalKey, row);
    }
  }
}

function reconcileBookings(input: ReconciliationCheckInput, collector: IssueCollector): void {
  const appointmentById = new Map<number, ReconciliationAppointmentRow>();
  for (const appointment of input.appointments) {
    const appointmentId = positiveSafeInteger(appointment.id);
    if (appointmentId) appointmentById.set(appointmentId, appointment);
  }

  const latestReschedule = new Map<string, ReconciliationAnalyticsEventRow>();
  const completions = new Set<string>();

  for (const event of input.events) {
    const eventName = text(event.event_name).trim();
    if (!BOOKING_REFERENCE_EVENT_NAMES.has(eventName)) continue;
    const businessId = positiveSafeInteger(event.business_id);
    const bookingId = positiveSafeInteger(event.booking_id);
    if (!businessId || !bookingId) continue;

    const appointment = appointmentById.get(bookingId);
    const context = eventContext(event);
    if (!appointment) {
      collector.add({
        code: COMPLETION_EVENT_NAMES.has(eventName)
          ? 'COMPLETION_WITHOUT_AUTHORITATIVE_APPOINTMENT'
          : 'BOOKING_EVENT_ORPHAN_UNRESOLVED',
        severity: COMPLETION_EVENT_NAMES.has(eventName) ? 'critical' : 'warning',
        ...context,
        safeContext: { classification: 'possible_deleted_operational_record_or_unknown' },
      });
      continue;
    }

    const appointmentBusinessId = positiveSafeInteger(appointment.business_id);
    if (appointmentBusinessId !== businessId) {
      collector.add({
        code: 'BOOKING_BUSINESS_MISMATCH',
        severity: 'critical',
        ...context,
        safeContext: { appointmentBusinessId },
      });
      continue;
    }

    const bookingKey = `${businessId}:${bookingId}`;
    if (COMPLETION_EVENT_NAMES.has(eventName)) {
      completions.add(bookingKey);
      const eventService = text(event.service_name_snapshot).toLocaleLowerCase();
      const appointmentService = text(appointment.service).toLocaleLowerCase();
      if (eventService && appointmentService && eventService !== appointmentService) {
        collector.add({ code: 'COMPLETION_SERVICE_MISMATCH', severity: 'error', ...context });
      }
      const eventChannel = text(event.channel) || text(event.platform);
      const appointmentChannel = text(appointment.platform);
      if (eventChannel && appointmentChannel && eventChannel !== appointmentChannel) {
        collector.add({ code: 'COMPLETION_CHANNEL_MISMATCH', severity: 'error', ...context });
      }
      const appointmentStatus = text(appointment.status).toLowerCase();
      if (appointmentStatus && appointmentStatus !== 'booked' && appointmentStatus !== 'completed') {
        collector.add({ code: 'COMPLETION_APPOINTMENT_STATUS_MISMATCH', severity: 'critical', ...context });
      }
    }
    if (eventName === 'booking_rescheduled') {
      const existing = latestReschedule.get(bookingKey);
      const existingOccurred = existing ? validDateMs(existing.occurred_at) : null;
      const candidateOccurred = validDateMs(event.occurred_at);
      if (!existing || (candidateOccurred !== null && (existingOccurred === null || candidateOccurred > existingOccurred))) {
        latestReschedule.set(bookingKey, event);
      }
    }
  }

  for (const event of latestReschedule.values()) {
    const bookingId = positiveSafeInteger(event.booking_id);
    if (!bookingId) continue;
    const appointment = appointmentById.get(bookingId);
    if (!appointment) continue;
    const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {};
    const newStartMs = validDateMs(metadata.new_start_time);
    const appointmentStartMs = validDateMs(appointment.start_time);
    const context = eventContext(event);

    if (newStartMs === null) {
      collector.add({ code: 'RESCHEDULE_NEW_START_INVALID', severity: 'error', ...context });
    } else if (appointmentStartMs === null) {
      collector.add({ code: 'APPOINTMENT_START_INVALID', severity: 'error', ...context });
    } else if (newStartMs !== appointmentStartMs) {
      collector.add({
        code: 'LATEST_RESCHEDULE_START_MISMATCH',
        severity: 'error',
        ...context,
      });
    }
  }

  const fromMs = validDateMs(input.scope.from);
  const toMs = validDateMs(input.scope.to);
  for (const appointment of input.appointments) {
    const appointmentId = positiveSafeInteger(appointment.id);
    const businessId = positiveSafeInteger(appointment.business_id);
    const createdAtMs = validDateMs(appointment.created_at);
    const status = text(appointment.status).toLowerCase();
    if (
      !appointmentId
      || businessId !== input.scope.businessId
      || createdAtMs === null
      || fromMs === null
      || toMs === null
      || createdAtMs < fromMs
      || createdAtMs >= toMs
      || (status !== 'booked' && status !== 'completed')
    ) continue;
    if (!completions.has(`${businessId}:${appointmentId}`)) {
      collector.add({
        code: input.scanTruncated
          ? 'APPOINTMENT_COMPLETION_UNVERIFIED_PARTIAL_SCAN'
          : 'AUTHORITATIVE_APPOINTMENT_MISSING_COMPLETION',
        severity: input.scanTruncated ? 'info' : 'warning',
        businessId,
        bookingId: appointmentId,
        safeContext: { appointmentStatus: status },
      });
    }
  }
}

function detectImpossibleFunnelOrdering(
  events: ReconciliationAnalyticsEventRow[],
  collector: IssueCollector,
): void {
  const order = [
    'booking_started',
    'availability_requested',
    'slot_offered',
    'slot_selected',
    'booking_completed',
  ] as const;
  const conversations = new Map<string, Map<string, ReconciliationAnalyticsEventRow>>();
  for (const event of events) {
    const eventName = text(event.event_name).trim();
    if (!order.includes(eventName as typeof order[number])) continue;
    const businessId = positiveSafeInteger(event.business_id);
    const conversationId = text(event.conversation_id).trim();
    const occurredAt = validDateMs(event.occurred_at);
    if (!businessId || !conversationId || occurredAt === null) continue;
    const key = `${businessId}:${conversationId}`;
    const stages = conversations.get(key) || new Map<string, ReconciliationAnalyticsEventRow>();
    const existing = stages.get(eventName);
    const existingAt = existing ? validDateMs(existing.occurred_at) : null;
    if (!existing || existingAt === null || occurredAt < existingAt) stages.set(eventName, event);
    conversations.set(key, stages);
  }

  for (const stages of conversations.values()) {
    let previous: ReconciliationAnalyticsEventRow | undefined;
    for (const eventName of order) {
      const current = stages.get(eventName);
      if (!current) continue;
      if (previous) {
        const previousAt = validDateMs(previous.occurred_at);
        const currentAt = validDateMs(current.occurred_at);
        if (previousAt !== null && currentAt !== null && currentAt < previousAt) {
          collector.add({
            code: 'IMPOSSIBLE_FUNNEL_ORDER',
            severity: 'warning',
            ...eventContext(current),
            safeContext: {
              previousStage: text(previous.event_name),
              currentStage: eventName,
            },
          });
        }
      }
      previous = current;
    }
  }
}

function buildVolume(events: ReconciliationAnalyticsEventRow[]): ReconciliationVolumeBucket[] {
  const buckets = new Map<string, ReconciliationVolumeBucket>();
  for (const event of events) {
    const businessId = positiveSafeInteger(event.business_id);
    const occurredMs = validDateMs(event.occurred_at);
    const eventName = text(event.event_name).trim();
    if (!businessId || occurredMs === null || !eventName) continue;
    const rawPlatform = text(event.platform).trim();
    const platform = rawPlatform
      ? CANONICAL_PLATFORMS.has(rawPlatform) ? rawPlatform : 'non_canonical'
      : null;
    const safeEventName = SUPPORTED_EVENT_NAMES.has(eventName) || DEFERRED_EVENT_NAMES.has(eventName)
      ? eventName
      : 'unsupported';
    const utcDate = new Date(occurredMs).toISOString().slice(0, 10);
    const key = `${businessId}:${safeEventName}:${platform || ''}:${utcDate}`;
    const existing = buckets.get(key);
    if (existing) existing.count += 1;
    else buckets.set(key, { businessId, eventName: safeEventName, platform, utcDate, count: 1 });
  }
  return Array.from(buckets.values()).sort((a, b) =>
    a.utcDate.localeCompare(b.utcDate)
    || a.businessId - b.businessId
    || a.eventName.localeCompare(b.eventName)
    || String(a.platform).localeCompare(String(b.platform))
  );
}

export function buildAnalyticsReconciliationReport(
  input: ReconciliationCheckInput,
): AnalyticsReconciliationReport {
  const collector = createIssueCollector(input.issueSampleLimit);
  validateEventRows(input, collector);
  detectDuplicates(input.events, collector);
  reconcileBookings(input, collector);
  detectImpossibleFunnelOrdering(input.events, collector);
  const volume = buildVolume(input.events);

  if (input.scanTruncated) {
    collector.add({
      code: 'SCAN_LIMIT_REACHED',
      severity: 'warning',
      safeContext: {
        checkedEvents: input.events.length,
        classification: 'max_rows_plus_one_sentinel',
      },
    });
  }

  const collected = collector.result();
  return {
    generatedAt: new Date().toISOString(),
    scope: input.scope,
    summary: {
      ...collected.summary,
      checkedEvents: input.events.length,
      checkedAppointments: input.appointments.length,
      scanTruncated: input.scanTruncated,
    },
    issueCounts: collected.issueCounts,
    issues: collected.issues,
    volume,
    coverage: {
      exactIdempotencyDuplicates: input.scanTruncated ? 'partial_scan' : 'checked',
      bookingCreated: 'deferred_missing_appointment_index',
      bookingCompleted: input.scanTruncated ? 'partial_scan' : 'checked',
      authoritativeAppointments: input.scanTruncated ? 'partial_scan' : 'checked',
      funnelOrdering: input.scanTruncated ? 'partial_scan' : 'checked_when_conversation_correlated',
      bookingCancelled: 'not_deterministically_reconcilable',
      bookingRescheduled: 'latest_event_only',
      customerMessageReceived: 'internal_quality_only',
    },
  };
}
