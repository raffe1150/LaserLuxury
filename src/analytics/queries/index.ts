import { aggregateAnalyticsMetrics } from './aggregate';
import { loadAnalyticsMetricRows } from './loader';
import type { AnalyticsMetricsOptions, AnalyticsMetricsReport } from './types';

/**
 * Returns tenant-scoped metrics for the explicit half-open UTC window [from, to).
 * Partial results are returned only with `completeness.truncated = true`.
 */
export async function getAnalyticsMetrics(
  options: AnalyticsMetricsOptions,
): Promise<AnalyticsMetricsReport> {
  return aggregateAnalyticsMetrics(await loadAnalyticsMetricRows(options));
}

export type { AnalyticsMetricsOptions, AnalyticsMetricsReport } from './types';
