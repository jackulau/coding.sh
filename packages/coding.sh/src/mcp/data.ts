// Read-side queries behind the MCP tools: small, model-sized summaries over
// the index (never raw event dumps). Pure functions of an IndexStore so they
// test against the memory store.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentEvent, IndexStore, Session, SessionFilter } from "../core/types.ts";
import { failureFlags, percentile } from "../core/sessions.ts";
import { sessionMatcher } from "../query/run.ts";
import type { Node, Query } from "../query/where.ts";

type Obj = Record<string, unknown>;

/** Sessions read per aggregate query, newest first. Reported as `truncated` when hit. */
export const SCAN_CAP = 2000;
/** Sessions whose events an event-level aggregate (latency, failures) reads. */
export const EVENT_SCAN_CAP = 300;

// ------------------------------------------------------------ formatting

/** Whitespace-folded, cut to n chars. */
export function clip(s: unknown, n = 160): string | undefined {
  if (typeof s !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export const iso = (ms: number | undefined): string | undefined => (ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString());

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Local calendar day (YYYY-MM-DD) of an instant, in the server's time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ------------------------------------------------------------ session summary

export interface SessionSummary extends Obj {
  id: string;
  agent: string;
}

/**
 * A session with no session.end and no activity for this long is reported as
 * not running. Backfilled transcripts never get a session.end, so endedAt alone
 * would call every one of them running forever.
 */
export const IDLE_MS = 30 * 60e3;

/** End of the last event seen: endedAt when known, else startedAt + wall time. */
export function lastActivity(s: Session): number {
  if (s.endedAt !== undefined) return s.endedAt;
  const wall = s.stats.latency?.wallMs;
  return typeof wall === "number" && Number.isFinite(wall) ? s.startedAt + wall : s.startedAt;
}

/** No end seen and active within IDLE_MS of `now`. */
export function isRunning(s: Session, now: number): boolean {
  return s.endedAt === undefined && now - lastActivity(s) < IDLE_MS;
}

export function sessionSummary(s: Session, now: number = Date.now()): SessionSummary {
  const u = s.stats.usage;
  return {
    id: s.id,
    agent: s.agent,
    title: clip(s.title, 120),
    model: s.model,
    repo: s.repo?.root,
    branch: s.repo?.branch,
    cwd: s.cwd && s.cwd !== s.repo?.root ? s.cwd : undefined,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    durationMs: s.endedAt !== undefined ? Math.max(0, s.endedAt - s.startedAt) : undefined,
    lastActivityAt: s.endedAt === undefined ? iso(lastActivity(s)) : undefined,
    running: isRunning(s, now),
    turns: s.stats.turns,
    toolCalls: s.stats.toolCalls,
    toolErrors: s.stats.toolErrors,
    filesChanged: s.stats.filesChanged,
    tests: s.stats.testsPassed !== undefined || s.stats.testsFailed !== undefined ? { passed: s.stats.testsPassed ?? 0, failed: s.stats.testsFailed ?? 0 } : undefined,
    tokens: u && (u.inputTokens !== undefined || u.outputTokens !== undefined) ? { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0 } : undefined,
    costUsd: u?.costUsd !== undefined ? round4(u.costUsd) : undefined,
    costEstimated: (u?.estimatedCostUsd ?? 0) > 0 ? true : undefined,
    flags: s.flags.length ? s.flags : undefined,
    derails: s.stats.derails?.length ? s.stats.derails.map((d) => ({ flag: d.flag, at: iso(d.ts), index: d.index, eventId: d.eventId, detail: d.detail })) : undefined,
    waste: s.stats.waste,
    cacheBreaks: s.stats.cacheBreaks,
    parentSessionId: s.parent?.sessionId,
    subagentType: s.parent?.type,
  };
}

// ------------------------------------------------------------ filters

export interface Place {
  /** Absolute path: matches a repo root or cwd at or under it. */
  path?: string;
  /** Bare name: matches the basename of the repo root or cwd. */
  name?: string;
}

/** "~/x", "./x", "/abs" → a path; "coding-sh" → a repo name. */
export function parsePlace(v: string, cwd: string, home: string): Place {
  const t = v.trim();
  if (t === "~" || t.startsWith("~/")) return { path: resolve(home, t.slice(2)) };
  if (isAbsolute(t) || t.startsWith(".") || t.includes("/") || t.includes(sep)) return { path: resolve(cwd, t) };
  return { name: t };
}

const under = (x: string | undefined, p: string) => !!x && (x === p || x.startsWith(p.endsWith(sep) ? p : p + sep));

export function matchesPlace(s: Session, p: Place): boolean {
  if (p.path) return under(s.repo?.root, p.path) || under(s.cwd, p.path);
  if (p.name) return (!!s.repo?.root && basename(s.repo.root) === p.name) || (!!s.cwd && basename(s.cwd) === p.name);
  return true;
}

export interface ScanQuery {
  agent?: string;
  since?: number;
  until?: number;
  flag?: string;
  place?: Place;
  /** Only sessions in this serve project. */
  project?: string;
  /** true = top-level sessions only; false = every session (subagents too). */
  topLevel: boolean;
  /** Extra in-memory predicate. */
  where?: (s: Session) => boolean;
  /** `where` query (src/query): the store's query path when it has one, else evaluated per session. Its sort is ignored. */
  query?: Query;
}

/** The store-side part of a ScanQuery (place, where and query filter on top). */
export function scanFilter(q: ScanQuery): SessionFilter {
  return {
    ...(q.agent ? { agent: q.agent } : {}),
    ...(q.since !== undefined ? { since: q.since } : {}),
    ...(q.until !== undefined ? { until: q.until } : {}),
    ...(q.flag ? { flag: q.flag } : {}),
    ...(q.project ? { project: q.project } : {}),
    ...(q.topLevel ? { parentSessionId: null } : {}),
  };
}

/** A place as query clauses (for facets, which take a query, not a predicate). */
export function placeNode(p: Place): Node | undefined {
  const cmp = (key: string, raw: string, glob: boolean): Node => ({ t: "cmp", key, op: ":", values: [{ raw, quoted: !glob, kind: glob ? "glob" : "eq" }], at: 0 });
  if (p.name) return { t: "or", items: [cmp("repo", p.name, false), cmp("dir", `*${sep}${p.name}`, true)] };
  if (p.path) {
    const under = p.path.endsWith(sep) ? p.path : p.path + sep;
    return { t: "or", items: [cmp("repo", p.path, false), cmp("repo", `${under}*`, true), cmp("dir", p.path, false), cmp("dir", `${under}*`, true)] };
  }
  return undefined;
}

/** Sessions newest first matching q, scanning at most `cap` index rows. */
export async function* scanSessions(index: IndexStore, q: ScanQuery, cap = SCAN_CAP): AsyncGenerator<Session, { truncated: boolean }> {
  const base = scanFilter(q);
  // An exact repo root narrows in the store; anything looser filters here.
  const batch = 500;
  const root = q.query?.root;
  const native = root && index.querySessions ? index.querySessions.bind(index) : undefined;
  const match = root && !native ? sessionMatcher(index, root) : undefined;
  for (let offset = 0; offset < cap; offset += batch) {
    const page = { limit: Math.min(batch, cap - offset), offset };
    const rows = native ? await native({ root }, { filter: base, ...page }) : await index.listSessions({ ...base, ...page });
    for (const s of rows) {
      if (q.place && !matchesPlace(s, q.place)) continue;
      if (q.where && !q.where(s)) continue;
      if (match && !(await match(s))) continue;
      yield s;
    }
    if (rows.length < Math.min(batch, cap - offset)) return { truncated: false };
  }
  return { truncated: true };
}

/** One page of sessions plus whether the scan cap cut the result short. */
export async function pageSessions(index: IndexStore, q: ScanQuery, offset: number, limit: number): Promise<{ sessions: Session[]; hasMore: boolean; truncated: boolean }> {
  const out: Session[] = [];
  let seen = 0;
  const it = scanSessions(index, q, Math.max(SCAN_CAP, offset + limit + 1));
  for (;;) {
    const n = await it.next();
    if (n.done) return { sessions: out, hasMore: false, truncated: n.value.truncated };
    if (seen++ < offset) continue;
    if (out.length === limit) {
      await it.return({ truncated: false });
      return { sessions: out, hasMore: true, truncated: false };
    }
    out.push(n.value);
  }
}

export async function collectSessions(index: IndexStore, q: ScanQuery, cap = SCAN_CAP): Promise<{ sessions: Session[]; truncated: boolean }> {
  const sessions: Session[] = [];
  const it = scanSessions(index, q, cap);
  for (;;) {
    const n = await it.next();
    if (n.done) return { sessions, truncated: n.value.truncated };
    sessions.push(n.value);
  }
}

// ------------------------------------------------------------ timeline digest

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Short description of a tool input (command, path, pattern…). */
export function toolArg(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isObjLike(input)) return "";
  for (const k of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const v = input[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return "";
}

const isObjLike = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Text of a tool failure: payload.error, else the output head. */
export function toolErrorText(e: AgentEvent): string | undefined {
  const p = e.payload;
  return clip(str(p.error) ?? str(p.output) ?? str(p.stderr) ?? (isObjLike(p.output) ? JSON.stringify(p.output) : undefined), 200);
}

export interface TimelineEntry extends Obj {
  /** Milliseconds since the session started. */
  at: number;
  kind: string;
  text: string;
}

/** Tool duration: event.durationMs, payload.durationMs, else end − start. */
export function toolDuration(e: AgentEvent, start?: AgentEvent): number | undefined {
  const d = typeof e.durationMs === "number" ? e.durationMs : typeof e.payload.durationMs === "number" ? (e.payload.durationMs as number) : start ? e.ts - start.ts : undefined;
  return d !== undefined && Number.isFinite(d) && d >= 0 ? d : undefined;
}

/**
 * One line per meaningful event. tool.start/tool.end pairs collapse into the
 * end; session/turn bookkeeping is dropped.
 */
export function timeline(events: AgentEvent[], startedAt: number): TimelineEntry[] {
  const starts = new Map<string, AgentEvent>();
  const out: TimelineEntry[] = [];
  const pendingStarts = new Set<AgentEvent>();
  for (const e of events) {
    const p = e.payload;
    const at = Math.max(0, e.ts - startedAt);
    const push = (kind: string, text: string | undefined) => {
      if (text) out.push({ at, kind, text });
    };
    switch (e.kind) {
      case "user.message":
        push("user", clip(p.text, 240));
        break;
      case "assistant.message":
        push("assistant", clip(p.text, 240));
        break;
      case "tool.start": {
        const id = str(p.toolUseId);
        if (id) {
          starts.set(id, e);
          pendingStarts.add(e);
        } else push("tool", `${str(p.tool) ?? "?"} ${clip(toolArg(p.input), 120) ?? ""}`.trim());
        break;
      }
      case "tool.end": {
        const id = str(p.toolUseId);
        const start = id ? starts.get(id) : undefined;
        if (start) pendingStarts.delete(start);
        const tool = str(p.tool) ?? str(start?.payload.tool) ?? "?";
        const arg = clip(toolArg(start?.payload.input ?? p.input), 120);
        const ok = p.ok !== false;
        const d = toolDuration(e, start);
        const err = ok ? undefined : toolErrorText(e);
        push("tool", `${tool}${arg ? ` ${arg}` : ""} → ${ok ? "ok" : "FAILED"}${d !== undefined ? ` ${fmtMs(d)}` : ""}${err ? `: ${err}` : ""}`);
        break;
      }
      case "llm.call":
        push("llm", `${e.model ?? str(p.responseModel) ?? str(p.requestModel) ?? "model"} ${fmtMs(e.durationMs)}${e.usage?.outputTokens !== undefined ? ` out ${e.usage.outputTokens} tok` : ""}${p.ok === false ? " FAILED" : ""}`);
        break;
      case "subagent.start":
        push("subagent", `start ${str(p.type) ?? str(p.subagentType) ?? ""} ${clip(str(p.description) ?? str(p.prompt), 120) ?? ""}`.replace(/\s+/g, " ").trim());
        break;
      case "subagent.end":
        push("subagent", `end${e.durationMs !== undefined ? ` ${fmtMs(e.durationMs)}` : ""}${p.ok === false ? " FAILED" : ""}`);
        break;
      case "file.change":
        push("file", `${str(p.op) ?? "change"} ${str(p.path) ?? ""}`.trim());
        break;
      case "test.result":
        push("tests", `${p.passed ?? "?"} passed, ${p.failed ?? "?"} failed${str(p.runner) ? ` (${p.runner})` : ""}`);
        break;
      case "error":
        push("error", clip(str(p.message) ?? str(p.error), 200));
        break;
      case "context.compact":
        push("compact", `context compacted (${str(p.trigger) ?? "auto"})`);
        break;
      case "notification":
        push("notification", clip(str(p.message) ?? str(p.text), 160));
        break;
      default:
        break;
    }
  }
  // Tools that started and never ended (still running, or the end was lost).
  for (const s of pendingStarts) {
    out.push({ at: Math.max(0, s.ts - startedAt), kind: "tool", text: `${str(s.payload.tool) ?? "?"} ${clip(toolArg(s.payload.input), 120) ?? ""} → no result`.trim() });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

export interface TurnInfo extends Obj {
  turn: number;
  prompt?: string;
  at: number;
  toolCalls: number;
  toolErrors: number;
  durationMs?: number;
}

/** Splits events into turns at each user.message (events before the first prompt join turn 1). */
export function splitTurns(events: AgentEvent[]): AgentEvent[][] {
  const turns: AgentEvent[][] = [];
  let cur: AgentEvent[] = [];
  for (const e of events) {
    if (e.kind === "user.message" && cur.some((x) => x.kind === "user.message")) {
      turns.push(cur);
      cur = [];
    }
    cur.push(e);
  }
  if (cur.length) turns.push(cur);
  return turns;
}

export function turnIndex(turns: AgentEvent[][], startedAt: number): TurnInfo[] {
  return turns.map((t, i) => {
    const first = t[0]!;
    const last = t[t.length - 1]!;
    const prompt = t.find((e) => e.kind === "user.message");
    return {
      turn: i + 1,
      prompt: clip(prompt?.payload.text, 100),
      at: Math.max(0, first.ts - startedAt),
      toolCalls: t.filter((e) => e.kind === "tool.end" && e.payload.wrapper !== true).length,
      toolErrors: t.filter((e) => e.kind === "tool.end" && e.payload.wrapper !== true && e.payload.ok === false).length,
      durationMs: Math.max(0, last.ts + (last.durationMs ?? 0) - first.ts),
    };
  });
}

// ------------------------------------------------------------ pushback

const PUSHBACK_START = /^(?:no\b|nope\b|stop\b|wait\b|don'?t\b|do not\b|undo\b|revert\b|wrong\b|why did you\b|that'?s (?:not|wrong)\b|this is (?:not|wrong)\b|not what\b|you (?:broke|didn'?t|forgot|missed)\b|still (?:fail|broken|not)\w*\b|it (?:still )?(?:doesn'?t|didn'?t) work\b|actually\b)/i;
const PUSHBACK_ANY = /\b(?:that'?s wrong|you broke|not what i (?:asked|wanted)|didn'?t work|still (?:failing|fails|broken)|try again|please revert|undo (?:that|this|it)|that is wrong)\b/i;

/** True when a follow-up prompt reads as the user correcting the agent. */
export function isPushback(text: string): boolean {
  const t = text.trim().slice(0, 400);
  return PUSHBACK_START.test(t) || PUSHBACK_ANY.test(t);
}

// ------------------------------------------------------------ aggregates

export interface FailuresOut extends Obj {
  window: Obj;
  flaggedSessions: Obj[];
  flagCounts: Record<string, number>;
  topToolErrors: Obj[];
  pushback: Obj[];
}

export async function failures(index: IndexStore, q: ScanQuery, limit: number): Promise<FailuresOut> {
  const { sessions, truncated } = await collectSessions(index, { ...q, topLevel: false });
  const flagCounts: Record<string, number> = {};
  for (const s of sessions) for (const f of failureFlags(s.flags)) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const bad = sessions.filter((s) => failureFlags(s.flags).length || s.stats.toolErrors > 0 || (s.stats.testsFailed ?? 0) > 0);
  const flaggedSessions = bad
    .filter((s) => failureFlags(s.flags).length || (s.stats.testsFailed ?? 0) > 0)
    .slice(0, limit)
    .map((s) => ({ id: s.id, agent: s.agent, title: clip(s.title, 100), startedAt: iso(s.startedAt), flags: failureFlags(s.flags), toolErrors: s.stats.toolErrors, testsFailed: s.stats.testsFailed, parentSessionId: s.parent?.sessionId }));

  // Event-level: tool errors and pushback over the most recent sessions that have any.
  const byTool = new Map<string, { tool: string; count: number; sessions: Set<string>; sample?: string; sampleSession?: string; sampleInput?: string }>();
  const pushback: Obj[] = [];
  let scanned = 0;
  for (const s of sessions) {
    if (scanned >= EVENT_SCAN_CAP) break;
    const wantErrors = s.stats.toolErrors > 0;
    const wantPrompts = s.stats.turns > 1 || s.stats.turns === 0;
    if (!wantErrors && !wantPrompts) continue;
    scanned++;
    const kinds = [...(wantErrors ? ["tool.start", "tool.end"] : []), ...(wantPrompts ? ["user.message"] : [])];
    const evs = await index.listEvents(s.id, { kinds, limit: 5000 });
    const starts = new Map<string, AgentEvent>();
    let prompts = 0;
    for (const e of evs) {
      if (e.kind === "tool.start" && typeof e.payload.toolUseId === "string") starts.set(e.payload.toolUseId, e);
      else if (e.kind === "tool.end" && e.payload.ok === false) {
        const start = typeof e.payload.toolUseId === "string" ? starts.get(e.payload.toolUseId) : undefined;
        const tool = str(e.payload.tool) ?? str(start?.payload.tool) ?? "?";
        const g = byTool.get(tool) ?? { tool, count: 0, sessions: new Set<string>() };
        g.count++;
        g.sessions.add(s.id);
        if (!g.sample) {
          g.sample = toolErrorText(e);
          g.sampleSession = s.id;
          g.sampleInput = clip(toolArg(start?.payload.input ?? e.payload.input), 120);
        }
        byTool.set(tool, g);
      } else if (e.kind === "user.message") {
        prompts++;
        const text = str(e.payload.text);
        if (prompts > 1 && text && isPushback(text) && pushback.length < limit) {
          pushback.push({ sessionId: s.id, agent: s.agent, at: iso(e.ts), text: clip(text, 200) });
        }
      }
    }
  }
  const topToolErrors = [...byTool.values()]
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, limit)
    .map((g) => ({ tool: g.tool, errors: g.count, sessions: g.sessions.size, sample: g.sample, sampleInput: g.sampleInput, sampleSessionId: g.sampleSession }));
  return {
    window: windowOf(q, sessions.length, truncated || scanned >= EVENT_SCAN_CAP),
    flaggedSessions,
    flagCounts,
    topToolErrors,
    pushback,
  };
}

function windowOf(q: ScanQuery, sessions: number, truncated: boolean): Obj {
  return { since: iso(q.since), until: iso(q.until), agent: q.agent, sessions, ...(truncated ? { truncated: true } : {}) };
}

interface Dist {
  n: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
}

function dist(values: number[]): Dist {
  if (!values.length) return { n: 0 };
  return { n: values.length, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: Math.max(...values) };
}

export type WaitKind = "human" | "subagent" | "wait";

// Tools whose duration is someone else's time: the user answering, a subagent
// working, or an explicit wait. Keyed by lowercase name (MCP prefix stripped).
const WAIT_TOOLS: Record<string, WaitKind> = {
  askuserquestion: "human",
  ask_user_question: "human",
  ask_user: "human",
  ask_followup_question: "human",
  request_user_input: "human",
  request_user_input_async: "human",
  exitplanmode: "human",
  exit_plan_mode: "human",
  task: "subagent",
  agent: "subagent",
  wait_agent: "subagent",
  wait: "wait",
  sleep: "wait",
  monitor: "wait",
  taskoutput: "wait",
};

/** Whether a tool's duration is waiting (on the user, a subagent, a timer) rather than tool latency. */
export function waitKind(tool: string): WaitKind | undefined {
  const t = tool.toLowerCase();
  return WAIT_TOOLS[t] ?? WAIT_TOOLS[t.replace(/^mcp__.*__/, "")];
}

export async function latency(index: IndexStore, q: ScanQuery, opts: { model?: string; limit: number }): Promise<Obj> {
  const { sessions, truncated } = await collectSessions(index, { ...q, topLevel: false });
  const llm: number[] = [];
  const ttft: number[] = [];
  const byModel = new Map<string, { d: number[]; ttft: number[] }>();
  const byTool = new Map<string, number[]>();
  const slowest: { tool: string; ms: number; sessionId: string; input?: string; ok: boolean }[] = [];
  let scanned = 0;
  for (const s of sessions) {
    if (scanned >= EVENT_SCAN_CAP) break;
    if (!s.stats.toolCalls && !s.stats.latency?.llmCalls) continue;
    scanned++;
    const evs = await index.listEvents(s.id, { kinds: ["llm.call", "tool.start", "tool.end"], limit: 20_000 });
    const starts = new Map<string, AgentEvent>();
    for (const e of evs) {
      if (e.kind === "llm.call") {
        const model = e.model ?? str(e.payload.responseModel) ?? str(e.payload.requestModel) ?? s.model ?? "unknown";
        if (opts.model && !model.includes(opts.model)) continue;
        const g = byModel.get(model) ?? { d: [], ttft: [] };
        if (typeof e.durationMs === "number" && e.durationMs >= 0) {
          llm.push(e.durationMs);
          g.d.push(e.durationMs);
        }
        if (typeof e.payload.ttftMs === "number" && e.payload.ttftMs >= 0) {
          ttft.push(e.payload.ttftMs);
          g.ttft.push(e.payload.ttftMs);
        }
        byModel.set(model, g);
      } else if (e.kind === "tool.start") {
        if (typeof e.payload.toolUseId === "string") starts.set(e.payload.toolUseId, e);
      } else {
        const start = typeof e.payload.toolUseId === "string" ? starts.get(e.payload.toolUseId) : undefined;
        const d = toolDuration(e, start);
        if (d === undefined) continue;
        const tool = str(e.payload.tool) ?? str(start?.payload.tool) ?? "?";
        const arr = byTool.get(tool) ?? [];
        arr.push(d);
        byTool.set(tool, arr);
        slowest.push({ tool, ms: d, sessionId: s.id, input: clip(toolArg(start?.payload.input ?? e.payload.input), 100), ok: e.payload.ok !== false });
      }
    }
  }
  slowest.sort((a, b) => b.ms - a.ms);
  const l = dist(llm);
  const t = dist(ttft);
  const toolRow = ([tool, v]: [string, number[]]) => {
    const d = dist(v);
    return { tool, calls: d.n, p50Ms: d.p50Ms, p95Ms: d.p95Ms, maxMs: d.maxMs, totalMs: v.reduce((a, b) => a + b, 0) };
  };
  const byP95 = (a: { p95Ms?: number }, b: { p95Ms?: number }) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0);
  const tools = [...byTool];
  const waiting = tools.filter(([tool]) => waitKind(tool));
  return {
    window: windowOf(q, sessions.length, truncated || scanned >= EVENT_SCAN_CAP),
    llm: { calls: l.n, p50Ms: l.p50Ms, p95Ms: l.p95Ms, maxMs: l.maxMs, ttftP50Ms: t.p50Ms, ttftP95Ms: t.p95Ms },
    byModel: [...byModel]
      .map(([model, g]) => {
        const d = dist(g.d);
        const tt = dist(g.ttft);
        return { model, calls: d.n, p50Ms: d.p50Ms, p95Ms: d.p95Ms, ttftP50Ms: tt.p50Ms };
      })
      .sort((a, b) => b.calls - a.calls)
      .slice(0, opts.limit),
    slowestTools: tools
      .filter(([tool]) => !waitKind(tool))
      .map(toolRow)
      .sort(byP95)
      .slice(0, opts.limit),
    slowestCalls: slowest.filter((x) => !waitKind(x.tool)).slice(0, Math.min(5, opts.limit)),
    ...(waiting.length
      ? {
          waitingTools: waiting
            .map((e) => ({ ...toolRow(e), waitsOn: waitKind(e[0]) }))
            .sort(byP95)
            .slice(0, opts.limit),
          note: "waitingTools (user prompts, subagent runs, explicit waits) are left out of slowestTools and slowestCalls: their time is the user's or a subagent's, not tool latency.",
        }
      : {}),
  };
}

export type UsageGroup = "day" | "agent" | "model" | "agent-model" | "repo";
export const USAGE_GROUPS: readonly UsageGroup[] = ["day", "agent", "model", "agent-model", "repo"];

export async function usage(index: IndexStore, q: ScanQuery, groupBy: UsageGroup, limit: number): Promise<Obj> {
  const { sessions, truncated } = await collectSessions(index, { ...q, topLevel: false });
  interface Acc {
    sessions: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    /** Part of costUsd computed from the price table. */
    estimatedCostUsd: number;
    /** Part of estimatedCostUsd at tier or long-context rates, by `payload.priceTier`. */
    estimatedCostByTier: Record<string, number>;
    /** Sessions that have a cost (reported or estimated). */
    priced: number;
    /** Sessions with tokens but no reported cost. */
    unpriced: number;
    /** Read-only calls repeated with an unchanged result (Session.stats.waste) and the tokens they re-sent. */
    duplicateFetches: number;
    duplicateFetchTokens: number;
    /** Prompt-cache breaks (Session.stats.cacheBreaks): prompt tokens billed again, and what that cost. */
    cacheBreaks: number;
    cacheBreakTokens: number;
    cacheBreakUsd: number;
  }
  const zero = (): Acc => ({ sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimatedCostUsd: 0, estimatedCostByTier: {}, priced: 0, unpriced: 0, duplicateFetches: 0, duplicateFetchTokens: 0, cacheBreaks: 0, cacheBreakTokens: 0, cacheBreakUsd: 0 });
  const tokens = (s: Session) => {
    const u = s.stats.usage ?? {};
    return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  };
  const add = (a: Acc, s: Session) => {
    const u = s.stats.usage ?? {};
    a.sessions++;
    a.turns += s.stats.turns ?? 0;
    a.inputTokens += u.inputTokens ?? 0;
    a.outputTokens += u.outputTokens ?? 0;
    a.cacheReadTokens += u.cacheReadTokens ?? 0;
    a.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd)) {
      a.costUsd += u.costUsd;
      a.estimatedCostUsd += u.estimatedCostUsd ?? 0;
      for (const [k, v] of Object.entries(u.estimatedCostByTier ?? {})) if (typeof v === "number" && Number.isFinite(v)) a.estimatedCostByTier[k] = (a.estimatedCostByTier[k] ?? 0) + v;
      a.priced++;
    } else if (tokens(s) > 0) a.unpriced++;
    a.duplicateFetches += s.stats.waste?.duplicateFetches ?? 0;
    a.duplicateFetchTokens += s.stats.waste?.duplicateFetchTokens ?? 0;
    a.cacheBreaks += s.stats.cacheBreaks?.count ?? 0;
    a.cacheBreakTokens += s.stats.cacheBreaks?.lostTokens ?? 0;
    a.cacheBreakUsd += s.stats.cacheBreaks?.extraUsd ?? 0;
  };
  const unpricedModels = new Map<string, number>();
  const total = zero();
  const groups = new Map<string, Acc>();
  for (const s of sessions) {
    add(total, s);
    if (typeof s.stats.usage?.costUsd !== "number" && tokens(s) > 0) unpricedModels.set(s.model ?? "unknown", (unpricedModels.get(s.model ?? "unknown") ?? 0) + 1);
    const key =
      groupBy === "day" ? localDay(s.startedAt)
      : groupBy === "agent" ? s.agent
      : groupBy === "model" ? (s.model ?? "unknown")
      : groupBy === "agent-model" ? `${s.agent} ${s.model ?? "unknown"}`
      : (s.repo?.root ?? s.cwd ?? "unknown");
    const g = groups.get(key) ?? zero();
    add(g, s);
    groups.set(key, g);
  }
  // Cost is reported only when some session in the group carried one: a missing
  // cost is unknown, not $0. Partial coverage is flagged as a lower bound.
  // tokensPerTurn and cacheReadShare (cache reads / all prompt tokens) compare
  // harnesses at a fixed model: same work, fewer tokens or more cache hits.
  const fix = ({ priced, unpriced, costUsd, estimatedCostUsd, estimatedCostByTier, duplicateFetches, duplicateFetchTokens, cacheBreaks, cacheBreakTokens, cacheBreakUsd, ...a }: Acc) => {
    const tiers = Object.entries(estimatedCostByTier).sort((x, y) => y[1] - x[1]);
    const totalTokens = a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens;
    const prompt = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens;
    return {
      ...a,
      ...(priced ? { costUsd: round4(costUsd) } : {}),
      ...(priced && estimatedCostUsd > 0 ? { estimatedCostUsd: round4(estimatedCostUsd) } : {}),
      ...(priced && tiers.length ? { estimatedCostByTier: Object.fromEntries(tiers.map(([k, v]) => [k, round4(v)])) } : {}),
      ...(priced && unpriced ? { costPartial: true, unpricedSessions: unpriced } : {}),
      totalTokens,
      ...(a.turns ? { tokensPerTurn: Math.round(totalTokens / a.turns) } : {}),
      ...(prompt ? { cacheReadShare: Math.round((a.cacheReadTokens / prompt) * 1000) / 1000 } : {}),
      ...(duplicateFetches ? { duplicateFetches, duplicateFetchTokens } : {}),
      ...(cacheBreaks ? { cacheBreaks, cacheBreakTokens, ...(cacheBreakUsd > 0 ? { cacheBreakUsd: round4(cacheBreakUsd) } : {}) } : {}),
    };
  };
  const rows = [...groups].map(([key, a]) => ({ key, ...fix(a) }));
  if (groupBy === "day") rows.sort((a, b) => b.key.localeCompare(a.key));
  else rows.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.totalTokens - a.totalTokens);
  const anyCost = total.priced > 0;
  const cost = (s: Session) => s.stats.usage?.costUsd ?? 0;
  const out = (s: Session) => s.stats.usage?.outputTokens ?? 0;
  const top = [...sessions]
    .filter((s) => cost(s) > 0 || out(s) > 0)
    .sort((a, b) => (anyCost ? cost(b) - cost(a) : 0) || out(b) - out(a))
    .slice(0, 5)
    .map((s) => ({ id: s.id, agent: s.agent, title: clip(s.title, 80), costUsd: s.stats.usage?.costUsd !== undefined ? round4(s.stats.usage.costUsd) : undefined, costEstimated: (s.stats.usage?.estimatedCostUsd ?? 0) > 0 ? true : undefined, outputTokens: s.stats.usage?.outputTokens }));
  const notes: string[] = [];
  if (!anyCost && total.unpriced) notes.push("No session in this window has a cost (none reported one and their models have no price), so costUsd is omitted rather than shown as $0. Compare spend by totalTokens; topSessions is ranked by output tokens.");
  else if (total.unpriced) notes.push(`${total.unpriced} of ${total.sessions} sessions have tokens but no cost (none reported, no price for the model); costUsd counts only the priced ones (a lower bound) and rows with unpriced sessions say costPartial.`);
  if (total.estimatedCostUsd > 0) notes.push(`$${round4(total.estimatedCostUsd)} of costUsd is estimated: token counts times list prices (estimatedCostUsd), not a bill. Reported and gateway-billed costs are used as is.`);
  const tierUsd = Object.values(total.estimatedCostByTier).reduce((x, y) => x + y, 0);
  if (tierUsd > 0) notes.push(`$${round4(tierUsd)} of the estimate used batch, flex, priority, fast, long-context or US-only rates rather than standard ones (estimatedCostByTier, by the calls' payload.priceTier).`);
  if (total.cacheBreaks) notes.push(`${total.cacheBreaks} prompt-cache ${total.cacheBreaks === 1 ? "break" : "breaks"} billed ${total.cacheBreakTokens} prompt tokens again${total.cacheBreakUsd > 0 ? ` (~$${round4(total.cacheBreakUsd)} more than reading them from cache)` : ""}: cacheBreaks, cacheBreakTokens, cacheBreakUsd; causes per session in session_get stats.cacheBreaks.`);
  if (total.duplicateFetches) notes.push(`${total.duplicateFetches} read-only ${total.duplicateFetches === 1 ? "call was" : "calls were"} repeated with the same result while the earlier result was still in context (duplicateFetches, ~${total.duplicateFetchTokens} tokens re-sent).`);
  if (unpricedModels.size) notes.push(`No price for: ${[...unpricedModels].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, n]) => `${m} (${n})`).join(", ")}. Add [prices."<model>"] to config.toml to price them.`);
  return {
    window: windowOf(q, sessions.length, truncated),
    groupBy,
    total: fix(total),
    groups: rows.slice(0, limit),
    topSessions: top,
    topSessionsRankedBy: anyCost ? "costUsd" : "outputTokens",
    ...(unpricedModels.size ? { unpricedModels: Object.fromEntries(unpricedModels) } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

// ------------------------------------------------------------ subagents

export interface SubagentNode extends Obj {
  type?: string;
  description?: string;
  sessionId?: string;
  subagentId?: string;
  durationMs?: number;
  toolCalls?: number;
  toolErrors?: number;
  ok?: boolean;
  children: SubagentNode[];
}

/** One subagent as the parent session recorded it (subagent.start / subagent.end). */
interface SubEvents {
  start?: AgentEvent;
  end?: AgentEvent;
  used?: boolean;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Child sessions (linked by parent.sessionId) plus in-session subagents seen
 * only as events. A child session's node merges what the parent recorded about
 * it (matched by childSessionId or subagentId): the short task description,
 * ok, and the duration the parent measured.
 */
export async function subagentTree(index: IndexStore, id: string, depth = 0, seen = new Set<string>()): Promise<SubagentNode[]> {
  if (depth > 5 || seen.has(id)) return [];
  seen.add(id);
  const kids = await index.listSessions({ parentSessionId: id, limit: 500 });
  kids.sort((a, b) => a.startedAt - b.startedAt);
  const evs = await index.listEvents(id, { kinds: ["subagent.start", "subagent.end"], limit: 2000 });
  const all: SubEvents[] = [];
  const bySub = new Map<string, SubEvents>();
  const byChild = new Map<string, SubEvents>();
  for (const e of evs) {
    const sid = str(e.payload.subagentId) ?? e.subagentId;
    const child = str(e.payload.childSessionId);
    let rec = (child ? byChild.get(child) : undefined) ?? (sid ? bySub.get(sid) : undefined);
    if (e.kind === "subagent.start") {
      // A second start under the same id is a new subagent.
      if (!rec || rec.start) all.push((rec = {}));
      rec.start = e;
    } else {
      if (!rec) all.push((rec = {}));
      rec.end = e;
    }
    if (sid) bySub.set(sid, rec);
    if (child) byChild.set(child, rec);
  }
  const ok = (r: SubEvents | undefined) => (typeof r?.end?.payload.ok === "boolean" ? (r.end.payload.ok as boolean) : undefined);
  const type = (r: SubEvents | undefined) => str(r?.start?.payload.type) ?? str(r?.start?.payload.subagentType) ?? str(r?.end?.payload.type);
  const pairMs = (r: SubEvents | undefined) => (r?.start && r.end ? r.end.ts - r.start.ts : undefined);

  const nodes: SubagentNode[] = [];
  for (const k of kids) {
    const rec = byChild.get(k.id) ?? (k.parent?.subagentId ? bySub.get(k.parent.subagentId) : undefined);
    if (rec) rec.used = true;
    // Duration: what the parent measured, else the child's own end, else its
    // last activity (backfilled children have no end), else the start→end gap.
    const wall = k.stats.latency?.wallMs;
    const durationMs = [rec?.end?.durationMs, k.endedAt !== undefined ? k.endedAt - k.startedAt : undefined, wall, pairMs(rec)].find(finite);
    nodes.push({
      sessionId: k.id,
      type: k.parent?.type ?? type(rec) ?? k.agent,
      description: clip(str(rec?.start?.payload.description) ?? k.title ?? str(rec?.start?.payload.prompt), 120),
      subagentId: k.parent?.subagentId ?? str(rec?.start?.payload.subagentId) ?? str(rec?.end?.payload.subagentId),
      durationMs,
      toolCalls: k.stats.toolCalls,
      toolErrors: k.stats.toolErrors,
      ok: ok(rec),
      children: await subagentTree(index, k.id, depth + 1, seen),
    });
  }
  for (const r of all) {
    if (r.used || !r.start) continue;
    const e = r.start;
    nodes.push({
      type: type(r),
      description: clip(str(e.payload.description) ?? str(e.payload.prompt), 120),
      subagentId: str(e.payload.subagentId) ?? e.subagentId,
      durationMs: [r.end?.durationMs, pairMs(r)].find(finite),
      ok: ok(r),
      children: [],
    });
  }
  return nodes;
}

export function countNodes(t: SubagentNode[]): number {
  return t.reduce((a, n) => a + 1 + countNodes(n.children), 0);
}

// ------------------------------------------------------------ current session

/** A `.git` git itself accepts: a gitdir file (worktree, submodule) or a dir with HEAD (not a stray empty dir). */
function hasGit(d: string): boolean {
  const g = join(d, ".git");
  try {
    return statSync(g).isFile() || existsSync(join(g, "HEAD"));
  } catch {
    return false;
  }
}

/** Nearest directory at or above `dir` holding a .git, else undefined. */
export function gitRoot(dir: string): string | undefined {
  let d = resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (hasGit(d)) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

/** Most recent top-level session that ran in `cwd` (or its repo), preferring one still running. */
export async function currentByCwd(index: IndexStore, cwd: string, now: number = Date.now()): Promise<{ session: Session; matchedBy: "cwd-running" | "cwd-recent" } | undefined> {
  const root = gitRoot(cwd);
  const here = (s: Session) => s.cwd === cwd || under(cwd, s.cwd ?? "\0") || under(s.cwd, cwd) || (!!root && (s.repo?.root === root || under(s.cwd, root)));
  let recent: Session | undefined;
  const it = scanSessions(index, { topLevel: true, where: here }, 1000);
  for (;;) {
    const n = await it.next();
    if (n.done) break;
    if (isRunning(n.value, now)) return { session: n.value, matchedBy: "cwd-running" };
    recent ??= n.value;
  }
  return recent ? { session: recent, matchedBy: "cwd-recent" } : undefined;
}

export const SESSION_ENV_VARS = ["CODING_SH_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID"] as const;

export { round2 };
