import assert from "node:assert/strict";
import test from "node:test";

import {
  P2LeaseRepositoryError,
  SupabaseConversationLeaseRepository,
} from "./supabase-conversation-lease-repository";

type RpcCall = {
  functionName: string;
  params: Record<string, unknown>;
};

class FakeRpcQuery {
  constructor(
    private readonly result: {
      data: any;
      error: any;
    },
  ) {}

  async maybeSingle() {
    return this.result;
  }
}

class FakeSupabase {
  readonly calls: RpcCall[] = [];

  constructor(
    private readonly results: Record<
      string,
      { data: any; error: any }
    >,
  ) {}

  rpc(
    functionName: string,
    params: Record<string, unknown>,
  ) {
    this.calls.push({
      functionName,
      params,
    });

    return new FakeRpcQuery(
      this.results[functionName] || {
        data: null,
        error: null,
      },
    );
  }
}

function leaseRow(
  overrides: Record<string, any> = {},
) {
  return {
    conversation_id:
      "11111111-1111-1111-1111-111111111111",
    revision: 4,
    fence_epoch: 7,
    lease_owner: "worker-a",
    lease_expires_at:
      "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

test("claimLease calls frozen A1 RPC contract", async () => {
  const client = new FakeSupabase({
    odin_claim_conversation_lease: {
      data: leaseRow(),
      error: null,
    },
  });

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  const result = await repo.claimLease({
    businessId: 100,
    conversationId:
      "11111111-1111-1111-1111-111111111111",
    workerId: "worker-a",
    expectedRevision: 4,
    leaseSeconds: 30,
  });

  assert.equal(result?.fence_epoch, 7);

  assert.deepEqual(client.calls, [
    {
      functionName:
        "odin_claim_conversation_lease",
      params: {
        p_business_id: 100,
        p_conversation_id:
          "11111111-1111-1111-1111-111111111111",
        p_worker_id: "worker-a",
        p_expected_revision: 4,
        p_lease_seconds: 30,
      },
    },
  ]);
});

test("claimLease returns null when lease was not acquired", async () => {
  const client = new FakeSupabase({
    odin_claim_conversation_lease: {
      data: null,
      error: null,
    },
  });

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  const result = await repo.claimLease({
    businessId: 100,
    conversationId:
      "11111111-1111-1111-1111-111111111111",
    workerId: "worker-b",
    expectedRevision: 4,
    leaseSeconds: 30,
  });

  assert.equal(result, null);
});

test("renewLease uses worker identity and fence epoch", async () => {
  const client = new FakeSupabase({
    odin_renew_conversation_lease: {
      data: leaseRow({
        lease_owner: "worker-a",
        fence_epoch: 8,
      }),
      error: null,
    },
  });

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  const result = await repo.renewLease({
    businessId: 100,
    conversationId:
      "11111111-1111-1111-1111-111111111111",
    workerId: "worker-a",
    fenceEpoch: 8,
    leaseSeconds: 45,
  });

  assert.equal(result?.lease_owner, "worker-a");

  assert.deepEqual(client.calls[0], {
    functionName:
      "odin_renew_conversation_lease",
    params: {
      p_business_id: 100,
      p_conversation_id:
        "11111111-1111-1111-1111-111111111111",
      p_worker_id: "worker-a",
      p_fence_epoch: 8,
      p_lease_seconds: 45,
    },
  });
});

test("stale or rejected renewal returns null", async () => {
  const client = new FakeSupabase({
    odin_renew_conversation_lease: {
      data: null,
      error: null,
    },
  });

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  const result = await repo.renewLease({
    businessId: 100,
    conversationId:
      "11111111-1111-1111-1111-111111111111",
    workerId: "stale-worker",
    fenceEpoch: 3,
    leaseSeconds: 30,
  });

  assert.equal(result, null);
});

test("RPC failure throws typed fail-closed error", async () => {
  const client = new FakeSupabase({
    odin_claim_conversation_lease: {
      data: null,
      error: {
        code: "08006",
        message: "connection failure",
      },
    },
  });

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.claimLease({
        businessId: 100,
        conversationId:
          "11111111-1111-1111-1111-111111111111",
        workerId: "worker-a",
        expectedRevision: 4,
        leaseSeconds: 30,
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof P2LeaseRepositoryError,
      );

      assert.equal(error.causeCode, "08006");

      return true;
    },
  );
});

test("invalid lease duration is rejected before RPC", async () => {
  const client = new FakeSupabase({});

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.claimLease({
        businessId: 100,
        conversationId:
          "11111111-1111-1111-1111-111111111111",
        workerId: "worker-a",
        expectedRevision: 4,
        leaseSeconds: 301,
      }),
    P2LeaseRepositoryError,
  );

  assert.equal(client.calls.length, 0);
});

test("invalid revision is rejected before RPC", async () => {
  const client = new FakeSupabase({});

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.claimLease({
        businessId: 100,
        conversationId:
          "11111111-1111-1111-1111-111111111111",
        workerId: "worker-a",
        expectedRevision: -1,
        leaseSeconds: 30,
      }),
    P2LeaseRepositoryError,
  );

  assert.equal(client.calls.length, 0);
});

test("invalid fence epoch is rejected before RPC", async () => {
  const client = new FakeSupabase({});

  const repo =
    new SupabaseConversationLeaseRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.renewLease({
        businessId: 100,
        conversationId:
          "11111111-1111-1111-1111-111111111111",
        workerId: "worker-a",
        fenceEpoch: -1,
        leaseSeconds: 30,
      }),
    P2LeaseRepositoryError,
  );

  assert.equal(client.calls.length, 0);
});
