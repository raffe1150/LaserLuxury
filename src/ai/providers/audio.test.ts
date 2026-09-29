import assert from "node:assert/strict";
import test from "node:test";
import {
  extractUnifiedAudioInput,
  toGeminiAudioContent,
} from "./audio";

const audioData = Buffer.from("test-audio").toString("base64");

function legacyVoicePayload(label: string, mimeType: string) {
  return [
    { text: label },
    { inlineData: { data: audioData, mimeType } },
  ];
}

test("shared audio extraction normalizes Gemini inlineData", () => {
  assert.deepEqual(
    extractUnifiedAudioInput(legacyVoicePayload("Voice message input:", "audio/ogg; codecs=opus")),
    { data: audioData, mimeType: "audio/ogg" },
  );
});

test("Telegram voice payload normalizes with channel metadata", () => {
  assert.deepEqual(
    extractUnifiedAudioInput(legacyVoicePayload("Voice message input:", "audio/ogg"), "telegram"),
    { data: audioData, mimeType: "audio/ogg", channel: "telegram" },
  );
});

test("Messenger voice payload normalizes with its downloaded MIME type", () => {
  assert.deepEqual(
    extractUnifiedAudioInput(legacyVoicePayload("Voice message input from Messenger:", "audio/mpeg"), "messenger"),
    { data: audioData, mimeType: "audio/mpeg", channel: "messenger" },
  );
});

test("Instagram voice payload normalizes video/mp4 to supported audio/mp4", () => {
  assert.deepEqual(
    extractUnifiedAudioInput(legacyVoicePayload("Instagram voice message input", "video/mp4"), "instagram"),
    { data: audioData, mimeType: "audio/mp4", channel: "instagram" },
  );
});

test("WhatsApp provider-agnostic audio payload normalizes", () => {
  assert.deepEqual(
    extractUnifiedAudioInput({ data: audioData, mimeType: "audio/ogg", channel: "whatsapp" }),
    { data: audioData, mimeType: "audio/ogg", channel: "whatsapp" },
  );
});

test("missing, malformed, and unsupported audio fail safely", () => {
  assert.equal(extractUnifiedAudioInput(null), null);
  assert.equal(extractUnifiedAudioInput([{ text: "voice" }]), null);
  assert.equal(extractUnifiedAudioInput({ data: "%%%", mimeType: "audio/ogg" }), null);
  assert.equal(extractUnifiedAudioInput({ data: audioData, mimeType: "application/octet-stream" }), null);
  assert.equal(extractUnifiedAudioInput({ inlineData: { data: audioData, mimeType: "image/png" } }), null);
});

test("Gemini conversion is explicit and contains only Gemini audio formatting", () => {
  assert.deepEqual(
    toGeminiAudioContent({ data: audioData, mimeType: "audio/ogg", channel: "whatsapp" }),
    [
      { text: "Voice message input:" },
      { inlineData: { data: audioData, mimeType: "audio/ogg" } },
    ],
  );
});
