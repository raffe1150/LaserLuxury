import type {
  AnalyticsMetricsReport,
  CanonicalAnalyticsPlatform,
  LoadedAnalyticsMetricRows,
} from './types';

const PLATFORMS: readonly CanonicalAnalyticsPlatform[] = [
  'telegram',
  'whatsapp',
  'messenger',
  'instagram',
];

type ActivityCounts = {
  messagesReceived: number;
  bookingsCreated: number;
  bookingsRescheduled: number;
  bookingsCancelled: number;
};

type BookingCounts = Omit<ActivityCounts, 'messagesReceived'>;

function activityCounts(): ActivityCounts {
  return { messagesReceived: 0, bookingsCreated: 0, bookingsRescheduled: 0, bookingsCancelled: 0 };
}

function bookingCounts(): BookingCounts {
  return { bookingsCreated: 0, bookingsRescheduled: 0, bookingsCancelled: 0 };
}

function ratio(counts: ActivityCounts): number | null {
  return counts.messagesReceived === 0
    ? null
    : counts.bookingsCreated / counts.messagesReceived;
}

function addEvent(counts: ActivityCounts, eventName: unknown): void {
  if (eventName === 'customer_message_received') counts.messagesReceived += 1;
  else if (eventName === 'booking_created') counts.bookingsCreated += 1;
  else if (eventName === 'booking_rescheduled') counts.bookingsRescheduled += 1;
  else if (eventName === 'booking_cancelled') counts.bookingsCancelled += 1;
}

function addBookingEvent(counts: BookingCounts, eventName: unknown): void {
  if (eventName === 'booking_created') counts.bookingsCreated += 1;
  else if (eventName === 'booking_rescheduled') counts.bookingsRescheduled += 1;
  else if (eventName === 'booking_cancelled') counts.bookingsCancelled += 1;
}

function isBookingEvent(eventName: unknown): boolean {
  return eventName === 'booking_created'
    || eventName === 'booking_rescheduled'
    || eventName === 'booking_cancelled';
}

function utcDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString().slice(0, 10)
    : null;
}

function continuousUtcDays(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  const cursor = new Date(fromMs);
  cursor.setUTCHours(0, 0, 0, 0);
  const finalDay = new Date(toMs - 1);
  finalDay.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= finalDay.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** @internal */
export function aggregateAnalyticsMetrics(
  input: LoadedAnalyticsMetricRows,
): AnalyticsMetricsReport {
  const summary = activityCounts();
  const platformCounts = new Map(PLATFORMS.map((platform) => [platform, activityCounts()]));
  const serviceCounts = new Map<string, BookingCounts>();
  const unattributed = bookingCounts();
  const dailyCounts = new Map(continuousUtcDays(input.options.fromMs, input.options.toMs)
    .map((date) => [date, activityCounts()]));

  for (const event of input.events) {
    addEvent(summary, event.event_name);

    if (typeof event.platform === 'string') {
      const platform = event.platform.trim() as CanonicalAnalyticsPlatform;
      const counts = platformCounts.get(platform);
      if (counts) addEvent(counts, event.event_name);
    }

    const date = utcDate(event.occurred_at);
    const day = date ? dailyCounts.get(date) : undefined;
    if (day) addEvent(day, event.event_name);

    if (!isBookingEvent(event.event_name)) continue;
    const serviceName = typeof event.service_name_snapshot === 'string'
      ? event.service_name_snapshot.trim()
      : '';
    if (!serviceName) addBookingEvent(unattributed, event.event_name);
    else {
      const counts = serviceCounts.get(serviceName) || bookingCounts();
      addBookingEvent(counts, event.event_name);
      serviceCounts.set(serviceName, counts);
    }
  }

  const allServices = Array.from(serviceCounts, ([serviceName, counts]) => ({ serviceName, ...counts }))
    .sort((a, b) => b.bookingsCreated - a.bookingsCreated
      || (b.bookingsCreated + b.bookingsRescheduled + b.bookingsCancelled)
        - (a.bookingsCreated + a.bookingsRescheduled + a.bookingsCancelled)
      || a.serviceName.localeCompare(b.serviceName));

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      businessId: input.options.businessId,
      from: input.options.from,
      to: input.options.to,
      timezone: 'UTC',
    },
    completeness: {
      truncated: input.truncated,
      checkedEvents: input.events.length,
      maxEvents: input.options.maxEvents,
    },
    summary: {
      ...summary,
      netBookingActivity: summary.bookingsCreated - summary.bookingsCancelled,
      bookingMessageRatio: ratio(summary),
    },
    platforms: PLATFORMS.map((platform) => ({
      platform,
      ...platformCounts.get(platform)!,
      bookingMessageRatio: ratio(platformCounts.get(platform)!),
    })),
    services: {
      rows: allServices.slice(0, input.options.maxServices),
      unattributed,
      truncated: allServices.length > input.options.maxServices,
    },
    daily: Array.from(dailyCounts, ([date, counts]) => ({ date, ...counts })),
  };
}
