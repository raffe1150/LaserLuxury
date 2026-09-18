import { createHmac } from "node:crypto";

export class P2ConversationKeyError extends Error {
  readonly code =
    "P2_CONVERSATION_KEY_ERROR";

  constructor(
    readonly causeCode:
      | "missing_secret"
      | "weak_secret"
      | "invalid_business_id"
      | "missing_channel"
      | "missing_session_id",
  ) {
    super(causeCode);
    this.name =
      "P2ConversationKeyError";
  }
}

export function createP2ConversationKey(
  params: {
    secret: string;
    businessId: number;
    channel: string;
    sessionId: string;
  },
): string {
  const secret =
    String(params.secret || "");

  if (!secret.trim()) {
    throw new P2ConversationKeyError(
      "missing_secret",
    );
  }

  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new P2ConversationKeyError(
      "weak_secret",
    );
  }

  if (
    !Number.isSafeInteger(
      params.businessId,
    ) ||
    params.businessId <= 0
  ) {
    throw new P2ConversationKeyError(
      "invalid_business_id",
    );
  }

  const channel =
    String(params.channel || "")
      .trim()
      .toLowerCase();

  if (!channel) {
    throw new P2ConversationKeyError(
      "missing_channel",
    );
  }

  const sessionId =
    String(params.sessionId || "")
      .trim();

  if (!sessionId) {
    throw new P2ConversationKeyError(
      "missing_session_id",
    );
  }

  const digest =
    createHmac("sha256", secret)
      .update(
        `${params.businessId}\n${channel}\n${sessionId}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 32);

  return `${channel}:${params.businessId}:${digest}`;
}
