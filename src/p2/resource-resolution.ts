import {
  evaluateAuthoritativeCapacityPolicy,
  type CapacityPolicyDecision,
} from "./capacity-policy";

import type {
  OdinResource,
  OdinServiceResource,
} from "./contracts";

import type {
  ResourceRepository,
} from "./repositories";

export type ResourceResolutionFailureReason =
  | "no_active_mapping"
  | "resource_not_found"
  | "resource_inactive"
  | "tenant_mismatch"
  | "capacity_not_authoritative";

export type ResourceResolutionResult =
  | {
      ok: true;
      mapping: OdinServiceResource;
      resource: OdinResource;
      capacityPolicy: Extract<
        CapacityPolicyDecision,
        { supported: true }
      >;
    }
  | {
      ok: false;
      reason: ResourceResolutionFailureReason;
      mapping?: OdinServiceResource;
      resource?: OdinResource;
      capacityPolicy?: CapacityPolicyDecision;
    };

export async function resolveAuthoritativeResourceForService(params: {
  businessId: number;
  serviceKey: string;
  repository: ResourceRepository;
}): Promise<ResourceResolutionResult> {
  const mappings = await params.repository.listServiceResources(
    params.businessId,
    params.serviceKey,
  );

  if (mappings.length === 0) {
    return {
      ok: false,
      reason: "no_active_mapping",
    };
  }

  for (const mapping of mappings) {
    const resource = await params.repository.getById(
      params.businessId,
      mapping.resource_id,
    );

    if (!resource) {
      continue;
    }

    if (
      mapping.business_id !== params.businessId ||
      resource.business_id !== params.businessId
    ) {
      return {
        ok: false,
        reason: "tenant_mismatch",
        mapping,
        resource,
      };
    }

    if (resource.status !== "active") {
      continue;
    }

    const capacityPolicy = evaluateAuthoritativeCapacityPolicy({
      capacity: resource.capacity,
      requiredUnits: mapping.required_units,
    });

    if (!capacityPolicy.supported) {
      return {
        ok: false,
        reason: "capacity_not_authoritative",
        mapping,
        resource,
        capacityPolicy,
      };
    }

    return {
      ok: true,
      mapping,
      resource,
      capacityPolicy,
    };
  }

  const firstMapping = mappings[0];

  const firstResource = await params.repository.getById(
    params.businessId,
    firstMapping.resource_id,
  );

  if (!firstResource) {
    return {
      ok: false,
      reason: "resource_not_found",
      mapping: firstMapping,
    };
  }

  if (firstResource.status !== "active") {
    return {
      ok: false,
      reason: "resource_inactive",
      mapping: firstMapping,
      resource: firstResource,
    };
  }

  return {
    ok: false,
    reason: "resource_not_found",
    mapping: firstMapping,
  };
}
