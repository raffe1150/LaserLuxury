import { normalizeAiResponseText } from "../reliability";
import type {
  UnifiedAiGenerationRequest,
  UnifiedAiGenerationResponse,
} from "./provider";

export function buildGeminiGenerationParams(
  request: UnifiedAiGenerationRequest,
): any {
  const formattedMessages = request.messages.map((m: any) => {
    if (m.role === "tool") {
      return {
        role: "user",
        parts: [{
          functionResponse: {
            name: m.name,
            response: JSON.parse(m.content),
            id: m.id,
          },
        }],
      };
    }

    if (m.tool_calls) {
      const toolParts = m.tool_calls.map((c: any) => ({
        functionCall: {
          name: c.function.name,
          args: JSON.parse(c.function.arguments),
          id: c.id,
        },
      }));

      if (typeof m.content === "string" && m.content.length > 0) {
        return {
          role: "model",
          parts: [{ text: m.content }, ...toolParts],
        };
      }

      return {
        role: "model",
        parts: toolParts,
      };
    }

    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: Array.isArray(m.content)
        ? m.content
        : [{ text: m.content }],
    };
  });

  const params: any = {
    model: request.model || "gemini-2.5-flash",
    contents: formattedMessages,
    config: {
      systemInstruction: request.systemInstruction,
      tools: request.tools,
      temperature: request.temperature,
    },
  };

  if (!params.config.systemInstruction) delete params.config.systemInstruction;
  if (!params.config.tools) delete params.config.tools;
  if (params.config.temperature === undefined) {
    delete params.config.temperature;
  }

  return params;
}

export function normalizeGeminiGenerationResponse(
  response: any,
): UnifiedAiGenerationResponse {
  const functionCalls = response.functionCalls
    ? response.functionCalls.map((fc: any) => ({
        id: fc.id || Math.random().toString(36).substring(7),
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        },
      }))
    : [];

  let safeText = "";

  try {
    safeText = normalizeAiResponseText(response.text);
  } catch {
    const parts = response.candidates?.[0]?.content?.parts || [];
    safeText = parts.map((p: any) => p.text || "").join("");
  }

  return {
    text: safeText || "",
    functionCalls,
  };
}
