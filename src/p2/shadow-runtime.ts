import type {
  P2LegacyObservation,
  P2ShadowAnalyzer,
  P2ShadowEvent,
  P2ShadowEvaluationRecord,
  P2ShadowRecorder,
} from "./shadow-evaluator";

import {
  P2ShadowEvaluator,
} from "./shadow-evaluator";

export interface P2ShadowRuntimeLogger {
  info?: (
    event: string,
    details?: Record<string, unknown>,
  ) => void;

  error?: (
    event: string,
    details?: Record<string, unknown>,
  ) => void;
}

export interface P2ShadowRuntimeInput {
  event: P2ShadowEvent;
  legacy?: P2LegacyObservation | null;
}

export type P2ShadowRuntimeResult =
  | {
      status: "recorded";
      evaluation: P2ShadowEvaluationRecord;
    }
  | {
      status: "disabled";
    }
  | {
      status: "failed";
      errorCategory: string;
    };

export interface P2ShadowRuntimeOptions {
  enabled: boolean;
  analyzer: P2ShadowAnalyzer;
  recorder: P2ShadowRecorder;
  logger?: P2ShadowRuntimeLogger;
  timeoutMs?: number;
}

function classifyShadowFailure(
  error: unknown,
): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return String(
      (error as { code: string }).code,
    );
  }

  if (
    error instanceof Error &&
    error.name
  ) {
    return error.name;
  }

  return "unknown_shadow_failure";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(
            Object.assign(
              new Error(
                "P2 shadow evaluation timed out.",
              ),
              {
                code:
                  "P2_SHADOW_TIMEOUT",
              },
            ),
          ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class P2ShadowRuntime {
  private readonly evaluator:
    P2ShadowEvaluator;

  private readonly timeoutMs: number;

  constructor(
    private readonly options:
      P2ShadowRuntimeOptions,
  ) {
    this.evaluator =
      new P2ShadowEvaluator({
        analyzer: options.analyzer,
        recorder: options.recorder,
      });

    this.timeoutMs =
      options.timeoutMs ?? 2500;
  }

  async mirror(
    input: P2ShadowRuntimeInput,
  ): Promise<P2ShadowRuntimeResult> {
    if (!this.options.enabled) {
      return {
        status: "disabled",
      };
    }

    try {
      const evaluation =
        await withTimeout(
          this.evaluator.evaluate(
            input.event,
            input.legacy ?? null,
          ),
          this.timeoutMs,
        );

      this.options.logger?.info?.(
        "P2ShadowRecorded",
        {
          businessId:
            input.event.businessId,
          channel:
            input.event.channel,
          providerEventIdPresent:
            Boolean(
              input.event
                .providerEventId,
            ),
          comparison:
            evaluation.comparison,
        },
      );

      return {
        status: "recorded",
        evaluation,
      };
    } catch (error) {
      const errorCategory =
        classifyShadowFailure(error);

      this.options.logger?.error?.(
        "P2ShadowFailed",
        {
          businessId:
            input.event.businessId,
          channel:
            input.event.channel,
          providerEventIdPresent:
            Boolean(
              input.event
                .providerEventId,
            ),
          errorCategory,
        },
      );

      // IMPORTANT:
      // Shadow failure must never break
      // the live legacy request.
      return {
        status: "failed",
        errorCategory,
      };
    }
  }
}
