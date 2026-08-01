import { createDemoAnalyticsData } from './analytics-demo-data';
import type {
  AnalyticsDatePreset,
  DashboardAnalyticsData,
  DashboardAnalyticsRequest,
} from './analytics-types';

const PRESET_DAYS: Record<AnalyticsDatePreset, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export function buildAnalyticsDateRange(
  preset: AnalyticsDatePreset,
  now = new Date(),
): Pick<DashboardAnalyticsRequest, 'from' | 'to'> {
  const to = new Date(now);
  if (!Number.isFinite(to.getTime())) throw new Error('Analytics date range is unavailable.');
  const from = new Date(Date.UTC(
    to.getUTCFullYear(),
    to.getUTCMonth(),
    to.getUTCDate() - (PRESET_DAYS[preset] - 1),
  ));
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Phase K demo boundary. Phase J replaces only this function's implementation. */
export async function getDashboardAnalytics(
  request: DashboardAnalyticsRequest,
): Promise<DashboardAnalyticsData> {
  if (!Number.isSafeInteger(request.businessId) || request.businessId <= 0) {
    throw new Error('Analytics are unavailable for the selected business.');
  }
  if (!Number.isFinite(Date.parse(request.from)) || !Number.isFinite(Date.parse(request.to))) {
    throw new Error('Analytics are unavailable for the selected period.');
  }
  await Promise.resolve();
  return createDemoAnalyticsData(request);
}
