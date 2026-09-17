import assert from "node:assert/strict";
import test from "node:test";

import {
  SupabaseShadowEvaluationRecorder,
} from "./supabase-shadow-recorder";

const evaluation = {
  businessId: 100,
  conversationKey:
    "wa:phone-1:customer-1",
  channel: "whatsapp",
  providerScope: "phone-1",
  providerEventId: "event-1",
  executionMode: "shadow" as const,
  legacy: {
    languageCode: "en",
    taskType: "booking",
  },
  shadow: {
    languageCode: "en",
    taskType: "booking",
    confidence: 0.95,
  },
  comparison: "match" as const,
  evaluatedAt:
    "2026-09-17T20:01:00.000Z",
};

const storedRow = {
  id: "shadow-1",
  business_id: 100,
  schema_version: 1,
  conversation_key:
    "wa:phone-1:customer-1",
  channel: "whatsapp",
  provider_scope: "phone-1",
  provider_event_id: "event-1",
  execution_mode: "shadow" as const,
  legacy_observation: {
    languageCode: "en",
    taskType: "booking",
  },
  shadow_decision: {
    languageCode: "en",
    taskType: "booking",
    confidence: 0.95,
  },
  comparison: "match" as const,
  evaluated_at:
    "2026-09-17T20:01:00.000Z",
  created_at:
    "2026-09-17T20:01:00.000Z",
  updated_at:
    "2026-09-17T20:01:00.000Z",
};

class FakeQuery {
  private mode:
    | "insert"
    | "select"
    | null = null;

  constructor(
    private readonly scenario:
      "insert"
      | "duplicate"
      | "failure"
      | "duplicate_missing",
  ) {}

  insert() {
    this.mode = "insert";
    return this;
  }

  select() {
    if (!this.mode) {
      this.mode = "select";
    }
    return this;
  }

  eq() {
    return this;
  }

  async maybeSingle() {
    if (this.mode === "insert") {
      if (
        this.scenario ===
        "insert"
      ) {
        return {
          data: storedRow,
          error: null,
        };
      }

      if (
        this.scenario ===
        "failure"
      ) {
        return {
          data: null,
          error: {
            code: "500",
            message: "storage down",
          },
        };
      }

      return {
        data: null,
        error: {
          code: "23505",
          message: "duplicate",
        },
      };
    }

    if (
      this.scenario ===
      "duplicate_missing"
    ) {
      return {
        data: null,
        error: null,
      };
    }

    return {
      data: storedRow,
      error: null,
    };
  }
}

class FakeSupabase {
  constructor(
    private readonly scenario:
      | "insert"
      | "duplicate"
      | "failure"
      | "duplicate_missing",
  ) {}

  from() {
    return new FakeQuery(
      this.scenario,
    );
  }
}

test("inserts new shadow evaluation", async () => {
  const recorder =
    new SupabaseShadowEvaluationRecorder(
      new FakeSupabase(
        "insert",
      ) as any,
    );

  const result =
    await recorder.recordOnce(
      evaluation,
    );

  assert.equal(
    result.inserted,
    true,
  );

  assert.equal(
    result.row.id,
    "shadow-1",
  );
});

test("duplicate event reuses existing shadow evaluation", async () => {
  const recorder =
    new SupabaseShadowEvaluationRecorder(
      new FakeSupabase(
        "duplicate",
      ) as any,
    );

  const result =
    await recorder.recordOnce(
      evaluation,
    );

  assert.equal(
    result.inserted,
    false,
  );

  assert.equal(
    result.row.id,
    "shadow-1",
  );
});

test("non duplicate storage failure fails closed", async () => {
  const recorder =
    new SupabaseShadowEvaluationRecorder(
      new FakeSupabase(
        "failure",
      ) as any,
    );

  await assert.rejects(
    () =>
      recorder.recordOnce(
        evaluation,
      ),
    (error: unknown) => {
      assert.equal(
        (error as {
          causeCode?: string;
        }).causeCode,
        "storage_failure",
      );

      return true;
    },
  );
});

test("duplicate without readable durable row fails closed", async () => {
  const recorder =
    new SupabaseShadowEvaluationRecorder(
      new FakeSupabase(
        "duplicate_missing",
      ) as any,
    );

  await assert.rejects(
    () =>
      recorder.recordOnce(
        evaluation,
      ),
    (error: unknown) => {
      assert.equal(
        (error as {
          causeCode?: string;
        }).causeCode,
        "duplicate_row_unreadable",
      );

      return true;
    },
  );
});
