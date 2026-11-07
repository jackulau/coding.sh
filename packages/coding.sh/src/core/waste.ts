// Duplicate fetches: a read-only tool call repeated while its earlier result is
// still in the agent's context and unchanged (same tool, same input, same
// output, nothing in between that could have changed it). The repeat re-sends
// tokens the model already had. One strict-waste kind from "How Do AI Agents
// Waste Your Money?" (arXiv 2611.07238, §2). Pure over a session's events.
//
// Scope: (sessionId, subagentId). A subagent reading a file its parent read has
// a different context, so it is never a repeat of the parent's call.
// Invalidation, per scope unless noted:
// - context.compact clears the scope (the earlier result left the context);
// - a file.change, or an edit/write call naming a path, drops every key that
//   contains the path, in every scope (the file is shared);
// - a shell call that is not read-only drops search and listing keys (Grep,
//   Glob, LS, shell rg/ls/find/git status/diff): it may have created files.
// A first call that failed never seeds; a repeat whose output differs is not one.
// foldWaste is the same rules as a fold live ingest keeps; a call whose end comes
// after 64 more calls in its scope (or 1,024 in all) can count as unfinished.
import { createHash } from "node:crypto";
import type { AgentEvent, WasteStats } from "../schema/index.ts";
import { commandOf, FLAGS } from "./sessions.ts";

/** A repeated read-only call (`eventId`, its tool.start) and the call it repeats. */
export interface DuplicateFetch {
  eventId: string;
  firstEventId: string;
  tool: string;
  /** Tokens the repeat re-sent: its output length / 4, rounded up. */
  estTokens: number;
}

/** Duplicates in one scope that raise the duplicate-fetch flag. */
export const DUPLICATE_FETCH_FLAG_AT = 3;

const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "webfetch",
  "websearch",
  "view",
  "read_file",
  "read_many_files",
  "list_dir",
  "list_directory",
  "grep_search",
  "file_search",
  "search_file_content",
]);
const SEARCH_TOOLS = new Set(["grep", "glob", "ls", "list_dir", "list_directory", "grep_search", "file_search", "search_file_content"]);
const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell", "local_shell_call", "run_terminal_cmd", "terminal", "command_execution", "run_shell_command", "execute_command", "powershell"]);
const EDIT_TOOLS = /^(?:write|edit|multiedit|multi_edit|notebookedit|notebook_edit|edit_notebook|str_replace|str_replace_editor|str_replace_based_edit_tool|search_replace|replace|edit_file|write_file|create_file|write_to_file|replace_in_file|delete_file|delete)$/;
const MCP_READ = /^mcp__.+?__(?:read|get|list)/i;

/** Read-only shell programs; `sed` only with -n, `find` only without actions, `git` only for reading subcommands. */
const SHELL_READERS = new Set(["cat", "head", "tail", "nl", "wc", "ls", "rg", "grep", "fd", "tree", "stat", "file", "cd", "pwd"]);
const SHELL_SEARCHERS = new Set(["ls", "rg", "grep", "fd", "tree", "find"]);
const GIT_READERS = new Set(["show", "log", "diff", "status", "blame"]);
const GIT_SEARCHERS = new Set(["status", "diff"]);

/** The program and argv of each `&&`/`||`/`;`/`|`/newline segment, or undefined when the line can write (redirects, substitutions). */
function segments(cmd: string): string[][] | undefined {
  // Harmless redirects: stderr folded into stdout, output thrown away.
  const line = cmd.replace(/\d?>&\d/g, " ").replace(/(?:\d|&)?>>?\s*\/dev\/null/g, " ");
  if (/[>`]|\$\(|<\(/.test(line)) return undefined;
  return line
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((s) => s.length);
}

const readOnlySegment = (argv: string[]): boolean => {
  const [prog = "", ...rest] = argv;
  const p = prog.split("/").pop()!;
  if (SHELL_READERS.has(p)) return true;
  if (p === "sed") return rest.includes("-n") && !rest.some((a) => /^-[a-z]*i/.test(a) || a.startsWith("--in-place"));
  if (p === "find") return !rest.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a));
  if (p === "git") return GIT_READERS.has(rest.find((a) => !a.startsWith("-")) ?? "");
  return false;
};

const searchSegment = (argv: string[]): boolean => {
  const p = (argv[0] ?? "").split("/").pop()!;
  if (SHELL_SEARCHERS.has(p)) return true;
  return p === "git" && GIT_SEARCHERS.has(argv.slice(1).find((a) => !a.startsWith("-")) ?? "");
};

const toolOf = (e: AgentEvent): string => (typeof e.payload.tool === "string" ? e.payload.tool : "");
const isShell = (tool: string): boolean => SHELL_TOOLS.has(tool.toLowerCase());

/** A shell command that only reads: every segment is a known reader, with no redirect, `tee`, `sed -i` or `find -delete`/`-exec`. */
export function isReadOnlyCommand(cmd: string | undefined): boolean {
  if (!cmd?.trim()) return false;
  const segs = segments(cmd);
  return !!segs?.length && segs.every(readOnlySegment);
}

/** True for a tool.start of a call that only reads: Read, Grep, Glob, LS, WebFetch, …, MCP read/get/list, or a read-only shell command. */
export function isReadOnlyToolStart(e: AgentEvent): boolean {
  if (e.kind !== "tool.start" || e.payload.wrapper === true) return false;
  const tool = toolOf(e);
  if (READ_TOOLS.has(tool.toLowerCase()) || MCP_READ.test(tool)) return true;
  return isShell(tool) && isReadOnlyCommand(commandOf(e.payload.input));
}

/** JSON with sorted keys, so two equal inputs give one string. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** What makes two calls the same fetch: the tool plus its input (a shell call: its command, whitespace collapsed). */
function fetchKey(e: AgentEvent): string {
  const tool = toolOf(e);
  if (isShell(tool)) return `shell\u0000${(commandOf(e.payload.input) ?? "").replace(/\s+/g, " ").trim()}`;
  return `${tool.toLowerCase()}\u0000${canonical(e.payload.input)}`;
}

/** A search or listing (its result can change when any file appears): Grep, Glob, LS, shell rg/ls/find/git status/diff. */
function isSearchKey(key: string): boolean {
  const [tool = "", rest = ""] = key.split("\u0000");
  if (SEARCH_TOOLS.has(tool)) return true;
  if (tool !== "shell") return false;
  return (segments(rest) ?? []).some(searchSegment);
}

const pathOf = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  for (const k of ["file_path", "filePath", "path", "notebook_path", "target_file"]) if (typeof i[k] === "string" && i[k]) return i[k] as string;
  return undefined;
};

/** The output a tool.end returned, as one comparable string (inline text plus any blob holding the rest). */
const outputOf = (e: AgentEvent): string => `${typeof e.payload.output === "string" ? e.payload.output : canonical(e.payload.output)}\u0000${(e.blobs ?? []).join(",")}`;

export interface DuplicateFetchOpts {
  /** Full size (bytes) of a blob, when it can be read: a cut output's real length. */
  blobBytes?: (ref: string) => number | undefined;
}

/** Repeated read-only calls in time-sorted events. */
export function findDuplicateFetches(sorted: readonly AgentEvent[], opts: DuplicateFetchOpts = {}): DuplicateFetch[] {
  const ends = new Map<string, AgentEvent>();
  for (const e of sorted) if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") ends.set(`${e.sessionId}\u0000${e.payload.toolUseId}`, e);
  const endOf = (e: AgentEvent) => (typeof e.payload.toolUseId === "string" ? ends.get(`${e.sessionId}\u0000${e.payload.toolUseId}`) : undefined);
  // Per scope: fetch key → the first call's start and output.
  const scopes = new Map<string, Map<string, { start: AgentEvent; output: string }>>();
  const scopeOf = (e: AgentEvent) => {
    const k = `${e.sessionId}\u0000${e.subagentId ?? ""}`;
    let m = scopes.get(k);
    if (!m) scopes.set(k, (m = new Map()));
    return m;
  };
  const dropPath = (path: string) => {
    for (const m of scopes.values()) for (const k of [...m.keys()]) if (k.includes(path)) m.delete(k);
  };
  const out: DuplicateFetch[] = [];
  for (const e of sorted) {
    if (e.kind === "context.compact") {
      scopeOf(e).clear();
      continue;
    }
    if (e.kind === "file.change") {
      if (typeof e.payload.path === "string" && e.payload.path) dropPath(e.payload.path);
      continue;
    }
    if (e.kind !== "tool.start" || e.payload.wrapper === true) continue;
    const tool = toolOf(e);
    if (!isReadOnlyToolStart(e)) {
      const path = EDIT_TOOLS.test(tool.toLowerCase()) ? pathOf(e.payload.input) : undefined;
      if (path) dropPath(path);
      if (isShell(tool)) {
        const m = scopeOf(e);
        for (const k of [...m.keys()]) if (isSearchKey(k)) m.delete(k);
      }
      continue;
    }
    const end = endOf(e);
    if (!end || end.payload.ok === false) continue;
    const key = fetchKey(e);
    const m = scopeOf(e);
    const output = outputOf(end);
    const prior = m.get(key);
    if (prior && prior.output === output) {
      const blob = end.blobs?.[0];
      const chars = (blob && opts.blobBytes?.(blob)) || (typeof end.payload.output === "string" ? end.payload.output.length : canonical(end.payload.output).length);
      out.push({ eventId: e.id, firstEventId: prior.start.id, tool, estTokens: Math.ceil(chars / 4) });
      continue;
    }
    m.set(key, { start: e, output });
  }
  return out;
}

/** Session.stats.waste and the flags it raises (duplicate-fetch); undefined when nothing repeated. */
export function wasteOf(sorted: readonly AgentEvent[], opts?: DuplicateFetchOpts): { stats: WasteStats; flags: string[] } | undefined {
  const dups = findDuplicateFetches(sorted, opts);
  if (!dups.length) return undefined;
  const byId = new Map(sorted.map((e) => [e.id, e]));
  const perScope = new Map<string, number>();
  for (const d of dups) {
    const e = byId.get(d.eventId)!;
    const k = `${e.sessionId}\u0000${e.subagentId ?? ""}`;
    perScope.set(k, (perScope.get(k) ?? 0) + 1);
  }
  const readOnlyCalls = sorted.filter(isReadOnlyToolStart).length;
  return {
    stats: { duplicateFetches: dups.length, duplicateFetchTokens: dups.reduce((s, d) => s + d.estTokens, 0), readOnlyCalls },
    flags: [...perScope.values()].some((n) => n >= DUPLICATE_FETCH_FLAG_AT) ? [FLAGS.duplicateFetch] : [],
  };
}

/** Calls after a read whose end is still missing, in its scope or in all, before it counts as unfinished (as derail.ts LATE_END_CALLS). */
export const WASTE_LATE_END_CALLS = { scope: 64, all: 1024 } as const;

/** One event that findDuplicateFetches acts on, waiting its turn in WasteState.queue. */
type WasteItem =
  | { t: "compact"; scope: string }
  | { t: "change"; path: string }
  /** A call that is not read-only: an edit naming `path`, or a shell command. */
  | { t: "write"; scope: string; path?: string; shell: boolean }
  /** A read-only call, waiting for its end (`out`: a hash of the output; `ok: false` or no end never seeds). */
  | { t: "read"; scope: string; join: string; key: string; seq: number; scopeSeq: number; end?: { ok: boolean; out: string; chars: number } };

/**
 * What foldWaste carries from one event to the next. A read-only call needs its
 * end to count, so events wait in `queue`, in time order, until the read before
 * them has ended (or counts as unfinished). Serializable (node:v8).
 */
export interface WasteState {
  queue: WasteItem[];
  /** Reads in the queue by session + toolUseId, for joining their ends (a start captured twice is two reads). */
  open: Map<string, (WasteItem & { t: "read" })[]>;
  calls: number;
  scopeCalls: Map<string, number>;
  /** Per scope: fetch key → a hash of the first call's output. */
  scopes: Map<string, Map<string, string>>;
  dups: number;
  tokens: number;
  perScope: Map<string, number>;
  readOnly: number;
}

export function wasteState(): WasteState {
  return { queue: [], open: new Map(), calls: 0, scopeCalls: new Map(), scopes: new Map(), dups: 0, tokens: 0, perScope: new Map(), readOnly: 0 };
}

const scopeKey = (e: AgentEvent) => `${e.sessionId}\u0000${e.subagentId ?? ""}`;

/** Applies the queue's first item, as findDuplicateFetches does at its event. */
function applyWaste(s: WasteState, x: WasteItem): void {
  const scope = (k: string) => {
    let m = s.scopes.get(k);
    if (!m) s.scopes.set(k, (m = new Map()));
    return m;
  };
  const dropPath = (path: string) => {
    for (const m of s.scopes.values()) for (const k of [...m.keys()]) if (k.includes(path)) m.delete(k);
  };
  if (x.t === "compact") scope(x.scope).clear();
  else if (x.t === "change") dropPath(x.path);
  else if (x.t === "write") {
    if (x.path) dropPath(x.path);
    if (x.shell) {
      const m = scope(x.scope);
      for (const k of [...m.keys()]) if (isSearchKey(k)) m.delete(k);
    }
  } else {
    const open = s.open.get(x.join);
    if (open?.includes(x)) {
      if (open.length > 1) open.splice(open.indexOf(x), 1);
      else s.open.delete(x.join);
    }
    if (!x.end?.ok) return;
    const m = scope(x.scope);
    if (m.get(x.key) === x.end.out) {
      s.dups++;
      s.tokens += Math.ceil(x.end.chars / 4);
      s.perScope.set(x.scope, (s.perScope.get(x.scope) ?? 0) + 1);
    } else m.set(x.key, x.end.out);
  }
}

/** Applies queued items from the front while they are ready: everything but a read with no end yet, unless `all`. */
function drainWaste(s: WasteState, all: boolean): void {
  let n = 0;
  for (; n < s.queue.length; n++) {
    const x = s.queue[n]!;
    if (!all && x.t === "read" && !x.end && (s.scopeCalls.get(x.scope) ?? 0) - x.scopeSeq - 1 < WASTE_LATE_END_CALLS.scope && s.calls - x.seq - 1 < WASTE_LATE_END_CALLS.all) break;
    applyWaste(s, x);
  }
  if (n) s.queue.splice(0, n);
}

/** Folds the next event, in time order, into a WasteState. */
export function foldWaste(s: WasteState, e: AgentEvent): void {
  if (e.kind === "context.compact") s.queue.push({ t: "compact", scope: scopeKey(e) });
  else if (e.kind === "file.change") {
    if (typeof e.payload.path === "string" && e.payload.path) s.queue.push({ t: "change", path: e.payload.path });
  } else if (e.kind === "tool.end") {
    const reads = typeof e.payload.toolUseId === "string" ? s.open.get(`${e.sessionId}\u0000${e.payload.toolUseId}`) : undefined;
    if (reads) {
      const text = typeof e.payload.output === "string" ? e.payload.output : canonical(e.payload.output);
      // outputOf, hashed: equal outputs give equal hashes. A later end of the same call replaces an earlier one.
      const end = { ok: e.payload.ok !== false, out: createHash("sha1").update(`${text}\u0000${(e.blobs ?? []).join(",")}`).digest("base64"), chars: text.length };
      for (const r of reads) r.end = end;
    }
  } else if (e.kind === "tool.start" && e.payload.wrapper !== true) {
    const scope = scopeKey(e);
    const seq = s.calls++;
    const scopeSeq = s.scopeCalls.get(scope) ?? 0;
    s.scopeCalls.set(scope, scopeSeq + 1);
    const tool = toolOf(e);
    if (isReadOnlyToolStart(e)) {
      s.readOnly++;
      if (typeof e.payload.toolUseId === "string") {
        const r = { t: "read" as const, scope, join: `${e.sessionId}\u0000${e.payload.toolUseId}`, key: fetchKey(e), seq, scopeSeq };
        const open = s.open.get(r.join);
        if (open) open.push(r);
        else s.open.set(r.join, [r]);
        s.queue.push(r);
      }
    } else {
      const path = EDIT_TOOLS.test(tool.toLowerCase()) ? pathOf(e.payload.input) : undefined;
      const shell = isShell(tool);
      if (path || shell) s.queue.push({ t: "write", scope, ...(path ? { path } : {}), shell });
    }
  }
  if (s.queue.length) drainWaste(s, false);
}

/** Session.stats.waste and its flags for the events folded so far; reads still waiting for their end count as unfinished. */
export function wasteStatsOf(state: WasteState): { stats: WasteStats; flags: string[] } | undefined {
  let s = state;
  // What is still queued waits on a read's end: apply it to a copy, that read unfinished.
  if (s.queue.length) {
    s = structuredClone(state);
    drainWaste(s, true);
  }
  if (!s.dups) return undefined;
  return {
    stats: { duplicateFetches: s.dups, duplicateFetchTokens: s.tokens, readOnlyCalls: s.readOnly },
    flags: [...s.perScope.values()].some((n) => n >= DUPLICATE_FETCH_FLAG_AT) ? [FLAGS.duplicateFetch] : [],
  };
}
