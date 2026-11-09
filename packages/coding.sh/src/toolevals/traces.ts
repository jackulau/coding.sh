// `toolevals traces` (AA-21): an MCP server's trajectories and per-tool health,
// from tool-eval trials (`--from <experiment>`) and captured agent sessions
// (`--sessions '<filter>'`). AT-AT and τ²-bench showed that an improver works
// better with the full failing traces in hand: so the workspace holds one
// markdown file per trace (failing first, at most `passingCap` passing), an
// index.jsonl, tool-health.json (calls, errors, error rate, repeats, retries
// after an error, never-called tools, median result size, sample failures) and
// tools.json. Held-out trials are never exported.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRedactor } from "../core/redact.ts";
import type { BlobStore, IndexStore, Session } from "../core/types.ts";
import { sessionMarkdown } from "../mcp/digest.ts";
import { findSessions } from "../query/run.ts";
import { parseWhere } from "../query/where.ts";
import type { AgentEvent } from "../schema/index.ts";
import { parseMcpToolName } from "./classify.ts";
import { loadTrialTrace } from "./experiment.ts";
import { armKey } from "./types.ts";
import type { McpTool, TapRecord, TrialResult } from "./types.ts";

export const RETRY_WINDOW = 3;
const SAMPLE_FAILURES = 3;
const SAMPLE_TEXT = 300;

/** One call to a tool of the server, from a tap record (trials) or a tool.start/tool.end pair (sessions). */
export interface TargetCall {
  tool: string;
  ok: boolean;
  /** invalid / failed / ok (trials: the tap class; sessions: from the error text). */
  class: string;
  reason?: string;
  args?: unknown;
  resultBytes?: number;
  error?: string;
}

export interface ToolHealth {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number | null;
  invalidKinds: Record<string, number>;
  /** Calls with the same tool and arguments as an earlier call in the same trace. */
  repeatedIdenticalCalls: number;
  /** Error runs (back-to-back failures of the tool) followed by a successful call of it within 3 calls. */
  retriedAfterError: number;
  neverCalled: boolean;
  medianResultBytes: number | null;
  sampleFailures: { trace: string; args?: unknown; error?: string }[];
}

export interface TraceEntry {
  id: string;
  source: "trial" | "session";
  taskId?: string;
  sessionId?: string;
  agent: string;
  outcome: "pass" | "fail" | "ok" | "failed";
  reward?: number;
  targetCalls: number;
  targetErrors: number;
  bytes: number;
}

export interface TraceWorkspace {
  server: string;
  traces: (TraceEntry & { markdown: string })[];
  health: ToolHealth[];
  tools?: McpTool[];
  /** Traces matched before the failing-first and passing caps. */
  matched: number;
  notes: string[];
}

export interface TraceExperiment {
  id: string;
  meta: Record<string, unknown>;
  trials: TrialResult[];
}

export interface TraceOpts {
  index: IndexStore;
  blobs?: BlobStore;
  /** MCP server name, as in `mcp__<server>__<tool>`. */
  server: string;
  /** Trials of a tool-eval experiment (dev split only). */
  experiment?: TraceExperiment;
  /** Only this arm's trials (`<variant>@<driver>`). */
  arm?: string;
  /** Query-language filter over captured sessions (`since:30d agent:claude-code`). */
  sessions?: string;
  /** The server's tools (with the variant's overrides), for neverCalled and tools.json. */
  tools?: McpTool[];
  maxTraces?: number;
  passingCap?: number;
  now?: number;
}

export class TraceError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "TraceError";
    this.reason = reason;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** A session's error text, sorted into the tap's invalid kinds where it says so. */
export function errorClass(text: string): { class: "invalid" | "failed"; reason: string } {
  if (/unknown tool|tool .*not found|no such tool/i.test(text)) return { class: "invalid", reason: "unknown-tool" };
  if (/invalid (argument|arguments|params|parameters|input)|validation (error|failed)|required (property|parameter|field|argument)|unknown (argument|parameter|property)|expected .+ received|-32602/i.test(text)) return { class: "invalid", reason: "schema" };
  if (/timed? ?out|timeout/i.test(text)) return { class: "failed", reason: "timeout" };
  if (/permission|denied|unauthori[sz]ed|forbidden|\b40[13]\b/i.test(text)) return { class: "failed", reason: "denied" };
  return { class: "failed", reason: "tool-error" };
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("\n");
  if (isObj(v) && typeof v.text === "string") return v.text;
  return v === undefined ? "" : JSON.stringify(v);
}

/** The server's calls in a captured session, in order. */
export function sessionCalls(events: readonly AgentEvent[], server: string): TargetCall[] {
  const ends = new Map<string, AgentEvent>();
  for (const e of events) if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") ends.set(`${e.sessionId}#${e.payload.toolUseId}`, e);
  const out: TargetCall[] = [];
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.kind !== "tool.start" || typeof e.payload.tool !== "string") continue;
    const named = parseMcpToolName(e.payload.tool, typeof e.payload.server === "string" ? e.payload.server : undefined);
    if (!named || named.server !== server) continue;
    const end = typeof e.payload.toolUseId === "string" ? ends.get(`${e.sessionId}#${e.payload.toolUseId}`) : undefined;
    const ok = end ? end.payload.ok !== false && !end.payload.error : true;
    const errText = ok ? "" : textOf(end?.payload.error ?? end?.payload.output);
    const cls = ok ? { class: "ok", reason: undefined } : errorClass(errText);
    const bytes = typeof end?.payload.outputBytes === "number" ? end.payload.outputBytes : typeof end?.payload.output === "string" ? Buffer.byteLength(end.payload.output, "utf8") : undefined;
    out.push({ tool: named.tool, ok, class: cls.class, ...(cls.reason ? { reason: cls.reason } : {}), ...(e.payload.input !== undefined ? { args: e.payload.input } : {}), ...(bytes !== undefined ? { resultBytes: bytes } : {}), ...(errText ? { error: errText.slice(0, SAMPLE_TEXT) } : {}) });
  }
  return out;
}

/** The target's calls in a trial, from its tap (MCP initialize, tools/list… left out). */
export function tapCalls(tap: readonly TapRecord[]): TargetCall[] {
  return [...tap]
    .filter((r) => r.class !== "meta")
    .sort((a, b) => a.ts - b.ts)
    .map((r) => {
      const ok = r.class === "ok" || r.class === "help";
      const tool = r.tool ?? r.method ?? (r.argv ? r.argv.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ") : `${r.httpMethod ?? ""} ${r.pathTemplate ?? ""}`.trim());
      const err = ok ? undefined : [r.reason, r.rpcErrorCode !== undefined ? `rpc ${r.rpcErrorCode}` : "", r.stderrHead ?? "", r.schemaViolations?.join("; ") ?? ""].filter(Boolean).join(" · ");
      return { tool, ok, class: r.class, ...(r.reason ? { reason: r.reason } : {}), ...(r.args ? { args: r.args } : r.argv ? { args: r.argv } : {}), ...(r.responseBytes !== undefined ? { resultBytes: r.responseBytes } : r.stdoutBytes !== undefined ? { resultBytes: r.stdoutBytes } : {}), ...(err ? { error: err.slice(0, SAMPLE_TEXT) } : {}) };
    });
}

interface Acc {
  calls: number;
  errors: number;
  invalidKinds: Record<string, number>;
  repeats: number;
  retried: number;
  bytes: number[];
  samples: ToolHealth["sampleFailures"];
}

/** Adds one trace's calls to the per-tool tallies. */
function tally(acc: Map<string, Acc>, trace: string, calls: readonly TargetCall[]): void {
  const get = (t: string) => {
    let a = acc.get(t);
    if (!a) acc.set(t, (a = { calls: 0, errors: 0, invalidKinds: {}, repeats: 0, retried: 0, bytes: [], samples: [] }));
    return a;
  };
  const seen = new Set<string>();
  // Per tool: index of the last error of the current error run, if any.
  const lastErr = new Map<string, number>();
  calls.forEach((c, i) => {
    const a = get(c.tool);
    a.calls++;
    if (c.resultBytes !== undefined) a.bytes.push(c.resultBytes);
    const key = `${c.tool}\u0000${JSON.stringify(c.args ?? null)}`;
    if (seen.has(key)) a.repeats++;
    seen.add(key);
    const prev = lastErr.get(c.tool);
    const inRun = prev !== undefined && i - prev <= RETRY_WINDOW;
    if (!c.ok) {
      a.errors++;
      if (c.class === "invalid") a.invalidKinds[c.reason ?? "other"] = (a.invalidKinds[c.reason ?? "other"] ?? 0) + 1;
      if (a.samples.length < SAMPLE_FAILURES) a.samples.push({ trace, ...(c.args !== undefined ? { args: c.args } : {}), ...(c.error ? { error: c.error } : {}) });
      lastErr.set(c.tool, i);
    } else {
      if (inRun) a.retried++;
      lastErr.delete(c.tool);
    }
  });
}

function healthOf(acc: Map<string, Acc>, tools: readonly McpTool[] | undefined): ToolHealth[] {
  const names = new Set([...acc.keys(), ...(tools ?? []).map((t) => t.name)]);
  return [...names]
    .map((tool): ToolHealth => {
      const a = acc.get(tool);
      return {
        tool,
        calls: a?.calls ?? 0,
        errors: a?.errors ?? 0,
        errorRate: a?.calls ? a.errors / a.calls : null,
        invalidKinds: a?.invalidKinds ?? {},
        repeatedIdenticalCalls: a?.repeats ?? 0,
        retriedAfterError: a?.retried ?? 0,
        neverCalled: !a?.calls,
        medianResultBytes: median(a?.bytes ?? []),
        sampleFailures: a?.samples ?? [],
      };
    })
    .sort((x, y) => y.errors - x.errors || y.calls - x.calls || x.tool.localeCompare(y.tool));
}

function targetSection(calls: readonly TargetCall[]): string[] {
  const lines = ["", "## Target calls", ""];
  if (!calls.length) lines.push("_None._");
  calls.forEach((c, i) => {
    const args = c.args === undefined ? "" : ` args=${JSON.stringify(c.args).slice(0, 200)}`;
    lines.push(`${i + 1}. [TARGET tool=${c.tool} ok=${c.ok} class=${c.class}${c.reason ? ` reason=${c.reason}` : ""}]${args}${c.error ? ` error=${JSON.stringify(c.error)}` : ""}`);
  });
  return lines;
}

function header(e: TraceEntry): string[] {
  return [
    `<!-- trace ${e.id} -->`,
    `- **Trace:** ${e.id}`,
    `- **Source:** ${e.source}${e.taskId ? ` · task ${e.taskId}` : ""}${e.sessionId ? ` · session ${e.sessionId}` : ""}`,
    `- **Agent:** ${e.agent}`,
    `- **Outcome:** ${e.outcome}${e.reward !== undefined ? ` · reward ${e.reward.toFixed(2)}` : ""}`,
    `- **Target calls:** ${e.targetCalls} (${e.targetErrors} failed)`,
    "",
  ];
}

async function readTapBlob(blobs: BlobStore | undefined, t: TrialResult): Promise<TapRecord[]> {
  if (!blobs || !t.tapBlob) return [];
  const text = await blobs.getText(t.tapBlob).catch(() => undefined);
  if (!text) return [];
  return text.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l) as TapRecord];
    } catch {
      return [];
    }
  });
}

const FAILING = new Set(["fail", "failed"]);

export async function buildTraceWorkspace(o: TraceOpts): Promise<TraceWorkspace> {
  const maxTraces = o.maxTraces ?? 200;
  const passingCap = o.passingCap ?? 3;
  const notes: string[] = [];
  const acc = new Map<string, Acc>();
  const all: (TraceEntry & { markdown: string })[] = [];
  const redactor = createRedactor();
  const add = (e: TraceEntry, body: string, calls: TargetCall[]) => {
    const markdown = [...header(e), body.trimEnd(), ...targetSection(calls), ""].join("\n");
    // A secret the store kept unredacted (older capture, redaction off): never copy it out.
    if (redactor.string(markdown) !== markdown) {
      notes.push(`skipped ${e.id}: it holds an unredacted secret`);
      return;
    }
    tally(acc, e.id, calls);
    all.push({ ...e, bytes: Buffer.byteLength(markdown, "utf8"), markdown });
  };

  if (o.experiment) {
    const split = new Map<string, string>();
    for (const t of Array.isArray(o.experiment.meta.tasks) ? (o.experiment.meta.tasks as { id?: string; split?: string }[]) : []) if (t.id) split.set(t.id, t.split ?? "dev");
    let trials = o.experiment.trials;
    if (o.arm) {
      trials = trials.filter((t) => armKey(t.variant, t.driver) === o.arm);
      if (!trials.length) throw new TraceError(`experiment ${o.experiment.id} has no trials in arm ${o.arm}`, "not_found");
    }
    const dev = trials.filter((t) => split.get(t.taskId) !== "heldout");
    if (trials.length && !dev.length) throw new TraceError(`experiment ${o.experiment.id}${o.arm ? ` arm ${o.arm}` : ""} has only held-out trials; held-out tasks are never exported`, "heldout_only");
    if (dev.length < trials.length) notes.push(`left out ${trials.length - dev.length} held-out trial(s)`);
    for (const t of [...dev].sort((a, b) => a.id.localeCompare(b.id))) {
      const tap = await readTapBlob(o.blobs, t);
      const calls = tapCalls(tap);
      const trace = await loadTrialTrace(o.index, t.id, t.sessionId);
      const root = trace.sessions[0];
      const bodies: string[] = [];
      for (const s of trace.sessions) bodies.push(await sessionMarkdown(o.index, s, 120, o.now));
      const checks = t.checks.map((c) => `- ${c.pass ? "pass" : "FAIL"} ${c.kind}${c.detail ? `: ${c.detail}` : ""}`);
      const body = [...(bodies.length ? bodies : ["_No captured session._\n"]), "## Checks", "", ...(checks.length ? checks : ["_None ran._"]), ...(t.error ? ["", `Error: ${t.error}`] : [])].join("\n");
      add(
        {
          id: `trial-${t.id}`,
          source: "trial",
          taskId: t.taskId,
          ...(t.sessionId ?? root?.id ? { sessionId: t.sessionId ?? root!.id } : {}),
          agent: root?.agent ?? t.driver,
          outcome: t.pass ? "pass" : "fail",
          reward: t.checks.length ? t.checks.filter((c) => c.pass).length / t.checks.length : 0,
          targetCalls: calls.length,
          targetErrors: calls.filter((c) => !c.ok).length,
          bytes: 0,
        },
        body,
        calls,
      );
    }
  }

  if (o.sessions !== undefined) {
    const q = parseWhere(o.sessions, { now: o.now ?? Date.now() });
    // Organic sessions only: trial sessions come in through --from with their checks.
    const { sessions, truncated } = await findSessions(o.index, q, { filter: { runId: null } });
    if (truncated) notes.push("the session scan stopped at its cap; narrow the filter");
    for (const s of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
      const events = await o.index.listEvents(s.id);
      const calls = sessionCalls(events, o.server);
      if (!calls.length) continue;
      const failed = s.flags.some((f) => !f.includes(":")) || calls.some((c) => !c.ok);
      add(
        { id: `session-${s.id}`, source: "session", sessionId: s.id, agent: s.agent, outcome: failed ? "failed" : "ok", targetCalls: calls.length, targetErrors: calls.filter((c) => !c.ok).length, bytes: 0 },
        await sessionMarkdown(o.index, s as Session, 120, o.now),
        calls,
      );
    }
  }

  // Failing first, then at most passingCap passing; deterministic order inside each group.
  const failing = all.filter((e) => FAILING.has(e.outcome)).sort((a, b) => a.id.localeCompare(b.id));
  const passing = all.filter((e) => !FAILING.has(e.outcome)).sort((a, b) => a.id.localeCompare(b.id));
  const traces = [...failing, ...passing.slice(0, passingCap)].slice(0, maxTraces);
  if (passing.length > passingCap) notes.push(`kept ${passingCap} of ${passing.length} passing traces`);
  if (failing.length + Math.min(passing.length, passingCap) > maxTraces) notes.push(`kept the first ${maxTraces} traces`);
  return { server: o.server, traces, health: healthOf(acc, o.tools), ...(o.tools ? { tools: o.tools } : {}), matched: all.length, notes };
}

/** Writes traces/<id>.md, index.jsonl, tool-health.json and tools.json under `dir` (replacing an earlier export there). */
export async function writeTraceWorkspace(ws: TraceWorkspace, dir: string): Promise<void> {
  await rm(join(dir, "traces"), { recursive: true, force: true });
  await mkdir(join(dir, "traces"), { recursive: true });
  for (const t of ws.traces) await writeFile(join(dir, "traces", `${t.id}.md`), t.markdown);
  const index = ws.traces.map(({ markdown: _m, ...e }) => JSON.stringify(e)).join("\n");
  await writeFile(join(dir, "index.jsonl"), index ? `${index}\n` : "");
  await writeFile(join(dir, "tool-health.json"), JSON.stringify({ server: ws.server, tools: ws.health }, null, 2) + "\n");
  await writeFile(join(dir, "tools.json"), JSON.stringify(ws.tools ?? [], null, 2) + "\n");
}

/** Plain-text table, most errors first. */
export function formatHealth(ws: TraceWorkspace): string {
  const rows = [["tool", "calls", "errors", "error%", "repeats", "retried-after-error"]];
  for (const h of ws.health) rows.push([h.tool + (h.neverCalled ? " (never called)" : ""), String(h.calls), String(h.errors), h.errorRate === null ? "—" : `${(h.errorRate * 100).toFixed(1)}%`, String(h.repeatedIdenticalCalls), String(h.retriedAfterError)]);
  const w = rows.reduce<number[]>((acc, r) => r.map((c, i) => Math.max(acc[i] ?? 0, c.length + 2)), []);
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("").trimEnd());
  const failing = ws.traces.filter((t) => FAILING.has(t.outcome)).length;
  lines.push("", `${ws.traces.length} trace(s) of ${ws.matched} matched · ${failing} failing`);
  for (const t of ws.traces.filter((x) => FAILING.has(x.outcome)).slice(0, 10)) lines.push(`  ${t.outcome.padEnd(6)} ${t.id}  ${t.targetErrors}/${t.targetCalls} target calls failed`);
  return lines.join("\n") + "\n";
}
