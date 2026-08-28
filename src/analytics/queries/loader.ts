import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AnalyticsMetricEventRow,
  AnalyticsMetricsOptions,
  LoadedAnalyticsMetricRows,
  NormalizedAnalyticsMetricsOptions,
} from './types';
import { AnalyticsMetricsError, validateAnalyticsMetricsOptions } from './validation';

const METRIC_COLUMNS = 'event_name,occurred_at,platform,service_name_snapshot';
const METRIC_EVENTS = [
  'booking_created',
  'booking_completed',
  'booking_rescheduled',
  'booking_cancelled',
  'customer_message_received',
] as const;

let metricsClient: SupabaseClient | null = null;

function getMetricsClient(): SupabaseClient {
  if (metricsClient) return metricsClient;
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) throw new AnalyticsMetricsError('analytics_query_failed');
  try {
    metricsClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    throw new AnalyticsMetricsError('analytics_query_failed');
  }
  return metricsClient;
}

async function fetchMetricEvents(
  client: SupabaseClient,
  options: NormalizedAnalyticsMetricsOptions,
): Promise<{ events: AnalyticsMetricEventRow[]; truncated: boolean }> {
  const targetRows = options.maxEvents + 1;
  const events: AnalyticsMetricEventRow[] = [];

  while (events.length < targetRows) {
    const pageLength = Math.min(options.pageSize, targetRows - events.length);
    const { data, error } = await client
      .from('analytics_events')
      .select(METRIC_COLUMNS)
      .eq('business_id', options.businessId)
      .in('event_name', METRIC_EVENTS)
      .gte('occurred_at', options.from)
      .lt('occurred_at', options.to)
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(events.length, events.length + pageLength - 1);
    if (error) throw new AnalyticsMetricsError('analytics_query_failed');
    if (!Array.isArray(data) || data.length === 0) break;
    events.push(...data as unknown as AnalyticsMetricEventRow[]);
    if (data.length < pageLength) break;
  }

  return {
    events: events.slice(0, options.maxEvents),
    truncated: events.length > options.maxEvents,
  };
}

/** @internal Test seam; the Supabase client is not part of the public options. */
export async function loadAnalyticsMetricRows(
  options: AnalyticsMetricsOptions,
  injectedClient?: SupabaseClient,
): Promise<LoadedAnalyticsMetricRows> {
  const normalized = validateAnalyticsMetricsOptions(options);
  try {
    const result = await fetchMetricEvents(injectedClient || getMetricsClient(), normalized);
    return { options: normalized, ...result };
  } catch (error) {
    if (error instanceof AnalyticsMetricsError) throw error;
    throw new AnalyticsMetricsError('analytics_query_failed');
  }
}
