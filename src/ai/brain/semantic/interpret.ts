import { detectNormalizedIntent, getBookingDateConflict, hasBookingCorrectionCue, isReadOnlyAvailabilityInquiry,
  normalizeConversationText, parseBookingDate, parseTimeConstraint } from '../../booking-intelligence';
import { hasBookingInterruption } from '../../booking-interruption';
import { hasExternalConversationReference } from '../../conversation-intent-continuity';
import { isBusinessInformationQuestion, isExplicitBusinessActionRequest } from '../../business-information';
import { SEMANTIC_LIMITS, type Catalog, type Field, type InterpretationRequest, type Reading, type Route, type Span } from './contracts';

export const routes = ['new_booking', 'availability', 'booking_lookup', 'reschedule', 'cancellation'] as const;
const intents = [...routes, 'general_question', 'unknown', 'correction', 'close'] as const;
export const fields = ['service', 'staff', 'date', 'time'] as const;
const questionTypes = ['description', 'recommendation', 'requirement', 'permission', 'prohibition'] as const;
const missingFields = [...fields, 'reference', 'intent', 'conflict'] as const;
const inList = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && list.includes(value as T);
export const isRoute = (value: unknown): value is Route => inList(routes, value);

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}

export const excerpt = (text: string, span: Span) => text.slice(span.start, span.end);

function span(value: unknown, text: string, within?: Span): Span | undefined {
  if (!object(value, ['start', 'end'])) return undefined;
  const { start, end } = value;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < (within?.start ?? 0) || end > (within?.end ?? text.length) || start >= end ||
      !text.slice(start, end).trim()) return undefined;
  return { start, end };
}

/** Parse a bounded JSON reply at the trust boundary. Spans are pointers into
 * user text. There are no identity, permission, fact, tool or state fields. */
export function parseInterpretation(wire: unknown, request: InterpretationRequest): Reading[] | null {
  if (typeof wire !== 'string' || wire.length > SEMANTIC_LIMITS.proposalChars) return null;
  let data: unknown;
  try { data = JSON.parse(wire); } catch { return null; }
  if (!object(data, ['version', 'readings']) || data.version !== 1 || !Array.isArray(data.readings) ||
      !data.readings.length || data.readings.length > SEMANTIC_LIMITS.obligations) return null;
  const readings: Reading[] = [];
  for (const value of data.readings) {
    if (!object(value, ['intent', 'span', 'questionType', 'polarity', 'premise', 'conditions', 'reference', 'missing', 'change', 'entities']) ||
        !inList(intents, value.intent)) return null;
    const anchor = span(value.span, request.text);
    if (!anchor || (value.questionType !== undefined && !inList(questionTypes, value.questionType)) ||
        (value.polarity !== undefined && value.polarity !== 'positive' && value.polarity !== 'negative') ||
        (value.missing !== undefined && !inList(missingFields, value.missing))) return null;
    if ((value.intent === 'general_question') !== (value.questionType !== undefined)) return null;
    const premise = value.premise === undefined ? undefined : span(value.premise, request.text, anchor);
    if (value.premise !== undefined && (!premise || value.intent !== 'general_question')) return null;
    const conditions: NonNullable<Reading['conditions']>[number][] = [];
    if (value.conditions !== undefined) {
      if (!Array.isArray(value.conditions) || value.conditions.length > SEMANTIC_LIMITS.conditions) return null;
      for (const c of value.conditions) {
        if (!object(c, ['kind', 'explicit', 'span']) || !inList(['if', 'unless', 'while'] as const, c.kind) ||
            typeof c.explicit !== 'boolean') return null;
        const sourceSpan = span(c.span, request.text, anchor);
        if (!sourceSpan) return null;
        conditions.push({ kind: c.kind, explicit: c.explicit, span: sourceSpan });
      }
    }
    const reference = value.reference;
    if (reference !== undefined && (typeof reference !== 'number' || !Number.isInteger(reference) ||
        reference < 0 || reference >= request.references.length)) return null;
    const change = value.change;
    if (change !== undefined && (value.intent !== 'correction' || !Array.isArray(change) || !change.length ||
        change.length > fields.length || new Set(change).size !== change.length || change.some(x => !inList(fields, x)))) return null;
    if (value.intent === 'correction' && change === undefined) return null;
    const entities: Partial<Record<Field, Span>> = {};
    if (value.entities !== undefined) {
      if (!object(value.entities, fields)) return null;
      for (const field of fields) {
        if (value.entities[field] === undefined) continue;
        const entity = span(value.entities[field], request.text, anchor);
        if (!entity) return null;
        entities[field] = entity;
      }
    }
    if (readings.some(r => r.span.start === anchor.start && r.span.end === anchor.end && r.intent === value.intent &&
        r.questionType === value.questionType)) return null;
    readings.push({ intent: value.intent, span: anchor,
      questionType: inList(questionTypes, value.questionType) ? value.questionType : undefined,
      polarity: inList(['positive', 'negative'] as const, value.polarity) ? value.polarity : undefined,
      premise, conditions, reference: typeof reference === 'number' ? reference : undefined,
      missing: inList(missingFields, value.missing) ? value.missing : undefined,
      change: Array.isArray(change) ? change.filter((field): field is Field => inList(fields, field)) : undefined,
      entities });
  }
  if (readings.some(r => r.intent === 'close' && (readings.length > 1 || r.missing || r.reference !== undefined ||
      r.conditions?.length || r.polarity === 'negative' || Object.keys(r.entities ?? {}).length))) return null;
  return readings;
}

export function catalogId(text: string, items: Catalog['services']): string | undefined {
  const folded = text.trim().normalize('NFKC').toLowerCase();
  const matches = items.filter(item => item.label.trim().normalize('NFKC').toLowerCase() === folded);
  if (matches.length !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(matches[0].id)) return undefined;
  return matches[0].id;
}

function literalCatalogSpan(text: string, items: Catalog['services']): Span | undefined {
  const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  const matches: Span[] = [];
  for (const { label } of items) {
    const parts = label.trim().split(/\s+/).length;
    if (!label.trim() || parts > 8) continue;
    for (let i = 0; i <= tokens.length - parts; i++) {
      const start = tokens[i].index!;
      const end = tokens[i + parts - 1].index! + tokens[i + parts - 1][0].length;
      if (catalogId(text.slice(start, end), items) && !matches.some(m => m.start === start && m.end === end)) matches.push({ start, end });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Existing shared booking predicates are narrow fallback signals. Semantic
 * questions, mixed requests and uncertain references need an interpretation. */
export function literalReading(request: InterpretationRequest, catalog: Catalog): Reading[] {
  const { text } = request;
  const span = { start: 0, end: text.length };
  const intent = detectNormalizedIntent(text);
  const info = isBusinessInformationQuestion(text);
  const action = isExplicitBusinessActionRequest(text);
  if (hasBookingInterruption(text)) return [{ intent: 'unknown', span, missing: 'intent' }];
  const bookingGoals = request.references.map((ref, index) => ({ ref, index })).filter(({ ref }) => ref.kind === 'booking');
  if (!info && hasBookingCorrectionCue(text)) {
    if (bookingGoals.length !== 1) return [{ intent: 'unknown', span, missing: 'reference' }];
    // Deliberately narrow literal form. Alternatives, negation, implicit
    // updates and other natural-language corrections require a proposal.
    const weekday = /^actually[,]?\s+make it\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)[.!]?$/iu.exec(text.trim());
    if (weekday) {
      const start = text.toLowerCase().lastIndexOf(weekday[1].toLowerCase());
      return [{ intent: 'correction', span, change: ['date'], reference: bookingGoals[0].index,
        entities: { date: { start, end: start + weekday[1].length } } }];
    }
    return [{ intent: 'unknown', span, missing: 'intent' }];
  }
  if (hasExternalConversationReference(text)) return [{ intent: 'unknown', span, missing: 'reference' }];
  if (!info && !action && bookingGoals.length === 1) {
    const [{ ref, index }] = bookingGoals;
    const [field] = ref.waitingFor;
    const exact = (field === 'service' && catalogId(text, catalog.services)) ||
      (field === 'staff' && catalogId(text, catalog.staff)) ||
      (field === 'time' && /^\s*\p{Nd}{1,2}:\p{Nd}{2}\s*$/u.test(text));
    if (exact && ref.intent === 'new_booking' && (field === 'service' || field === 'staff' || field === 'time'))
      return [{ intent: 'new_booking', span, reference: index, entities: { [field]: span } }];
  }
  const availability = !info && isReadOnlyAvailabilityInquiry(text);
  const route = availability ? 'availability' : isRoute(intent) && action ? intent : undefined;
  if (!info && route) {
    return [{ intent: route, span, entities: {
      service: literalCatalogSpan(text, catalog.services), staff: literalCatalogSpan(text, catalog.staff),
      date: span, time: span,
    } }];
  }
  return [{ intent: 'unknown', span, missing: 'intent' }];
}

export function parsedDate(text: string, timezone: string, now: Date) {
  if (getBookingDateConflict(text, timezone, now)) return 'conflict' as const;
  // The shared parser may return the first date in an explicit choice.
  // Require two independently parseable, different dates before flagging it.
  const alternatives = text.split(/\s+(?:or|eller|oder|o|یا|أو)\s+/iu);
  if (alternatives.length > 1) {
    const dates = new Set(alternatives.map(part => parseBookingDate(part, timezone, now)?.value).filter(Boolean));
    if (dates.size > 1) return 'conflict' as const;
  }
  const value = parseBookingDate(text, timezone, now);
  if (!value?.value || !/^\d{4}-\d{2}-\d{2}$/.test(value.value) ||
      (value.endValue !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value.endValue))) return undefined;
  return { kind: value.kind, value: value.value, endValue: value.endValue };
}

export function parsedTime(text: string) {
  const normalized = normalizeConversationText(text);
  const clocks = [...normalized.matchAll(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g)];
  const value = parseTimeConstraint(normalized);
  // A shared heuristic can choose the first clock from an alternative. Keep
  // a multi-clock value only if the parser recognized a range.
  if (clocks.length > 1 && value?.kind !== 'between') return undefined;
  if (!value || value.confidence === 'low') return undefined;
  return { kind: value.kind, startMinutes: value.startMinutes, endMinutes: value.endMinutes,
    startInclusive: value.startInclusive, endInclusive: value.endInclusive };
}
