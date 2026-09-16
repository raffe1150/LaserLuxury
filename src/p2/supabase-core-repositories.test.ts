import assert from "node:assert/strict";
import test from "node:test";

import {
  SupabaseConversationRepository,
  SupabaseOperationRepository,
} from "./supabase-core-repositories";

type Row = Record<string, any>;

class FakeQuery {
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

class FakeSupabase {
  constructor(
    private readonly tables: Record<string, Row[]>,
  ) {}

  from(table: string) {
    return {
      select: (_columns: string) =>
        new FakeQuery(
          this.tables[table] || [],
        ),
    };
  }
}

function conversationRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: "conversation-1",
    business_id: 100,
    conversation_key: "whatsapp:user-1",
    schema_version: 1,
    revision: 4,
    runtime_generation: null,
    lease_owner: null,
    lease_expires_at: null,
    fence_epoch: 2,
    language_code: "sv",
    aggregate_meta: {},
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
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
    action_digest: null,
    provider: "google_calendar",
    provider_reference: null,
    result: null,
    uncertainty: null,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

test("conversation lookup by id is tenant scoped", async () => {
  const repo = new SupabaseConversationRepository(
    new FakeSupabase({
      odin_conversations: [
        conversationRow(),
        conversationRow({
          id: "conversation-2",
          business_id: 200,
        }),
      ],
    }) as any,
  );

  const own = await repo.getById(
    100,
    "conversation-1",
  );

  assert.equal(own?.id, "conversation-1");

  const crossTenant = await repo.getById(
    100,
    "conversation-2",
  );

  assert.equal(crossTenant, null);
});

test("conversation lookup by key is tenant scoped", async () => {
  const repo = new SupabaseConversationRepository(
    new FakeSupabase({
      odin_conversations: [
        conversationRow(),
        conversationRow({
          business_id: 200,
          conversation_key:
            "whatsapp:other-user",
        }),
      ],
    }) as any,
  );

  const row = await repo.getByKey(
    100,
    "whatsapp:user-1",
  );

  assert.equal(row?.business_id, 100);
  assert.equal(
    row?.conversation_key,
    "whatsapp:user-1",
  );
});

test("missing conversation returns null", async () => {
  const repo = new SupabaseConversationRepository(
    new FakeSupabase({
      odin_conversations: [],
    }) as any,
  );

  assert.equal(
    await repo.getByKey(
      100,
      "missing",
    ),
    null,
  );
});

test("operation lookup is tenant scoped", async () => {
  const repo = new SupabaseOperationRepository(
    new FakeSupabase({
      odin_operations: [
        operationRow(),
        operationRow({
          id: "operation-2",
          business_id: 200,
          operation_key: "booking:key-2",
        }),
      ],
    }) as any,
  );

  const own = await repo.getByOperationKey(
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

test("missing operation returns null", async () => {
  const repo = new SupabaseOperationRepository(
    new FakeSupabase({
      odin_operations: [],
    }) as any,
  );

  assert.equal(
    await repo.getByOperationKey(
      100,
      "missing",
    ),
    null,
  );
});
