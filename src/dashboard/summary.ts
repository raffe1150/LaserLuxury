import type { BusinessAnalyticsSummary } from '../analytics/queries/contracts';
import type { IntegrationHealth } from '../types/dashboard';
import type {
  DashboardMetricQuality,
  DashboardOperationalStatus,
  DashboardTodaySummary,
} from './contracts';

export type DashboardOperationalSources = {
  health: IntegrationHealth[] | null;
  activeNotificationCount: number | null;
};

function metricQuality(coverage: 'complete' | 'partial' | 'unavailable'): DashboardMetricQuality {
  if (coverage === 'complete') return 'available';
  return coverage;
}

export function resolveDashboardOperationalStatus(
  sources: DashboardOperationalSources,
): DashboardOperationalStatus {
  const healthQuality: DashboardMetricQuality = sources.health ? 'available' : 'unavailable';
  const notificationQuality: DashboardMetricQuality = sources.activeNotificationCount === null
    ? 'unavailable'
    : 'available';
  const activeNotificationCount = sources.activeNotificationCount;

  if (activeNotificationCount !== null && activeNotificationCount > 0) {
    return {
      state: 'attention',
      title: `${activeNotificationCount} ${activeNotificationCount === 1 ? 'issue needs' : 'issues need'} attention`,
      detail: 'Review active notifications for the selected business.',
      activeNotificationCount,
      healthIssueCount: sources.health
        ? sources.health.filter((item) => ['degraded', 'disconnected', 'error'].includes(item.status)).length
        : null,
      sourceQuality: { health: healthQuality, notifications: notificationQuality },
    };
  }

  if (!sources.health || activeNotificationCount === null) {
    return {
      state: 'unavailable',
      title: 'Status unavailable',
      detail: 'Current health and notification status could not both be verified.',
      activeNotificationCount,
      healthIssueCount: null,
      sourceQuality: { health: healthQuality, notifications: notificationQuality },
    };
  }

  const configured = sources.health.filter((item) => item.status !== 'setup_required');
  const healthIssues = configured.filter((item) =>
    ['degraded', 'disconnected', 'error'].includes(item.status),
  );
  if (healthIssues.length > 0) {
    return {
      state: 'attention',
      title: `${healthIssues.length} ${healthIssues.length === 1 ? 'connection needs' : 'connections need'} attention`,
      detail: 'Review integration health for the selected business.',
      activeNotificationCount,
      healthIssueCount: healthIssues.length,
      sourceQuality: { health: healthQuality, notifications: notificationQuality },
    };
  }

  const allVerified = configured.length > 0 && configured.every((item) =>
    ['connected', 'synced'].includes(item.status)
      && item.reasonCode === 'verified'
      && item.stale !== true,
  );
  if (allVerified) {
    return {
      state: 'operational',
      title: 'All connected systems operational',
      detail: 'Current integration checks are verified and there are no active notifications.',
      activeNotificationCount,
      healthIssueCount: 0,
      sourceQuality: { health: healthQuality, notifications: notificationQuality },
    };
  }

  return {
    state: 'unavailable',
    title: 'Status unavailable',
    detail: configured.length === 0
      ? 'No configured integration has a current verified health state.'
      : 'One or more configured integrations are awaiting a current verification.',
    activeNotificationCount,
    healthIssueCount: 0,
    sourceQuality: { health: healthQuality, notifications: notificationQuality },
  };
}

export function buildDashboardTodaySummary(
  analytics: BusinessAnalyticsSummary,
  operationalSources: DashboardOperationalSources,
): DashboardTodaySummary {
  if (analytics.scope.preset !== 'today') {
    throw new Error('dashboard_summary_requires_today_scope');
  }

  return {
    generatedAt: analytics.generatedAt,
    scope: {
      ...analytics.scope,
      preset: 'today',
    },
    dataQuality: {
      overall: analytics.dataQuality.status,
      events: analytics.dataQuality.events,
      appointments: analytics.dataQuality.authoritativeAppointments,
    },
    conversationsToday: {
      quality: metricQuality(analytics.dataQuality.conversations),
      value: analytics.conversations.activeConversations,
      source: 'distinct analytics_events.customer_message_received conversation_id values within the canonical business-local today window',
    },
    completedBookingsToday: {
      quality: metricQuality(analytics.dataQuality.authoritativeAppointments),
      value: analytics.authoritativeBookings.completedBookingCount,
      source: analytics.authoritativeBookings.source,
    },
    estimatedBookingValue: {
      quality: metricQuality(analytics.revenue.coverage),
      amounts: analytics.revenue.estimatedRevenueFromKnownPrices,
      completedBookingCount: analytics.revenue.completedBookingCount,
      knownPriceCount: analytics.revenue.revenueKnownCount,
      unknownPriceCount: analytics.revenue.revenueUnknownCount,
      priceCoverageRate: analytics.revenue.priceCoverageRate,
      definition: analytics.revenue.definition,
    },
    operationalStatus: resolveDashboardOperationalStatus(operationalSources),
  };
}
