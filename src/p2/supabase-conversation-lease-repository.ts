import type {
  ConversationLease,
} from "./contracts";

import type {
  ConversationRepository,
} from "./repositories";

type SupabaseLikeClient = {
  rpc(
    functionName: string,
    params: Record<string, unknown>,
  ): any;
};

export class P2LeaseRepositoryError extends Error {
  readonly code = "P2_LEASE_REPOSITORY_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2LeaseRepositoryError";
  }
}

function assertLeaseInput(params: {
  businessId: number;
  conversationId: string;
  workerId: string;
  leaseSeconds: number;
}) {
  if (
    !Number.isInteger(params.businessId) ||
    params.businessId <= 0
  ) {
    throw new P2LeaseRepositoryError(
      "Invalid business id.",
      "invalid_business_id",
    );
  }

  if (!String(params.conversationId || "").trim()) {
    throw new P2LeaseRepositoryError(
      "Conversation id is required.",
      "conversation_id_required",
    );
  }

  if (!String(params.workerId || "").trim()) {
    throw new P2LeaseRepositoryError(
      "Worker id is required.",
      "worker_id_required",
    );
  }

  if (
    !Number.isInteger(params.leaseSeconds) ||
    params.leaseSeconds < 1 ||
    params.leaseSeconds > 300
  ) {
    throw new P2LeaseRepositoryError(
      "Lease duration must be between 1 and 300 seconds.",
      "invalid_lease_seconds",
    );
  }
}

function normalizeLeaseResult(
  data: ConversationLease | null,
  error: any,
): ConversationLease | null {
  if (error) {
    throw new P2LeaseRepositoryError(
      "Conversation lease RPC failed.",
      String(
        error?.code ||
        error?.message ||
        "unknown_rpc_error",
      ),
    );
  }

  return data || null;
}

export class SupabaseConversationLeaseRepository
  implements Pick<
    ConversationRepository,
    "claimLease" | "renewLease"
  >
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async claimLease(params: {
    businessId: number;
    conversationId: string;
    workerId: string;
    expectedRevision: number;
    leaseSeconds: number;
  }): Promise<ConversationLease | null> {
    assertLeaseInput(params);

    if (
      !Number.isInteger(params.expectedRevision) ||
      params.expectedRevision < 0
    ) {
      throw new P2LeaseRepositoryError(
        "Expected revision must be a non-negative integer.",
        "invalid_expected_revision",
      );
    }

    const { data, error } = await this.supabase
      .rpc(
        "odin_claim_conversation_lease",
        {
          p_business_id: params.businessId,
          p_conversation_id: params.conversationId,
          p_worker_id: params.workerId,
          p_expected_revision:
            params.expectedRevision,
          p_lease_seconds: params.leaseSeconds,
        },
      )
      .maybeSingle();

    return normalizeLeaseResult(
      data as ConversationLease | null,
      error,
    );
  }

  async renewLease(params: {
    businessId: number;
    conversationId: string;
    workerId: string;
    fenceEpoch: number;
    leaseSeconds: number;
  }): Promise<ConversationLease | null> {
    assertLeaseInput(params);

    if (
      !Number.isInteger(params.fenceEpoch) ||
      params.fenceEpoch < 0
    ) {
      throw new P2LeaseRepositoryError(
        "Fence epoch must be a non-negative integer.",
        "invalid_fence_epoch",
      );
    }

    const { data, error } = await this.supabase
      .rpc(
        "odin_renew_conversation_lease",
        {
          p_business_id: params.businessId,
          p_conversation_id: params.conversationId,
          p_worker_id: params.workerId,
          p_fence_epoch: params.fenceEpoch,
          p_lease_seconds: params.leaseSeconds,
        },
      )
      .maybeSingle();

    return normalizeLeaseResult(
      data as ConversationLease | null,
      error,
    );
  }
}
