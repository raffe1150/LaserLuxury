import type { AnalyticsWindowRequest, BusinessAnalyticsSummary } from './queries';
import type { AnalyticsReconciliationReport } from './reconciliation';

export type BusinessAnalyticsApiRequest = AnalyticsWindowRequest;

export type BusinessAnalyticsApiResponse = BusinessAnalyticsSummary;

export type AnalyticsReconciliationStatus = Omit<AnalyticsReconciliationReport, 'issues'>;

