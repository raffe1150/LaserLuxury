import type {
  DashboardAnalyticsData,
  DashboardAnalyticsPlatform,
  DashboardAnalyticsRequest,
} from './analytics-types';

const PLATFORMS: readonly DashboardAnalyticsPlatform[] = [
  'telegram',
  'whatsapp',
  'messenger',
  'instagram',
];

function daysInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const finalDay = new Date(Date.parse(to) - 1);
  finalDay.setUTCHours(0, 0, 0, 0);
  while (cursor <= finalDay) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function distribute(total: number, weights: readonly number[]): number[] {
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let assigned = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return total - assigned;
    const value = Math.floor((total * weight) / weightTotal);
    assigned += value;
    return value;
  });
}

/** Development-only fixture. Replace the adapter, not this shape, for Phase J. */
export function createDemoAnalyticsData(
  request: DashboardAnalyticsRequest,
): DashboardAnalyticsData {
  const dates = daysInRange(request.from, request.to);
  const zeroIndex = Math.max(0, dates.length - 2);
  const daily = dates.map((date, index) => {
    const zeroDay = index === zeroIndex;
    return {
      date,
      messagesReceived: zeroDay ? 0 : 9 + ((index * 3) % 8),
      bookingsCreated: zeroDay ? 0 : 2 + (index % 3),
      bookingsRescheduled: zeroDay ? 0 : index % 2,
      bookingsCancelled: zeroDay ? 0 : index % 4 === 0 ? 1 : 0,
    };
  });

  const totals = daily.reduce((sum, day) => ({
    messagesReceived: sum.messagesReceived + day.messagesReceived,
    bookingsCreated: sum.bookingsCreated + day.bookingsCreated,
    bookingsRescheduled: sum.bookingsRescheduled + day.bookingsRescheduled,
    bookingsCancelled: sum.bookingsCancelled + day.bookingsCancelled,
  }), {
    messagesReceived: 0,
    bookingsCreated: 0,
    bookingsRescheduled: 0,
    bookingsCancelled: 0,
  });

  const platformWeights = [5, 3, 2, 2];
  const platformMessages = distribute(totals.messagesReceived, platformWeights);
  const platformCreated = distribute(totals.bookingsCreated, platformWeights);
  const platformRescheduled = distribute(totals.bookingsRescheduled, platformWeights);
  const platformCancelled = distribute(totals.bookingsCancelled, platformWeights);
  const platforms = PLATFORMS.map((platform, index) => ({
    platform,
    messagesReceived: platformMessages[index],
    bookingsCreated: platformCreated[index],
    bookingsRescheduled: platformRescheduled[index],
    bookingsCancelled: platformCancelled[index],
    bookingMessageRatio: platformMessages[index] === 0
      ? null
      : platformCreated[index] / platformMessages[index],
  }));

  const serviceWeights = [5, 3, 2, 1];
  const serviceCreated = distribute(totals.bookingsCreated, serviceWeights);
  const serviceRescheduled = distribute(totals.bookingsRescheduled, serviceWeights);
  const serviceCancelled = distribute(totals.bookingsCancelled, serviceWeights);
  const serviceNames = ['Consultation', 'Signature treatment', 'Follow-up'];
  const services = serviceNames.map((serviceName, index) => ({
    serviceName,
    bookingsCreated: serviceCreated[index],
    bookingsRescheduled: serviceRescheduled[index],
    bookingsCancelled: serviceCancelled[index],
  })).sort((a, b) => b.bookingsCreated - a.bookingsCreated
    || (b.bookingsCreated + b.bookingsRescheduled + b.bookingsCancelled)
      - (a.bookingsCreated + a.bookingsRescheduled + a.bookingsCancelled)
    || a.serviceName.localeCompare(b.serviceName));

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      businessId: request.businessId,
      from: request.from,
      to: request.to,
      timezone: 'UTC',
    },
    completeness: {
      truncated: false,
      checkedEvents: totals.messagesReceived
        + totals.bookingsCreated
        + totals.bookingsRescheduled
        + totals.bookingsCancelled,
      maxEvents: 20_000,
    },
    summary: {
      ...totals,
      netBookingActivity: totals.bookingsCreated - totals.bookingsCancelled,
      bookingMessageRatio: totals.messagesReceived === 0
        ? null
        : totals.bookingsCreated / totals.messagesReceived,
    },
    platforms,
    services: {
      rows: services,
      unattributed: {
        bookingsCreated: serviceCreated[3],
        bookingsRescheduled: serviceRescheduled[3],
        bookingsCancelled: serviceCancelled[3],
      },
      truncated: false,
    },
    daily,
  };
}
