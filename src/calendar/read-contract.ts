export type CalendarReadFailureCode = 'calendar_unavailable' | 'calendar_timeout' | 'calendar_malformed' | 'calendar_incomplete';
export class CalendarReadError extends Error {
  constructor(readonly code: CalendarReadFailureCode = 'calendar_unavailable') {
    super(code);
    this.name = 'CalendarReadError';
  }
}
export type CalendarReadResult =
  | { ok: true; events: any[]; empty: boolean }
  | { ok: false; code: CalendarReadFailureCode };

export async function readCalendarEvents(
  adapter: { getEvents(start: string, end: string, options?: { throwOnReadFailure?: boolean }): any },
  start: string, end: string, timeoutMs = 20_000,
): Promise<CalendarReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const events = await Promise.race([
      Promise.resolve().then(() => adapter.getEvents(start, end, { throwOnReadFailure: true })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CalendarReadError('calendar_timeout')), timeoutMs); }),
    ]);
    if (!Array.isArray(events)) throw new CalendarReadError('calendar_malformed');
    for (const event of events) {
      if (event?.status === 'cancelled' || event?.transparency === 'transparent') continue;
      const start = event?.start?.dateTime || event?.start?.date || event?.startTime;
      if (!start || !Number.isFinite(new Date(start).getTime())) throw new CalendarReadError('calendar_malformed');
    }
    return { ok: true, events, empty: events.length === 0 };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return { ok: false, code: error instanceof CalendarReadError ? error.code
      : name === 'AbortError' || name === 'TimeoutError' ? 'calendar_timeout' : 'calendar_unavailable' };
  } finally { clearTimeout(timer); }
}

export async function requireCalendarEvents(
  adapter: Parameters<typeof readCalendarEvents>[0], start: string, end: string,
): Promise<any[]> {
  const result = await readCalendarEvents(adapter, start, end);
  if (result.ok === false) throw new CalendarReadError(result.code);
  return result.events;
}
