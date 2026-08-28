import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import {
  getOdinLinkStartupPolicy,
  registerHealthEndpoint,
} from "./local-test-mode";

async function verifyHealthEndpoint(): Promise<void> {
  const app = express();
  registerHealthEndpoint(app);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function verifyLocalTestModePolicy(): void {
  const policy = getOdinLinkStartupPolicy({
    ODINLINK_LOCAL_TEST_MODE: "true",
  });

  assert.equal(policy.localTestMode, true);
  assert.equal(policy.telegramPollersEnabled, false);
  assert.equal(policy.reminderCronEnabled, false);
  assert.equal(policy.backgroundJobsEnabled, false);
}

function verifyNormalModePolicy(): void {
  const policy = getOdinLinkStartupPolicy({});

  assert.equal(policy.localTestMode, false);
  assert.equal(policy.telegramPollersEnabled, true);
  assert.equal(policy.reminderCronEnabled, true);
  assert.equal(policy.backgroundJobsEnabled, true);
}

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function verifyServerIntegration(): void {
  const serverSource = readFileSync(
    new URL("../../server.ts", import.meta.url),
    "utf8",
  );
  const telegramPolling = sourceSection(
    serverSource,
    "async function startTelegramPolling(",
    "async function startAllBusinessTelegramPollers(",
  );
  const reminderCron = sourceSection(
    serverSource,
    "function setupDailyReminders()",
    "function cleanInstagramToken(",
  );
  const chatRoute = sourceSection(
    serverSource,
    'app.post("/api/chat"',
    'app.post("/api/transcribe"',
  );
  const listenCallback = sourceSection(
    serverSource,
    "app.listen(PORT, () => {",
    "export const priority1hUnifiedEngineTestBoundary",
  );

  assert.match(
    telegramPolling,
    /if \(!odinLinkStartupPolicy\.telegramPollersEnabled\)[\s\S]*return;/,
  );
  assert.match(
    reminderCron,
    /if \(!odinLinkStartupPolicy\.reminderCronEnabled\)[\s\S]*return;[\s\S]*cron\.schedule/,
  );
  assert.match(serverSource, /registerHealthEndpoint\(app\)/);
  assert.match(
    listenCallback,
    /if \(odinLinkStartupPolicy\.backgroundJobsEnabled\)[\s\S]*startAllBusinessTelegramPollers\(\)[\s\S]*setupDailyReminders\(\)/,
  );

  assert.match(chatRoute, /const \{ chatId: clientChatId \} = req\.body/);
  assert.match(chatRoute, /res\.json\(\{ text: textPart, audioData: audioDataOut, mimeType: outMimeType, chatId \}\)/);
  assert.doesNotMatch(chatRoute, /apiKey\s*\}\s*=\s*req\.body/);
  assert.match(
    chatRoute,
    /new GoogleGenAI\(\{ apiKey: process\.env\.GEMINI_API_KEY \}\)/,
  );
}

await verifyHealthEndpoint();
verifyLocalTestModePolicy();
verifyNormalModePolicy();
verifyServerIntegration();

console.log("Local test mode and health endpoint tests passed");
