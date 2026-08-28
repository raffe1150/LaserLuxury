import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  BusinessAnalyticsRequest,
  BusinessMetricAppointmentRow,
  BusinessMetricEventRow,
  BusinessMetricService,
  LoadedBusinessAnalyticsRows,
} from './contracts';
import { AnalyticsMetricsError } from './validation';
import { resolveAnalyticsWindow } from './windows';

const EVENT_COLUMNS = [
  'business_id', 'event_name', 'occurred_at', 'conversation_id', 'booking_id',
  'channel', 'platform', 'service_id', 'service_name_snapshot', 'outcome',
  'reason_code', 'idempotency_key',
].join(',');
const APPOINTMENT_COLUMNS = 'id,business_id,service,platform,status,created_at';
const EVENT_NAMES = [
  'conversation_started', 'customer_message_received', 'booking_started',
  'availability_requested', 'slot_offered', 'slot_selected', 'booking_completed',
  'booking_created', 'booking_failed', 'booking_abandoned',
] as const;

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new AnalyticsMetricsError('analytics_query_failed');
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

function limit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new AnalyticsMetricsError('invalid_query_limit');
  }
  return Number(value);
}

function services(value: unknown): BusinessMetricService[] {
  if (!Array.isArray(value)) return [];
  const result: BusinessMetricService[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const rawPrice = row.price;
    const price = rawPrice === null || rawPrice === undefined || rawPrice === ''
      ? null
      : Number(rawPrice);
    const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : '';
    if (!name) continue;
    const validCurrency = /^[A-Z]{3}$/.test(currency);
    result.push({
      name,
      price: price !== null && Number.isFinite(price) && price >= 0 && validCurrency ? price : null,
      currency: validCurrency ? currency : '',
    });
  }
  return result;
}

async function loadBusinessAnalyticsContext(
  request: BusinessAnalyticsRequest,
  database: SupabaseClient,
): Promise<{
  scope: LoadedBusinessAnalyticsRows['scope'];
  services: BusinessMetricService[];
}> {
  const { data: business, error } = await database
    .from('businesses')
    .select('id,timezone,services')
    .eq('id', request.businessId)
    .maybeSingle();
  if (error || !business || Number(business.id) !== request.businessId) {
    throw new AnalyticsMetricsError('analytics_query_failed');
  }
  return {
    scope: resolveAnalyticsWindow({
      businessId: request.businessId,
      timezone: String(business.timezone || 'Europe/Stockholm'),
      window: request.window,
      now: request.now,
    }),
    services: services(business.services),
  };
}

/** Resolves the same tenant timezone window used by summary loading without scanning metrics. */
export async function resolveBusinessAnalyticsScope(
  request: BusinessAnalyticsRequest,
  injectedClient?: SupabaseClient,
): Promise<LoadedBusinessAnalyticsRows['scope']> {
  if (!request || !Number.isSafeInteger(request.businessId) || request.businessId <= 0) {
    throw new AnalyticsMetricsError('business_id_required');
  }
  try {
    return (await loadBusinessAnalyticsContext(request, injectedClient || getClient())).scope;
  } catch (error) {
    if (error instanceof AnalyticsMetricsError) throw error;
    throw new AnalyticsMetricsError('analytics_query_failed');
  }
}

async function fetchPages<T>(input: {
  client: SupabaseClient;
  table: 'analytics_events' | 'appointments';
  columns: string;
  businessId: number;
  timeColumn: 'occurred_at' | 'created_at';
  from: string;
  to: string;
  pageSize: number;
  maximum: number;
  eventNames?: readonly string[];
}): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  const target = input.maximum + 1;
  while (rows.length < target) {
    const length = Math.min(input.pageSize, target - rows.length);
    let query = input.client
      .from(input.table)
      .select(input.columns)
      .eq('business_id', input.businessId);
    if (input.eventNames) query = query.in('event_name', input.eventNames);
    const { data, error } = await query
      .gte(input.timeColumn, input.from)
      .lt(input.timeColumn, input.to)
      .order(input.timeColumn, { ascending: true })
      .range(rows.length, rows.length + length - 1);
    if (error) throw new AnalyticsMetricsError('analytics_query_failed');
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data as unknown as T[]);
    if (data.length < length) break;
  }
  return { rows: rows.slice(0, input.maximum), truncated: rows.length > input.maximum };
}

/** @internal Test seam. */
export async function loadBusinessAnalyticsRows(
  request: BusinessAnalyticsRequest,
  injectedClient?: SupabaseClient,
): Promise<LoadedBusinessAnalyticsRows> {
  if (!request || !Number.isSafeInteger(request.businessId) || request.businessId <= 0) {
    throw new AnalyticsMetricsError('business_id_required');
  }
  const database = injectedClient || getClient();
  try {
    const context = await loadBusinessAnalyticsContext(request, database);
    const scope = context.scope;
    const pageSize = limit(request.pageSize, 500, 1_000);
    const maxEvents = limit(request.maxEvents, 20_000, 50_000);
    const maxAppointments = limit(request.maxAppointments, 20_000, 50_000);
    const [eventResult, appointmentResult] = await Promise.all([
      fetchPages<BusinessMetricEventRow>({
        client: database, table: 'analytics_events', columns: EVENT_COLUMNS,
        businessId: request.businessId, timeColumn: 'occurred_at',
        from: scope.from, to: scope.to, pageSize, maximum: maxEvents,
        eventNames: EVENT_NAMES,
      }),
      fetchPages<BusinessMetricAppointmentRow>({
        client: database, table: 'appointments', columns: APPOINTMENT_COLUMNS,
        businessId: request.businessId, timeColumn: 'created_at',
        from: scope.from, to: scope.to, pageSize, maximum: maxAppointments,
      }),
    ]);
    return {
      scope,
      events: eventResult.rows,
      appointments: appointmentResult.rows,
      services: context.services,
      eventsTruncated: eventResult.truncated,
      appointmentsTruncated: appointmentResult.truncated,
    };
  } catch (error) {
    if (error instanceof AnalyticsMetricsError) throw error;
    throw new AnalyticsMetricsError('analytics_query_failed');
  }
}
