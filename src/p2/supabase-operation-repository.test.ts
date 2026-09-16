import assert from "node:assert/strict";
import test from "node:test";

import {
  P2OperationRepositoryError,
  SupabaseOperationJournalRepository,
} from "./supabase-operation-repository";

type Row = Record<string, any>;

class SelectQuery {
  private filters: Array<[string, any]> = [];

  constructor(
    private readonly rows: Row[],
  ) {}

  eq(column: string, value: any) {
    this.filters.push([column, value]);
    return this;
  }

  async maybeSingle() {
    const rows = this.rows.filter((row) =>
      this.filters.every(
        ([column, value]) =>
          row[column] === value,
      ),
    );

    if (rows.length === 0) {
      return {
        data: null,
        error: null,
      };
    }

    if (rows.length > 1) {
      return {
        data: null,
        error: {
          code: "PGRST116",
          message: "multiple rows",
        },
      };
    }

    return {
      data: rows[0],
      error: null,
    };
  }
}

class InsertQuery {
  constructor(
    private readonly result: {
      data: Row | null;
      error: any;
    },
  ) {}

  select(_columns: string) {
    return this;
  }

  async maybeSingle() {
    return this.result;
  }
}

class FakeSupabase {
  readonly inserts: Row[] = [];

  constructor(
    private readonly rows: Row[],
    private readonly insertResult?: {
      data: Row | null;
      error: any;
    },
  ) {}

  from(table: string) {
    assert.equal(table, "odin_operations");

    return {
      select: (_columns: string) =>
        new SelectQuery(this.rows),

      insert: (rows: Row[]) => {
        this.inserts.push(...rows);

        return new InsertQuery(
          this.insertResult || {
            data: rows[0],
            error: null,
          },
        );
      },
    };
  }
}

function operationRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: "operation-1",
    business_id: 100,
    conversation_id: "conversation-1",
    task_id: null,
    turn_id: null,
    schema_version: 1,
    operation_type: "create_booking",
    operation_key: "booking:key-1",
    status: "proposed",
    action_digest: "digest-1",
    provider: "google_calendar",
    provider_reference: null,
    result: null,
    uncertainty: null,
    created_at:
      "2026-09-17T01:00:00.000Z",
    updated_at:
      "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

test("getOrCreate inserts a new durable operation", async () => {
  const row = operationRow();

  const client = new FakeSupabase(
    [],
    {
      data: row,
      error: null,
    },
  );

  const repo =
    new SupabaseOperationJournalRepository(
      client as any,
    );

  const result = await repo.getOrCreate({
    businessId: 100,
    conversationId: "conversation-1",
    operationType: "create_booking",
    operationKey: "booking:key-1",
    status: "proposed",
    actionDigest: "digest-1",
    provider: "google_calendar",
  });

  assert.equal(result.inserted, true);
  assert.equal(result.row.id, "operation-1");
  assert.equal(client.inserts.length, 1);
});

test("duplicate operation key returns existing durable row", async () => {
  const existing = operationRow({
    status: "verified",
    result: {
      bookingId: "booking-1",
    },
  });

  const client = new FakeSupabase(
    [existing],
    {
      data: null,
      error: {
        code: "23505",
        message: "duplicate key",
      },
    },
  );

  const repo =
    new SupabaseOperationJournalRepository(
      client as any,
    );

  const result = await repo.getOrCreate({
    businessId: 100,
    operationType: "create_booking",
    operationKey: "booking:key-1",
    status: "proposed",
  });

  assert.equal(result.inserted, false);
  assert.equal(result.row.status, "verified");

  assert.deepEqual(
    result.row.result,
    {
      bookingId: "booking-1",
    },
  );
});

test("operation lookup is tenant scoped", async () => {
  const client = new FakeSupabase([
    operationRow(),
    operationRow({
      id: "operation-other",
      business_id: 200,
      operation_key: "booking:key-2",
    }),
  ]);

  const repo =
    new SupabaseOperationJournalRepository(
      client as any,
    );

  const own =
    await repo.getByOperationKey(
      100,
      "booking:key-1",
    );

  assert.equal(own?.id, "operation-1");

  const crossTenant =
    await repo.getByOperationKey(
      100,
      "booking:key-2",
    );

  assert.equal(crossTenant, null);
});

test("storage failure fails closed", async () => {
  const client = new FakeSupabase(
    [],
    {
      data: null,
      error: {
        code: "08006",
        message: "connection failure",
      },
    },
  );

  const repo =
    new SupabaseOperationJournalRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.getOrCreate({
        businessId: 100,
        operationType: "create_booking",
        operationKey: "booking:key-1",
        status: "proposed",
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof
          P2OperationRepositoryError,
      );

      assert.equal(
        error.causeCode,
        "08006",
      );

      return true;
    },
  );
});

test("missing operation type is rejected before insert", async () => {
  const client = new FakeSupabase([]);

  const repo =
    new SupabaseOperationJournalRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.getOrCreate({
        businessId: 100,
        operationType: "",
        operationKey: "booking:key-1",
        status: "proposed",
      }),
    P2OperationRepositoryError,
  );

  assert.equal(client.inserts.length, 0);
});

test("missing operation status is rejected before insert", async () => {
  const client = new FakeSupabase([]);

  const repo =
    new SupabaseOperationJournalRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.getOrCreate({
        businessId: 100,
        operationType: "create_booking",
        operationKey: "booking:key-1",
        status: "",
      }),
    P2OperationRepositoryError,
  );

  assert.equal(client.inserts.length, 0);
});
