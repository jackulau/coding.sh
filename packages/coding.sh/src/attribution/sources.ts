// What each captured session added, per file, as LineKeys (match.ts input).
//
// Two sources, best first:
// - snapshot: the diff from the session's start state (its pre-agent
//   snapshot, else HEAD at its start) to its end snapshot, read from the
//   shadow repo. It sees every write, Bash and subagents included.
// - replay: the session's own edit tool calls (core/replay.ts), for sessions
//   with no end snapshot, and for files a partial snapshot left out.
// The files a file.change event or an edit tool named are marked `edited`;
// the matcher trusts lines in other files a little less.
//
// Only hashes are kept, never line text. A session's source is cached in the
// index key/value store (when it has one), keyed by what it was built from.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { loadReplay } from "../core/replay.ts";
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
const SOURCE_VERSION = 1;
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

/** "+" lines of a unified diff (or of several, as replay ranges join them). */
function addedKeys(diff: string): LineKey[] {
  const out: LineKey[] = [];
  for (const l of diff.split("\n")) if (l.startsWith("+") && !l.startsWith("+++ ")) out.push(lineKey(l.slice(1)));
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
  let haveSnapshot = false;
  if (start && s.endSnapshot && start !== s.endSnapshot) {
    const patch = await snapshotPatch(root, start, s.endSnapshot, ctx.env).catch(() => undefined);
    haveSnapshot = patch !== undefined;
    for (const f of patch ?? []) {
      if (f.binary || f.deleted || !f.added.length) continue;
      const pid = filePatchId(f);
      files.set(f.path, { path: f.path, keys: f.added.map((a) => a.key), ...(pid ? { patchId: pid } : {}), via: s.repo?.snapshot ? "snapshot" : "snapshot-head" });
    }
  }

  // The session's own edits: which files its tools named, and (without a full snapshot) what they wrote.
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
  const needReplay = !haveSnapshot || s.repo?.partial === true;
  if (needReplay && replay.steps.length && [...edited].some((p) => !files.has(p))) {
    const view = await replay.range(1, replay.steps.length).catch(() => undefined);
    for (const f of view?.files ?? []) {
      if (f.op === "delete" || !f.diff) continue;
      const p = repoPath(f.path, base, root);
      if (!p || files.has(p)) continue;
      const keys = addedKeys(f.diff);
      if (keys.length) files.set(p, { path: p, keys, via: "replay", edited: true });
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
