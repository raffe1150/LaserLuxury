export interface P2ShadowEvent {
  businessId: number;
  conversationKey: string;
  channel: string;
  providerEventId: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface P2LegacyObservation {
  languageCode?: string | null;
  taskType?: string | null;
  operationType?: string | null;
  outcome?: string | null;
}

export interface P2ShadowDecision {
  languageCode?: string | null;
  taskType?: string | null;
  operationType?: string | null;
  outcome?: string | null;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
}

export type P2ShadowComparison =
  | "match"
  | "divergent"
  | "not_comparable";

export interface P2ShadowEvaluationRecord {
  businessId: number;
  conversationKey: string;
  channel: string;
  providerEventId: string;
  executionMode: "shadow";
  legacy: P2LegacyObservation | null;
  shadow: P2ShadowDecision;
  comparison: P2ShadowComparison;
  evaluatedAt: string;
}

export interface P2ShadowAnalyzer {
  analyze(
    event: P2ShadowEvent,
  ): Promise<P2ShadowDecision>;
}

export interface P2ShadowRecorder {
  record(
    evaluation: P2ShadowEvaluationRecord,
  ): Promise<void>;
}

export interface P2ShadowEvaluatorDependencies {
  analyzer: P2ShadowAnalyzer;
  recorder: P2ShadowRecorder;
  now?: () => Date;
}

export class P2ShadowEvaluatorError extends Error {
  readonly code = "P2_SHADOW_EVALUATOR_ERROR";

  constructor(
    message: string,
    readonly causeCode:
      | "invalid_business_id"
      | "conversation_key_required"
      | "channel_required"
      | "provider_event_id_required"
      | "invalid_received_at"
      | "invalid_confidence",
  ) {
    super(message);
    this.name = "P2ShadowEvaluatorError";
  }
}

function requiredString(
  value: unknown,
  causeCode:
    | "conversation_key_required"
    | "channel_required"
    | "provider_event_id_required",
  message: string,
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new P2ShadowEvaluatorError(
      message,
      causeCode,
    );
  }

  return normalized;
}

function normalizeNullable(
  value: string | null | undefined,
): string | null {
  const normalized =
    String(value ?? "").trim();

  return normalized || null;
}

function compare(
  legacy: P2LegacyObservation | null,
  shadow: P2ShadowDecision,
): P2ShadowComparison {
  if (!legacy) {
    return "not_comparable";
  }

  const fields = [
    "languageCode",
    "taskType",
    "operationType",
    "outcome",
  ] as const;

  let comparableFields = 0;

  for (const field of fields) {
    const legacyValue =
      normalizeNullable(legacy[field]);

    const shadowValue =
      normalizeNullable(shadow[field]);

    if (
      legacyValue === null &&
      shadowValue === null
    ) {
      continue;
    }

    comparableFields += 1;

    if (legacyValue !== shadowValue) {
      return "divergent";
    }
  }

  return comparableFields > 0
    ? "match"
    : "not_comparable";
}

export class P2ShadowEvaluator {
  private readonly now: () => Date;

  constructor(
    private readonly deps: P2ShadowEvaluatorDependencies,
  ) {
    this.now =
      deps.now ?? (() => new Date());
  }

  async evaluate(
    event: P2ShadowEvent,
    legacy: P2LegacyObservation | null,
  ): Promise<P2ShadowEvaluationRecord> {
    if (
      !Number.isInteger(event.businessId) ||
      event.businessId <= 0
    ) {
      throw new P2ShadowEvaluatorError(
        "Invalid business id.",
        "invalid_business_id",
      );
    }

    const conversationKey =
      requiredString(
        event.conversationKey,
        "conversation_key_required",
        "Conversation key is required.",
      );

    const channel =
      requiredString(
        event.channel,
        "channel_required",
        "Channel is required.",
      );

    const providerEventId =
      requiredString(
        event.providerEventId,
        "provider_event_id_required",
        "Provider event id is required.",
      );

    const receivedAt =
      new Date(event.receivedAt);

    if (
      Number.isNaN(receivedAt.getTime())
    ) {
      throw new P2ShadowEvaluatorError(
        "Invalid receivedAt timestamp.",
        "invalid_received_at",
      );
    }

    const shadow =
      await this.deps.analyzer.analyze(
        event,
      );

    if (
      shadow.confidence !== undefined &&
      shadow.confidence !== null &&
      (
        !Number.isFinite(
          shadow.confidence,
        ) ||
        shadow.confidence < 0 ||
        shadow.confidence > 1
      )
    ) {
      throw new P2ShadowEvaluatorError(
        "Shadow confidence must be between 0 and 1.",
        "invalid_confidence",
      );
    }

    const evaluation:
      P2ShadowEvaluationRecord = {
        businessId:
          event.businessId,
        conversationKey,
        channel,
        providerEventId,
        executionMode: "shadow",
        legacy,
        shadow,
        comparison:
          compare(
            legacy,
            shadow,
          ),
        evaluatedAt:
          this.now().toISOString(),
      };

    await this.deps.recorder.record(
      evaluation,
    );

    return evaluation;
  }
}
