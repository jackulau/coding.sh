// "When did it go off the rails": derail detection over one session's events.
// Pure functions over the time-sorted event list, like the other detectors in
// core/sessions.ts, so re-running them after every ingest is exact.
//
// Each detector reports where a derail STARTED (the onset event), so a viewer
// can put a marker there and a comparison can measure time to first derail.
// The thresholds below are deliberately conservative (docs/guides/explore.md
// lists them): a flag should mean "look here", not "an agent did agent things".
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

interface Call {
  /** Index of its first event (start, else end) in the sorted list. */
  index: number;
  ev: AgentEvent;
  tool: string;
  input: unknown;
  sig: string;
  /** The call's result (tool.end output), when the adapter kept it. */
  out?: string;
  ok?: boolean;
  interrupted: boolean;
  endTs: number;
  stream: string;
  turn: number;
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

/** Tool calls in start order, start and end joined by toolUseId. Wrapper calls (Codex code-mode cells) are left out. */
function toolCalls(sorted: readonly AgentEvent[]): Call[] {
  const calls: Call[] = [];
  const open = new Map<string, Call>();
  let turn = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.kind === "user.message") turn++;
    if (e.kind !== "tool.start" && e.kind !== "tool.end") continue;
    if (e.payload.wrapper === true) continue;
    const id = str(e.payload.toolUseId);
    const key = id ? `${e.subagentId ?? ""}\u0000${id}` : undefined;
    if (e.kind === "tool.start") {
      const tool = str(e.payload.tool) ?? "?";
      const input = e.payload.input;
      const cmd = commandOf(input);
      const c: Call = { index: i, ev: e, tool, input, sig: `${tool}\u0000${cmd !== undefined ? cmd.replace(/\s+/g, " ").trim() : stable(input)}`, interrupted: false, endTs: e.ts, stream: e.subagentId ?? "", turn };
      calls.push(c);
      if (key) open.set(key, c);
      continue;
    }
    const c = key ? open.get(key) : undefined;
    const ok = e.payload.ok === false ? false : true;
    const interrupted = e.payload.interrupted === true;
    const output = e.payload.output ?? e.payload.error;
    const out = output === undefined ? undefined : typeof output === "string" ? output : stable(output);
    if (c) {
      open.delete(key!);
      c.ok = ok;
      c.out = out;
      c.interrupted = interrupted;
      c.endTs = e.ts;
    } else {
      const tool = str(e.payload.tool) ?? "?";
      const input = e.payload.input;
      calls.push({ index: i, ev: e, tool, input, sig: `${tool}\u0000${stable(input)}`, out, ok, interrupted, endTs: e.ts, stream: e.subagentId ?? "", turn });
    }
  }
  return calls;
}

function byStream(calls: Call[]): Call[][] {
  const m = new Map<string, Call[]>();
  for (const c of calls) {
    const s = m.get(c.stream);
    if (s) s.push(c);
    else m.set(c.stream, [c]);
  }
  return [...m.values()];
}

const isEdit = (c: Call): boolean => EDIT_TOOL.test(c.tool) && c.ok !== false;
const baseName = (tool: string): string => tool.replace(/^mcp__.+?__/, "");
const isPoll = (c: Call): boolean => POLL_TOOLS.has(c.tool) || POLL_NAME.test(baseName(c.tool)) || UI_SERVER.test(c.tool) || UI_TOOL.test(baseName(c.tool)) || WAIT_COMMAND.test(commandOf(c.input) ?? "");
/** Progress for no-progress: an edit, a shell command that writes, or work handed to a subagent. */
const isProgress = (c: Call): boolean => isEdit(c) || DELEGATE_TOOL.test(baseName(c.tool)) || (c.ok !== false && SHELL_WRITE.test(commandOf(c.input) ?? ""));
/** Same call, same result: what a loop repeats. A call whose output changed did something new. */
const loopKey = (c: Call): string => `${c.sig}\u0000${c.ok === false ? "!" : ""}${c.out ?? ""}`;

function label(c: Call): string {
  const cmd = commandOf(c.input);
  if (cmd !== undefined) return `${c.tool} ${clip(cmd, 60)}`;
  if (c.input && typeof c.input === "object") {
    const o = c.input as Record<string, unknown>;
    for (const k of ["file_path", "path", "pattern", "query", "url"]) if (typeof o[k] === "string") return `${c.tool} ${clip(o[k] as string, 60)}`;
  }
  return c.tool;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------------------------------------------------------- detectors

export function detectLooping(calls: Call[], t = DERAIL_THRESHOLDS): Omit<Derail, "flag">[] {
  const out: Omit<Derail, "flag">[] = [];
  const ids = new Map<string, number>();
  for (const stream of byStream(calls)) {
    // One small integer per distinct call + result, so the window checks compare numbers, not outputs.
    const key = stream.map((c) => {
      const k = loopKey(c);
      let id = ids.get(k);
      if (id === undefined) ids.set(k, (id = ids.size));
      return id;
    });
    const edit = stream.map(isEdit);
    const lastEdit: number[] = [];
    for (let j = 0, le = -1; j < stream.length; j++) lastEdit.push(edit[j] ? (le = j) : le);
    const seenIn = (id: number, from: number, to: number): number => {
      let n = 0;
      for (let x = from; x <= to; x++) if (key[x] === id) n++;
      return n;
    };
    let flaggedUntil = -1;
    for (let j = 0; j < stream.length; j++) {
      const c = stream[j]!;
      if (j <= flaggedUntil || isPoll(c)) continue;
      const from = Math.max(0, j - t.loopWindow + 1);
      if (lastEdit[j]! >= from) continue;
      const id = key[j]!;
      if (seenIn(id, from, j) < t.loopRepeats) continue;
      // Extend the episode while the signature keeps coming back with no edit.
      let k = j;
      let last = c;
      while (k + 1 < stream.length && !edit[k + 1] && seenIn(id, Math.max(k + 2 - t.loopWindow, 0), k + 1) > 0) {
        k++;
        if (key[k] === id) last = stream[k]!;
      }
      let first = from;
      while (key[first] !== id) first++;
      const at = stream[first]!;
      out.push({ ts: at.ev.ts, eventId: at.ev.id, index: at.index, endTs: last.endTs, detail: `${label(c)} ×${seenIn(id, from, k)} with no edit in between` });
      flaggedUntil = k;
    }
  }
  return out;
}

export function detectFailureStreak(calls: Call[], t = DERAIL_THRESHOLDS): Omit<Derail, "flag">[] {
  const out: Omit<Derail, "flag">[] = [];
  for (const stream of byStream(calls)) {
    let run: Call[] = [];
    const close = () => {
      if (run.length >= t.failureStreak) {
        const tools = [...new Set(run.map((c) => c.tool))].slice(0, 3).join(", ");
        out.push({ ts: run[0]!.ev.ts, eventId: run[0]!.ev.id, index: run[0]!.index, endTs: run.at(-1)!.endTs, detail: `${run.length} failed tool calls in a row (${tools})` });
      }
      run = [];
    };
    for (const c of stream) {
      if (c.ok === undefined) continue; // still running or its end was lost
      if (c.ok === false && !c.interrupted) run.push(c);
      else close();
    }
    close();
  }
  return out;
}

interface Delta {
  path: string;
  removed: string;
  added: string;
  call: Call;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What a successful edit call replaced in which file, from its input. */
function deltasOf(c: Call): Delta[] {
  if (!isEdit(c)) return [];
  const input = c.input;
  if (typeof input === "string" && input.includes("*** ")) return patchDeltas(input, c);
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const path = str(o.file_path) ?? str(o.path) ?? str(o.filePath) ?? str(o.target_file);
  if (typeof o.input === "string" && o.input.includes("*** ")) return patchDeltas(o.input, c);
  if (typeof o.patch === "string" && o.patch.includes("*** ")) return patchDeltas(o.patch, c);
  if (!path) return [];
  const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [o];
  const out: Delta[] = [];
  for (const e of edits) {
    const removed = str(e.old_string) ?? str(e.oldText) ?? str(e.old_str) ?? str(e.search);
    const added = typeof e.new_string === "string" ? e.new_string : typeof e.newText === "string" ? e.newText : typeof e.new_str === "string" ? e.new_str : typeof e.replace === "string" ? e.replace : undefined;
    if (removed !== undefined && added !== undefined) out.push({ path, removed: norm(removed), added: norm(added), call: c });
  }
  // A whole-file write: "removed" is unknown, so it is matched by content (A, B, A).
  if (!out.length && typeof o.content === "string") out.push({ path, removed: "\u0000write", added: norm(o.content), call: c });
  return out;
}

/** apply_patch text: one delta per updated file (its - lines → its + lines). */
function patchDeltas(patch: string, c: Call): Delta[] {
  const out: Delta[] = [];
  let cur: { path: string; minus: string[]; plus: string[] } | undefined;
  const flush = () => {
    if (cur && (cur.minus.length || cur.plus.length)) out.push({ path: cur.path, removed: norm(cur.minus.join("\n")), added: norm(cur.plus.join("\n")), call: c });
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

export function detectChurn(calls: Call[], t = DERAIL_THRESHOLDS): Omit<Derail, "flag">[] {
  const out: Omit<Derail, "flag">[] = [];
  const history = new Map<string, Delta[]>();
  const reverts = new Map<string, { original: Delta; revert: Delta }[]>();
  const flagged = new Map<string, Omit<Derail, "flag">>();
  for (const c of calls) {
    for (const d of deltasOf(c)) {
      const h = history.get(d.path) ?? [];
      // A revert undoes an earlier edit: swaps its strings back, or writes back an older whole-file content.
      const undone =
        d.removed === "\u0000write"
          ? h.slice(0, -1).find((p) => p.removed === "\u0000write" && p.added === d.added && h.at(-1)!.added !== d.added)
          : h.slice(-50).find((p) => p.removed === d.added && p.added === d.removed && p.removed !== p.added);
      h.push(d);
      history.set(d.path, h);
      if (!undone) continue;
      const list = (reverts.get(d.path) ?? []).filter((r) => d.call.ev.ts - r.revert.call.ev.ts <= t.churnWindowMs);
      list.push({ original: undone, revert: d });
      reverts.set(d.path, list);
      if (list.length < t.churnReverts) continue;
      const open = flagged.get(d.path);
      const detail = `${shortPath(d.path)} edited back and forth (${list.length} reverts)`;
      if (open && d.call.ev.ts - open.endTs <= t.churnWindowMs) {
        open.endTs = d.call.endTs;
        open.detail = detail;
      } else {
        const o = list[0]!.original.call;
        const episode = { ts: o.ev.ts, eventId: o.ev.id, index: o.index, endTs: d.call.endTs, detail };
        flagged.set(d.path, episode);
        out.push(episode);
      }
    }
  }
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

export function detectNoProgress(sorted: readonly AgentEvent[], calls: Call[], t = DERAIL_THRESHOLDS): Omit<Derail, "flag">[] {
  // Measured only in sessions that edit at all: a read-only session (questions, reviews) has no file progress to miss.
  if (!sorted.some((e) => e.kind === "file.change") && !calls.some(isEdit)) return [];
  const out: Omit<Derail, "flag">[] = [];
  const callAt = new Map<number, Call>();
  for (const c of calls) if (c.stream === "") callAt.set(c.index, c);
  let stretch: Call[] = [];
  let seen = new Set<string>();
  let repeats = 0;
  let firstCtx: number | undefined;
  let lastCtx: number | undefined;
  // A compaction inside the stretch means the context filled up: that is growth, whatever comes after.
  let filled = false;
  let bestFailed = Infinity;
  let bestPassed = -1;
  let flagged = false;
  const reset = () => {
    stretch = [];
    seen = new Set();
    repeats = 0;
    firstCtx = lastCtx = undefined;
    filled = flagged = false;
  };
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.subagentId) continue; // a subagent's own work is not the main agent's progress or lack of it
    if (e.kind === "user.message" || e.kind === "file.change") {
      reset();
      continue;
    }
    if (e.kind === "test.result") {
      const failed = num(e.payload.failed) ?? 0;
      const passed = num(e.payload.passed) ?? 0;
      if (failed < bestFailed || passed > bestPassed) {
        bestFailed = Math.min(bestFailed, failed);
        bestPassed = Math.max(bestPassed, passed);
        reset();
      }
      continue;
    }
    if (e.kind === "context.compact") {
      if (stretch.length && e.payload.trigger !== "manual") filled = true;
      continue;
    }
    if (e.kind === "llm.call") {
      const n = contextOf(e);
      if (n !== undefined && stretch.length) {
        firstCtx ??= n;
        lastCtx = n;
      }
      continue;
    }
    const c = callAt.get(i);
    if (!c || isPoll(c)) continue;
    if (isProgress(c)) {
      reset();
      continue;
    }
    stretch.push(c);
    if (seen.has(c.sig)) repeats++;
    else seen.add(c.sig);
    const grew = filled || (firstCtx !== undefined && lastCtx !== undefined && lastCtx >= firstCtx * t.noProgressGrowth);
    if (!flagged && stretch.length >= t.noProgressCalls && grew && repeats >= stretch.length * t.noProgressRepeat) {
      flagged = true;
      const s = stretch[0]!;
      const ctx = filled ? "the context filled up and was compacted" : `context ${compact(firstCtx!)} → ${compact(lastCtx!)} tokens`;
      out.push({ ts: s.ev.ts, eventId: s.ev.id, index: s.index, endTs: c.endTs, detail: `${stretch.length}+ tool calls (${Math.round((repeats / stretch.length) * 100)}% repeats) with no edit or better test result; ${ctx}` });
    } else if (flagged) out.at(-1)!.endTs = c.endTs;
  }
  return out;
}

const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Events after which a quiet gap is the user's (they were asked, or the turn was over), not the agent's. */
const USER_TURN_BEFORE = new Set(["turn.end", "session.end", "notification", "error"]);
/** Events that open with the user coming back. */
const USER_TURN_AFTER = new Set(["user.message", "session.start"]);

export function detectStalled(sorted: readonly AgentEvent[], t = DERAIL_THRESHOLDS): Omit<Derail, "flag">[] {
  const out: Omit<Derail, "flag">[] = [];
  // Tool calls running right now (subagent + toolUseId → its start), so a quiet gap can be pinned on one.
  const open = new Map<string, { e: AgentEvent; index: number }>();
  // A tool that sat through a quiet gap: a hang if it then fails, times out or never ends; a long job if it succeeds.
  const suspects = new Map<string, Omit<Derail, "flag">>();
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (i > 0) {
      const prev = sorted[i - 1]!;
      // A gap with nothing running is the user's or the machine's (asleep, waiting on a prompt), not a hang.
      if (e.ts - prev.ts >= t.stallMs && !USER_TURN_BEFORE.has(prev.kind) && !USER_TURN_AFTER.has(e.kind)) {
        for (const [key, o] of open) {
          if (hangExempt(o.e) || suspects.has(key)) continue;
          const tool = str(o.e.payload.tool) ?? "a tool";
          const cmd = commandOf(o.e.payload.input);
          suspects.set(key, { ts: o.e.ts, eventId: o.e.id, index: o.index, endTs: e.ts, detail: `${tool}${cmd ? ` ${clip(cmd, 50)}` : ""}` });
        }
      }
    }
    const id = str(e.payload.toolUseId);
    if (!id || e.payload.wrapper === true) continue;
    const key = `${e.subagentId ?? ""}\u0000${id}`;
    if (e.kind === "tool.start") open.set(key, { e, index: i });
    else if (e.kind === "tool.end") {
      open.delete(key);
      const sus = suspects.get(key);
      if (!sus) continue;
      suspects.delete(key);
      if (e.payload.ok !== false) continue;
      out.push({ ...sus, endTs: e.ts, detail: `${sus.detail} hung ${minutes(e.ts - sus.ts)}, then failed` });
    }
  }
  for (const sus of suspects.values()) out.push({ ...sus, detail: `${sus.detail} hung ${minutes(sus.endTs - sus.ts)} and never finished` });
  return out.sort((a, b) => a.ts - b.ts);
}

/** A tool expected to sit for a long time: polling, sleeping, a subagent, a question to the user. */
function hangExempt(e: AgentEvent): boolean {
  const tool = str(e.payload.tool) ?? "";
  return POLL_TOOLS.has(tool) || POLL_NAME.test(baseName(tool)) || WAITING_TOOL.test(baseName(tool)) || WAIT_COMMAND.test(commandOf(e.payload.input) ?? "");
}

const minutes = (ms: number): string => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

export function detectContextThrash(sorted: readonly AgentEvent[], t = DERAIL_THRESHOLDS): Omit<Derail, "flag">[] {
  const out: Omit<Derail, "flag">[] = [];
  let prev: { e: AgentEvent; index: number; calls: number } | undefined;
  let calls = 0;
  let episode: { d: Omit<Derail, "flag">; count: number; calls: number } | undefined;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.kind === "tool.start" && !e.subagentId) calls++;
    if (e.kind !== "context.compact" || e.subagentId) continue;
    if (e.payload.trigger === "manual") {
      prev = undefined; // the user asked for it
      continue;
    }
    if (prev && (e.ts - prev.e.ts < t.thrashMs || calls - prev.calls < t.thrashCalls)) {
      if (episode && episode.d.endTs === prev.e.ts) {
        episode.count++;
        episode.d.endTs = e.ts;
        episode.d.detail = `${episode.count} compactions in ${minutes(e.ts - episode.d.ts)} (${calls - episode.calls} tool calls)`;
      } else {
        const d = { ts: prev.e.ts, eventId: prev.e.id, index: prev.index, endTs: e.ts, detail: `2 compactions ${minutes(e.ts - prev.e.ts)} apart (${calls - prev.calls} tool calls between)` };
        episode = { d, count: 2, calls: prev.calls };
        out.push(d);
      }
    }
    prev = { e, index: i, calls };
  }
  return out;
}

/** Max derails kept per session (the earliest win: they say when it went off the rails). */
export const MAX_DERAILS = 25;

/** Every derail episode in a session, earliest first. `sorted` must be sorted by time. */
export function detectDerails(sorted: readonly AgentEvent[], t = DERAIL_THRESHOLDS): Derail[] {
  const calls = toolCalls(sorted);
  const tag = (flag: DerailFlag, xs: Omit<Derail, "flag">[]): Derail[] => xs.map((x) => ({ flag, ...x }));
  const all = [
    ...tag(DERAIL_FLAGS.looping, detectLooping(calls, t)),
    ...tag(DERAIL_FLAGS.failureStreak, detectFailureStreak(calls, t)),
    ...tag(DERAIL_FLAGS.churn, detectChurn(calls, t)),
    ...tag(DERAIL_FLAGS.noProgress, detectNoProgress(sorted, calls, t)),
    ...tag(DERAIL_FLAGS.stalled, detectStalled(sorted, t)),
    ...tag(DERAIL_FLAGS.contextThrash, detectContextThrash(sorted, t)),
  ];
  all.sort((a, b) => a.ts - b.ts || a.index - b.index);
  return all.slice(0, MAX_DERAILS);
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
