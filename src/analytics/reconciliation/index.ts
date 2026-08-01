import { buildAnalyticsReconciliationReport } from './checks';
import { loadReconciliationRows } from './queries';
import type {
  AnalyticsReconciliationOptions,
  AnalyticsReconciliationReport,
} from './types';

const DEFAULT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const DEFAULT_SUSPICIOUS_FUTURE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DELAYED_WARNING_MS = 5 * 60 * 1_000;
const DEFAULT_DELAYED_ERROR_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_METADATA_SIZE_WARNING_BYTES = 8 * 1_024;

function threshold(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Analytics reconciliation options are invalid.');
  }
  return value;
}

/**
 * Runs a bounded, read-only reconciliation. It is intentionally not exported
 * from the analytics recorder's public index and is never scheduled or exposed
 * as an API route by this module.
 */
export async function runAnalyticsReconciliation(
  options: AnalyticsReconciliationOptions,
): Promise<AnalyticsReconciliationReport> {
  const loaded = await loadReconciliationRows(options);
  const futureToleranceMs = threshold(
    options.futureToleranceMs,
    DEFAULT_FUTURE_TOLERANCE_MS,
  );
  const suspiciousFutureMs = threshold(
    options.suspiciousFutureMs,
    DEFAULT_SUSPICIOUS_FUTURE_MS,
  );
  const delayedWarningMs = threshold(
    options.delayedWarningMs,
    DEFAULT_DELAYED_WARNING_MS,
  );
  const delayedErrorMs = threshold(options.delayedErrorMs, DEFAULT_DELAYED_ERROR_MS);
  if (suspiciousFutureMs < futureToleranceMs || delayedErrorMs < delayedWarningMs) {
    throw new Error('Analytics reconciliation options are invalid.');
  }

  return buildAnalyticsReconciliationReport({
    events: loaded.events,
    appointments: loaded.appointments,
    scanTruncated: loaded.scanTruncated,
    issueSampleLimit: loaded.issueSampleLimit,
    scope: {
      businessId: loaded.businessId,
      from: loaded.from,
      to: loaded.to,
      boundarySource: loaded.boundarySource,
    },
    thresholds: {
      futureToleranceMs,
      suspiciousFutureMs,
      delayedWarningMs,
      delayedErrorMs,
      metadataSizeWarningBytes: threshold(
        options.metadataSizeWarningBytes,
        DEFAULT_METADATA_SIZE_WARNING_BYTES,
      ),
    },
  });
}

export type {
  AnalyticsReconciliationOptions,
  AnalyticsReconciliationReport,
} from './types';
