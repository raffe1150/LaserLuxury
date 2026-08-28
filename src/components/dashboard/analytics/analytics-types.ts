import type {
  BusinessAnalyticsApiRequest,
  BusinessAnalyticsApiResponse,
} from '../../../analytics/api-contracts';

export type DashboardAnalyticsData = BusinessAnalyticsApiResponse;

export type AnalyticsDatePreset = 'today' | '7d' | '30d' | 'custom';

export type DashboardAnalyticsRequest = {
  businessId: string;
  window: BusinessAnalyticsApiRequest;
};

export type DashboardAnalyticsAdapter = (
  request: DashboardAnalyticsRequest,
  signal?: AbortSignal,
) => Promise<DashboardAnalyticsData>;
