import { aggregateAnalyticsMetrics } from './aggregate';
import { loadAnalyticsMetricRows } from './loader';
import type { AnalyticsMetricsOptions, AnalyticsMetricsReport } from './types';
import { aggregateBusinessAnalytics } from './business-summary';
import { loadBusinessAnalyticsRows, resolveBusinessAnalyticsScope } from './business-loader';
import type { BusinessAnalyticsRequest, BusinessAnalyticsSummary } from './contracts';

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

export async function getBusinessAnalyticsSummary(
  request: BusinessAnalyticsRequest,
): Promise<BusinessAnalyticsSummary> {
  return aggregateBusinessAnalytics(await loadBusinessAnalyticsRows(request));
}

export async function getBusinessAnalyticsScope(
  request: BusinessAnalyticsRequest,
): Promise<BusinessAnalyticsSummary['scope']> {
  return resolveBusinessAnalyticsScope(request);
}

export type {
  AnalyticsCoverage,
  AnalyticsWindowRequest,
  BusinessAnalyticsRequest,
  BusinessAnalyticsSummary,
} from './contracts';
