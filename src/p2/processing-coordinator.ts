import type {
  ConversationLease,
  OdinConversation,
  OdinInboxTurn,
  OdinOperation,
  OdinOutboxEntry,
  OdinResourceReservation,
} from "./contracts";

import type {
  CapacityOneReservationResult,
  FinalizeTurnResult,
  OperationGetOrCreateResult,
  OutboxEnqueueOnceResult,
} from "./repositories";

export interface ProcessingConversationReader {
  getById(
    businessId: number,
    conversationId: string,
  ): Promise<OdinConversation | null>;
}

export interface ProcessingLeaseRepository {
  claimLease(params: {
    businessId: number;
    conversationId: string;
    workerId: string;
    expectedRevision: number;
    leaseSeconds: number;
  }): Promise<ConversationLease | null>;
}

export interface ProcessingFinalizationRepository {
  finalizeTurn(params: {
    businessId: number;
    conversationId: string;
    inboxId: string;
    workerId: string;
    expectedRevision: number;
    fenceEpoch: number;
  }): Promise<FinalizeTurnResult>;
}

export interface ProcessingOperationRepository {
  getOrCreate(params: {
    businessId: number;
    conversationId?: string | null;
    taskId?: string | null;
    turnId?: string | null;
    operationType: string;
    operationKey: string;
    status: string;
    actionDigest?: string | null;
    provider?: string | null;
  }): Promise<OperationGetOrCreateResult>;
}

export interface ProcessingReservationRepository {
  createCapacityOne(params: {
    businessId: number;
    operationId: string;
    resourceId: string;
    startAt: string;
    endAt: string;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    status?: "held" | "reserved" | "dispatching" | "uncertain" | "verified";
    expiresAt?: string | null;
  }): Promise<CapacityOneReservationResult>;
}

export interface ProcessingOutboxRepository {
  enqueueOnce(params: {
    businessId: number;
    conversationId?: string | null;
    operationId?: string | null;
    channel: string;
    recipientKey: string;
    deliveryKey: string;
    artifact: Record<string, unknown>;
    availableAt?: string | null;
  }): Promise<OutboxEnqueueOnceResult>;
}

export interface P2ProcessingDependencies {
  conversations: ProcessingConversationReader;
  leases: ProcessingLeaseRepository;
  finalization: ProcessingFinalizationRepository;
  operations: ProcessingOperationRepository;
  reservations: ProcessingReservationRepository;
  outbox: ProcessingOutboxRepository;
}

export interface CapacityOneProcessingPlan {
  businessId: number;
  inbox: OdinInboxTurn;
  workerId: string;
  leaseSeconds?: number;

  operation: {
    type: string;
    key: string;
    status?: string;
    actionDigest?: string | null;
    provider?: string | null;
  };

  reservation: {
    resourceId: string;
    startAt: string;
    endAt: string;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    status?: "held" | "reserved" | "dispatching" | "uncertain" | "verified";
    expiresAt?: string | null;
  };

  outbox: {
    channel: string;
    recipientKey: string;
    deliveryKey: string;
    artifact: Record<string, unknown>;
    availableAt?: string | null;
  };
}

export type P2ProcessingResult =
  | {
      outcome: "completed";
      lease: ConversationLease;
      operation: OdinOperation;
      operationInserted: boolean;
      reservation: OdinResourceReservation;
      reservationOutcome: "created" | "existing";
      outbox: OdinOutboxEntry;
      outboxInserted: boolean;
      finalization: Extract<
        FinalizeTurnResult,
        { outcome: "finalized" }
      >;
    }
  | {
      outcome: "reservation_conflict";
      lease: ConversationLease;
      operation: OdinOperation;
      operationInserted: boolean;
    }
  | {
      outcome: "lease_unavailable";
      conversation: OdinConversation;
    }
  | {
      outcome: "inbox_not_processable";
      reason:
        | "missing_conversation"
        | "not_accepted"
        | "tenant_mismatch";
    }
  | {
      outcome: "finalization_rejected";
      lease: ConversationLease;
      operation: OdinOperation;
      reservation: OdinResourceReservation;
      outbox: OdinOutboxEntry;
      finalization: Exclude<
        FinalizeTurnResult,
        { outcome: "finalized" }
      >;
    };

export class P2ProcessingCoordinatorError extends Error {
  readonly code = "P2_PROCESSING_COORDINATOR_ERROR";

  constructor(
    message: string,
    readonly causeCode: string,
  ) {
    super(message);
    this.name = "P2ProcessingCoordinatorError";
  }
}

function requiredString(
  value: unknown,
  code: string,
  message: string,
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new P2ProcessingCoordinatorError(
      message,
      code,
    );
  }

  return normalized;
}

export class P2ProcessingCoordinator {
  constructor(
    private readonly deps: P2ProcessingDependencies,
  ) {}

  async processCapacityOnePlan(
    plan: CapacityOneProcessingPlan,
  ): Promise<P2ProcessingResult> {
    if (
      !Number.isInteger(plan.businessId) ||
      plan.businessId <= 0
    ) {
      throw new P2ProcessingCoordinatorError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const workerId = requiredString(
      plan.workerId,
      "worker_id_required",
      "Worker id is required.",
    );

    const conversationId =
      plan.inbox.conversation_id;

    if (!conversationId) {
      return {
        outcome: "inbox_not_processable",
        reason: "missing_conversation",
      };
    }

    if (plan.inbox.business_id !== plan.businessId) {
      return {
        outcome: "inbox_not_processable",
        reason: "tenant_mismatch",
      };
    }

    if (plan.inbox.status !== "accepted") {
      return {
        outcome: "inbox_not_processable",
        reason: "not_accepted",
      };
    }

    const conversation =
      await this.deps.conversations.getById(
        plan.businessId,
        conversationId,
      );

    if (!conversation) {
      throw new P2ProcessingCoordinatorError(
        "Conversation referenced by inbox was not found.",
        "conversation_not_found",
      );
    }

    const leaseSeconds =
      plan.leaseSeconds ?? 30;

    const lease =
      await this.deps.leases.claimLease({
        businessId: plan.businessId,
        conversationId,
        workerId,
        expectedRevision: conversation.revision,
        leaseSeconds,
      });

    if (!lease) {
      return {
        outcome: "lease_unavailable",
        conversation,
      };
    }

    const operationResult =
      await this.deps.operations.getOrCreate({
        businessId: plan.businessId,
        conversationId,
        turnId: plan.inbox.id,
        operationType: requiredString(
          plan.operation.type,
          "operation_type_required",
          "Operation type is required.",
        ),
        operationKey: requiredString(
          plan.operation.key,
          "operation_key_required",
          "Operation key is required.",
        ),
        status: plan.operation.status ?? "proposed",
        actionDigest:
          plan.operation.actionDigest ?? null,
        provider:
          plan.operation.provider ?? null,
      });

    const reservationResult =
      await this.deps.reservations.createCapacityOne({
        businessId: plan.businessId,
        operationId: operationResult.row.id,
        resourceId: requiredString(
          plan.reservation.resourceId,
          "resource_id_required",
          "Resource id is required.",
        ),
        startAt: plan.reservation.startAt,
        endAt: plan.reservation.endAt,
        bufferBeforeMinutes:
          plan.reservation.bufferBeforeMinutes,
        bufferAfterMinutes:
          plan.reservation.bufferAfterMinutes,
        status:
          plan.reservation.status ?? "held",
        expiresAt:
          plan.reservation.expiresAt ?? null,
      });

    if (reservationResult.outcome === "conflict") {
      return {
        outcome: "reservation_conflict",
        lease,
        operation: operationResult.row,
        operationInserted:
          operationResult.inserted,
      };
    }

    const outboxResult =
      await this.deps.outbox.enqueueOnce({
        businessId: plan.businessId,
        conversationId,
        operationId:
          operationResult.row.id,
        channel: requiredString(
          plan.outbox.channel,
          "outbox_channel_required",
          "Outbox channel is required.",
        ),
        recipientKey: requiredString(
          plan.outbox.recipientKey,
          "recipient_key_required",
          "Recipient key is required.",
        ),
        deliveryKey: requiredString(
          plan.outbox.deliveryKey,
          "delivery_key_required",
          "Delivery key is required.",
        ),
        artifact: plan.outbox.artifact,
        availableAt:
          plan.outbox.availableAt ?? null,
      });

    const finalization =
      await this.deps.finalization.finalizeTurn({
        businessId: plan.businessId,
        conversationId,
        inboxId: plan.inbox.id,
        workerId,
        expectedRevision:
          lease.revision,
        fenceEpoch:
          lease.fence_epoch,
      });

    if (finalization.outcome !== "finalized") {
      return {
        outcome: "finalization_rejected",
        lease,
        operation:
          operationResult.row,
        reservation:
          reservationResult.row,
        outbox:
          outboxResult.row,
        finalization,
      };
    }

    return {
      outcome: "completed",
      lease,
      operation:
        operationResult.row,
      operationInserted:
        operationResult.inserted,
      reservation:
        reservationResult.row,
      reservationOutcome:
        reservationResult.outcome,
      outbox:
        outboxResult.row,
      outboxInserted:
        outboxResult.inserted,
      finalization,
    };
  }
}
