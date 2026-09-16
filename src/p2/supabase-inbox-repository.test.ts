import assert from "node:assert/strict";
import test from "node:test";

import {
  P2InboxRepositoryError,
  SupabaseInboxRepository,
} from "./supabase-inbox-repository";

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
    assert.equal(table, "odin_inbox");

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

function inboxRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: "inbox-1",
    business_id: 100,
    conversation_id: "conversation-1",
    channel: "whatsapp",
    provider_scope: "phone-1",
    provider_event_id: "wamid-1",
    turn_sequence: 1,
    schema_version: 1,
    payload: {
      text: "hello",
    },
    status: "accepted",
    received_at:
      "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

test("acceptOnce inserts a new durable inbox row", async () => {
  const row = inboxRow();

  const client = new FakeSupabase(
    [],
    {
      data: row,
      error: null,
    },
  );

  const repo =
    new SupabaseInboxRepository(
      client as any,
    );

  const result = await repo.acceptOnce({
    businessId: 100,
    conversationId: "conversation-1",
    channel: "whatsapp",
    providerScope: "phone-1",
    providerEventId: "wamid-1",
    turnSequence: 1,
    payload: {
      text: "hello",
    },
  });

  assert.equal(result.inserted, true);
  assert.equal(result.row.id, "inbox-1");
  assert.equal(client.inserts.length, 1);
});

test("duplicate delivery returns existing row without overwriting it", async () => {
  const existing = inboxRow({
    payload: {
      text: "original durable payload",
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
    new SupabaseInboxRepository(
      client as any,
    );

  const result = await repo.acceptOnce({
    businessId: 100,
    conversationId: "conversation-1",
    channel: "whatsapp",
    providerScope: "phone-1",
    providerEventId: "wamid-1",
    turnSequence: 99,
    payload: {
      text: "different retry payload",
    },
  });

  assert.equal(result.inserted, false);

  assert.deepEqual(
    result.row.payload,
    {
      text: "original durable payload",
    },
  );
});

test("provider scope defaults to empty string", async () => {
  const row = inboxRow({
    provider_scope: "",
  });

  const client = new FakeSupabase(
    [],
    {
      data: row,
      error: null,
    },
  );

  const repo =
    new SupabaseInboxRepository(
      client as any,
    );

  await repo.acceptOnce({
    businessId: 100,
    channel: "telegram",
    providerEventId: "update-1",
    payload: {},
  });

  assert.equal(
    client.inserts[0].provider_scope,
    "",
  );
});

test("lookup is tenant scoped", async () => {
  const client = new FakeSupabase([
    inboxRow(),
    inboxRow({
      id: "inbox-other",
      business_id: 200,
      provider_event_id: "wamid-other",
    }),
  ]);

  const repo =
    new SupabaseInboxRepository(
      client as any,
    );

  const own =
    await repo.getByProviderEvent({
      businessId: 100,
      channel: "whatsapp",
      providerScope: "phone-1",
      providerEventId: "wamid-1",
    });

  assert.equal(own?.id, "inbox-1");

  const crossTenant =
    await repo.getByProviderEvent({
      businessId: 100,
      channel: "whatsapp",
      providerScope: "phone-1",
      providerEventId: "wamid-other",
    });

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
    new SupabaseInboxRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.acceptOnce({
        businessId: 100,
        channel: "whatsapp",
        providerEventId: "wamid-1",
        payload: {},
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof
          P2InboxRepositoryError,
      );

      assert.equal(
        error.causeCode,
        "08006",
      );

      return true;
    },
  );
});

test("duplicate error without readable row fails closed", async () => {
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
    new SupabaseInboxRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.acceptOnce({
        businessId: 100,
        channel: "whatsapp",
        providerEventId: "wamid-1",
        payload: {},
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof
          P2InboxRepositoryError,
      );

      assert.equal(
        error.causeCode,
        "duplicate_row_not_found",
      );

      return true;
    },
  );
});

test("invalid turn sequence is rejected before storage access", async () => {
  const client = new FakeSupabase([]);

  const repo =
    new SupabaseInboxRepository(
      client as any,
    );

  await assert.rejects(
    () =>
      repo.acceptOnce({
        businessId: 100,
        channel: "whatsapp",
        providerEventId: "wamid-1",
        turnSequence: -1,
        payload: {},
      }),
    P2InboxRepositoryError,
  );

  assert.equal(
    client.inserts.length,
    0,
  );
});
