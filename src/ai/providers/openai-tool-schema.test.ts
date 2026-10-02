import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { FunctionTool } from "openai/resources/responses/responses";
import { Responses } from "openai/resources/responses";
import { generateWithOpenAi, normalizeOpenAiGenerationResponse, toOpenAiTools } from "./openai";
import { normalizeOpenAiToolSchema } from "./openai-tool-schema";

// Read the actual production declarations without importing/running the server.
const source = ts.createSourceFile("server.ts", readFileSync(
  new URL("../../../server.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
let toolsExpression: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "calendarTools") {
    toolsExpression = node.initializer?.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(toolsExpression);
const productionTools = JSON.parse(JSON.stringify(runInNewContext(`(${toolsExpression})`)));

test("exact production logSystemAnalysis declaration emits a valid Responses function shape", () => {
  const declaration = productionTools[0].functionDeclarations.find((fn: any) => fn.name === "logSystemAnalysis");
  assert.equal(declaration.parameters.type, "OBJECT");
  const tool: FunctionTool = toOpenAiTools([{ functionDeclarations: [declaration] }])![0];
  assert.deepEqual(tool, {
    type: "function", name: "logSystemAnalysis", description: declaration.description, strict: false,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "user's name if mentioned, else null" },
        phone: { type: "string", description: "user's phone number if mentioned, else null" },
        booked_appointment: { type: "boolean", description: "true if user is trying to book or booked, else false" },
        feedback_left: { type: "boolean", description: "true if they left any complain/suggestion, else false" },
        feedback_summary: { type: "string", description: "summary of feedback if they left any, else null" },
      },
    },
  });
  assert.equal(declaration.parameters.properties.name.type, "STRING", "internal declaration remains unchanged");
});

test("all five production declarations keep names, descriptions, required fields, and enum constraints", () => {
  const snapshot = JSON.stringify(productionTools);
  const converted = toOpenAiTools(productionTools)!;
  assert.deepEqual(converted.map((fn) => fn.name), [
    "checkSlots", "findCustomerAppointments", "rescheduleAppointment", "insertAppointment", "logSystemAnalysis",
  ]);
  for (const [index, tool] of converted.entries()) {
    const original = productionTools[0].functionDeclarations[index];
    assert.equal(tool.type, "function");
    assert.equal(tool.strict, false);
    assert.equal(tool.description, original.description);
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(tool.parameters.required, original.parameters.required);
    assert.deepEqual(Object.keys(tool.parameters.properties), Object.keys(original.parameters.properties));
    for (const [name, property] of Object.entries(original.parameters.properties) as [string, any][]) {
      assert.deepEqual(tool.parameters.properties[name], { ...property, type: property.type.toLowerCase() });
    }
  }
  assert.equal(JSON.stringify(productionTools), snapshot);
});

test("Responses generation sends the normalized live tool schema and preserves returned tool calls", async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-no-network";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const declaration = productionTools[0].functionDeclarations.find((fn: any) => fn.name === "logSystemAnalysis");
  const create = t.mock.method(Responses.prototype, "create", async (params: any) => {
    assert.equal(params.tools.length, 1);
    assert.equal(params.tools[0].name, "logSystemAnalysis");
    assert.equal(params.tools[0].strict, false);
    assert.equal(params.tools[0].parameters.type, "object");
    assert.equal(params.tools[0].parameters.properties.booked_appointment.type, "boolean");
    assert.equal(params.tools[0].parameters.required, undefined);
    assert.equal(params.tools[0].parameters.additionalProperties, undefined);
    return { output_text: "", output: [{ type: "function_call", call_id: "call-log", name: "logSystemAnalysis", arguments: '{"booked_appointment":false}' }] } as any;
  });
  assert.deepEqual(await generateWithOpenAi({
    model: "gpt-6-luna", messages: [{ role: "user", content: "Hi! What services do you offer?" }],
    tools: [{ functionDeclarations: [declaration] }],
  }), {
    text: "", functionCalls: [{ id: "call-log", function: { name: "logSystemAnalysis", arguments: '{"booked_appointment":false}' } }],
  });
  assert.equal(create.mock.callCount(), 1);
});

test("Responses generation maps unified structured output to text.format json_schema", async (t) => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-no-network";

  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["phone"],
    properties: {
      phone: { type: "string" },
    },
  };

  const create = t.mock.method(Responses.prototype, "create", async (params: any) => {
    assert.deepEqual(params.text, {
      format: {
        type: "json_schema",
        name: "contact_understanding",
        schema,
        description: "Extract grounded customer contact.",
        strict: true,
      },
    });
    return { output_text: '{"phone":"0701234567"}', output: [] } as any;
  });

  assert.deepEqual(await generateWithOpenAi({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "My phone number is 0701234567." }],
    structuredOutput: {
      name: "contact_understanding",
      schema,
      description: "Extract grounded customer contact.",
      strict: true,
    },
  }), {
    text: '{"phone":"0701234567"}',
    functionCalls: [],
  });

  assert.equal(create.mock.callCount(), 1);
});

test("nested objects and arrays preserve constraints and optional properties without mutation", () => {
  const schema = {
    type: "OBJECT", additionalProperties: false, required: ["records"],
    properties: {
      records: { type: "ARRAY", minItems: "1", maxItems: "3", items: {
        type: "OBJECT", additionalProperties: false, required: ["kind"], properties: {
          kind: { type: "STRING", format: "enum", enum: ["OBJECT", "STRING"] },
          note: { type: "STRING", minLength: "2", maxLength: "10", pattern: "^[a-z]+$" },
          score: { type: "NUMBER", format: "double", minimum: 0, maximum: 1 },
        },
      } },
      type: { type: "STRING", default: "OBJECT", example: "STRING" },
    },
  };
  const snapshot = JSON.stringify(schema);
  assert.deepEqual(normalizeOpenAiToolSchema(schema), {
    type: "object", additionalProperties: false, required: ["records"],
    properties: {
      records: { type: "array", minItems: 1, maxItems: 3, items: {
        type: "object", additionalProperties: false, required: ["kind"], properties: {
          kind: { type: "string", enum: ["OBJECT", "STRING"] },
          note: { type: "string", minLength: 2, maxLength: 10, pattern: "^[a-z]+$" },
          score: { type: "number", minimum: 0, maximum: 1 },
        },
      } },
      type: { type: "string", default: "OBJECT", examples: ["STRING"] },
    },
  });
  assert.equal(JSON.stringify(schema), snapshot);
});

test("Gemini nullable and propertyOrdering become JSON Schema without loosening enums or requiring optional fields", () => {
  assert.deepEqual(normalizeOpenAiToolSchema({
    type: "OBJECT", propertyOrdering: ["status", "email"], properties: {
      status: { type: "STRING", nullable: true, format: "enum", enum: ["ready", "waiting"] },
      email: { type: "STRING", nullable: false, format: "email" },
    },
  }), {
    type: "object", properties: {
      status: { anyOf: [{ type: "string", enum: ["ready", "waiting"] }, { type: "null" }] },
      email: { type: "string", format: "email" },
    },
  });
});

test("schema compositions, type unions, and schema-valued maps normalize recursively", () => {
  const normalized = normalizeOpenAiToolSchema({
    type: "OBJECT", properties: {
      choice: { anyOf: [{ type: "STRING" }, { type: "INTEGER" }], nullable: true },
      tags: { type: ["ARRAY", "NULL"], items: { type: "STRING" } },
      mapping: { type: "OBJECT", additionalProperties: { type: "BOOLEAN" } },
    }, $defs: { text: { type: "STRING" } },
  });
  assert.deepEqual(normalized, {
    type: "object", properties: {
      choice: { anyOf: [{ anyOf: [{ type: "string" }, { type: "integer" }] }, { type: "null" }] },
      tags: { type: ["array", "null"], items: { type: "string" } },
      mapping: { type: "object", additionalProperties: { type: "boolean" } },
    }, $defs: { text: { type: "string" } },
  });
  assert.deepEqual(normalizeOpenAiToolSchema(normalized), normalized);
});

test("Gemini string-encoded numeric enums keep their numeric constraints", () => {
  assert.deepEqual(normalizeOpenAiToolSchema({ type: "INTEGER", format: "int64", enum: ["101", "201"], minimum: 100 }), {
    type: "integer", enum: [101, 201], minimum: 100,
  });
  assert.deepEqual(normalizeOpenAiToolSchema({ type: "NUMBER", format: "float", enum: ["1.5", "2e2"] }), {
    type: "number", enum: [1.5, 200],
  });
});

test("unsupported types and malformed Gemini constraints fail safely instead of weakening schemas", () => {
  assert.throws(() => normalizeOpenAiToolSchema({ type: "TYPE_UNSPECIFIED" }), /^Error: Unsupported OpenAI tool schema type$/);
  assert.throws(() => normalizeOpenAiToolSchema({ type: "PRIVATE-secret-marker" }), /^Error: Unsupported OpenAI tool schema type$/);
  assert.throws(() => normalizeOpenAiToolSchema({ type: "ARRAY", minItems: "private-payload" }), /^Error: Invalid OpenAI tool schema bound$/);
  assert.throws(() => normalizeOpenAiToolSchema({ type: "INTEGER", enum: ["1.5"] }), /^Error: Invalid OpenAI tool schema numeric enum$/);
});

test("lowercase JSON Schema, empty tools, and successful returned tool calls stay unchanged", () => {
  const schema = { type: "object", properties: { optional: { type: "string" } }, required: [], additionalProperties: false };
  assert.deepEqual(normalizeOpenAiToolSchema(schema), schema);
  assert.equal(toOpenAiTools(undefined), undefined);
  assert.equal(toOpenAiTools([{ functionDeclarations: [] }]), undefined);
  assert.deepEqual(toOpenAiTools([{ functionDeclarations: [{ name: "noArgs" }] }])![0].parameters, {
    type: "object", properties: {}, additionalProperties: true,
  });
  assert.deepEqual(normalizeOpenAiGenerationResponse({
    output_text: "", output: [{ type: "function_call", id: "item-1", call_id: "call-1", name: "logSystemAnalysis", arguments: '{"booked_appointment":false}' }],
  }), { text: "", functionCalls: [{ id: "call-1", function: { name: "logSystemAnalysis", arguments: '{"booked_appointment":false}' } }] });
});
