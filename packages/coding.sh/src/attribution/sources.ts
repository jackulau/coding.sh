// What each captured session added, per file, as LineKeys (match.ts input).
//
// Two sources, best first:
// - snapshot: the diff from the session's start state (its pre-agent
//   snapshot, else HEAD at its start) to its end snapshot, read from the
//   shadow repo. It sees every write, Bash and subagents included.
// - replay: the session's own edit tool calls (core/replay.ts), for every
//   file its tools named that the snapshot diff does not hold: there is no
//   end snapshot, a partial one left the file out, or the tree had changed
//   by the time it was taken (the work was committed on a branch and another
//   branch checked out). Each edit step gives the lines it added itself
//   (editStepKeys); what a read shows that no step wrote is someone else's
//   edit and is left out.
// The tree diff holds whatever changed in that window, a person's typing
// included, so a file is kept only when the session's tools named it, or it
// ran a shell or subagent call (which can write files nothing names). With no
// such call, a named file takes the lines its edit steps added, not the diff.
// The files a file.change event or an edit tool named are marked `edited`;
// the matcher trusts lines in other files a little less.
//
// Only hashes are kept, never line text. A session's source is cached in the
// index key/value store (when it has one), keyed by what it was built from.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { loadReplay, type Replay } from "../core/replay.ts";
import { shellCommand, simpleCommands } from "../core/shell-diff.ts";
import type { BlobStore, IndexStore, Session } from "../core/types.ts";
import { snapshotPatch } from "./git.ts";
import { filePatchId, lineKey, type LineKey } from "./lines.ts";
import type { SessionSource, SourceFile } from "./match.ts";

export interface SourceContext {
  index: IndexStore;
  blobs: BlobStore;
  env: NodeJS.ProcessEnv;
}

/** Bump when a stored source would be built differently. */
const SOURCE_VERSION = 5;
const kvKey = (id: string) => `attribution:source:${id}`;

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Repo-relative "/" path for a replay path (relative to `base`, or absolute); undefined outside the repo. */
function repoPath(p: string, base: string | undefined, root: string): string | undefined {
  const abs = isAbsolute(p) ? p : base ? `${base}/${p}` : undefined;
  if (!abs) return p.replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = relative(real(root), real(abs.replace(/\//g, sep)));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    // realpath fails for a deleted file: compare the paths as written.
    const r2 = relative(root, abs);
    if (!r2 || r2.startsWith("..") || isAbsolute(r2)) return undefined;
    return r2.split(sep).join("/");
  }
  return rel.split(sep).join("/");
}

/** Keys of the "+" and "-" lines of a unified diff. */
function diffKeys(diff: string): { added: LineKey[]; removed: LineKey[] } {
  const added: LineKey[] = [];
  const removed: LineKey[] = [];
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++ ")) added.push(lineKey(l.slice(1)));
    else if (l.startsWith("-") && !l.startsWith("--- ")) removed.push(lineKey(l.slice(1)));
  }
  return { added, removed };
}

/**
 * Keys of the lines the session's own edit steps added, per repo path.
 *
 * Each step that wrote or edited a file gives its own diff: the file as the
 * step found it against the file as it left it. A line a later step of the
 * session removed again is dropped. Lines that reach the replay only through
 * a read (a person, a formatter or another agent changed the file between two
 * steps) are in no step's diff, so they are never the session's.
 */
export async function editStepKeys(replay: Replay, root: string): Promise<Map<string, LineKey[]>> {
  // path → key → how many the session has added and not removed
  const owned = new Map<string, Map<LineKey, number>>();
  for (const st of replay.steps) {
    if (!st.files?.some((f) => f.op !== "read")) continue;
    for (const c of await replay.changesAt(st.n, { own: true }).catch(() => [])) {
      const p = c.diff ? repoPath(c.path, replay.root, root) : undefined;
      if (!p) continue;
      const counts = owned.get(p) ?? new Map<LineKey, number>();
      owned.set(p, counts);
      const { added, removed } = diffKeys(c.diff!);
      for (const k of removed) {
        const n = counts.get(k) ?? 0;
        if (n > 1) counts.set(k, n - 1);
        else counts.delete(k);
      }
      for (const k of added) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const out = new Map<string, LineKey[]>();
  for (const [p, counts] of owned) {
    const keys = [...counts].flatMap(([k, n]) => new Array<LineKey>(n).fill(k));
    if (keys.length) out.set(p, keys);
  }
  return out;
}

/** Commands that only look: they write no file, so a file they ran beside is not theirs to have written. */
const LOOKS = new Set(["ls", "cat", "head", "tail", "pwd", "echo", "printf", "wc", "rg", "grep", "egrep", "fgrep", "tree", "stat", "file", "which", "type", "date", "whoami", "basename", "dirname", "realpath", "du", "df", "cd", "true", "false", "test", "[", "sort", "uniq", "cut", "tr", "diff", "cmp", "nl", "od", "xxd", "jq", "less", "more", "sleep", "uname", "id", "env", "printenv"]);
const GIT_LOOKS = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "grep", "shortlog", "ls-tree", "cat-file", "remote", "config"]);

/**
 * True when every command in `command` can only look at files (ls, cat, rg, git status, …), with no
 * redirect, no command substitution and no pipe into something that could write. Unknown commands,
 * scripts and builds are not read-only: they may write files nothing names.
 */
export function readOnlyCommand(command: string): boolean {
  if (/\$\(|`|<\(|>\(/.test(command)) return false;
  return simpleCommands(command).every((c) => {
    if (c.redirects.length) return false;
    if (c.cmd === "") return true;
    if (c.cmd === "find") return !c.args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(a));
    if (c.cmd === "git") {
      const sub = c.args.filter((a, i) => !a.startsWith("-") && !(i > 0 && (c.args[i - 1] === "-C" || c.args[i - 1] === "-c")))[0];
      return sub !== undefined && GIT_LOOKS.has(sub) && !(sub === "remote" && c.args.some((a) => /^(?:add|remove|rm|set-url|rename)$/.test(a))) && !(sub === "config" && !c.args.includes("--get") && !c.args.includes("--list") && !c.args.includes("-l"));
    }
    return LOOKS.has(c.cmd);
  });
}

function sameKeys(a: LineKey[], b: LineKey[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((k, i) => k === y[i]);
}

function fingerprint(s: Session): string {
  return [SOURCE_VERSION, s.repo?.root ?? "", s.repo?.snapshot ?? s.repo?.head ?? "", s.endSnapshot ?? "", s.stats.events].join("|");
}

/**
 * The lines a session added, or undefined when it added none that can be
 * found (no snapshot, no edit tool content).
 */
export async function sessionSource(ctx: SourceContext, s: Session, opts: { cache?: boolean } = {}): Promise<SessionSource | undefined> {
  const cache = opts.cache !== false && !!ctx.index.kvGet && !!ctx.index.kvSet;
  const fp = fingerprint(s);
  if (cache) {
    try {
      const hit = JSON.parse((await ctx.index.kvGet!(kvKey(s.id))) ?? "null") as { fp?: string; files?: SourceFile[] } | null;
      if (hit?.fp === fp && Array.isArray(hit.files)) return hit.files.length ? toSource(s, hit.files) : undefined;
    } catch {
      // a bad cache entry is rebuilt below
    }
  }
  const files = await buildFiles(ctx, s);
  if (cache) {
    try {
      await ctx.index.kvSet!(kvKey(s.id), JSON.stringify({ fp, files }));
    } catch {
      // read-only store (a viewer replica): compute again next time
    }
  }
  return files.length ? toSource(s, files) : undefined;
}

function toSource(s: Session, files: SourceFile[]): SessionSource {
  return { sessionId: s.id, agent: s.agent, ...(s.model ? { model: s.model } : {}), startedAt: s.startedAt, files };
}

async function buildFiles(ctx: SourceContext, s: Session): Promise<SourceFile[]> {
  const root = s.repo?.root;
  if (!root) return [];
  const files = new Map<string, SourceFile>();

  const start = s.repo?.snapshot || s.repo?.head;
  if (start && s.endSnapshot && start !== s.endSnapshot) {
    const patch = await snapshotPatch(root, start, s.endSnapshot, ctx.env).catch(() => undefined);
    for (const f of patch ?? []) {
      if (f.binary || f.deleted || !f.added.length) continue;
      const pid = filePatchId(f);
      files.set(f.path, { path: f.path, keys: f.added.map((a) => a.key), ...(pid ? { patchId: pid } : {}), via: s.repo?.snapshot ? "snapshot" : "snapshot-head" });
    }
  }

  // The session's own edits: which files its tools named, and what they wrote to the ones the snapshot diff lacks.
  let replay;
  try {
    replay = await loadReplay(ctx, s);
  } catch {
    return [...files.values()];
  }
  const base = replay.root;
  const edited = new Set<string>();
  for (const st of replay.steps) {
    for (const f of st.files ?? []) {
      if (f.op === "read") continue;
      const p = repoPath(f.path, base, root);
      if (p) edited.add(p);
    }
  }
  // A shell or subagent call can write files nothing names; without one the session wrote only the files its tools named.
  // A session with no stored events at all says nothing about what it ran: its diff stands as it is.
  // A shell call whose command only looks (ls, cat, git status) writes nothing, so it does not count.
  const starts = new Map((await ctx.index.listEvents(s.id, { kinds: ["tool.start"] }).catch(() => [])).map((e) => [e.id, e] as const));
  const mayWrite = (st: (typeof replay.steps)[number]): boolean => {
    if (st.kind === "subagent") return true;
    if (st.kind !== "shell") return false;
    const e = starts.get(st.eventId);
    const command = e ? shellCommand(typeof e.payload.tool === "string" ? e.payload.tool : undefined, e.payload.input) : undefined;
    return command === undefined || !readOnlyCommand(command);
  };
  const mayWriteUnnamed = !replay.steps.length || replay.steps.some(mayWrite);
  // The tree diff from the start to the end snapshot also holds what a person typed in that window (and what
  // another session left uncommitted), so a file the session could not have written is not its own.
  for (const p of [...files.keys()]) {
    if (!edited.has(p) && !mayWriteUnnamed) files.delete(p);
  }
  for (const p of edited) {
    const f = files.get(p);
    if (f) f.edited = true;
  }
  // The session's own edit steps give what it added; the tree diff for a named file also holds a person's lines
  // when no shell or subagent call can explain them, so the steps win then. A file the snapshot diff lacks (no end
  // snapshot, a partial one, or a tree that moved to another branch) comes from the steps alone.
  if (edited.size) {
    for (const [p, keys] of await editStepKeys(replay, root)) {
      const f = files.get(p);
      if (!f) files.set(p, { path: p, keys, via: "replay", edited: true });
      else if (!mayWriteUnnamed && !sameKeys(f.keys, keys)) {
        f.keys = keys;
        delete f.patchId;
      }
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
