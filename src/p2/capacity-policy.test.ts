import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAuthoritativeCapacityOne,
  evaluateAuthoritativeCapacityPolicy,
  UnsupportedAuthoritativeCapacityError,
} from "./capacity-policy";

test("capacity=1 and requiredUnits=1 is authoritative", () => {
  assert.deepEqual(
    evaluateAuthoritativeCapacityPolicy({
      capacity: 1,
      requiredUnits: 1,
    }),
    {
      supported: true,
      mode: "exclusive_capacity_one",
      capacity: 1,
      requiredUnits: 1,
    },
  );
});

test("capacity > 1 fails closed during initial P2 rollout", () => {
  assert.deepEqual(
    evaluateAuthoritativeCapacityPolicy({
      capacity: 2,
      requiredUnits: 1,
    }),
    {
      supported: false,
      reason: "multi_capacity_not_yet_authoritative",
      capacity: 2,
      requiredUnits: 1,
    },
  );
});

test("required units cannot exceed resource capacity", () => {
  assert.deepEqual(
    evaluateAuthoritativeCapacityPolicy({
      capacity: 1,
      requiredUnits: 2,
    }),
    {
      supported: false,
      reason: "required_units_exceed_capacity",
      capacity: 1,
      requiredUnits: 2,
    },
  );
});

test("invalid resource capacities fail closed", () => {
  const decision = evaluateAuthoritativeCapacityPolicy({
    capacity: 0,
    requiredUnits: 1,
  });

  assert.equal(decision.supported, false);

  if (!decision.supported) {
    assert.equal(decision.reason, "invalid_capacity");
  }
});

test("assertion throws typed error for multi-capacity resources", () => {
  assert.throws(
    () =>
      assertAuthoritativeCapacityOne({
        capacity: 3,
        requiredUnits: 1,
      }),
    UnsupportedAuthoritativeCapacityError,
  );
});


test("supported assertion returns the unchanged authoritative decision without a reason", () => {
  const params = { capacity: 1, requiredUnits: 1 };
  const decision = assertAuthoritativeCapacityOne(params);
  assert.deepEqual(decision, evaluateAuthoritativeCapacityPolicy(params));
  assert.equal("reason" in decision, false);
  assert.deepEqual(params, { capacity: 1, requiredUnits: 1 });
});

for (const [capacity, requiredUnits, reason] of [
  [0, 1, "invalid_capacity"], [-1, 1, "invalid_capacity"],
  [1.5, 1, "invalid_capacity"], [NaN, 1, "invalid_capacity"], [Infinity, 1, "invalid_capacity"],
  [1, 0, "invalid_required_units"], [1, -1, "invalid_required_units"],
  [1, 0.5, "invalid_required_units"], [1, NaN, "invalid_required_units"], [1, Infinity, "invalid_required_units"],
  [1, 2, "required_units_exceed_capacity"], [2, 3, "required_units_exceed_capacity"],
  [2, 1, "multi_capacity_not_yet_authoritative"], [3, 2, "multi_capacity_not_yet_authoritative"],
] as const) {
  test(`unsupported ${capacity}/${requiredUnits} preserves ${reason} and fails closed`, () => {
    const params = { capacity, requiredUnits };
    const decision = evaluateAuthoritativeCapacityPolicy(params);
    assert.deepEqual(decision, { supported: false, reason, capacity, requiredUnits });
    assert.equal("mode" in decision, false);
    assert.throws(() => assertAuthoritativeCapacityOne(params), (error: unknown) => {
      assert.ok(error instanceof UnsupportedAuthoritativeCapacityError);
      assert.equal(error.code, "P2_CAPACITY_NOT_AUTHORITATIVE");
      assert.equal(error.name, "UnsupportedAuthoritativeCapacityError");
      assert.equal(error.message, `P2 authoritative resource capacity rejected: ${reason}`);
      assert.deepEqual(error.decision, decision);
      return true;
    });
    assert.deepEqual(params, { capacity, requiredUnits });
  });
}
