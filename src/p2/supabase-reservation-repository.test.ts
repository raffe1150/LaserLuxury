import assert from "node:assert/strict";
import test from "node:test";

import {
  P2ReservationRepositoryError,
  SupabaseReservationRepository,
} from "./supabase-reservation-repository";

class FakeSupabase {
  readonly rpcCalls: Array<{
    functionName: string;
    args: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly rpcResult: {
      data: any;
      error: any;
    },
  ) {}

  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ) {
    this.rpcCalls.push({
      functionName,
      args,
    });

    return Promise.resolve(this.rpcResult);
  }

  from() {
    throw new Error("from() not expected in these tests");
  }
}

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "created",
    reservation_id: "reservation-1",
    business_id: 100,
    operation_id: "operation-1",
    resource_id: "resource-1",
    schema_version: 1,
    units: 1,
    start_at: "2026-09-18T12:00:00.000Z",
    end_at: "2026-09-18T13:00:00.000Z",
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
    status: "held",
    expires_at: null,
    exclusive_capacity_one: true,
    effective_window:
      '["2026-09-18 12:00:00+00","2026-09-18 13:00:00+00")',
    created_at: "2026-09-17T01:00:00.000Z",
    updated_at: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

test("creates authoritative capacity-one reservation through RPC", async () => {
  const client = new FakeSupabase({
    data: [createdRow()],
    error: null,
  });

  const repo = new SupabaseReservationRepository(
    client as any,
  );

  const result = await repo.createCapacityOne({
    businessId: 100,
    operationId: "operation-1",
    resourceId: "resource-1",
    startAt: "2026-09-18T12:00:00.000Z",
    endAt: "2026-09-18T13:00:00.000Z",
  });

  assert.equal(result.outcome, "created");

  if (result.outcome === "created") {
    assert.equal(result.row.id, "reservation-1");
    assert.equal(result.row.units, 1);
    assert.equal(
      result.row.exclusive_capacity_one,
      true,
    );
  }

  assert.equal(
    client.rpcCalls[0].functionName,
    "odin_create_capacity_one_reservation",
  );
});

test("overlap conflict is returned as deterministic conflict", async () => {
  const client = new FakeSupabase({
    data: [{
      ...createdRow({
        outcome: "conflict",
        reservation_id: null,
        created_at: null,
        updated_at: null,
      }),
    }],
    error: null,
  });

  const repo = new SupabaseReservationRepository(
    client as any,
  );

  const result = await repo.createCapacityOne({
    businessId: 100,
    operationId: "operation-2",
    resourceId: "resource-1",
    startAt: "2026-09-18T12:30:00.000Z",
    endAt: "2026-09-18T13:30:00.000Z",
  });

  assert.deepEqual(result, {
    outcome: "conflict",
    row: null,
  });
});

test("database or RPC failure fails closed", async () => {
  const client = new FakeSupabase({
    data: null,
    error: {
      code: "P0001",
      message: "multi_capacity_not_yet_authoritative",
    },
  });

  const repo = new SupabaseReservationRepository(
    client as any,
  );

  await assert.rejects(
    () =>
      repo.createCapacityOne({
        businessId: 100,
        operationId: "operation-1",
        resourceId: "resource-1",
        startAt: "2026-09-18T12:00:00.000Z",
        endAt: "2026-09-18T13:00:00.000Z",
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof P2ReservationRepositoryError,
      );

      assert.equal(error.causeCode, "P0001");
      return true;
    },
  );
});

test("invalid time window is rejected before RPC", async () => {
  const client = new FakeSupabase({
    data: null,
    error: null,
  });

  const repo = new SupabaseReservationRepository(
    client as any,
  );

  await assert.rejects(
    () =>
      repo.createCapacityOne({
        businessId: 100,
        operationId: "operation-1",
        resourceId: "resource-1",
        startAt: "2026-09-18T13:00:00.000Z",
        endAt: "2026-09-18T12:00:00.000Z",
      }),
    P2ReservationRepositoryError,
  );

  assert.equal(client.rpcCalls.length, 0);
});

test("invalid buffers are rejected before RPC", async () => {
  const client = new FakeSupabase({
    data: null,
    error: null,
  });

  const repo = new SupabaseReservationRepository(
    client as any,
  );

  await assert.rejects(
    () =>
      repo.createCapacityOne({
        businessId: 100,
        operationId: "operation-1",
        resourceId: "resource-1",
        startAt: "2026-09-18T12:00:00.000Z",
        endAt: "2026-09-18T13:00:00.000Z",
        bufferBeforeMinutes: -1,
      }),
    P2ReservationRepositoryError,
  );

  assert.equal(client.rpcCalls.length, 0);
});

test("created result must prove exclusive capacity one", async () => {
  const client = new FakeSupabase({
    data: [
      createdRow({
        exclusive_capacity_one: false,
      }),
    ],
    error: null,
  });

  const repo = new SupabaseReservationRepository(
    client as any,
  );

  await assert.rejects(
    () =>
      repo.createCapacityOne({
        businessId: 100,
        operationId: "operation-1",
        resourceId: "resource-1",
        startAt: "2026-09-18T12:00:00.000Z",
        endAt: "2026-09-18T13:00:00.000Z",
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof P2ReservationRepositoryError,
      );

      assert.equal(
        error.causeCode,
        "capacity_one_not_confirmed",
      );

      return true;
    },
  );
});
