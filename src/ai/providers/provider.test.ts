import assert from "node:assert/strict";
import test from "node:test";
import { getConfiguredAiProvider } from "./provider";
import {
  getAiProviderCapabilities,
  normalizeGenerationRequestForProvider,
} from "./router";

test("unset AI provider defaults to openai", () => {
  const previous = process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER;

  try {
    assert.equal(getConfiguredAiProvider(), "openai");
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
});

test("empty or whitespace AI provider defaults to openai", () => {
  const previous = process.env.AI_PROVIDER;

  try {
    for (const value of ["", "   ", "\t\n"]) {
      process.env.AI_PROVIDER = value;
      assert.equal(getConfiguredAiProvider(), "openai");
    }
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
});

test("AI provider selects openai", () => {
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "openai";

  try {
    assert.equal(getConfiguredAiProvider(), "openai");
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
});

test("AI provider selects gemini only when explicitly configured", () => {
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "gemini";

  try {
    assert.equal(getConfiguredAiProvider(), "gemini");
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
});

test("misspelled or unknown AI provider fails clearly without exposing its value", () => {
  const previous = process.env.AI_PROVIDER;
  const invalidValue = "opneai-secret-marker";
  process.env.AI_PROVIDER = invalidValue;

  try {
    assert.throws(
      () => getConfiguredAiProvider(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          'Invalid AI_PROVIDER configuration. Expected "openai" or "gemini".',
        );
        assert.equal(error.message.includes(invalidValue), false);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
  }
});

test("provider capabilities report only implemented AI features", () => {
  assert.deepEqual(getAiProviderCapabilities("gemini"), {
    embeddings: true,
    textGeneration: true,
    toolCalling: true,
    transcription: true,
    speechSynthesis: false,
    realtimeVoice: false,
  });
  assert.deepEqual(getAiProviderCapabilities("openai"), {
    embeddings: true,
    textGeneration: true,
    toolCalling: true,
    transcription: true,
    speechSynthesis: false,
    realtimeVoice: false,
  });
});

test("OpenAI provider routing strips legacy Gemini model names", () => {
  const request = {
    messages: [{ role: "user", content: "hello" }],
    model: "gemini-2.5-flash",
  };

  assert.deepEqual(
    normalizeGenerationRequestForProvider("openai", request),
    { ...request, model: undefined },
  );
  assert.equal(
    normalizeGenerationRequestForProvider("gemini", request),
    request,
  );
});
