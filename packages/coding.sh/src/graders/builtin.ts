// Deterministic built-in graders. Each is built from a plain, serializable
// spec, and its version is a hash of that spec, so a result always says
// exactly which grading rule produced it.
import { canonicalJson, deepEqual, shortHash } from "../datasets/hash.ts";
import type { GradeContext, GradeResult, Grader } from "../datasets/types.ts";
import { maybeJson } from "../judge/extract.ts";
import { formatSchemaErrors, validateJsonSchema, type JsonSchema } from "./json-schema.ts";
import { queryJsonPath } from "./json-path.ts";
import { detectDerails, DERAIL_FLAG_LIST, progressMetrics } from "../core/derail.ts";
import { aucPec, executability, INVALID_KINDS, type InvalidKind } from "../core/executability.ts";
import type { AgentEvent } from "../schema/index.ts";
import { callsFromEvents, callsSpecProblems, checkCalls, type CallsSpec } from "../toolevals/calls.ts";
import { looksLikeDiff, selectSlopRules, slopFindings, slopScore, slopSummary, traceDiffs } from "./slop.ts";

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

// ---------------------------------------------------------------- objective

export interface ObjectiveSpec<G = unknown> {
  kind: "objective";
  name?: string;
  /** JSON path to the measured quantity J in the output. Default: the whole output, read with toNumber. */
  path?: string;
  /** Anchor that scores 0 (a baseline). Frozen: change it and the grader version changes. */
  base: number;
  /** Anchor that scores 1 (a reference). Lower is better when ref < base. */
  ref: number;
  /** When the anchors were measured (e.g. "2026-11-14"). Named in every reason. */
  anchoredAt: string;
  /** "log" (default): ratio on a log scale, for positive quantities. "linear": for quantities with no natural zero. */
  scale?: "log" | "linear";
  /** Upper bound of the score, at least 1 (the pass mark). Default 3. 1 keeps the score in 0..1 like every other grader. */
  clip?: number;
  /** A grader that must pass first; when it fails the score is 0. A GraderSpec in a config, a Grader in code. */
  gate?: G;
}

export const OBJECTIVE_DEFAULT_CLIP = 3;

/** Objective score (arXiv 2611.13541): clip(max(0, log(J/base) / log(ref/base)), 0, clip). Not capped at 1, so pass is score >= 1. */
export function objectiveGrader(spec: Omit<ObjectiveSpec<Grader>, "kind">): Grader {
  const scale = spec.scale ?? "log";
  const clip = spec.clip ?? OBJECTIVE_DEFAULT_CLIP;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!finite(spec.base) || !finite(spec.ref)) throw new Error("objective: base and ref must be finite numbers");
  if (spec.base === spec.ref) throw new Error("objective: base and ref must differ");
  if (scale !== "log" && scale !== "linear") throw new Error(`objective: scale must be "log" or "linear" (got ${JSON.stringify(spec.scale)})`);
  if (scale === "log" && (spec.base <= 0 || spec.ref <= 0)) throw new Error("objective: base and ref must be greater than 0 on the log scale (use scale \"linear\" otherwise)");
  if (typeof spec.anchoredAt !== "string" || !spec.anchoredAt.trim()) throw new Error("objective: anchoredAt (the date the anchors were measured) is required");
  // Pass is score >= 1, so a clip below 1 could never pass.
  if (!finite(clip) || clip < 1) throw new Error("objective: clip must be a number of at least 1 (the score that passes)");
  if (spec.path) queryJsonPath(null, spec.path); // validate syntax eagerly
  const { gate, ...frozen } = spec;
  const hashed: { name?: string; [k: string]: unknown } = { ...frozen };
  if (gate) hashed.gate = { kind: gate.kind, version: gate.version };
  const g = makeGrader("objective", hashed, async (ctx): Promise<GradeResult> => {
    if (gate) {
      const gr = await gate.grade(ctx);
      if (!gr.pass) return { score: 0, pass: false, reason: `gate ${gate.id} failed${gr.reason ? `: ${gr.reason}` : ""}` };
    }
    const raw = spec.path ? selection(ctx.output, spec.path) : ctx.output;
    const j = toNumber(raw);
    if (j === undefined) return { score: 0, pass: false, reason: spec.path ? `${spec.path} ${raw === undefined ? "not found" : `has no number (${short(raw)})`} in output` : `output ${short(raw)} has no number` };
    const anchors = `base ${spec.base}, ref ${spec.ref}, anchored ${spec.anchoredAt}`;
    if (scale === "log" && j <= 0) return { score: 0, pass: false, reason: `J=${j} is not above 0, so the log scale has no score (${anchors})` };
    const x = scale === "log" ? Math.log(j / spec.base) / Math.log(spec.ref / spec.base) : (j - spec.base) / (spec.ref - spec.base);
    const floored = Math.max(0, x);
    const clipped = floored > clip;
    const score = clipped ? clip : floored;
    const bound = clipped ? `clipped at ${clip} (unclipped ${floored.toFixed(3)})` : floored === 0 && x < 0 ? "floored at 0" : "within the clip";
    return { score, pass: score >= 1, reason: `J=${j} on the ${scale} scale: score ${score.toFixed(3)} (${anchors}; ${bound})` };
  });
  return g;
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

// ---------------------------------------------------------------- progress

export interface ProgressSpec {
  kind: "progress";
  name?: string;
  /** Count only these derail flags (looping, failure-streak, churn, no-progress, stalled, context-thrash). Default all. */
  flags?: string[];
  /** Pass with at most this many derails. Default 0. */
  maxDerails?: number;
}

/**
 * How long the agent stayed on track, from the run's trace: score = time to the
 * first derail / wall time (1 when it never derailed), pass when it derailed at
 * most maxDerails times. Graded on the trace, so `exp compare` compares it like
 * any other grader.
 */
export function progressGrader(spec: Omit<ProgressSpec, "kind"> = {}): Grader {
  const max = spec.maxDerails ?? 0;
  if (!(Number.isInteger(max) && max >= 0)) throw new RangeError("progress maxDerails must be a whole number >= 0");
  const only = spec.flags?.length ? new Set(spec.flags) : undefined;
  for (const f of only ?? []) if (!(DERAIL_FLAG_LIST as readonly string[]).includes(f)) throw new RangeError(`unknown derail flag ${JSON.stringify(f)} (expected ${DERAIL_FLAG_LIST.join(", ")})`);
  return makeGrader("progress", spec, (ctx) => {
    const events = (ctx.trace ?? []).filter((e) => typeof e.ts === "number") as unknown as AgentEvent[];
    if (!events.length) return result(0, false, "no timed trace to measure progress on");
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    const derails = detectDerails(sorted).filter((d) => !only || only.has(d.flag));
    const p = progressMetrics(derails, sorted[0]!.ts, sorted.at(-1)!.ts);
    const first = derails[0];
    const why = first
      ? `${p.derails} derail${p.derails === 1 ? "" : "s"}; first ${first.flag} at ${Math.round(p.timeToFirstDerailMs / 1000)}s (${Math.round(p.onTrack * 100)}% of the run on track): ${first.detail}`
      : "no derails";
    return result(p.onTrack, p.derails <= max, why);
  });
}

// ---------------------------------------------------------------- executability

export interface ExecutabilitySpec {
  kind: "executability";
  name?: string;
  /** Count only these invalid-call kinds (schema, unknown-tool, precondition, state, missing, denied, other). Default all. */
  kinds?: readonly InvalidKind[];
  /** Pass with at most this many invalid calls. Default 0. */
  maxInvalid?: number;
}

/**
 * How far the agent got before its first invalid tool call, from the run's
 * trace (arXiv 2610.40444): score = (FED-1)/T, the share of steps before the
 * first call the harness refused (1 when none was), so the mean score over runs
 * is AUC-PEC. Pass when at most maxInvalid calls were invalid, so the pass rate
 * with the default 0 is TER. A call that ran and failed (a test exiting 1) is
 * not invalid.
 */
export function executabilityGrader(spec: Omit<ExecutabilitySpec, "kind"> = {}): Grader {
  const max = spec.maxInvalid ?? 0;
  if (!(Number.isInteger(max) && max >= 0)) throw new RangeError("executability maxInvalid must be a whole number >= 0");
  if (spec.kinds !== undefined && !Array.isArray(spec.kinds)) throw new RangeError(`executability kinds must be a list of ${INVALID_KINDS.join(", ")}`);
  for (const k of spec.kinds ?? []) if (!(INVALID_KINDS as readonly string[]).includes(k)) throw new RangeError(`unknown invalid-call kind ${JSON.stringify(k)} (expected ${INVALID_KINDS.join(", ")})`);
  return makeGrader("executability", spec, (ctx) => {
    const events = (ctx.trace ?? []).filter((e) => typeof e.ts === "number") as unknown as AgentEvent[];
    if (!events.length) return result(0, false, "no timed trace to check tool calls on");
    const sorted = [...events].sort((a, b) => a.ts - b.ts);
    const x = executability(sorted, { only: spec.kinds });
    if (!x.steps) return result(1, true, "no tool calls");
    const first = x.first;
    let why = first
      ? `first invalid call at step ${first.depth} of ${x.steps}: ${first.tool || "tool"} (${first.kind})${first.detail ? `: ${first.detail}` : ""}`
      : `all ${x.steps} tool call${x.steps === 1 ? "" : "s"} executable`;
    if (why.length > 160) why = `${why.slice(0, 159)}…`;
    return result(aucPec(x), x.invalid <= max, why);
  });
}

// ---------------------------------------------------------------- calls

export interface CallsGraderSpec extends CallsSpec {
  kind: "calls";
  name?: string;
}

/**
 * The tools the task's trace called (tool.start events): must, mustNot, max
 * and order, with partial argument matches (src/toolevals/calls.ts). MCP
 * tools match by their own name or the agent's (`mcp__github__create_issue`).
 */
export function callsGrader(spec: Omit<CallsGraderSpec, "kind">): Grader {
  const { name: _n, ...rest } = spec;
  const problems = callsSpecProblems(rest as Record<string, unknown>);
  if (problems.length) throw new RangeError(`calls grader ${problems.join("; ")}`);
  return makeGrader("calls", spec, (ctx) => {
    const events = (ctx.trace ?? []).filter((e) => typeof e.ts === "number") as unknown as AgentEvent[];
    if (!events.length) return result(0, false, "no timed trace to check tool calls on");
    const calls = callsFromEvents(events);
    const r = checkCalls(rest, calls);
    return result(r.pass ? 1 : 0, r.pass, r.detail ?? `${calls.length} call${calls.length === 1 ? "" : "s"} as expected`);
  });
}

// ---------------------------------------------------------------- agent slop

export interface AgentSlopSpec {
  kind: "agent-slop";
  name?: string;
  /** Rule ids to run instead of the default set; "default" and "all" stand for those sets. */
  rules?: string[];
  /** Rule ids to leave out. */
  exclude?: string[];
  /** Pass with at most this many error findings. Default 0. */
  maxErrors?: number;
  /** Pass with at most this many warnings. Default: no limit. */
  maxWarnings?: number;
}

/** Where agent-slop finds the agent's diff: ctx.diff, else an output that is a unified diff, else the trace's file.change diffs. */
export async function gradedDiffs(ctx: GradeContext): Promise<{ source: "diff" | "output" | "trace"; patches: string[] } | undefined> {
  if (typeof ctx.diff === "string") return { source: "diff", patches: [ctx.diff] };
  if (typeof ctx.output === "string" && looksLikeDiff(ctx.output)) return { source: "output", patches: [ctx.output] };
  const t = await traceDiffs(ctx.trace ?? []);
  return t.patches.length ? { source: "trace", patches: t.patches } : undefined;
}

/**
 * Anti-slop rules (src/graders/slop.ts) over the lines the agent's diff adds:
 * pass with at most maxErrors error findings (and maxWarnings warnings, when
 * set); score from findings per 100 added lines (see slopScore).
 */
export function agentSlopGrader(spec: Omit<AgentSlopSpec, "kind"> = {}): Grader {
  const rules = selectSlopRules(spec.rules, spec.exclude);
  for (const [k, v] of [["maxErrors", spec.maxErrors], ["maxWarnings", spec.maxWarnings]] as const) {
    if (v !== undefined && !(Number.isInteger(v) && v >= 0)) throw new RangeError(`agent-slop ${k} must be a whole number >= 0`);
  }
  return makeGrader("agent-slop", spec, async (ctx) => {
    const found = await gradedDiffs(ctx);
    if (!found) return result(0, false, "no diff to grade: the output is not a unified diff and the trace has no file.change diffs");
    const r = slopFindings(found.patches, rules);
    const s = slopScore(r, { ...(spec.maxErrors !== undefined ? { maxErrors: spec.maxErrors } : {}), ...(spec.maxWarnings !== undefined ? { maxWarnings: spec.maxWarnings } : {}) });
    return result(s.score, s.pass, `${slopSummary(r)} (from the ${found.source})`);
  });
}
