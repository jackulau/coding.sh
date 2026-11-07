// "When did it go off the rails": derail detection over one session's events.
// A fold over the time-sorted event list: each event is read once and the state
// carried forward, so live ingest can save it and pick up where it left off
// instead of re-reading a long session on every append (core/ingest.ts).
//
// Each detector reports where a derail STARTED (the onset event), so a viewer
// can put a marker there and a comparison can measure time to first derail.
// The thresholds below are deliberately conservative (docs/guides/explore.md
// lists them): a flag should mean "look here", not "an agent did agent things".
import { createHash } from "node:crypto";
import type { AgentEvent } from "../schema/index.ts";

export const DERAIL_FLAGS = {
  /** The same tool call (tool + input) over and over with nothing changing in between. */
  looping: "looping",
  /** Many tool calls in a row failed. */
  failureStreak: "failure-streak",
  /** The same file edited back and forth: an edit undone, then redone. */
  churn: "churn",
  /** A long stretch of tool calls with no edit and no better test result while the context keeps growing. */
  noProgress: "no-progress",
  /** Nothing happened for a long time in the middle of a turn (a hung tool or model call). */
  stalled: "stalled",
  /** Compactions back to back: the context refills as fast as it is freed. */
  contextThrash: "context-thrash",
} as const;

export type DerailFlag = (typeof DERAIL_FLAGS)[keyof typeof DERAIL_FLAGS];
export const DERAIL_FLAG_LIST: readonly DerailFlag[] = Object.values(DERAIL_FLAGS);

/** Detection thresholds. Documented in docs/guides/explore.md; change both together. */
export const DERAIL_THRESHOLDS = {
  /** looping: one call signature at least this many times… */
  loopRepeats: 5,
  /** …within this many consecutive calls of one agent, with no successful edit among them. */
  loopWindow: 10,
  /** failure-streak: this many failed tool calls in a row (user interrupts do not count). */
  failureStreak: 5,
  /** churn: this many reverts (an edit that undoes an earlier one) of one file… */
  churnReverts: 2,
  /** …within this long. */
  churnWindowMs: 60 * 60_000,
  /** no-progress: this many tool calls in one turn with no successful edit or improved test result… */
  noProgressCalls: 80,
  /** …while the model's context grew by at least this factor over the stretch… */
  noProgressGrowth: 1.5,
  /** …and at least this share of the stretch repeats a call already made in it (going in circles, not exploring). */
  noProgressRepeat: 0.4,
  /** stalled: a tool call sat this long with no other event, then failed, timed out or never finished. */
  stallMs: 15 * 60_000,
  /** context-thrash: two automatic compactions closer than this (the context refilled within minutes)… */
  thrashMs: 3 * 60_000,
  /** …or with fewer tool calls than this between them. */
  thrashCalls: 15,
} as const;

/** One derail episode. */
export interface Derail {
  flag: DerailFlag;
  /** When it started: the onset event's ts. */
  ts: number;
  /** The onset event (put a marker here). */
  eventId: string;
  /** Index of the onset event in the session's events sorted by time. */
  index: number;
  /** When it was last seen. */
  endTs: number;
  /** What happened, one line ("Read src/router.ts ×6 in 10 calls"). */
  detail: string;
}


/** Tools that poll something running in the background: calling them again and again is how they work. */
const POLL_TOOLS = new Set(["BashOutput", "TaskOutput", "AgentOutputTool", "KillShell", "KillBash", "write_stdin", "read_output", "check_background", "list_agents"]);
/** Waiting tools by name: wait, wait_agent, sleep… */
const POLL_NAME = /^(?:wait|sleep)/i;
/** MCP servers that drive a browser or a desktop: every tool they have acts on a changing world. */
const UI_SERVER = /^mcp__[^_]*(?:browser|chrome|playwright|puppeteer|computer|devtools|desktop|cua)[^_]*__/i;
/** Tools that hand work to another agent: the main agent is making progress through it. */
const DELEGATE_TOOL = /^(?:Task|Agent|spawn_agent|send_message|send_input|followup_task|delegate\w*)$/i;
/** Shell commands that write files: an edit made through the shell. */
const SHELL_WRITE = /(?:^|[\s;&|])(?:sed\s+-i|perl\s+-p?i|tee\b|mv\b|cp\b|rm\b|git\s+(?:apply|commit|checkout|restore|am|cherry-pick)|patch\b|npm\s+(?:i|install)\b)|>{1,2}\s*[^\s&|>]/;
/**
 * Tools that drive a browser or a desktop (clicks, key presses, screenshots, page
 * scripts): the world they act on changes with every call, so the same call again
 * is progress, not a loop. Matched on the name after any mcp__<server>__ prefix.
 */
const UI_TOOL =
  /^(?:browser_|computer_)?(?:press_key|key|keyboard\w*|type|type_text|click|left_click|right_click|double_click|dblclick|hover|scroll|drag|fill|fill_form|select|select_page|select_tab|select_option|navigate|navigate_page|navigate_back|go_back|go_forward|take_screenshot|screenshot|take_snapshot|snapshot|look|wait_for|mouse\w*|computer|evaluate_script|evaluate|list_console_messages|get_console_message|list_network_requests|get_network_request|lighthouse_audit|performance_\w+|emulate|resize|resize_page|handle_dialog|upload_file|new_page|close_page|list_pages|tabs|tab_\w+)$/i;
/** Tools that hand work to a subagent (its events live in its own session) or wait on the user: a long one is not a hang. */
const WAITING_TOOL = /^(?:Task|Agent|spawn_agent|subagent|delegate\w*|AskUserQuestion|ExitPlanMode|request_user_input|ask_user\w*)$/i;
/** Shell commands that wait on purpose. */
const WAIT_COMMAND = /^\s*(?:sleep\b|gh\s+run\s+watch\b|watch\b)/;
/** Tools whose successful call changes files. */
const EDIT_TOOL = /^(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch|str_replace(?:_based_edit_tool|_editor)?|edit_file|write_file|replace|create_file|edit|write|patch)$/i;

/** Thresholds as detectors take them (tests may pass looser ones). */
export type DerailThresholds = { readonly [K in keyof typeof DERAIL_THRESHOLDS]: number };

/**
 * A call's end that arrives after this many more calls of its own agent, or
 * this many calls in all, comes too late: the call-pattern detectors (looping,
 * failure-streak, churn, no-progress) have already judged it unfinished. It
 * keeps the fold's look-back bounded, so a call that never ends (a crash, a
 * lost hook line) holds nothing up. A normal call ends before the next starts.
 */
export const LATE_END_CALLS = { stream: 64, all: 1024 } as const;

/** Where an episode starts or ends: an event of the session. */
interface At {
  ts: number;
  id: string;
  index: number;
  endTs: number;
}

/** One derail episode before its flag is added. */
type Episode = Omit<Derail, "flag">;

/**
 * A tool call as the call-pattern detectors see it: start and end joined by
 * toolUseId, with what they need from its input worked out once.
 */
interface Call extends At {
  /** Creation order among all calls and among its own stream's (subagent id; "" is the main agent). */
  seq: number;
  streamSeq: number;
  stream: string;
  tool: string;
  /** Tool plus normalized command or input: what a repeat repeats. */
  sig: string;
  /** The call's result (tool.end output), when the adapter kept it. */
  out?: string;
  ok?: boolean;
  interrupted: boolean;
  label: string;
  poll: boolean;
  editTool: boolean;
  delegate: boolean;
  shellWrite: boolean;
  /** What it replaced in which file, when its input is an edit (hashes of the normalized text). */
  deltas?: RawDelta[];
  /** Ended, or judged unfinished (LATE_END_CALLS). */
  settled: boolean;
  /** Its subagent + toolUseId, while it can still be joined to its end. */
  key?: string;
}

/** A main-agent event the no-progress detector reads, in order with the calls. */
interface Ev {
  ev: "user" | "file" | "test" | "compact" | "llm";
  failed?: number;
  passed?: number;
  manual?: boolean;
  ctx?: number;
}

interface RawDelta {
  path: string;
  removed: string;
  added: string;
}

interface Delta extends RawDelta {
  at: At;
}

interface LoopStream {
  /** The last loopWindow calls: what each repeated, and whether it was a successful edit. */
  win: { key: string; edit: boolean; at: At }[];
  /** An episode still going on: the signature keeps coming back with no edit. */
  active?: { key: string; first: At; last: At; count: number; label: string };
  out: Episode[];
}

interface FailStream {
  run: (At & { tool: string })[];
  out: Episode[];
}

interface ChurnFile {
  /** The last 50 deltas (an edit reverts one of these), every whole-file write, and how many deltas there were. */
  recent: Delta[];
  writes: Delta[];
  count: number;
  reverts: { original: At; revertTs: number }[];
  /** Index in out of the file's open episode. */
  flagged?: number;
}

interface NoProgress {
  /** First call of the current stretch and its length. */
  first?: At;
  len: number;
  seen: Set<string>;
  repeats: number;
  firstCtx?: number;
  lastCtx?: number;
  filled: boolean;
  /** Best test result so far; null is no result yet (Infinity does not serialize). */
  bestFailed: number | null;
  bestPassed: number;
  flagged: boolean;
  out: Episode[];
}

interface Stall {
  open: Map<string, { ts: number; id: string; index: number; exempt: boolean; detail: string }>;
  suspects: Map<string, Episode>;
  out: Episode[];
  prev?: { kind: string; ts: number };
}

interface Thrash {
  prev?: { ts: number; id: string; index: number; calls: number };
  calls: number;
  episode?: { at: number; count: number; calls: number };
  out: Episode[];
}

/**
 * Everything the detectors carry from one event to the next: plain data (maps,
 * sets, arrays), so the whole fold can be saved and picked up again later.
 */
export interface DerailState {
  calls: number;
  streams: Map<string, number>;
  /** Calls still waiting for their end, by subagent + toolUseId; null: judged unfinished, its late end is dropped. */
  open: Map<string, Call | null>;
  /** Calls and main-agent events in order, from the oldest call not yet settled. */
  queue: (Call | Ev)[];
  loop: Map<string, LoopStream>;
  fail: Map<string, FailStream>;
  churn: Map<string, ChurnFile>;
  churnOut: Episode[];
  np: NoProgress;
  anyFileChange: boolean;
  anyEdit: boolean;
  stall: Stall;
  thrash: Thrash;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => k !== "description" && k !== "timeout")
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "script"]) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return undefined;
}

const hash = (s: string): string => createHash("sha1").update(s).digest("base64");
const baseName = (tool: string): string => tool.replace(/^mcp__.+?__/, "");
const isEdit = (c: Call): boolean => c.editTool && c.ok !== false;
/** Progress for no-progress: an edit, a shell command that writes, or work handed to a subagent. */
const isProgress = (c: Call): boolean => isEdit(c) || c.delegate || (c.ok !== false && c.shellWrite);
/** Same call, same result: what a loop repeats. A call whose output changed did something new. */
const loopKey = (c: Call): string => `${c.sig}\u0000${c.ok === false ? "!" : ""}${c.out ?? ""}`;
const atOf = (c: Call): At => ({ ts: c.ts, id: c.id, index: c.index, endTs: c.endTs });

function label(tool: string, input: unknown): string {
  const cmd = commandOf(input);
  if (cmd !== undefined) return `${tool} ${clip(cmd, 60)}`;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["file_path", "path", "pattern", "query", "url"]) if (typeof o[k] === "string") return `${tool} ${clip(o[k] as string, 60)}`;
  }
  return tool;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A whole-file write: what it replaced is unknown, so it is matched by content (A, B, A). */
const WRITE = "\u0000write";

/** What an edit call's input replaced in which file (used only if the call succeeds). */
function deltasOf(input: unknown): RawDelta[] {
  if (typeof input === "string" && input.includes("*** ")) return patchDeltas(input);
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const path = str(o.file_path) ?? str(o.path) ?? str(o.filePath) ?? str(o.target_file);
  if (typeof o.input === "string" && o.input.includes("*** ")) return patchDeltas(o.input);
  if (typeof o.patch === "string" && o.patch.includes("*** ")) return patchDeltas(o.patch);
  if (!path) return [];
  const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [o];
  const out: RawDelta[] = [];
  for (const e of edits) {
    const removed = str(e.old_string) ?? str(e.oldText) ?? str(e.old_str) ?? str(e.search);
    const added = typeof e.new_string === "string" ? e.new_string : typeof e.newText === "string" ? e.newText : typeof e.new_str === "string" ? e.new_str : typeof e.replace === "string" ? e.replace : undefined;
    if (removed !== undefined && added !== undefined) out.push({ path, removed: hash(norm(removed)), added: hash(norm(added)) });
  }
  if (!out.length && typeof o.content === "string") out.push({ path, removed: WRITE, added: hash(norm(o.content)) });
  return out;
}

/** apply_patch text: one delta per updated file (its - lines → its + lines). */
function patchDeltas(patch: string): RawDelta[] {
  const out: RawDelta[] = [];
  let cur: { path: string; minus: string[]; plus: string[] } | undefined;
  const flush = () => {
    if (cur && (cur.minus.length || cur.plus.length)) out.push({ path: cur.path, removed: hash(norm(cur.minus.join("\n"))), added: hash(norm(cur.plus.join("\n"))) });
    cur = undefined;
  };
  for (const line of patch.split("\n")) {
    const m = /^\*\*\* (?:Update|Add) File: (.+)$/.exec(line);
    if (m) {
      flush();
      cur = { path: m[1]!.trim(), minus: [], plus: [] };
    } else if (line.startsWith("*** ")) flush();
    else if (cur && line.startsWith("-") && !line.startsWith("---")) cur.minus.push(line.slice(1));
    else if (cur && line.startsWith("+") && !line.startsWith("+++")) cur.plus.push(line.slice(1));
  }
  flush();
  return out;
}

const shortPath = (p: string): string => p.split(/[\\/]/).slice(-2).join("/");

/** Tokens the model saw on one call: fresh input plus cache reads and writes. */
const contextOf = (e: AgentEvent): number | undefined => {
  const u = e.usage;
  if (!u) return undefined;
  const n = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  return n > 0 ? n : undefined;
};

const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const minutes = (ms: number): string => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** Events after which a quiet gap is the user's (they were asked, or the turn was over), not the agent's. */
const USER_TURN_BEFORE = new Set(["turn.end", "session.end", "notification", "error"]);
/** Events that open with the user coming back. */
const USER_TURN_AFTER = new Set(["user.message", "session.start"]);

/** A tool expected to sit for a long time: polling, sleeping, a subagent, a question to the user. */
function hangExempt(e: AgentEvent): boolean {
  const tool = str(e.payload.tool) ?? "";
  return POLL_TOOLS.has(tool) || POLL_NAME.test(baseName(tool)) || WAITING_TOOL.test(baseName(tool)) || WAIT_COMMAND.test(commandOf(e.payload.input) ?? "");
}

/** Max derails kept per session (the earliest win: they say when it went off the rails). */
export const MAX_DERAILS = 25;

/** A fresh fold: no events seen. */
export function derailState(): DerailState {
  return {
    calls: 0,
    streams: new Map(),
    open: new Map(),
    queue: [],
    loop: new Map(),
    fail: new Map(),
    churn: new Map(),
    churnOut: [],
    np: { len: 0, seen: new Set(), repeats: 0, filled: false, bestFailed: null, bestPassed: -1, flagged: false, out: [] },
    anyFileChange: false,
    anyEdit: false,
    stall: { open: new Map(), suspects: new Map(), out: [] },
    thrash: { calls: 0, out: [] },
  };
}

/**
 * Folds one event into the detectors. Events must come in time order, `index`
 * being the event's position in the session's sorted events. Every detector
 * reads each event once, so folding a session's events in chunks (saving the
 * state in between) gives exactly what folding them all at once gives.
 */
export function foldDerails(s: DerailState, e: AgentEvent, index: number, t: DerailThresholds = DERAIL_THRESHOLDS): void {
  stallStep(s.stall, e, index, t);
  thrashStep(s.thrash, e, index, t);
  if (e.kind === "file.change") s.anyFileChange = true;
  if ((e.kind === "tool.start" || e.kind === "tool.end") && e.payload.wrapper !== true) joinCall(s, e, index);
  else if (!e.subagentId) {
    const ev = npEvent(e);
    if (ev) s.queue.push(ev);
  }
  release(s, t, false);
}

/** The derails of the events folded so far, earliest first. Leaves the state as it was. */
export function derailsOf(state: DerailState, t: DerailThresholds = DERAIL_THRESHOLDS): Derail[] {
  // Calls still running count as unfinished from here on: judge them on a copy.
  const s = structuredClone(state);
  release(s, t, true);
  const tag = (flag: DerailFlag, xs: readonly Episode[]): Derail[] => xs.map((x) => ({ flag, ...x }));
  const looping: Episode[] = [];
  for (const l of s.loop.values()) {
    if (l.active) l.out.push(loopEpisode(l.active));
    looping.push(...l.out);
  }
  const failing: Episode[] = [];
  for (const f of s.fail.values()) {
    closeRun(f, t);
    failing.push(...f.out);
  }
  // Measured only in sessions that edit at all: a read-only session (questions, reviews) has no file progress to miss.
  const noProgress = s.anyFileChange || s.anyEdit ? s.np.out : [];
  const stalled = [...s.stall.out, ...[...s.stall.suspects.values()].map((x) => ({ ...x, detail: `${x.detail} hung ${minutes(x.endTs - x.ts)} and never finished` }))].sort((a, b) => a.ts - b.ts);
  const all = [
    ...tag(DERAIL_FLAGS.looping, looping),
    ...tag(DERAIL_FLAGS.failureStreak, failing),
    ...tag(DERAIL_FLAGS.churn, s.churnOut),
    ...tag(DERAIL_FLAGS.noProgress, noProgress),
    ...tag(DERAIL_FLAGS.stalled, stalled),
    ...tag(DERAIL_FLAGS.contextThrash, s.thrash.out),
  ];
  all.sort((a, b) => a.ts - b.ts || a.index - b.index);
  return all.slice(0, MAX_DERAILS);
}

/** Every derail episode in a session, earliest first. `sorted` must be sorted by time. */
export function detectDerails(sorted: readonly AgentEvent[], t: DerailThresholds = DERAIL_THRESHOLDS): Derail[] {
  const s = derailState();
  for (let i = 0; i < sorted.length; i++) foldDerails(s, sorted[i]!, i, t);
  return derailsOf(s, t);
}

// ---------------------------------------------------------------- calls

function joinCall(s: DerailState, e: AgentEvent, index: number): void {
  const id = str(e.payload.toolUseId);
  const key = id ? `${e.subagentId ?? ""}\u0000${id}` : undefined;
  const tool = str(e.payload.tool) ?? "?";
  const input = e.payload.input;
  if (e.kind === "tool.start") {
    const cmd = commandOf(input);
    const c = newCall(s, e, index, tool, input, `${tool}\u0000${cmd !== undefined ? cmd.replace(/\s+/g, " ").trim() : stable(input)}`);
    // A call with no id can never be joined to its end: it is as finished as it will get.
    c.settled = key === undefined;
    s.queue.push(c);
    if (key) {
      c.key = key;
      s.open.set(key, c);
    }
    return;
  }
  const c = key ? s.open.get(key) : undefined;
  const ok = e.payload.ok === false ? false : true;
  const output = e.payload.output ?? e.payload.error;
  const out = output === undefined ? undefined : typeof output === "string" ? output : stable(output);
  if (c === null) {
    s.open.delete(key!); // too late: the call was judged unfinished
    return;
  }
  if (c) {
    s.open.delete(key!);
    c.ok = ok;
    c.out = out;
    c.interrupted = e.payload.interrupted === true;
    c.endTs = e.ts;
    c.settled = true;
    return;
  }
  // An end with no start (a lost hook line): a call of its own, here.
  const o = newCall(s, e, index, tool, input, `${tool}\u0000${stable(input)}`);
  o.ok = ok;
  o.out = out;
  o.interrupted = e.payload.interrupted === true;
  o.settled = true;
  s.queue.push(o);
}

function newCall(s: DerailState, e: AgentEvent, index: number, tool: string, input: unknown, sig: string): Call {
  const stream = e.subagentId ?? "";
  const streamSeq = s.streams.get(stream) ?? 0;
  s.streams.set(stream, streamSeq + 1);
  const cmd = commandOf(input) ?? "";
  const base = baseName(tool);
  const editTool = EDIT_TOOL.test(tool);
  return {
    seq: s.calls++,
    streamSeq,
    stream,
    index,
    ts: e.ts,
    id: e.id,
    endTs: e.ts,
    tool,
    sig,
    interrupted: false,
    label: label(tool, input),
    poll: POLL_TOOLS.has(tool) || POLL_NAME.test(base) || UI_SERVER.test(tool) || UI_TOOL.test(base) || WAIT_COMMAND.test(cmd),
    editTool,
    delegate: DELEGATE_TOOL.test(base),
    shellWrite: SHELL_WRITE.test(cmd),
    ...(editTool ? { deltas: deltasOf(input) } : {}),
    settled: false,
  };
}

function npEvent(e: AgentEvent): Ev | undefined {
  switch (e.kind) {
    case "user.message":
      return { ev: "user" };
    case "file.change":
      return { ev: "file" };
    case "test.result":
      return { ev: "test", failed: num(e.payload.failed) ?? 0, passed: num(e.payload.passed) ?? 0 };
    case "context.compact":
      return { ev: "compact", manual: e.payload.trigger === "manual" };
    case "llm.call": {
      const ctx = contextOf(e);
      return ctx === undefined ? { ev: "llm" } : { ev: "llm", ctx };
    }
  }
  return undefined;
}

const isCall = (x: Call | Ev): x is Call => "seq" in x;

/** Hands settled calls (and the main-agent events between them) to the detectors, in start order. `all` also hands over calls still running. */
function release(s: DerailState, t: DerailThresholds, all: boolean): void {
  let n = 0;
  for (; n < s.queue.length; n++) {
    const x = s.queue[n]!;
    if (isCall(x) && !x.settled) {
      const later = (s.streams.get(x.stream) ?? 0) - x.streamSeq - 1;
      if (!all && later < LATE_END_CALLS.stream && s.calls - x.seq - 1 < LATE_END_CALLS.all) break;
      // Judged unfinished: a late end is dropped.
      if (x.key !== undefined && s.open.get(x.key) === x) s.open.set(x.key, null);
      x.settled = true;
    }
    if (isCall(x)) callStep(s, x, t);
    else npStep(s.np, x, undefined, t);
  }
  if (n) s.queue.splice(0, n);
}

function callStep(s: DerailState, c: Call, t: DerailThresholds): void {
  if (isEdit(c)) s.anyEdit = true;
  let l = s.loop.get(c.stream);
  if (!l) s.loop.set(c.stream, (l = { win: [], out: [] }));
  loopStep(l, c, t);
  let f = s.fail.get(c.stream);
  if (!f) s.fail.set(c.stream, (f = { run: [], out: [] }));
  failStep(f, c, t);
  churnStep(s, c, t);
  if (c.stream === "") npStep(s.np, undefined, c, t);
}

// ---------------------------------------------------------------- looping

function loopEpisode(a: NonNullable<LoopStream["active"]>): Episode {
  return { ts: a.first.ts, eventId: a.first.id, index: a.first.index, endTs: a.last.endTs, detail: `${a.label} ×${a.count} with no edit in between` };
}

function loopStep(l: LoopStream, c: Call, t: DerailThresholds): void {
  const key = loopKey(c);
  const edit = isEdit(c);
  l.win.push({ key, edit, at: atOf(c) });
  if (l.win.length > t.loopWindow) l.win.shift();
  const a = l.active;
  if (a) {
    // The episode goes on while its signature is still in the window and no edit came.
    if (!edit && l.win.some((w) => w.key === a.key)) {
      if (key === a.key) {
        a.last = atOf(c);
        a.count++;
      }
      return;
    }
    l.out.push(loopEpisode(a));
    l.active = undefined;
  }
  if (c.poll || l.win.some((w) => w.edit)) return;
  let count = 0;
  for (const w of l.win) if (w.key === key) count++;
  if (count < t.loopRepeats) return;
  l.active = { key, first: l.win.find((w) => w.key === key)!.at, last: atOf(c), count, label: c.label };
}

// ---------------------------------------------------------------- failure-streak

function closeRun(f: FailStream, t: DerailThresholds): void {
  const run = f.run;
  if (run.length >= t.failureStreak) {
    const tools = [...new Set(run.map((c) => c.tool))].slice(0, 3).join(", ");
    f.out.push({ ts: run[0]!.ts, eventId: run[0]!.id, index: run[0]!.index, endTs: run.at(-1)!.endTs, detail: `${run.length} failed tool calls in a row (${tools})` });
  }
  f.run = [];
}

function failStep(f: FailStream, c: Call, t: DerailThresholds): void {
  if (c.ok === undefined) return; // still running or its end was lost
  if (c.ok === false && !c.interrupted) f.run.push({ ...atOf(c), tool: c.tool });
  else closeRun(f, t);
}

// ---------------------------------------------------------------- churn

function churnStep(s: DerailState, c: Call, t: DerailThresholds): void {
  if (!isEdit(c) || !c.deltas) return;
  for (const raw of c.deltas) {
    const d: Delta = { ...raw, at: atOf(c) };
    let h = s.churn.get(d.path);
    if (!h) s.churn.set(d.path, (h = { recent: [], writes: [], count: 0, reverts: [] }));
    // A revert undoes an earlier edit: swaps its strings back, or writes back an older whole-file content.
    const last = h.recent.at(-1);
    const undone =
      d.removed === WRITE
        ? h.count >= 2 && last!.added !== d.added
          ? h.writes.find((p) => p !== last && p.added === d.added)
          : undefined
        : h.recent.find((p) => p.removed === d.added && p.added === d.removed && p.removed !== p.added);
    h.recent.push(d);
    if (h.recent.length > 50) h.recent.shift();
    if (d.removed === WRITE) h.writes.push(d);
    h.count++;
    if (!undone) continue;
    h.reverts = h.reverts.filter((r) => d.at.ts - r.revertTs <= t.churnWindowMs);
    h.reverts.push({ original: undone.at, revertTs: d.at.ts });
    if (h.reverts.length < t.churnReverts) continue;
    const open = h.flagged === undefined ? undefined : s.churnOut[h.flagged];
    const detail = `${shortPath(d.path)} edited back and forth (${h.reverts.length} reverts)`;
    if (open && d.at.ts - open.endTs <= t.churnWindowMs) {
      open.endTs = d.at.endTs;
      open.detail = detail;
    } else {
      const o = h.reverts[0]!.original;
      h.flagged = s.churnOut.length;
      s.churnOut.push({ ts: o.ts, eventId: o.id, index: o.index, endTs: d.at.endTs, detail });
    }
  }
}

// ---------------------------------------------------------------- no-progress

function npReset(p: NoProgress): void {
  p.first = undefined;
  p.len = 0;
  p.seen = new Set();
  p.repeats = 0;
  p.firstCtx = p.lastCtx = undefined;
  p.filled = p.flagged = false;
}

/** One main-agent event or call, in order. A subagent's own work is not the main agent's progress or lack of it. */
function npStep(p: NoProgress, x: Ev | undefined, c: Call | undefined, t: DerailThresholds): void {
  if (x) {
    switch (x.ev) {
      case "user":
      case "file":
        npReset(p);
        return;
      case "test": {
        const failed = x.failed!;
        const passed = x.passed!;
        const bestFailed = p.bestFailed ?? Infinity;
        if (failed < bestFailed || passed > p.bestPassed) {
          p.bestFailed = Math.min(bestFailed, failed);
          p.bestPassed = Math.max(p.bestPassed, passed);
          npReset(p);
        }
        return;
      }
      case "compact":
        // A compaction inside the stretch means the context filled up: that is growth, whatever comes after.
        if (p.len && !x.manual) p.filled = true;
        return;
      case "llm":
        if (x.ctx !== undefined && p.len) {
          p.firstCtx ??= x.ctx;
          p.lastCtx = x.ctx;
        }
        return;
    }
  }
  if (!c || c.poll) return;
  if (isProgress(c)) {
    npReset(p);
    return;
  }
  p.first ??= atOf(c);
  p.len++;
  if (p.seen.has(c.sig)) p.repeats++;
  else p.seen.add(c.sig);
  const grew = p.filled || (p.firstCtx !== undefined && p.lastCtx !== undefined && p.lastCtx >= p.firstCtx * t.noProgressGrowth);
  if (!p.flagged && p.len >= t.noProgressCalls && grew && p.repeats >= p.len * t.noProgressRepeat) {
    p.flagged = true;
    const s = p.first;
    const ctx = p.filled ? "the context filled up and was compacted" : `context ${compact(p.firstCtx!)} → ${compact(p.lastCtx!)} tokens`;
    p.out.push({ ts: s.ts, eventId: s.id, index: s.index, endTs: c.endTs, detail: `${p.len}+ tool calls (${Math.round((p.repeats / p.len) * 100)}% repeats) with no edit or better test result; ${ctx}` });
  } else if (p.flagged) p.out.at(-1)!.endTs = c.endTs;
}

// ---------------------------------------------------------------- stalled

function stallStep(st: Stall, e: AgentEvent, index: number, t: DerailThresholds): void {
  const prev = st.prev;
  st.prev = { kind: e.kind, ts: e.ts };
  // A gap with nothing running is the user's or the machine's (asleep, waiting on a prompt), not a hang.
  if (prev && e.ts - prev.ts >= t.stallMs && !USER_TURN_BEFORE.has(prev.kind) && !USER_TURN_AFTER.has(e.kind)) {
    for (const [key, o] of st.open) {
      if (o.exempt || st.suspects.has(key)) continue;
      st.suspects.set(key, { ts: o.ts, eventId: o.id, index: o.index, endTs: e.ts, detail: o.detail });
    }
  }
  const id = str(e.payload.toolUseId);
  if (!id || e.payload.wrapper === true) return;
  const key = `${e.subagentId ?? ""}\u0000${id}`;
  if (e.kind === "tool.start") {
    const tool = str(e.payload.tool) ?? "a tool";
    const cmd = commandOf(e.payload.input);
    st.open.set(key, { ts: e.ts, id: e.id, index, exempt: hangExempt(e), detail: `${tool}${cmd ? ` ${clip(cmd, 50)}` : ""}` });
  } else if (e.kind === "tool.end") {
    st.open.delete(key);
    // A tool that sat through a quiet gap: a hang if it then fails, times out or never ends; a long job if it succeeds.
    const sus = st.suspects.get(key);
    if (!sus) return;
    st.suspects.delete(key);
    if (e.payload.ok !== false) return;
    st.out.push({ ...sus, endTs: e.ts, detail: `${sus.detail} hung ${minutes(e.ts - sus.ts)}, then failed` });
  }
}

// ---------------------------------------------------------------- context-thrash

function thrashStep(th: Thrash, e: AgentEvent, index: number, t: DerailThresholds): void {
  if (e.kind === "tool.start" && !e.subagentId) th.calls++;
  if (e.kind !== "context.compact" || e.subagentId) return;
  if (e.payload.trigger === "manual") {
    th.prev = undefined; // the user asked for it
    return;
  }
  const prev = th.prev;
  if (prev && (e.ts - prev.ts < t.thrashMs || th.calls - prev.calls < t.thrashCalls)) {
    const ep = th.episode;
    const d = ep ? th.out[ep.at]! : undefined;
    if (ep && d && d.endTs === prev.ts) {
      ep.count++;
      d.endTs = e.ts;
      d.detail = `${ep.count} compactions in ${minutes(e.ts - d.ts)} (${th.calls - ep.calls} tool calls)`;
    } else {
      th.episode = { at: th.out.length, count: 2, calls: prev.calls };
      th.out.push({ ts: prev.ts, eventId: prev.id, index: prev.index, endTs: e.ts, detail: `2 compactions ${minutes(e.ts - prev.ts)} apart (${th.calls - prev.calls} tool calls between)` });
    }
  }
  th.prev = { ts: e.ts, id: e.id, index, calls: th.calls };
}

/** Progress metrics for comparisons: how long a run stayed on track. */
export interface ProgressMetrics {
  derails: number;
  /** First derail's flag, when there is one. */
  firstFlag?: string;
  /** ms from session start to the first derail; the whole wall time when it never derailed (it ran clean to the end). */
  timeToFirstDerailMs: number;
  /** timeToFirstDerailMs / wall time: 1 = never derailed. */
  onTrack: number;
}

export function progressMetrics(derails: readonly { flag: string; ts: number }[], startedAt: number, endedAt: number): ProgressMetrics {
  const wall = Math.max(0, endedAt - startedAt);
  const first = derails.reduce<{ flag: string; ts: number } | undefined>((a, d) => (!a || d.ts < a.ts ? d : a), undefined);
  if (!first) return { derails: 0, timeToFirstDerailMs: wall, onTrack: 1 };
  const ttfd = Math.min(wall, Math.max(0, first.ts - startedAt));
  return { derails: derails.length, firstFlag: first.flag, timeToFirstDerailMs: ttfd, onTrack: wall > 0 ? ttfd / wall : 0 };
}
