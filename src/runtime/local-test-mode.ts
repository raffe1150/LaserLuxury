import type { Express, Request, Response } from "express";

export const LOCAL_TEST_MODE_ENV = "ODINLINK_LOCAL_TEST_MODE";

export interface OdinLinkStartupPolicy {
  localTestMode: boolean;
  telegramPollersEnabled: boolean;
  reminderCronEnabled: boolean;
  backgroundJobsEnabled: boolean;
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
    response.status(200).json({ status: "ok" });
  });
}
