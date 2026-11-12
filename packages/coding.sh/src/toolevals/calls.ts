// The `calls` check (toolevals) and grader (exp): which tools a run called,
// with which arguments, how many times and in what order. Arguments match
// partially: only the keys a match names are compared, a key may be a dotted
// path (`where.agent`), a string that starts with `~` is a substring, and
// `<=N`, `>=N`, `<N`, `>N` bound a number. Pure: no I/O.
import type { AgentEvent } from "../schema/index.ts";
import { parseMcpToolName } from "./classify.ts";
import type { TapRecord } from "./types.ts";

export interface CallMatch {
  tool: string;
  args?: Record<string, unknown>;
}

export interface CallsSpec {
  /** Each must match at least one call. */
  must?: CallMatch[];
  /** None may match any call. */
  mustNot?: CallMatch[];
  /** At most this many calls. */
  max?: number;
  /** These tools are called in this order (other calls may come between). */
  order?: string[];
}

export interface ToolCall {
  /** The tool's name: an MCP tool without its `mcp__<server>__` prefix, a CLI subcommand path, `GET /path/{id}`. */
  tool: string;
  /** The name as the agent reported it, when it differs (`mcp__github__create_issue`). */
  alias?: string;
  /** Undefined when the source records no arguments (HTTP taps). */
  args?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with a calls spec, for config errors. Empty when it is usable. */
export function callsSpecProblems(s: Record<string, unknown>): string[] {
  const out: string[] = [];
  const matches = (k: "must" | "mustNot") => {
    const v = s[k];
    if (v === undefined) return;
    if (!Array.isArray(v)) return void out.push(`${k} must be a list of { tool, args }`);
    v.forEach((m, i) => {
      if (!isObj(m) || typeof m.tool !== "string" || !m.tool) out.push(`${k}[${i}] needs tool`);
      else if (m.args !== undefined && !isObj(m.args)) out.push(`${k}[${i}].args must be a table`);
    });
  };
  matches("must");
  matches("mustNot");
  if (s.max !== undefined && !(typeof s.max === "number" && Number.isInteger(s.max) && s.max >= 0)) out.push("max must be a whole number >= 0");
  if (s.order !== undefined && !(Array.isArray(s.order) && s.order.every((x) => typeof x === "string" && x))) out.push("order must be a list of tool names");
  if (s.must === undefined && s.mustNot === undefined && s.max === undefined && s.order === undefined) out.push("needs must, mustNot, max or order");
  return out;
}

/** The value at a dotted path, or at the literal key when the object has one with dots in it. */
function at(v: unknown, path: string): unknown {
  if (isObj(v) && path in v) return v[path];
  let cur = v;
  for (const k of path.split(".")) {
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)];
    else if (isObj(cur)) cur = cur[k];
    else return undefined;
  }
  return cur;
}

const text = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" ") : v === undefined ? "" : JSON.stringify(v));

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}

const BOUND = /^(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/;

/** Whether `got` satisfies `want` (see the file header). */
export function valueMatches(want: unknown, got: unknown): boolean {
  if (typeof want === "string") {
    if (want.startsWith("~")) return got !== undefined && text(got).includes(want.slice(1));
    const b = BOUND.exec(want);
    if (b) {
      const n = typeof got === "number" ? got : typeof got === "string" && got.trim() !== "" ? Number(got) : NaN;
      if (!Number.isFinite(n)) return false;
      const x = Number(b[2]);
      return b[1] === "<=" ? n <= x : b[1] === ">=" ? n >= x : b[1] === "<" ? n < x : n > x;
    }
  }
  if (isObj(want)) return isObj(got) && argsMatch(want, got);
  if (same(want, got)) return true;
  // A CLI flag's value is a string: `limit = 5` matches `--limit 5`.
  return typeof got === "string" && (typeof want === "number" || typeof want === "boolean") && String(want) === got;
}

export function argsMatch(want: Record<string, unknown>, got: Record<string, unknown> | undefined): boolean {
  if (!got) return false;
  return Object.entries(want).every(([k, w]) => valueMatches(w, at(got, k)));
}

const named = (m: CallMatch, c: ToolCall) => m.tool === c.tool || (c.alias !== undefined && m.tool === c.alias);
export const callMatches = (m: CallMatch, c: ToolCall): boolean => named(m, c) && (!m.args || argsMatch(m.args, c.args));

const describe = (m: CallMatch) => (m.args && Object.keys(m.args).length ? `${m.tool} with ${JSON.stringify(m.args)}` : m.tool);

/** Pass when every part of the spec holds; the detail names the first part that does not. */
export function checkCalls(spec: CallsSpec, calls: readonly ToolCall[]): { pass: boolean; detail?: string } {
  for (const m of spec.must ?? []) {
    if (calls.some((c) => callMatches(m, c))) continue;
    const byName = calls.filter((c) => named(m, c));
    const hint = !byName.length ? "" : m.args && byName.every((c) => !c.args) ? ` (calls to ${m.tool} carry no arguments here)` : ` (${byName.length} call${byName.length === 1 ? "" : "s"} to ${m.tool} with other arguments)`;
    return { pass: false, detail: `no call to ${describe(m)}${hint}` };
  }
  for (const m of spec.mustNot ?? []) {
    const i = calls.findIndex((c) => callMatches(m, c));
    if (i >= 0) return { pass: false, detail: `call ${i + 1} is ${describe(m)}, which mustNot forbids` };
  }
  if (spec.max !== undefined && calls.length > spec.max) return { pass: false, detail: `${calls.length} calls, max ${spec.max}` };
  if (spec.order?.length) {
    let from = 0;
    for (let k = 0; k < spec.order.length; k++) {
      const want = spec.order[k]!;
      const i = calls.findIndex((c, j) => j >= from && named({ tool: want }, c));
      if (i < 0) return { pass: false, detail: k === 0 ? `order: no call to ${want}` : `order: no call to ${want} after ${spec.order[k - 1]}` };
      from = i + 1;
    }
  }
  return { pass: true };
}

/**
 * `--name value`, `--name=value` and a bare `--flag` (true) after the
 * subcommand words; `argv` keeps the whole list. A flag given twice keeps its
 * last value.
 */
export function cliArgs(argv: readonly string[]): { tool: string; args: Record<string, unknown> } {
  let i = 0;
  const lead: string[] = [];
  for (; i < argv.length && !argv[i]!.startsWith("-"); i++) lead.push(argv[i]!);
  const args: Record<string, unknown> = { argv: [...argv] };
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    const m = /^--?([^=]+)(?:=(.*))?$/s.exec(a);
    if (!m || a === "--" || a === "-") continue;
    if (m[2] !== undefined) args[m[1]!] = m[2];
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) args[m[1]!] = argv[++i];
    else args[m[1]!] = true;
  }
  return { tool: lead.join(" "), args };
}

/**
 * A tool-eval trial's target calls, in order, from its tap (meta calls such as
 * MCP initialize left out). `bin`: a CLI target's name, which names a call
 * with no subcommand (`greet --name Ada` is tool `greet`).
 */
export function callsFromTap(tap: readonly TapRecord[], bin?: string): ToolCall[] {
  return [...tap]
    .filter((r) => r.class !== "meta")
    .sort((a, b) => a.ts - b.ts)
    .map((r): ToolCall => {
      if (r.target === "cli") {
        const c = cliArgs(r.argv ?? []);
        return c.tool === "" && bin ? { ...c, tool: bin } : c;
      }
      if (r.target === "mcp") return { tool: r.tool ?? r.method ?? "", ...(isObj(r.args) ? { args: r.args } : {}) };
      return { tool: `${r.httpMethod ?? ""} ${r.pathTemplate ?? ""}`.trim() };
    });
}

/** Every tool call in a trace (tool.start events, in time order), MCP tools under their own name. */
export function callsFromEvents(events: readonly Pick<AgentEvent, "kind" | "ts" | "payload">[]): ToolCall[] {
  return events
    .filter((e) => e.kind === "tool.start" && typeof e.payload?.tool === "string")
    .sort((a, b) => a.ts - b.ts)
    .map((e) => {
      const raw = e.payload.tool as string;
      const mcp = parseMcpToolName(raw);
      const input = e.payload.input;
      return { tool: mcp?.tool ?? raw, ...(mcp ? { alias: raw } : {}), ...(isObj(input) ? { args: input } : {}) };
    });
}
