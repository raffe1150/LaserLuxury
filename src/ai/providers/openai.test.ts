import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenAiTranscriptionParams,
  normalizeOpenAiGenerationResponse,
  normalizeOpenAiTranscriptionResponse,
  resolveOpenAiTextModel,
  toOpenAiInput,
  toOpenAiTools,
} from "./openai";

test("OpenAI message mapping preserves internal tool history contract", () => {
  assert.deepEqual(toOpenAiInput([
    { role: "user", content: "Find a slot" },
    {
      role: "assistant",
      content: "I will check.",
      tool_calls: [{
        id: "call-1",
        function: { name: "checkSlots", arguments: '{"date":"2026-10-01"}' },
      }],
    },
    { role: "tool", id: "call-1", name: "checkSlots", content: '{"available":true}' },
  ]), [
    { role: "user", content: "Find a slot" },
    { role: "assistant", content: "I will check." },
    { type: "function_call", call_id: "call-1", name: "checkSlots", arguments: '{"date":"2026-10-01"}' },
    { type: "function_call_output", call_id: "call-1", output: '{"available":true}' },
  ]);
});

test("OpenAI tool declarations and returned calls map to the unified contract", () => {
  assert.deepEqual(toOpenAiTools([{ functionDeclarations: [{
    name: "checkSlots",
    description: "Check availability",
    parameters: { type: "object", properties: { date: { type: "string" } } },
  }] }]), [{
    type: "function",
    name: "checkSlots",
    description: "Check availability",
    strict: false,
    parameters: { type: "object", properties: { date: { type: "string" } } },
  }]);

  assert.deepEqual(normalizeOpenAiGenerationResponse({
    output_text: "",
    output: [{ type: "function_call", id: "item-1", call_id: "call-1", name: "checkSlots", arguments: '{"date":"2026-10-01"}' }],
  }), {
    text: "",
    functionCalls: [{
      id: "call-1",
      function: { name: "checkSlots", arguments: '{"date":"2026-10-01"}' },
    }],
  });
});

test("Gemini model names are never resolved for OpenAI", () => {
  const previous = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = "configured-openai-model";
  try {
    assert.equal(resolveOpenAiTextModel("gemini-2.5-flash"), "configured-openai-model");
    assert.equal(resolveOpenAiTextModel("openai-explicit-model"), "openai-explicit-model");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previous;
  }
});

test("OpenAI text mapping rejects Gemini inlineData instead of forwarding it", () => {
  assert.throws(
    () => toOpenAiInput([{
      role: "user",
      content: [{ inlineData: { data: "dGVzdA==", mimeType: "audio/ogg" } }],
    }]),
    /does not accept provider-specific inline audio content/,
  );
});

test("OpenAI transcription uses an in-memory file and normalizes its response", async () => {
  const previous = process.env.OPENAI_TRANSCRIPTION_MODEL;
  process.env.OPENAI_TRANSCRIPTION_MODEL = "configured-transcription-model";
  const seen: any[] = [];
  try {
    const params = await buildOpenAiTranscriptionParams({
      audio: {
        data: Buffer.from("voice-bytes").toString("base64"),
        mimeType: "audio/ogg",
        channel: "telegram",
      },
    }, async (value: any, name?: string | null, options?: any) => {
      seen.push({ value: Buffer.from(value).toString(), name, options });
      return { fakeFile: true } as any;
    });

    assert.deepEqual(seen, [{
      value: "voice-bytes",
      name: "voice-message.ogg",
      options: { type: "audio/ogg" },
    }]);
    assert.equal(params.model, "configured-transcription-model");
    assert.equal(params.response_format, "json");
    assert.match(params.prompt, /never translate/i);
    assert.match(params.prompt, /\[unclear\]/);
    assert.deepEqual(normalizeOpenAiTranscriptionResponse({ text: "سلام ۱۲۳" }), { text: "سلام ۱۲۳" });
    assert.deepEqual(normalizeOpenAiTranscriptionResponse({}), { text: "" });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_TRANSCRIPTION_MODEL;
    else process.env.OPENAI_TRANSCRIPTION_MODEL = previous;
  }
});
