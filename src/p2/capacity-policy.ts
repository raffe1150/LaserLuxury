export type CapacityPolicyDecision =
  | {
      supported: true;
      mode: "exclusive_capacity_one";
      capacity: 1;
      requiredUnits: 1;
    }
  | {
      supported: false;
      reason:
        | "invalid_capacity"
        | "invalid_required_units"
        | "required_units_exceed_capacity"
        | "multi_capacity_not_yet_authoritative";
      capacity: number;
      requiredUnits: number;
    };

export function evaluateAuthoritativeCapacityPolicy(params: {
  capacity: number;
  requiredUnits: number;
}): CapacityPolicyDecision {
  const capacity = Number(params.capacity);
  const requiredUnits = Number(params.requiredUnits);

  if (!Number.isInteger(capacity) || capacity < 1) {
    return {
      supported: false,
      reason: "invalid_capacity",
      capacity,
      requiredUnits,
    };
  }

  if (!Number.isInteger(requiredUnits) || requiredUnits < 1) {
    return {
      supported: false,
      reason: "invalid_required_units",
      capacity,
      requiredUnits,
    };
  }

  if (requiredUnits > capacity) {
    return {
      supported: false,
      reason: "required_units_exceed_capacity",
      capacity,
      requiredUnits,
    };
  }

  if (capacity !== 1) {
    return {
      supported: false,
      reason: "multi_capacity_not_yet_authoritative",
      capacity,
      requiredUnits,
    };
  }

  if (requiredUnits !== 1) {
    return {
      supported: false,
      reason: "required_units_exceed_capacity",
      capacity,
      requiredUnits,
    };
  }

  return {
    supported: true,
    mode: "exclusive_capacity_one",
    capacity: 1,
    requiredUnits: 1,
  };
}

export class UnsupportedAuthoritativeCapacityError extends Error {
  readonly code = "P2_CAPACITY_NOT_AUTHORITATIVE";

  constructor(
    readonly decision: Exclude<
      CapacityPolicyDecision,
      { supported: true }
    >,
  ) {
    super(`P2 authoritative resource capacity rejected: ${decision.reason}`);
    this.name = "UnsupportedAuthoritativeCapacityError";
  }
}

export function assertAuthoritativeCapacityOne(params: {
  capacity: number;
  requiredUnits: number;
}): Extract<CapacityPolicyDecision, { supported: true }> {
  const decision = evaluateAuthoritativeCapacityPolicy(params);

  if (!decision.supported) {
    throw new UnsupportedAuthoritativeCapacityError(decision);
  }

  return decision;
}
