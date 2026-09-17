import assert from "node:assert/strict";
import test from "node:test";

import type {
  UnderstandingProvider,
} from "../ai/understanding/provider";

import {
  createP2LiveShadowRuntime,
} from "./live-shadow-runtime";

function provider(): UnderstandingProvider {
  return {
    providerId:
      "test-provider",

    async interpret() {
      return {
        schemaVersion: 1,
        language: {
          primary: {
            value: "en",
            confidence: 0.96,
          },
          codeSwitches: [],
        },
        intents: [
          {
            value:
              "new_booking",
            confidence: 0.94,
          },
        ],
        acts: {
          bookingRequest: {
            value: true,
            confidence: 0.93,
          },
        },
        entities: {},
        ambiguities: [],
      };
    },
  };
}

const input = {
  event: {
    businessId: 101,
    conversationKey:
      "wa:scope:customer",
    channel: "whatsapp",
    providerScope: "scope",
    providerEventId:
      "evt-1",
    receivedAt:
      "2026-09-17T20:00:00.000Z",
    payload: {
      text:
        "I want to book tomorrow",
      timezone:
        "Europe/Stockholm",
      currentTimeIso:
        "2026-09-17T20:00:00.000Z",
      configuredServices: [],
      bookingPhase: "idle",
      offeredSlotCount: 0,
      selectedSlotPresent: false,
      knownFields: [],
    },
  },
};

test(
  "is disabled by default",
  async () => {
    let storageTouched =
      false;

    const runtime =
      createP2LiveShadowRuntime({
        supabase: {
          from() {
            storageTouched = true;
            throw new Error(
              "must not touch storage",
            );
          },
        },

        provider: provider(),

        environment: {},
      });

    assert.equal(
      runtime.status,
      "disabled",
    );

    const result =
      await runtime.mirror(
        input,
      );

    assert.equal(
      result.status,
      "disabled",
    );

    assert.equal(
      storageTouched,
      false,
    );
  },
);


test(
  "omitted environment is disabled and side-effect free",
  async () => {
    let providerCalled = false;
    let storageTouched = false;

    const runtime =
      createP2LiveShadowRuntime({
        supabase: {
          from() {
            storageTouched = true;
            throw new Error(
              "must not touch storage",
            );
          },
        },

        provider: {
          providerId:
            "test-provider",

          async interpret() {
            providerCalled = true;

            return {
              schemaVersion: 1,
              language: {
                primary: {
                  value: "en",
                  confidence: 1,
                },
                codeSwitches: [],
              },
              intents: [],
              acts: {},
              entities: {},
              ambiguities: [],
            };
          },
        },
      });

    assert.equal(
      runtime.status,
      "disabled",
    );

    const result =
      await runtime.mirror(
        input,
      );

    assert.equal(
      result.status,
      "disabled",
    );

    assert.equal(
      providerCalled,
      false,
    );

    assert.equal(
      storageTouched,
      false,
    );
  },
);

test(
  "fails closed to missing dependency when enabled without storage",
  async () => {
    const runtime =
      createP2LiveShadowRuntime({
        supabase: null,
        provider: provider(),

        environment: {
          P2_DURABLE_SHADOW_ENABLED:
            "true",
          P2_DURABLE_SHADOW_BUSINESS_IDS:
            "101",
        },
      });

    assert.equal(
      runtime.status,
      "missing_dependency",
    );

    const result =
      await runtime.mirror(
        input,
      );

    assert.equal(
      result.status,
      "disabled",
    );
  },
);

test(
  "fails closed to missing dependency when enabled without provider",
  async () => {
    const runtime =
      createP2LiveShadowRuntime({
        supabase: {
          from() {
            throw new Error(
              "must not be reached",
            );
          },
        },

        provider: null,

        environment: {
          P2_DURABLE_SHADOW_ENABLED:
            "true",
          P2_DURABLE_SHADOW_BUSINESS_IDS:
            "101",
        },
      });

    assert.equal(
      runtime.status,
      "missing_dependency",
    );
  },
);

test(
  "ready runtime analyzes and records shadow evaluation",
  async () => {
    let insertedRow:
      Record<string, unknown>
      | null = null;

    const existingRow = {
      id: "shadow-1",
      business_id: 101,
      schema_version: 1,
      conversation_key:
        "wa:scope:customer",
      channel: "whatsapp",
      provider_scope: "scope",
      provider_event_id:
        "evt-1",
      execution_mode:
        "shadow",
      legacy_observation:
        null,
      shadow_decision: {},
      comparison:
        "not_comparable",
      evaluated_at:
        "2026-09-17T20:00:00.000Z",
      created_at:
        "2026-09-17T20:00:00.000Z",
      updated_at:
        "2026-09-17T20:00:00.000Z",
    };

    const supabase = {
      from(table: string) {
        assert.equal(
          table,
          "odin_shadow_evaluations",
        );

        return {
          insert(rows: any[]) {
            insertedRow =
              rows[0];

            return {
              select() {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        ...existingRow,
                        shadow_decision:
                          insertedRow &&
                          typeof insertedRow ===
                            "object" &&
                          "shadow_decision" in
                            insertedRow
                            ? (
                                insertedRow as any
                              )
                                .shadow_decision
                            : {},
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const runtime =
      createP2LiveShadowRuntime({
        supabase,
        provider: provider(),

        environment: {
          P2_DURABLE_SHADOW_ENABLED:
            "true",
          P2_DURABLE_SHADOW_BUSINESS_IDS:
            "101",
          P2_DURABLE_SHADOW_TIMEOUT_MS:
            "2000",
        },
      });

    assert.equal(
      runtime.status,
      "ready",
    );

    const result =
      await runtime.mirror(
        input,
      );

    assert.equal(
      result.status,
      "recorded",
    );

    assert.ok(insertedRow);

    assert.equal(
      (
        insertedRow as any
      ).execution_mode,
      "shadow",
    );

    assert.equal(
      (
        insertedRow as any
      ).comparison,
      "not_comparable",
    );

    assert.equal(
      (
        insertedRow as any
      ).shadow_decision
        .operationType,
      "new_booking",
    );
  },
);

test(
  "fails closed when enabled without a business allowlist",
  async () => {
    let providerCalled = false;
    let storageTouched = false;

    const runtime =
      createP2LiveShadowRuntime({
        supabase: {
          from() {
            storageTouched = true;
            throw new Error(
              "must not touch storage",
            );
          },
        },
        provider: {
          providerId: "test-provider",
          async interpret() {
            providerCalled = true;
            return {
              schemaVersion: 1,
              language: {
                primary: {
                  value: "en",
                  confidence: 1,
                },
                codeSwitches: [],
              },
              intents: [],
              acts: {},
              entities: {},
              ambiguities: [],
            };
          },
        },
        environment: {
          P2_DURABLE_SHADOW_ENABLED:
            "true",
        },
      });

    assert.equal(runtime.status, "disabled");

    const result =
      await runtime.mirror(input);

    assert.equal(result.status, "disabled");
    assert.equal(providerCalled, false);
    assert.equal(storageTouched, false);
  },
);

test(
  "does not mirror a business outside the configured cohort",
  async () => {
    let providerCalled = false;
    let storageTouched = false;

    const runtime =
      createP2LiveShadowRuntime({
        supabase: {
          from() {
            storageTouched = true;
            throw new Error(
              "must not touch storage",
            );
          },
        },
        provider: {
          providerId: "test-provider",
          async interpret() {
            providerCalled = true;
            return {};
          },
        },
        environment: {
          P2_DURABLE_SHADOW_ENABLED:
            "true",
          P2_DURABLE_SHADOW_BUSINESS_IDS:
            "202,303",
        },
      });

    assert.equal(runtime.status, "ready");

    const result =
      await runtime.mirror(input);

    assert.equal(result.status, "disabled");
    assert.equal(providerCalled, false);
    assert.equal(storageTouched, false);
  },
);

test(
  "allows an explicitly configured business into durable shadow",
  async () => {
    let inserted = false;

    const runtime =
      createP2LiveShadowRuntime({
        supabase: {
          from(table: string) {
            assert.equal(
              table,
              "odin_shadow_evaluations",
            );

            return {
              insert(rows: any[]) {
                inserted = true;

                return {
                  select() {
                    return {
                      async maybeSingle() {
                        return {
                          data: {
                            id: "shadow-cohort-1",
                            business_id: 101,
                            schema_version: 1,
                            conversation_key:
                              "wa:scope:customer",
                            channel: "whatsapp",
                            provider_scope:
                              "scope",
                            provider_event_id:
                              "evt-1",
                            execution_mode:
                              "shadow",
                            legacy_observation:
                              null,
                            shadow_decision:
                              rows[0]?.shadow_decision ?? {},
                            comparison:
                              "not_comparable",
                            evaluated_at:
                              "2026-09-17T20:00:00.000Z",
                            created_at:
                              "2026-09-17T20:00:00.000Z",
                            updated_at:
                              "2026-09-17T20:00:00.000Z",
                          },
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        },
        provider: provider(),
        environment: {
          P2_DURABLE_SHADOW_ENABLED:
            "true",
          P2_DURABLE_SHADOW_BUSINESS_IDS:
            "101",
        },
      });

    assert.equal(runtime.status, "ready");

    const result =
      await runtime.mirror(input);

    assert.equal(result.status, "recorded");
    assert.equal(inserted, true);
  },
);
