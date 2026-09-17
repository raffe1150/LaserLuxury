import assert from "node:assert/strict";
import test from "node:test";

import {
  P2ShadowEvaluator,
} from "./shadow-evaluator";

const event = {
  businessId: 100,
  conversationKey: "wa:100:customer-1",
  channel: "whatsapp",
  providerEventId: "event-1",
  receivedAt: "2026-09-17T20:00:00.000Z",
  payload: {
    text: "I want to book tomorrow",
  },
};

test("records matching shadow evaluation without authoritative side effects", async () => {
  let analyzeCalls = 0;
  const recorded: unknown[] = [];

  const evaluator =
    new P2ShadowEvaluator({
      analyzer: {
        async analyze() {
          analyzeCalls += 1;

          return {
            languageCode: "en",
            taskType: "booking",
            operationType:
              "check_availability",
            outcome:
              "needs_availability",
            confidence: 0.95,
          };
        },
      },

      recorder: {
        async record(value) {
          recorded.push(value);
        },
      },

      now: () =>
        new Date(
          "2026-09-17T20:01:00.000Z",
        ),
    });

  const result =
    await evaluator.evaluate(
      event,
      {
        languageCode: "en",
        taskType: "booking",
        operationType:
          "check_availability",
        outcome:
          "needs_availability",
      },
    );

  assert.equal(
    result.executionMode,
    "shadow",
  );

  assert.equal(
    result.comparison,
    "match",
  );

  assert.equal(
    analyzeCalls,
    1,
  );

  assert.equal(
    recorded.length,
    1,
  );
});

test("marks semantic difference as divergent", async () => {
  const evaluator =
    new P2ShadowEvaluator({
      analyzer: {
        async analyze() {
          return {
            languageCode: "de",
            taskType: "booking",
            operationType:
              "check_availability",
            outcome:
              "needs_availability",
          };
        },
      },

      recorder: {
        async record() {},
      },
    });

  const result =
    await evaluator.evaluate(
      event,
      {
        languageCode: "sv",
        taskType: "booking",
        operationType:
          "check_availability",
        outcome:
          "needs_availability",
      },
    );

  assert.equal(
    result.comparison,
    "divergent",
  );
});

test("missing legacy observation is not comparable", async () => {
  const evaluator =
    new P2ShadowEvaluator({
      analyzer: {
        async analyze() {
          return {
            taskType: "booking",
          };
        },
      },

      recorder: {
        async record() {},
      },
    });

  const result =
    await evaluator.evaluate(
      event,
      null,
    );

  assert.equal(
    result.comparison,
    "not_comparable",
  );
});

test("recorder failure fails closed", async () => {
  const evaluator =
    new P2ShadowEvaluator({
      analyzer: {
        async analyze() {
          return {
            taskType: "booking",
          };
        },
      },

      recorder: {
        async record() {
          throw new Error(
            "shadow storage unavailable",
          );
        },
      },
    });

  await assert.rejects(
    () =>
      evaluator.evaluate(
        event,
        null,
      ),
    /shadow storage unavailable/,
  );
});

test("invalid confidence is rejected before recording", async () => {
  let recorded = false;

  const evaluator =
    new P2ShadowEvaluator({
      analyzer: {
        async analyze() {
          return {
            taskType: "booking",
            confidence: 1.5,
          };
        },
      },

      recorder: {
        async record() {
          recorded = true;
        },
      },
    });

  await assert.rejects(
    () =>
      evaluator.evaluate(
        event,
        null,
      ),
    (error: unknown) => {
      assert.equal(
        (error as {
          causeCode?: string;
        }).causeCode,
        "invalid_confidence",
      );

      return true;
    },
  );

  assert.equal(
    recorded,
    false,
  );
});
