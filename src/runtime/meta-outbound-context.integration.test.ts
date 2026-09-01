import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const { priority1hUnifiedEngineTestBoundary: boundary } = await import("../../server");

const businessConfig = {
  id: "meta-outbound-boundary-business",
  whatsappAccessToken: "test-whatsapp-token",
  whatsappPhoneNumberId: "whatsapp-phone-number-id",
  messengerPageAccessToken: "test-messenger-token",
  messengerPageId: "messenger-page-id",
  instagramAccessToken: "test-instagram-token",
};
const authoredSwedishText =
  "Hej Alex! En vänlig påminnelse från kliniken: du har tid för Video Consultation idag kl 14:00. Vi ses snart! 😊";
const englishFallback = "I’m happy to help in English. What would you like to know?";

boundary.reset();
const originalFetch = globalThis.fetch;

try {
  const proactiveWhatsApp = boundary.whatsappOutboundText(
    "46701234567",
    authoredSwedishText,
    businessConfig,
    "proactive",
  );
  assert.equal(proactiveWhatsApp, authoredSwedishText);
  assert.notEqual(proactiveWhatsApp, englishFallback);

  assert.equal(
    boundary.whatsappOutboundText(
      "46701234567",
      authoredSwedishText,
      businessConfig,
      "conversation",
    ),
    englishFallback,
    "WhatsApp conversational replies retain the customer-facing language guard",
  );

  const proactiveMessenger = boundary.messengerOutboundText(
    "messenger-customer-1",
    authoredSwedishText,
    businessConfig,
    "proactive",
  );
  assert.equal(proactiveMessenger, authoredSwedishText);
  assert.notEqual(proactiveMessenger, englishFallback);

  assert.equal(
    boundary.messengerOutboundText(
      "messenger-customer-1",
      authoredSwedishText,
      businessConfig,
      "conversation",
    ),
    englishFallback,
    "Messenger conversational replies retain the customer-facing language guard",
  );

  const dispatchedBodies: any[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    dispatchedBodies.push(JSON.parse(String(init?.body || "{}")));
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  for (const platform of ["whatsapp", "messenger", "instagram"] as const) {
    assert.equal(
      await boundary.sendCustomerMessage(
        platform,
        "meta-customer-1",
        authoredSwedishText,
        businessConfig,
        "proactive",
      ),
      true,
    );
  }
  assert.equal(dispatchedBodies[0]?.text?.body, authoredSwedishText);
  assert.equal(dispatchedBodies[1]?.message?.text, authoredSwedishText);
  assert.equal(dispatchedBodies[2]?.message?.text, authoredSwedishText);
} finally {
  globalThis.fetch = originalFetch;
  boundary.reset();
}

console.log("Meta outbound context regressions passed");
