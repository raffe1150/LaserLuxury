import type {
  OdinOperation,
} from "./contracts";

import type {
  OperationGetOrCreateResult,
  OperationRepository,
} from "./repositories";

type SupabaseLikeClient = {
  from(table: string): any;
};

const OPERATION_COLUMNS = [
  "id",
  "business_id",
  "conversation_id",
  "task_id",
  "turn_id",
  "schema_version",
  "operation_type",
  "operation_key",
  "status",
  "action_digest",
  "provider",
  "provider_reference",
  "result",
  "uncertainty",
  "created_at",
  "updated_at",
].join(",");

export class P2OperationRepositoryError extends Error {
  readonly code = "P2_OPERATION_REPOSITORY_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2OperationRepositoryError";
  }
}

function isDuplicateError(error: any): boolean {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();

  return (
    code === "23505" ||
    message.includes("duplicate key") ||
    message.includes("unique constraint")
  );
}

function validateKey(params: {
  businessId: number;
  operationKey: string;
}) {
  if (
    !Number.isInteger(params.businessId) ||
    params.businessId <= 0
  ) {
    throw new P2OperationRepositoryError(
      "Invalid business id.",
      "invalid_business_id",
    );
  }

  if (!String(params.operationKey || "").trim()) {
    throw new P2OperationRepositoryError(
      "Operation key is required.",
      "operation_key_required",
    );
  }
}

function storageError(
  message: string,
  error: any,
): P2OperationRepositoryError {
  return new P2OperationRepositoryError(
    message,
    String(
      error?.code ||
      error?.message ||
      "unknown_storage_error",
    ),
  );
}

export class SupabaseOperationJournalRepository
  implements OperationRepository
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getByOperationKey(
    businessId: number,
    operationKey: string,
  ): Promise<OdinOperation | null> {
    const normalizedKey =
      String(operationKey || "").trim();

    validateKey({
      businessId,
      operationKey: normalizedKey,
    });

    const { data, error } = await this.supabase
      .from("odin_operations")
      .select(OPERATION_COLUMNS)
      .eq("business_id", businessId)
      .eq("operation_key", normalizedKey)
      .maybeSingle();

    if (error) {
      throw storageError(
        "Operation lookup failed.",
        error,
      );
    }

    return (data as OdinOperation | null) || null;
  }

  async getOrCreate(params: {
    businessId: number;
    conversationId?: string | null;
    taskId?: string | null;
    turnId?: string | null;
    operationType: string;
    operationKey: string;
    status: string;
    actionDigest?: string | null;
    provider?: string | null;
  }): Promise<OperationGetOrCreateResult> {
    const operationKey =
      String(params.operationKey || "").trim();

    const operationType =
      String(params.operationType || "").trim();

    const status =
      String(params.status || "").trim();

    validateKey({
      businessId: params.businessId,
      operationKey,
    });

    if (!operationType) {
      throw new P2OperationRepositoryError(
        "Operation type is required.",
        "operation_type_required",
      );
    }

    if (!status) {
      throw new P2OperationRepositoryError(
        "Operation status is required.",
        "operation_status_required",
      );
    }

    const insertPayload = {
      business_id: params.businessId,
      conversation_id:
        params.conversationId || null,
      task_id:
        params.taskId || null,
      turn_id:
        params.turnId || null,
      schema_version: 1,
      operation_type: operationType,
      operation_key: operationKey,
      status,
      action_digest:
        params.actionDigest || null,
      provider:
        params.provider || null,
    };

    const { data, error } = await this.supabase
      .from("odin_operations")
      .insert([insertPayload])
      .select(OPERATION_COLUMNS)
      .maybeSingle();

    if (!error && data) {
      return {
        row: data as OdinOperation,
        inserted: true,
      };
    }

    if (!isDuplicateError(error)) {
      throw storageError(
        "Operation journal insert failed.",
        error || {
          code: "insert_row_missing",
        },
      );
    }

    const existing =
      await this.getByOperationKey(
        params.businessId,
        operationKey,
      );

    if (!existing) {
      throw new P2OperationRepositoryError(
        "Duplicate operation key was reported but the durable row could not be read.",
        "duplicate_row_not_found",
      );
    }

    return {
      row: existing,
      inserted: false,
    };
  }
}
