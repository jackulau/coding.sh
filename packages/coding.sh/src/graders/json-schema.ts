// A JSON Schema (draft 2020-12) validator covering the keywords evals use:
// type, enum, const, numeric bounds + multipleOf, string length + pattern,
// properties / required / additionalProperties / patternProperties /
// propertyNames / min-maxProperties, items / prefixItems / contains /
// min-maxItems / uniqueItems, allOf / anyOf / oneOf / not, if/then/else,
// boolean schemas, and local `$ref` ("#", "#/$defs/x", JSON pointers).
// `format` is an annotation in 2020-12 and is ignored. Unknown keywords are ignored.
import { deepEqual } from "../datasets/hash.ts";

export type JsonSchema = boolean | { [k: string]: unknown };

export interface SchemaError {
  /** JSON pointer into the instance, "" for the root. */
  path: string;
  keyword: string;
  message: string;
}

export interface ValidateOpts {
  /** Stop after this many errors (default 50). */
  maxErrors?: number;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "number") return Number.isInteger(v) ? "integer" : "number";
  return t;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = jsonType(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

function escapePointer(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const regexCache = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  let r = regexCache.get(pattern);
  if (!r) {
    try {
      r = new RegExp(pattern, "u");
    } catch {
      r = new RegExp(pattern);
    }
    regexCache.set(pattern, r);
  }
  return r;
}

class Validator {
  readonly errors: SchemaError[] = [];
  readonly root: JsonSchema;
  readonly max: number;
  constructor(root: JsonSchema, max: number) {
    this.root = root;
    this.max = max;
  }

  full(): boolean {
    return this.errors.length >= this.max;
  }

  add(path: string, keyword: string, message: string): void {
    if (!this.full()) this.errors.push({ path, keyword, message });
  }

  resolve(ref: string): JsonSchema {
    if (!ref.startsWith("#")) throw new Error(`json-schema: only local $ref is supported (got ${ref})`);
    const frag = decodeURIComponent(ref.slice(1));
    if (frag === "") return this.root;
    if (!frag.startsWith("/")) throw new Error(`json-schema: unsupported $ref ${ref}`);
    let cur: unknown = this.root;
    for (const raw of frag.slice(1).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (cur === null || typeof cur !== "object" || !(key in (cur as object))) throw new Error(`json-schema: $ref ${ref} not found`);
      cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur !== "boolean" && (cur === null || typeof cur !== "object")) throw new Error(`json-schema: $ref ${ref} is not a schema`);
    return cur as JsonSchema;
  }

  /** Validate without recording errors (for anyOf/oneOf/not/if branches). */
  probe(v: unknown, s: JsonSchema, path: string, depth: number): SchemaError[] {
    const sub = new Validator(this.root, this.max);
    sub.check(v, s, path, depth);
    return sub.errors;
  }

  check(v: unknown, s: JsonSchema, path: string, depth: number): void {
    if (depth > 64) throw new Error("json-schema: $ref recursion too deep");
    if (s === true) return;
    if (s === false) {
      this.add(path, "false", "no value is allowed here");
      return;
    }
    if (typeof s !== "object" || s === null) throw new Error("json-schema: schema must be an object or boolean");

    if (typeof s.$ref === "string") this.check(v, this.resolve(s.$ref), path, depth + 1);

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeMatches(v, t))) this.add(path, "type", `expected ${types.join(" or ")}, got ${jsonType(v)}`);
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) {
      this.add(path, "enum", `must be one of ${JSON.stringify(s.enum)}`);
    }
    if ("const" in s && !deepEqual(s.const, v)) this.add(path, "const", `must equal ${JSON.stringify(s.const)}`);

    if (typeof v === "number") this.numeric(v, s, path);
    if (typeof v === "string") this.string(v, s, path);
    if (Array.isArray(v)) this.array(v, s, path, depth);
    else if (v !== null && typeof v === "object") this.object(v as Record<string, unknown>, s, path, depth);

    if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) this.check(v, sub, path, depth + 1);
    if (Array.isArray(s.anyOf)) {
      const branches = s.anyOf as JsonSchema[];
      if (!branches.some((b) => this.probe(v, b, path, depth + 1).length === 0)) this.add(path, "anyOf", "must match at least one schema in anyOf");
    }
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as JsonSchema[]).filter((b) => this.probe(v, b, path, depth + 1).length === 0).length;
      if (n !== 1) this.add(path, "oneOf", `must match exactly one schema in oneOf (matched ${n})`);
    }
    if (s.not !== undefined && this.probe(v, s.not as JsonSchema, path, depth + 1).length === 0) {
      this.add(path, "not", "must not match the schema in not");
    }
    if (s.if !== undefined) {
      const ok = this.probe(v, s.if as JsonSchema, path, depth + 1).length === 0;
      const branch = ok ? s.then : s.else;
      if (branch !== undefined) this.check(v, branch as JsonSchema, path, depth + 1);
    }
  }

  numeric(v: number, s: Record<string, unknown>, path: string): void {
    if (typeof s.minimum === "number" && v < s.minimum) this.add(path, "minimum", `must be >= ${s.minimum}`);
    if (typeof s.maximum === "number" && v > s.maximum) this.add(path, "maximum", `must be <= ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) this.add(path, "exclusiveMinimum", `must be > ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) this.add(path, "exclusiveMaximum", `must be < ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
      const q = v / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) this.add(path, "multipleOf", `must be a multiple of ${s.multipleOf}`);
    }
  }

  string(v: string, s: Record<string, unknown>, path: string): void {
    const len = typeof s.minLength === "number" || typeof s.maxLength === "number" ? codePoints(v) : 0;
    if (typeof s.minLength === "number" && len < s.minLength) this.add(path, "minLength", `must be at least ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && len > s.maxLength) this.add(path, "maxLength", `must be at most ${s.maxLength} characters`);
    if (typeof s.pattern === "string" && !re(s.pattern).test(v)) this.add(path, "pattern", `must match /${s.pattern}/`);
  }

  array(v: unknown[], s: Record<string, unknown>, path: string, depth: number): void {
    if (typeof s.minItems === "number" && v.length < s.minItems) this.add(path, "minItems", `must have at least ${s.minItems} items`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) this.add(path, "maxItems", `must have at most ${s.maxItems} items`);
    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as JsonSchema[]) : [];
    prefix.forEach((ps, i) => {
      if (i < v.length) this.check(v[i], ps, `${path}/${i}`, depth + 1);
    });
    // Draft 2020-12 `items` (schema) applies after prefixItems. Draft-07 tuple
    // form (`items: [...]`) is accepted too, as prefixItems.
    if (Array.isArray(s.items)) {
      (s.items as JsonSchema[]).forEach((ps, i) => {
        if (i < v.length) this.check(v[i], ps, `${path}/${i}`, depth + 1);
      });
    } else if (s.items !== undefined) {
      for (let i = prefix.length; i < v.length && !this.full(); i++) this.check(v[i], s.items as JsonSchema, `${path}/${i}`, depth + 1);
    }
    if (s.contains !== undefined) {
      const n = v.filter((x, i) => this.probe(x, s.contains as JsonSchema, `${path}/${i}`, depth + 1).length === 0).length;
      const min = typeof s.minContains === "number" ? s.minContains : 1;
      if (n < min) this.add(path, "contains", `must contain at least ${min} matching item(s) (found ${n})`);
      if (typeof s.maxContains === "number" && n > s.maxContains) this.add(path, "maxContains", `must contain at most ${s.maxContains} matching item(s)`);
    }
    if (s.uniqueItems === true) {
      for (let i = 0; i < v.length; i++) {
        for (let j = i + 1; j < v.length; j++) {
          if (deepEqual(v[i], v[j])) {
            this.add(path, "uniqueItems", `items ${i} and ${j} are equal`);
            return;
          }
        }
      }
    }
  }

  object(v: Record<string, unknown>, s: Record<string, unknown>, path: string, depth: number): void {
    const keys = Object.keys(v);
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) this.add(path, "minProperties", `must have at least ${s.minProperties} properties`);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) this.add(path, "maxProperties", `must have at most ${s.maxProperties} properties`);
    if (Array.isArray(s.required)) {
      for (const k of s.required as string[]) if (!Object.hasOwn(v, k)) this.add(path, "required", `missing required property ${JSON.stringify(k)}`);
    }
    if (s.dependentRequired && typeof s.dependentRequired === "object") {
      for (const [k, deps] of Object.entries(s.dependentRequired as Record<string, string[]>)) {
        if (!Object.hasOwn(v, k)) continue;
        for (const d of deps) if (!Object.hasOwn(v, d)) this.add(path, "dependentRequired", `${JSON.stringify(k)} requires ${JSON.stringify(d)}`);
      }
    }
    const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, JsonSchema>;
    const patterns = (s.patternProperties && typeof s.patternProperties === "object" ? s.patternProperties : {}) as Record<string, JsonSchema>;
    for (const k of keys) {
      if (this.full()) return;
      const p = `${path}/${escapePointer(k)}`;
      let matched = false;
      if (Object.hasOwn(props, k)) {
        matched = true;
        this.check(v[k], props[k] as JsonSchema, p, depth + 1);
      }
      for (const [pat, ps] of Object.entries(patterns)) {
        if (re(pat).test(k)) {
          matched = true;
          this.check(v[k], ps, p, depth + 1);
        }
      }
      if (!matched && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) this.add(p, "additionalProperties", `unexpected property ${JSON.stringify(k)}`);
        else this.check(v[k], s.additionalProperties as JsonSchema, p, depth + 1);
      }
      if (s.propertyNames !== undefined) {
        const errs = this.probe(k, s.propertyNames as JsonSchema, p, depth + 1);
        if (errs.length) this.add(p, "propertyNames", `property name ${JSON.stringify(k)} is invalid: ${errs[0]?.message}`);
      }
    }
  }
}

/** Validate `value` against `schema`. Throws only for an unusable schema (bad $ref). */
export function validateJsonSchema(value: unknown, schema: JsonSchema, opts: ValidateOpts = {}): { valid: boolean; errors: SchemaError[] } {
  const v = new Validator(schema, opts.maxErrors ?? 50);
  v.check(value, schema, "", 0);
  return { valid: v.errors.length === 0, errors: v.errors };
}

export function formatSchemaErrors(errors: readonly SchemaError[], limit = 5): string {
  const shown = errors.slice(0, limit).map((e) => `${e.path || "/"}: ${e.message}`);
  if (errors.length > limit) shown.push(`… ${errors.length - limit} more`);
  return shown.join("; ");
}
