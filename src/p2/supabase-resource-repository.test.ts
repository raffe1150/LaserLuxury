import assert from "node:assert/strict";
import test from "node:test";

import {
  SupabaseResourceRepository,
} from "./supabase-resource-repository";

type Row = Record<string, any>;

class FakeQuery {
  private filters: Array<[string, any]> = [];
  private ordering: Array<[string, boolean]> = [];

  constructor(
    private readonly rows: Row[],
  ) {}

  eq(column: string, value: any) {
    this.filters.push([column, value]);
    return this;
  }

  order(
    column: string,
    options?: { ascending?: boolean },
  ) {
    this.ordering.push([
      column,
      options?.ascending !== false,
    ]);
    return this;
  }

  private filteredRows() {
    const result = this.rows.filter((row) =>
      this.filters.every(
        ([column, value]) => row[column] === value,
      ),
    );

    for (const [column, ascending] of this.ordering) {
      result.sort((a, b) => {
        if (a[column] === b[column]) return 0;
        return (
          (a[column] < b[column] ? -1 : 1) *
          (ascending ? 1 : -1)
        );
      });
    }

    return result;
  }

  async maybeSingle() {
    const rows = this.filteredRows();

    return {
      data: rows.length === 1 ? rows[0] : null,
      error:
        rows.length <= 1
          ? null
          : { code: "PGRST116" },
    };
  }

  then(
    resolve: (value: {
      data: Row[];
      error: null;
    }) => unknown,
  ) {
    return Promise.resolve({
      data: this.filteredRows(),
      error: null,
    }).then(resolve);
  }
}

class FakeSupabase {
  constructor(
    private readonly tables: Record<string, Row[]>,
  ) {}

  from(table: string) {
    return {
      select: (_columns: string) =>
        new FakeQuery(this.tables[table] || []),
    };
  }
}

function resourceRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: "resource-1",
    business_id: 100,
    schema_version: 1,
    resource_key: "primary-calendar",
    resource_type: "calendar",
    name: "Primary Calendar",
    capacity: 1,
    status: "active",
    provider: "google_calendar",
    provider_resource_id: "calendar-1",
    metadata: {},
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function serviceResourceRow(
  overrides: Partial<Row> = {},
): Row {
  return {
    id: "mapping-1",
    business_id: 100,
    schema_version: 1,
    service_key: "video-consultation",
    resource_id: "resource-1",
    required_units: 1,
    priority: 0,
    active: true,
    metadata: {},
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

test("resource lookup is tenant scoped by id", async () => {
  const repo = new SupabaseResourceRepository(
    new FakeSupabase({
      odin_resources: [
        resourceRow(),
        resourceRow({
          id: "resource-2",
          business_id: 200,
        }),
      ],
    }) as any,
  );

  const row = await repo.getById(
    100,
    "resource-1",
  );

  assert.equal(row?.business_id, 100);
  assert.equal(row?.id, "resource-1");

  const crossTenant = await repo.getById(
    100,
    "resource-2",
  );

  assert.equal(crossTenant, null);
});

test("resource lookup is tenant scoped by key", async () => {
  const repo = new SupabaseResourceRepository(
    new FakeSupabase({
      odin_resources: [
        resourceRow(),
        resourceRow({
          business_id: 200,
          resource_key: "other-resource",
        }),
      ],
    }) as any,
  );

  const row = await repo.getByKey(
    100,
    "primary-calendar",
  );

  assert.equal(
    row?.resource_key,
    "primary-calendar",
  );
});

test("service mappings return only active tenant mappings", async () => {
  const repo = new SupabaseResourceRepository(
    new FakeSupabase({
      odin_service_resources: [
        serviceResourceRow({
          id: "mapping-priority-10",
          priority: 10,
        }),
        serviceResourceRow({
          id: "mapping-priority-1",
          priority: 1,
        }),
        serviceResourceRow({
          id: "mapping-inactive",
          active: false,
          priority: 0,
        }),
        serviceResourceRow({
          id: "mapping-other-business",
          business_id: 200,
          priority: 0,
        }),
      ],
    }) as any,
  );

  const rows = await repo.listServiceResources(
    100,
    "video-consultation",
  );

  assert.deepEqual(
    rows.map((row) => row.id),
    [
      "mapping-priority-1",
      "mapping-priority-10",
    ],
  );
});

test("missing resource returns null", async () => {
  const repo = new SupabaseResourceRepository(
    new FakeSupabase({
      odin_resources: [],
    }) as any,
  );

  assert.equal(
    await repo.getByKey(
      100,
      "missing-resource",
    ),
    null,
  );
});
