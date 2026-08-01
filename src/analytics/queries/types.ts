export type CanonicalAnalyticsPlatform =
  | 'telegram'
  | 'whatsapp'
  | 'messenger'
  | 'instagram';

export type AnalyticsMetricsOptions = {
  businessId: number;
  from: string;
  to: string;
  pageSize?: number;
  maxEvents?: number;
  maxServices?: number;
};

type ActivityCounts = {
  messagesReceived: number;
  bookingsCreated: number;
  bookingsRescheduled: number;
  bookingsCancelled: number;
};

type BookingCounts = Omit<ActivityCounts, 'messagesReceived'>;

export type AnalyticsMetricsReport = {
  generatedAt: string;
  scope: {
    businessId: number;
    from: string;
    to: string;
    timezone: 'UTC';
  };
  completeness: {
    truncated: boolean;
    checkedEvents: number;
    maxEvents: number;
  };
  summary: ActivityCounts & {
    /** Booking activity, not the current active appointment count. */
    netBookingActivity: number;
    /** Activity ratio only; events are not correlated by customer. */
    bookingMessageRatio: number | null;
  };
  platforms: Array<ActivityCounts & {
    platform: CanonicalAnalyticsPlatform;
    bookingMessageRatio: number | null;
  }>;
  services: {
    rows: Array<BookingCounts & { serviceName: string }>;
    unattributed: BookingCounts;
    truncated: boolean;
  };
  daily: Array<ActivityCounts & { date: string }>;
};

/** @internal */
export type AnalyticsMetricEventRow = {
  event_name: unknown;
  occurred_at: unknown;
  platform: unknown;
  service_name_snapshot: unknown;
};

/** @internal */
export type NormalizedAnalyticsMetricsOptions = {
  businessId: number;
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
  pageSize: number;
  maxEvents: number;
  maxServices: number;
};

/** @internal */
export type LoadedAnalyticsMetricRows = {
  options: NormalizedAnalyticsMetricsOptions;
  events: AnalyticsMetricEventRow[];
  truncated: boolean;
};
