export type DashboardAnalyticsPlatform =
  | 'telegram'
  | 'whatsapp'
  | 'messenger'
  | 'instagram';

export type DashboardAnalyticsData = {
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
  summary: {
    messagesReceived: number;
    bookingsCreated: number;
    bookingsRescheduled: number;
    bookingsCancelled: number;
    netBookingActivity: number;
    bookingMessageRatio: number | null;
  };
  platforms: Array<{
    platform: DashboardAnalyticsPlatform;
    messagesReceived: number;
    bookingsCreated: number;
    bookingsRescheduled: number;
    bookingsCancelled: number;
    bookingMessageRatio: number | null;
  }>;
  services: {
    rows: Array<{
      serviceName: string;
      bookingsCreated: number;
      bookingsRescheduled: number;
      bookingsCancelled: number;
    }>;
    unattributed: {
      bookingsCreated: number;
      bookingsRescheduled: number;
      bookingsCancelled: number;
    };
    truncated: boolean;
  };
  daily: Array<{
    date: string;
    messagesReceived: number;
    bookingsCreated: number;
    bookingsRescheduled: number;
    bookingsCancelled: number;
  }>;
};

export type AnalyticsDatePreset = '7d' | '30d' | '90d';

export type DashboardAnalyticsRequest = {
  businessId: number;
  from: string;
  to: string;
};

export type DashboardAnalyticsAdapter = (
  request: DashboardAnalyticsRequest,
) => Promise<DashboardAnalyticsData>;
