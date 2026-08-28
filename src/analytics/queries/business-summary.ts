import type {
  AnalyticsCoverage,
  BookingFunnelCounts,
  BusinessAnalyticsSummary,
  BusinessMetricAppointmentRow,
  BusinessMetricEventRow,
  LoadedBusinessAnalyticsRows,
} from './contracts';
import { analyticsLocalDate } from './windows';
import { normalizeAnalyticsChannel } from '../validators';

const COMPLETION_EVENTS = new Set(['booking_completed', 'booking_created']);
const AUTHORITATIVE_STATUSES = new Set(['booked', 'completed']);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveId(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(String(value || '').trim());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function coverage(truncated: boolean): AnalyticsCoverage {
  return truncated ? 'partial' : 'complete';
}

function canonicalChannel(event: BusinessMetricEventRow): string {
  try {
    return normalizeAnalyticsChannel(event.channel, event.platform) || 'unattributed';
  } catch {
    return 'unattributed';
  }
}

function canonicalService(event: BusinessMetricEventRow): string | null {
  return text(event.service_name_snapshot) || text(event.service_id) || null;
}

function servicePriceKey(value: unknown): string {
  const key = text(value).toLocaleLowerCase();
  return /\b(?:consultation|konsultation)\b/u.test(key) ? 'consultation' : key;
}

function deduplicateEvents(
  events: BusinessMetricEventRow[],
  businessId: number,
  fromMs: number,
  toMs: number,
): BusinessMetricEventRow[] {
  const seen = new Set<string>();
  const result: BusinessMetricEventRow[] = [];
  for (const event of events) {
    if (positiveId(event.business_id) !== businessId) continue;
    const occurredAt = Date.parse(text(event.occurred_at));
    if (!Number.isFinite(occurredAt) || occurredAt < fromMs || occurredAt >= toMs) continue;
    const key = text(event.idempotency_key);
    if (key) {
      const tenantKey = `${businessId}:${key}`;
      if (seen.has(tenantKey)) continue;
      seen.add(tenantKey);
    }
    result.push(event);
  }
  return result;
}

function completionKey(event: BusinessMetricEventRow, fallback: number): string {
  const bookingId = positiveId(event.booking_id);
  return bookingId ? `booking:${bookingId}` : `event:${fallback}`;
}

type MutablePerformance = {
  conversations: number;
  bookingStarted: number;
  bookingCompleted: number;
  failures: number;
  noAvailability: number;
};

function performance(): MutablePerformance {
  return { conversations: 0, bookingStarted: 0, bookingCompleted: 0, failures: 0, noAvailability: 0 };
}

type MutableService = {
  bookingStarted: number;
  availabilityRequests: number;
  bookingCompleted: number;
  failures: number;
  unavailableDemand: number;
};

function servicePerformance(): MutableService {
  return { bookingStarted: 0, availabilityRequests: 0, bookingCompleted: 0, failures: 0, unavailableDemand: 0 };
}

function funnelCounts(): BookingFunnelCounts {
  return {
    bookingStarted: 0,
    availabilityRequested: 0,
    slotOffered: 0,
    slotSelected: 0,
    bookingCompleted: 0,
    bookingFailed: 0,
    bookingAbandoned: null,
  };
}

export function aggregateBusinessAnalytics(
  input: LoadedBusinessAnalyticsRows,
): BusinessAnalyticsSummary {
  const configuredPrices = new Map(input.services.map((service) => [
    service.name.trim().toLocaleLowerCase(),
    service,
  ]));
  const canonicalConfiguredPrices = new Map<string, (typeof input.services)[number] | null>();
  for (const service of input.services) {
    const key = servicePriceKey(service.name);
    canonicalConfiguredPrices.set(
      key,
      canonicalConfiguredPrices.has(key) ? null : service,
    );
  }
  const resolvedServiceName = (value: unknown): string | null => {
    const raw = text(value);
    if (!raw) return null;
    const exact = configuredPrices.get(raw.toLocaleLowerCase());
    const canonical = canonicalConfiguredPrices.get(servicePriceKey(raw));
    return (exact || canonical)?.name || raw;
  };
  const events = deduplicateEvents(
    input.events,
    input.scope.businessId,
    input.scope.fromMs,
    input.scope.toMs,
  );
  const funnel = funnelCounts();
  const conversationIds = new Set<string>();
  const channels = new Map<string, MutablePerformance>();
  const services = new Map<string, MutableService>();
  const serviceLabels = new Map<string, string | null>();
  const failureReasons = new Map<string, number>();
  const completionKeys = new Set<string>();
  const completionKeysByChannel = new Map<string, Set<string>>();
  const completionKeysByService = new Map<string, Set<string>>();
  const daily = new Map<string, {
    conversations: number;
    customerMessages: number;
    bookingStarted: number;
    bookingCompleted: number;
    bookingFailed: number;
  }>();
  let totalConversations = 0;
  let customerMessages = 0;
  let messagesWithoutCorrelation = 0;
  let noAvailability = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const eventName = text(event.event_name);
    const channel = canonicalChannel(event);
    const serviceName = resolvedServiceName(canonicalService(event));
    const serviceKey = serviceName ? serviceName.toLocaleLowerCase() : '';
    if (!serviceLabels.has(serviceKey)) serviceLabels.set(serviceKey, serviceName);
    const channelCounts = channels.get(channel) || performance();
    const serviceCounts = services.get(serviceKey) || servicePerformance();
    const dayKey = analyticsLocalDate(event.occurred_at, input.scope.timezone);
    const day = dayKey ? daily.get(dayKey) || {
      conversations: 0, customerMessages: 0, bookingStarted: 0,
      bookingCompleted: 0, bookingFailed: 0,
    } : null;

    if (eventName === 'conversation_started') {
      totalConversations += 1;
      channelCounts.conversations += 1;
      if (day) day.conversations += 1;
    } else if (eventName === 'customer_message_received') {
      customerMessages += 1;
      const conversationId = text(event.conversation_id);
      if (conversationId) conversationIds.add(conversationId);
      else messagesWithoutCorrelation += 1;
      if (day) day.customerMessages += 1;
    } else if (eventName === 'booking_started') {
      funnel.bookingStarted += 1;
      channelCounts.bookingStarted += 1;
      serviceCounts.bookingStarted += 1;
      if (day) day.bookingStarted += 1;
    } else if (eventName === 'availability_requested') {
      funnel.availabilityRequested += 1;
      serviceCounts.availabilityRequests += 1;
    } else if (eventName === 'slot_offered') {
      funnel.slotOffered += 1;
    } else if (eventName === 'slot_selected') {
      funnel.slotSelected += 1;
    } else if (COMPLETION_EVENTS.has(eventName)) {
      const key = completionKey(event, index);
      if (!completionKeys.has(key)) {
        completionKeys.add(key);
        funnel.bookingCompleted += 1;
        channelCounts.bookingCompleted += 1;
        serviceCounts.bookingCompleted += 1;
        const channelSet = completionKeysByChannel.get(channel) || new Set<string>();
        channelSet.add(key);
        completionKeysByChannel.set(channel, channelSet);
        const serviceSet = completionKeysByService.get(serviceKey) || new Set<string>();
        serviceSet.add(key);
        completionKeysByService.set(serviceKey, serviceSet);
        if (day) day.bookingCompleted += 1;
      }
    } else if (eventName === 'booking_failed') {
      funnel.bookingFailed += 1;
      channelCounts.failures += 1;
      serviceCounts.failures += 1;
      const reason = text(event.reason_code) || 'unspecified';
      failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
      if (reason === 'no_availability') {
        noAvailability += 1;
        channelCounts.noAvailability += 1;
        serviceCounts.unavailableDemand += 1;
      }
      if (day) day.bookingFailed += 1;
    }

    channels.set(channel, channelCounts);
    if (
      serviceCounts.bookingStarted > 0
      || serviceCounts.availabilityRequests > 0
      || serviceCounts.bookingCompleted > 0
      || serviceCounts.failures > 0
      || serviceCounts.unavailableDemand > 0
    ) services.set(serviceKey, serviceCounts);
    if (day && dayKey) daily.set(dayKey, day);
  }

  const authoritativeAppointments = new Map<number, BusinessMetricAppointmentRow>();
  for (const appointment of input.appointments) {
    if (positiveId(appointment.business_id) !== input.scope.businessId) continue;
    const id = positiveId(appointment.id);
    const createdAt = Date.parse(text(appointment.created_at));
    if (
      !id
      || !Number.isFinite(createdAt)
      || createdAt < input.scope.fromMs
      || createdAt >= input.scope.toMs
      || !AUTHORITATIVE_STATUSES.has(text(appointment.status).toLowerCase())
    ) continue;
    authoritativeAppointments.set(id, appointment);
  }

  const revenueByCurrency = new Map<string, number>();
  let revenueKnownCount = 0;
  let revenueUnknownCount = 0;
  for (const appointment of authoritativeAppointments.values()) {
    const exactKey = text(appointment.service).toLocaleLowerCase();
    const configured = configuredPrices.get(exactKey)
      || canonicalConfiguredPrices.get(servicePriceKey(appointment.service));
    if (!configured || configured.price === null || !Number.isFinite(configured.price) || configured.price < 0) {
      revenueUnknownCount += 1;
      continue;
    }
    revenueKnownCount += 1;
    revenueByCurrency.set(
      configured.currency,
      (revenueByCurrency.get(configured.currency) || 0) + configured.price,
    );
  }
  const completedBookingCount = authoritativeAppointments.size;
  const revenueCoverage: AnalyticsCoverage = completedBookingCount > 0 && revenueKnownCount === 0
    ? 'unavailable'
    : revenueUnknownCount > 0
      ? 'partial'
      : 'complete';
  const eventCoverage = coverage(input.eventsTruncated);
  const appointmentCoverage = coverage(input.appointmentsTruncated);
  const conversationCoverage: AnalyticsCoverage = messagesWithoutCorrelation > 0 ? 'partial' : eventCoverage;
  const overallCoverage: AnalyticsCoverage = [eventCoverage, appointmentCoverage, conversationCoverage].includes('partial')
    ? 'partial'
    : 'complete';

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      businessId: input.scope.businessId,
      timezone: input.scope.timezone,
      preset: input.scope.preset,
      from: input.scope.from,
      to: input.scope.to,
      startDate: input.scope.startDate,
      endDate: input.scope.endDate,
      semantics: input.scope.semantics,
    },
    dataQuality: {
      status: overallCoverage,
      events: eventCoverage,
      authoritativeAppointments: appointmentCoverage,
      conversations: conversationCoverage,
      checkedEvents: input.events.length,
      checkedAppointments: input.appointments.length,
      eventsTruncated: input.eventsTruncated,
      appointmentsTruncated: input.appointmentsTruncated,
    },
    conversations: {
      totalConversations,
      customerMessages,
      activeConversations: conversationIds.size,
      activeConversationDefinition: 'distinct_correlated_conversations_with_customer_message_in_window',
    },
    funnel: {
      ...funnel,
      bookingConversionRate: rate(funnel.bookingCompleted, funnel.bookingStarted),
      slotSelectionRate: rate(funnel.slotSelected, funnel.slotOffered),
      bookingFailureRate: rate(funnel.bookingFailed, funnel.bookingStarted),
      noAvailabilityRate: rate(noAvailability, funnel.availabilityRequested),
      completionDefinition: 'deduplicated_observed_verified_booking_completion',
      abandonedDefinition: 'unavailable_no_deterministic_policy',
      rateDefinitions: {
        bookingConversionRate: 'booking_completed / booking_started',
        slotSelectionRate: 'slot_selected / slot_offered_event',
        bookingFailureRate: 'booking_failed / booking_started',
        noAvailabilityRate: 'booking_failed_reason_no_availability / availability_requested',
        zeroDenominator: 'null',
      },
    },
    channels: Array.from(channels, ([channel, count]) => ({
      channel,
      conversations: count.conversations,
      bookingStarted: count.bookingStarted,
      bookingCompleted: completionKeysByChannel.get(channel)?.size || count.bookingCompleted,
      conversionRate: rate(completionKeysByChannel.get(channel)?.size || count.bookingCompleted, count.bookingStarted),
      failures: count.failures,
      noAvailability: count.noAvailability,
    })).sort((a, b) => a.channel.localeCompare(b.channel)),
    services: Array.from(services, ([key, count]) => ({
      serviceName: serviceLabels.get(key) || null,
      bookingStarted: count.bookingStarted,
      availabilityRequests: count.availabilityRequests,
      bookingCompleted: completionKeysByService.get(key)?.size || count.bookingCompleted,
      conversionRate: rate(completionKeysByService.get(key)?.size || count.bookingCompleted, count.bookingStarted),
      failures: count.failures,
      unavailableDemand: count.unavailableDemand,
    })).sort((a, b) => (b.bookingStarted + b.availabilityRequests) - (a.bookingStarted + a.availabilityRequests)
      || String(a.serviceName).localeCompare(String(b.serviceName))),
    outcomes: {
      completedBookingsObserved: funnel.bookingCompleted,
      failedBookings: funnel.bookingFailed,
      failuresByReason: Array.from(failureReasons, ([reasonCode, count]) => ({ reasonCode, count }))
        .sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode)),
      noAvailability,
      abandonedFlows: null,
    },
    authoritativeBookings: {
      completedBookingCount,
      source: 'appointments_booked_or_completed_by_created_at',
    },
    revenue: {
      definition: 'completed_booking_estimate_from_current_configured_service_prices_not_payment_revenue',
      coverage: revenueCoverage,
      completedBookingCount,
      revenueKnownCount,
      revenueUnknownCount,
      priceCoverageRate: rate(revenueKnownCount, completedBookingCount),
      estimatedRevenueFromKnownPrices: Array.from(revenueByCurrency, ([currency, amount]) => ({ currency, amount }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    },
    daily: Array.from(daily, ([date, count]) => ({ date, ...count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}
