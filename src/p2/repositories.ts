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
}

export interface TaskRepository {
  getById(
    businessId: number,
    taskId: string,
  ): Promise<OdinTask | null>;
}

export interface InboxRepository {
  getByProviderEvent(params: {
    businessId: number;
    channel: string;
    providerScope: string;
    providerEventId: string;
  }): Promise<OdinInboxTurn | null>;
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

export interface OperationRepository {
  getByOperationKey(
    businessId: number,
    operationKey: string,
  ): Promise<OdinOperation | null>;
}

export interface ReservationRepository {
  getById(
    businessId: number,
    reservationId: string,
  ): Promise<OdinResourceReservation | null>;
}

export interface OutboxRepository {
  getByDeliveryKey(
    businessId: number,
    deliveryKey: string,
  ): Promise<OdinOutboxEntry | null>;
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
