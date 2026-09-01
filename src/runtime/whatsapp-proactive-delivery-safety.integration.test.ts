import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const now = new Date("2026-09-01T12:00:00.000Z").getTime();
const customerId = "46701234567";
const recentInbound = {
  user_id: `wa_${customerId}`,
  platform: "whatsapp-webhook",
  sender: "user",
  created_at: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
};

assert.equal(
  boundary.whatsappServiceWindowOpen([
    { ...recentInbound, sender: "human", created_at: new Date(now - 1_000).toISOString() },
    recentInbound,
  ], customerId, now),
  true,
  "a recent legitimate customer inbound opens the free-form service window",
);
assert.equal(
  boundary.whatsappServiceWindowOpen([
    { ...recentInbound, created_at: new Date(now - 24 * 60 * 60 * 1000).toISOString() },
  ], customerId, now),
  false,
  "the service window is closed at 24 hours",
);
assert.equal(boundary.whatsappServiceWindowOpen([], customerId, now), false);
assert.equal(
  boundary.whatsappServiceWindowOpen([
    { ...recentInbound, user_id: "46709999999" },
    { ...recentInbound, platform: "messenger" },
    { ...recentInbound, sender: "bot" },
  ], customerId, now),
  false,
  "other identities, channels, and outbound rows cannot open the window",
);

const businessConfig = {
  id: "whatsapp-delivery-safety-business",
  whatsappAccessToken: "test-whatsapp-token",
  whatsappPhoneNumberId: "test-whatsapp-phone-id",
};
const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 131047 } }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
  assert.equal(
    await boundary.sendCustomerMessage("whatsapp", customerId, "Test", businessConfig, "proactive"),
    false,
    "provider HTTP rejection is propagated",
  );

  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(
    await boundary.sendCustomerMessage("whatsapp", customerId, "Test", businessConfig, "proactive"),
    false,
    "proactive HTTP success without a provider message id is not accepted",
  );
  assert.equal(
    await boundary.sendCustomerMessage("whatsapp", customerId, "Test", businessConfig, "conversation"),
    true,
    "existing conversational WhatsApp acceptance remains based on HTTP success",
  );

  globalThis.fetch = async () => new Response(
    JSON.stringify({ messages: [{ id: "not-a-whatsapp-message-id" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  assert.equal(
    await boundary.sendCustomerMessage("whatsapp", customerId, "Test", businessConfig, "proactive"),
    false,
    "an invalid provider message id is not accepted",
  );

  globalThis.fetch = async () => new Response(
    JSON.stringify({ messages: [{ id: "wamid.delivery-safety-test" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  assert.equal(
    await boundary.sendCustomerMessage("whatsapp", customerId, "Test", businessConfig, "proactive"),
    true,
    "a proactive send with a provider message id is accepted",
  );
} finally {
  globalThis.fetch = originalFetch;
  boundary.reset();
}

const serverSource = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
const manualRoute = serverSource.match(
  /\/\/ API: send a manual dashboard reply[\s\S]*?\/\/ API: mark all unread customer messages/,
)?.[0] || "";
assert.match(manualRoute, /select\('id,user_id,platform,sender,created_at'\)/);
assert.match(manualRoute, /\.eq\('business_id', businessId\)[\s\S]*?\.eq\('platform', 'whatsapp'\)[\s\S]*?\.eq\('user_id', canonicalWhatsAppUserId\)[\s\S]*?\.in\('sender', \['user', 'customer'\]\)/);
assert.match(manualRoute, /hasOpenWhatsAppCustomerServiceWindow\(customerInboundRows \|\| \[\], canonicalWhatsAppUserId\)/);
assert.match(manualRoute, /code: 'whatsapp_template_required'/);
assert.match(manualRoute, /sendCustomerMessage\('whatsapp', recipient, text, businessConfig, "proactive"\)/);
assert.match(manualRoute, /code: 'provider_send_failed'/);
assert.ok(
  manualRoute.indexOf("whatsapp_template_required") < manualRoute.indexOf("sendCustomerMessage('whatsapp'"),
  "closed-window rejection occurs before the low-level sender",
);
assert.ok(
  manualRoute.indexOf("if (!sent)") < manualRoute.lastIndexOf(".from('chat_history')"),
  "provider failure returns before outbound history insertion",
);

const panelSource = readFileSync(
  new URL("../components/dashboard/ConversationsPanel.tsx", import.meta.url),
  "utf8",
);
const sendReplySource = panelSource.match(/const sendReply = async \(\) => \{[\s\S]*?\n  \};/)?.[0] || "";
assert.match(sendReplySource, /const previousPreview = selected\.preview/);
assert.match(sendReplySource, /const previousUpdatedAt = selected\.updatedAt/);
assert.match(sendReplySource, /preview: previousPreview, updatedAt: previousUpdatedAt/);
assert.match(sendReplySource, /filter\(\(message\) => message\.id !== optimisticId\)/);
assert.match(sendReplySource, /setSendError\(/);

console.log("WhatsApp proactive delivery safety regressions passed");
