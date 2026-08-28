export type AnalyticsCoverage = 'complete' | 'partial' | 'unavailable';

export type AnalyticsWindowRequest =
  | { preset: 'today' | 'last_7_days' | 'last_30_days' }
  | { preset: 'custom'; startDate: string; endDate: string };

export type BusinessAnalyticsRequest = {
  businessId: number;
  window: AnalyticsWindowRequest;
  now?: Date;
  pageSize?: number;
  maxEvents?: number;
  maxAppointments?: number;
};

export type AnalyticsRate = number | null;

export type BookingFunnelCounts = {
  bookingStarted: number;
  availabilityRequested: number;
  slotOffered: number;
  slotSelected: number;
  bookingCompleted: number;
  bookingFailed: number;
  bookingAbandoned: number | null;
};

export type BookingRates = {
  bookingConversionRate: AnalyticsRate;
  slotSelectionRate: AnalyticsRate;
  bookingFailureRate: AnalyticsRate;
  noAvailabilityRate: AnalyticsRate;
};

export type BusinessAnalyticsSummary = {
  generatedAt: string;
  scope: {
    businessId: number;
    timezone: string;
    preset: AnalyticsWindowRequest['preset'];
    from: string;
    to: string;
    startDate: string;
    endDate: string;
    semantics: 'business_local_calendar_days_half_open_utc_query';
  };
  dataQuality: {
    status: AnalyticsCoverage;
    events: AnalyticsCoverage;
    authoritativeAppointments: AnalyticsCoverage;
    conversations: AnalyticsCoverage;
    checkedEvents: number;
    checkedAppointments: number;
    eventsTruncated: boolean;
    appointmentsTruncated: boolean;
  };
  conversations: {
    totalConversations: number;
    customerMessages: number;
    activeConversations: number;
    activeConversationDefinition: 'distinct_correlated_conversations_with_customer_message_in_window';
  };
  funnel: BookingFunnelCounts & BookingRates & {
    completionDefinition: 'deduplicated_observed_verified_booking_completion';
    abandonedDefinition: 'unavailable_no_deterministic_policy';
    rateDefinitions: {
      bookingConversionRate: 'booking_completed / booking_started';
      slotSelectionRate: 'slot_selected / slot_offered_event';
      bookingFailureRate: 'booking_failed / booking_started';
      noAvailabilityRate: 'booking_failed_reason_no_availability / availability_requested';
      zeroDenominator: 'null';
    };
  };
  channels: Array<{
    channel: string;
    conversations: number;
    bookingStarted: number;
    bookingCompleted: number;
    conversionRate: AnalyticsRate;
    failures: number;
    noAvailability: number;
  }>;
  services: Array<{
    serviceName: string | null;
    bookingStarted: number;
    availabilityRequests: number;
    bookingCompleted: number;
    conversionRate: AnalyticsRate;
    failures: number;
    unavailableDemand: number;
  }>;
  outcomes: {
    completedBookingsObserved: number;
    failedBookings: number;
    failuresByReason: Array<{ reasonCode: string; count: number }>;
    noAvailability: number;
    abandonedFlows: number | null;
  };
  authoritativeBookings: {
    completedBookingCount: number;
    source: 'appointments_booked_or_completed_by_created_at';
  };
  revenue: {
    definition: 'completed_booking_estimate_from_current_configured_service_prices_not_payment_revenue';
    coverage: AnalyticsCoverage;
    completedBookingCount: number;
    revenueKnownCount: number;
    revenueUnknownCount: number;
    priceCoverageRate: AnalyticsRate;
    estimatedRevenueFromKnownPrices: Array<{ currency: string; amount: number }>;
  };
  daily: Array<{
    date: string;
    conversations: number;
    customerMessages: number;
    bookingStarted: number;
    bookingCompleted: number;
    bookingFailed: number;
  }>;
};

/** @internal */
export type BusinessMetricEventRow = {
  business_id: unknown;
  event_name: unknown;
  occurred_at: unknown;
  conversation_id: unknown;
  booking_id: unknown;
  channel: unknown;
  platform: unknown;
  service_id: unknown;
  service_name_snapshot: unknown;
  outcome: unknown;
  reason_code: unknown;
  idempotency_key: unknown;
};

/** @internal */
export type BusinessMetricAppointmentRow = {
  id: unknown;
  business_id: unknown;
  service: unknown;
  platform: unknown;
  status: unknown;
  created_at: unknown;
};

/** @internal */
export type BusinessMetricService = {
  name: string;
  price: number | null;
  currency: string;
};

/** @internal */
export type ResolvedAnalyticsWindow = BusinessAnalyticsSummary['scope'] & {
  fromMs: number;
  toMs: number;
};

/** @internal */
export type LoadedBusinessAnalyticsRows = {
  scope: ResolvedAnalyticsWindow;
  events: BusinessMetricEventRow[];
  appointments: BusinessMetricAppointmentRow[];
  services: BusinessMetricService[];
  eventsTruncated: boolean;
  appointmentsTruncated: boolean;
};
