import type {
  P2ShadowEvaluationRecord,
  P2ShadowRecorder,
} from "./shadow-evaluator";

export interface OdinShadowEvaluationRow {
  id: string;
  business_id: number;
  schema_version: number;
  conversation_key: string;
  channel: string;
  provider_scope: string;
  provider_event_id: string;
  execution_mode: "shadow";
  legacy_observation:
    | Record<string, unknown>
    | null;
  shadow_decision:
    Record<string, unknown>;
  comparison:
    | "match"
    | "divergent"
    | "not_comparable";
  evaluated_at: string;
  created_at: string;
  updated_at: string;
}

export type ShadowRecordOnceResult = {
  row: OdinShadowEvaluationRow;
  inserted: boolean;
};

interface SupabaseLikeResult<T> {
  data: T | null;
  error: {
    code?: string;
    message?: string;
  } | null;
}

interface SupabaseLikeClient {
  from(table: string): any;
}

export class P2ShadowRecorderError extends Error {
  readonly code =
    "P2_SHADOW_RECORDER_ERROR";

  constructor(
    message: string,
    readonly causeCode:
      | "storage_failure"
      | "duplicate_row_unreadable"
      | "invalid_record",
  ) {
    super(message);
    this.name =
      "P2ShadowRecorderError";
  }
}

function storageError(
  message: string,
): P2ShadowRecorderError {
  return new P2ShadowRecorderError(
    message,
    "storage_failure",
  );
}

export class SupabaseShadowEvaluationRecorder
  implements P2ShadowRecorder
{
  constructor(
    private readonly supabase:
      SupabaseLikeClient,
  ) {}

  async record(
    evaluation:
      P2ShadowEvaluationRecord,
  ): Promise<void> {
    await this.recordOnce(
      evaluation,
    );
  }

  async recordOnce(
    evaluation:
      P2ShadowEvaluationRecord,
  ): Promise<ShadowRecordOnceResult> {
    if (
      !Number.isInteger(
        evaluation.businessId,
      ) ||
      evaluation.businessId <= 0 ||
      !evaluation.channel.trim() ||
      !evaluation.providerEventId.trim() ||
      !evaluation.conversationKey.trim()
    ) {
      throw new P2ShadowRecorderError(
        "Invalid shadow evaluation record.",
        "invalid_record",
      );
    }

    const row = {
      business_id:
        evaluation.businessId,
      schema_version: 1,
      conversation_key:
        evaluation.conversationKey,
      channel:
        evaluation.channel,
      provider_scope:
        evaluation.providerScope ?? "",
      provider_event_id:
        evaluation.providerEventId,
      execution_mode: "shadow",
      legacy_observation:
        evaluation.legacy,
      shadow_decision:
        evaluation.shadow,
      comparison:
        evaluation.comparison,
      evaluated_at:
        evaluation.evaluatedAt,
    };

    const inserted =
      await this.supabase
        .from(
          "odin_shadow_evaluations",
        )
        .insert([row])
        .select("*")
        .maybeSingle() as SupabaseLikeResult<
          OdinShadowEvaluationRow
        >;

    if (!inserted.error) {
      if (!inserted.data) {
        throw storageError(
          "Shadow evaluation insert returned no row.",
        );
      }

      return {
        row: inserted.data,
        inserted: true,
      };
    }

    if (
      inserted.error.code !== "23505"
    ) {
      throw storageError(
        "Shadow evaluation insert failed.",
      );
    }

    const existing =
      await this.supabase
        .from(
          "odin_shadow_evaluations",
        )
        .select("*")
        .eq(
          "business_id",
          evaluation.businessId,
        )
        .eq(
          "channel",
          evaluation.channel,
        )
        .eq(
          "provider_scope",
          evaluation.providerScope ?? "",
        )
        .eq(
          "provider_event_id",
          evaluation.providerEventId,
        )
        .maybeSingle() as SupabaseLikeResult<
          OdinShadowEvaluationRow
        >;

    if (
      existing.error ||
      !existing.data
    ) {
      throw new P2ShadowRecorderError(
        "Duplicate shadow evaluation could not be read.",
        "duplicate_row_unreadable",
      );
    }

    return {
      row: existing.data,
      inserted: false,
    };
  }
}
