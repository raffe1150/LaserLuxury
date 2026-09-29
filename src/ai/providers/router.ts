import type {
  AiProviderAdapter,
  AiProviderName,
  UnifiedAiGenerationRequest,
  UnifiedAiGenerationResponse,
} from "./provider";
import { getConfiguredAiProvider } from "./provider";
import { generateWithOpenAi, transcribeWithOpenAi } from "./openai";

const geminiCapabilities = {
  textGeneration: true,
  toolCalling: true,
  transcription: true,
  speechSynthesis: false,
  realtimeVoice: false,
} as const;

const openAiAdapter: AiProviderAdapter = {
  name: "openai",

  capabilities: {
    textGeneration: true,
    toolCalling: true,
    transcription: true,
    speechSynthesis: false,
    realtimeVoice: false,
  },

  generate: generateWithOpenAi,
  transcribe: transcribeWithOpenAi,
};

const providerRegistry: Partial<Record<AiProviderName, AiProviderAdapter>> = {
  openai: openAiAdapter,
};

export function getAiProviderAdapter(
  provider: AiProviderName = getConfiguredAiProvider(),
): AiProviderAdapter | null {
  return providerRegistry[provider] || null;
}

export function getAiProviderCapabilities(
  provider: AiProviderName = getConfiguredAiProvider(),
) {
  return provider === "gemini"
    ? geminiCapabilities
    : getAiProviderAdapter(provider)?.capabilities || null;
}

export function normalizeGenerationRequestForProvider(
  provider: AiProviderName,
  request: UnifiedAiGenerationRequest,
): UnifiedAiGenerationRequest {
  if (provider !== "openai") {
    return request;
  }

  const requestedModel = String(request.model || "").trim();

  // Existing OdinLink call sites still often pass Gemini model names.
  // Never forward those model names to OpenAI.
  if (requestedModel.startsWith("gemini-")) {
    return {
      ...request,
      model: undefined,
    };
  }

  return request;
}

export async function generateWithConfiguredProvider(
  request: UnifiedAiGenerationRequest,
): Promise<UnifiedAiGenerationResponse> {
  const provider = getConfiguredAiProvider();
  const adapter = getAiProviderAdapter(provider);

  if (!adapter?.generate) {
    throw new Error(
      `Text generation is not implemented for AI provider: ${provider}`,
    );
  }

  return adapter.generate(
    normalizeGenerationRequestForProvider(provider, request),
  );
}

export async function transcribeWithConfiguredProvider(
  request: Parameters<NonNullable<AiProviderAdapter["transcribe"]>>[0],
): Promise<Awaited<ReturnType<NonNullable<AiProviderAdapter["transcribe"]>>>> {
  const provider = getConfiguredAiProvider();
  const adapter = getAiProviderAdapter(provider);

  if (!adapter?.transcribe) {
    throw new Error(
      `Transcription is not implemented for AI provider: ${provider}`,
    );
  }

  return adapter.transcribe(request);
}
