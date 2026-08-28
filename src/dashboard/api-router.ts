import express, { type RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../auth/types';
import {
  getBusinessAnalyticsSummary,
  type BusinessAnalyticsRequest,
  type BusinessAnalyticsSummary,
} from '../analytics/queries';
import type { DashboardOperationalSources } from './summary';
import { buildDashboardTodaySummary } from './summary';

type SummaryLoader = (request: BusinessAnalyticsRequest) => Promise<BusinessAnalyticsSummary>;

export type DashboardSummaryRouterDependencies = {
  requireAuth: RequestHandler;
  requireAnalyticsPermission: RequestHandler;
  loadAnalyticsSummary?: SummaryLoader;
  loadOperationalSources: (businessId: number) => Promise<DashboardOperationalSources>;
  onFailure?: (category: string, businessId: number | null, request: express.Request) => void;
};

function authorizedBusinessId(request: express.Request): number | null {
  const value = (request as AuthenticatedRequest).businessAccess?.businessId;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function createDashboardSummaryRouter(
  dependencies: DashboardSummaryRouterDependencies,
): express.Router {
  const router = express.Router();
  const loadAnalyticsSummary = dependencies.loadAnalyticsSummary || getBusinessAnalyticsSummary;

  router.get(
    '/:businessId/dashboard/summary',
    dependencies.requireAuth,
    dependencies.requireAnalyticsPermission,
    async (request, response) => {
      const businessId = authorizedBusinessId(request);
      try {
        if (!businessId) throw new Error('missing_authorized_business_scope');
        const analytics = await loadAnalyticsSummary({ businessId, window: { preset: 'today' } });
        const operational = await dependencies.loadOperationalSources(businessId);
        response.setHeader('Cache-Control', 'no-store');
        return response.status(200).json(buildDashboardTodaySummary(analytics, operational));
      } catch (error) {
        dependencies.onFailure?.('dashboard_summary_failed', businessId, request);
        return response.status(503).json({ error: 'dashboard_summary_unavailable' });
      }
    },
  );

  return router;
}
