import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { RecordableAnalyticsEvent, ValidatedAnalyticsEvent } from './event-types';
import { AnalyticsValidationError, validateAnalyticsEvent } from './validators';

let analyticsClient: SupabaseClient | null = null;

class AnalyticsDatabaseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('Analytics database operation failed.');
    this.name = 'AnalyticsDatabaseError';
    this.code = code;
  }
}

function getAnalyticsClient(): SupabaseClient {
  if (analyticsClient) return analyticsClient;

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Analytics database configuration is unavailable.');
  }

  analyticsClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return analyticsClient;
}

async function insertAnalyticsEvent(event: ValidatedAnalyticsEvent): Promise<void> {
  const { error } = await getAnalyticsClient()
    .from('analytics_events')
    .insert([event]);

  if (error?.code === '23505') return;

  if (error) {
    const code = typeof error.code === 'string' ? error.code : 'unknown';
    throw new AnalyticsDatabaseError(code);
  }
}

export type AnalyticsPersistence = (event: ValidatedAnalyticsEvent) => Promise<void>;

export type AnalyticsRecorder = Readonly<{
  record(event: RecordableAnalyticsEvent): Promise<void>;
}>;

const DEFAULT_PERSISTENCE_TIMEOUT_MS = 1_500;

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AnalyticsDatabaseError('timeout')), timeoutMs);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeErrorDiagnostic(error: unknown): {
  error_class: string;
  error_code?: string;
  reason: string;
} {
  if (error instanceof AnalyticsDatabaseError) {
    const safeCode = /^[A-Z0-9_]{1,16}$/i.test(error.code) ? error.code : 'unknown';
    return {
      error_class: error.name,
      error_code: safeCode,
      reason: 'database_error',
    };
  }

  if (error instanceof AnalyticsValidationError) {
    return {
      error_class: error.name,
      reason: 'validation_error',
    };
  }

  const errorClass = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : 'UnknownError';

  return {
    error_class: errorClass,
    reason: 'unexpected_internal_error',
  };
}

/**
 * Creates a fail-open recorder. Validation, persistence and timeout failures are
 * contained here and are never rethrown into an operational workflow.
 *
 * @internal Exported for focused failure-isolation tests.
 */
export function createAnalyticsRecorder(options: {
  persist?: AnalyticsPersistence;
  timeoutMs?: number;
  reportError?: (message: string, context: Record<string, unknown>) => void;
} = {}): AnalyticsRecorder {
  const persist = options.persist || insertAnalyticsEvent;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERSISTENCE_TIMEOUT_MS;
  const reportError = options.reportError || ((message, context) => console.error(message, context));

  return Object.freeze({
    async record(event: RecordableAnalyticsEvent): Promise<void> {
      let safeContext: { business_id?: number; event_name?: string } = {};
      try {
        const validatedEvent = validateAnalyticsEvent(event);
        safeContext = {
          business_id: validatedEvent.business_id,
          event_name: validatedEvent.event_name,
        };
        await withTimeout(Promise.resolve().then(() => persist(validatedEvent)), timeoutMs);
      } catch (error) {
        reportError('[Analytics] Event recording failed.', {
          ...safeContext,
          ...safeErrorDiagnostic(error),
        });
      }
    },
  });
}

export const analytics = createAnalyticsRecorder();

/** Canonical public boundary used by runtime instrumentation. */
export function recordAnalyticsEvent(event: RecordableAnalyticsEvent): Promise<void> {
  return analytics.record(event);
}
