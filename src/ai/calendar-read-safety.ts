export class CalendarReadFailure extends Error {
  readonly code = "CALENDAR_READ_FAILURE";

  constructor(
    message: string,
    readonly causeCategory: "timeout" | "provider" | "malformed" = "provider",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CalendarReadFailure";
  }
}
function positiveTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return 15_000;
  return Math.min(60_000, Math.max(250, Number(value)));
}

/**
 * Calendar availability is safety-critical: an unsuccessful or malformed read
 * must never be converted into an empty event list.
 */
export async function readCalendarEventsStrict<T = unknown>(params: {
  read: () => Promise<unknown> | unknown;
  timeoutMs?: number;
}): Promise<T[]> {
  const timeoutMs = positiveTimeout(params.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const value = await Promise.race([
      Promise.resolve().then(params.read),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new CalendarReadFailure("Calendar read timed out", "timeout")),
          timeoutMs,
        );
      }),
    ]);

    if (!Array.isArray(value)) {
      throw new CalendarReadFailure("Calendar read returned a malformed event list", "malformed");
    }
    return value as T[];
  } catch (error) {
    if (error instanceof CalendarReadFailure) throw error;
    throw new CalendarReadFailure("Calendar provider read failed", "provider", { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
