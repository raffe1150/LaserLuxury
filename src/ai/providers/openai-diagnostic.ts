// Temporary production diagnostic: never serialize an SDK error or request.
const errorTypes = new Set([
  "invalid_request_error", "authentication_error", "permission_error",
  "not_found_error", "rate_limit_error", "insufficient_quota",
  "billing_error", "server_error", "api_error",
]);
const errorCodes = new Set([
  "model_not_found", "model_not_available", "model_access_denied",
  "permission_denied", "invalid_api_key", "incorrect_api_key",
  "insufficient_quota", "billing_hard_limit_reached", "billing_not_active",
  "rate_limit_exceeded", "unsupported_parameter", "unsupported_value",
  "invalid_parameter", "invalid_value", "invalid_type", "missing_required_parameter",
  "invalid_tool_schema", "invalid_function_parameters", "invalid_json_schema",
  "invalid_request", "invalid_input", "context_length_exceeded", "server_error",
]);

function allowed(value: unknown, values: Set<string>): string | null {
  return typeof value === "string" && values.has(value) ? value : null;
}

function identifier(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string" || !pattern.test(value)) return null;
  // Defense in depth for operational identifiers accidentally containing a configured secret.
  for (const [name, secret] of Object.entries(process.env)) {
    if (/key|token|secret|password|authorization/i.test(name) && secret && value.includes(secret)) return null;
  }
  return value;
}

function safeParameter(value: unknown): string | null {
  // Arbitrary tool property names can be customer data. Only protocol field paths are allowed.
  if (typeof value !== "string" || value.length > 120) return null;
  const fields = new Set([
    "model", "temperature", "input", "messages", "instructions", "tools", "tool_choice",
    "type", "role", "content", "name", "description", "parameters", "properties",
    "required", "additionalProperties", "strict", "items", "text", "format", "schema",
    "call_id", "arguments", "output", "max_output_tokens", "reasoning", "effort",
  ]);
  if (!/^[A-Za-z_]+(?:\[\d{1,3}\])?(?:\.[A-Za-z_]+(?:\[\d{1,3}\])?)*$/.test(value)) return null;
  return value.split(".").every((part) => fields.has(part.replace(/\[\d+\]$/, ""))) ? value : null;
}

function safeSummary(error: any, status: number | null, code: string | null): string {
  // Match known failure descriptions but emit only literal summaries, never provider text.
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (code === "model_not_found" || status === 404) return "Model or resource not found";
  if (status === 401) return "Authentication failed";
  if (status === 403) return "Model or resource access denied";
  if (status === 402 || code?.startsWith("billing_") || code === "insufficient_quota") return "Billing or quota failure";
  if (status === 429) return "Rate limit exceeded";
  if (code === "unsupported_parameter" || message.includes("unsupported parameter")) return "Unsupported parameter";
  if (code?.includes("schema") || code === "invalid_function_parameters" || /invalid.*schema/.test(message)) return "Invalid tool or output schema";
  if (code === "invalid_input" || /invalid.*(?:input|message)/.test(message)) return "Invalid input or message format";
  if (status === 400 || status === 422) return "Invalid or malformed request";
  return "OpenAI generation failed";
}

export function buildOpenAiFailureDiagnostic(error: unknown, context: {
  model: string;
  toolCount: number;
  correlationId?: string;
}) {
  const failure = error as any;
  const status = typeof failure?.status === "number" && Number.isInteger(failure.status)
    && failure.status >= 400 && failure.status <= 599 ? failure.status : null;
  const code = allowed(failure?.code ?? failure?.error?.code, errorCodes);
  return {
    provider: "openai",
    operation: "responses.create",
    stage: "generation",
    httpStatus: status,
    errorType: allowed(failure?.type ?? failure?.error?.type, errorTypes),
    errorCode: code,
    parameter: safeParameter(failure?.param ?? failure?.error?.param),
    requestId: identifier(failure?.requestID ?? failure?.request_id, /^req_[A-Za-z0-9_-]{1,96}$/),
    message: safeSummary(failure, status, code),
    model: identifier(context.model, /^(?:gpt-\d+(?:\.\d+)?o?|o\d+)(?:-(?:luna|sol|astra|terra|mini|nano|pro|chat|latest|preview|turbo|instruct|\d{4}-\d{2}-\d{2}))*$/) || "[unrecognized model]",
    toolsPresent: context.toolCount > 0,
    toolCount: context.toolCount,
    correlationId: identifier(context.correlationId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  };
}
