import type {
  AnalyticsMetricsOptions,
  NormalizedAnalyticsMetricsOptions,
} from './types';

const MAXIMUM_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const TIMEZONE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export type AnalyticsMetricsErrorCode =
  | 'business_id_required'
  | 'invalid_time_range'
  | 'time_range_too_large'
  | 'invalid_query_limit'
  | 'analytics_query_failed';

/** @internal */
export class AnalyticsMetricsError extends Error {
  readonly code: AnalyticsMetricsErrorCode;

  constructor(code: AnalyticsMetricsErrorCode) {
    super('Analytics metrics query could not be completed.');
    this.name = 'AnalyticsMetricsError';
    this.code = code;
  }
}

function timestamp(value: unknown): { iso: string; milliseconds: number } {
  if (typeof value !== 'string') throw new AnalyticsMetricsError('invalid_time_range');
  const normalized = value.trim();
  const milliseconds = Date.parse(normalized);
  if (!TIMEZONE_ISO.test(normalized) || !Number.isFinite(milliseconds)) {
    throw new AnalyticsMetricsError('invalid_time_range');
  }
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new AnalyticsMetricsError('invalid_query_limit');
  }
  return Number(value);
}

/** @internal */
export function validateAnalyticsMetricsOptions(
  value: AnalyticsMetricsOptions,
): NormalizedAnalyticsMetricsOptions {
  const options = value as AnalyticsMetricsOptions | null | undefined;
  if (!options || !Number.isSafeInteger(options.businessId) || options.businessId <= 0) {
    throw new AnalyticsMetricsError('business_id_required');
  }

  const from = timestamp(options.from);
  const to = timestamp(options.to);
  if (from.milliseconds >= to.milliseconds) {
    throw new AnalyticsMetricsError('invalid_time_range');
  }
  if (to.milliseconds - from.milliseconds > MAXIMUM_WINDOW_MS) {
    throw new AnalyticsMetricsError('time_range_too_large');
  }

  return {
    businessId: options.businessId,
    from: from.iso,
    to: to.iso,
    fromMs: from.milliseconds,
    toMs: to.milliseconds,
    pageSize: boundedInteger(options.pageSize, 500, 1_000),
    maxEvents: boundedInteger(options.maxEvents, 20_000, 50_000),
    maxServices: boundedInteger(options.maxServices, 20, 100),
  };
}
