import { api } from '../../../services/api';
import type {
  AnalyticsDatePreset,
  DashboardAnalyticsAdapter,
  DashboardAnalyticsRequest,
} from './analytics-types';

export function analyticsWindowForSelection(
  preset: AnalyticsDatePreset,
  customStartDate = '',
  customEndDate = '',
): DashboardAnalyticsRequest['window'] | null {
  if (preset === 'today') return { preset: 'today' };
  if (preset === '7d') return { preset: 'last_7_days' };
  if (preset === '30d') return { preset: 'last_30_days' };
  if (!customStartDate || !customEndDate) return null;
  return { preset: 'custom', startDate: customStartDate, endDate: customEndDate };
}

export function analyticsRequestKey(request: DashboardAnalyticsRequest): string {
  const { window } = request;
  return window.preset === 'custom'
    ? `${request.businessId}:custom:${window.startDate}:${window.endDate}`
    : `${request.businessId}:${window.preset}`;
}

export function createAnalyticsRequestGuard() {
  let latest = 0;
  return {
    begin() {
      const identity = ++latest;
      return { isCurrent: () => identity === latest };
    },
    invalidate() {
      latest += 1;
    },
  };
}

export const getDashboardAnalytics: DashboardAnalyticsAdapter = (request, signal) =>
  api.getBusinessAnalyticsSummary(request.businessId, request.window, signal);
