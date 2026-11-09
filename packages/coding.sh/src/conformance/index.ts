// Real-data invariant checker. Adapter tests run on small fixtures; backfill
// over real transcripts found four silent fidelity bugs no suite saw
// (docs/research/round-1-self.md F1, F2, F3, F6). This module checks the
// events an adapter produces against invariants every adapter must hold, so
// the same class of bug shows up on any machine's real data.
//
// - checkEvents(events): the invariants over a list of events.
// - Checker: the same, streaming (add one event at a time).
// - checkAdapter(adapter): runs the adapter's backfill read-only (blobs are
//   hashed, never written; the coding.sh store is never opened) and checks it.
// - score(reports): the share of adapters with no violations.
//
// Memory holds ids, hashes and small keys only. Reports never carry payload
// text: details are fixed templates with numbers, kinds and short ids.
import { createHash } from "node:crypto";
import { hashParts, sha256Hex } from "../core/ids.ts";
import type { Adapter, BackfillFile, NormalizeContext } from "../core/types.ts";
import type { AgentEvent } from "../schema/index.ts";
import { sourceSummary, type SourceSummary } from "./sources.ts";

/** Every invariant. `finding` names the real-data bug the rule was written to catch. */
export const RULES = {
  "duplicate-id": { finding: "F1", desc: "Two events share an id but differ in content; the store keeps one and drops the other." },
  "usage-double-count": { finding: "F1", desc: "Usage counted twice: the same model call (message or response id) carries usage on two events, or a session total sits in `usage` next to per-call usage." },
  "negative-usage": { desc: "A usage field is negative or not a number." },
  "dangling-parent": { finding: "F2", desc: "parentId names no event in the data." },
  "parent-other-session": { finding: "F2", desc: "parentId names an event of another session." },
  "parent-link-broken": { finding: "F2", desc: "A child session.start names a parentEventId that is not in its parentSessionId." },
  "empty-backfill": { finding: "F3", desc: "The agent's source files are there but the backfill produced no events." },
  "session-without-prompt": { finding: "F6", desc: "A session did model or tool work but has no user.message (no task, no title)." },
  "exit-code-not-failed": { finding: "F6", desc: "A tool.end is not ok:false although its output reports a nonzero exit code." },
  "tool-end-without-start": { desc: "A tool.end has no tool.start with the same session and toolUseId." },
  "duplicate-tool-call": { desc: "Two different tool.start (or tool.end) events share a session and toolUseId: the call counts twice." },
  "end-before-start": { desc: "A tool.end, subagent.end or session.end is earlier than its start." },
  "turn-end-repeated": { desc: "Two different turn.end events close the same turnId: the turn counts twice." },
  "bad-timestamp": { desc: "ts is not a number of ms between 2000 and 2100 (seconds for ms, or a parse failure)." },
  "negative-duration": { desc: "durationMs is negative or not a number." },
  "backfill-threw": { desc: "The adapter's backfill threw instead of skipping what it could not read." },
} as const satisfies Record<string, { finding?: string; desc: string }>;

export type Rule = keyof typeof RULES;

export interface Violation {
  rule: Rule;
  /** F1, F2, F3 or F6 when the rule catches that finding's class of bug. */
  finding?: string;
  sessionId?: string;
  eventId?: string;
  kind?: string;
  /** Short, fixed text with numbers and ids only, never payload text. */
  detail: string;
}

/** What checkEvents counted. Only counts: no payload text. */
export interface ConformanceCounts {
  events: number;
  sessions: number;
  kinds: Record<string, number>;
  sessionsWithoutStart: number;
  sessionsWithoutUserMessage: number;
  duplicateIdsSameContent: number;
  duplicateIdsDifferentContent: number;
  parentIds: number;
  danglingParentIds: number;
  toolStartWithoutEnd: number;
  toolEndWithoutStart: number;
  badTimestamps: number;
  negativeDurations: number;
  /** Sessions left out of the pairing, parent and prompt checks: cut by `since`, or still being read when a cap hit. */
  partialSessions: number;
}

export interface ConformanceReport {
  ok: boolean;
  counts: ConformanceCounts;
  /** Violations per rule (only rules with at least one). */
  violations: Partial<Record<Rule, number>>;
  /** The first few violations of each rule. */
  examples: Violation[];
}

export interface CheckOptions {
  /** The data starts at this time (ms): sessions that began earlier are partial (their parents and prompts may be cut off). */
  since?: number;
  /** Examples kept per rule (default 5). */
  maxExamples?: number;
}

// ---------------------------------------------------------------- helpers

const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);
/** Kinds that mean the session did work a prompt asked for. */
const WORK_KINDS = new Set(["llm.call", "assistant.message", "tool.start"]);
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "estimatedCostUsd"] as const;
/** Kinds that close a span: usage on them is a total when the span's calls carry their own. */
const TOTAL_KINDS = new Set(["session.end", "turn.end", "subagent.end"]);
/** A nonzero exit status at the start of a line in the first part of a tool's output ("Exit code 1", "Error: Exit code 2", "The command exited with code 1", "exit status 127"). */
const EXIT_RE = /^[\s>*-]*(?:error:\s*)?(?:the\s+)?(?:command\s+|process\s+|shell\s+)?exit(?:ed)?\s+(?:with\s+)?(?:code|status)\s*:?\s*(-?\d+)/im;
const EXIT_SCAN_CHARS = 300;

/** Ids are kept as their first 24 hex chars (96 bits): enough to tell a million events apart. */
const key = (id: string): string => id.slice(0, 24);
const short = (id: string | undefined): string => (id ?? "").slice(0, 12);

/** JSON with sorted keys, so two copies of the same event hash the same. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

const contentHash = (e: AgentEvent): string => createHash("sha256").update(stable(e)).digest("hex").slice(0, 16);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function hasUsage(e: AgentEvent): boolean {
  const u = e.usage;
  return !!u && USAGE_KEYS.some((k) => typeof u[k] === "number" && u[k]! > 0);
}

/** The nonzero exit code a tool's output reports in its first lines, if any. */
export function reportedExitCode(output: unknown): number | undefined {
  if (typeof output !== "string") return undefined;
  const m = EXIT_RE.exec(output.slice(0, EXIT_SCAN_CHARS));
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

interface SessionState {
  startTs?: number;
  endTs: number[];
  prompt: boolean;
  work: boolean;
  /** Events with usage on a total-like kind (session.end, turn.end, subagent.end). */
  totalUsage: { id: string; kind: string }[];
  callUsage: boolean;
}

interface Pending {
  id: string;
  sid: string;
  ts: number;
}

// ---------------------------------------------------------------- checker

/** Streaming invariant checker: add() every event, then report(). */
export class Checker {
  private readonly opts: CheckOptions;
  private readonly hashes = new Map<string, { h: string; sid: string }>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly kinds: Record<string, number> = {};
  private readonly toolStarts = new Map<string, Pending>();
  private readonly toolEnds = new Map<string, Pending>();
  private readonly subStarts = new Map<string, Pending>();
  private readonly subEnds: Pending[] = [];
  private readonly subEndKeys: string[] = [];
  private readonly parents: { id: string; sid: string; parent: string; kind: string }[] = [];
  private readonly links: { id: string; sid: string; parentSid: string; parentEvent: string }[] = [];
  private readonly calls = new Map<string, string>();
  private readonly turnEnds = new Map<string, string>();
  private readonly found: Violation[] = [];
  private events = 0;
  private sameDup = 0;
  private diffDup = 0;
  private badTs = 0;
  private negDur = 0;

  constructor(opts: CheckOptions = {}) {
    this.opts = opts;
  }

  private flag(rule: Rule, v: Omit<Violation, "rule" | "finding">): void {
    const finding = (RULES[rule] as { finding?: string }).finding;
    this.found.push({ rule, ...(finding ? { finding } : {}), ...v });
  }

  private session(sid: string): SessionState {
    let s = this.sessions.get(sid);
    if (!s) this.sessions.set(sid, (s = { endTs: [], prompt: false, work: false, totalUsage: [], callUsage: false }));
    return s;
  }

  add(e: AgentEvent): void {
    this.events++;
    const sid = String(e.sessionId ?? "");
    const kind = String(e.kind);
    this.kinds[kind] = (this.kinds[kind] ?? 0) + 1;
    const s = this.session(sid);
    const id = String(e.id ?? "");
    const at = { sessionId: sid, eventId: short(id), kind };

    // Ids: a repeat with the same content is a harmless re-emit; with other content one copy is lost (F1).
    const h = contentHash(e);
    const prev = this.hashes.get(key(id));
    if (prev) {
      if (prev.h === h) this.sameDup++;
      else {
        this.diffDup++;
        this.flag("duplicate-id", { ...at, detail: `${kind} ${short(id)} emitted twice with different content` });
      }
      return; // the store keeps the first copy: check that one only
    }
    this.hashes.set(key(id), { h, sid });

    // Time.
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts < MIN_TS || e.ts > MAX_TS) {
      this.badTs++;
      this.flag("bad-timestamp", { ...at, detail: `${kind} ts ${typeof e.ts === "number" ? e.ts : typeof e.ts}` });
    }
    if (e.durationMs !== undefined && (typeof e.durationMs !== "number" || !Number.isFinite(e.durationMs) || e.durationMs < 0)) {
      this.negDur++;
      this.flag("negative-duration", { ...at, detail: `${kind} durationMs ${String(e.durationMs).slice(0, 24)}` });
    }
    const ts = typeof e.ts === "number" ? e.ts : NaN;

    // Usage.
    if (e.usage) {
      for (const k of USAGE_KEYS) {
        const v = e.usage[k];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) this.flag("negative-usage", { ...at, detail: `${kind} usage.${k} ${String(v).slice(0, 24)}` });
      }
    }
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (hasUsage(e)) {
      if (kind === "llm.call") {
        s.callUsage = true;
        const callId = str(p.messageId) ?? str(p.responseId);
        // A proxy or gateway copy of a call is a second capture path, paired downstream (core/call-copies.ts).
        if (callId && e.source !== "proxy" && e.source !== "gateway" && p.replay !== true) {
          const k = `${sid}\0${e.source ?? ""}\0${callId}`;
          const first = this.calls.get(k);
          if (first) this.flag("usage-double-count", { ...at, detail: `llm.call ${short(id)} repeats the usage of call ${short(first)} (same message/response id)` });
          else this.calls.set(k, id);
        }
      } else if (TOTAL_KINDS.has(kind)) s.totalUsage.push({ id, kind });
    }

    // Session shape.
    if (kind === "session.start") {
      if (s.startTs === undefined || ts < s.startTs) s.startTs = ts;
      const parentSid = str(p.parentSessionId);
      const parentEvent = str(p.parentEventId);
      if (parentSid && parentEvent) this.links.push({ id, sid, parentSid, parentEvent });
    } else if (kind === "session.end") s.endTs.push(ts);
    else if (kind === "user.message") s.prompt = true;
    if (WORK_KINDS.has(kind)) s.work = true;

    // Tool calls.
    const toolUseId = str(p.toolUseId);
    if ((kind === "tool.start" || kind === "tool.end") && toolUseId) {
      const k = `${sid}\0${toolUseId}`;
      const map = kind === "tool.start" ? this.toolStarts : this.toolEnds;
      const other = map.get(k);
      if (other) this.flag("duplicate-tool-call", { ...at, detail: `${kind} for one toolUseId emitted as ${short(other.id)} and ${short(id)}` });
      else map.set(k, { id, sid, ts });
      if (kind === "tool.end") {
        const code = p.ok === false ? undefined : reportedExitCode(p.output);
        if (code !== undefined) this.flag("exit-code-not-failed", { ...at, detail: `tool output reports exit code ${code} but ok is ${p.ok === undefined ? "unset" : p.ok === true ? "true" : "not a boolean"}` });
      }
    }

    // Subagents.
    const subId = str(p.subagentId);
    if (kind === "subagent.start" && subId) {
      const k = `${sid}\0${subId}`;
      if (!this.subStarts.has(k)) this.subStarts.set(k, { id, sid, ts });
    } else if (kind === "subagent.end" && subId) {
      this.subEnds.push({ id, sid, ts });
      this.subEndKeys.push(`${sid}\0${subId}`);
    }

    // Turns.
    if (kind === "turn.end" && e.turnId) {
      const k = `${sid}\0${e.turnId}`;
      const first = this.turnEnds.get(k);
      if (first) this.flag("turn-end-repeated", { ...at, detail: `turn ${short(e.turnId)} closed by ${short(first)} and ${short(id)}` });
      else this.turnEnds.set(k, id);
    }

    // Parent links (resolved at the end: a parent may come later in the stream).
    if (e.parentId) {
      if (e.parentId === id) this.flag("dangling-parent", { ...at, detail: `${kind} names itself as parent` });
      else this.parents.push({ id, sid, parent: e.parentId, kind });
    }
  }

  /**
   * The report. `partial` names sessions still being read when the input was
   * cut (a cap or timeout): they skip the checks that need a whole session.
   */
  report(partial: Iterable<string> = []): ConformanceReport {
    const cut = new Set(partial);
    const since = this.opts.since;
    // Whole: not cut by a cap, and (with since) started inside the window.
    const whole = (sid: string): boolean => {
      if (cut.has(sid)) return false;
      if (since === undefined) return true;
      const st = this.sessions.get(sid)?.startTs;
      return st !== undefined && st >= since;
    };
    const late: Violation[] = [];
    const flag = (rule: Rule, v: Omit<Violation, "rule" | "finding">) => {
      const finding = (RULES[rule] as { finding?: string }).finding;
      late.push({ rule, ...(finding ? { finding } : {}), ...v });
    };

    // Tool pairing and order.
    let startWithoutEnd = 0;
    let endWithoutStart = 0;
    for (const [k, end] of this.toolEnds) {
      const start = this.toolStarts.get(k);
      if (!start) {
        if (!whole(end.sid)) continue;
        endWithoutStart++;
        flag("tool-end-without-start", { sessionId: end.sid, eventId: short(end.id), kind: "tool.end", detail: `tool.end ${short(end.id)} has no tool.start` });
      } else if (end.ts < start.ts) flag("end-before-start", { sessionId: end.sid, eventId: short(end.id), kind: "tool.end", detail: `tool.end is ${start.ts - end.ts} ms before its tool.start` });
    }
    for (const [k, start] of this.toolStarts) if (!this.toolEnds.has(k) && whole(start.sid)) startWithoutEnd++;
    this.subEnds.forEach((end, i) => {
      const start = this.subStarts.get(this.subEndKeys[i]!);
      if (start && end.ts < start.ts) flag("end-before-start", { sessionId: end.sid, eventId: short(end.id), kind: "subagent.end", detail: `subagent.end is ${start.ts - end.ts} ms before its subagent.start` });
    });

    // Sessions.
    let withoutStart = 0;
    let withoutPrompt = 0;
    for (const [sid, s] of this.sessions) {
      if (s.startTs === undefined) withoutStart++;
      if (!s.prompt) withoutPrompt++;
      if (s.startTs !== undefined) {
        const early = s.endTs.filter((t) => t < s.startTs!);
        if (early.length) flag("end-before-start", { sessionId: sid, kind: "session.end", detail: `session.end is ${s.startTs - Math.min(...early)} ms before session.start` });
      }
      if (s.work && !s.prompt && whole(sid)) flag("session-without-prompt", { sessionId: sid, detail: "session has model or tool events but no user.message" });
      if (s.callUsage) for (const t of s.totalUsage) flag("usage-double-count", { sessionId: sid, eventId: short(t.id), kind: t.kind, detail: `${t.kind} carries usage while the session's llm.call events carry it too (totals go in payload.reportedUsage)` });
    }

    // Parent links.
    let dangling = 0;
    for (const r of this.parents) {
      const parent = this.hashes.get(key(r.parent));
      if (!parent) {
        if (!whole(r.sid)) continue;
        dangling++;
        flag("dangling-parent", { sessionId: r.sid, eventId: short(r.id), kind: r.kind, detail: `${r.kind} parentId ${short(r.parent)} is not in the data` });
      } else if (parent.sid !== r.sid) flag("parent-other-session", { sessionId: r.sid, eventId: short(r.id), kind: r.kind, detail: `${r.kind} parentId ${short(r.parent)} is in session ${short(parent.sid)}` });
    }
    for (const l of this.links) {
      if (!this.sessions.has(l.parentSid) || !whole(l.sid)) continue; // the parent session is not in this data
      const parent = this.hashes.get(key(l.parentEvent));
      if (!parent || parent.sid !== l.parentSid) flag("parent-link-broken", { sessionId: l.sid, eventId: short(l.id), kind: "session.start", detail: `parentEventId ${short(l.parentEvent)} is ${parent ? `in session ${short(parent.sid)}` : "missing"}, not in parent session ${short(l.parentSid)}` });
    }

    const all = [...this.found, ...late];
    const violations: Partial<Record<Rule, number>> = {};
    const examples: Violation[] = [];
    const maxExamples = this.opts.maxExamples ?? 5;
    for (const v of all) {
      const n = (violations[v.rule] = (violations[v.rule] ?? 0) + 1);
      if (n <= maxExamples) examples.push(v);
    }
    return {
      ok: all.length === 0,
      counts: {
        events: this.events,
        sessions: this.sessions.size,
        kinds: { ...this.kinds },
        sessionsWithoutStart: withoutStart,
        sessionsWithoutUserMessage: withoutPrompt,
        duplicateIdsSameContent: this.sameDup,
        duplicateIdsDifferentContent: this.diffDup,
        parentIds: this.parents.length,
        danglingParentIds: dangling,
        toolStartWithoutEnd: startWithoutEnd,
        toolEndWithoutStart: endWithoutStart,
        badTimestamps: this.badTs,
        negativeDurations: this.negDur,
        partialSessions: [...this.sessions.keys()].filter((sid) => !whole(sid)).length,
      },
      violations,
      examples,
    };
  }
}

/** The invariants over a list of events (any order). */
export function checkEvents(events: Iterable<AgentEvent>, opts: CheckOptions = {}): ConformanceReport {
  const c = new Checker(opts);
  for (const e of events) c.add(e);
  return c.report();
}

// ---------------------------------------------------------------- adapters

export interface CheckAdapterOptions {
  /** Only events at or after this time (ms), passed to the backfill. */
  since?: number;
  /** Stop after this many events (default 200,000). */
  maxEvents?: number;
  /** Stop after this long (default 60 s). */
  timeoutMs?: number;
  maxInlineBytes?: number;
  maxExamples?: number;
  /** Environment the adapter's source paths are read from (default process.env, as backfill reads). */
  env?: NodeJS.ProcessEnv;
}

export interface AdapterReport {
  adapter: string;
  ms: number;
  /** Set when the adapter has no backfill: nothing to check. */
  skipped?: "no-backfill";
  /** The backfill was stopped by maxEvents or timeoutMs; sessions still being read are partial. */
  truncated?: "max-events" | "timeout";
  /** Source files found where the adapter reads (empty-backfill compares against it). */
  sources?: SourceSummary;
  report: ConformanceReport;
  /** Total violations (report.violations summed). */
  violations: number;
}

/** A NormalizeContext that hashes blobs and keeps nothing. */
export function hashOnlyContext(maxInlineBytes = 4096): NormalizeContext {
  return {
    maxInlineBytes,
    id: (...parts) => hashParts(...parts),
    async blob(data) {
      return sha256Hex(data);
    },
  };
}

/** Sessions touched by the trailing events: still being read when a cap hit. */
const TAIL_EVENTS = 1000;

/**
 * Runs `adapter.backfill` with a hash-only context and checks what it yields.
 * Read-only: blobs are hashed, not stored, and no store is opened. A throw is
 * reported as `backfill-threw`, never rethrown.
 */
export async function checkAdapter(adapter: Adapter, opts: CheckAdapterOptions = {}): Promise<AdapterReport> {
  const t0 = performance.now();
  const checkOpts: CheckOptions = { ...(opts.since !== undefined ? { since: opts.since } : {}), ...(opts.maxExamples !== undefined ? { maxExamples: opts.maxExamples } : {}) };
  const checker = new Checker(checkOpts);
  if (!adapter.backfill) return { adapter: adapter.id, ms: 0, skipped: "no-backfill", report: checker.report(), violations: 0 };

  const maxEvents = opts.maxEvents ?? 200_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctx = hashOnlyContext(opts.maxInlineBytes);
  // Sessions of the file being read: when a cap cuts it, they are partial.
  let fileSessions = new Set<string>();
  let fileBoundaries = 0;
  const tail: string[] = [];
  const changed = async (_f: BackfillFile): Promise<boolean> => {
    fileBoundaries++;
    fileSessions = new Set();
    return true;
  };
  let truncated: AdapterReport["truncated"];
  let threw: string | undefined;
  let n = 0;
  const it = adapter.backfill(ctx, { ...(opts.since !== undefined ? { since: opts.since } : {}), changed })[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      const r = await Promise.race([it.next(), timeout]);
      if (r === "timeout") {
        truncated = "timeout";
        break;
      }
      if (r.done) break;
      const e = r.value;
      checker.add(e);
      fileSessions.add(e.sessionId);
      tail.push(e.sessionId);
      if (tail.length > TAIL_EVENTS) tail.shift();
      if (++n >= maxEvents) {
        truncated = "max-events";
        break;
      }
    }
  } catch (e) {
    threw = (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
  } finally {
    clearTimeout(timer);
  }
  // Stop the generator without waiting on it (a hung read would hang us too).
  if (truncated) void Promise.resolve(it.return?.()).catch(() => {});

  const partial = truncated ? (fileBoundaries > 0 ? fileSessions : new Set(tail)) : new Set<string>();
  const report = checker.report(partial);
  const extra: Violation[] = [];
  if (threw !== undefined) extra.push({ rule: "backfill-threw", detail: `backfill threw: ${redactPaths(threw).slice(0, 160)}` });
  let sources: SourceSummary | undefined;
  try {
    sources = sourceSummary(adapter.id, { env: opts.env ?? process.env, ...(opts.since !== undefined ? { since: opts.since } : {}) });
  } catch {
    sources = undefined;
  }
  // Files there, nothing since the cut: a file touched recently may hold only older events, so
  // look once more without the cut (first event only) before calling it an empty backfill.
  const empty = n === 0 && threw === undefined && !!sources && sources.files > 0 && (opts.since === undefined || !(await yieldsAny(adapter, ctx, timeoutMs)));
  if (empty && sources) {
    extra.push({ rule: "empty-backfill", finding: "F3", detail: `${sources.files} source file(s), ${sources.bytes} bytes, but the backfill produced no events` });
  }
  for (const v of extra) {
    report.violations[v.rule] = (report.violations[v.rule] ?? 0) + 1;
    report.examples.push(v);
    report.ok = false;
  }
  const violations = Object.values(report.violations).reduce((a, b) => a + (b ?? 0), 0);
  return {
    adapter: adapter.id,
    ms: Math.round(performance.now() - t0),
    ...(truncated ? { truncated } : {}),
    ...(sources ? { sources } : {}),
    report,
    violations,
  };
}

/** True when the adapter's backfill yields at least one event (any time) within the time limit. */
async function yieldsAny(adapter: Adapter, ctx: NormalizeContext, timeoutMs: number): Promise<boolean> {
  const it = adapter.backfill!(ctx)[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const r = await Promise.race([it.next(), timeout]);
    // A timeout is not proof of an empty source: give the benefit of the doubt.
    return r === "timeout" || !r.done;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}

/** A message without the user's home path or other absolute paths' directories. */
function redactPaths(s: string): string {
  return s.replace(/(?:[A-Za-z]:)?[\\/][^\s'"`:]*[\\/]([^\s'"`:\\/]+)/g, "…/$1");
}

/** Share of the checked adapters (skipped ones left out) with no violations; 1 when none was checked. */
export function score(reports: readonly AdapterReport[]): number {
  const checked = reports.filter((r) => !r.skipped);
  if (!checked.length) return 1;
  return checked.filter((r) => r.violations === 0).length / checked.length;
}
