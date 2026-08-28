import {
  STRUCTURED_UNDERSTANDING_SCHEMA_VERSION,
  type CanonicalStructuredUnderstandingV1,
  type UnderstandingCorrectionValue,
  type UnderstandingDateValue,
  type UnderstandingEvidence,
  type UnderstandingFact,
  type UnderstandingIntent,
  type UnderstandingSlotReferenceValue,
  type UnderstandingTimeValue,
} from './types';

export type StructuredUnderstandingValidationIssue = {
  path: string;
  code:
    | 'invalid_type'
    | 'invalid_value'
    | 'invalid_enum'
    | 'invalid_range'
    | 'unexpected_field'
    | 'missing_field'
    | 'too_long';
};

export type StructuredUnderstandingDecodeResult =
  | { ok: true; value: CanonicalStructuredUnderstandingV1 }
  | { ok: false; issues: StructuredUnderstandingValidationIssue[] };

class DecodeFailure extends Error {
  constructor(readonly issue: StructuredUnderstandingValidationIssue) {
    super(`${issue.code} at ${issue.path}`);
  }
}

const intentValues = new Set<UnderstandingIntent>([
  'new_booking',
  'availability',
  'booking_lookup',
  'reschedule',
  'cancellation',
  'general_question',
  'unknown',
]);
const dateKinds = new Set<UnderstandingDateValue['kind']>(['absolute', 'weekday', 'relative', 'range']);
const timeKinds = new Set<UnderstandingTimeValue['kind']>(['exact', 'before', 'after', 'from', 'between', 'daypart']);
const dayparts = new Set<NonNullable<UnderstandingTimeValue['daypart']>>(['morning', 'afternoon', 'evening']);
const slotKinds = new Set<UnderstandingSlotReferenceValue['kind']>(['ordinal', 'deictic', 'time']);
const correctionKinds = new Set<UnderstandingCorrectionValue['kind']>(['correction', 'replacement', 'mind_change']);
const correctionTargets = new Set<UnderstandingCorrectionValue['targets'][number]>(['service', 'date', 'time', 'name', 'phone', 'slot']);
const confirmationValues = new Set(['affirmed', 'rejected', 'unclear'] as const);
const languagePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function fail(path: string, code: StructuredUnderstandingValidationIssue['code']): never {
  throw new DecodeFailure({ path, code });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'invalid_type');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, 'unexpected_field');
  }
}

function required(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'missing_field');
  return value[key];
}

function stringValue(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') fail(path, 'invalid_type');
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    fail(path, value.length > maxLength ? 'too_long' : 'invalid_value');
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'invalid_type');
  return value;
}

function confidence(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'invalid_type');
  if (value < 0 || value > 1) fail(path, 'invalid_range');
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'invalid_type');
  if (value < minimum || value > maximum) fail(path, 'invalid_range');
  return value;
}

function arrayValue(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'invalid_type');
  if (value.length > maxLength) fail(path, 'too_long');
  return value;
}

function optional<T>(value: unknown, decode: (entry: unknown) => T): T | undefined {
  return value === undefined ? undefined : decode(value);
}

function evidence(value: unknown, path: string): UnderstandingEvidence {
  const item = record(value, path);
  exactKeys(item, ['start', 'end', 'explicit'], path);
  const start = boundedInteger(required(item, 'start', path), `${path}.start`, 0, 1_000_000);
  const end = boundedInteger(required(item, 'end', path), `${path}.end`, 0, 1_000_000);
  if (end < start) fail(path, 'invalid_range');
  return {
    start,
    end,
    explicit: booleanValue(required(item, 'explicit', path), `${path}.explicit`),
  };
}

function evidenceList(value: unknown, path: string): UnderstandingEvidence[] | undefined {
  if (value === undefined) return undefined;
  return arrayValue(value, path, 8).map((entry, index) => evidence(entry, `${path}[${index}]`));
}

function fact<T>(
  value: unknown,
  path: string,
  decodeValue: (entry: unknown, path: string) => T,
): UnderstandingFact<T> {
  const item = record(value, path);
  exactKeys(item, ['value', 'confidence', 'evidence'], path);
  return {
    value: decodeValue(required(item, 'value', path), `${path}.value`),
    confidence: confidence(required(item, 'confidence', path), `${path}.confidence`),
    ...(item.evidence === undefined ? {} : { evidence: evidenceList(item.evidence, `${path}.evidence`) }),
  };
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): T {
  if (typeof value !== 'string') fail(path, 'invalid_type');
  if (!values.has(value as T)) fail(path, 'invalid_enum');
  return value as T;
}

function language(value: unknown, path: string): string {
  const decoded = stringValue(value, path, 35);
  if (!languagePattern.test(decoded)) fail(path, 'invalid_value');
  return decoded;
}

function optionalDate(value: unknown, path: string): string {
  const decoded = stringValue(value, path, 10);
  if (!datePattern.test(decoded)) fail(path, 'invalid_value');
  return decoded;
}

function optionalClock(value: unknown, path: string): string {
  const decoded = stringValue(value, path, 5);
  if (!clockPattern.test(decoded)) fail(path, 'invalid_value');
  return decoded;
}

function dateValue(value: unknown, path: string): UnderstandingDateValue {
  const item = record(value, path);
  exactKeys(item, ['kind', 'value', 'endValue', 'weekday', 'relativeExpression'], path);
  const kind = enumValue(required(item, 'kind', path), dateKinds, `${path}.kind`);
  const decoded: UnderstandingDateValue = {
    kind,
    ...(item.value === undefined ? {} : { value: optionalDate(item.value, `${path}.value`) }),
    ...(item.endValue === undefined ? {} : { endValue: optionalDate(item.endValue, `${path}.endValue`) }),
    ...(item.weekday === undefined ? {} : { weekday: boundedInteger(item.weekday, `${path}.weekday`, 0, 6) }),
    ...(item.relativeExpression === undefined ? {} : {
      relativeExpression: stringValue(item.relativeExpression, `${path}.relativeExpression`, 160),
    }),
  };
  if (kind === 'absolute' && !decoded.value) fail(path, 'missing_field');
  if (kind === 'range' && (!decoded.value || !decoded.endValue)) fail(path, 'missing_field');
  if (kind === 'weekday' && decoded.weekday === undefined) fail(path, 'missing_field');
  if (kind === 'relative' && !decoded.relativeExpression) fail(path, 'missing_field');
  return decoded;
}

function timeValue(value: unknown, path: string): UnderstandingTimeValue {
  const item = record(value, path);
  exactKeys(item, ['kind', 'start', 'end', 'daypart'], path);
  const kind = enumValue(required(item, 'kind', path), timeKinds, `${path}.kind`);
  const decoded: UnderstandingTimeValue = {
    kind,
    ...(item.start === undefined ? {} : { start: optionalClock(item.start, `${path}.start`) }),
    ...(item.end === undefined ? {} : { end: optionalClock(item.end, `${path}.end`) }),
    ...(item.daypart === undefined ? {} : {
      daypart: enumValue(item.daypart, dayparts, `${path}.daypart`),
    }),
  };
  if (['exact', 'before', 'after', 'from'].includes(kind) && !decoded.start) fail(path, 'missing_field');
  if (kind === 'between' && (!decoded.start || !decoded.end)) fail(path, 'missing_field');
  if (kind === 'daypart' && !decoded.daypart) fail(path, 'missing_field');
  return decoded;
}

function slotReferenceValue(value: unknown, path: string): UnderstandingSlotReferenceValue {
  const item = record(value, path);
  exactKeys(item, ['kind', 'ordinal', 'time'], path);
  const kind = enumValue(required(item, 'kind', path), slotKinds, `${path}.kind`);
  const decoded: UnderstandingSlotReferenceValue = {
    kind,
    ...(item.ordinal === undefined ? {} : { ordinal: boundedInteger(item.ordinal, `${path}.ordinal`, 1, 100) }),
    ...(item.time === undefined ? {} : { time: optionalClock(item.time, `${path}.time`) }),
  };
  if (kind === 'ordinal' && decoded.ordinal === undefined) fail(path, 'missing_field');
  if (kind === 'time' && !decoded.time) fail(path, 'missing_field');
  return decoded;
}

function correctionValue(value: unknown, path: string): UnderstandingCorrectionValue {
  const item = record(value, path);
  exactKeys(item, ['kind', 'targets'], path);
  const targets = arrayValue(required(item, 'targets', path), `${path}.targets`, 6)
    .map((entry, index) => enumValue(entry, correctionTargets, `${path}.targets[${index}]`));
  if (targets.length === 0 || new Set(targets).size !== targets.length) fail(`${path}.targets`, 'invalid_value');
  return {
    kind: enumValue(required(item, 'kind', path), correctionKinds, `${path}.kind`),
    targets,
  };
}

export function decodeCanonicalStructuredUnderstanding(
  input: unknown,
): StructuredUnderstandingDecodeResult {
  try {
    const root = record(input, '$');
    exactKeys(root, ['schemaVersion', 'language', 'intents', 'acts', 'entities', 'correction', 'ambiguities'], '$');
    if (required(root, 'schemaVersion', '$') !== STRUCTURED_UNDERSTANDING_SCHEMA_VERSION) {
      fail('$.schemaVersion', 'invalid_value');
    }

    const languageObject = record(required(root, 'language', '$'), '$.language');
    exactKeys(languageObject, ['primary', 'codeSwitches'], '$.language');
    const primary = fact(required(languageObject, 'primary', '$.language'), '$.language.primary', language);
    const codeSwitches = arrayValue(required(languageObject, 'codeSwitches', '$.language'), '$.language.codeSwitches', 16)
      .map((entry, index) => {
        const path = `$.language.codeSwitches[${index}]`;
        const item = record(entry, path);
        exactKeys(item, ['language', 'start', 'end', 'confidence'], path);
        const start = boundedInteger(required(item, 'start', path), `${path}.start`, 0, 1_000_000);
        const end = boundedInteger(required(item, 'end', path), `${path}.end`, 0, 1_000_000);
        if (end < start) fail(path, 'invalid_range');
        return {
          language: language(required(item, 'language', path), `${path}.language`),
          start,
          end,
          confidence: confidence(required(item, 'confidence', path), `${path}.confidence`),
        };
      });

    const intents = arrayValue(required(root, 'intents', '$'), '$.intents', 8)
      .map((entry, index) => fact(
        entry,
        `$.intents[${index}]`,
        (candidate, path) => enumValue(candidate, intentValues, path),
      ));

    const actsObject = record(required(root, 'acts', '$'), '$.acts');
    exactKeys(actsObject, ['bookingRequest', 'bookingConfirmation'], '$.acts');
    const acts: CanonicalStructuredUnderstandingV1['acts'] = {
      ...(actsObject.bookingRequest === undefined ? {} : {
        bookingRequest: fact(actsObject.bookingRequest, '$.acts.bookingRequest', booleanValue),
      }),
      ...(actsObject.bookingConfirmation === undefined ? {} : {
        bookingConfirmation: fact(
          actsObject.bookingConfirmation,
          '$.acts.bookingConfirmation',
          (candidate, path) => enumValue(candidate, confirmationValues, path),
        ),
      }),
    };

    const entitiesObject = record(required(root, 'entities', '$'), '$.entities');
    exactKeys(entitiesObject, ['service', 'date', 'time', 'name', 'phone', 'slotReference'], '$.entities');
    const entities: CanonicalStructuredUnderstandingV1['entities'] = {
      ...(entitiesObject.service === undefined ? {} : {
        service: fact(entitiesObject.service, '$.entities.service', (candidate, path) => {
          const item = record(candidate, path);
          exactKeys(item, ['statedValue'], path);
          return { statedValue: stringValue(required(item, 'statedValue', path), `${path}.statedValue`, 160) };
        }),
      }),
      ...(entitiesObject.date === undefined ? {} : { date: fact(entitiesObject.date, '$.entities.date', dateValue) }),
      ...(entitiesObject.time === undefined ? {} : { time: fact(entitiesObject.time, '$.entities.time', timeValue) }),
      ...(entitiesObject.name === undefined ? {} : {
        name: fact(entitiesObject.name, '$.entities.name', (candidate, path) => stringValue(candidate, path, 160)),
      }),
      ...(entitiesObject.phone === undefined ? {} : {
        phone: fact(entitiesObject.phone, '$.entities.phone', (candidate, path) => stringValue(candidate, path, 40)),
      }),
      ...(entitiesObject.slotReference === undefined ? {} : {
        slotReference: fact(entitiesObject.slotReference, '$.entities.slotReference', slotReferenceValue),
      }),
    };

    const ambiguities = arrayValue(required(root, 'ambiguities', '$'), '$.ambiguities', 16)
      .map((entry, index) => {
        const path = `$.ambiguities[${index}]`;
        const item = record(entry, path);
        exactKeys(item, ['field', 'reason', 'confidence', 'evidence'], path);
        return {
          field: stringValue(required(item, 'field', path), `${path}.field`, 64),
          reason: stringValue(required(item, 'reason', path), `${path}.reason`, 240),
          confidence: confidence(required(item, 'confidence', path), `${path}.confidence`),
          ...(item.evidence === undefined ? {} : { evidence: evidenceList(item.evidence, `${path}.evidence`) }),
        };
      });

    const decoded: CanonicalStructuredUnderstandingV1 = {
      schemaVersion: STRUCTURED_UNDERSTANDING_SCHEMA_VERSION,
      language: { primary, codeSwitches },
      intents,
      acts,
      entities,
      ...(root.correction === undefined ? {} : {
        correction: fact(root.correction, '$.correction', correctionValue),
      }),
      ambiguities,
    };
    return { ok: true, value: decoded };
  } catch (error) {
    if (error instanceof DecodeFailure) return { ok: false, issues: [error.issue] };
    return { ok: false, issues: [{ path: '$', code: 'invalid_value' }] };
  }
}
