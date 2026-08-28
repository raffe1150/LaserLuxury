import type { CanonicalStructuredUnderstandingV1, UnderstandingIntent } from '../types';

export const GEMINI_WIRE_SCHEMA_VERSION = 1 as const;

const intentValues = [
  'new_booking',
  'availability',
  'booking_lookup',
  'reschedule',
  'cancellation',
  'general_question',
  'unknown',
] as const;
const confirmationValues = ['affirmed', 'rejected', 'unclear'] as const;
const dateKinds = ['absolute', 'weekday', 'relative', 'range'] as const;
const timeKinds = ['exact', 'before', 'after', 'from', 'between', 'daypart'] as const;
const dayparts = ['morning', 'afternoon', 'evening'] as const;
const slotKinds = ['ordinal', 'deictic', 'time'] as const;
const correctionKinds = ['correction', 'replacement', 'mind_change'] as const;
const correctionTargets = ['service', 'date', 'time', 'name', 'phone', 'slot'] as const;

export const GEMINI_STRUCTURED_UNDERSTANDING_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'language', 'confidence', 'intents', 'ambiguityFields'],
  properties: {
    schemaVersion: { type: 'integer', enum: [GEMINI_WIRE_SCHEMA_VERSION] },
    language: { type: 'string' },
    confidence: { type: 'number' },
    intents: { type: 'array', items: { type: 'string', enum: intentValues } },
    bookingRequest: { type: 'boolean' },
    bookingConfirmation: { type: 'string', enum: confirmationValues },
    serviceText: { type: 'string' },
    dateKind: { type: 'string', enum: dateKinds },
    dateValue: { type: 'string' },
    dateEndValue: { type: 'string' },
    dateWeekday: { type: 'integer' },
    dateRelativeExpression: { type: 'string' },
    timeKind: { type: 'string', enum: timeKinds },
    timeStart: { type: 'string' },
    timeEnd: { type: 'string' },
    daypart: { type: 'string', enum: dayparts },
    name: { type: 'string' },
    phone: { type: 'string' },
    slotReferenceKind: { type: 'string', enum: slotKinds },
    slotOrdinal: { type: 'integer' },
    slotTime: { type: 'string' },
    correctionKind: { type: 'string', enum: correctionKinds },
    correctionTargets: { type: 'array', items: { type: 'string', enum: correctionTargets } },
    ambiguityFields: { type: 'array', items: { type: 'string' } },
  },
} as const;

type GeminiWireUnderstanding = {
  schemaVersion: typeof GEMINI_WIRE_SCHEMA_VERSION;
  language: string;
  confidence: number;
  intents: UnderstandingIntent[];
  bookingRequest?: boolean;
  bookingConfirmation?: typeof confirmationValues[number];
  serviceText?: string;
  dateKind?: typeof dateKinds[number];
  dateValue?: string;
  dateEndValue?: string;
  dateWeekday?: number;
  dateRelativeExpression?: string;
  timeKind?: typeof timeKinds[number];
  timeStart?: string;
  timeEnd?: string;
  daypart?: typeof dayparts[number];
  name?: string;
  phone?: string;
  slotReferenceKind?: typeof slotKinds[number];
  slotOrdinal?: number;
  slotTime?: string;
  correctionKind?: typeof correctionKinds[number];
  correctionTargets?: typeof correctionTargets[number][];
  ambiguityFields: string[];
};

export type GeminiWireDecodeResult =
  | { ok: true; value: GeminiWireUnderstanding }
  | { ok: false };

const allowedKeys = new Set(Object.keys(GEMINI_STRUCTURED_UNDERSTANDING_WIRE_SCHEMA.properties));
const languagePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function optionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maxLength);
}

function validStringArray(value: unknown, maximum: number, maxStringLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(
    (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= maxStringLength,
  );
}

function hasAny(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => record[key] !== undefined);
}

export function decodeGeminiWireUnderstanding(input: unknown): GeminiWireDecodeResult {
  if (!isRecord(input) || Object.keys(input).some((key) => !allowedKeys.has(key))) return { ok: false };
  if (input.schemaVersion !== GEMINI_WIRE_SCHEMA_VERSION) return { ok: false };
  if (typeof input.language !== 'string' || !languagePattern.test(input.language)) return { ok: false };
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) return { ok: false };
  if (!Array.isArray(input.intents) || input.intents.length > 8 || !input.intents.every((value) => isEnum(value, intentValues))) return { ok: false };
  if (!validStringArray(input.ambiguityFields, 16, 64)) return { ok: false };
  if (input.bookingRequest !== undefined && typeof input.bookingRequest !== 'boolean') return { ok: false };
  if (input.bookingConfirmation !== undefined && !isEnum(input.bookingConfirmation, confirmationValues)) return { ok: false };
  for (const [key, maximum] of [
    ['serviceText', 160], ['dateValue', 10], ['dateEndValue', 10],
    ['dateRelativeExpression', 160], ['timeStart', 5], ['timeEnd', 5],
    ['name', 160], ['phone', 40], ['slotTime', 5],
  ] as const) {
    if (!optionalString(input[key], maximum)) return { ok: false };
  }

  const dateFields = ['dateValue', 'dateEndValue', 'dateWeekday', 'dateRelativeExpression'];
  if (input.dateKind === undefined) {
    if (hasAny(input, dateFields)) return { ok: false };
  } else {
    if (!isEnum(input.dateKind, dateKinds)) return { ok: false };
    if (input.dateKind === 'absolute' && (typeof input.dateValue !== 'string' || !datePattern.test(input.dateValue))) return { ok: false };
    if (input.dateKind === 'range' && (typeof input.dateValue !== 'string' || !datePattern.test(input.dateValue) || typeof input.dateEndValue !== 'string' || !datePattern.test(input.dateEndValue))) return { ok: false };
    if (input.dateKind === 'weekday' && (!Number.isInteger(input.dateWeekday) || Number(input.dateWeekday) < 0 || Number(input.dateWeekday) > 6)) return { ok: false };
    if (input.dateKind === 'relative' && !optionalString(input.dateRelativeExpression, 160)) return { ok: false };
  }

  const timeFields = ['timeStart', 'timeEnd', 'daypart'];
  if (input.timeKind === undefined) {
    if (hasAny(input, timeFields)) return { ok: false };
  } else {
    if (!isEnum(input.timeKind, timeKinds)) return { ok: false };
    if (['exact', 'before', 'after', 'from'].includes(input.timeKind) && (typeof input.timeStart !== 'string' || !clockPattern.test(input.timeStart))) return { ok: false };
    if (input.timeKind === 'between' && (typeof input.timeStart !== 'string' || !clockPattern.test(input.timeStart) || typeof input.timeEnd !== 'string' || !clockPattern.test(input.timeEnd))) return { ok: false };
    if (input.timeKind === 'daypart' && !isEnum(input.daypart, dayparts)) return { ok: false };
  }

  const slotFields = ['slotOrdinal', 'slotTime'];
  if (input.slotReferenceKind === undefined) {
    if (hasAny(input, slotFields)) return { ok: false };
  } else {
    if (!isEnum(input.slotReferenceKind, slotKinds)) return { ok: false };
    if (input.slotReferenceKind === 'ordinal' && (!Number.isInteger(input.slotOrdinal) || Number(input.slotOrdinal) < 1 || Number(input.slotOrdinal) > 100)) return { ok: false };
    if (input.slotReferenceKind === 'time' && (typeof input.slotTime !== 'string' || !clockPattern.test(input.slotTime))) return { ok: false };
  }

  if (input.correctionKind === undefined) {
    if (input.correctionTargets !== undefined) return { ok: false };
  } else {
    if (!isEnum(input.correctionKind, correctionKinds) || !Array.isArray(input.correctionTargets) || input.correctionTargets.length === 0 || input.correctionTargets.length > 6 || !input.correctionTargets.every((value) => isEnum(value, correctionTargets)) || new Set(input.correctionTargets).size !== input.correctionTargets.length) return { ok: false };
  }

  return { ok: true, value: input as GeminiWireUnderstanding };
}

export function mapGeminiWireToCanonical(
  wire: GeminiWireUnderstanding,
): CanonicalStructuredUnderstandingV1 {
  const confidence = wire.confidence;
  const date = wire.dateKind ? {
    kind: wire.dateKind,
    ...(wire.dateValue ? { value: wire.dateValue } : {}),
    ...(wire.dateEndValue ? { endValue: wire.dateEndValue } : {}),
    ...(wire.dateWeekday !== undefined ? { weekday: wire.dateWeekday } : {}),
    ...(wire.dateRelativeExpression ? { relativeExpression: wire.dateRelativeExpression } : {}),
  } : undefined;
  const time = wire.timeKind ? {
    kind: wire.timeKind,
    ...(wire.timeStart ? { start: wire.timeStart } : {}),
    ...(wire.timeEnd ? { end: wire.timeEnd } : {}),
    ...(wire.daypart ? { daypart: wire.daypart } : {}),
  } : undefined;
  const slotReference = wire.slotReferenceKind ? {
    kind: wire.slotReferenceKind,
    ...(wire.slotOrdinal !== undefined ? { ordinal: wire.slotOrdinal } : {}),
    ...(wire.slotTime ? { time: wire.slotTime } : {}),
  } : undefined;
  return {
    schemaVersion: 1,
    language: { primary: { value: wire.language, confidence }, codeSwitches: [] },
    intents: wire.intents.map((value) => ({ value, confidence })),
    acts: {
      ...(wire.bookingRequest === undefined ? {} : { bookingRequest: { value: wire.bookingRequest, confidence } }),
      ...(wire.bookingConfirmation === undefined ? {} : { bookingConfirmation: { value: wire.bookingConfirmation, confidence } }),
    },
    entities: {
      ...(wire.serviceText ? { service: { value: { statedValue: wire.serviceText }, confidence } } : {}),
      ...(date ? { date: { value: date, confidence } } : {}),
      ...(time ? { time: { value: time, confidence } } : {}),
      ...(wire.name ? { name: { value: wire.name, confidence } } : {}),
      ...(wire.phone ? { phone: { value: wire.phone, confidence } } : {}),
      ...(slotReference ? { slotReference: { value: slotReference, confidence } } : {}),
    },
    ...(wire.correctionKind ? {
      correction: {
        value: { kind: wire.correctionKind, targets: wire.correctionTargets || [] },
        confidence,
      },
    } : {}),
    ambiguities: wire.ambiguityFields.map((field) => ({
      field,
      reason: 'Provider marked this field as ambiguous.',
      confidence,
    })),
  };
}
