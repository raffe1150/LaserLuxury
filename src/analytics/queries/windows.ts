import type {
  AnalyticsWindowRequest,
  ResolvedAnalyticsWindow,
} from './contracts';
import { AnalyticsMetricsError } from './validation';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAXIMUM_DAYS = 366;

function validTimeZone(timeZone: string): string {
  const normalized = String(timeZone || '').trim();
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    throw new AnalyticsMetricsError('invalid_time_range');
  }
}

function zonedParts(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function localDate(instant: Date, timeZone: string): string {
  const part = zonedParts(instant, timeZone);
  return `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  if (!DATE.test(date)) throw new AnalyticsMetricsError('invalid_time_range');
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  const result = value.toISOString().slice(0, 10);
  const roundTrip = addDaysUnchecked(result, 0);
  if (days === 0 && result !== date || roundTrip !== result) {
    throw new AnalyticsMetricsError('invalid_time_range');
  }
  return result;
}

function addDaysUnchecked(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function localMidnightUtc(date: string, timeZone: string): number {
  if (!DATE.test(date) || addDays(date, 0) !== date) {
    throw new AnalyticsMetricsError('invalid_time_range');
  }
  const [year, month, day] = date.split('-').map(Number);
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetLocalAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const part = zonedParts(new Date(guess), timeZone);
    const representedLocal = Date.UTC(
      part.year, part.month - 1, part.day,
      part.hour, part.minute, part.second,
    );
    const correction = representedLocal - targetLocalAsUtc;
    if (correction === 0) return guess;
    guess -= correction;
  }
  if (localDate(new Date(guess), timeZone) !== date) {
    throw new AnalyticsMetricsError('invalid_time_range');
  }
  return guess;
}

export function resolveAnalyticsWindow(input: {
  businessId: number;
  timezone: string;
  window: AnalyticsWindowRequest;
  now?: Date;
}): ResolvedAnalyticsWindow {
  if (!Number.isSafeInteger(input.businessId) || input.businessId <= 0) {
    throw new AnalyticsMetricsError('business_id_required');
  }
  const timezone = validTimeZone(input.timezone);
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new AnalyticsMetricsError('invalid_time_range');

  let startDate: string;
  let endDate: string;
  if (input.window.preset === 'custom') {
    startDate = input.window.startDate;
    endDate = input.window.endDate;
    if (!DATE.test(startDate) || !DATE.test(endDate) || addDays(startDate, 0) !== startDate || addDays(endDate, 0) !== endDate) {
      throw new AnalyticsMetricsError('invalid_time_range');
    }
  } else {
    endDate = localDate(now, timezone);
    const days = input.window.preset === 'today' ? 1
      : input.window.preset === 'last_7_days' ? 7
        : 30;
    startDate = addDays(endDate, -(days - 1));
  }
  if (startDate > endDate) throw new AnalyticsMetricsError('invalid_time_range');
  const exclusiveEndDate = addDays(endDate, 1);
  const calendarDays = (
    Date.parse(`${exclusiveEndDate}T00:00:00.000Z`)
    - Date.parse(`${startDate}T00:00:00.000Z`)
  ) / 86_400_000;
  if (!Number.isInteger(calendarDays) || calendarDays > MAXIMUM_DAYS) {
    throw new AnalyticsMetricsError('time_range_too_large');
  }
  const fromMs = localMidnightUtc(startDate, timezone);
  const toMs = localMidnightUtc(exclusiveEndDate, timezone);
  if (toMs <= fromMs) throw new AnalyticsMetricsError('invalid_time_range');

  return {
    businessId: input.businessId,
    timezone,
    preset: input.window.preset,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    startDate,
    endDate,
    semantics: 'business_local_calendar_days_half_open_utc_query',
    fromMs,
    toMs,
  };
}

/** @internal */
export function analyticsLocalDate(occurredAt: unknown, timezone: string): string | null {
  if (typeof occurredAt !== 'string') return null;
  const instant = new Date(occurredAt);
  if (!Number.isFinite(instant.getTime())) return null;
  return localDate(instant, timezone);
}
