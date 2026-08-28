import type { NormalizedBookingRequest } from '../booking-intelligence';
import {
  createConfiguredUnderstandingProvider,
  readStructuredUnderstandingConfiguration,
  type StructuredUnderstandingFactoryDependencies,
} from './config';
import {
  compareStructuredUnderstanding,
  type LegacyUnderstandingSignals,
  type ShadowComparisonFieldName,
  type ShadowFieldComparison,
} from './comparison';
import type { UnderstandingProvider, UnderstandingProviderInput } from './provider';
import { StructuredUnderstandingProviderError } from './provider-error';
import { decodeCanonicalStructuredUnderstanding } from './validation';

export type ShadowFailureCategory =
  | 'timeout'
  | 'provider_error'
  | 'malformed_response'
  | 'schema_validation_failed'
  | 'unexpected_error'
  | 'concurrency_limit';

export type StructuredUnderstandingShadowTelemetry = Readonly<{
  eventName: 'structured_understanding_shadow';
  mode: 'shadow_only';
  schemaVersion: 1;
  correlationId: string;
  provider: string;
  model: string;
  languageCode: string;
  elapsedMs: number;
  outcome: 'success' | 'failure' | 'skipped';
  failureCategory?: ShadowFailureCategory;
  comparableFields: readonly ShadowComparisonFieldName[];
  agreementCount: number;
  disagreementCount: number;
  disagreementCategories: readonly ShadowComparisonFieldName[];
  fields: readonly ShadowFieldComparison[];
}>;

export type ShadowObservation = Readonly<{
  correlationId: string;
  providerInput: UnderstandingProviderInput;
  legacy: NormalizedBookingRequest;
  legacySignals?: LegacyUnderstandingSignals;
  eligible: boolean;
}>;

export interface UnderstandingShadowObserver {
  observe(observation: ShadowObservation): void;
  waitForIdle(): Promise<void>;
}

export type ShadowTelemetrySink = (event: StructuredUnderstandingShadowTelemetry) => void;

type ShadowObserverOptions = {
  provider: UnderstandingProvider;
  providerName: string;
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  emit?: ShadowTelemetrySink;
};

const MAX_REMEMBERED_TURNS = 1_024;

function defaultTelemetrySink(event: StructuredUnderstandingShadowTelemetry): void {
  console.info('[StructuredUnderstandingShadow]', event);
}

function safeEmit(sink: ShadowTelemetrySink, event: StructuredUnderstandingShadowTelemetry): void {
  try {
    sink(event);
  } catch {
    // Telemetry is observation-only and can never affect a customer turn.
  }
}

function emptyTelemetry(
  observation: ShadowObservation,
  options: ShadowObserverOptions,
  startedAt: number,
  outcome: 'failure' | 'skipped',
  failureCategory: ShadowFailureCategory,
): StructuredUnderstandingShadowTelemetry {
  return Object.freeze({
    eventName: 'structured_understanding_shadow',
    mode: 'shadow_only',
    schemaVersion: 1,
    correlationId: observation.correlationId,
    provider: options.providerName,
    model: options.model,
    languageCode: observation.legacy.language,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    outcome,
    failureCategory,
    comparableFields: Object.freeze([]),
    agreementCount: 0,
    disagreementCount: 0,
    disagreementCategories: Object.freeze([]),
    fields: Object.freeze([]),
  });
}

function categorizedFailure(error: unknown): ShadowFailureCategory {
  if (error instanceof StructuredUnderstandingProviderError) {
    return error.category === 'disabled' || error.category === 'missing_configuration'
      ? 'provider_error'
      : error.category;
  }
  return 'unexpected_error';
}

async function boundedInterpret(
  provider: UnderstandingProvider,
  input: UnderstandingProviderInput,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new StructuredUnderstandingProviderError('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      provider.interpret(input, { signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createStructuredUnderstandingShadowObserver(
  options: ShadowObserverOptions,
): UnderstandingShadowObserver {
  const sink = options.emit || defaultTelemetrySink;
  const inFlight = new Set<Promise<void>>();
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  const remember = (correlationId: string): boolean => {
    if (seen.has(correlationId)) return false;
    seen.add(correlationId);
    seenOrder.push(correlationId);
    if (seenOrder.length > MAX_REMEMBERED_TURNS) {
      const oldest = seenOrder.shift();
      if (oldest) seen.delete(oldest);
    }
    return true;
  };

  const execute = async (observation: ShadowObservation): Promise<void> => {
    const startedAt = Date.now();
    try {
      const output = await boundedInterpret(options.provider, observation.providerInput, options.timeoutMs);
      const decoded = decodeCanonicalStructuredUnderstanding(output);
      if (!decoded.ok) {
        const category = decoded.issues.some((issue) => issue.code === 'invalid_type' && issue.path === '$')
          ? 'malformed_response'
          : 'schema_validation_failed';
        throw new StructuredUnderstandingProviderError(category);
      }
      const comparison = compareStructuredUnderstanding(
        observation.legacy,
        decoded.value,
        observation.legacySignals,
      );
      safeEmit(sink, Object.freeze({
        eventName: 'structured_understanding_shadow',
        mode: 'shadow_only',
        schemaVersion: 1,
        correlationId: observation.correlationId,
        provider: options.providerName,
        model: options.model,
        languageCode: observation.legacy.language,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        outcome: 'success',
        comparableFields: comparison.comparableFields,
        agreementCount: comparison.agreementCount,
        disagreementCount: comparison.disagreementCount,
        disagreementCategories: comparison.disagreementCategories,
        fields: comparison.fields,
      }));
    } catch (error) {
      safeEmit(sink, emptyTelemetry(
        observation,
        options,
        startedAt,
        'failure',
        categorizedFailure(error),
      ));
    }
  };

  return {
    observe(observation): void {
      if (!observation.eligible || !remember(observation.correlationId)) return;
      if (inFlight.size >= options.maxConcurrency) {
        safeEmit(sink, emptyTelemetry(
          observation,
          options,
          Date.now(),
          'skipped',
          'concurrency_limit',
        ));
        return;
      }
      let task: Promise<void>;
      task = execute(observation)
        .catch(() => undefined)
        .finally(() => { inFlight.delete(task); });
      inFlight.add(task);
    },
    async waitForIdle(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

export type ConfiguredUnderstandingShadowRuntime = Readonly<{
  status: 'disabled' | 'missing_configuration' | 'ready';
  observer: UnderstandingShadowObserver | null;
}>;

export type StructuredUnderstandingShadowFactoryDependencies =
  StructuredUnderstandingFactoryDependencies & { emit?: ShadowTelemetrySink };

export function createConfiguredUnderstandingShadowRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: StructuredUnderstandingShadowFactoryDependencies = {},
): ConfiguredUnderstandingShadowRuntime {
  const config = readStructuredUnderstandingConfiguration(environment);
  if (!config.enabled || !config.shadowMode) return Object.freeze({ status: 'disabled', observer: null });
  const configured = createConfiguredUnderstandingProvider(environment, dependencies);
  if (configured.status !== 'ready') {
    return Object.freeze({ status: 'missing_configuration', observer: null });
  }
  return Object.freeze({
    status: 'ready',
    observer: createStructuredUnderstandingShadowObserver({
      provider: configured.provider,
      providerName: configured.provider.providerId,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.shadowMaxConcurrency,
      emit: dependencies.emit,
    }),
  });
}
