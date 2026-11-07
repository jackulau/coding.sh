// tools/call argument validation for the MCP tap. The spec names a subset
// (type, required, properties, enum, additionalProperties, items,
// minimum/maximum); src/graders/json-schema.ts covers a superset of it, so the
// tap reuses it and reports one human-readable string per violation.
import { validateJsonSchema, type JsonSchema } from "../graders/json-schema.ts";

/** Violations of `schema` by `value`, as "<pointer>: <message>" strings; [] when valid. */
export function schemaViolations(value: unknown, schema: unknown, max = 20): string[] {
  if (schema === undefined || schema === null || (typeof schema !== "object" && typeof schema !== "boolean")) return [];
  const r = validateJsonSchema(value, schema as JsonSchema, { maxErrors: max });
  return r.errors.map((e) => `${e.path || "/"}: ${e.message}`);
}
