import express, { type RequestHandler } from 'express';
import {
  getBusinessAnalyticsScope,
  getBusinessAnalyticsSummary,
  type AnalyticsWindowRequest,
  type BusinessAnalyticsRequest,
  type BusinessAnalyticsSummary,
} from './queries';
import { AnalyticsMetricsError } from './queries/validation';
import {
  runAnalyticsReconciliation,
  type AnalyticsReconciliationOptions,
  type AnalyticsReconciliationReport,
} from './reconciliation';
import { AnalyticsReconciliationError } from './reconciliation/queries';
import type { AuthenticatedRequest } from '../auth/types';
import type { AnalyticsReconciliationStatus } from './api-contracts';

type SummaryLoader = (request: BusinessAnalyticsRequest) => Promise<BusinessAnalyticsSummary>;
type ScopeLoader = (request: BusinessAnalyticsRequest) => Promise<{ from: string; to: string }>;
type ReconciliationLoader = (
  request: AnalyticsReconciliationOptions,
) => Promise<AnalyticsReconciliationReport>;

export type AnalyticsApiRouterDependencies = {
  requireAuth: RequestHandler;
  requireAnalyticsPermission: RequestHandler;
  loadSummary?: SummaryLoader;
  loadScope?: ScopeLoader;
  loadReconciliation?: ReconciliationLoader;
  onFailure?: (
    category: string,
    businessId: number | null,
    request: express.Request,
  ) => void;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_QUERY_KEYS = new Set(['window', 'startDate', 'endDate']);

export class AnalyticsApiRequestError extends Error {
  constructor() {
    super('Invalid analytics request.');
    this.name = 'AnalyticsApiRequestError';
  }
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Strictly parses the public query shape; calendar semantics remain centralized in Phase 2. */
export function parseAnalyticsWindowQuery(query: Record<string, unknown>): AnalyticsWindowRequest {
  if (Object.keys(query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    throw new AnalyticsApiRequestError();
  }
  const preset = singleQueryValue(query.window);
  if (preset === 'today' || preset === 'last_7_days' || preset === 'last_30_days') {
    if (query.startDate !== undefined || query.endDate !== undefined) {
      throw new AnalyticsApiRequestError();
    }
    return { preset };
  }
  if (preset !== 'custom') throw new AnalyticsApiRequestError();
  const startDate = singleQueryValue(query.startDate);
  const endDate = singleQueryValue(query.endDate);
  if (!startDate || !endDate || !DATE.test(startDate) || !DATE.test(endDate)) {
    throw new AnalyticsApiRequestError();
  }
  return { preset, startDate, endDate };
}

function safeReconciliationStatus(
  report: AnalyticsReconciliationReport,
): AnalyticsReconciliationStatus {
  const { issues: _privateIssueSamples, ...status } = report;
  return status;
}

function businessId(request: express.Request): number | null {
  const value = (request as AuthenticatedRequest).businessAccess?.businessId;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeFailure(
  response: express.Response,
  error: unknown,
): express.Response {
  if (error instanceof AnalyticsApiRequestError) {
    return response.status(400).json({ error: 'invalid_analytics_request' });
  }
  if (error instanceof AnalyticsMetricsError) {
    if (error.code === 'invalid_time_range' || error.code === 'time_range_too_large') {
      return response.status(400).json({ error: error.code });
    }
    return response.status(503).json({ error: 'analytics_unavailable' });
  }
  if (error instanceof AnalyticsReconciliationError) {
    if (error.code === 'invalid_options' || error.code === 'boundary_required') {
      return response.status(400).json({ error: 'invalid_analytics_request' });
    }
    return response.status(503).json({ error: 'analytics_reconciliation_unavailable' });
  }
  return response.status(500).json({ error: 'analytics_unavailable' });
}

export function createAnalyticsApiRouter(
  dependencies: AnalyticsApiRouterDependencies,
): express.Router {
  const router = express.Router();
  const loadSummary = dependencies.loadSummary || getBusinessAnalyticsSummary;
  const loadScope = dependencies.loadScope || getBusinessAnalyticsScope;
  const loadReconciliation = dependencies.loadReconciliation || runAnalyticsReconciliation;
  const protectedRoute = [dependencies.requireAuth, dependencies.requireAnalyticsPermission];

  router.get('/:businessId/analytics/summary', ...protectedRoute, async (request, response) => {
    const authorizedBusinessId = businessId(request);
    try {
      if (!authorizedBusinessId) throw new Error('missing_authorized_business_scope');
      const window = parseAnalyticsWindowQuery(request.query as Record<string, unknown>);
      return response.json(await loadSummary({ businessId: authorizedBusinessId, window }));
    } catch (error) {
      dependencies.onFailure?.('analytics_summary_failed', authorizedBusinessId, request);
      return safeFailure(response, error);
    }
  });

  router.get('/:businessId/analytics/reconciliation', ...protectedRoute, async (request, response) => {
    const authorizedBusinessId = businessId(request);
    try {
      if (!authorizedBusinessId) throw new Error('missing_authorized_business_scope');
      const window = parseAnalyticsWindowQuery(request.query as Record<string, unknown>);
      const scope = await loadScope({ businessId: authorizedBusinessId, window });
      const report = await loadReconciliation({
        businessId: authorizedBusinessId,
        from: scope.from,
        to: scope.to,
      });
      return response.json(safeReconciliationStatus(report));
    } catch (error) {
      dependencies.onFailure?.('analytics_reconciliation_failed', authorizedBusinessId, request);
      return safeFailure(response, error);
    }
  });

  return router;
}
