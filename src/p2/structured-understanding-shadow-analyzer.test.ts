import assert from "node:assert/strict";
import test from "node:test";

import type {
  UnderstandingProvider,
} from "../ai/understanding/provider";

import {
  P2StructuredUnderstandingShadowAnalyzer,
  P2StructuredUnderstandingShadowAnalyzerError,
} from "./structured-understanding-shadow-analyzer";

function provider(
  output: unknown,
): UnderstandingProvider {
  return {
    providerId: "test-provider",

    async interpret() {
      return output;
    },
  };
}

function baseUnderstanding(
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    language: {
      primary: {
        value: "en",
        confidence: 0.98,
      },
      codeSwitches: [],
    },
    intents: [
      {
        value: "new_booking",
        confidence: 0.96,
      },
    ],
    acts: {
      bookingRequest: {
        value: true,
        confidence: 0.95,
      },
    },
    entities: {},
    ambiguities: [],
    ...overrides,
  };
}

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
    text:
      "I want to book tomorrow",
    timezone:
      "Europe/Stockholm",
    currentTimeIso:
      "2026-09-17T20:00:00.000Z",
    configuredServices: [
      "Video Consultation",
    ],
    bookingPhase: "idle",
    offeredSlotCount: 0,
    selectedSlotPresent: false,
    knownFields: [],
  },
};

test(
  "maps validated provider output into P2 shadow decision",
  async () => {
    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider:
          provider(
            baseUnderstanding(),
          ),
      });

    const result =
      await analyzer.analyze(
        event,
      );

    assert.equal(
      result.languageCode,
      "en",
    );
    assert.equal(
      result.taskType,
      "booking",
    );
    assert.equal(
      result.operationType,
      "new_booking",
    );
    assert.equal(
      result.outcome,
      null,
    );
    assert.equal(
      result.confidence,
      0.96,
    );
    assert.equal(
      result.metadata?.provider,
      "test-provider",
    );
  },
);

test(
  "maps general question to support without booking operation",
  async () => {
    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider:
          provider(
            baseUnderstanding({
              intents: [
                {
                  value:
                    "general_question",
                  confidence:
                    0.91,
                },
              ],
              acts: {},
            }),
          ),
      });

    const result =
      await analyzer.analyze(
        event,
      );

    assert.equal(
      result.taskType,
      "support",
    );
    assert.equal(
      result.operationType,
      null,
    );
  },
);

test(
  "maps ambiguity before confirmation outcome",
  async () => {
    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider:
          provider(
            baseUnderstanding({
              acts: {
                bookingConfirmation:
                  {
                    value:
                      "affirmed",
                    confidence:
                      0.9,
                  },
              },
              ambiguities: [
                {
                  field: "time",
                  reason:
                    "multiple times",
                  confidence:
                    0.8,
                },
              ],
            }),
          ),
      });

    const result =
      await analyzer.analyze(
        event,
      );

    assert.equal(
      result.outcome,
      null,
    );

    assert.equal(
      result.metadata
        ?.bookingConfirmation,
      "affirmed",
    );

    assert.equal(
      result.metadata
        ?.ambiguityCount,
      1,
    );
  },
);


test(
  "keeps availability distinct from new booking",
  async () => {
    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider:
          provider(
            baseUnderstanding({
              intents: [
                {
                  value:
                    "availability",
                  confidence:
                    0.87,
                },
              ],
              acts: {},
            }),
          ),
      });

    const result =
      await analyzer.analyze(
        event,
      );

    assert.equal(
      result.taskType,
      "booking",
    );
    assert.equal(
      result.operationType,
      "availability",
    );
    assert.equal(
      result.confidence,
      0.87,
    );
  },
);

test(
  "overall confidence follows semantic intent rather than language confidence",
  async () => {
    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider:
          provider(
            baseUnderstanding({
              language: {
                primary: {
                  value: "en",
                  confidence: 0.99,
                },
                codeSwitches: [],
              },
              intents: [
                {
                  value:
                    "new_booking",
                  confidence:
                    0.61,
                },
              ],
              acts: {
                bookingRequest: {
                  value: true,
                  confidence:
                    0.58,
                },
              },
            }),
          ),
      });

    const result =
      await analyzer.analyze(
        event,
      );

    assert.equal(
      result.confidence,
      0.61,
    );
  },
);

test(
  "rejects missing shadow text before provider call",
  async () => {
    let called = false;

    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider: {
          providerId:
            "test-provider",

          async interpret() {
            called = true;
            return baseUnderstanding();
          },
        },
      });

    await assert.rejects(
      () =>
        analyzer.analyze({
          ...event,
          payload: {},
        }),
      (
        error: unknown,
      ) =>
        error instanceof
          P2StructuredUnderstandingShadowAnalyzerError &&
        error.causeCode ===
          "message_required",
    );

    assert.equal(
      called,
      false,
    );
  },
);

test(
  "rejects malformed canonical provider output",
  async () => {
    const analyzer =
      new P2StructuredUnderstandingShadowAnalyzer({
        provider:
          provider({
            schemaVersion: 99,
          }),
      });

    await assert.rejects(
      () =>
        analyzer.analyze(
          event,
        ),
      (
        error: unknown,
      ) =>
        error instanceof
          P2StructuredUnderstandingShadowAnalyzerError &&
        error.causeCode ===
          "schema_validation_failed",
    );
  },
);
