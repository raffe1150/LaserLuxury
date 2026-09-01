import type { Express, Request, Response } from "express";

export const LOCAL_TEST_MODE_ENV = "ODINLINK_LOCAL_TEST_MODE";

export interface OdinLinkStartupPolicy {
  localTestMode: boolean;
  telegramPollersEnabled: boolean;
  reminderCronEnabled: boolean;
  backgroundJobsEnabled: boolean;
}

const RUNTIME_REVISION_ENV_KEYS = [
  "ODINLINK_REVISION",
  "RENDER_GIT_COMMIT",
  "COMMIT_SHA",
  "GIT_SHA",
  "SOURCE_VERSION",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

export function getOdinLinkRuntimeRevision(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of RUNTIME_REVISION_ENV_KEYS) {
    const candidate = String(env[key] || "").trim();
    if (/^[A-Za-z0-9._/-]{1,128}$/u.test(candidate)) return candidate;
  }
  return "unknown";
}

export function isOdinLinkLocalTestMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[LOCAL_TEST_MODE_ENV]?.trim().toLowerCase() === "true";
}

export function getOdinLinkStartupPolicy(
  env: NodeJS.ProcessEnv = process.env,
): OdinLinkStartupPolicy {
  const localTestMode = isOdinLinkLocalTestMode(env);

  return {
    localTestMode,
    telegramPollersEnabled: !localTestMode,
    reminderCronEnabled: !localTestMode,
    backgroundJobsEnabled: !localTestMode,
  };
}

export function registerHealthEndpoint(app: Pick<Express, "get">): void {
  app.get("/health", (_request: Request, response: Response) => {
    response.status(200).json({
      status: "ok",
      revision: getOdinLinkRuntimeRevision(),
    });
  });
}
