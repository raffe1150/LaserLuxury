import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");

test("generation boundary routes OpenAI while retaining Gemini build and normalization", () => {
  const boundary = serverSource.match(/async function generateContentWithFallback[\s\S]*?\n}\n\nasync function transcribeVoiceMessageForFlow/)?.[0] || "";
  assert.match(boundary, /provider === "gemini"[\s\S]*buildGeminiGenerationParams/);
  assert.match(boundary, /priority1hTestDependencies\?\.geminiGenerate/);
  assert.match(boundary, /activeAi!\.models\.generateContent\(params\)/);
  assert.match(boundary, /generateWithConfiguredProvider\(\{ \.\.\.request, signal \}\)/);
  assert.match(boundary, /provider === "gemini"[\s\S]*normalizeGeminiGenerationResponse/);
  assert.match(boundary, /beforeRetry[\s\S]*provider === "gemini"[\s\S]*rotateKey/);
});

test("OpenAI diagnostic correlation uses the existing AIRequest ID without entering the SDK payload", () => {
  const boundary = serverSource.match(/async function generateContentWithFallback[\s\S]*?\n}\n\nasync function transcribeVoiceMessageForFlow/)?.[0] || "";
  assert.equal((boundary.match(/const correlationId = crypto.randomUUID\(\)/g) || []).length, 1);
  assert.match(boundary, /diagnosticContext: \{ correlationId \}/);
  assert.match(boundary, /generateWithConfiguredProvider\(\{ \.\.\.request, signal \}\)/);
  assert.match(boundary, /console.log\("\[AIRequest\]", \{\s*correlationId,/);
});

test("Gemini transcription remains on its existing generation path", () => {
  const boundary = serverSource.match(/async function transcribeVoiceMessageForFlow[\s\S]*?\n}\n\n\nasync function handleSystemAnalysisLog/)?.[0] || "";
  assert.match(boundary, /provider === "gemini"[\s\S]*generateContentWithFallback/);
  assert.match(boundary, /model: "gemini-2\.5-flash"/);
  assert.match(boundary, /transcribeWithConfiguredProvider\(\{ audio \}\)/);
});

test("all production messaging channels enter the shared transcription boundary", () => {
  for (const channel of ["telegram", "messenger", "instagram", "whatsapp"]) {
    assert.match(
      serverSource,
      new RegExp(`transcribeVoiceMessageForFlow\\([\\s\\S]{0,700}channel: ["']${channel}["']`),
      `${channel} should use the shared transcription boundary`,
    );
  }
  assert.match(serverSource, /downloadWhatsAppAudio\([\s\S]*?whatsappAudio\.id/);
});
