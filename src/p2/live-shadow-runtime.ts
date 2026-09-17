import type {
  UnderstandingProvider,
} from "../ai/understanding/provider";

import {
  P2ShadowRuntime,
  type P2ShadowRuntimeInput,
  type P2ShadowRuntimeLogger,
  type P2ShadowRuntimeResult,
} from "./shadow-runtime";

import {
  SupabaseShadowEvaluationRecorder,
} from "./supabase-shadow-recorder";

import {
  P2StructuredUnderstandingShadowAnalyzer,
} from "./structured-understanding-shadow-analyzer";

interface SupabaseLikeClient {
  from(table: string): any;
}

export type P2LiveShadowRuntimeStatus =
  | "disabled"
  | "missing_dependency"
  | "ready";

export interface P2LiveShadowRuntime {
  readonly status:
    P2LiveShadowRuntimeStatus;

  mirror(
    input: P2ShadowRuntimeInput,
  ): Promise<P2ShadowRuntimeResult>;
}

type P2Environment = Record<string, string | undefined>;

export interface CreateP2LiveShadowRuntimeOptions {
  supabase:
    | SupabaseLikeClient
    | null
    | undefined;

  provider:
    | UnderstandingProvider
    | null
    | undefined;

  environment?:
    P2Environment;

  logger?:
    P2ShadowRuntimeLogger;
}

function isEnabled(
  environment: P2Environment,
): boolean {
  return String(
    environment
      .P2_DURABLE_SHADOW_ENABLED ||
      "",
  )
    .trim()
    .toLowerCase() === "true";
}

function configuredBusinessIds(
  environment: P2Environment,
): Set<number> {
  const raw = String(
    environment.P2_DURABLE_SHADOW_BUSINESS_IDS || "",
  ).trim();

  if (!raw) return new Set();

  return new Set(
    raw
      .split(",")
      .map((value) => Number(value.trim()))
      .filter(
        (value) =>
          Number.isSafeInteger(value) &&
          value > 0,
      ),
  );
}

function disabledResult(): P2ShadowRuntimeResult {
  return {
    status: "disabled",
  };
}

export function createP2LiveShadowRuntime(
  options:
    CreateP2LiveShadowRuntimeOptions,
): P2LiveShadowRuntime {
  const environment =
    options.environment ?? {};

  if (!isEnabled(environment)) {
    return {
      status: "disabled",

      async mirror() {
        return disabledResult();
      },
    };
  }

  const allowedBusinessIds =
    configuredBusinessIds(environment);

  if (allowedBusinessIds.size === 0) {
    return {
      status: "disabled",
      async mirror() {
        return disabledResult();
      },
    };
  }

  if (
    !options.supabase ||
    !options.provider
  ) {
    return {
      status:
        "missing_dependency",

      async mirror() {
        return disabledResult();
      },
    };
  }

  const analyzer =
    new P2StructuredUnderstandingShadowAnalyzer({
      provider:
        options.provider,
    });

  const recorder =
    new SupabaseShadowEvaluationRecorder(
      options.supabase,
    );

  const configuredTimeoutMs =
    Number(
      environment
        .P2_DURABLE_SHADOW_TIMEOUT_MS ||
        3000,
    );

  const timeoutMs =
    Number.isFinite(
      configuredTimeoutMs,
    ) &&
    configuredTimeoutMs >= 500
      ? Math.min(
          10_000,
          Math.floor(
            configuredTimeoutMs,
          ),
        )
      : 3000;

  const runtime =
    new P2ShadowRuntime({
      enabled: true,
      analyzer,
      recorder,
      logger:
        options.logger,
      timeoutMs,
    });

  return {
    status: "ready",

    mirror(input) {
      if (
        !allowedBusinessIds.has(
          input.event.businessId,
        )
      ) {
        return Promise.resolve(
          disabledResult(),
        );
      }

      return runtime.mirror(
        input,
      );
    },
  };
}
