import assert from "node:assert/strict";
import test from "node:test";
import { APIError } from "openai";
import { Responses } from "openai/resources/responses";
import { classifyAiFailure, isRetryableAiFailure, runAiProviderRequest } from "../reliability";
import { generateWithOpenAi, toOpenAiInput, toOpenAiTools } from "./openai";
import { buildOpenAiFailureDiagnostic } from "./openai-diagnostic";

const correlationId = "70c662be-f130-445e-8de0-69292c61ab22";
const context = { model: "gpt-6-luna", toolCount: 1, correlationId };
function apiError(status: number, code: string | null, param: string | null = null, message = "Failure") {
  return APIError.generate(status, {
    error: { type: "invalid_request_error", code, param, message },
  }, undefined, new Headers({ "x-request-id": "req_diagnostic123" }));
}

for (const [status, code, category, summary] of [
  [400, "unsupported_parameter", "INVALID_REQUEST", "Unsupported parameter"],
  [401, "invalid_api_key", "AUTHENTICATION", "Authentication failed"],
  [403, "model_access_denied", "AUTHENTICATION", "Model or resource access denied"],
  [404, "model_not_found", "NOT_FOUND", "Model or resource not found"],
  [429, "rate_limit_exceeded", "RATE_LIMIT", "Rate limit exceeded"],
  [429, "insufficient_quota", "RATE_LIMIT", "Billing or quota failure"],
  [402, "billing_not_active", "BILLING", "Billing or quota failure"],
  [422, "invalid_input", "INVALID_REQUEST", "Invalid input or message format"],
] as const) {
  test(`OpenAI ${status}/${code} logs safe metadata and classifies as ${category}`, async (t) => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-secret-diagnostic";
    t.after(() => {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    });
    const error = apiError(status, code, "temperature", "Customer body quota timeout api key");
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(Responses.prototype, "create", async () => { throw error; });
    await assert.rejects(generateWithOpenAi({
      model: context.model,
      messages: [{ role: "user", content: "Customer body" }],
      tools: [{ functionDeclarations: [{ name: "checkSlots" }] }],
      diagnosticContext: { correlationId },
    }), (caught) => caught === error);
    assert.deepEqual(logs, [["[OpenAIProviderFailure]", {
      provider: "openai", operation: "responses.create", stage: "generation",
      httpStatus: status, errorType: "invalid_request_error", errorCode: code,
      parameter: "temperature", requestId: "req_diagnostic123", message: summary,
      model: context.model, toolsPresent: true, toolCount: 1, correlationId,
    }]]);
    assert.equal(classifyAiFailure(error), category);
    assert.equal(isRetryableAiFailure(category), status === 429);
    let attempts = 0;
    await assert.rejects(runAiProviderRequest({
      timeoutMs: 100,
      invoke: async () => { attempts++; throw error; },
    }));
    assert.equal(attempts, status === 429 ? 2 : 1);
  });
}

test("safe summaries distinguish invalid tool schema, input, and malformed request", () => {
  for (const [code, param, message, expected] of [
    ["invalid_function_parameters", "tools[0].parameters", "Failure", "Invalid tool or output schema"],
    [null, "input[0].content", "Invalid message format: private customer content", "Invalid input or message format"],
    [null, null, "Private request body", "Invalid or malformed request"],
  ]) {
    const diagnostic = buildOpenAiFailureDiagnostic(apiError(400, code, param, message), context);
    assert.equal(diagnostic.message, expected);
    assert.equal(diagnostic.parameter, param);
  }
});

test("diagnostic never serializes secrets, prompts, knowledge, tool arguments, headers, or stack", async (t) => {
  const secret = "sk-secret-diagnostic-marker";
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const privateData = `${secret} Bearer access-token-marker customer-prompt-marker business-knowledge-marker tool-arguments-marker`;
  const error = apiError(400, "invalid_tool_schema", "tools[0].parameters", privateData);
  Object.assign(error, {
    stack: privateData, body: privateData,
    headers: { authorization: privateData },
    request: { input: privateData, tools: privateData },
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(Responses.prototype, "create", async () => { throw error; });
  await assert.rejects(generateWithOpenAi({
    model: context.model, systemInstruction: "business-knowledge-marker",
    messages: [
      { role: "user", content: "customer-prompt-marker" },
      { role: "assistant", tool_calls: [{ id: "call-private", function: { name: "checkSlots", arguments: "tool-arguments-marker" } }] },
      { role: "tool", id: "call-private", content: "private-tool-output-marker" },
    ],
    tools: [{ functionDeclarations: [{ name: "checkSlots", description: privateData }] }],
  }));
  const output = JSON.stringify(logs);
  for (const marker of [secret, "Bearer", "access-token-marker", "customer-prompt-marker", "business-knowledge-marker", "tool-arguments-marker", "private-tool-output-marker", "authorization", "stack", "body"]) {
    assert.equal(output.includes(marker), false, marker);
  }
  // No arbitrary API metadata or configuration strings may bypass the allowlists.
  const hostile = buildOpenAiFailureDiagnostic({
    status: 400, type: privateData, code: privateData, param: privateData,
    requestID: privateData, message: privateData,
  }, { model: privateData, correlationId: privateData, toolCount: 0 });
  assert.equal(hostile.errorType, null);
  assert.equal(hostile.errorCode, null);
  assert.equal(hostile.parameter, null);
  assert.equal(hostile.requestId, null);
  assert.equal(hostile.correlationId, null);
  assert.equal(hostile.model, "[unrecognized model]");
  assert.equal(JSON.stringify(hostile).includes(secret), false);
  assert.equal(buildOpenAiFailureDiagnostic({ param: "tools[0].parameters.properties.customerSecret" }, context).parameter, null);
});

test("successful OpenAI generation preserves nonsampling payload and response without diagnostics", async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-success";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const request = {
    model: "gpt-6-luna", temperature: 0.2, systemInstruction: "System instruction",
    messages: [{ role: "user", content: "Hello" }],
    tools: [{ functionDeclarations: [{ name: "checkSlots" }] }],
    diagnosticContext: { correlationId },
  };
  const logs = t.mock.method(console, "error", () => {});
  const create = t.mock.method(Responses.prototype, "create", async (params: unknown) => {
    assert.deepEqual(params, {
      model: request.model, instructions: request.systemInstruction,
      input: toOpenAiInput(request.messages), tools: toOpenAiTools(request.tools),
    });
    return { output_text: "Hello back", output: [] } as any;
  });
  assert.deepEqual(await generateWithOpenAi(request), { text: "Hello back", functionCalls: [] });
  assert.equal(create.mock.callCount(), 1);
  assert.equal(logs.mock.callCount(), 0);
});
