import type {
  OdinConversation,
  OdinOperation,
} from "./contracts";

import type {
  ConversationRepository,
  OperationRepository,
} from "./repositories";

type SupabaseLikeClient = {
  from(table: string): {
    select(columns: string): any;
  };
};

const CONVERSATION_COLUMNS = [
  "id",
  "business_id",
  "conversation_key",
  "schema_version",
  "revision",
  "runtime_generation",
  "lease_owner",
  "lease_expires_at",
  "fence_epoch",
  "language_code",
  "aggregate_meta",
  "created_at",
  "updated_at",
].join(",");

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

function readFailure(error: any): Error {
  return new Error(
    `P2 read-only repository query failed: ${String(
      error?.code || error?.message || "unknown_error",
    )}`,
  );
}

export class SupabaseConversationRepository
  implements Pick<
    ConversationRepository,
    "getById" | "getByKey"
  >
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getById(
    businessId: number,
    conversationId: string,
  ): Promise<OdinConversation | null> {
    const { data, error } = await this.supabase
      .from("odin_conversations")
      .select(CONVERSATION_COLUMNS)
      .eq("business_id", businessId)
      .eq("id", conversationId)
      .maybeSingle();

    if (error) throw readFailure(error);

    return (data as OdinConversation | null) || null;
  }

  async getByKey(
    businessId: number,
    conversationKey: string,
  ): Promise<OdinConversation | null> {
    const { data, error } = await this.supabase
      .from("odin_conversations")
      .select(CONVERSATION_COLUMNS)
      .eq("business_id", businessId)
      .eq("conversation_key", conversationKey)
      .maybeSingle();

    if (error) throw readFailure(error);

    return (data as OdinConversation | null) || null;
  }
}

export class SupabaseOperationRepository
  implements Pick<
    OperationRepository,
    "getByOperationKey"
  >
{
  constructor(
    private readonly supabase: SupabaseLikeClient,
  ) {}

  async getByOperationKey(
    businessId: number,
    operationKey: string,
  ): Promise<OdinOperation | null> {
    const { data, error } = await this.supabase
      .from("odin_operations")
      .select(OPERATION_COLUMNS)
      .eq("business_id", businessId)
      .eq("operation_key", operationKey)
      .maybeSingle();

    if (error) throw readFailure(error);

    return (data as OdinOperation | null) || null;
  }
}
