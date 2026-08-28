import type { CanonicalStructuredUnderstanding } from './types';
import {
  createConfiguredUnderstandingProvider,
  readStructuredUnderstandingConfiguration,
  type StructuredUnderstandingFactoryDependencies,
} from './config';
import type { UnderstandingProvider, UnderstandingProviderInput } from './provider';
import { StructuredUnderstandingProviderError } from './provider-error';
import { decodeCanonicalStructuredUnderstanding } from './validation';

export const STRUCTURED_UNDERSTANDING_HIGH_CONFIDENCE = 0.8;

export type ControlledRelativeDateSemantic = 'today' | 'tomorrow' | 'day_after_tomorrow';

export type ControlledAdoptionField =
  | 'booking_intent'
  | 'relative_date'
  | 'time'
  | 'confirmation'
  | 'name'
  | 'phone';
export type ControlledAdoptionDisposition =
  | 'shadow_only'
  | 'provider_adopted'
  | 'provider_rejected_low_confidence'
  | 'provider_rejected_conflict'
  | 'provider_rejected_validation'
  | 'legacy_preserved';

export type ControlledAdoptionDecision = Readonly<{
  field: ControlledAdoptionField;
  disposition: ControlledAdoptionDisposition;
  legacyPresent: boolean;
  providerPresent: boolean;
  providerConfidenceBucket?: 'low' | 'medium' | 'high';
  finalCanonicalSource: 'legacy' | 'provider' | 'none';
}>;

export type ControlledUnderstandingCandidates = Readonly<{
  bookingIntent?: 'new_booking';
  relativeDate?: ControlledRelativeDateSemantic;
  time?: string;
  confirmation?: true;
  name?: string;
  phone?: string;
}>;

export type ControlledAdoptionResolution = Readonly<{
  candidates: ControlledUnderstandingCandidates;
  decisions: readonly ControlledAdoptionDecision[];
}>;

type ResolveControlledAdoptionInput = {
  provider: CanonicalStructuredUnderstanding;
  legacy: Readonly<{
    time?: string | null;
    confirmation?: true;
    rejection?: true;
    name?: string | null;
    phone?: string | null;
    intent?: string | null;
    relativeDate?: string | null;
    blocksNewBookingIntent?: boolean;
    blocksRelativeDate?: boolean;
  }>;
  validateOwnedTime: (value: string) => string | null;
  validateName: (value: string) => string | null;
  validatePhone: (value: string) => string | null;
};

function confidenceBucket(confidence: number | undefined): 'low' | 'medium' | 'high' | undefined {
  if (confidence === undefined) return undefined;
  if (confidence >= STRUCTURED_UNDERSTANDING_HIGH_CONFIDENCE) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function normalizedComparable(value: string | null | undefined): string {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

export function normalizeControlledRelativeDateSemantic(
  value: string | null | undefined,
): ControlledRelativeDateSemantic | null {
  const normalized = normalizedComparable(value).replace(/[\s-]+/g, '_');
  return ['today', 'tomorrow', 'day_after_tomorrow'].includes(normalized)
    ? normalized as ControlledRelativeDateSemantic
    : null;
}

function decision(
  field: ControlledAdoptionField,
  disposition: ControlledAdoptionDisposition,
  legacyPresent: boolean,
  providerPresent: boolean,
  confidence?: number,
  finalCanonicalSource: ControlledAdoptionDecision['finalCanonicalSource'] = 'none',
): ControlledAdoptionDecision {
  return Object.freeze({
    field,
    disposition,
    legacyPresent,
    providerPresent,
    ...(confidenceBucket(confidence) ? { providerConfidenceBucket: confidenceBucket(confidence) } : {}),
    finalCanonicalSource,
  });
}

function resolveCandidate(params: {
  field: Exclude<ControlledAdoptionField, 'confirmation'>;
  legacy?: string | null;
  provider?: string;
  confidence?: number;
  validate: (value: string) => string | null;
}): { value?: string; decision: ControlledAdoptionDecision } {
  const legacy = params.legacy ? params.validate(params.legacy) : null;
  const providerPresent = Boolean(params.provider);
  if (!providerPresent) {
    return { decision: decision(params.field, 'shadow_only', Boolean(legacy), false, undefined, legacy ? 'legacy' : 'none') };
  }
  if ((params.confidence ?? 0) < STRUCTURED_UNDERSTANDING_HIGH_CONFIDENCE) {
    return { decision: decision(params.field, 'provider_rejected_low_confidence', Boolean(legacy), true, params.confidence, legacy ? 'legacy' : 'none') };
  }
  const provider = params.validate(params.provider as string);
  if (!provider) {
    return { decision: decision(params.field, 'provider_rejected_validation', Boolean(legacy), true, params.confidence, legacy ? 'legacy' : 'none') };
  }
  if (legacy) {
    const same = normalizedComparable(legacy) === normalizedComparable(provider);
    return {
      decision: decision(
        params.field,
        same ? 'legacy_preserved' : 'provider_rejected_conflict',
        true,
        true,
        params.confidence,
        'legacy',
      ),
    };
  }
  return {
    value: provider,
    decision: decision(params.field, 'provider_adopted', false, true, params.confidence, 'provider'),
  };
}

export function resolveControlledUnderstandingAdoption(
  input: ResolveControlledAdoptionInput,
): ControlledAdoptionResolution {
  const providerNewBookingIntent = input.provider.intents.find(
    (entry) => entry.value === 'new_booking',
  );
  const providerBookingRequest = input.provider.acts.bookingRequest;
  const providerIntentPresent = Boolean(
    providerNewBookingIntent || providerBookingRequest?.value === true,
  );
  const providerIntentConfidence = Math.max(
    providerNewBookingIntent?.confidence ?? 0,
    providerBookingRequest?.value === true ? providerBookingRequest.confidence : 0,
  );
  const providerHasConflictingIntent = input.provider.intents.some(
    (entry) => ['cancellation', 'reschedule', 'booking_lookup'].includes(entry.value),
  ) || providerBookingRequest?.value === false;
  const legacyIntent = normalizedComparable(input.legacy.intent);
  let adoptedBookingIntent: 'new_booking' | undefined;
  let bookingIntentDecision: ControlledAdoptionDecision;
  if (!providerIntentPresent) {
    bookingIntentDecision = decision(
      'booking_intent', 'shadow_only', legacyIntent === 'new_booking', false,
      undefined, legacyIntent === 'new_booking' ? 'legacy' : 'none',
    );
  } else if (providerIntentConfidence < STRUCTURED_UNDERSTANDING_HIGH_CONFIDENCE) {
    bookingIntentDecision = decision(
      'booking_intent', 'provider_rejected_low_confidence', Boolean(legacyIntent), true,
      providerIntentConfidence, legacyIntent ? 'legacy' : 'none',
    );
  } else if (legacyIntent === 'new_booking') {
    bookingIntentDecision = decision(
      'booking_intent', 'legacy_preserved', true, true,
      providerIntentConfidence, 'legacy',
    );
  } else if (
    input.legacy.blocksNewBookingIntent ||
    providerHasConflictingIntent ||
    input.provider.acts.bookingConfirmation?.value === 'rejected' ||
    !['', 'unknown', 'clarification', 'general_question'].includes(legacyIntent)
  ) {
    bookingIntentDecision = decision(
      'booking_intent', 'provider_rejected_conflict', Boolean(legacyIntent), true,
      providerIntentConfidence, legacyIntent ? 'legacy' : 'none',
    );
  } else {
    adoptedBookingIntent = 'new_booking';
    bookingIntentDecision = decision(
      'booking_intent', 'provider_adopted', Boolean(legacyIntent), true,
      providerIntentConfidence, 'provider',
    );
  }

  const providerDate = input.provider.entities.date;
  const providerRelativePresent = providerDate?.value.kind === 'relative';
  const providerRelative = providerRelativePresent
    ? normalizeControlledRelativeDateSemantic(providerDate.value.relativeExpression)
    : null;
  const legacyRelative = normalizeControlledRelativeDateSemantic(input.legacy.relativeDate);
  let adoptedRelativeDate: ControlledRelativeDateSemantic | undefined;
  let relativeDateDecision: ControlledAdoptionDecision;
  if (!providerRelativePresent) {
    relativeDateDecision = decision(
      'relative_date', 'shadow_only', Boolean(input.legacy.relativeDate), false,
      undefined, input.legacy.relativeDate ? 'legacy' : 'none',
    );
  } else if ((providerDate?.confidence ?? 0) < STRUCTURED_UNDERSTANDING_HIGH_CONFIDENCE) {
    relativeDateDecision = decision(
      'relative_date', 'provider_rejected_low_confidence', Boolean(input.legacy.relativeDate), true,
      providerDate?.confidence, input.legacy.relativeDate ? 'legacy' : 'none',
    );
  } else if (!providerRelative) {
    relativeDateDecision = decision(
      'relative_date', 'provider_rejected_validation', Boolean(input.legacy.relativeDate), true,
      providerDate?.confidence, input.legacy.relativeDate ? 'legacy' : 'none',
    );
  } else if (legacyRelative === providerRelative && !input.legacy.blocksRelativeDate) {
    relativeDateDecision = decision(
      'relative_date', 'legacy_preserved', true, true,
      providerDate?.confidence, 'legacy',
    );
  } else if (input.legacy.relativeDate || input.legacy.blocksRelativeDate) {
    relativeDateDecision = decision(
      'relative_date', 'provider_rejected_conflict', Boolean(input.legacy.relativeDate), true,
      providerDate?.confidence, input.legacy.relativeDate ? 'legacy' : 'none',
    );
  } else {
    adoptedRelativeDate = providerRelative;
    relativeDateDecision = decision(
      'relative_date', 'provider_adopted', false, true,
      providerDate?.confidence, 'provider',
    );
  }

  const slotTime = input.provider.entities.slotReference?.value.kind === 'time'
    ? input.provider.entities.slotReference.value.time
    : undefined;
  const exactTime = input.provider.entities.time?.value.kind === 'exact'
    ? input.provider.entities.time.value.start
    : undefined;
  const providerTimeConflict = Boolean(slotTime && exactTime && slotTime !== exactTime);
  const timeConfidence = Math.max(
    input.provider.entities.slotReference?.confidence ?? 0,
    input.provider.entities.time?.confidence ?? 0,
  );
  const time = providerTimeConflict
    ? {
        decision: decision(
          'time',
          'provider_rejected_conflict',
          Boolean(input.legacy.time),
          true,
          timeConfidence,
          input.legacy.time ? 'legacy' : 'none',
        ),
      }
    : resolveCandidate({
        field: 'time',
        legacy: input.legacy.time,
        provider: slotTime || exactTime,
        confidence: timeConfidence || undefined,
        validate: input.validateOwnedTime,
      });

  const providerConfirmation = input.provider.acts.bookingConfirmation;
  let confirmationDecision: ControlledAdoptionDecision;
  let adoptedConfirmation: true | undefined;
  if (!providerConfirmation || providerConfirmation.value !== 'affirmed') {
    confirmationDecision = decision(
      'confirmation',
      'shadow_only',
      Boolean(input.legacy.confirmation),
      Boolean(providerConfirmation),
      providerConfirmation?.confidence,
      input.legacy.confirmation ? 'legacy' : 'none',
    );
  } else if (providerConfirmation.confidence < STRUCTURED_UNDERSTANDING_HIGH_CONFIDENCE) {
    confirmationDecision = decision(
      'confirmation',
      'provider_rejected_low_confidence',
      Boolean(input.legacy.confirmation),
      true,
      providerConfirmation.confidence,
      input.legacy.confirmation ? 'legacy' : 'none',
    );
  } else if (input.legacy.rejection) {
    confirmationDecision = decision(
      'confirmation', 'provider_rejected_conflict', false, true,
      providerConfirmation.confidence, 'legacy',
    );
  } else if (input.legacy.confirmation) {
    confirmationDecision = decision(
      'confirmation', 'legacy_preserved', true, true,
      providerConfirmation.confidence, 'legacy',
    );
  } else {
    adoptedConfirmation = true;
    confirmationDecision = decision(
      'confirmation', 'provider_adopted', false, true,
      providerConfirmation.confidence, 'provider',
    );
  }

  const name = resolveCandidate({
    field: 'name',
    legacy: input.legacy.name,
    provider: input.provider.entities.name?.value,
    confidence: input.provider.entities.name?.confidence,
    validate: input.validateName,
  });
  const phone = resolveCandidate({
    field: 'phone',
    legacy: input.legacy.phone,
    provider: input.provider.entities.phone?.value,
    confidence: input.provider.entities.phone?.confidence,
    validate: input.validatePhone,
  });
  return Object.freeze({
    candidates: Object.freeze({
      ...(adoptedBookingIntent ? { bookingIntent: adoptedBookingIntent } : {}),
      ...(adoptedRelativeDate ? { relativeDate: adoptedRelativeDate } : {}),
      ...(time.value ? { time: time.value } : {}),
      ...(adoptedConfirmation ? { confirmation: adoptedConfirmation } : {}),
      ...(name.value ? { name: name.value } : {}),
      ...(phone.value ? { phone: phone.value } : {}),
    }),
    decisions: Object.freeze([
      bookingIntentDecision,
      relativeDateDecision,
      time.decision,
      confirmationDecision,
      name.decision,
      phone.decision,
    ]),
  });
}

export type StructuredUnderstandingAdoptionTelemetry = Readonly<{
  eventName: 'structured_understanding_adoption';
  schemaVersion: 1;
  correlationId: string;
  provider: string;
  model: string;
  outcome: 'success' | 'failure' | 'skipped';
  failureCategory?: string;
  decisions: readonly ControlledAdoptionDecision[];
}>;

type AdoptionTelemetrySink = (event: StructuredUnderstandingAdoptionTelemetry) => void;

function safeEmit(sink: AdoptionTelemetrySink, event: StructuredUnderstandingAdoptionTelemetry): void {
  try { sink(event); } catch { /* observation must not affect booking */ }
}

export interface UnderstandingAdoptionRuntime {
  evaluate(input: UnderstandingProviderInput, correlationId: string): Promise<CanonicalStructuredUnderstanding | null>;
  emitDecisions(correlationId: string, decisions: readonly ControlledAdoptionDecision[]): void;
}

function createAdoptionRuntime(options: {
  provider: UnderstandingProvider;
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  emit?: AdoptionTelemetrySink;
}): UnderstandingAdoptionRuntime {
  const emit = options.emit || ((event) => console.info('[StructuredUnderstandingAdoption]', event));
  let active = 0;
  const completed = new Set<string>();
  const order: string[] = [];
  const remember = (correlationId: string): boolean => {
    if (completed.has(correlationId)) return false;
    completed.add(correlationId);
    order.push(correlationId);
    if (order.length > 1_024) {
      const oldest = order.shift();
      if (oldest) completed.delete(oldest);
    }
    return true;
  };
  return {
    async evaluate(input, correlationId) {
      if (!remember(correlationId)) return null;
      if (active >= options.maxConcurrency) {
        safeEmit(emit, Object.freeze({
          eventName: 'structured_understanding_adoption', schemaVersion: 1,
          correlationId, provider: options.provider.providerId, model: options.model,
          outcome: 'skipped', failureCategory: 'concurrency_limit', decisions: Object.freeze([]),
        }));
        return null;
      }
      active += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const output = await options.provider.interpret(input, { signal: controller.signal });
        const decoded = decodeCanonicalStructuredUnderstanding(output);
        if (!decoded.ok) throw new StructuredUnderstandingProviderError('schema_validation_failed');
        return decoded.value;
      } catch (error) {
        const failureCategory = error instanceof StructuredUnderstandingProviderError
          ? error.category
          : 'unexpected_error';
        safeEmit(emit, Object.freeze({
          eventName: 'structured_understanding_adoption', schemaVersion: 1,
          correlationId, provider: options.provider.providerId, model: options.model,
          outcome: 'failure', failureCategory, decisions: Object.freeze([]),
        }));
        return null;
      } finally {
        clearTimeout(timer);
        active -= 1;
      }
    },
    emitDecisions(correlationId, decisions) {
      safeEmit(emit, Object.freeze({
        eventName: 'structured_understanding_adoption', schemaVersion: 1,
        correlationId, provider: options.provider.providerId, model: options.model,
        outcome: 'success', decisions: Object.freeze([...decisions]),
      }));
    },
  };
}

export type ConfiguredUnderstandingAdoptionRuntime = Readonly<{
  status: 'disabled' | 'missing_configuration' | 'ready';
  runtime: UnderstandingAdoptionRuntime | null;
}>;

export function createConfiguredUnderstandingAdoptionRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: StructuredUnderstandingFactoryDependencies & { emitAdoption?: AdoptionTelemetrySink } = {},
): ConfiguredUnderstandingAdoptionRuntime {
  const config = readStructuredUnderstandingConfiguration(environment);
  if (!config.enabled || !config.adoptionEnabled) return Object.freeze({ status: 'disabled', runtime: null });
  const configured = createConfiguredUnderstandingProvider(environment, dependencies);
  if (configured.status !== 'ready') return Object.freeze({ status: 'missing_configuration', runtime: null });
  return Object.freeze({
    status: 'ready',
    runtime: createAdoptionRuntime({
      provider: configured.provider,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.shadowMaxConcurrency,
      emit: dependencies.emitAdoption,
    }),
  });
}
