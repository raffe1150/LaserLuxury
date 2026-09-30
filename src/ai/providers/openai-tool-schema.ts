const jsonSchemaTypes = new Set([
  "object", "array", "string", "number", "integer", "boolean", "null",
]);
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const childSchemas = new Set([
  "items", "additionalProperties", "additionalItems", "contains", "not",
  "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems",
]);
const integerBounds = new Set([
  "minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties",
]);

function normalizeType(type: unknown): string {
  if (typeof type !== "string" || !jsonSchemaTypes.has(type.toLowerCase())) {
    // Fail closed instead of replacing an unknown type with an unconstrained schema.
    throw new Error("Unsupported OpenAI tool schema type");
  }
  return type.toLowerCase();
}

/** Convert Gemini's OpenAPI-style schema only at the OpenAI provider boundary. */
export function normalizeOpenAiToolSchema(schema: any): any {
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Invalid OpenAI tool schema");
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "nullable" || key === "propertyOrdering") continue;
    if (key === "type") {
      result.type = Array.isArray(value) ? value.map(normalizeType) : normalizeType(value);
    } else if (schemaMaps.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [
        name, normalizeOpenAiToolSchema(child),
      ]));
    } else if (schemaLists.has(key) && Array.isArray(value)) {
      result[key] = value.map(normalizeOpenAiToolSchema);
    } else if (childSchemas.has(key)) {
      result[key] = Array.isArray(value)
        ? value.map(normalizeOpenAiToolSchema)
        : normalizeOpenAiToolSchema(value);
    } else if (integerBounds.has(key) && typeof value === "string") {
      // Gemini's SDK represents these integer constraints as strings.
      const bound = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(bound)) {
        throw new Error("Invalid OpenAI tool schema bound");
      }
      result[key] = bound;
    } else if (key === "format" && ["enum", "int32", "int64", "float", "double"].includes(value as string)) {
      // Gemini enum/numeric format annotations are not JSON Schema formats.
      // The enum and base integer/number constraints remain intact.
      continue;
    } else if (key === "example") {
      result.examples = schema.examples || [value];
    } else {
      // Preserve JSON Schema constraints and data verbatim; don't recursively
      // rewrite enums, defaults, examples, or a user property named "type".
      result[key] = value;
    }
  }

  // Gemini can encode numeric enum values as strings even for INTEGER/NUMBER.
  if ((result.type === "integer" || result.type === "number") && Array.isArray(result.enum)) {
    result.enum = result.enum.map((value: unknown) => {
      const numeric = typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
        ? Number(value) : value;
      if (typeof numeric !== "number" || !Number.isFinite(numeric)
        || (result.type === "integer" && !Number.isInteger(numeric))) {
        throw new Error("Invalid OpenAI tool schema numeric enum");
      }
      return numeric;
    });
  }

  // Wrap the full constrained schema so null is allowed even with an enum,
  // pattern, or composition. Optionality continues to be controlled by required.
  return schema.nullable === true && result.type !== "null"
    ? { anyOf: [result, { type: "null" }] }
    : result;
}
