const DEFAULT_CONVERSATION_CONTEXT_MESSAGE_LIMIT = 20;

export function buildRecentConversationHistory(
  messages: any[],
  limit: number = DEFAULT_CONVERSATION_CONTEXT_MESSAGE_LIMIT,
): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const normalizedLimit = Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_CONVERSATION_CONTEXT_MESSAGE_LIMIT;
  return messages.slice(-normalizedLimit);
}
