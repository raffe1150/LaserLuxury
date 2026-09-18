import assert from "node:assert/strict";
import test from "node:test";
import {
  createP2ConversationKey,
  P2ConversationKeyError,
} from "./conversation-key";

const secret =
  "odinlink-p2-test-secret-0123456789abcdef";

test(
  "creates deterministic keyed conversation identity",
  () => {
    const first =
      createP2ConversationKey({
        secret,
        businessId: 101,
        channel: "whatsapp",
        sessionId:
          "wa:101:+46701234567",
      });

    const second =
      createP2ConversationKey({
        secret,
        businessId: 101,
        channel: "whatsapp",
        sessionId:
          "wa:101:+46701234567",
      });

    assert.equal(first, second);
    assert.match(
      first,
      /^whatsapp:101:[a-f0-9]{32}$/,
    );

    assert.equal(
      first.includes("+46701234567"),
      false,
    );
  },
);

test(
  "different secrets produce different identities",
  () => {
    const first =
      createP2ConversationKey({
        secret,
        businessId: 101,
        channel: "whatsapp",
        sessionId: "customer-1",
      });

    const second =
      createP2ConversationKey({
        secret:
          "different-p2-secret-0123456789abcdef",
        businessId: 101,
        channel: "whatsapp",
        sessionId: "customer-1",
      });

    assert.notEqual(first, second);
  },
);

test(
  "tenant and channel are bound into the identity",
  () => {
    const base =
      createP2ConversationKey({
        secret,
        businessId: 101,
        channel: "whatsapp",
        sessionId: "customer-1",
      });

    const otherBusiness =
      createP2ConversationKey({
        secret,
        businessId: 202,
        channel: "whatsapp",
        sessionId: "customer-1",
      });

    const otherChannel =
      createP2ConversationKey({
        secret,
        businessId: 101,
        channel: "telegram",
        sessionId: "customer-1",
      });

    assert.notEqual(
      base,
      otherBusiness,
    );
    assert.notEqual(
      base,
      otherChannel,
    );
  },
);

test(
  "fails closed without a secret",
  () => {
    assert.throws(
      () =>
        createP2ConversationKey({
          secret: "",
          businessId: 101,
          channel: "whatsapp",
          sessionId: "customer-1",
        }),
      (error) =>
        error instanceof
          P2ConversationKeyError &&
        error.causeCode ===
          "missing_secret",
    );
  },
);

test(
  "fails closed for a weak secret",
  () => {
    assert.throws(
      () =>
        createP2ConversationKey({
          secret: "too-short",
          businessId: 101,
          channel: "whatsapp",
          sessionId: "customer-1",
        }),
      (error) =>
        error instanceof
          P2ConversationKeyError &&
        error.causeCode ===
          "weak_secret",
    );
  },
);
