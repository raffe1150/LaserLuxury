import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AnalyticsReconciliationOptions,
  ReconciliationAnalyticsEventRow,
  ReconciliationAppointmentRow,
} from './types';

const EVENT_COLUMNS = [
  'id',
  'business_id',
  'event_name',
  'event_category',
  'occurred_at',
  'recorded_at',
  'conversation_id',
  'booking_id',
  'customer_key',
  'platform',
  'channel',
  'service_id',
  'service_name_snapshot',
  'language',
  'source',
  'actor',
  'outcome',
  'reason_code',
  'currency',
  'metadata',
  'schema_version',
  'idempotency_key',
].join(',');

const APPOINTMENT_COLUMNS = 'id,business_id,service,platform,status,created_at,start_time';

let reconciliationClient: SupabaseClient | null = null;

/** @internal */
export class AnalyticsReconciliationError extends Error {
  readonly code:
    | 'business_id_required'
    | 'boundary_required'
    | 'configuration_unavailable'
    | 'invalid_options'
    | 'query_failed';

  constructor(code: AnalyticsReconciliationError['code']) {
    super('Analytics reconciliation could not be completed.');
    this.name = 'AnalyticsReconciliationError';
    this.code = code;
  }
}

function getReconciliationClient(): SupabaseClient {
  if (reconciliationClient) return reconciliationClient;
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new AnalyticsReconciliationError('configuration_unavailable');
  }
  reconciliationClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return reconciliationClient;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new AnalyticsReconciliationError('invalid_options');
  }
  return value;
}

function isoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) {
    throw new AnalyticsReconciliationError('invalid_options');
  }
  return new Date(parsed).toISOString();
}

function normalizeScope(options: AnalyticsReconciliationOptions): {
  businessId: number;
  from: string;
  to: string;
  boundarySource: 'caller' | 'environment';
  pageSize: number;
  maxRows: number;
  issueSampleLimit: number;
} {
  if (!Number.isSafeInteger(options.businessId) || options.businessId <= 0) {
    throw new AnalyticsReconciliationError('business_id_required');
  }

  const callerFrom = isoTimestamp(options.from);
  const environmentFrom = callerFrom
    ? undefined
    : isoTimestamp(process.env.ANALYTICS_RECONCILIATION_FROM?.trim() || undefined);
  const from = callerFrom || environmentFrom;
  if (!from) throw new AnalyticsReconciliationError('boundary_required');

  const to = isoTimestamp(options.to) || new Date().toISOString();
  if (Date.parse(from) >= Date.parse(to)) {
    throw new AnalyticsReconciliationError('invalid_options');
  }

  return {
    businessId: options.businessId,
    from,
    to,
    boundarySource: callerFrom ? 'caller' : 'environment',
    pageSize: boundedInteger(options.pageSize, 500, 1_000),
    maxRows: boundedInteger(options.maxRows, 10_000, 50_000),
    issueSampleLimit: boundedInteger(options.issueSampleLimit, 200, 2_000),
  };
}

async function fetchEvents(input: {
  client: SupabaseClient;
  businessId: number;
  from: string;
  to: string;
  pageSize: number;
  maxRows: number;
}): Promise<{ rows: ReconciliationAnalyticsEventRow[]; truncated: boolean }> {
  const targetRows = input.maxRows + 1;
  const rows: ReconciliationAnalyticsEventRow[] = [];

  while (rows.length < targetRows) {
    const pageLength = Math.min(input.pageSize, targetRows - rows.length);
    const { data, error } = await input.client
      .from('analytics_events')
      .select(EVENT_COLUMNS)
      .eq('business_id', input.businessId)
      .gte('occurred_at', input.from)
      .lt('occurred_at', input.to)
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(rows.length, rows.length + pageLength - 1);
    if (error) throw new AnalyticsReconciliationError('query_failed');
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data as unknown as ReconciliationAnalyticsEventRow[]);
    if (data.length < pageLength) break;
  }

  return {
    rows: rows.slice(0, input.maxRows),
    truncated: rows.length > input.maxRows,
  };
}

async function fetchReferencedAppointments(
  client: SupabaseClient,
  businessId: number,
  events: ReconciliationAnalyticsEventRow[],
): Promise<ReconciliationAppointmentRow[]> {
  const ids = Array.from(new Set(events
    .filter((event) => Number(event.business_id) === businessId)
    .map((event) => Number(String(event.booking_id || '').trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0)));
  const rows: ReconciliationAppointmentRow[] = [];

  // Exact primary-key lookups are bounded by booking IDs from the tenant-scoped
  // event scan. business_id is selected so mismatched correlation snapshots can
  // be reported instead of being misclassified as missing appointments.
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const { data, error } = await client
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .in('id', chunk)
      .limit(chunk.length);
    if (error) throw new AnalyticsReconciliationError('query_failed');
    if (Array.isArray(data)) {
      rows.push(...data as unknown as ReconciliationAppointmentRow[]);
    }
  }
  return rows;
}

async function fetchWindowAppointments(input: {
  client: SupabaseClient;
  businessId: number;
  from: string;
  to: string;
  pageSize: number;
  maxRows: number;
}): Promise<{ rows: ReconciliationAppointmentRow[]; truncated: boolean }> {
  const targetRows = input.maxRows + 1;
  const rows: ReconciliationAppointmentRow[] = [];
  while (rows.length < targetRows) {
    const pageLength = Math.min(input.pageSize, targetRows - rows.length);
    const { data, error } = await input.client
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('business_id', input.businessId)
      .gte('created_at', input.from)
      .lt('created_at', input.to)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(rows.length, rows.length + pageLength - 1);
    if (error) throw new AnalyticsReconciliationError('query_failed');
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data as unknown as ReconciliationAppointmentRow[]);
    if (data.length < pageLength) break;
  }
  return { rows: rows.slice(0, input.maxRows), truncated: rows.length > input.maxRows };
}

/** @internal Test seam; the client is deliberately not part of public options. */
export async function loadReconciliationRows(
  options: AnalyticsReconciliationOptions,
  injectedClient?: SupabaseClient,
): Promise<{
  events: ReconciliationAnalyticsEventRow[];
  appointments: ReconciliationAppointmentRow[];
  scanTruncated: boolean;
  businessId: number;
  from: string;
  to: string;
  boundarySource: 'caller' | 'environment';
  issueSampleLimit: number;
}> {
  const scope = normalizeScope(options);
  const client = injectedClient || getReconciliationClient();
  const eventResult = await fetchEvents({ client, ...scope });
  const [windowAppointments, referencedAppointments] = await Promise.all([
    fetchWindowAppointments({ client, ...scope }),
    fetchReferencedAppointments(client, scope.businessId, eventResult.rows),
  ]);
  const appointmentMap = new Map<string, ReconciliationAppointmentRow>();
  for (const appointment of [...windowAppointments.rows, ...referencedAppointments]) {
    const id = String(appointment.id || '').trim();
    if (id) appointmentMap.set(id, appointment);
  }
  const appointments = Array.from(appointmentMap.values());

  return {
    events: eventResult.rows,
    appointments,
    scanTruncated: eventResult.truncated || windowAppointments.truncated,
    businessId: scope.businessId,
    from: scope.from,
    to: scope.to,
    boundarySource: scope.boundarySource,
    issueSampleLimit: scope.issueSampleLimit,
  };
}
