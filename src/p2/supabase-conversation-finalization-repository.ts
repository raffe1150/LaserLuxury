import type {
  ConversationRepository,
  FinalizeTurnResult,
} from "./repositories";

type SupabaseLikeClient = {
  rpc(functionName: string, args: Record<string, unknown>): Promise<{
    data: any;
    error: any;
  }>;
};

export class P2TurnFinalizationError extends Error {
  readonly code = "P2_TURN_FINALIZATION_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2TurnFinalizationError";
  }
}

function requiredString(
  value: unknown,
  code: string,
  message: string,
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new P2TurnFinalizationError(
      message,
      code,
    );
  }

  return normalized;
}

function validateNonNegativeInteger(
  value: unknown,
  code: string,
  message: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0
  ) {
    throw new P2TurnFinalizationError(
      message,
      code,
    );
  }

  return Number(value);
}

export class SupabaseConversationFinalizationRepository
  implements Pick<ConversationRepository, "finalizeTurn">
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async finalizeTurn(params: {
    businessId: number;
    conversationId: string;
    inboxId: string;
    workerId: string;
    expectedRevision: number;
    fenceEpoch: number;
  }): Promise<FinalizeTurnResult> {
    if (
      !Number.isInteger(params.businessId) ||
      params.businessId <= 0
    ) {
      throw new P2TurnFinalizationError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const conversationId = requiredString(
      params.conversationId,
      "conversation_id_required",
      "Conversation id is required.",
    );

    const inboxId = requiredString(
      params.inboxId,
      "inbox_id_required",
      "Inbox id is required.",
    );

    const workerId = requiredString(
      params.workerId,
      "worker_id_required",
      "Worker id is required.",
    );

    const expectedRevision = validateNonNegativeInteger(
      params.expectedRevision,
      "invalid_expected_revision",
      "Expected revision must be a non-negative safe integer.",
    );

    const fenceEpoch = validateNonNegativeInteger(
      params.fenceEpoch,
      "invalid_fence_epoch",
      "Fence epoch must be a non-negative safe integer.",
    );

    const { data, error } = await this.supabase.rpc(
      "odin_finalize_conversation_turn",
      {
        p_business_id: params.businessId,
        p_conversation_id: conversationId,
        p_inbox_id: inboxId,
        p_worker_id: workerId,
        p_expected_revision: expectedRevision,
        p_fence_epoch: fenceEpoch,
      },
    );

    if (error) {
      throw new P2TurnFinalizationError(
        "Conversation turn finalization failed.",
        String(
          error?.code ||
          error?.message ||
          "unknown_storage_error",
        ),
      );
    }

    const row = Array.isArray(data)
      ? data[0]
      : data;

    if (!row) {
      throw new P2TurnFinalizationError(
        "Turn finalization RPC returned no result.",
        "finalization_result_missing",
      );
    }

    const outcome = String(row.outcome || "");

    const allowed = new Set([
      "finalized",
      "rejected_revision",
      "rejected_worker",
      "rejected_fence",
      "rejected_expired_lease",
      "already_finalized",
    ]);

    if (!allowed.has(outcome)) {
      throw new P2TurnFinalizationError(
        "Turn finalization RPC returned an invalid outcome.",
        "invalid_finalization_outcome",
      );
    }

    const result = {
      outcome,
      conversationId: row.conversation_id,
      inboxId: row.inbox_id,
      previousRevision: Number(row.previous_revision),
      newRevision: Number(row.new_revision),
      fenceEpoch: Number(row.fence_epoch),
      inboxStatus: row.inbox_status ?? null,
    } as FinalizeTurnResult;

    if (
      result.outcome === "finalized" &&
      (
        result.newRevision !== result.previousRevision + 1 ||
        result.inboxStatus !== "processed"
      )
    ) {
      throw new P2TurnFinalizationError(
        "Finalized result violated revision or inbox contract.",
        "invalid_finalized_result",
      );
    }

    return result;
  }
}
