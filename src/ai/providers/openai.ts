import OpenAI, { toFile } from "openai";
import type { EmbeddingVector } from "../embeddings";
import { buildOpenAiFailureDiagnostic } from "./openai-diagnostic";
import { normalizeOpenAiToolSchema } from "./openai-tool-schema";
import type {
  UnifiedAiGenerationRequest,
  UnifiedAiGenerationResponse,
  UnifiedAiTranscriptionRequest,
  UnifiedAiTranscriptionResponse,
} from "./provider";

export function toOpenAiTools(tools?: any[]): any[] | undefined {
  const declarations = tools?.[0]?.functionDeclarations;
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return undefined;
  }

  return declarations.map((fn: any) => ({
    type: "function",
    name: fn.name,
    description: fn.description,
    strict: false,
    parameters: fn.parameters ? normalizeOpenAiToolSchema(fn.parameters) : {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
  }));
}

export function toOpenAiInput(messages: any[]): any[] {
  return messages.map((m: any) => {
    if (m.role === "tool") {
      return {
        type: "function_call_output",
        call_id: m.id,
        output: String(m.content ?? ""),
      };
    }

    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const items: any[] = [];

      if (typeof m.content === "string" && m.content.trim()) {
        items.push({
          role: "assistant",
          content: m.content,
        });
      }

      for (const call of m.tool_calls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }

      return items;
    }

    if (Array.isArray(m.content)) {
      throw new Error("OpenAI text generation does not accept provider-specific inline audio content");
    }

    return {
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    };
  }).flat();
}

export function resolveOpenAiTextModel(requestedModel?: string): string {
  const requested = String(requestedModel || "").trim();
  if (requested && !requested.toLowerCase().startsWith("gemini-")) {
    return requested;
  }
  return process.env.OPENAI_MODEL || "gpt-5.6-luna";
}

// Only documented non-reasoning Responses models accept temperature in this
// runtime. Reasoning models can require an explicit reasoning effort; this
// adapter does not set one, so unknown models and snapshots omit temperature.
const OPENAI_TEMPERATURE_MODELS = new Set([
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini",
  "gpt-4.1-2025-04-14", "gpt-4.1-mini-2025-04-14", "gpt-4.1-nano-2025-04-14",
  "gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18",
]);

export function normalizeOpenAiGenerationResponse(
  response: any,
): UnifiedAiGenerationResponse {
  const functionCalls = Array.isArray(response?.output)
    ? response.output
        .filter((item: any) => item?.type === "function_call")
        .map((item: any) => ({
          id: item.call_id || item.id,
          function: {
            name: item.name,
            arguments: item.arguments || "{}",
          },
        }))
    : [];

  return {
    text: String(response?.output_text || ""),
    functionCalls,
  };
}

export async function generateWithOpenAi(
  request: UnifiedAiGenerationRequest,
): Promise<UnifiedAiGenerationResponse> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
  });

  const model = resolveOpenAiTextModel(request.model);
  const tools = toOpenAiTools(request.tools);
  const params = {
    model,
    instructions: request.systemInstruction,
    input: toOpenAiInput(request.messages),
    tools,
    ...(request.structuredOutput ? {
      text: {
        format: {
          type: "json_schema",
          name: request.structuredOutput.name,
          schema: request.structuredOutput.schema,
          ...(request.structuredOutput.description
            ? { description: request.structuredOutput.description }
            : {}),
          ...(request.structuredOutput.strict !== undefined
            ? { strict: request.structuredOutput.strict }
            : {}),
        },
      },
    } : {}),
    ...(request.temperature !== undefined && OPENAI_TEMPERATURE_MODELS.has(model)
      ? { temperature: request.temperature }
      : {}),
  };
  let response;
  try {
    response = await client.responses.create(params as any, request.signal ? { signal: request.signal } : undefined);
  } catch (error) {
    console.error("[OpenAIProviderFailure]", buildOpenAiFailureDiagnostic(error, {
      model,
      toolCount: tools?.length || 0,
      correlationId: request.diagnosticContext?.correlationId,
    }));
    throw error;
  }

  return normalizeOpenAiGenerationResponse(response);
}

const transcriptionPrompt =
  "Transcribe exactly in the spoken language; never translate. Preserve names and spoken digits exactly. " +
  "Never guess unclear names, phone numbers, dates, or times; write [unclear] for an unclear segment. " +
  "Return only the transcript without a label, explanation, markdown, or quotation marks.";

function audioFileExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "audio/flac": "flac",
    "audio/mp3": "mp3",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mpga": "mpga",
    "audio/m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
  };
  return extensions[mimeType] || "audio";
}

export async function buildOpenAiTranscriptionParams(
  request: UnifiedAiTranscriptionRequest,
  fileFactory: typeof toFile = toFile,
): Promise<any> {
  const { audio } = request;
  const file = await fileFactory(
    Buffer.from(audio.data, "base64"),
    `voice-message.${audioFileExtension(audio.mimeType)}`,
    { type: audio.mimeType },
  );

  return {
    file,
    model: request.model || process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
    prompt: transcriptionPrompt,
    response_format: "json",
  };
}

export function normalizeOpenAiTranscriptionResponse(
  response: unknown,
): UnifiedAiTranscriptionResponse {
  return {
    text: typeof (response as any)?.text === "string"
      ? (response as any).text
      : "",
  };
}

export async function transcribeWithOpenAi(
  request: UnifiedAiTranscriptionRequest,
): Promise<UnifiedAiTranscriptionResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const client = new OpenAI({ apiKey, maxRetries: 0 });
  const response = await client.audio.transcriptions.create(
    await buildOpenAiTranscriptionParams(request),
  );

  return normalizeOpenAiTranscriptionResponse(response);
}

// Separate from the conversation model: the database's existing vector width is 768.
export async function embedWithOpenAi(texts: string[]): Promise<EmbeddingVector[]> {
  if (!texts.length || texts.some((text) => !text.trim())) {
    throw new Error("Embedding input must contain non-empty text.");
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 20_000 });
  const model = "text-embedding-3-small";
  const dimensions = 768;
  const response = await client.embeddings.create({
    model, input: texts, dimensions, encoding_format: "float",
  });
  if (!Array.isArray(response.data) || response.data.length !== texts.length) {
    throw new Error("Embedding provider returned an unexpected result count.");
  }
  const ordered = [...response.data].sort((a, b) => a.index - b.index);
  return ordered.map((item, index) => {
    if (item.index !== index || !Array.isArray(item.embedding) ||
        item.embedding.length !== dimensions || item.embedding.some((value) => !Number.isFinite(value))) {
      throw new Error("Embedding provider returned an invalid vector.");
    }
    return { values: item.embedding, provider: "openai", model, dimensions, version: 1 };
  });
}
