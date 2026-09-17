import assert from "node:assert/strict";
import test from "node:test";

import {
  P2ProcessingCoordinator,
} from "./processing-coordinator";

const conversation = {
  id: "conversation-1",
  business_id: 100,
  conversation_key: "wa:1",
  schema_version: 1,
  revision: 4,
  runtime_generation: null,
  lease_owner: null,
  lease_expires_at: null,
  fence_epoch: 7,
  language_code: "en",
  aggregate_meta: {},
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};

const inbox = {
  id: "inbox-1",
  business_id: 100,
  conversation_id: "conversation-1",
  channel: "whatsapp",
  provider_scope: "phone-1",
  provider_event_id: "event-1",
  turn_sequence: 1,
  schema_version: 1,
  payload: {},
  status: "accepted",
  received_at: "2026-09-17T00:00:00Z",
};

const lease = {
  conversation_id: "conversation-1",
  revision: 4,
  fence_epoch: 8,
  lease_owner: "worker-a",
  lease_expires_at: "2026-09-17T00:01:00Z",
};

const operation = {
  id: "operation-1",
  business_id: 100,
  conversation_id: "conversation-1",
  task_id: null,
  turn_id: "inbox-1",
  schema_version: 1,
  operation_type: "create_booking",
  operation_key: "booking:1",
  status: "proposed",
  action_digest: "digest-1",
  provider: null,
  provider_reference: null,
  result: null,
  uncertainty: null,
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};

const reservation = {
  id: "reservation-1",
  business_id: 100,
  operation_id: "operation-1",
  resource_id: "resource-1",
  schema_version: 1,
  units: 1,
  start_at: "2026-09-18T10:00:00Z",
  end_at: "2026-09-18T11:00:00Z",
  buffer_before_minutes: 0,
  buffer_after_minutes: 0,
  status: "held",
  expires_at: null,
  exclusive_capacity_one: true,
  effective_window:
    '["2026-09-18 10:00:00+00","2026-09-18 11:00:00+00")',
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};

const outbox = {
  id: "outbox-1",
  business_id: 100,
  conversation_id: "conversation-1",
  operation_id: "operation-1",
  schema_version: 1,
  channel: "telegram",
  recipient_key: "chat-1",
  delivery_key: "delivery-1",
  artifact: { text: "shadow output" },
  status: "pending",
  attempt_count: 0,
  available_at: "2026-09-17T00:00:00Z",
  last_attempt_at: null,
  provider_message_id: null,
  last_error: null,
  created_at: "2026-09-17T00:00:00Z",
  updated_at: "2026-09-17T00:00:00Z",
};

function plan() {
  return {
    executionMode: "authority" as const,
    businessId: 100,
    inbox,
    workerId: "worker-a",
    operation: {
      type: "create_booking",
      key: "booking:1",
      actionDigest: "digest-1",
    },
    reservation: {
      resourceId: "resource-1",
      startAt: "2026-09-18T10:00:00Z",
      endAt: "2026-09-18T11:00:00Z",
    },
    outbox: {
      channel: "telegram",
      recipientKey: "chat-1",
      deliveryKey: "delivery-1",
      artifact: { text: "shadow output" },
    },
  };
}

test("executes durable capacity-one processing flow", async () => {
  const calls: string[] = [];

  const coordinator = new P2ProcessingCoordinator({
    conversations: {
      async getById() {
        calls.push("conversation");
        return conversation;
      },
    },
    leases: {
      async claimLease() {
        calls.push("lease");
        return lease;
      },
    },
    operations: {
      async getOrCreate() {
        calls.push("operation");
        return {
          row: operation,
          inserted: true,
        };
      },
    },
    reservations: {
      async createCapacityOne() {
        calls.push("reservation");
        return {
          outcome: "created",
          row: reservation,
        };
      },
    },
    outbox: {
      async enqueueOnce() {
        calls.push("outbox");
        return {
          row: outbox,
          inserted: true,
        };
      },
    },
    finalization: {
      async finalizeTurn() {
        calls.push("finalize");
        return {
          outcome: "finalized",
          conversationId: "conversation-1",
          inboxId: "inbox-1",
          previousRevision: 4,
          newRevision: 5,
          fenceEpoch: 8,
          inboxStatus: "processed",
        };
      },
    },
  });

  const result =
    await coordinator.processCapacityOnePlan(
      plan(),
    );

  assert.equal(result.outcome, "completed");

  assert.deepEqual(calls, [
    "conversation",
    "lease",
    "operation",
    "reservation",
    "outbox",
    "finalize",
  ]);
});

test("retry reuses existing operation reservation and outbox", async () => {
  const coordinator = new P2ProcessingCoordinator({
    conversations: {
      async getById() {
        return conversation;
      },
    },
    leases: {
      async claimLease() {
        return lease;
      },
    },
    operations: {
      async getOrCreate() {
        return {
          row: operation,
          inserted: false,
        };
      },
    },
    reservations: {
      async createCapacityOne() {
        return {
          outcome: "existing",
          row: reservation,
        };
      },
    },
    outbox: {
      async enqueueOnce() {
        return {
          row: outbox,
          inserted: false,
        };
      },
    },
    finalization: {
      async finalizeTurn() {
        return {
          outcome: "finalized",
          conversationId: "conversation-1",
          inboxId: "inbox-1",
          previousRevision: 4,
          newRevision: 5,
          fenceEpoch: 8,
          inboxStatus: "processed",
        };
      },
    },
  });

  const result =
    await coordinator.processCapacityOnePlan(
      plan(),
    );

  assert.equal(result.outcome, "completed");

  if (result.outcome === "completed") {
    assert.equal(result.operationInserted, false);
    assert.equal(
      result.reservationOutcome,
      "existing",
    );
    assert.equal(result.outboxInserted, false);
  }
});

test("reservation conflict stops before outbox and finalization", async () => {
  let outboxCalled = false;
  let finalizeCalled = false;

  const coordinator = new P2ProcessingCoordinator({
    conversations: {
      async getById() {
        return conversation;
      },
    },
    leases: {
      async claimLease() {
        return lease;
      },
    },
    operations: {
      async getOrCreate() {
        return {
          row: operation,
          inserted: true,
        };
      },
    },
    reservations: {
      async createCapacityOne() {
        return {
          outcome: "conflict",
          row: null,
        };
      },
    },
    outbox: {
      async enqueueOnce() {
        outboxCalled = true;
        throw new Error("must not run");
      },
    },
    finalization: {
      async finalizeTurn() {
        finalizeCalled = true;
        throw new Error("must not run");
      },
    },
  });

  const result =
    await coordinator.processCapacityOnePlan(
      plan(),
    );

  assert.equal(
    result.outcome,
    "reservation_conflict",
  );

  assert.equal(outboxCalled, false);
  assert.equal(finalizeCalled, false);
});

test("lease contention stops before operation creation", async () => {
  let operationCalled = false;

  const coordinator = new P2ProcessingCoordinator({
    conversations: {
      async getById() {
        return conversation;
      },
    },
    leases: {
      async claimLease() {
        return null;
      },
    },
    operations: {
      async getOrCreate() {
        operationCalled = true;
        throw new Error("must not run");
      },
    },
    reservations: {
      async createCapacityOne() {
        throw new Error("must not run");
      },
    },
    outbox: {
      async enqueueOnce() {
        throw new Error("must not run");
      },
    },
    finalization: {
      async finalizeTurn() {
        throw new Error("must not run");
      },
    },
  });

  const result =
    await coordinator.processCapacityOnePlan(
      plan(),
    );

  assert.equal(
    result.outcome,
    "lease_unavailable",
  );

  assert.equal(operationCalled, false);
});

test("processed inbox is not re-executed", async () => {
  const coordinator = new P2ProcessingCoordinator({
    conversations: {
      async getById() {
        throw new Error("must not run");
      },
    },
    leases: {
      async claimLease() {
        throw new Error("must not run");
      },
    },
    operations: {
      async getOrCreate() {
        throw new Error("must not run");
      },
    },
    reservations: {
      async createCapacityOne() {
        throw new Error("must not run");
      },
    },
    outbox: {
      async enqueueOnce() {
        throw new Error("must not run");
      },
    },
    finalization: {
      async finalizeTurn() {
        throw new Error("must not run");
      },
    },
  });

  const result =
    await coordinator.processCapacityOnePlan({
      ...plan(),
      inbox: {
        ...inbox,
        status: "processed",
      },
    });

  assert.deepEqual(result, {
    outcome: "inbox_not_processable",
    reason: "not_accepted",
  });
});

test("finalization rejection is surfaced without pretending completion", async () => {
  const coordinator = new P2ProcessingCoordinator({
    conversations: {
      async getById() {
        return conversation;
      },
    },
    leases: {
      async claimLease() {
        return lease;
      },
    },
    operations: {
      async getOrCreate() {
        return {
          row: operation,
          inserted: true,
        };
      },
    },
    reservations: {
      async createCapacityOne() {
        return {
          outcome: "created",
          row: reservation,
        };
      },
    },
    outbox: {
      async enqueueOnce() {
        return {
          row: outbox,
          inserted: true,
        };
      },
    },
    finalization: {
      async finalizeTurn() {
        return {
          outcome: "rejected_fence",
          conversationId: "conversation-1",
          inboxId: "inbox-1",
          previousRevision: 4,
          newRevision: 4,
          fenceEpoch: 9,
          inboxStatus: null,
        };
      },
    },
  });

  const result =
    await coordinator.processCapacityOnePlan(
      plan(),
    );

  assert.equal(
    result.outcome,
    "finalization_rejected",
  );
});

test("shadow mode is rejected before authoritative processing begins", async () => {
  let touchedStorage = false;

  const coordinator =
    new P2ProcessingCoordinator({
      conversations: {
        async getById() {
          touchedStorage = true;
          throw new Error(
            "must not run",
          );
        },
      },
      leases: {
        async claimLease() {
          touchedStorage = true;
          throw new Error(
            "must not run",
          );
        },
      },
      operations: {
        async getOrCreate() {
          touchedStorage = true;
          throw new Error(
            "must not run",
          );
        },
      },
      reservations: {
        async createCapacityOne() {
          touchedStorage = true;
          throw new Error(
            "must not run",
          );
        },
      },
      outbox: {
        async enqueueOnce() {
          touchedStorage = true;
          throw new Error(
            "must not run",
          );
        },
      },
      finalization: {
        async finalizeTurn() {
          touchedStorage = true;
          throw new Error(
            "must not run",
          );
        },
      },
    });

  await assert.rejects(
    () =>
      coordinator.processCapacityOnePlan({
        ...plan(),
        executionMode: "shadow",
      }),
    (error: unknown) => {
      assert.equal(
        (error as {
          causeCode?: string;
        }).causeCode,
        "authority_required",
      );

      return true;
    },
  );

  assert.equal(
    touchedStorage,
    false,
  );
});
