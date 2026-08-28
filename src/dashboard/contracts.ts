import type { AnalyticsCoverage } from '../analytics/queries/contracts';

export type DashboardMetricQuality = 'available' | 'partial' | 'unavailable';

export type DashboardCountMetric = {
  quality: DashboardMetricQuality;
  value: number | null;
  source: string;
};

export type DashboardEstimatedValueMetric = {
  quality: DashboardMetricQuality;
  amounts: Array<{ currency: string; amount: number }>;
  completedBookingCount: number;
  knownPriceCount: number;
  unknownPriceCount: number;
  priceCoverageRate: number | null;
  definition: 'completed_booking_estimate_from_current_configured_service_prices_not_payment_revenue';
};

export type DashboardOperationalStatus = {
  state: 'operational' | 'attention' | 'unavailable';
  title: string;
  detail: string;
  activeNotificationCount: number | null;
  healthIssueCount: number | null;
  sourceQuality: {
    health: DashboardMetricQuality;
    notifications: DashboardMetricQuality;
  };
};

export type DashboardTodaySummary = {
  generatedAt: string;
  scope: {
    businessId: number;
    timezone: string;
    preset: 'today';
    from: string;
    to: string;
    startDate: string;
    endDate: string;
    semantics: 'business_local_calendar_days_half_open_utc_query';
  };
  dataQuality: {
    overall: AnalyticsCoverage;
    events: AnalyticsCoverage;
    appointments: AnalyticsCoverage;
  };
  conversationsToday: DashboardCountMetric;
  completedBookingsToday: DashboardCountMetric;
  estimatedBookingValue: DashboardEstimatedValueMetric;
  operationalStatus: DashboardOperationalStatus;
};

export type DashboardSummaryState =
  | { status: 'available'; data: DashboardTodaySummary }
  | { status: 'unavailable' };
