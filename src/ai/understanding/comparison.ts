import type {
  NormalizedBookingRequest,
  NormalizedTimeConstraint,
} from '../booking-intelligence';
import type {
  CanonicalStructuredUnderstanding,
  UnderstandingConfidence,
  UnderstandingTimeValue,
} from './types';

export type ShadowComparisonStatus =
  | 'agreement'
  | 'legacy_only'
  | 'provider_only'
  | 'conflict'
  | 'not_comparable';

export type ShadowComparisonFieldName =
  | 'language'
  | 'booking_intent'
  | 'confirmation'
  | 'rejection'
  | 'service'
  | 'date'
  | 'time_constraint'
  | 'name_presence'
  | 'phone_presence'
  | 'slot_reference'
  | 'correction'
  | 'cancellation'
  | 'reschedule'
  | 'ambiguity';

export type LegacyUnderstandingSignals = Readonly<{
  confirmation?: boolean;
  rejection?: boolean;
  namePresent?: boolean;
  phonePresent?: boolean;
  slotReferencePresent?: boolean;
}>;

export type ShadowConfidenceBucket = 'low' | 'medium' | 'high';

export type ShadowFieldComparison = Readonly<{
  field: ShadowComparisonFieldName;
  status: ShadowComparisonStatus;
  legacyPresent: boolean;
  providerPresent: boolean;
  providerConfidenceBucket?: ShadowConfidenceBucket;
}>;

export type ShadowUnderstandingComparison = Readonly<{
  fields: readonly ShadowFieldComparison[];
  comparableFields: readonly ShadowComparisonFieldName[];
  agreementCount: number;
  disagreementCount: number;
  disagreementCategories: readonly ShadowComparisonFieldName[];
}>;

type Projection = {
  comparable: boolean;
  present: boolean;
  value?: string;
  confidence?: UnderstandingConfidence;
};

function bucket(confidence: UnderstandingConfidence | undefined): ShadowConfidenceBucket | undefined {
  if (confidence === undefined) return undefined;
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function absent(comparable = true): Projection {
  return { comparable, present: false };
}

function present(value: string, confidence?: UnderstandingConfidence): Projection {
  return { comparable: true, present: true, value, confidence };
}

function booleanProjection(value: boolean | undefined, confidence?: UnderstandingConfidence): Projection {
  return value === undefined ? absent(false) : present(String(value), confidence);
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
  return normalized || undefined;
}

function minutesToClock(minutes: number | undefined): string | undefined {
  if (!Number.isFinite(minutes)) return undefined;
  const bounded = Math.max(0, Math.min((24 * 60) - 1, Math.floor(minutes as number)));
  return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}

function legacyTimeValue(value: NormalizedTimeConstraint | undefined): string | undefined {
  if (!value || value.kind === 'none') return undefined;
  if (['morning', 'afternoon', 'evening'].includes(value.kind)) return `daypart:${value.kind}`;
  const start = minutesToClock(value.startMinutes);
  const end = minutesToClock(value.endMinutes);
  switch (value.kind) {
    case 'exact': return start ? `exact:${start}` : undefined;
    case 'before': return (end || start) ? `before:${end || start}` : undefined;
    case 'after': return (start || end) ? `after:${start || end}` : undefined;
    case 'from': return start ? `from:${start}` : undefined;
    case 'between': return start && end ? `between:${start}:${end}` : undefined;
    default: return undefined;
  }
}

function providerTimeValue(value: UnderstandingTimeValue | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'daypart') return value.daypart ? `daypart:${value.daypart}` : undefined;
  if (value.kind === 'between') return value.start && value.end ? `between:${value.start}:${value.end}` : undefined;
  return value.start ? `${value.kind}:${value.start}` : undefined;
}

function legacyDateValue(legacy: NormalizedBookingRequest): string | undefined {
  const date = legacy.date;
  if (!date) return undefined;
  if (date.kind === 'exact_date' && date.value) return `absolute:${date.value}`;
  if (date.kind === 'weekday' && date.weekday !== undefined) return `weekday:${date.weekday}`;
  if (date.kind === 'date_range' && date.value && date.endValue) return `range:${date.value}:${date.endValue}`;
  if (date.kind === 'relative_date' && date.relative) return `relative:${normalizeText(date.relative)}`;
  return undefined;
}

function providerDateValue(provider: CanonicalStructuredUnderstanding): string | undefined {
  const date = provider.entities.date?.value;
  if (!date) return undefined;
  if (date.kind === 'absolute' && date.value) return `absolute:${date.value}`;
  if (date.kind === 'weekday' && date.weekday !== undefined) return `weekday:${date.weekday}`;
  if (date.kind === 'range' && date.value && date.endValue) return `range:${date.value}:${date.endValue}`;
  if (date.kind === 'relative' && date.relativeExpression) {
    return `relative:${normalizeText(date.relativeExpression)}`;
  }
  return undefined;
}

function compareField(
  field: ShadowComparisonFieldName,
  legacy: Projection,
  provider: Projection,
): ShadowFieldComparison {
  let status: ShadowComparisonStatus;
  if (!legacy.comparable || !provider.comparable) status = 'not_comparable';
  else if (legacy.present && provider.present) status = legacy.value === provider.value ? 'agreement' : 'conflict';
  else if (legacy.present) status = 'legacy_only';
  else if (provider.present) status = 'provider_only';
  else status = 'agreement';
  return Object.freeze({
    field,
    status,
    legacyPresent: legacy.present,
    providerPresent: provider.present,
    ...(bucket(provider.confidence) ? { providerConfidenceBucket: bucket(provider.confidence) } : {}),
  });
}

export function compareStructuredUnderstanding(
  legacy: NormalizedBookingRequest,
  provider: CanonicalStructuredUnderstanding,
  signals: LegacyUnderstandingSignals = {},
): ShadowUnderstandingComparison {
  const providerIntents = new Set(provider.intents.map((entry) => entry.value));
  const providerIntentConfidence = provider.intents.length
    ? Math.max(...provider.intents.map((entry) => entry.confidence))
    : undefined;
  const legacyCorrectionTargets = legacy.customerCorrection
    ? [
        ...(legacy.customerCorrection.replacesService ? ['service'] : []),
        ...(legacy.customerCorrection.replacesDate ? ['date'] : []),
        ...(legacy.customerCorrection.replacesTime ? ['time'] : []),
      ].sort().join(',')
    : undefined;
  const providerCorrectionTargets = provider.correction?.value.targets.slice().sort().join(',');
  const providerConfirmation = provider.acts.bookingConfirmation;
  const providerConfirmed = providerConfirmation?.value === 'affirmed'
    ? true
    : providerConfirmation?.value === 'rejected'
      ? false
      : undefined;
  const providerRejected = providerConfirmation?.value === 'rejected'
    ? true
    : providerConfirmation?.value === 'affirmed'
      ? false
      : undefined;

  const fields: ShadowFieldComparison[] = [
    compareField('language', present(legacy.language), present(provider.language.primary.value, provider.language.primary.confidence)),
    compareField('booking_intent', present(String(legacy.intent === 'new_booking')), present(String(providerIntents.has('new_booking') || provider.acts.bookingRequest?.value === true), provider.acts.bookingRequest?.confidence ?? providerIntentConfidence)),
    compareField('confirmation', booleanProjection(signals.confirmation), booleanProjection(providerConfirmed, providerConfirmation?.confidence)),
    compareField('rejection', booleanProjection(signals.rejection), booleanProjection(providerRejected, providerConfirmation?.confidence)),
    compareField('service', legacy.service?.normalized ? present(normalizeText(legacy.service.normalized) as string) : absent(), provider.entities.service ? present(normalizeText(provider.entities.service.value.statedValue) as string, provider.entities.service.confidence) : absent()),
    compareField('date', legacyDateValue(legacy) ? present(legacyDateValue(legacy) as string) : absent(), providerDateValue(provider) ? present(providerDateValue(provider) as string, provider.entities.date?.confidence) : absent()),
    compareField('time_constraint', legacyTimeValue(legacy.timeConstraint) ? present(legacyTimeValue(legacy.timeConstraint) as string) : absent(), providerTimeValue(provider.entities.time?.value) ? present(providerTimeValue(provider.entities.time?.value) as string, provider.entities.time?.confidence) : absent()),
    compareField('name_presence', signals.namePresent === undefined ? absent(false) : signals.namePresent ? present('true') : absent(), provider.entities.name ? present('true', provider.entities.name.confidence) : absent()),
    compareField('phone_presence', signals.phonePresent === undefined ? absent(false) : signals.phonePresent ? present('true') : absent(), provider.entities.phone ? present('true', provider.entities.phone.confidence) : absent()),
    compareField('slot_reference', signals.slotReferencePresent === undefined ? absent(false) : signals.slotReferencePresent ? present('true') : absent(), provider.entities.slotReference ? present('true', provider.entities.slotReference.confidence) : absent()),
    compareField('correction', legacyCorrectionTargets ? present(legacyCorrectionTargets) : absent(), providerCorrectionTargets ? present(providerCorrectionTargets, provider.correction?.confidence) : absent()),
    compareField('cancellation', present(String(legacy.intent === 'cancellation')), present(String(providerIntents.has('cancellation')), providerIntentConfidence)),
    compareField('reschedule', present(String(legacy.intent === 'reschedule')), present(String(providerIntents.has('reschedule')), providerIntentConfidence)),
    compareField('ambiguity', present(String(legacy.requiresClarification)), present(String(provider.ambiguities.length > 0 || providerConfirmation?.value === 'unclear'), providerConfirmation?.confidence)),
  ];
  const comparable = fields.filter((entry) => entry.status !== 'not_comparable');
  const disagreements = comparable.filter((entry) => entry.status !== 'agreement');
  return Object.freeze({
    fields: Object.freeze(fields),
    comparableFields: Object.freeze(comparable.map((entry) => entry.field)),
    agreementCount: comparable.length - disagreements.length,
    disagreementCount: disagreements.length,
    disagreementCategories: Object.freeze(disagreements.map((entry) => entry.field)),
  });
}
