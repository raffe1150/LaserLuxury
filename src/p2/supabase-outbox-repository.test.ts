import assert from "node:assert/strict";
import test from "node:test";

import {
  P2OutboxRepositoryError,
  SupabaseOutboxRepository,
} from "./supabase-outbox-repository";

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
    assert.equal(table, "odin_outbox");

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

function outboxRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: "outbox-1",
    business_id: 100,
    conversation_id: "conversation-1",
    operation_id: "operation-1",
    schema_version: 1,
    channel: "telegram",
    recipient_key: "chat-100",
    delivery_key: "booking-confirmation:1",
    artifact: {
      text: "Booking confirmed",
    },
    status: "pending",
    attempt_count: 0,
    available_at:
      "2026-09-17T09:00:00.000Z",
    last_attempt_at: null,
    provider_message_id: null,
    last_error: null,
    created_at:
      "2026-09-17T09:00:00.000Z",
    updated_at:
      "2026-09-17T09:00:00.000Z",
    ...overrides,
  };
}

test("enqueueOnce inserts new durable outbox item", async () => {
  const row = outboxRow();

  const client = new FakeSupabase(
    [],
    {
      data: row,
      error: null,
    },
  );

  const repo =
    new SupabaseOutboxRepository(
      client as any,
    );

  const result = await repo.enqueueOnce({
    businessId: 100,
    conversationId: "conversation-1",
    operationId: "operation-1",
    channel: "telegram",
    recipientKey: "chat-100",
    deliveryKey: "booking-confirmation:1",
    artifact: {
      text: "Booking confirmed",
    },
  });

  assert.equal(result.inserted, true);
  assert.equal(result.row.id, "outbox-1");
  assert.equal(client.inserts.length, 1);
  assert.equal(client.inserts[0].status, "pending");
  assert.equal(client.inserts[0].attempt_count, 0);
});

test("duplicate delivery key returns existing row without overwrite", async () => {
  const existing = outboxRow({
    artifact: {
      text: "original durable artifact",
    },
    status: "delivered",
    provider_message_id: "provider-message-1",
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
    new SupabaseOutboxRepository(
      client as any,
    );

  const result = await repo.enqueueOnce({
    businessId: 100,
    channel: "telegram",
    recipientKey: "chat-100",
    deliveryKey: "booking-confirmation:1",
    artifact: {
      text: "retry must not overwrite",
    },
  });

  assert.equal(result.inserted, false);
  assert.equal(result.row.status, "delivered");
  assert.equal(
    result.row.provider_message_id,
    "provider-message-1",
  );

  assert.deepEqual(
    result.row.artifact,
    {
      text: "original durable artifact",
    },
  );
});

test("lookup is tenant scoped", async () => {
  const client = new FakeSupabase([
    outboxRow(),
    outboxRow({
      id: "outbox-other",
      business_id: 200,
      delivery_key: "other-key",
    }),
  ]);

  const repo =
    new SupabaseOutboxRepository(
      client as any,
    );

  const own =
    await repo.getByDeliveryKey(
      100,
      "booking-confirmation:1",
    );

  assert.equal(own?.id, "outbox-1");

  const crossTenant =
    await repo.getByDeliveryKey(
      100,
      "other-key",
    );

  assert.equal(crossTenant, null);
});

test("non-duplicate storage failure fails closed", async () => {
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
    new SupabaseOutboxRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.enqueueOnce({
        businessId: 100,
        channel: "telegram",
        recipientKey: "chat-100",
        deliveryKey: "booking-confirmation:1",
        artifact: {},
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof
          P2OutboxRepositoryError,
      );

      assert.equal(
        error.causeCode,
        "08006",
      );

      return true;
    },
  );
});

test("duplicate error without readable durable row fails closed", async () => {
  const client = new FakeSupabase(
    [],
    {
      data: null,
      error: {
        code: "23505",
        message: "duplicate key",
      },
    },
  );

  const repo =
    new SupabaseOutboxRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.enqueueOnce({
        businessId: 100,
        channel: "telegram",
        recipientKey: "chat-100",
        deliveryKey: "booking-confirmation:1",
        artifact: {},
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof
          P2OutboxRepositoryError,
      );

      assert.equal(
        error.causeCode,
        "duplicate_row_not_found",
      );

      return true;
    },
  );
});

test("invalid availableAt is rejected before insert", async () => {
  const client = new FakeSupabase([]);

  const repo =
    new SupabaseOutboxRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.enqueueOnce({
        businessId: 100,
        channel: "telegram",
        recipientKey: "chat-100",
        deliveryKey: "booking-confirmation:1",
        artifact: {},
        availableAt: "not-a-date",
      }),
    P2OutboxRepositoryError,
  );

  assert.equal(client.inserts.length, 0);
});
