import type { UnifiedAudioInput } from "./audio";

export type AiProviderName = "gemini" | "openai";

export type AiProviderCapability =
  | "text_generation"
  | "tool_calling"
  | "transcription"
  | "speech_synthesis"
  | "realtime_voice";

export interface AiProviderCapabilities {
  textGeneration: boolean;
  toolCalling: boolean;
  transcription: boolean;
  speechSynthesis: boolean;
  realtimeVoice: boolean;
}

export function getConfiguredAiProvider(): AiProviderName {
  const raw = String(process.env.AI_PROVIDER || "")
    .trim()
    .toLowerCase();

  if (!raw) return "openai";
  if (raw === "openai") return "openai";
  if (raw === "gemini") return "gemini";

  throw new Error(
    'Invalid AI_PROVIDER configuration. Expected "openai" or "gemini".',
  );
}

export interface UnifiedAiGenerationRequest {
  diagnosticContext?: { correlationId?: string };
  messages: any[];
  tools?: any[];
  systemInstruction?: string;
  model?: string;
  temperature?: number;
}

export interface UnifiedAiGenerationResponse {
  text: string;
  functionCalls: Array<{
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface UnifiedAiTranscriptionRequest {
  audio: UnifiedAudioInput;
  language?: string;
  model?: string;
}

export interface UnifiedAiTranscriptionResponse {
  text: string;
}

export interface UnifiedAiSpeechRequest {
  text: string;
  voice?: string;
  model?: string;
  format?: string;
}

export interface UnifiedAiSpeechResponse {
  audio: Uint8Array;
  contentType?: string;
}

export interface AiProviderAdapter {
  name: AiProviderName;
  capabilities: AiProviderCapabilities;

  generate?: (
    request: UnifiedAiGenerationRequest,
  ) => Promise<UnifiedAiGenerationResponse>;

  transcribe?: (
    request: UnifiedAiTranscriptionRequest,
  ) => Promise<UnifiedAiTranscriptionResponse>;

  synthesizeSpeech?: (
    request: UnifiedAiSpeechRequest,
  ) => Promise<UnifiedAiSpeechResponse>;
}
