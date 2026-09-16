import type {
  OdinInboxTurn,
} from "./contracts";

import type {
  InboxAcceptOnceResult,
  InboxRepository,
} from "./repositories";

type SupabaseLikeClient = {
  from(table: string): any;
};

const INBOX_COLUMNS = [
  "id",
  "business_id",
  "conversation_id",
  "channel",
  "provider_scope",
  "provider_event_id",
  "turn_sequence",
  "schema_version",
  "payload",
  "status",
  "received_at",
].join(",");

export class P2InboxRepositoryError extends Error {
  readonly code = "P2_INBOX_REPOSITORY_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2InboxRepositoryError";
  }
}

function normalizeScope(value: unknown): string {
  return String(value ?? "").trim();
}

function validateLookup(params: {
  businessId: number;
  channel: string;
  providerScope: string;
  providerEventId: string;
}) {
  if (
    !Number.isInteger(params.businessId) ||
    params.businessId <= 0
  ) {
    throw new P2InboxRepositoryError(
      "Invalid business id.",
      "invalid_business_id",
    );
  }

  if (!String(params.channel || "").trim()) {
    throw new P2InboxRepositoryError(
      "Channel is required.",
      "channel_required",
    );
  }

  if (!String(params.providerEventId || "").trim()) {
    throw new P2InboxRepositoryError(
      "Provider event id is required.",
      "provider_event_id_required",
    );
  }
}

function storageError(
  message: string,
  error: any,
): P2InboxRepositoryError {
  return new P2InboxRepositoryError(
    message,
    String(
      error?.code ||
      error?.message ||
      "unknown_storage_error",
    ),
  );
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

export class SupabaseInboxRepository
  implements InboxRepository
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getByProviderEvent(params: {
    businessId: number;
    channel: string;
    providerScope: string;
    providerEventId: string;
  }): Promise<OdinInboxTurn | null> {
    const normalized = {
      ...params,
      channel: String(params.channel || "").trim(),
      providerScope: normalizeScope(params.providerScope),
      providerEventId:
        String(params.providerEventId || "").trim(),
    };

    validateLookup(normalized);

    const { data, error } = await this.supabase
      .from("odin_inbox")
      .select(INBOX_COLUMNS)
      .eq("business_id", normalized.businessId)
      .eq("channel", normalized.channel)
      .eq("provider_scope", normalized.providerScope)
      .eq(
        "provider_event_id",
        normalized.providerEventId,
      )
      .maybeSingle();

    if (error) {
      throw storageError(
        "Inbox lookup failed.",
        error,
      );
    }

    return (data as OdinInboxTurn | null) || null;
  }

  async acceptOnce(params: {
    businessId: number;
    conversationId?: string | null;
    channel: string;
    providerScope?: string;
    providerEventId: string;
    turnSequence?: number | null;
    payload: Record<string, unknown>;
  }): Promise<InboxAcceptOnceResult> {
    const channel =
      String(params.channel || "").trim();

    const providerScope =
      normalizeScope(params.providerScope);

    const providerEventId =
      String(params.providerEventId || "").trim();

    validateLookup({
      businessId: params.businessId,
      channel,
      providerScope,
      providerEventId,
    });

    if (
      params.turnSequence !== undefined &&
      params.turnSequence !== null &&
      (
        !Number.isSafeInteger(params.turnSequence) ||
        params.turnSequence < 0
      )
    ) {
      throw new P2InboxRepositoryError(
        "Turn sequence must be a non-negative safe integer.",
        "invalid_turn_sequence",
      );
    }

    const insertPayload = {
      business_id: params.businessId,
      conversation_id:
        params.conversationId || null,
      channel,
      provider_scope: providerScope,
      provider_event_id: providerEventId,
      turn_sequence:
        params.turnSequence ?? null,
      schema_version: 1,
      payload: params.payload || {},
      status: "accepted",
    };

    const { data, error } = await this.supabase
      .from("odin_inbox")
      .insert([insertPayload])
      .select(INBOX_COLUMNS)
      .maybeSingle();

    if (!error && data) {
      return {
        row: data as OdinInboxTurn,
        inserted: true,
      };
    }

    if (!isDuplicateError(error)) {
      throw storageError(
        "Durable inbox insert failed.",
        error || {
          code: "insert_row_missing",
        },
      );
    }

    const existing =
      await this.getByProviderEvent({
        businessId: params.businessId,
        channel,
        providerScope,
        providerEventId,
      });

    if (!existing) {
      throw new P2InboxRepositoryError(
        "Duplicate inbox key was reported but the durable row could not be read.",
        "duplicate_row_not_found",
      );
    }

    return {
      row: existing,
      inserted: false,
    };
  }
}
