export type CalendarEventLike = {
  summary?: string;
  title?: string;
  description?: string;
  transparency?: string;
  eventType?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  startTime?: string;
  endTime?: string;
};

export type SlotMinuteConstraint = {
  minMinutes?: number | null;
  maxMinutes?: number | null;
  boundaryMinutes?: number | null;
  boundaryKind?: "exclusive_lower" | "inclusive_lower" | "exclusive_upper" | "inclusive_upper";
  excludedMinutes?: ReadonlySet<number>;
};

export function isBlockingCalendarEvent(event: CalendarEventLike): boolean {
  const summary = String(event?.summary || event?.title || "").trim().toLowerCase();
  const description = String(event?.description || "").trim().toLowerCase();
  const text = `${summary} ${description}`;
  const transparency = String(event?.transparency || "").toLowerCase();
  const eventType = String(event?.eventType || "").toLowerCase();
  const status = String(event?.status || "").toLowerCase();

  if (status === "cancelled" || transparency === "transparent") return false;
  if (eventType === "workinglocation" || eventType === "outofoffice") return false;
  if (!summary) return true;

  return !(
    /working\s*hours|business\s*hours|opening\s*hours|öppettider|arbetstid|schema/.test(text) ||
    /\b\d{1,2}\s*(am|pm)\b/.test(text) ||
    /^laser\s+luxury\s*,?\s*\d{1,2}/i.test(summary)
  );
}

export function isCanonicalSlotFree(
  startMs: number,
  durationMinutes: number,
  events: CalendarEventLike[],
  nowMs = Date.now(),
): boolean {
  const endMs = startMs + durationMinutes * 60_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMinutes) || durationMinutes <= 0 || startMs < nowMs) return false;
  return !events.some((event) => {
    if (!isBlockingCalendarEvent(event) || (!event.start && !event.startTime)) return false;
    const startIso = event.start?.dateTime || event.start?.date || event.startTime;
    const endIso = event.end?.dateTime || event.end?.date || event.endTime;
    const eventStart = new Date(String(startIso || "")).getTime();
    if (!Number.isFinite(eventStart)) return false;
    const parsedEnd = new Date(String(endIso || "")).getTime();
    const eventEnd = Number.isFinite(parsedEnd) ? parsedEnd : eventStart + 60 * 60_000;
    return startMs < eventEnd && endMs > eventStart;
  });
}

export function enumerateCandidateMinutes(
  openMinutes: number,
  closeMinutes: number,
  durationMinutes: number,
  intervalMinutes: number,
  constraint: SlotMinuteConstraint = {},
): number[] {
  const candidates: number[] = [];
  for (let minute = openMinutes; minute + durationMinutes <= closeMinutes; minute += intervalMinutes) {
    if (constraint.minMinutes != null && minute < constraint.minMinutes) continue;
    if (constraint.maxMinutes != null && minute > constraint.maxMinutes) continue;
    if (constraint.boundaryMinutes != null) {
      if (constraint.boundaryKind === "exclusive_lower" && minute <= constraint.boundaryMinutes) continue;
      if (constraint.boundaryKind === "inclusive_lower" && minute < constraint.boundaryMinutes) continue;
      if (constraint.boundaryKind === "exclusive_upper" && minute >= constraint.boundaryMinutes) continue;
      if (constraint.boundaryKind === "inclusive_upper" && minute > constraint.boundaryMinutes) continue;
    }
    if (constraint.excludedMinutes?.has(minute)) continue;
    candidates.push(minute);
  }
  return candidates;
}
