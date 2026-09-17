import type {
  OdinResourceReservation,
} from "./contracts";

import type {
  CapacityOneReservationResult,
  ReservationRepository,
} from "./repositories";

type SupabaseLikeClient = {
  from(table: string): any;
  rpc(functionName: string, args: Record<string, unknown>): Promise<{
    data: any;
    error: any;
  }>;
};

export class P2ReservationRepositoryError extends Error {
  readonly code = "P2_RESERVATION_REPOSITORY_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2ReservationRepositoryError";
  }
}

const RESERVATION_COLUMNS = [
  "id",
  "business_id",
  "operation_id",
  "resource_id",
  "schema_version",
  "units",
  "start_at",
  "end_at",
  "buffer_before_minutes",
  "buffer_after_minutes",
  "status",
  "expires_at",
  "exclusive_capacity_one",
  "effective_window",
  "created_at",
  "updated_at",
].join(",");

function requiredString(
  value: unknown,
  code: string,
  message: string,
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new P2ReservationRepositoryError(
      message,
      code,
    );
  }

  return normalized;
}

function storageError(
  message: string,
  error: any,
): P2ReservationRepositoryError {
  return new P2ReservationRepositoryError(
    message,
    String(
      error?.code ||
      error?.message ||
      "unknown_storage_error",
    ),
  );
}

export class SupabaseReservationRepository
  implements ReservationRepository
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getById(
    businessId: number,
    reservationId: string,
  ): Promise<OdinResourceReservation | null> {
    if (!Number.isInteger(businessId) || businessId <= 0) {
      throw new P2ReservationRepositoryError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const id = requiredString(
      reservationId,
      "reservation_id_required",
      "Reservation id is required.",
    );

    const { data, error } = await this.supabase
      .from("odin_resource_reservations")
      .select(RESERVATION_COLUMNS)
      .eq("business_id", businessId)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw storageError(
        "Reservation lookup failed.",
        error,
      );
    }

    return (data as OdinResourceReservation | null) || null;
  }

  async createCapacityOne(params: {
    businessId: number;
    operationId: string;
    resourceId: string;
    startAt: string;
    endAt: string;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    status?: "held" | "reserved" | "dispatching" | "uncertain" | "verified";
    expiresAt?: string | null;
  }): Promise<CapacityOneReservationResult> {
    if (
      !Number.isInteger(params.businessId) ||
      params.businessId <= 0
    ) {
      throw new P2ReservationRepositoryError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const operationId = requiredString(
      params.operationId,
      "operation_id_required",
      "Operation id is required.",
    );

    const resourceId = requiredString(
      params.resourceId,
      "resource_id_required",
      "Resource id is required.",
    );

    const startAt = requiredString(
      params.startAt,
      "start_at_required",
      "Reservation start is required.",
    );

    const endAt = requiredString(
      params.endAt,
      "end_at_required",
      "Reservation end is required.",
    );

    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);

    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      throw new P2ReservationRepositoryError(
        "Invalid reservation window.",
        "invalid_reservation_window",
      );
    }

    const before = params.bufferBeforeMinutes ?? 0;
    const after = params.bufferAfterMinutes ?? 0;

    if (
      !Number.isSafeInteger(before) ||
      before < 0 ||
      !Number.isSafeInteger(after) ||
      after < 0
    ) {
      throw new P2ReservationRepositoryError(
        "Reservation buffers must be non-negative integers.",
        "invalid_reservation_buffer",
      );
    }

    const status = params.status ?? "held";

    const { data, error } = await this.supabase.rpc(
      "odin_create_capacity_one_reservation",
      {
        p_business_id: params.businessId,
        p_operation_id: operationId,
        p_resource_id: resourceId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_buffer_before_minutes: before,
        p_buffer_after_minutes: after,
        p_status: status,
        p_expires_at: params.expiresAt ?? null,
      },
    );

    if (error) {
      throw storageError(
        "Capacity-one reservation creation failed.",
        error,
      );
    }

    const row = Array.isArray(data)
      ? data[0]
      : data;

    if (!row) {
      throw new P2ReservationRepositoryError(
        "Reservation RPC returned no result.",
        "reservation_result_missing",
      );
    }

    if (row.outcome === "conflict") {
      return {
        outcome: "conflict",
        row: null,
      };
    }

    if (
      !["created", "existing"].includes(row.outcome) ||
      !row.reservation_id
    ) {
      throw new P2ReservationRepositoryError(
        "Reservation RPC returned an invalid result.",
        "invalid_reservation_result",
      );
    }

    const reservation: OdinResourceReservation = {
      id: row.reservation_id,
      business_id: row.business_id,
      operation_id: row.operation_id,
      resource_id: row.resource_id,
      schema_version: row.schema_version,
      units: row.units,
      start_at: row.start_at,
      end_at: row.end_at,
      buffer_before_minutes: row.buffer_before_minutes,
      buffer_after_minutes: row.buffer_after_minutes,
      status: row.status,
      expires_at: row.expires_at,
      exclusive_capacity_one: row.exclusive_capacity_one,
      effective_window: row.effective_window,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    if (
      reservation.units !== 1 ||
      reservation.exclusive_capacity_one !== true
    ) {
      throw new P2ReservationRepositoryError(
        "Reservation was not confirmed as authoritative capacity-one.",
        "capacity_one_not_confirmed",
      );
    }

    return {
      outcome: row.outcome as "created" | "existing",
      row: reservation,
    };
  }
}
