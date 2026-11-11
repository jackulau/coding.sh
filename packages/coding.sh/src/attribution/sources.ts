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
// The files a file.change event or an edit tool named are marked `edited`;
// the matcher trusts lines in other files a little less.
//
// Only hashes are kept, never line text. A session's source is cached in the
// index key/value store (when it has one), keyed by what it was built from.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { loadReplay, type Replay } from "../core/replay.ts";
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
const SOURCE_VERSION = 3;
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
  for (const p of edited) {
    const f = files.get(p);
    if (f) f.edited = true;
  }
  // A snapshot diff that exists says nothing about a file it lacks: the end snapshot is of the tree as it was
  // when ingest ran, which can be another branch than the one the session's work was committed on.
  if ([...edited].some((p) => !files.has(p))) {
    for (const [p, keys] of await editStepKeys(replay, root)) {
      if (!files.has(p)) files.set(p, { path: p, keys, via: "replay", edited: true });
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
