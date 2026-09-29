import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeminiGenerationParams,
  normalizeGeminiGenerationResponse,
} from "./gemini";

test("Gemini request formatting preserves legacy message and tool history parity", () => {
  const request = {
    model: "gemini-2.5-flash",
    systemInstruction: "system",
    temperature: 0.2,
    tools: [{ functionDeclarations: [{ name: "checkSlots" }] }],
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{
          id: "call-1",
          function: { name: "checkSlots", arguments: '{"date":"2026-10-01"}' },
        }],
      },
      { role: "tool", id: "call-1", name: "checkSlots", content: '{"ok":true}' },
    ],
  };

  assert.deepEqual(buildGeminiGenerationParams(request), {
    model: "gemini-2.5-flash",
    contents: [
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "model",
        parts: [
          { text: "checking" },
          { functionCall: { name: "checkSlots", args: { date: "2026-10-01" }, id: "call-1" } },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "checkSlots", response: { ok: true }, id: "call-1" } }],
      },
    ],
    config: {
      systemInstruction: "system",
      tools: request.tools,
      temperature: 0.2,
    },
  });
});

test("Gemini response normalization preserves text and tool-call parity", () => {
  assert.deepEqual(
    normalizeGeminiGenerationResponse({
      text: "Available",
      functionCalls: [{ id: "call-2", name: "checkSlots", args: { date: "2026-10-02" } }],
    }),
    {
      text: "Available",
      functionCalls: [{
        id: "call-2",
        function: { name: "checkSlots", arguments: '{"date":"2026-10-02"}' },
      }],
    },
  );
});

test("Gemini malformed text getter retains candidate-part fallback", () => {
  const response = {
    get text() {
      throw new Error("malformed text accessor");
    },
    candidates: [{ content: { parts: [{ text: "safe" }, { text: " fallback" }] } }],
  };
  assert.equal(normalizeGeminiGenerationResponse(response).text, "safe fallback");
});
