// Session replay: a captured session as numbered steps, and the files the agent
// touched as of any step, rebuilt from its own tool calls.
//
// Steps are prompts, replies, tool calls (a tool.start/tool.end pair, with the
// file.change and test.result events it produced), subagent starts,
// compactions, errors, and file changes no tool call claims. Step n is 1-based;
// "the state at step n" is the state after step n ran (step 0 is the start).
//
// Reconstruction replays, per file, what each step did to it:
// - a full write (Write, write_file, create, an apply_patch Add File) sets the content;
// - a full read (Read, read_file, view, `cat <file>`) sets it when it was unknown,
//   and re-syncs it when it differs (something outside the edit tools changed it);
// - Claude Code's Edit/Write result carries the file before the edit (originalFile);
// - an edit (Edit, MultiEdit, replace, str_replace, apply_patch hunks, a
//   file.change diff) applies to known content only. An edit to content no
//   step has shown, an edit that does not match, a clipped input whose full
//   text is not stored, or a change with no recorded content makes the file
//   unknown from that step, with the reason, until a later read or write.
// A session with a start snapshot (`coding.sh run`, eval runs) can supply the
// starting content of each file through `baseline`.
//
// Index building reads only the events. Content is resolved lazily, per file
// and up to the step asked for, reading blobs only for the steps that touched
// that file; resolved steps and per-file states are cached on the Replay.
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import { unifiedDiff } from "../adapters/_shared/heuristics.ts";
import { patchTextOf } from "../adapters/_shared/tools.ts";
import { run } from "./git.ts";
import type { Redactor } from "./redact.ts";
import { shadowRepoPath } from "./snapshot.ts";
import type { BlobStore, IndexStore } from "./types.ts";

export type StepKind = "prompt" | "reply" | "tool" | "shell" | "edit" | "read" | "subagent" | "compact" | "error" | "change" | "test";
export type TouchOp = "add" | "modify" | "delete" | "read";

export interface ReplayStep {
  /** 1-based. */
  n: number;
  ts: number;
  kind: StepKind;
  /** One line: the prompt, `$ npm test`, `Edit src/a.ts`, … */
  label: string;
  /** The step's first event (tool.start for a tool call): a deep link into the session. */
  eventId: string;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  /** Files the step named, from its events alone (no blob reads). */
  files?: { path: string; op: TouchOp }[];
}

export interface ReplayIndex {
  sessionId: string;
  /** Paths are relative to this directory (the repo root, else the session's cwd) when inside it. */
  root?: string;
  steps: ReplayStep[];
  /** Every path a step names, sorted. */
  files: string[];
  /** "snapshot" when a start snapshot can supply each file's starting content. */
  baseline: "snapshot" | "none";
}

/** A file's state after some step. `content` undefined = unknown. */
export interface FileState {
  /** False once deleted (or absent at the start snapshot); undefined when unknown. */
  exists?: boolean;
  content?: string;
  /** Why the content is unknown (plain words, names the step). */
  why?: string;
  /** Content came from a numbered read, so its final newline is assumed. */
  approxEol?: boolean;
}

export interface StepChange {
  path: string;
  op: "add" | "modify" | "delete";
  /** Unified diff of the step's change; omitted when nothing is recorded. */
  diff?: string;
  /** True when `diff` compares reconstructed content before and after the step (real line numbers). */
  exact: boolean;
  diffTruncated?: boolean;
  /** Set when the content after the step is unknown: why. */
  why?: string;
  /** The step re-synced the file to what a read showed, which differed from the reconstruction. */
  resynced?: boolean;
}

export interface TreeEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "read";
  /** Steps up to here that changed it. */
  edits: number;
  /** Last step up to here that touched it. */
  lastStep: number;
  /** This step touched it. */
  here?: true;
}

export interface ShellDetail {
  command: string;
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  /** The stored output was cut; the full text is in `outputBlob`. */
  outputTruncated?: boolean;
  outputBlob?: string;
}

export interface StepView {
  sessionId: string;
  steps: number;
  step: ReplayStep;
  /** Prompt or reply text, tool input, shell command and output. */
  detail: { text?: string; textTruncated?: boolean; input?: unknown; shell?: ShellDetail; output?: string; outputTruncated?: boolean; outputBlob?: string };
  tree: TreeEntry[];
  changes: StepChange[];
  /** With `file`: that file as of this step. */
  file?: FileView;
}

export interface FileView {
  path: string;
  exists?: boolean;
  /** Undefined when unknown (see why). */
  content?: string;
  contentTruncated?: boolean;
  why?: string;
  approxEol?: boolean;
  /** Last step up to here that changed it, 0 for none. */
  changedAt: number;
}

export interface RangeFile {
  path: string;
  op: "add" | "modify" | "delete";
  /** Steps in the range that changed it. */
  steps: number[];
  diff?: string;
  /** True when `diff` compares reconstructed content at both ends; false: the steps' own diffs, one after another. */
  exact: boolean;
  diffTruncated?: boolean;
  why?: string;
}

export interface RangeView {
  sessionId: string;
  /** First step in the range (1-based). */
  from: number;
  /** Last step in the range, included. */
  to: number;
  files: RangeFile[];
  /** Files changed in the range that ended as they started. */
  unchanged: string[];
}

/** Text of a blob (undefined when missing). */
export type BlobText = (ref: string) => Promise<string | undefined>;
/** Starting content of a path (relative to the index root): string, null when absent, undefined when unknown. */
export type Baseline = (path: string) => Promise<string | null | undefined>;

export interface ReplayOptions {
  blob: BlobText;
  baseline?: Baseline;
  /** Caps for API answers. */
  maxContentBytes?: number;
  maxDiffBytes?: number;
}

const MAX_CONTENT = 1024 * 1024;
const MAX_DIFF = 512 * 1024;
/** Claude Code's Read returns at most this many lines without an explicit limit. */
const READ_LINE_CAP = 2000;

// ---------------------------------------------------------------- small helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const oneLine = (s: string, n = 120): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const pick = (o: Obj, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return undefined;
};
const truthy = (v: unknown) => v === true || v === "true";

/** Last segment of a namespaced tool name (`developer__text_editor` → `text_editor`), lowercased. */
function toolKey(tool: string): string {
  const t = tool.toLowerCase();
  const i = t.lastIndexOf("__");
  return i >= 0 ? t.slice(i + 2) : t;
}

const WRITE = new Set(["write", "write_file", "create_file", "writefile", "write_to_file", "create", "new_file", "file_write"]);
const EDIT = new Set(["edit", "str_replace", "str_replace_editor", "str_replace_based_edit_tool", "search_replace", "replace", "edit_file", "strreplace", "replace_in_file", "replace_file_content", "text_editor"]);
const MULTI = new Set(["multiedit", "multi_edit", "multi_replace_file_content"]);
const PATCH = new Set(["apply_patch", "patch", "applypatch", "apply_diff"]);
const DELETE = new Set(["delete_file", "delete", "deletefile", "remove_file"]);
const READ = new Set(["read", "read_file", "readfile", "view", "view_file", "open_file", "file_read"]);
const NOTEBOOK = new Set(["notebookedit", "notebook_edit", "edit_notebook"]);
const SHELL = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell", "local_shell_call", "run_terminal_cmd", "terminal", "command_execution", "run_shell_command", "execute_command", "powershell", "run_command", "execute", "user_bash", "exec", "run_in_terminal"]);

type Family = "write" | "edit" | "multi" | "patch" | "delete" | "read" | "notebook" | "shell" | "other";
const EDITS = new Set<Family>(["write", "edit", "multi", "patch", "delete"]);

/** Family of a tool call; text-editor tools with a `command` field are classified by it. */
function familyOf(tool: string, input: unknown): Family {
  const t = toolKey(tool);
  const i = isObj(input) ? input : {};
  if ((t === "text_editor" || t === "str_replace_editor" || t === "str_replace_based_edit_tool") && typeof i.command === "string") {
    const c = i.command;
    if (c === "view") return "read";
    if (c === "create" || c === "write") return "write";
    return "edit";
  }
  if (WRITE.has(t)) return "write";
  if (MULTI.has(t)) return "multi";
  if (EDIT.has(t)) return "edit";
  if (PATCH.has(t)) return "patch";
  if (DELETE.has(t)) return "delete";
  if (READ.has(t)) return "read";
  if (NOTEBOOK.has(t)) return "notebook";
  if (SHELL.has(t)) return "shell";
  if (patchTextOf(input) && /^\*\*\* Begin Patch/m.test(patchTextOf(input)!)) return "patch";
  return "other";
}

const PATH_KEYS = ["file_path", "filePath", "path", "absolute_path", "absolutePath", "AbsolutePath", "target_file", "targetFile", "TargetFile", "notebook_path", "file", "filename"];
const pathOf = (input: unknown): string | undefined => (isObj(input) ? PATH_KEYS.map((k) => input[k]).find((v): v is string => typeof v === "string" && v !== "") : undefined);

/** The command line of a shell call (string, argv array, `bash -lc` wrapper). */
export function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!isObj(input)) return undefined;
  const c = input.command ?? input.cmd ?? input.CommandLine ?? input.commandLine ?? input.script;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.filter((x): x is string => typeof x === "string");
    if (parts.length >= 3 && /(^|\/)(ba|z|)sh$/.test(parts[0]!) && /^-\w*c$/.test(parts[1]!)) return parts.slice(2).join(" ");
    return parts.join(" ");
  }
  return undefined;
}

/** `cat <one file>` with nothing else on the line: its output is the file. */
function catPath(command: string): string | undefined {
  const m = /^\s*cat\s+(?:--\s+)?("([^"$`\\]+)"|'([^']+)'|([^\s|;&<>$`*?(){}"'\\]+))\s*$/.exec(command);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);
const slash = (p: string) => p.replaceAll("\\", "/");

// ---------------------------------------------------------------- clipped values

/** True when a stored value was cut to fit (a string ending in "…", or a "…N more" array marker). */
function looksClipped(v: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof v === "string") return v.endsWith("…") || /^…\d+ more$/.test(v);
  if (Array.isArray(v)) return v.some((x) => looksClipped(x, depth + 1));
  if (isObj(v)) return Object.values(v).some((x) => looksClipped(x, depth + 1));
  return false;
}

/** `full` is what `clipped` was cut from. */
function compatible(clipped: unknown, full: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof clipped === "string") {
    if (typeof full === "string") return clipped.endsWith("…") ? full.startsWith(clipped.slice(0, -1)) : full === clipped;
    // A JSON preview string of an object that could not be shrunk.
    if (clipped.endsWith("…") && full !== null && typeof full === "object") return JSON.stringify(full).startsWith(clipped.slice(0, -1));
    return false;
  }
  if (Array.isArray(clipped)) {
    if (!Array.isArray(full)) return false;
    const items = clipped.filter((x) => !(typeof x === "string" && /^…\d+ more$/.test(x)));
    return items.length <= full.length && items.every((x, i) => compatible(x, full[i], depth + 1));
  }
  if (isObj(clipped)) {
    if (!isObj(full)) return false;
    return Object.keys(clipped).every((k) => k in full && compatible(clipped[k], full[k], depth + 1));
  }
  return clipped === full;
}

/** The value in `root` (a parsed blob) that `clipped` was cut from, searched a few levels deep. */
function findFull(root: unknown, clipped: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof root === "string" && depth > 0 && typeof clipped === "object" && clipped !== null) {
    // Arguments kept as a JSON string (OpenAI-style tool calls).
    if (root.length > 1 && (root[0] === "{" || root[0] === "[")) {
      try {
        const parsed = JSON.parse(root);
        if (compatible(clipped, parsed)) return parsed;
      } catch {
        /* not JSON */
      }
    }
    return undefined;
  }
  if (root === null || typeof root !== "object") return undefined;
  if (compatible(clipped, root)) return root;
  for (const v of Object.values(root as Obj)) {
    const hit = findFull(v, clipped, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Longest string in `root` (a parsed blob) that starts with `prefix`. */
function findString(root: unknown, prefix: string, depth = 0): string | undefined {
  if (typeof root === "string") return root.startsWith(prefix) ? root : undefined;
  if (depth > 5 || root === null || typeof root !== "object") return undefined;
  let best: string | undefined;
  for (const v of Object.values(root as Obj)) {
    const hit = findString(v, prefix, depth + 1);
    if (hit !== undefined && (best === undefined || hit.length > best.length)) best = hit;
  }
  return best;
}

const parseJson = (text: string): unknown => {
  const t = text.trimStart();
  if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- file ops

interface Hunk {
  /** 0-based line in the old file where the old lines start (a hint), when the diff said. */
  hint?: number;
  /** apply_patch `@@ <line>` context to find first. */
  anchor?: string;
  old: string[];
  new: string[];
  /** apply_patch `*** End of File`. */
  eof?: boolean;
}

type Op =
  | { t: "write"; content: string }
  | { t: "read"; content: string; approxEol?: boolean }
  /** The file before this step's edit, reported by the agent (Claude Code originalFile). */
  | { t: "base"; content: string }
  | { t: "replace"; edits: { old: string; new: string; all: boolean }[] }
  | { t: "insert"; line: number; text: string }
  /** Codex apply_patch semantics (first match from a cursor) or a unified diff (`udiff`: hint or unique match). */
  | { t: "hunks"; hunks: Hunk[]; udiff: boolean }
  | { t: "delete" }
  /** Content moved here from another path in this step (apply_patch Move to). */
  | { t: "from"; path: string }
  | { t: "unknown"; why: string };

interface StepOps {
  /** Ops per normalized path, in order. */
  files: Map<string, Op[]>;
  /** Fallback diffs per path, from the step's file.change events (full text). */
  diffs: Map<string, { diff: string; op: "add" | "modify" | "delete" }>;
  /** file.change op per path. */
  changeOps: Map<string, "add" | "modify" | "delete">;
  input?: unknown;
  inputComplete: boolean;
  output?: string;
}

function lineSplit(content: string): { lines: string[]; eol: boolean } {
  if (content === "") return { lines: [], eol: false };
  const eol = content.endsWith("\n");
  return { lines: (eol ? content.slice(0, -1) : content).split("\n"), eol };
}
const lineJoin = (lines: string[], eol: boolean) => (lines.length ? lines.join("\n") + (eol ? "\n" : "") : "");

/** Where `seq` occurs in `lines`, exactly, then ignoring trailing, then all surrounding whitespace. */
function findSeq(lines: string[], seq: string[], from: number, hint?: number, unique = false): number | undefined {
  if (!seq.length) return undefined;
  const norms: ((s: string) => string)[] = [(s) => s, (s) => s.trimEnd(), (s) => s.trim()];
  for (const f of norms) {
    const at = (i: number) => i >= 0 && i + seq.length <= lines.length && seq.every((l, k) => f(lines[i + k]!) === f(l));
    if (hint !== undefined && at(hint)) return hint;
    const hits: number[] = [];
    for (let i = from; i + seq.length <= lines.length; i++) {
      if (at(i)) {
        if (!unique) return i;
        hits.push(i);
        if (hits.length > 1 && hint === undefined) break;
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1 && hint !== undefined) return hits.reduce((a, b) => (Math.abs(b - hint) < Math.abs(a - hint) ? b : a));
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

/** Applies hunks to content; undefined when one cannot be placed. */
function applyHunks(content: string, hunks: Hunk[], udiff: boolean): string | undefined {
  const { lines, eol } = lineSplit(content);
  let out = lines.slice();
  let cursor = 0;
  let delta = 0;
  for (const h of hunks) {
    if (h.anchor !== undefined && h.anchor.trim() !== "") {
      const a = findSeq(out, [h.anchor], cursor);
      if (a === undefined) return undefined;
      cursor = a + 1;
    }
    let at: number | undefined;
    if (!h.old.length) {
      if (udiff && h.hint !== undefined) at = Math.min(out.length, Math.max(0, h.hint + delta));
      else at = h.eof || !udiff ? out.length : cursor;
    } else {
      at = udiff ? findSeq(out, h.old, 0, h.hint !== undefined ? h.hint + delta : undefined, true) : findSeq(out, h.old, cursor);
      if (at === undefined && !udiff && h.eof) at = findSeq(out, h.old, 0);
      if (at === undefined) return undefined;
    }
    out = [...out.slice(0, at), ...h.new, ...out.slice(at + h.old.length)];
    cursor = at + h.new.length;
    delta += h.new.length - h.old.length;
  }
  return lineJoin(out, eol || (lines.length === 0 && out.length > 0));
}

/** Hunks of a unified diff (one file). Header lines are skipped. */
function parseUdiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^(---|\+\+\+) /.test(line) || line.startsWith("diff --git") || /^(index|new file mode|deleted file mode|similarity|rename) /.test(line)) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      cur = { old: [], new: [] };
      if (m) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        cur.hint = count === 0 ? start : Math.max(0, start - 1);
      }
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) cur.new.push(line.slice(1));
    else if (line.startsWith("-")) cur.old.push(line.slice(1));
    else if (line.startsWith(" ") || line === "") {
      cur.old.push(line.slice(1));
      cur.new.push(line.slice(1));
    }
  }
  // A trailing empty line from the final "\n" is not context.
  for (const h of hunks) {
    while (h.old.length && h.new.length && h.old.at(-1) === "" && h.new.at(-1) === "" && diff.endsWith("\n")) {
      h.old.pop();
      h.new.pop();
      break;
    }
  }
  return hunks.filter((h) => h.old.length || h.new.length);
}

/** `+` lines of an add diff as file content. */
function addedContent(diff: string): string {
  const lines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++ "));
  return lines.length ? lines.map((l) => l.slice(1)).join("\n") + "\n" : "";
}

interface PatchFile {
  path: string;
  kind: "add" | "update" | "delete";
  moveTo?: string;
  content?: string;
  hunks: Hunk[];
}

/** An apply_patch envelope (`*** Begin Patch` … `*** End Patch`). */
function parseApplyPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | undefined;
  let hunk: Hunk | undefined;
  const added: string[] = [];
  const flushAdd = () => {
    if (cur?.kind === "add") cur.content = added.length ? added.join("\n") + "\n" : "";
    added.length = 0;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line))) {
      flushAdd();
      cur = { path: m[2]!.trim(), kind: m[1] === "Add" ? "add" : m[1] === "Delete" ? "delete" : "update", hunks: [] };
      files.push(cur);
      hunk = undefined;
      continue;
    }
    if (!cur) continue;
    if ((m = /^\*\*\* Move to: (.+)$/.exec(line))) {
      cur.moveTo = m[1]!.trim();
      continue;
    }
    if (line === "*** End Patch" || line === "*** Begin Patch") continue;
    if (line === "*** End of File") {
      if (hunk) hunk.eof = true;
      continue;
    }
    if (cur.kind === "add") {
      if (line.startsWith("+")) added.push(line.slice(1));
      continue;
    }
    if (cur.kind !== "update") continue;
    if (line.startsWith("@@")) {
      hunk = { old: [], new: [], anchor: line.slice(2).trim() || undefined };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      hunk = { old: [], new: [] };
      cur.hunks.push(hunk);
    }
    if (line.startsWith("+")) hunk.new.push(line.slice(1));
    else if (line.startsWith("-")) hunk.old.push(line.slice(1));
    else if (line.startsWith(" ") || line === "") {
      hunk.old.push(line.slice(1));
      hunk.new.push(line.slice(1));
    }
  }
  flushAdd();
  for (const f of files) {
    f.hunks = f.hunks.filter((h) => h.old.length || h.new.length);
    // A blank last line inside a hunk is usually the patch's own line break.
    for (const h of f.hunks) {
      if (h.old.at(-1) === "" && h.new.at(-1) === "") {
        h.old.pop();
        h.new.pop();
      }
    }
  }
  return files;
}

/** Per-file diffs of a git diff (`diff --git a/x b/x` sections). */
function splitGitDiff(text: string): { path: string; diff: string; op: "add" | "modify" | "delete" }[] {
  const out: { path: string; diff: string; op: "add" | "modify" | "delete" }[] = [];
  let cur: { path: string; lines: string[]; op: "add" | "modify" | "delete" } | undefined;
  for (const line of text.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      if (cur) out.push({ path: cur.path, diff: cur.lines.join("\n") + "\n", op: cur.op });
      cur = { path: m[2]!, lines: [], op: "modify" };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.op = "add";
    else if (line.startsWith("deleted file mode")) cur.op = "delete";
    cur.lines.push(line);
  }
  if (cur) out.push({ path: cur.path, diff: cur.lines.join("\n") + "\n", op: cur.op });
  return out;
}

// ---------------------------------------------------------------- reads

/** Line range a read asked for, when it asked for one. */
function readRange(input: unknown): { start: number; count?: number } | undefined {
  if (!isObj(input)) return undefined;
  const vr = input.view_range;
  if (Array.isArray(vr) && typeof vr[0] === "number") {
    const end = typeof vr[1] === "number" && vr[1] > 0 ? vr[1] : undefined;
    return { start: vr[0], count: end !== undefined ? end - vr[0] + 1 : undefined };
  }
  const startLine = num(input.StartLine) ?? num(input.start_line) ?? num(input.startLine);
  const endLine = num(input.EndLine) ?? num(input.end_line) ?? num(input.endLine);
  if (startLine !== undefined || endLine !== undefined) {
    const s = startLine ?? 1;
    return { start: s, count: endLine !== undefined ? endLine - s + 1 : undefined };
  }
  const offset = num(input.offset);
  const limit = num(input.limit);
  if (offset !== undefined || limit !== undefined) return { start: Math.max(1, offset ?? 1), count: limit };
  return undefined;
}

const NUMBERED = /^\s*(\d+)(→|\t|: ?|\| ?)(.*)$/;

/** Lines of `cat -n`-style output (`     1→x`, `1: x`, `00001| x`), when every line is numbered in sequence. */
function numbered(text: string): { first: number; lines: string[] } | undefined {
  const rows = text.replace(/\n$/, "").split("\n");
  if (!rows.length || rows[0] === "") return undefined;
  const lines: string[] = [];
  let first = -1;
  for (const [i, r] of rows.entries()) {
    const m = NUMBERED.exec(r);
    if (!m) return undefined;
    const n = Number(m[1]);
    if (i === 0) first = n;
    else if (n !== first + i) return undefined;
    lines.push(m[3]!);
  }
  return { first, lines };
}

/** Text Claude Code appends to tool results (`<system-reminder>` blocks). */
const stripReminders = (t: string) => t.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "\n").replace(/^\n+/, "");

/**
 * The whole file a read returned, or undefined when it may be partial or its
 * shape is not known. `plainOk`: the tool returns the raw file (Cursor Read,
 * Gemini read_file).
 */
function readContent(input: unknown, output: string, plainOk: boolean): { content: string; approxEol?: boolean } | undefined {
  const parsed = parseJson(output);
  if (isObj(parsed)) {
    // Claude Code hook: {type: "text", file: {content, startLine, numLines, totalLines}}.
    const f = isObj(parsed.file) ? parsed.file : undefined;
    if (!f || typeof f.content !== "string") return undefined;
    const start = num(f.startLine) ?? 1;
    const total = num(f.totalLines);
    const n = num(f.numLines);
    if (start > 1 || (total !== undefined && n !== undefined && n < total)) return undefined;
    return { content: f.content === "" || f.content.endsWith("\n") ? f.content : f.content + "\n", approxEol: !f.content.endsWith("\n") || undefined };
  }
  if (parsed !== undefined) return undefined;
  let text = output;
  const hadReminder = text.includes("<system-reminder>");
  text = stripReminders(text);
  if (hadReminder && /the file exists but the contents are empty|contents are empty/i.test(output) && text.trim() === "") return { content: "" };
  // OpenCode: <file>\n00001| …\n(End of file - total N lines)\n</file>
  let complete: boolean | undefined;
  const wrapped = /^<file>\n([\s\S]*?)\n?<\/file>\s*$/.exec(text);
  if (wrapped) text = wrapped[1]!;
  const tail = /\n*\((End of file - total \d+ lines|File has more lines[^)]*)\)\s*$/.exec(text);
  if (tail) {
    complete = tail[1]!.startsWith("End of file");
    text = text.slice(0, tail.index);
  }
  if (complete === false) return undefined;
  const range = readRange(input);
  const nl = numbered(text);
  if (nl) {
    if (nl.first !== 1) return undefined;
    if (range && range.start > 1) return undefined;
    if (complete !== true) {
      if (range?.count !== undefined && nl.lines.length >= range.count) return undefined;
      if (range?.count === undefined && nl.lines.length >= READ_LINE_CAP) return undefined;
    }
    // Newer Claude Code numbers the empty line after a final newline ("3\t"): the ending is then known.
    if (nl.lines.length > 1 && nl.lines.at(-1) === "") return { content: nl.lines.slice(0, -1).join("\n") + "\n" };
    return { content: nl.lines.join("\n") + "\n", approxEol: true };
  }
  if (!plainOk || range) return undefined;
  return { content: text };
}

// ---------------------------------------------------------------- the replay

interface StepRec {
  step: ReplayStep;
  start?: AgentEvent;
  end?: AgentEvent;
  ev?: AgentEvent;
  changes: AgentEvent[];
  tests: AgentEvent[];
  /** Tool input from the raw payload, when there is no tool.start (a lone PostToolUse). */
  rawInput?: unknown;
}

/** The tool input in a raw hook payload ({tool_input}, {toolCall: {args}}, …). */
function rawToolInput(raw: unknown, depth = 0): unknown {
  if (!isObj(raw) || depth > 2) return undefined;
  for (const k of ["tool_input", "toolInput", "input", "args", "arguments", "parameters"]) {
    const v = raw[k];
    if (isObj(v) || (typeof v === "string" && v !== "")) {
      if (typeof v === "string" && (k === "arguments" || k === "args")) {
        const parsed = parseJson(v);
        if (isObj(parsed)) return parsed;
      }
      return v;
    }
  }
  for (const k of ["toolCall", "tool_call", "tool", "call"]) {
    const hit = rawToolInput(raw[k], depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

interface Track {
  /** Step indices (0-based) that touch the path, ascending. */
  touches: number[];
  /** states[k] = state after touches[k], computed in order. */
  states: FileState[];
  base?: Promise<FileState>;
  lock: Promise<unknown>;
}

const sameText = (a: string, b: string) => a === b || a.replace(/\n+$/, "") === b.replace(/\n+$/, "");

export class Replay {
  readonly session: Session;
  readonly root: string | undefined;
  readonly steps: ReplayStep[] = [];
  private readonly recs: StepRec[] = [];
  private readonly tracks = new Map<string, Track>();
  private readonly resolved = new Map<number, Promise<StepOps>>();
  private readonly opts: ReplayOptions;

  constructor(session: Session, events: readonly AgentEvent[], opts: ReplayOptions) {
    this.session = session;
    this.opts = opts;
    const root = session.repo?.root ?? session.cwd ?? events.find((e) => e.cwd)?.cwd;
    this.root = root ? slash(root).replace(/\/+$/, "") || "/" : undefined;
    this.build(events);
  }

  /**
   * A replay of the session. Reads the raw payload of tool calls that have
   * an end but no start (their input is only there), so labels and file
   * lists are complete.
   */
  static async load(session: Session, events: readonly AgentEvent[], opts: ReplayOptions): Promise<Replay> {
    const r = new Replay(session, events, opts);
    await r.fillRawInputs();
    return r;
  }

  private async fillRawInputs(): Promise<void> {
    const lone = this.recs.map((r, i) => [r, i] as const).filter(([r]) => !r.start && r.end?.blobs?.length);
    await Promise.all(
      lone.map(async ([r, i]) => {
        const b = await this.blobJson(r.end!.blobs![0]!);
        const input = rawToolInput(b.json);
        if (input === undefined) return;
        r.rawInput = input;
        this.describe(r);
        for (const f of r.step.files ?? []) this.touch(f.path, i);
      }),
    );
  }

  /** A path relative to the root when inside it ("/"-separated); else absolute, or as given. */
  norm(p: string, cwd?: string): string {
    let s = slash(p);
    if (!isAbs(s)) {
      const base = cwd ? slash(cwd) : this.root;
      if (!base) return posix.normalize(s).replace(/^\.\//, "");
      s = posix.join(base, s);
    } else s = posix.normalize(s);
    const r = this.root;
    if (r && s.startsWith(r === "/" ? "/" : r + "/")) return s.slice(r === "/" ? 1 : r.length + 1);
    return s;
  }

  private build(events: readonly AgentEvent[]): void {
    const order = events.map((e, i) => [e, i] as const).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map((x) => x[0]);
    const byTool = new Map<string, StepRec>();
    const wrappers = new Set<string>();
    /** Tool calls with no id still waiting for their end, oldest first. */
    const open: StepRec[] = [];
    let lastTool: StepRec | undefined;
    const add = (rec: Omit<StepRec, "step" | "changes" | "tests"> & { kind: StepKind; ts: number; eventId: string }): StepRec => {
      const r: StepRec = { start: rec.start, end: rec.end, ev: rec.ev, changes: [], tests: [], step: { n: this.recs.length + 1, ts: rec.ts, kind: rec.kind, label: "", eventId: rec.eventId } };
      this.recs.push(r);
      return r;
    };
    for (const e of order) {
      const p = e.payload;
      const id = str(p.toolUseId);
      switch (e.kind) {
        case "user.message":
          add({ kind: "prompt", ts: e.ts, eventId: e.id, ev: e });
          break;
        case "assistant.message":
          add({ kind: "reply", ts: e.ts, eventId: e.id, ev: e });
          break;
        case "tool.start": {
          if (p.wrapper === true) {
            if (id) wrappers.add(id);
            break;
          }
          const prev = id ? byTool.get(id) : undefined;
          if (prev && !prev.start) {
            prev.start = e;
            prev.step.eventId = e.id;
            break;
          }
          if (prev) break; // a second start for one call
          const r = add({ kind: "tool", ts: e.ts, eventId: e.id, start: e });
          if (id) byTool.set(id, r);
          else open.push(r);
          lastTool = r;
          break;
        }
        case "tool.end": {
          if (p.wrapper === true || (id && wrappers.has(id))) break;
          const prev = id ? byTool.get(id) : undefined;
          if (prev) {
            prev.end ??= e;
            break;
          }
          if (!id) {
            // No id (Gemini CLI hooks): the oldest open call of the same tool.
            const k = open.findIndex((o) => str(o.start?.payload.tool) === str(p.tool));
            if (k >= 0) {
              open[k]!.end = e;
              open.splice(k, 1);
              break;
            }
          }
          const r = add({ kind: "tool", ts: e.ts, eventId: e.id, end: e });
          if (id) byTool.set(id, r);
          lastTool = r;
          break;
        }
        case "file.change": {
          let prev = id ? byTool.get(id) : undefined;
          // No id: the last tool call, when it named this file.
          if (!prev && !id && lastTool && this.recs.at(-1) === lastTool && str(p.path) && EDITS.has(familyOf(str(lastTool.start?.payload.tool) ?? str(lastTool.end?.payload.tool) ?? "", lastTool.start?.payload.input))) {
            const named = pathOf(lastTool.start?.payload.input);
            const cwd = lastTool.start?.cwd ?? lastTool.end?.cwd;
            if ((named && this.norm(named, cwd) === this.norm(str(p.path)!, e.cwd)) || lastTool.changes.some((c) => str(c.payload.path) === str(p.path))) prev = lastTool;
          }
          if (prev) prev.changes.push(e);
          else {
            const r = add({ kind: "change", ts: e.ts, eventId: e.id, ev: e });
            r.changes.push(e);
            if (id) byTool.set(id, r);
          }
          break;
        }
        case "test.result": {
          const prev = id ? byTool.get(id) : undefined;
          if (prev) prev.tests.push(e);
          else add({ kind: "test", ts: e.ts, eventId: e.id, ev: e }).tests.push(e);
          break;
        }
        case "subagent.start":
          if (id && byTool.has(id)) break;
          add({ kind: "subagent", ts: e.ts, eventId: e.id, ev: e });
          break;
        case "context.compact":
          add({ kind: "compact", ts: e.ts, eventId: e.id, ev: e });
          break;
        case "error":
          add({ kind: "error", ts: e.ts, eventId: e.id, ev: e });
          break;
        default:
          break;
      }
    }
    for (const [i, r] of this.recs.entries()) {
      this.describe(r);
      this.steps.push(r.step);
      for (const f of r.step.files ?? []) this.touch(f.path, i);
    }
  }

  private touch(path: string, idx: number): void {
    let t = this.tracks.get(path);
    if (!t) this.tracks.set(path, (t = { touches: [], states: [], lock: Promise.resolve() }));
    if (t.touches.at(-1) !== idx) {
      if (t.touches.length && t.touches.at(-1)! > idx) {
        // A path found while resolving an earlier step: keep order, drop computed states after it.
        const at = t.touches.findIndex((x) => x > idx);
        if (t.touches[at - 1] === idx) return;
        t.touches.splice(at, 0, idx);
        t.states.length = Math.min(t.states.length, at);
      } else t.touches.push(idx);
    }
  }

  /** Label, kind, tool facts and named files of a step, from its events only. */
  private describe(r: StepRec): void {
    const s = r.step;
    const ev = r.ev;
    if (s.kind === "prompt" || s.kind === "reply") {
      s.label = oneLine(str(ev!.payload.text) ?? "") || (s.kind === "prompt" ? "Prompt" : "Reply");
      return;
    }
    if (s.kind === "compact") {
      const t = str(ev!.payload.trigger);
      s.label = `Context compacted${t ? ` (${t})` : ""}`;
      return;
    }
    if (s.kind === "error") {
      s.label = oneLine(str(ev!.payload.message) ?? str(ev!.payload.error) ?? "Error");
      s.ok = false;
      return;
    }
    if (s.kind === "subagent") {
      const p = ev!.payload;
      s.label = `Subagent ${oneLine([str(p.type), str(p.description) ?? str(p.prompt)].filter(Boolean).join(": "), 100)}`.trim();
      return;
    }
    if (s.kind === "test") {
      const p = ev!.payload;
      s.label = `Tests: ${num(p.passed) ?? 0} passed, ${num(p.failed) ?? 0} failed`;
      s.ok = (num(p.failed) ?? 0) === 0;
      return;
    }
    const files = new Map<string, TouchOp>();
    const named = (path: string, op: TouchOp, cwd?: string) => {
      const p = this.norm(path, cwd);
      const had = files.get(p);
      if (!had || had === "read" || op === "delete" || (op === "add" && had === "modify")) files.set(p, op);
    };
    if (s.kind === "change") {
      for (const c of r.changes) named(str(c.payload.path) ?? "", (str(c.payload.op) as TouchOp) ?? "modify", c.cwd);
      const [first] = files.keys();
      s.label = `${files.get(first!) === "add" ? "Created" : files.get(first!) === "delete" ? "Deleted" : "Changed"} ${first ?? "a file"}${files.size > 1 ? ` +${files.size - 1}` : ""}`;
      s.files = [...files].map(([path, op]) => ({ path, op }));
      return;
    }
    // A tool call.
    const start = r.start?.payload ?? {};
    const end = r.end?.payload ?? {};
    const tool = str(start.tool) ?? str(end.tool) ?? "tool";
    const input = start.input ?? r.rawInput;
    const cwd = r.start?.cwd ?? r.end?.cwd;
    s.tool = tool;
    const ok = typeof end.ok === "boolean" ? end.ok : undefined;
    if (ok !== undefined) s.ok = ok;
    const dur = r.end?.durationMs ?? num(end.durationMs);
    if (dur !== undefined) s.durationMs = dur;
    const fam = familyOf(tool, input);
    const path = pathOf(input);
    for (const c of r.changes) if (str(c.payload.path)) named(str(c.payload.path)!, (str(c.payload.op) as TouchOp) ?? "modify", c.cwd);
    // A failed call changed nothing (its label still names the file).
    if (ok === false) {
      /* nothing */
    } else if (fam === "write" && path) named(path, "modify", cwd);
    else if ((fam === "edit" || fam === "multi" || fam === "notebook") && path) named(path, "modify", cwd);
    else if (fam === "delete" && path) named(path, "delete", cwd);
    else if (fam === "read" && path) named(path, "read", cwd);
    else if (fam === "patch") {
      const text = patchTextOf(input) ?? "";
      for (const m of text.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) named(m[2]!.trim(), m[1] === "Add" ? "add" : m[1] === "Delete" ? "delete" : "modify", cwd);
      for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) named(m[1]!.trim(), "add", cwd);
      for (const m of text.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) named(m[1]!, "modify", cwd);
    }
    const command = fam === "shell" ? commandOf(input) : undefined;
    if (command !== undefined && ok === true) {
      const cat = catPath(command);
      if (cat) named(cat, "read", cwd);
    }
    if (files.size) s.files = [...files].map(([p, op]) => ({ path: p, op }));
    const changed = [...files.values()].some((op) => op !== "read");
    s.kind = fam === "shell" ? "shell" : changed || fam === "write" || fam === "edit" || fam === "multi" || fam === "patch" || fam === "delete" ? "edit" : fam === "read" ? "read" : "tool";
    if (command !== undefined) s.label = `$ ${oneLine(command, 110)}`;
    else {
      const [first] = [...files].filter(([, op]) => op !== "read").map(([p]) => p);
      const target = first ?? path ?? (isObj(input) ? (pick(input, "pattern", "query", "url", "skill", "description", "prompt", "task") ?? "") : typeof input === "string" ? input : "");
      const extra = files.size > 1 && first ? ` +${files.size - 1}` : "";
      s.label = oneLine(`${tool} ${first ?? (path ? this.norm(path, cwd) : target)}${extra}`, 120);
    }
  }

  /** The step index (paths, steps, root) for lists and scrubbers. */
  index(): ReplayIndex {
    return { sessionId: this.session.id, ...(this.root ? { root: this.root } : {}), steps: this.steps, files: [...this.tracks.keys()].sort(), baseline: this.opts.baseline ? "snapshot" : "none" };
  }

  // ------------------------------------------------------------ blobs

  private async blobJson(ref: string): Promise<{ text?: string; json?: unknown }> {
    const text = await this.opts.blob(ref).catch(() => undefined);
    if (text === undefined) return {};
    return { text, json: parseJson(text) };
  }

  /** The tool input, from the blobs when the stored one was cut. */
  private async fullInput(r: StepRec): Promise<{ value: unknown; complete: boolean }> {
    const v = r.start?.payload.input ?? r.rawInput;
    if (v === undefined || !looksClipped(v)) return { value: v, complete: v !== undefined };
    const refs = [...new Set([...(r.start?.blobs ?? []), ...(r.end?.blobs ?? [])])];
    for (const ref of refs) {
      const b = await this.blobJson(ref);
      if (b.text === undefined) continue;
      if (typeof v === "string" && b.text.startsWith(v.slice(0, -1))) return { value: b.text, complete: true };
      const hit = b.json !== undefined ? (typeof v === "string" ? findString(b.json, v.slice(0, -1)) : findFull(b.json, v)) : undefined;
      if (hit !== undefined) return { value: hit, complete: true };
    }
    return { value: v, complete: false };
  }

  /** The tool output text, from the blobs when the stored one was cut. */
  private async fullOutput(r: StepRec): Promise<{ text?: string; complete: boolean }> {
    const o = r.end?.payload.output;
    const text = typeof o === "string" ? o : o === undefined ? undefined : JSON.stringify(o);
    if (text === undefined || !text.endsWith("…") || !r.end?.blobs?.length) return { text, complete: text !== undefined && !(text.endsWith("…") && text.length >= 64) };
    const prefix = text.slice(0, -1);
    for (const ref of r.end.blobs) {
      const b = await this.blobJson(ref);
      if (b.text === undefined) continue;
      if (b.text.startsWith(prefix)) return { text: b.text, complete: true };
      const hit = b.json !== undefined ? findString(b.json, prefix) : undefined;
      if (hit !== undefined) return { text: hit, complete: true };
    }
    return { text, complete: false };
  }

  /** A file.change's whole diff (from its blob when the stored one was cut). */
  private async fullDiff(c: AgentEvent): Promise<string | undefined> {
    const d = str(c.payload.diff);
    if (!d || c.payload.diffTruncated !== true) return d;
    for (const ref of c.blobs ?? []) {
      const t = await this.opts.blob(ref).catch(() => undefined);
      if (t !== undefined && t.startsWith(d)) return t;
    }
    return undefined;
  }

  /** `edits` an agent recorded for a file in the change's raw payload (Cursor afterFileEdit). */
  private async rawEdits(c: AgentEvent, path: string): Promise<{ old: string; new: string; all: boolean }[] | undefined> {
    for (const ref of c.blobs ?? []) {
      const b = await this.blobJson(ref);
      const hit = findEdits(b.json, (p) => this.norm(p, c.cwd) === path);
      if (hit) return hit;
    }
    return undefined;
  }

  // ------------------------------------------------------------ per-step ops

  private ops(idx: number): Promise<StepOps> {
    let p = this.resolved.get(idx);
    if (!p) {
      p = this.resolve(idx);
      this.resolved.set(idx, p);
    }
    return p;
  }

  private async resolve(idx: number): Promise<StepOps> {
    const r = this.recs[idx]!;
    const s = r.step;
    const out: StepOps = { files: new Map(), diffs: new Map(), changeOps: new Map(), inputComplete: true };
    const push = (path: string, op: Op) => {
      const list = out.files.get(path);
      if (list) list.push(op);
      else out.files.set(path, [op]);
      this.touch(path, idx);
    };
    const n = s.n;
    if (r.start || r.end) {
      const tool = s.tool ?? "tool";
      const cwd = r.start?.cwd ?? r.end?.cwd;
      const fam = familyOf(tool, r.start?.payload.input ?? r.rawInput);
      const ok = s.ok;
      const applied = ok === true || (ok === undefined && r.changes.length > 0);
      const relevant = fam !== "other" && fam !== "notebook";
      const inp = relevant ? await this.fullInput(r) : { value: r.start?.payload.input ?? r.rawInput, complete: true };
      out.input = inp.value;
      out.inputComplete = inp.complete;
      const input = isObj(inp.value) ? inp.value : {};
      const rawPath = pathOf(inp.value);
      const path = rawPath ? this.norm(rawPath, cwd) : undefined;
      const needsOutput = fam === "read" || fam === "edit" || fam === "write" || fam === "multi" || (fam === "shell" && ok === true);
      const outp = needsOutput && r.end ? await this.fullOutput(r) : undefined;
      out.output = outp?.text;
      const noResult = `Step ${n}'s result was not recorded, so whether its change was applied is unknown.`;
      const clipped = `Step ${n}'s input was cut short when stored and its full text is not in the blob store.`;
      if (fam === "read") {
        if (ok === true && path && outp?.text !== undefined && outp.complete) {
          const rc = readContent(inp.value, outp.text, (toolKey(tool) === "read" && this.session.agent === "cursor") || toolKey(tool) === "read_file");
          if (rc) push(path, { t: "read", content: rc.content, approxEol: rc.approxEol });
        }
      } else if (fam === "shell") {
        const command = commandOf(inp.value);
        const cat = command !== undefined ? catPath(command) : undefined;
        if (cat && ok === true && outp?.text !== undefined && outp.complete && !looksLikeWrapperOutput(outp.text)) push(this.norm(cat, cwd), { t: "read", content: outp.text });
      } else if (fam === "write" || fam === "edit" || fam === "multi" || fam === "delete" || fam === "patch") {
        if (ok === false) {
          // A failed edit changed nothing (its file.change events, if any, still apply below).
        } else if (!applied) {
          if (path) push(path, { t: "unknown", why: noResult });
          else if (fam === "patch") for (const f of parseApplyPatch(patchTextOf(inp.value) ?? "")) push(this.norm(f.path, cwd), { t: "unknown", why: noResult });
        } else if (!inp.complete) {
          if (path) push(path, { t: "unknown", why: clipped });
          else for (const f of s.files ?? []) if (f.op !== "read") push(f.path, { t: "unknown", why: clipped });
        } else if (fam === "patch") {
          const text = patchTextOf(inp.value) ?? "";
          if (/^\*\*\* Begin Patch/m.test(text) || /^\*\*\* (Add|Update|Delete) File: /m.test(text)) {
            for (const f of parseApplyPatch(text)) {
              const p = this.norm(f.path, cwd);
              if (f.kind === "add") push(p, { t: "write", content: f.content ?? "" });
              else if (f.kind === "delete") push(p, { t: "delete" });
              else {
                if (f.hunks.length) push(p, { t: "hunks", hunks: f.hunks, udiff: false });
                if (f.moveTo) {
                  const to = this.norm(f.moveTo, cwd);
                  push(to, { t: "from", path: p });
                  push(p, { t: "delete" });
                }
              }
            }
          } else if (/^diff --git /m.test(text)) {
            for (const f of splitGitDiff(text)) {
              const p = this.norm(f.path, cwd);
              if (f.op === "delete") push(p, { t: "delete" });
              else if (f.op === "add") push(p, { t: "write", content: addedContent(f.diff) });
              else push(p, { t: "hunks", hunks: parseUdiff(f.diff), udiff: true });
            }
          }
        } else if (path) {
          // Claude Code reports the file as it was before the edit.
          const resp = outp?.text !== undefined && outp.complete ? parseJson(outp.text) : undefined;
          const original = isObj(resp) ? str(resp.originalFile) : undefined;
          if (original !== undefined && fam !== "write") push(path, { t: "base", content: original });
          const op = editOp(fam, input, n);
          if (op) push(path, op);
        }
      }
    }
    // The step's file.change events: diffs for display, and the change itself when the input gave none.
    for (const c of r.changes) {
      const raw = str(c.payload.path);
      if (!raw) continue;
      const p = this.norm(raw, c.cwd);
      const op = (str(c.payload.op) as "add" | "modify" | "delete") ?? "modify";
      out.changeOps.set(p, op);
      const diff = await this.fullDiff(c);
      if (diff) out.diffs.set(p, { diff, op });
      const has = out.files.get(p)?.some((o) => o.t !== "read" && o.t !== "base");
      if (has) continue;
      if (op === "delete") push(p, { t: "delete" });
      else if (diff && /^--- \/dev\/null/m.test(diff)) push(p, { t: "write", content: addedContent(diff) });
      else if (diff && /^@@/m.test(diff)) push(p, { t: "hunks", hunks: parseUdiff(diff), udiff: true });
      else {
        const edits = await this.rawEdits(c, p);
        if (edits?.length) push(p, { t: "replace", edits });
        else push(p, { t: "unknown", why: `Step ${n} changed it, but the change itself is not recorded (only that the file changed).` });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ per-file state

  private baseState(path: string): Promise<FileState> {
    const t = this.tracks.get(path)!;
    if (!t.base) {
      t.base = (async (): Promise<FileState> => {
        const b = this.opts.baseline && !isAbs(path) ? await this.opts.baseline(path).catch(() => undefined) : undefined;
        if (typeof b === "string") return { exists: true, content: b };
        if (b === null) return { exists: false, content: "" };
        return { why: this.opts.baseline ? "The start snapshot has no readable copy of it." : "No step had shown its content yet." };
      })();
    }
    return t.base;
  }

  /** The file after step index `idx` (0-based; -1 = at the start). */
  async stateAt(path: string, idx: number): Promise<FileState> {
    const t = this.tracks.get(path);
    if (!t) return { why: "No step touched it." };
    const run = t.lock.then(() => this.compute(path, t, idx));
    t.lock = run.catch(() => undefined);
    return run;
  }

  private async compute(path: string, t: Track, idx: number): Promise<FileState> {
    let k = 0;
    while (k < t.touches.length && t.touches[k]! <= idx) k++;
    if (k === 0) {
      const base = await this.baseState(path);
      if (base.content !== undefined || !t.touches.length) return base;
      // Unknown at the start, and the first step that touched it created it: it did not exist before.
      const first = t.touches[0]!;
      const created = (await this.ops(first)).changeOps.get(path) === "add";
      if (t.touches[0] !== first) return this.compute(path, t, idx);
      return created ? { exists: false, content: "" } : base;
    }
    while (t.states.length < k) {
      const j = t.states.length;
      let prev = j === 0 ? await this.baseState(path) : t.states[j - 1]!;
      const at = t.touches[j]!;
      const stepOps = await this.ops(at);
      const ops = stepOps.files.get(path) ?? [];
      // Resolving the step may have added touches before this one; start over from them.
      if (t.touches[j] !== at) continue;
      // Unknown so far, and this step created it: it did not exist before.
      if (prev.content === undefined && stepOps.changeOps.get(path) === "add") prev = { exists: false, content: "" };
      t.states.push(await this.apply(prev, ops, at));
    }
    return t.states[k - 1]!;
  }

  private async apply(state: FileState, ops: Op[], idx: number): Promise<FileState> {
    const n = idx + 1;
    let s: FileState = state;
    for (const op of ops) {
      switch (op.t) {
        case "write":
          s = { exists: true, content: op.content };
          break;
        case "read":
        case "base":
          if (s.content === undefined || !sameText(s.content, op.content)) s = { exists: true, content: op.content, ...(op.t === "read" && op.approxEol ? { approxEol: true } : {}) };
          break;
        case "delete":
          s = { exists: false, content: "" };
          break;
        case "unknown":
          s = { why: op.why };
          break;
        case "from": {
          const t = this.tracks.get(op.path);
          if (!t) {
            s = { why: `Step ${n} moved it here from ${op.path}, whose content is unknown.` };
            break;
          }
          const before = await this.stateAt(op.path, idx - 1);
          const srcOps = ((await this.ops(idx)).files.get(op.path) ?? []).filter((o) => o.t !== "delete");
          const moved = await this.apply(before, srcOps, idx);
          s = moved.content !== undefined ? { exists: true, content: moved.content } : { why: `Step ${n} moved it here from ${op.path}, whose content is unknown.` };
          break;
        }
        case "replace": {
          if (s.content === undefined) {
            const create = op.edits.length === 1 && op.edits[0]!.old === "" && s.exists === false;
            s = create ? { exists: true, content: op.edits[0]!.new } : { why: s.exists === false ? `Step ${n} edited it, but it did not exist at that point.` : `Step ${n} edited it before any step showed its content (no earlier read, full write or start snapshot).` };
            break;
          }
          let c = s.content;
          let failed = false;
          for (const e of op.edits) {
            if (e.old === "") {
              if (c === "") c = e.new;
              else failed = true;
            } else if (!c.includes(e.old)) failed = true;
            else c = e.all ? c.split(e.old).join(e.new) : c.replace(e.old, () => e.new);
            if (failed) break;
          }
          s = failed ? { why: `Step ${n}'s edit did not match the reconstructed content.` } : { exists: true, content: c, ...(s.approxEol ? { approxEol: true } : {}) };
          break;
        }
        case "insert": {
          if (s.content === undefined) {
            s = { why: `Step ${n} inserted lines before any step showed its content.` };
            break;
          }
          const { lines, eol } = lineSplit(s.content);
          const at = Math.min(lines.length, Math.max(0, op.line));
          const add = op.text.replace(/\n$/, "").split("\n");
          s = { exists: true, content: lineJoin([...lines.slice(0, at), ...add, ...lines.slice(at)], eol || lines.length === 0) };
          break;
        }
        case "hunks": {
          if (s.content === undefined) {
            s = { why: `Step ${n} patched it before any step showed its content (no earlier read, full write or start snapshot).` };
            break;
          }
          const c = applyHunks(s.content, op.hunks, op.udiff);
          s = c === undefined ? { why: `Step ${n}'s patch could not be placed in the reconstructed content.` } : { exists: true, content: c, ...(s.approxEol ? { approxEol: true } : {}) };
          break;
        }
      }
    }
    return s;
  }

  // ------------------------------------------------------------ views

  private checkStep(n: number): number {
    if (!Number.isInteger(n) || n < 0 || n > this.steps.length) throw new RangeError(`step must be between 0 and ${this.steps.length}`);
    return n;
  }

  /** Touched files as of step n, with what happened to each (events only, no blob reads). */
  tree(n: number): TreeEntry[] {
    const idx = this.checkStep(n) - 1;
    const out: TreeEntry[] = [];
    for (const [path, t] of this.tracks) {
      let edits = 0;
      let first: TouchOp | undefined;
      let last: TouchOp | undefined;
      let lastStep = 0;
      let here = false;
      for (const i of t.touches) {
        if (i > idx) break;
        const op = this.steps[i]!.files?.find((f) => f.path === path)?.op ?? "modify";
        lastStep = i + 1;
        if (i === idx) here = true;
        if (op === "read") continue;
        edits++;
        first ??= op;
        last = op;
      }
      if (!lastStep) continue;
      const status: TreeEntry["status"] = !edits ? "read" : last === "delete" ? "deleted" : first === "add" ? "added" : "modified";
      out.push({ path, status, edits, lastStep, ...(here ? { here: true as const } : {}) });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** What step n changed: one entry per file, with its diff. */
  async changesAt(n: number): Promise<StepChange[]> {
    const idx = this.checkStep(n) - 1;
    if (idx < 0) return [];
    const ops = await this.ops(idx);
    const out: StepChange[] = [];
    const maxDiff = this.opts.maxDiffBytes ?? MAX_DIFF;
    for (const [path, list] of ops.files) {
      if (list.every((o) => o.t === "read" || o.t === "base")) {
        // A read that differed from the reconstruction is a change made outside the agent's edit tools.
        const before = await this.stateAt(path, idx - 1);
        const after = await this.stateAt(path, idx);
        if (before.content !== undefined && after.content !== undefined && !sameText(before.content, after.content)) {
          const d = unifiedDiff(path, before.content, after.content);
          out.push({ path, op: "modify", ...(d ? clipDiff(d, maxDiff) : {}), exact: true, resynced: true });
        }
        continue;
      }
      let before = await this.stateAt(path, idx - 1);
      const after = await this.stateAt(path, idx);
      if (before.content === undefined && ops.changeOps.get(path) === "add") before = { exists: false, content: "" };
      const opFromOps = list.some((o) => o.t === "delete") && after.exists === false ? "delete" : before.exists === false || (before.content === undefined && ops.changeOps.get(path) === "add") ? "add" : undefined;
      const op = opFromOps ?? ops.changeOps.get(path) ?? (list.some((o) => o.t === "write") && before.exists === false ? "add" : "modify");
      if (before.content !== undefined && after.content !== undefined) {
        const d = op === "delete" ? unifiedDiff(path, before.content, "", "delete") : unifiedDiff(path, before.exists === false ? "" : before.content, after.content, op === "add" ? "add" : "modify");
        out.push({ path, op, ...(d ? clipDiff(d, maxDiff) : {}), exact: true });
        continue;
      }
      // Content unknown on one side: the step's own record of the change.
      const fallback = ops.diffs.get(path)?.diff ?? opDiff(path, list, op);
      out.push({ path, op, ...(fallback ? clipDiff(fallback, maxDiff) : {}), exact: false, ...(after.content === undefined ? { why: after.why } : {}) });
    }
    return out;
  }

  /** The file as of step n. */
  async fileAt(path: string, n: number): Promise<FileView> {
    const idx = this.checkStep(n) - 1;
    const p = this.tracks.has(path) ? path : this.norm(path);
    const t = this.tracks.get(p);
    if (!t) return { path: p, why: "No step touched it.", changedAt: 0 };
    const st = await this.stateAt(p, idx);
    let changedAt = 0;
    for (const i of t.touches) if (i <= idx && this.steps[i]!.files?.some((f) => f.path === p && f.op !== "read")) changedAt = i + 1;
    const max = this.opts.maxContentBytes ?? MAX_CONTENT;
    const view: FileView = { path: p, changedAt };
    if (st.exists !== undefined) view.exists = st.exists;
    if (st.content !== undefined) {
      if (Buffer.byteLength(st.content) > max) {
        view.content = cutBytes(st.content, max);
        view.contentTruncated = true;
      } else view.content = st.content;
      if (st.approxEol) view.approxEol = true;
    } else view.why = st.why;
    return view;
  }

  /** Step n: what it was, the tree, its changes, and optionally one file. */
  async at(n: number, opts: { file?: string } = {}): Promise<StepView> {
    this.checkStep(n);
    if (n === 0) throw new RangeError(`step must be between 1 and ${this.steps.length}`);
    const r = this.recs[n - 1]!;
    const changes = await this.changesAt(n);
    const detail: StepView["detail"] = {};
    if (r.ev && (r.step.kind === "prompt" || r.step.kind === "reply")) {
      detail.text = str(r.ev.payload.text) ?? "";
      if (r.ev.payload.truncated === true) detail.textTruncated = true;
    } else if (r.start || r.end) {
      const ops = await this.ops(n - 1);
      const input = r.start?.payload.input ?? r.rawInput;
      if (input !== undefined) detail.input = input;
      const out = r.end?.payload.output;
      const outText = typeof out === "string" ? out : out === undefined ? undefined : JSON.stringify(out);
      const blobRef = outputBlob(r.end, outText);
      if (r.step.kind === "shell") {
        const command = commandOf(ops.input ?? r.start?.payload.input ?? r.rawInput) ?? "";
        const shell: ShellDetail = { command };
        if (r.step.ok !== undefined) shell.ok = r.step.ok;
        const code = exitCodeOf(r.end, outText);
        if (code !== undefined) shell.exitCode = code;
        if (r.step.durationMs !== undefined) shell.durationMs = r.step.durationMs;
        if (outText !== undefined) shell.output = outText;
        if (blobRef) {
          shell.outputTruncated = true;
          shell.outputBlob = blobRef;
        }
        detail.shell = shell;
      } else if (outText !== undefined) {
        detail.output = outText;
        if (blobRef) {
          detail.outputTruncated = true;
          detail.outputBlob = blobRef;
        }
      }
    } else if (r.ev) {
      const p = r.ev.payload;
      const t = str(p.message) ?? str(p.error) ?? str(p.description) ?? str(p.prompt);
      if (t) detail.text = t;
    }
    const view: StepView = { sessionId: this.session.id, steps: this.steps.length, step: r.step, detail, tree: this.tree(n), changes };
    if (opts.file) view.file = await this.fileAt(opts.file, n);
    return view;
  }

  /** What steps `first` through `last` changed together: the state before `first` against the state after `last`. */
  async range(first: number, last: number): Promise<RangeView> {
    this.checkStep(first);
    this.checkStep(last);
    if (first > last) [first, last] = [last, first];
    if (first < 1) throw new RangeError(`step must be between 1 and ${this.steps.length}`);
    // Step indices: the range covers indices from..to-1; the states compared are after index from-1 and after to-1.
    const from = first - 1;
    const to = last;
    const maxDiff = this.opts.maxDiffBytes ?? MAX_DIFF;
    const files: RangeFile[] = [];
    const unchanged: string[] = [];
    for (const [path, t] of [...this.tracks].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const steps: number[] = [];
      for (const i of t.touches) if (i >= from && i < to && this.steps[i]!.files?.some((f) => f.path === path && f.op !== "read")) steps.push(i + 1);
      // Reads inside the range can re-sync a file changed outside the edit tools; resolve them too.
      const inRange = t.touches.filter((i) => i >= from && i < to);
      if (!inRange.length) continue;
      if (!steps.length) {
        for (const i of inRange) {
          const ops = (await this.ops(i)).files.get(path) ?? [];
          if (ops.some((o) => o.t !== "read" && o.t !== "base")) steps.push(i + 1);
        }
        if (!steps.length) {
          const a = await this.stateAt(path, from - 1);
          const b = await this.stateAt(path, to - 1);
          if (a.content === undefined || b.content === undefined || sameText(a.content, b.content)) continue;
          steps.push(...inRange.map((i) => i + 1));
        }
      }
      let a = await this.stateAt(path, from - 1);
      const b = await this.stateAt(path, to - 1);
      // Unknown before the range, and its first step created it: it did not exist.
      if (a.content === undefined && (await this.ops(steps[0]! - 1)).changeOps.get(path) === "add") a = { exists: false, content: "" };
      // Unknown before the range but read inside it before the first change: nothing changed it in between.
      if (a.content === undefined && steps[0]! - 2 >= from) {
        const before = await this.stateAt(path, steps[0]! - 2);
        if (before.content !== undefined) a = before;
      }
      const op: RangeFile["op"] = b.exists === false && a.exists !== false ? "delete" : a.exists === false && b.exists !== false ? "add" : "modify";
      if (a.content !== undefined && b.content !== undefined) {
        if (a.exists === b.exists && sameText(a.content, b.content)) {
          unchanged.push(path);
          continue;
        }
        const d = op === "delete" ? unifiedDiff(path, a.content, "", "delete") : unifiedDiff(path, a.exists === false ? "" : a.content, b.content, op === "add" ? "add" : "modify");
        files.push({ path, op, steps, ...(d ? clipDiff(d, maxDiff) : {}), exact: true });
        continue;
      }
      // Unknown at one end: the steps' own diffs, in order.
      const parts: string[] = [];
      for (const sn of steps) {
        const c = (await this.changesAt(sn)).find((x) => x.path === path);
        if (c?.diff) parts.push(`# step ${sn}${c.exact ? "" : " (as recorded)"}\n${c.diff}`);
      }
      const why = b.content === undefined ? b.why : a.why;
      files.push({ path, op, steps, ...(parts.length ? clipDiff(parts.join(""), maxDiff) : {}), exact: false, ...(why ? { why } : {}) });
    }
    return { sessionId: this.session.id, from: first, to: last, files, unchanged };
  }
}

/** Edits a Cursor afterFileEdit-style payload records for one file. */
function findEdits(root: unknown, matches: (path: string) => boolean, depth = 0): { old: string; new: string; all: boolean }[] | undefined {
  if (depth > 4 || !isObj(root)) return undefined;
  const p = pathOf(root);
  if (p && matches(p) && Array.isArray(root.edits)) {
    const edits = root.edits.filter(isObj).map((e) => ({ old: pick(e, "old_string", "oldString", "old_str") ?? "", new: pick(e, "new_string", "newString", "new_str") ?? "", all: truthy(e.replace_all) }));
    if (edits.length && edits.every((e) => e.old !== "" || e.new !== "")) return edits;
  }
  for (const v of Object.values(root)) {
    const hit = findEdits(v, matches, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** The op an edit-family call's input describes, or an unknown op when it cannot be read. */
function editOp(fam: Family, input: Obj, n: number): Op | undefined {
  const cmd = str(input.command);
  if (fam === "write") {
    const content = pick(input, "content", "contents", "file_text", "fileText", "CodeContent", "text");
    return content !== undefined ? { t: "write", content } : { t: "unknown", why: `Step ${n} wrote it, but the written content is not in its input.` };
  }
  if (fam === "delete") return { t: "delete" };
  if (fam === "multi") {
    const list = Array.isArray(input.edits) ? input.edits : Array.isArray(input.ReplacementChunks) ? input.ReplacementChunks : [];
    const edits = list.filter(isObj).map((e) => ({
      old: pick(e, "old_string", "oldString", "old_str", "oldText", "TargetContent") ?? "",
      new: pick(e, "new_string", "newString", "new_str", "newText", "ReplacementContent") ?? "",
      all: truthy(e.replace_all) || truthy(e.replaceAll) || truthy(e.AllowMultiple),
    }));
    return edits.length ? { t: "replace", edits } : { t: "unknown", why: `Step ${n} edited it, but its edits are not in its input.` };
  }
  // edit
  if (cmd === "insert") {
    const line = num(input.insert_line) ?? num(input.line);
    const text = pick(input, "new_str", "text", "insert_text");
    return line !== undefined && text !== undefined ? { t: "insert", line, text } : { t: "unknown", why: `Step ${n} inserted lines that its input does not record.` };
  }
  if (cmd === "undo_edit") return { t: "unknown", why: `Step ${n} undid an earlier edit, which the trace does not record.` };
  if (Array.isArray(input.edits)) return editOp("multi", input, n);
  const old = pick(input, "old_string", "oldString", "old_str", "oldText", "old_text", "TargetContent", "search", "old");
  const nu = pick(input, "new_string", "newString", "new_str", "newText", "new_text", "ReplacementContent", "replace", "new");
  if (old === undefined || nu === undefined) {
    if (old === undefined && nu !== undefined) return { t: "unknown", why: `Step ${n} replaced text its input does not name (only the new text is recorded).` };
    return { t: "unknown", why: `Step ${n} edited it, but its input does not say how.` };
  }
  const expected = num(input.expected_replacements);
  return { t: "replace", edits: [{ old, new: nu, all: truthy(input.replace_all) || truthy(input.replaceAll) || truthy(input.AllowMultiple) || (expected !== undefined && expected > 1) }] };
}

/** A diff built from the step's ops alone (no line numbers), for when content is unknown. */
function opDiff(path: string, ops: Op[], op: "add" | "modify" | "delete"): string | undefined {
  const parts: string[] = [];
  for (const o of ops) {
    if (o.t === "write") parts.push(unifiedDiff(path, "", o.content, op === "add" ? "add" : "modify") ?? "");
    else if (o.t === "replace") for (const e of o.edits) parts.push(unifiedDiff(path, e.old, e.new) ?? "");
    else if (o.t === "hunks") {
      const body = o.hunks.map((h) => ["@@", ...h.old.filter((l, i) => !(h.new[i] === l)).map((l) => `-${l}`), ...h.new.filter((l, i) => !(h.old[i] === l)).map((l) => `+${l}`)].join("\n")).join("\n");
      parts.push(`--- a/${path}\n+++ b/${path}\n${body}\n`);
    } else if (o.t === "insert") parts.push(`--- a/${path}\n+++ b/${path}\n@@ after line ${o.line} @@\n${o.text.replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n")}\n`);
  }
  const text = parts.filter(Boolean).map((d, i) => (i === 0 ? d : d.slice(d.indexOf("@@")))).join("");
  return text || undefined;
}

function clipDiff(d: string, max: number): { diff: string; diffTruncated?: true } {
  if (Buffer.byteLength(d) <= max) return { diff: d };
  let cut = cutBytes(d, max);
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { diff: cut, diffTruncated: true };
}

function cutBytes(s: string, max: number): string {
  let out = Buffer.from(s).subarray(0, max).toString("utf8");
  if (out.endsWith("\uFFFD")) out = out.slice(0, -1);
  return out;
}

/** Output formats that wrap a command's output (so it is not the file's text). */
const looksLikeWrapperOutput = (t: string) => /^(Command: |Exit code:? \d|Error: Exit code|Chunk ID: |Process exited with code)/.test(t);

/** The blob holding a cut tool output, when the stored output was cut. */
function outputBlob(end: AgentEvent | undefined, text: string | undefined): string | undefined {
  if (!end || text === undefined || !text.endsWith("…") || !end.blobs?.length) return undefined;
  // The output blob is the one added for the output: after the raw payload when both are there.
  return end.blobs.length > 1 ? end.blobs.at(-1) : end.blobs[0];
}

/** A shell call's exit code: the event's own, or the code its output reports. */
function exitCodeOf(end: AgentEvent | undefined, text: string | undefined): number | undefined {
  if (!end) return undefined;
  const own = num(end.payload.exitCode) ?? num(end.payload.exit_code);
  if (own !== undefined) return own;
  if (!text) return undefined;
  const m = /^(?:Error: )?Exit code:? (\d+)/.exec(text) ?? /\nExit Code: (\d+)\s*$/.exec(text) ?? /Process exited with code (\d+)/.exec(text) ?? /^command exited with code (\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- loading

/** Event kinds a replay reads (everything else is skipped at the store). */
export const REPLAY_KINDS = ["user.message", "assistant.message", "tool.start", "tool.end", "file.change", "test.result", "subagent.start", "context.compact", "error"];

export interface ReplaySource {
  index: IndexStore;
  blobs: BlobStore;
}

/**
 * The replay of a stored session. `baseline` (from snapshotBaseline) supplies
 * each file's content at the start snapshot, when the session has one.
 */
export async function loadReplay(src: ReplaySource, session: Session, opts: Omit<ReplayOptions, "blob"> = {}): Promise<Replay> {
  const events = await src.index.listEvents(session.id, { kinds: REPLAY_KINDS });
  return Replay.load(session, events, { ...opts, blob: (ref) => src.blobs.getText(ref) });
}

/**
 * Starting content from the session's start snapshot (`coding.sh run`, eval
 * runs), read from its shadow repo and redacted like captured content.
 * Undefined when the session has no snapshot or the shadow repo is not on
 * this machine.
 */
export function snapshotBaseline(session: Session, env: NodeJS.ProcessEnv, redactor: Redactor): Baseline | undefined {
  const repo = session.repo;
  if (!repo?.snapshot || !repo.root) return undefined;
  const shadow = shadowRepoPath(repo.root, env);
  if (!existsSync(join(shadow, "HEAD"))) return undefined;
  const rev = repo.snapshot;
  return async (path) => {
    const r = await run(["cat-file", "blob", `${rev}:${path}`], { cwd: shadow, env: { GIT_DIR: shadow }, allowFail: true, timeoutMs: 5000, maxBuffer: MAX_CONTENT * 4 });
    if (r.code !== 0) {
      // Not in the snapshot: absent at the start, unless the snapshot kept tracked files only.
      if (/does not exist|exists on disk, but not in/i.test(r.stderr)) return repo.partial ? undefined : null;
      return undefined;
    }
    if (r.stdout.includes("\0")) return undefined;
    return redactor.string(r.stdout);
  };
}
