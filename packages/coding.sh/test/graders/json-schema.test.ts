import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateJsonSchema, type JsonSchema } from "../../src/graders/json-schema.ts";

const ok = (v: unknown, s: JsonSchema) => assert.equal(validateJsonSchema(v, s).valid, true, JSON.stringify(validateJsonSchema(v, s).errors));
const bad = (v: unknown, s: JsonSchema, keyword: string, path = "") => {
  const r = validateJsonSchema(v, s);
  assert.equal(r.valid, false, `expected ${JSON.stringify(v)} to fail ${keyword}`);
  assert.ok(
    r.errors.some((e) => e.keyword === keyword && e.path === path),
    `wanted ${keyword} at "${path}", got ${JSON.stringify(r.errors)}`,
  );
};

describe("json-schema: types and literals", () => {
  it("type, including integer vs number and type arrays", () => {
    ok(3, { type: "integer" });
    ok(3.0, { type: "integer" });
    bad(3.5, { type: "integer" }, "type");
    ok(3.5, { type: "number" });
    ok(null, { type: ["string", "null"] });
    bad([], { type: "object" }, "type");
    bad(null, { type: "object" }, "type");
    ok({}, { type: "object" });
    bad("1", { type: "number" }, "type");
  });

  it("boolean schemas", () => {
    ok(1, true);
    bad(1, false, "false");
  });

  it("enum and const use deep equality", () => {
    ok({ a: [1, 2] }, { enum: [1, { a: [1, 2] }] });
    bad({ a: [2, 1] }, { enum: [{ a: [1, 2] }] }, "enum");
    ok({ y: 1, x: 2 }, { const: { x: 2, y: 1 } });
    bad("A", { const: "a" }, "const");
  });
});

describe("json-schema: numbers and strings", () => {
  it("bounds and multipleOf", () => {
    ok(5, { minimum: 5, maximum: 5 });
    bad(4, { minimum: 5 }, "minimum");
    bad(6, { maximum: 5 }, "maximum");
    bad(5, { exclusiveMinimum: 5 }, "exclusiveMinimum");
    bad(5, { exclusiveMaximum: 5 }, "exclusiveMaximum");
    ok(0.3, { multipleOf: 0.1 });
    bad(7, { multipleOf: 2 }, "multipleOf");
  });

  it("length counts code points, pattern is unanchored", () => {
    ok("😀😀", { maxLength: 2 });
    bad("😀😀😀", { maxLength: 2 }, "maxLength");
    bad("a", { minLength: 2 }, "minLength");
    ok("order-123", { pattern: "\\d+" });
    bad("order-x", { pattern: "^order-\\d+$" }, "pattern");
  });

  it("keywords for other types do not apply", () => {
    ok("abc", { minimum: 10, minItems: 3, required: ["x"] });
  });
});

describe("json-schema: objects", () => {
  const person: JsonSchema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } },
    required: ["name"],
    additionalProperties: false,
  };

  it("properties, required, additionalProperties: false", () => {
    ok({ name: "a", age: 3 }, person);
    bad({ age: 3 }, person, "required");
    bad({ name: "a", age: -1 }, person, "minimum", "/age");
    bad({ name: "a", extra: 1 }, person, "additionalProperties", "/extra");
  });

  it("additionalProperties as a schema, with patternProperties", () => {
    const s: JsonSchema = { patternProperties: { "^x-": { type: "string" } }, additionalProperties: { type: "number" } };
    ok({ "x-a": "s", n: 1 }, s);
    bad({ "x-a": 1 }, s, "type", "/x-a");
    bad({ n: "s" }, s, "type", "/n");
  });

  it("escapes JSON pointer segments", () => {
    bad({ "a/b": 1 }, { properties: { "a/b": { type: "string" } } }, "type", "/a~1b");
  });

  it("min/maxProperties, propertyNames, dependentRequired", () => {
    bad({}, { minProperties: 1 }, "minProperties");
    bad({ a: 1, b: 2 }, { maxProperties: 1 }, "maxProperties");
    bad({ Bad: 1 }, { propertyNames: { pattern: "^[a-z]+$" } }, "propertyNames", "/Bad");
    bad({ card: 1 }, { dependentRequired: { card: ["cvv"] } }, "dependentRequired");
  });

  it("does not treat inherited properties as present", () => {
    bad(Object.create({ name: "x" }), { required: ["name"] }, "required");
  });
});

describe("json-schema: arrays", () => {
  it("items, prefixItems, min/maxItems", () => {
    ok([1, 2], { items: { type: "integer" }, minItems: 2, maxItems: 2 });
    bad([1, "2"], { items: { type: "integer" } }, "type", "/1");
    bad([], { minItems: 1 }, "minItems");
    bad([1, 2, 3], { maxItems: 2 }, "maxItems");
    const tuple: JsonSchema = { prefixItems: [{ type: "string" }, { type: "number" }], items: false };
    ok(["a", 1], tuple);
    bad(["a", 1, true], tuple, "false", "/2");
    bad([1, 1], tuple, "type", "/0");
  });

  it("contains with min/maxContains, uniqueItems with deep equality", () => {
    ok([1, "x"], { contains: { type: "string" } });
    bad([1, 2], { contains: { type: "string" } }, "contains");
    bad(["a"], { contains: { type: "string" }, minContains: 2 }, "contains");
    bad(["a", "b"], { contains: { type: "string" }, maxContains: 1 }, "maxContains");
    bad([{ a: 1 }, { a: 1 }], { uniqueItems: true }, "uniqueItems");
    ok([{ a: 1 }, { a: 2 }], { uniqueItems: true });
  });
});

describe("json-schema: composition and refs", () => {
  it("allOf / anyOf / oneOf / not", () => {
    ok(5, { allOf: [{ minimum: 1 }, { maximum: 10 }] });
    bad(50, { allOf: [{ minimum: 1 }, { maximum: 10 }] }, "maximum");
    ok("s", { anyOf: [{ type: "number" }, { type: "string" }] });
    bad(true, { anyOf: [{ type: "number" }, { type: "string" }] }, "anyOf");
    ok(5, { oneOf: [{ type: "integer" }, { type: "string" }] });
    bad(5, { oneOf: [{ type: "integer" }, { type: "number" }] }, "oneOf");
    bad("x", { oneOf: [{ type: "integer" }, { type: "boolean" }] }, "oneOf");
    bad("x", { not: { type: "string" } }, "not");
  });

  it("if / then / else", () => {
    const s: JsonSchema = {
      if: { properties: { kind: { const: "a" } } },
      then: { required: ["a"] },
      else: { required: ["b"] },
    };
    ok({ kind: "a", a: 1 }, s);
    bad({ kind: "a" }, s, "required");
    bad({ kind: "z" }, s, "required");
  });

  it("local $ref to $defs and recursion", () => {
    const tree: JsonSchema = {
      $defs: { node: { type: "object", properties: { v: { type: "number" }, kids: { type: "array", items: { $ref: "#/$defs/node" } } }, required: ["v"] } },
      $ref: "#/$defs/node",
    };
    ok({ v: 1, kids: [{ v: 2, kids: [{ v: 3 }] }] }, tree);
    bad({ v: 1, kids: [{ v: 2, kids: [{}] }] }, tree, "required", "/kids/0/kids/0");
    assert.throws(() => validateJsonSchema(1, { $ref: "#/$defs/missing" }), /not found/);
    assert.throws(() => validateJsonSchema(1, { $ref: "https://example.com/s.json" }), /only local/);
  });

  it("caps the number of errors", () => {
    const r = validateJsonSchema(Array.from({ length: 100 }, () => "x"), { items: { type: "number" } }, { maxErrors: 5 });
    assert.equal(r.errors.length, 5);
  });
});
