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

async function record(event: RecordableAnalyticsEvent): Promise<void> {
  let safeContext: { business_id?: number; event_name?: string } = {};

  try {
    const validatedEvent = validateAnalyticsEvent(event);
    safeContext = {
      business_id: validatedEvent.business_id,
      event_name: validatedEvent.event_name,
    };
    await insertAnalyticsEvent(validatedEvent);
  } catch (error) {
    console.error('[Analytics] Event recording failed.', {
      ...safeContext,
      ...safeErrorDiagnostic(error),
    });
  }
}

export const analytics = Object.freeze({ record });
