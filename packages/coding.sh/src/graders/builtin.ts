// Deterministic built-in graders. Each is built from a plain, serializable
// spec, and its version is a hash of that spec, so a result always says
// exactly which grading rule produced it.
import { canonicalJson, deepEqual, shortHash } from "../datasets/hash.ts";
import type { GradeContext, GradeResult, Grader } from "../datasets/types.ts";
import { maybeJson } from "../judge/extract.ts";
import { formatSchemaErrors, validateJsonSchema, type JsonSchema } from "./json-schema.ts";
import { queryJsonPath } from "./json-path.ts";

export interface NormalizeOpts {
  /** Trim leading/trailing whitespace. Default true. */
  trim?: boolean;
  caseInsensitive?: boolean;
  /** Collapse runs of whitespace to one space. */
  collapseWhitespace?: boolean;
  /** Remove Unicode punctuation and symbols. */
  stripPunctuation?: boolean;
  /** Unicode NFKC normalization (full-width digits, ligatures, …). */
  unicode?: boolean;
}

export function normalizeText(s: string, o: NormalizeOpts = {}): string {
  let t = s;
  if (o.unicode) t = t.normalize("NFKC");
  if (o.stripPunctuation) t = t.replace(/[\p{P}\p{S}]+/gu, "");
  if (o.collapseWhitespace) t = t.replace(/\s+/g, " ");
  if (o.trim ?? true) t = t.trim();
  if (o.caseInsensitive) t = t.toLowerCase();
  return t;
}

/** Text form of any output: strings as-is, everything else as canonical JSON. */
export function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  try {
    return canonicalJson(v);
  } catch {
    return String(v);
  }
}

export function result(score: number, pass: boolean, reason?: string): GradeResult {
  const r: GradeResult = { score: Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0)), pass };
  if (reason) r.reason = reason;
  return r;
}

function short(v: unknown, n = 80): string {
  const s = asText(v);
  return s.length > n ? `${JSON.stringify(s.slice(0, n))}…` : JSON.stringify(s);
}

function makeGrader(kind: string, spec: { name?: string }, grade: (ctx: GradeContext) => GradeResult | Promise<GradeResult>): Grader {
  const { name, ...config } = spec;
  return {
    id: name ?? kind,
    kind,
    version: shortHash({ kind, config }),
    grade: async (ctx) => grade(ctx),
  };
}

function target(spec: { value?: unknown }, ctx: GradeContext): unknown {
  return "value" in spec && spec.value !== undefined ? spec.value : ctx.expected;
}

// ---------------------------------------------------------------- exact

export interface ExactSpec {
  kind: "exact";
  name?: string;
  /** Compare against this instead of the case's expected value. */
  value?: unknown;
  normalize?: NormalizeOpts;
}

/** Structural equality for JSON values; normalized string equality otherwise. */
export function exactGrader(spec: Omit<ExactSpec, "kind"> = {}): Grader {
  return makeGrader("exact", spec, (ctx) => {
    const want = target(spec, ctx);
    if (want === undefined) return result(0, false, "no expected value to compare with");
    const got = ctx.output;
    if (typeof want !== "string" && typeof got !== "string") {
      return deepEqual(got, want) ? result(1, true) : result(0, false, `expected ${short(want)}, got ${short(got)}`);
    }
    const a = normalizeText(asText(got), spec.normalize);
    const b = normalizeText(asText(want), spec.normalize);
    return a === b ? result(1, true) : result(0, false, `expected ${short(b)}, got ${short(a)}`);
  });
}

// ---------------------------------------------------------------- contains / regex

export interface ContainsSpec {
  kind: "contains";
  name?: string;
  /** Substring(s) to look for. Default: the expected value. */
  value?: string | string[];
  /** "all" (default) or "any". */
  mode?: "all" | "any";
  normalize?: NormalizeOpts;
  /** Pass when the substrings are absent instead. */
  negate?: boolean;
}

export function containsGrader(spec: Omit<ContainsSpec, "kind"> = {}): Grader {
  return makeGrader("contains", spec, (ctx) => {
    const raw = target(spec, ctx);
    if (raw === undefined) return result(0, false, "no substring to look for");
    const needles = (Array.isArray(raw) ? raw : [raw]).map((n) => normalizeText(asText(n), spec.normalize));
    const hay = normalizeText(asText(ctx.output), spec.normalize);
    const found = needles.filter((n) => hay.includes(n));
    const missing = needles.filter((n) => !hay.includes(n));
    if (spec.negate) {
      const pass = found.length === 0;
      return result(1 - found.length / needles.length, pass, pass ? undefined : `found forbidden ${found.map((f) => short(f, 40)).join(", ")}`);
    }
    const pass = (spec.mode ?? "all") === "all" ? missing.length === 0 : found.length > 0;
    return result(found.length / needles.length, pass, pass ? undefined : `missing ${missing.map((m) => short(m, 40)).join(", ")}`);
  });
}

export interface RegexSpec {
  kind: "regex";
  name?: string;
  pattern: string;
  flags?: string;
  negate?: boolean;
}

export function regexGrader(spec: Omit<RegexSpec, "kind">): Grader {
  const re = new RegExp(spec.pattern, (spec.flags ?? "").replace(/[gy]/g, ""));
  return makeGrader("regex", spec, (ctx) => {
    const m = re.exec(asText(ctx.output));
    const pass = spec.negate ? !m : !!m;
    if (pass) return result(1, true, m && !spec.negate ? `matched ${short(m[0], 60)}` : undefined);
    return result(0, false, spec.negate ? `matched forbidden ${short(m?.[0], 60)}` : `no match for /${spec.pattern}/${spec.flags ?? ""}`);
  });
}

// ---------------------------------------------------------------- json schema

export interface JsonSchemaSpec {
  kind: "json-schema";
  name?: string;
  schema: JsonSchema;
}

/** Output (parsed from text if needed) must validate against the schema. */
export function jsonSchemaGrader(spec: Omit<JsonSchemaSpec, "kind">): Grader {
  // Fail fast on a broken schema (bad $ref) at construction, not per case.
  validateJsonSchema(null, spec.schema);
  return makeGrader("json-schema", spec, (ctx) => {
    const value = maybeJson(ctx.output);
    const { valid, errors } = validateJsonSchema(value, spec.schema);
    return valid ? result(1, true) : result(0, false, formatSchemaErrors(errors));
  });
}

// ---------------------------------------------------------------- json path

export interface JsonPathSpec {
  kind: "json-path";
  name?: string;
  /** Path into the output, e.g. "$.answer.city". */
  path: string;
  /** Value the selection must equal. Default: the same path in `expected` (or `expected` itself). */
  equals?: unknown;
  /** Path into `expected` to compare with (default: `path`, falling back to the whole expected value). */
  expectedPath?: string;
  normalize?: NormalizeOpts;
}

function selection(v: unknown, path: string): unknown {
  const hits = queryJsonPath(maybeJson(v), path);
  return hits.length === 0 ? undefined : hits.length === 1 ? hits[0] : hits;
}

export function jsonPathGrader(spec: Omit<JsonPathSpec, "kind">): Grader {
  queryJsonPath(null, spec.path); // validate syntax eagerly
  return makeGrader("json-path", spec, (ctx) => {
    const got = selection(ctx.output, spec.path);
    let want: unknown;
    if ("equals" in spec && spec.equals !== undefined) want = spec.equals;
    else {
      const exp = maybeJson(ctx.expected);
      want = selection(exp, spec.expectedPath ?? spec.path);
      if (want === undefined && spec.expectedPath === undefined) want = exp;
    }
    if (got === undefined) return result(0, false, `${spec.path} not found in output`);
    if (want === undefined) return result(0, false, "no expected value to compare with");
    const eq =
      typeof got === "string" && typeof want === "string" ? normalizeText(got, spec.normalize) === normalizeText(want, spec.normalize) : deepEqual(got, want);
    return eq ? result(1, true) : result(0, false, `${spec.path}: expected ${short(want)}, got ${short(got)}`);
  });
}

// ---------------------------------------------------------------- numeric

export interface NumericSpec {
  kind: "numeric";
  name?: string;
  /** Absolute tolerance. Default 0 (unless rel is set). */
  abs?: number;
  /** Relative tolerance, as a fraction of |expected|. */
  rel?: number;
  /** Target instead of the expected value. */
  value?: number;
  /** JSON path to the number inside a structured output. */
  path?: string;
}

/** First number in a value: numbers as-is, strings parsed ("1,234.5", "$3", "42%"). */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  const direct = Number(t);
  if (t !== "" && Number.isFinite(direct)) return direct;
  const m = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
  for (const hit of t.matchAll(m)) {
    if (!hit[0] || !/\d/.test(hit[0])) continue;
    const n = Number(hit[0].replaceAll(",", ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function numericGrader(spec: Omit<NumericSpec, "kind"> = {}): Grader {
  return makeGrader("numeric", spec, (ctx) => {
    const gotRaw = spec.path ? selection(ctx.output, spec.path) : ctx.output;
    const got = toNumber(gotRaw);
    const want = toNumber(spec.value ?? (spec.path ? (selection(ctx.expected, spec.path) ?? ctx.expected) : ctx.expected));
    if (want === undefined) return result(0, false, "no numeric expected value");
    if (got === undefined) return result(0, false, `output ${short(gotRaw)} has no number`);
    const tol = Math.max(spec.abs ?? 0, (spec.rel ?? 0) * Math.abs(want));
    const err = Math.abs(got - want);
    const pass = err <= tol + Number.EPSILON * Math.max(1, Math.abs(want));
    return pass ? result(1, true) : result(0, false, `expected ${want} ± ${tol}, got ${got} (off by ${err})`);
  });
}

// ---------------------------------------------------------------- similarity

/** Levenshtein distance over code points, O(min(n, m)) memory. */
export function levenshtein(a: string, b: string): number {
  let s = Array.from(a);
  let t = Array.from(b);
  if (s.length < t.length) [s, t] = [t, s];
  if (t.length === 0) return s.length;
  let prev = new Array<number>(t.length + 1);
  let cur = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    const si = s[i - 1];
    for (let j = 1; j <= t.length; j++) {
      const cost = si === t[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length] as number;
}

/** 1 − distance / max length; 1 for two empty strings. */
export function similarity(a: string, b: string): number {
  const n = Math.max(Array.from(a).length, Array.from(b).length);
  return n === 0 ? 1 : 1 - levenshtein(a, b) / n;
}

export interface SimilaritySpec {
  kind: "similarity";
  name?: string;
  /** Pass at or above this similarity. Default 0.8. */
  threshold?: number;
  value?: string;
  normalize?: NormalizeOpts;
}

export function similarityGrader(spec: Omit<SimilaritySpec, "kind"> = {}): Grader {
  const threshold = spec.threshold ?? 0.8;
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError("similarity threshold must be within [0, 1]");
  return makeGrader("similarity", spec, (ctx) => {
    const want = target(spec, ctx);
    if (want === undefined) return result(0, false, "no expected value to compare with");
    const sim = similarity(normalizeText(asText(ctx.output), spec.normalize), normalizeText(asText(want), spec.normalize));
    const pass = sim >= threshold;
    return result(sim, pass, `similarity ${sim.toFixed(3)} ${pass ? ">=" : "<"} ${threshold}`);
  });
}
