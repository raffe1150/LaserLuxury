import type {
  ConversationLease,
  OdinConversation,
  OdinInboxTurn,
  OdinOperation,
  OdinOutboxEntry,
  OdinResource,
  OdinResourceReservation,
  OdinServiceResource,
  OdinTask,
} from "./contracts";

export type FinalizeTurnResult =
  | {
      outcome: "finalized";
      conversationId: string;
      inboxId: string;
      previousRevision: number;
      newRevision: number;
      fenceEpoch: number;
      inboxStatus: "processed";
    }
  | {
      outcome:
        | "rejected_revision"
        | "rejected_worker"
        | "rejected_fence"
        | "rejected_expired_lease"
        | "already_finalized";
      conversationId: string;
      inboxId: string;
      previousRevision: number;
      newRevision: number;
      fenceEpoch: number;
      inboxStatus: string | null;
    };

export interface ConversationRepository {
  getById(
    businessId: number,
    conversationId: string,
  ): Promise<OdinConversation | null>;

  getByKey(
    businessId: number,
    conversationKey: string,
  ): Promise<OdinConversation | null>;

  claimLease(params: {
    businessId: number;
    conversationId: string;
    workerId: string;
    expectedRevision: number;
    leaseSeconds: number;
  }): Promise<ConversationLease | null>;

  renewLease(params: {
    businessId: number;
    conversationId: string;
    workerId: string;
    fenceEpoch: number;
    leaseSeconds: number;
  }): Promise<ConversationLease | null>;

  finalizeTurn(params: {
    businessId: number;
    conversationId: string;
    inboxId: string;
    workerId: string;
    expectedRevision: number;
    fenceEpoch: number;
  }): Promise<FinalizeTurnResult>;
}

export interface TaskRepository {
  getById(
    businessId: number,
    taskId: string,
  ): Promise<OdinTask | null>;
}

export type InboxAcceptOnceResult = {
  row: OdinInboxTurn;
  inserted: boolean;
};

export interface InboxRepository {
  getByProviderEvent(params: {
    businessId: number;
    channel: string;
    providerScope: string;
    providerEventId: string;
  }): Promise<OdinInboxTurn | null>;

  acceptOnce(params: {
    businessId: number;
    conversationId?: string | null;
    channel: string;
    providerScope?: string;
    providerEventId: string;
    turnSequence?: number | null;
    payload: Record<string, unknown>;
  }): Promise<InboxAcceptOnceResult>;
}

export interface ResourceRepository {
  getById(
    businessId: number,
    resourceId: string,
  ): Promise<OdinResource | null>;

  getByKey(
    businessId: number,
    resourceKey: string,
  ): Promise<OdinResource | null>;

  listServiceResources(
    businessId: number,
    serviceKey: string,
  ): Promise<OdinServiceResource[]>;
}

export type OperationGetOrCreateResult = {
  row: OdinOperation;
  inserted: boolean;
};

export interface OperationRepository {
  getByOperationKey(
    businessId: number,
    operationKey: string,
  ): Promise<OdinOperation | null>;

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

export type CapacityOneReservationResult =
  | {
      outcome: "created";
      row: OdinResourceReservation;
    }
  | {
      outcome: "conflict";
      row: null;
    };

export interface ReservationRepository {
  getById(
    businessId: number,
    reservationId: string,
  ): Promise<OdinResourceReservation | null>;

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

export type OutboxEnqueueOnceResult = {
  row: OdinOutboxEntry;
  inserted: boolean;
};

export interface OutboxRepository {
  getByDeliveryKey(
    businessId: number,
    deliveryKey: string,
  ): Promise<OdinOutboxEntry | null>;

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

export interface P2Repositories {
  conversations: ConversationRepository;
  tasks: TaskRepository;
  inbox: InboxRepository;
  resources: ResourceRepository;
  operations: OperationRepository;
  reservations: ReservationRepository;
  outbox: OutboxRepository;
}
