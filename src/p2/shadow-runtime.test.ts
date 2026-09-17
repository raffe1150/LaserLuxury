import assert from "node:assert/strict";
import test from "node:test";

import {
  P2ShadowRuntime,
} from "./shadow-runtime";

const event = {
  businessId: 101,
  conversationKey:
    "wa:scope:customer",
  channel: "whatsapp",
  providerScope: "scope",
  providerEventId: "evt-1",
  receivedAt:
    "2026-09-17T20:00:00.000Z",
  payload: {
    text: "I want to book tomorrow",
  },
};

test(
  "disabled runtime does not invoke analyzer or recorder",
  async () => {
    let analyzerCalled = false;
    let recorderCalled = false;

    const runtime =
      new P2ShadowRuntime({
        enabled: false,

        analyzer: {
          async analyze() {
            analyzerCalled = true;

            return {
              taskType: "booking",
              confidence: 1,
            };
          },
        },

        recorder: {
          async record() {
            recorderCalled = true;
          },
        },
      });

    const result =
      await runtime.mirror({
        event,
      });

    assert.equal(
      result.status,
      "disabled",
    );

    assert.equal(
      analyzerCalled,
      false,
    );

    assert.equal(
      recorderCalled,
      false,
    );
  },
);

test(
  "successful shadow evaluation is recorded",
  async () => {
    let recorderCalled = false;

    const runtime =
      new P2ShadowRuntime({
        enabled: true,

        analyzer: {
          async analyze() {
            return {
              languageCode: "en",
              taskType: "booking",
              confidence: 0.98,
            };
          },
        },

        recorder: {
          async record() {
            recorderCalled = true;
          },
        },
      });

    const result =
      await runtime.mirror({
        event,
        legacy: {
          languageCode: "en",
          taskType: "booking",
        },
      });

    assert.equal(
      result.status,
      "recorded",
    );

    assert.equal(
      recorderCalled,
      true,
    );

    if (
      result.status === "recorded"
    ) {
      assert.equal(
        result.evaluation.comparison,
        "match",
      );
    }
  },
);

test(
  "analyzer failure is isolated from live request",
  async () => {
    const runtime =
      new P2ShadowRuntime({
        enabled: true,

        analyzer: {
          async analyze() {
            throw new Error(
              "analyzer unavailable",
            );
          },
        },

        recorder: {
          async record() {
            throw new Error(
              "must not be reached",
            );
          },
        },
      });

    const result =
      await runtime.mirror({
        event,
      });

    assert.equal(
      result.status,
      "failed",
    );
  },
);

test(
  "recorder failure is isolated from live request",
  async () => {
    const runtime =
      new P2ShadowRuntime({
        enabled: true,

        analyzer: {
          async analyze() {
            return {
              taskType: "booking",
              confidence: 0.9,
            };
          },
        },

        recorder: {
          async record() {
            throw new Error(
              "database unavailable",
            );
          },
        },
      });

    const result =
      await runtime.mirror({
        event,
      });

    assert.equal(
      result.status,
      "failed",
    );
  },
);

test(
  "shadow timeout is isolated",
  async () => {
    const runtime =
      new P2ShadowRuntime({
        enabled: true,
        timeoutMs: 10,

        analyzer: {
          async analyze() {
            await new Promise(
              (resolve) =>
                setTimeout(
                  resolve,
                  100,
                ),
            );

            return {
              taskType: "booking",
              confidence: 0.9,
            };
          },
        },

        recorder: {
          async record() {},
        },
      });

    const result =
      await runtime.mirror({
        event,
      });

    assert.equal(
      result.status,
      "failed",
    );

    if (
      result.status === "failed"
    ) {
      assert.equal(
        result.errorCategory,
        "P2_SHADOW_TIMEOUT",
      );
    }
  },
);
