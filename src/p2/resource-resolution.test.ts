import assert from "node:assert/strict";
import test from "node:test";

import type {
  OdinResource,
  OdinServiceResource,
} from "./contracts";

import type {
  ResourceRepository,
} from "./repositories";

import {
  resolveAuthoritativeResourceForService,
} from "./resource-resolution";

function resource(
  overrides: Partial<OdinResource> = {},
): OdinResource {
  return {
    id: "resource-1",
    business_id: 100,
    schema_version: 1,
    resource_key: "primary",
    resource_type: "calendar",
    name: "Primary Resource",
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

function mapping(
  overrides: Partial<OdinServiceResource> = {},
): OdinServiceResource {
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

class FakeResourceRepository
  implements ResourceRepository
{
  constructor(
    private readonly resources: OdinResource[],
    private readonly mappings: OdinServiceResource[],
  ) {}

  async getById(
    businessId: number,
    resourceId: string,
  ) {
    return (
      this.resources.find(
        (row) =>
          row.business_id === businessId &&
          row.id === resourceId,
      ) || null
    );
  }

  async getByKey(
    businessId: number,
    resourceKey: string,
  ) {
    return (
      this.resources.find(
        (row) =>
          row.business_id === businessId &&
          row.resource_key === resourceKey,
      ) || null
    );
  }

  async listServiceResources(
    businessId: number,
    serviceKey: string,
  ) {
    return this.mappings
      .filter(
        (row) =>
          row.business_id === businessId &&
          row.service_key === serviceKey &&
          row.active,
      )
      .sort((a, b) => a.priority - b.priority);
  }
}

test("resolves active capacity-one resource", async () => {
  const repository = new FakeResourceRepository(
    [resource()],
    [mapping()],
  );

  const result =
    await resolveAuthoritativeResourceForService({
      businessId: 100,
      serviceKey: "video-consultation",
      repository,
    });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.resource.id, "resource-1");
    assert.equal(
      result.capacityPolicy.mode,
      "exclusive_capacity_one",
    );
  }
});

test("returns no_active_mapping when service has no mappings", async () => {
  const repository = new FakeResourceRepository(
    [resource()],
    [],
  );

  const result =
    await resolveAuthoritativeResourceForService({
      businessId: 100,
      serviceKey: "video-consultation",
      repository,
    });

  assert.deepEqual(result, {
    ok: false,
    reason: "no_active_mapping",
  });
});

test("skips inactive resource when later active mapping exists", async () => {
  const repository = new FakeResourceRepository(
    [
      resource({
        id: "inactive-resource",
        status: "inactive",
      }),
      resource({
        id: "active-resource",
        resource_key: "secondary",
      }),
    ],
    [
      mapping({
        id: "mapping-1",
        resource_id: "inactive-resource",
        priority: 0,
      }),
      mapping({
        id: "mapping-2",
        resource_id: "active-resource",
        priority: 1,
      }),
    ],
  );

  const result =
    await resolveAuthoritativeResourceForService({
      businessId: 100,
      serviceKey: "video-consultation",
      repository,
    });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.resource.id, "active-resource");
  }
});

test("fails closed for multi-capacity resource", async () => {
  const repository = new FakeResourceRepository(
    [
      resource({
        capacity: 3,
      }),
    ],
    [mapping()],
  );

  const result =
    await resolveAuthoritativeResourceForService({
      businessId: 100,
      serviceKey: "video-consultation",
      repository,
    });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(
      result.reason,
      "capacity_not_authoritative",
    );

    assert.equal(
      result.capacityPolicy?.supported,
      false,
    );
  }
});

test("does not cross tenant boundaries", async () => {
  const repository = new FakeResourceRepository(
    [
      resource({
        business_id: 200,
      }),
    ],
    [
      mapping({
        resource_id: "resource-1",
      }),
    ],
  );

  const result =
    await resolveAuthoritativeResourceForService({
      businessId: 100,
      serviceKey: "video-consultation",
      repository,
    });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.reason,
    "resource_not_found",
  );
});
