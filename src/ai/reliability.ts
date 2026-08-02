export type AiFailureCategory =
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK'
  | 'AUTHENTICATION'
  | 'SAFETY_BLOCK'
  | 'MALFORMED_RESPONSE'
  | 'UNKNOWN';

export class AiReliabilityError extends Error {
  constructor(
    public readonly category: AiFailureCategory,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiReliabilityError';
  }
}

export function classifyAiFailure(error: unknown): AiFailureCategory {
  if (error instanceof AiReliabilityError) return error.category;
  const status = Number((error as any)?.status || (error as any)?.code || (error as any)?.response?.status);
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (message.includes('timeout') || message.includes('timed out') || message.includes('abort')) return 'TIMEOUT';
  if (status === 429 || message.includes('429') || message.includes('quota') || message.includes('resource_exhausted')) return 'RATE_LIMIT';
  if (status === 502 || status === 503 || status === 504 || message.includes('unavailable') || message.includes('high demand')) return 'PROVIDER_UNAVAILABLE';
  if (status === 401 || status === 403 || message.includes('api key') || message.includes('unauthorized')) return 'AUTHENTICATION';
  if (message.includes('safety') || message.includes('blocked') || message.includes('prohibited')) return 'SAFETY_BLOCK';
  if (message.includes('network') || message.includes('fetch failed') || message.includes('econnreset') || message.includes('enotfound')) return 'NETWORK';
  return 'UNKNOWN';
}

export function isRetryableAiFailure(category: AiFailureCategory): boolean {
  // A Promise.race timeout cannot prove that the original provider call was
  // cancelled. Do not start a second request while the first may still be live.
  return category === 'RATE_LIMIT' || category === 'PROVIDER_UNAVAILABLE' || category === 'NETWORK';
}

export async function runAiProviderRequest<T>(options: {
  invoke: (attempt: number) => Promise<T>;
  timeoutMs: number;
  retryDelayMs?: number;
  beforeRetry?: (category: AiFailureCategory) => void | Promise<void>;
  onAttemptComplete?: (event: {
    attempt: number;
    durationMs: number;
    ok: boolean;
    category?: AiFailureCategory;
  }) => void;
}): Promise<T> {
  const timeoutMs = Math.max(1, options.timeoutMs);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AiReliabilityError('TIMEOUT', 'AI provider request timed out')),
          timeoutMs,
        );
      });
      const result = await Promise.race([options.invoke(attempt), timeout]);
      options.onAttemptComplete?.({ attempt, durationMs: Date.now() - startedAt, ok: true });
      return result;
    } catch (error) {
      const category = classifyAiFailure(error);
      options.onAttemptComplete?.({ attempt, durationMs: Date.now() - startedAt, ok: false, category });
      if (attempt === 2 || !isRetryableAiFailure(category)) {
        throw error instanceof AiReliabilityError
          ? error
          : new AiReliabilityError(category, `AI provider request failed (${category})`, error);
      }
      await options.beforeRetry?.(category);
      const retryDelayMs = Math.max(0, options.retryDelayMs || 0);
      if (retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new AiReliabilityError('UNKNOWN', 'AI provider request failed');
}

export function containsUnverifiedBookingSuccessClaim(text: string): boolean {
  const value = String(text || '').normalize('NFKC');
  const lower = value.toLowerCase();
  return (
    /\b(?:appointment|booking|slot|time)\b.{0,40}\b(?:booked|confirmed|reserved|created|secured)\b/i.test(lower) ||
    /\b(?:booked|confirmed|reserved|created|secured)\b.{0,40}\b(?:appointment|booking|slot|time)\b/i.test(lower) ||
    /\b(?:din\s+)?(?:tid|bokning)\b.{0,35}\b(?:bokad|bekräftad|reserverad)\b/i.test(lower) ||
    /\b(?:termin|buchung)\b.{0,35}\b(?:gebucht|bestätigt|reserviert)\b/i.test(lower) ||
    /\b(?:cita|reserva)\b.{0,35}\b(?:reservada|confirmada|creada)\b/i.test(lower) ||
    /(?:وقت|نوبت|رزرو).{0,30}(?:رزرو شد|ثبت شد|تأیید شد|قطعی شد)/u.test(value) ||
    /(?:تم\s+(?:حجز|تأكيد)|موعدك.{0,25}(?:محجوز|مؤكد))/u.test(value)
  );
}

export type BookingOperationResult =
  | {
      ok: true;
      bookingId: string | number;
      businessId: string | number;
      serviceName: string;
      startTime: string;
      customerName?: string;
      customerPhone?: string;
      sourceChannel: string;
    }
  | {
      ok: false;
      code:
        | 'VALIDATION_FAILED'
        | 'MISSING_CUSTOMER_DETAILS'
        | 'SLOT_UNAVAILABLE'
        | 'PROVIDER_FAILED'
        | 'PROVIDER_VERIFICATION_FAILED'
        | 'DATABASE_FAILED'
        | 'DATABASE_VERIFICATION_FAILED'
        | 'IDEMPOTENCY_FAILED'
        | 'TIMEOUT'
        | 'UNKNOWN';
    };

export function createBookingOperationResult(input: {
  calendarCreated: boolean;
  calendarVerified: boolean;
  databaseInserted: boolean;
  databaseVerified: boolean;
  settlementRecorded: boolean;
  bookingId?: string | number | null;
  businessId?: string | number | null;
  serviceName?: string | null;
  startTime?: string | null;
  customerName?: string;
  customerPhone?: string;
  sourceChannel?: string | null;
}): BookingOperationResult {
  if (!input.calendarCreated) return { ok: false, code: 'PROVIDER_FAILED' };
  if (!input.calendarVerified) return { ok: false, code: 'PROVIDER_VERIFICATION_FAILED' };
  if (!input.databaseInserted) return { ok: false, code: 'DATABASE_FAILED' };
  if (!input.databaseVerified) return { ok: false, code: 'DATABASE_VERIFICATION_FAILED' };
  if (!input.settlementRecorded) return { ok: false, code: 'IDEMPOTENCY_FAILED' };
  if (
    input.bookingId === null || input.bookingId === undefined ||
    input.businessId === null || input.businessId === undefined ||
    !input.serviceName || !input.startTime || !input.sourceChannel
  ) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  return {
    ok: true,
    bookingId: input.bookingId,
    businessId: input.businessId,
    serviceName: input.serviceName,
    startTime: input.startTime,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    sourceChannel: input.sourceChannel,
  };
}
