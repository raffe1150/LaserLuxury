import assert from "node:assert/strict";
import test from "node:test";

import {
  P2TurnFinalizationError,
  SupabaseConversationFinalizationRepository,
} from "./supabase-conversation-finalization-repository";

class FakeSupabase {
  readonly calls: Array<{
    functionName: string;
    args: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly result: {
      data: any;
      error: any;
    },
  ) {}

  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ) {
    this.calls.push({
      functionName,
      args,
    });

    return Promise.resolve(this.result);
  }
}

function finalizedRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    outcome: "finalized",
    conversation_id: "conversation-1",
    inbox_id: "inbox-1",
    previous_revision: 7,
    new_revision: 8,
    fence_epoch: 12,
    inbox_status: "processed",
    ...overrides,
  };
}

test("finalizeTurn calls A3 RPC contract", async () => {
  const client = new FakeSupabase({
    data: [finalizedRow()],
    error: null,
  });

  const repo =
    new SupabaseConversationFinalizationRepository(
      client as any,
    );

  const result = await repo.finalizeTurn({
    businessId: 100,
    conversationId: "conversation-1",
    inboxId: "inbox-1",
    workerId: "worker-a",
    expectedRevision: 7,
    fenceEpoch: 12,
  });

  assert.equal(result.outcome, "finalized");
  assert.equal(result.previousRevision, 7);
  assert.equal(result.newRevision, 8);
  assert.equal(result.inboxStatus, "processed");

  assert.equal(
    client.calls[0].functionName,
    "odin_finalize_conversation_turn",
  );
});

test("stale fence result is preserved as deterministic rejection", async () => {
  const client = new FakeSupabase({
    data: [
      finalizedRow({
        outcome: "rejected_fence",
        previous_revision: 7,
        new_revision: 7,
        fence_epoch: 13,
        inbox_status: null,
      }),
    ],
    error: null,
  });

  const repo =
    new SupabaseConversationFinalizationRepository(
      client as any,
    );

  const result = await repo.finalizeTurn({
    businessId: 100,
    conversationId: "conversation-1",
    inboxId: "inbox-1",
    workerId: "worker-a",
    expectedRevision: 7,
    fenceEpoch: 12,
  });

  assert.equal(result.outcome, "rejected_fence");
  assert.equal(result.newRevision, 7);
});

test("wrong revision result is preserved as deterministic rejection", async () => {
  const client = new FakeSupabase({
    data: [
      finalizedRow({
        outcome: "rejected_revision",
        previous_revision: 8,
        new_revision: 8,
        inbox_status: null,
      }),
    ],
    error: null,
  });

  const repo =
    new SupabaseConversationFinalizationRepository(
      client as any,
    );

  const result = await repo.finalizeTurn({
    businessId: 100,
    conversationId: "conversation-1",
    inboxId: "inbox-1",
    workerId: "worker-a",
    expectedRevision: 7,
    fenceEpoch: 12,
  });

  assert.equal(result.outcome, "rejected_revision");
});

test("storage failure fails closed", async () => {
  const client = new FakeSupabase({
    data: null,
    error: {
      code: "08006",
      message: "connection failure",
    },
  });

  const repo =
    new SupabaseConversationFinalizationRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.finalizeTurn({
        businessId: 100,
        conversationId: "conversation-1",
        inboxId: "inbox-1",
        workerId: "worker-a",
        expectedRevision: 7,
        fenceEpoch: 12,
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof P2TurnFinalizationError,
      );

      assert.equal(error.causeCode, "08006");
      return true;
    },
  );
});

test("invalid finalized result fails closed", async () => {
  const client = new FakeSupabase({
    data: [
      finalizedRow({
        new_revision: 9,
      }),
    ],
    error: null,
  });

  const repo =
    new SupabaseConversationFinalizationRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.finalizeTurn({
        businessId: 100,
        conversationId: "conversation-1",
        inboxId: "inbox-1",
        workerId: "worker-a",
        expectedRevision: 7,
        fenceEpoch: 12,
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof P2TurnFinalizationError,
      );

      assert.equal(
        error.causeCode,
        "invalid_finalized_result",
      );

      return true;
    },
  );
});

test("invalid input is rejected before RPC", async () => {
  const client = new FakeSupabase({
    data: null,
    error: null,
  });

  const repo =
    new SupabaseConversationFinalizationRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.finalizeTurn({
        businessId: 100,
        conversationId: "conversation-1",
        inboxId: "inbox-1",
        workerId: "",
        expectedRevision: 7,
        fenceEpoch: 12,
      }),
    P2TurnFinalizationError,
  );

  assert.equal(client.calls.length, 0);
});
