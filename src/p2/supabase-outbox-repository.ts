import type {
  OdinOutboxEntry,
} from "./contracts";

import type {
  OutboxEnqueueOnceResult,
  OutboxRepository,
} from "./repositories";

type SupabaseLikeClient = {
  from(table: string): any;
};

const OUTBOX_COLUMNS = [
  "id",
  "business_id",
  "conversation_id",
  "operation_id",
  "schema_version",
  "channel",
  "recipient_key",
  "delivery_key",
  "artifact",
  "status",
  "attempt_count",
  "available_at",
  "last_attempt_at",
  "provider_message_id",
  "last_error",
  "created_at",
  "updated_at",
].join(",");

export class P2OutboxRepositoryError extends Error {
  readonly code = "P2_OUTBOX_REPOSITORY_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2OutboxRepositoryError";
  }
}

function normalizeRequired(
  value: unknown,
  code: string,
  message: string,
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new P2OutboxRepositoryError(
      message,
      code,
    );
  }

  return normalized;
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

function storageError(
  message: string,
  error: any,
): P2OutboxRepositoryError {
  return new P2OutboxRepositoryError(
    message,
    String(
      error?.code ||
      error?.message ||
      "unknown_storage_error",
    ),
  );
}

export class SupabaseOutboxRepository
  implements OutboxRepository
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getByDeliveryKey(
    businessId: number,
    deliveryKey: string,
  ): Promise<OdinOutboxEntry | null> {
    if (
      !Number.isInteger(businessId) ||
      businessId <= 0
    ) {
      throw new P2OutboxRepositoryError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const normalizedKey = normalizeRequired(
      deliveryKey,
      "delivery_key_required",
      "Delivery key is required.",
    );

    const { data, error } = await this.supabase
      .from("odin_outbox")
      .select(OUTBOX_COLUMNS)
      .eq("business_id", businessId)
      .eq("delivery_key", normalizedKey)
      .maybeSingle();

    if (error) {
      throw storageError(
        "Outbox lookup failed.",
        error,
      );
    }

    return (data as OdinOutboxEntry | null) || null;
  }

  async enqueueOnce(params: {
    businessId: number;
    conversationId?: string | null;
    operationId?: string | null;
    channel: string;
    recipientKey: string;
    deliveryKey: string;
    artifact: Record<string, unknown>;
    availableAt?: string | null;
  }): Promise<OutboxEnqueueOnceResult> {
    if (
      !Number.isInteger(params.businessId) ||
      params.businessId <= 0
    ) {
      throw new P2OutboxRepositoryError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const channel = normalizeRequired(
      params.channel,
      "channel_required",
      "Channel is required.",
    );

    const recipientKey = normalizeRequired(
      params.recipientKey,
      "recipient_key_required",
      "Recipient key is required.",
    );

    const deliveryKey = normalizeRequired(
      params.deliveryKey,
      "delivery_key_required",
      "Delivery key is required.",
    );

    let availableAt: string | undefined;

    if (params.availableAt) {
      const parsed = Date.parse(params.availableAt);

      if (!Number.isFinite(parsed)) {
        throw new P2OutboxRepositoryError(
          "Invalid availableAt timestamp.",
          "invalid_available_at",
        );
      }

      availableAt = params.availableAt;
    }

    const insertPayload: Record<string, unknown> = {
      business_id: params.businessId,
      conversation_id:
        params.conversationId || null,
      operation_id:
        params.operationId || null,
      schema_version: 1,
      channel,
      recipient_key: recipientKey,
      delivery_key: deliveryKey,
      artifact: params.artifact || {},
      status: "pending",
      attempt_count: 0,
    };

    if (availableAt) {
      insertPayload.available_at = availableAt;
    }

    const { data, error } = await this.supabase
      .from("odin_outbox")
      .insert([insertPayload])
      .select(OUTBOX_COLUMNS)
      .maybeSingle();

    if (!error && data) {
      return {
        row: data as OdinOutboxEntry,
        inserted: true,
      };
    }

    if (!isDuplicateError(error)) {
      throw storageError(
        "Durable outbox enqueue failed.",
        error || {
          code: "insert_row_missing",
        },
      );
    }

    const existing =
      await this.getByDeliveryKey(
        params.businessId,
        deliveryKey,
      );

    if (!existing) {
      throw new P2OutboxRepositoryError(
        "Duplicate delivery key was reported but the durable outbox row could not be read.",
        "duplicate_row_not_found",
      );
    }

    return {
      row: existing,
      inserted: false,
    };
  }
}
