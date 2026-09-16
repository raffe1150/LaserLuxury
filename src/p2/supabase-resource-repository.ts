import type {
  OdinResource,
  OdinServiceResource,
} from "./contracts";

import type {
  ResourceRepository,
} from "./repositories";

type SupabaseLikeClient = {
  from(table: string): {
    select(columns: string): any;
  };
};

const RESOURCE_COLUMNS = [
  "id",
  "business_id",
  "schema_version",
  "resource_key",
  "resource_type",
  "name",
  "capacity",
  "status",
  "provider",
  "provider_resource_id",
  "metadata",
  "created_at",
  "updated_at",
].join(",");

const SERVICE_RESOURCE_COLUMNS = [
  "id",
  "business_id",
  "schema_version",
  "service_key",
  "resource_id",
  "required_units",
  "priority",
  "active",
  "metadata",
  "created_at",
  "updated_at",
].join(",");

function normalizeSingleResult<T>(
  data: T | null,
  error: any,
): T | null {
  if (error) {
    throw new Error(
      `P2 read-only repository query failed: ${String(
        error?.code || error?.message || "unknown_error",
      )}`,
    );
  }

  return data || null;
}

export class SupabaseResourceRepository
  implements ResourceRepository
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getById(
    businessId: number,
    resourceId: string,
  ): Promise<OdinResource | null> {
    const { data, error } = await this.supabase
      .from("odin_resources")
      .select(RESOURCE_COLUMNS)
      .eq("business_id", businessId)
      .eq("id", resourceId)
      .maybeSingle();

    return normalizeSingleResult<OdinResource>(
      data as OdinResource | null,
      error,
    );
  }

  async getByKey(
    businessId: number,
    resourceKey: string,
  ): Promise<OdinResource | null> {
    const { data, error } = await this.supabase
      .from("odin_resources")
      .select(RESOURCE_COLUMNS)
      .eq("business_id", businessId)
      .eq("resource_key", resourceKey)
      .maybeSingle();

    return normalizeSingleResult<OdinResource>(
      data as OdinResource | null,
      error,
    );
  }

  async listServiceResources(
    businessId: number,
    serviceKey: string,
  ): Promise<OdinServiceResource[]> {
    const { data, error } = await this.supabase
      .from("odin_service_resources")
      .select(SERVICE_RESOURCE_COLUMNS)
      .eq("business_id", businessId)
      .eq("service_key", serviceKey)
      .eq("active", true)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(
        `P2 read-only repository query failed: ${String(
          error?.code || error?.message || "unknown_error",
        )}`,
      );
    }

    return Array.isArray(data)
      ? (data as OdinServiceResource[])
      : [];
  }
}
