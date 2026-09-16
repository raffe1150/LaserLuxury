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
