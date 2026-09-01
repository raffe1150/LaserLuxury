import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const providerCustomerId = "46738762287";
const scopedSessionId = boundary.channelSessionId("whatsapp", providerCustomerId, { id: 3 });

assert.equal(scopedSessionId, "wa_3:46738762287");
assert.equal(boundary.canonicalWhatsAppCustomerId(providerCustomerId), providerCustomerId);
assert.equal(
  boundary.canonicalWhatsAppCustomerId(scopedSessionId),
  "",
  "a tenant-scoped session id is never accepted as a provider customer identity",
);
assert.notEqual(boundary.canonicalWhatsAppCustomerId(providerCustomerId), "346738762287");

const persistedPayloads: any[][] = [];
boundary.configure({
  supabaseClient: {
    from(table: string) {
      assert.equal(table, "chat_history");
      return {
        insert(rows: any[]) {
          persistedPayloads.push(structuredClone(rows));
          return { select: async () => ({ error: null }) };
        },
      };
    },
  },
});
await boundary.persistCustomerExchange(
  providerCustomerId,
  "whatsapp-webhook",
  "Customer message",
  "Business reply",
  "3",
);
assert.deepEqual(
  persistedPayloads[0].map((row) => row.user_id),
  [providerCustomerId, providerCustomerId],
  "WhatsApp history persists the provider customer identity",
);
await boundary.persistCustomerExchange(
  scopedSessionId,
  "whatsapp-webhook",
  "Customer message",
  "Business reply",
  "3",
);
assert.equal(
  persistedPayloads.length,
  1,
  "a scoped WhatsApp session identity is rejected instead of being persisted as 346738762287",
);

const originalFetch = globalThis.fetch;
let providerCalls = 0;
try {
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(
      JSON.stringify({ messages: [{ id: "wamid.canonical-identity-test" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  assert.equal(
    await boundary.sendCustomerMessage(
      "whatsapp",
      scopedSessionId,
      "Authored message",
      {
        id: 3,
        whatsappAccessToken: "test-token",
        whatsappPhoneNumberId: "test-phone-number-id",
      },
      "proactive",
    ),
    false,
  );
  assert.equal(providerCalls, 0, "a scoped identity is rejected before any provider request");
} finally {
  globalThis.fetch = originalFetch;
}

const canonicalInbound = [{
  user_id: providerCustomerId,
  platform: "whatsapp",
  sender: "user",
  created_at: "2026-09-01T12:00:00.000Z",
}];

assert.equal(
  boundary.knownWhatsAppScopedIdentityRemainder("346738762287", 3, canonicalInbound),
  providerCustomerId,
  "the confirmed business-prefix duplicate is recognized",
);
assert.equal(
  boundary.knownWhatsAppScopedIdentityRemainder("346738762287", 3, []),
  null,
  "a phone is not rejected based only on a leading business-id digit",
);
assert.equal(
  boundary.knownWhatsAppScopedIdentityRemainder("346738762287", 3, [
    { ...canonicalInbound[0], sender: "bot" },
  ]),
  null,
  "an outbound-only remainder is not evidence of scoped identity corruption",
);

const serverSource = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
const whatsappHandler = serverSource.match(
  /async function processWhatsAppMessageClaimed[\s\S]*?\n}\n\nasync function sendMessengerMessage/,
)?.[0] || "";

assert.doesNotMatch(whatsappHandler, /postProcessMessage\(chatId,/);
assert.match(whatsappHandler, /postProcessMessage\(from, platform, textMessage, limitText/);
assert.match(whatsappHandler, /postProcessMessage\(\s*from,\s*platform,\s*textMessage,\s*reply/);
assert.match(whatsappHandler, /postProcessMessage\(from, platform, textMessage, textResponse/);

const manualRoute = serverSource.match(
  /\/\/ API: send a manual dashboard reply[\s\S]*?\/\/ API: mark all unread customer messages/,
)?.[0] || "";
assert.match(manualRoute, /code: 'whatsapp_invalid_conversation_identity'/);
assert.match(manualRoute, /getKnownWhatsAppScopedIdentityRemainder\(/);
assert.ok(
  manualRoute.indexOf("whatsapp_invalid_conversation_identity") <
    manualRoute.indexOf("sendCustomerMessage('whatsapp'"),
  "invalid identity rejection occurs before provider delivery",
);
assert.ok(
  manualRoute.indexOf("whatsapp_invalid_conversation_identity") <
    manualRoute.lastIndexOf(".from('chat_history')"),
  "invalid identity rejection occurs before outbound history persistence",
);
assert.match(manualRoute, /code: 'whatsapp_template_required'/);

boundary.reset();
console.log("WhatsApp canonical identity regressions passed");
