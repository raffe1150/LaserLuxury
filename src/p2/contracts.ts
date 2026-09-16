export type JsonObject = Record<string, unknown>;

export interface OdinConversation {
  id: string;
  business_id: number;
  conversation_key: string;
  schema_version: number;
  revision: number;
  runtime_generation: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fence_epoch: number;
  language_code: string | null;
  aggregate_meta: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface OdinTask {
  id: string;
  business_id: number;
  conversation_id: string;
  schema_version: number;
  task_type: string;
  status: string;
  task_revision: number;
  payload: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface OdinInboxTurn {
  id: string;
  business_id: number;
  conversation_id: string | null;
  channel: string;
  provider_scope: string;
  provider_event_id: string;
  turn_sequence: number | null;
  schema_version: number;
  payload: JsonObject;
  status: string;
  received_at: string;
}

export interface OdinResource {
  id: string;
  business_id: number;
  schema_version: number;
  resource_key: string;
  resource_type: string;
  name: string | null;
  capacity: number;
  status: string;
  provider: string | null;
  provider_resource_id: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface OdinServiceResource {
  id: string;
  business_id: number;
  schema_version: number;
  service_key: string;
  resource_id: string;
  required_units: number;
  priority: number;
  active: boolean;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface OdinOperation {
  id: string;
  business_id: number;
  conversation_id: string | null;
  task_id: string | null;
  turn_id: string | null;
  schema_version: number;
  operation_type: string;
  operation_key: string;
  status: string;
  action_digest: string | null;
  provider: string | null;
  provider_reference: string | null;
  result: JsonObject | null;
  uncertainty: JsonObject | null;
  created_at: string;
  updated_at: string;
}

export type OdinReservationStatus =
  | "proposed"
  | "held"
  | "reserved"
  | "dispatching"
  | "uncertain"
  | "verified"
  | string;

export interface OdinResourceReservation {
  id: string;
  business_id: number;
  operation_id: string | null;
  resource_id: string;
  schema_version: number;
  units: number;
  start_at: string;
  end_at: string;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  status: OdinReservationStatus;
  expires_at: string | null;
  exclusive_capacity_one: boolean;
  effective_window: string | null;
  created_at: string;
  updated_at: string;
}

export interface OdinOutboxEntry {
  id: string;
  business_id: number;
  conversation_id: string | null;
  operation_id: string | null;
  schema_version: number;
  channel: string;
  recipient_key: string;
  delivery_key: string;
  artifact: JsonObject;
  status: string;
  attempt_count: number;
  available_at: string;
  last_attempt_at: string | null;
  provider_message_id: string | null;
  last_error: JsonObject | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationLease {
  conversation_id: string;
  revision: number;
  fence_epoch: number;
  lease_owner: string;
  lease_expires_at: string;
}

export const ODIN_SCHEMA_VERSION = 1 as const;

export const CAPACITY_ONE_BLOCKING_RESERVATION_STATUSES = new Set<string>([
  "held",
  "reserved",
  "dispatching",
  "uncertain",
  "verified",
]);
