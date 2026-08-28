import type { UnderstandingProvider } from './provider';
import type { StructuredUnderstandingFailureCategory } from './provider-error';
import {
  GeminiUnderstandingProvider,
  createGoogleGenAiUnderstandingTransport,
} from './providers/gemini';

export type StructuredUnderstandingConfiguration = {
  enabled: boolean;
  shadowMode: boolean;
  adoptionEnabled: boolean;
  shadowMaxConcurrency: number;
  provider: string;
  model: string;
  timeoutMs: number;
};

export type ConfiguredUnderstandingProvider =
  | { status: 'disabled'; provider: null; config: StructuredUnderstandingConfiguration }
  | { status: 'missing_configuration'; provider: null; config: StructuredUnderstandingConfiguration }
  | { status: 'ready'; provider: UnderstandingProvider; config: StructuredUnderstandingConfiguration };

type ProviderFactory = (options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}) => UnderstandingProvider;

export type StructuredUnderstandingFactoryDependencies = {
  createGeminiProvider?: ProviderFactory;
};

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_SHADOW_MAX_CONCURRENCY = 2;

function configuredTimeout(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(10_000, Math.max(500, Math.floor(parsed)));
}

function configuredShadowMaxConcurrency(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SHADOW_MAX_CONCURRENCY;
  return Math.min(8, Math.max(1, Math.floor(parsed)));
}

export function readStructuredUnderstandingConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StructuredUnderstandingConfiguration {
  return {
    enabled: String(environment.STRUCTURED_UNDERSTANDING_ENABLED || '').trim().toLowerCase() === 'true',
    shadowMode: String(environment.STRUCTURED_UNDERSTANDING_SHADOW_MODE || '').trim().toLowerCase() === 'true',
    adoptionEnabled: String(environment.STRUCTURED_UNDERSTANDING_ADOPTION_ENABLED || '').trim().toLowerCase() === 'true',
    shadowMaxConcurrency: configuredShadowMaxConcurrency(
      environment.STRUCTURED_UNDERSTANDING_SHADOW_MAX_CONCURRENCY,
    ),
    provider: String(environment.STRUCTURED_UNDERSTANDING_PROVIDER || 'gemini').trim().toLowerCase(),
    model: String(environment.STRUCTURED_UNDERSTANDING_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: configuredTimeout(environment.STRUCTURED_UNDERSTANDING_TIMEOUT_MS),
  };
}

export function createConfiguredUnderstandingProvider(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: StructuredUnderstandingFactoryDependencies = {},
): ConfiguredUnderstandingProvider {
  const config = readStructuredUnderstandingConfiguration(environment);
  if (!config.enabled) return { status: 'disabled', provider: null, config };

  const apiKey = String(environment.GEMINI_API_KEY || '').trim();
  if (config.provider !== 'gemini' || !config.model || !apiKey) {
    return { status: 'missing_configuration', provider: null, config };
  }

  const createProvider = dependencies.createGeminiProvider || ((options) => new GeminiUnderstandingProvider({
    model: options.model,
    timeoutMs: options.timeoutMs,
    transport: createGoogleGenAiUnderstandingTransport(options.apiKey),
  }));
  return {
    status: 'ready',
    provider: createProvider({ apiKey, model: config.model, timeoutMs: config.timeoutMs }),
    config,
  };
}

export function isStructuredUnderstandingUnavailable(
  status: ConfiguredUnderstandingProvider['status'],
): status is Extract<StructuredUnderstandingFailureCategory, 'disabled' | 'missing_configuration'> {
  return status === 'disabled' || status === 'missing_configuration';
}
