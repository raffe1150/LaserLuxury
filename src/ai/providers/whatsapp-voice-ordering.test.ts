import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../../../server.ts", import.meta.url), "utf8");
const whatsappHandler = serverSource.match(
  /async function processWhatsAppMessageClaimed[\s\S]*?\n}\n\n\nfunction getBusinessMessengerToken/,
)?.[0] || "";

test("WhatsApp voice never prepares conversation language from empty content", () => {
  assert.doesNotMatch(
    whatsappHandler,
    /prepareConversationLanguageForTurn\(\s*chatId,\s*textMessage\s*\|\|\s*["']{2}/,
  );
  assert.match(
    whatsappHandler,
    /if \(preTranscriptionVoiceLanguage\)[\s\S]*?usageLanguage[\s\S]*?else \{[\s\S]*?prepareConversationLanguageForTurn\(\s*chatId,\s*textMessage,/,
  );
});

test("successful WhatsApp voice transcription updates language before shadowing", () => {
  const assignment = whatsappHandler.indexOf("textMessage = voiceTranscript;");
  const preparation = whatsappHandler.indexOf(
    "userLanguage = await prepareConversationLanguageForTurn(",
    assignment,
  );
  const shadow = whatsappHandler.indexOf("mirrorP2InboundTextShadow({", preparation);

  assert.ok(assignment >= 0, "voice transcript should become the effective text message");
  assert.ok(preparation > assignment, "language preparation should use the successful transcript");
  assert.ok(shadow > preparation, "the transcript should enter shadowing after language preparation");
  assert.match(
    whatsappHandler.slice(preparation, shadow),
    /voiceTranscript/,
  );
  assert.match(
    whatsappHandler.slice(shadow, shadow + 500),
    /text: voiceTranscript[\s\S]*activeLanguage: userLanguage/,
  );
});

test("WhatsApp accepted-message analytics remains single-shot", () => {
  assert.equal(
    (whatsappHandler.match(/recordAcceptedCustomerMessage\(\{/g) || []).length,
    1,
  );
  assert.match(
    whatsappHandler,
    /language: isVoiceMessage[\s\S]*?preTranscriptionVoiceLanguage\?\.storedLanguage \|\| undefined[\s\S]*?: userLanguage/,
  );
});

test("WhatsApp text still prepares and mirrors before the usage gate", () => {
  const textPreparation = whatsappHandler.indexOf(
    "userLanguage = await prepareConversationLanguageForTurn(",
  );
  const textShadow = whatsappHandler.indexOf("if (String(textMessage || \"\").trim())");
  const usageGate = whatsappHandler.indexOf("const usage = await checkAndIncrementDailyUsage");

  assert.ok(textPreparation >= 0 && textPreparation < textShadow);
  assert.ok(textShadow < usageGate);
  assert.match(
    whatsappHandler.slice(textShadow, usageGate),
    /text:\s*String\(textMessage\)[\s\S]*activeLanguage:\s*userLanguage/,
  );
});

test("WhatsApp usage limit is enforced before audio download and transcription", () => {
  const usageGate = whatsappHandler.indexOf("const usage = await checkAndIncrementDailyUsage");
  const deniedReturn = whatsappHandler.indexOf("if (!usage.allowed)", usageGate);
  const download = whatsappHandler.indexOf("downloadWhatsAppAudio(", deniedReturn);
  const transcription = whatsappHandler.indexOf("transcribeVoiceMessageForFlow(", download);

  assert.ok(usageGate >= 0);
  assert.ok(deniedReturn > usageGate);
  assert.ok(download > deniedReturn);
  assert.ok(transcription > download);
  assert.match(
    whatsappHandler.slice(deniedReturn, download),
    /return;/,
  );
});
