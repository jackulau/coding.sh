// Prefix executability: was each tool call valid to make at all, and where did
// a session make its first invalid one (First-Error Depth)?
//
// Prefix Executability (Rezaeian, Sun, Benajiba, Roth; arXiv 2610.40444 §2.1):
// an action is executable when its tool is exposed, its arguments match the
// schema, its preconditions hold and the values it references exist. FED is the
// 1-based step of the first call that is not, or T+1 when every call is.
//
// For a coding agent the raw `ok:false` flag is not that test: a test run that
// exits 1 executed, it just failed. So a call is one of
// - ok:      `ok` is not false;
// - failed:  it ran and did not succeed (a non-zero exit, an error with no
//            recognizable harness message, or no output at all);
// - invalid: the harness refused it before it ran, with a kind below.
// Deterministic: no judge, no gold trajectory. Pure, no I/O.
import { classifyToolStart } from "../toolevals/classify.ts";
import type { AgentEvent } from "../schema/index.ts";

/** Why a call was invalid. Checked in this order (the paper's precedence: schema > dependency > precondition > state > information). */
export const INVALID_KINDS = ["schema", "unknown-tool", "precondition", "state", "missing", "denied", "other"] as const;
export type InvalidKind = (typeof INVALID_KINDS)[number];

export interface CallClass {
  cls: "ok" | "failed" | "invalid";
  kind?: InvalidKind;
  /** The error's first line, up to 120 characters (failed and invalid calls with output). */
  detail?: string;
}

/** Only the start of the output is read: harness errors come first, and this keeps the pass cheap. */
const HEAD_BYTES = 2048;

// Claude Code wraps a refused call's message in <tool_use_error>…</tool_use_error>.
const CLAUDE_RULES: readonly [InvalidKind, RegExp][] = [
  ["schema", /InputValidationError|\brequired parameter\b|\bunexpected parameter\b/i],
  ["unknown-tool", /No such tool available/i],
  ["precondition", /has not been read yet|modified since (?:it was )?read/i],
  ["state", /String to replace not found|Found \d+ matches/i],
  ["missing", /File does not exist/i],
];

// A permission denial or a PreToolUse hook block: the call never ran.
const DENIED = /Permission to use \S+ (?:has been |was )?denied|PreToolUse:\S+ hook (?:error|blocked|returned blocking)|\bhook\b[^\n]{0,60}\b(?:blocked|denied)\b|\b(?:blocked|denied) by (?:a |the )?[\w:-]*\s*hook\b/i;

// Any agent. Schema and unknown-tool are not checked on shell output that has
// an exit code: the command ran, and its own output may say "validation error".
const UNKNOWN_TOOL = /\b(?:unknown|unsupported) tool\b|\bno such tool\b|\btool [`'"]?[\w./:-]+[`'"]? (?:is |was )?not found\b|not found in (?:the )?(?:tool )?registry/i;
const SCHEMA = /\b(?:invalid|failed to parse) (?:function |tool )?arguments\b|must have required property|\bvalidation error\b/i;
const PATCH_STATE = /apply_patch verification failed/i;
const NO_FILE = /No such file or directory/i;
const NOT_FOUND_CMD = /command not found/i;
const EXIT_CODE = /\bexit (?:code|status):?\s*(-?\d+)/i;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function textOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.slice(0, HEAD_BYTES);
  try {
    return (JSON.stringify(v) ?? "").slice(0, HEAD_BYTES);
  } catch {
    return "";
  }
}

function firstLine(text: string): string | undefined {
  const line = text
    .replace(/<\/?tool_use_error>/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l);
  if (!line) return undefined;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function exitCodeOf(end: AgentEvent, text: string): number | undefined {
  const v = end.payload.exitCode;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = EXIT_CODE.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * Classify one tool call from its start (when seen) and end. Reads the first
 * 2 KB of `end.payload.output` (or `error`). A call with ok:false and no output
 * is failed: hook-only captures often carry no output, so their invalid counts
 * are a lower bound.
 */
export function classifyToolCall(start: AgentEvent | undefined, end: AgentEvent): CallClass {
  if (end.payload.ok !== false) return { cls: "ok" };
  const text = textOf(end.payload.output ?? end.payload.error);
  const detail = firstLine(text);
  const invalid = (kind: InvalidKind): CallClass => (detail ? { cls: "invalid", kind, detail } : { cls: "invalid", kind });
  const failed: CallClass = detail ? { cls: "failed", detail } : { cls: "failed" };
  const probe = start ?? ({ ...end, payload: { tool: end.payload.tool, input: end.payload.input } } as AgentEvent);
  const category = classifyToolStart(probe).category;
  const shell = category === "shell";
  const code = shell ? exitCodeOf(end, text) : undefined;
  if (!text.trim()) return shell && code === 127 ? invalid("missing") : failed;

  if (text.includes("<tool_use_error>")) {
    for (const [kind, re] of CLAUDE_RULES) if (re.test(text)) return invalid(kind);
    if (DENIED.test(text)) return invalid("denied");
    return invalid("other");
  }
  if (DENIED.test(text)) return invalid("denied");
  if (shell) {
    if (code === 127 || NOT_FOUND_CMD.test(text)) return invalid("missing");
    if (code !== undefined) return failed; // it ran: a failing test, a build error
  }
  if (UNKNOWN_TOOL.test(text)) return invalid("unknown-tool");
  if (SCHEMA.test(text)) return invalid("schema");
  if (PATCH_STATE.test(text)) return invalid("state");
  if ((category === "read" || category === "edit") && NO_FILE.test(text)) return invalid("missing");
  return failed;
}

export interface Executability {
  /** Main-stream tool calls: no subagent's, no wrapper, no interrupted call. */
  steps: number;
  /** Invalid calls among them (of the counted kinds). */
  invalid: number;
  kinds: Partial<Record<InvalidKind, number>>;
  /** The first invalid call; `depth` is its 1-based step. */
  first?: { depth: number; eventId: string; tool: string; kind: InvalidKind; detail?: string };
}

interface Step {
  eventId: string;
  tool: string;
  start?: AgentEvent;
  cls?: CallClass;
  skip?: boolean;
}

/**
 * One pass over a session's time-sorted events. Steps are main-stream tool
 * calls (no `subagentId`) in tool.start order, paired with their end by
 * `toolUseId`; an end with no start is a step in end order. Wrapper calls
 * (`payload.wrapper`, which only run other calls) and interrupted calls are not
 * steps. `only` counts just those invalid kinds; calls of other kinds count as
 * valid.
 */
export function executability(sorted: readonly AgentEvent[], opts: { only?: readonly InvalidKind[] } = {}): Executability {
  const only = opts.only?.length ? new Set(opts.only) : undefined;
  const steps: Step[] = [];
  const byId = new Map<string, Step>();
  const wrappers = new Set<string>();
  for (const e of sorted) {
    if (e.kind !== "tool.start" && e.kind !== "tool.end") continue;
    if (e.subagentId) continue;
    const id = str(e.payload.toolUseId);
    if (e.payload.wrapper === true) {
      if (id) wrappers.add(id);
      continue;
    }
    if (id && wrappers.has(id)) continue;
    const tool = str(e.payload.tool) ?? "";
    if (e.kind === "tool.start") {
      if (id && byId.has(id)) continue; // the same call from a second capture path
      const s: Step = { eventId: e.id, tool, start: e };
      steps.push(s);
      if (id) byId.set(id, s);
      continue;
    }
    let s = id ? byId.get(id) : undefined;
    if (s?.cls) continue; // already ended
    if (!s) {
      s = { eventId: e.id, tool };
      steps.push(s);
      if (id) byId.set(id, s);
    }
    if (e.payload.interrupted === true) s.skip = true;
    s.cls = classifyToolCall(s.start, e);
  }
  const out: Executability = { steps: 0, invalid: 0, kinds: {} };
  for (const s of steps) {
    if (s.skip) continue;
    out.steps++;
    const c = s.cls;
    if (c?.cls !== "invalid" || !c.kind || (only && !only.has(c.kind))) continue;
    out.invalid++;
    out.kinds[c.kind] = (out.kinds[c.kind] ?? 0) + 1;
    if (!out.first) out.first = { depth: out.steps, eventId: s.eventId, tool: s.tool, kind: c.kind, ...(c.detail ? { detail: c.detail } : {}) };
  }
  return out;
}

/** First-Error Depth: the first invalid call's step, or steps + 1 when every call was executable (arXiv 2610.40444). */
export function fed(x: Executability): number {
  return x.first ? x.first.depth : x.steps + 1;
}

/**
 * The share of steps before the first invalid call, (FED-1)/T, or 1 with no
 * steps. Its mean over runs is AUC-PEC = E[(FED-1)/T]; the share of runs with
 * no invalid call (FED = T+1) is TER, the Total Executability Rate (arXiv
 * 2610.40444).
 */
export function aucPec(x: Executability): number {
  return x.steps ? (fed(x) - 1) / x.steps : 1;
}
