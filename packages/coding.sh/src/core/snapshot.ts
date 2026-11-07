// Shadow-repo snapshots of a user's working tree.
//
// Invariant: NOTHING in the user's repository is written — not refs, index,
// stash, config, hooks, or objects. (Git may bump the mtime of objects it finds
// already present in the user's store — "freshening" — which only delays their
// pruning.)
//
// How a snapshot is taken (all git commands run with cwd = user's repo root, so
// the user's own config, .gitignore files, info/exclude, attributes and HEAD
// apply exactly as they would for `git add`):
//
//   GIT_INDEX_FILE       = <shadow>/tmp-index-*   (a copy of the user's index, so
//                          the stat cache is warm and only changed files are hashed)
//   GIT_OBJECT_DIRECTORY = <shadow>/objects       (new blobs/trees/commits land here)
//   <shadow>/objects/info/alternates → user's objects (reads see user objects)
//
//   git add -A --ignore-errors → git write-tree → git commit-tree [-p HEAD]
//
// The commit is kept reachable by a loose ref refs/snapshots/<commit> in the
// shadow repo, so `git gc` in the shadow keeps it.
//
// Large-repo guard (partial snapshots): if tracked + untracked files exceed
// `maxFiles`, or the full `add -A` exceeds `timeoutMs`, we fall back to
// `git add -u` (tracked files only, with their working-tree content) under a
// fresh `timeoutMs` budget. The result is still a normal commit (HEAD + tracked
// modifications), so diff/materialize work unchanged; untracked files are simply
// absent, and RepoState.partial = true. If even that fails, snapshot is
// undefined and only head is recorded.
//
// Known limitations:
// - Shadow commits reference objects in the user's store via alternates (the
//   HEAD commit, unchanged blobs). If the user rewrites history and prunes, an
//   old snapshot can become unreadable. Eval tasks should copy what they need
//   (materialize early, or store a patch/blob) rather than rely on the shadow forever.
// - Submodules are recorded as gitlinks (their HEAD); dirty submodule content is
//   not captured.
// - Untracked large files are hashed like any other (bounded only by timeoutMs).
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoState } from "../schema/index.ts";
import { paths } from "./paths.ts";
import { CODING_SH_IDENTITY, EMPTY_TREE_SHA1, EMPTY_TREE_SHA256, GitError, branch, git, head, layout, run } from "./git.ts";
import type { RepoLayout } from "./git.ts";

export const DEFAULT_SNAPSHOT_MAX_FILES = 50_000;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2_000;
/**
 * materialize() writes and then hashes every file of the tree. It is not on a hot path, and a
 * failed one fails the whole eval run, so its git calls get far more than git's 30 s default
 * (a large tree on Windows, where a virus scanner reads each new file, can need it).
 */
const MATERIALIZE_TIMEOUT_MS = 10 * 60_000;

export interface SnapshotOptions {
  maxFiles?: number;
  timeoutMs?: number;
  message?: string;
  /** Env used to locate the data dir (CODING_SH_HOME). Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface FileDiff {
  path: string;
  status: "add" | "modify" | "delete";
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface DiffResult {
  patch: string;
  files: FileDiff[];
}

export interface MaterializeResult {
  dir: string;
  /** The "coding.sh task start" commit in dir/.git. */
  startCommit: string;
}

/** Ref in a materialized dir pointing at its start commit (hidden from branch/tag lists). */
export const START_REF = "refs/coding.sh/start";

function realRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

export function shadowRepoPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const id = createHash("sha256").update(realRoot(repoRoot)).digest("hex");
  return join(paths(env).repos, `${id}.git`);
}

/**
 * Create (idempotently) the bare shadow repo for `repoRoot` and point its
 * alternates at the user's object store. Safe to call concurrently.
 */
export async function ensureShadow(repoRoot: string, env: NodeJS.ProcessEnv = process.env, known?: RepoLayout): Promise<string> {
  const lay = known ?? (await layout(repoRoot));
  if (!lay) throw new Error(`not a git repository: ${repoRoot}`);
  const shadow = shadowRepoPath(lay.root, env);
  if (!existsSync(join(shadow, "HEAD"))) {
    mkdirSync(shadow, { recursive: true, mode: 0o700 });
    await run(["init", "--bare", "-q", `--object-format=${lay.objectFormat}`, shadow], { cwd: shadow });
    // allowFail: a concurrent init may hold config.lock; gc.auto is only a nicety.
    await run(["config", "gc.auto", "0"], { env: { GIT_DIR: shadow }, allowFail: true });
    writeFileSync(join(shadow, "coding.sh-root"), realRoot(lay.root) + "\n");
  }
  const alternatesFile = join(shadow, "objects", "info", "alternates");
  const want = join(lay.commonDir, "objects") + "\n";
  let have = "";
  try {
    have = readFileSync(alternatesFile, "utf8");
  } catch {
    // missing
  }
  if (have !== want) {
    mkdirSync(join(shadow, "objects", "info"), { recursive: true });
    const tmp = `${alternatesFile}.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, want);
    renameSync(tmp, alternatesFile);
  }
  return shadow;
}

function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true, recursive: true });
  } catch {
    // ignore
  }
}

/** Seed a temp index from the user's index (warm stat cache), preserving its mtime for racy-git checks. */
function seedIndex(userIndex: string, tmpIndex: string): boolean {
  try {
    const st = statSync(userIndex);
    copyFileSync(userIndex, tmpIndex);
    utimesSync(tmpIndex, st.atime, st.mtime);
    return true;
  } catch {
    return false;
  }
}

/** Entry count from an index file header ("DIRC", version, count). */
function indexEntryCount(indexFile: string): number {
  try {
    const fd = readFileSync(indexFile).subarray(0, 12);
    return fd.length === 12 && fd.toString("latin1", 0, 4) === "DIRC" ? fd.readUInt32BE(8) : 0;
  } catch {
    return 0;
  }
}

/** Count untracked, non-ignored files, stopping early (and killing git) once over `limit`. */
async function countUntracked(root: string, limit: number, timeoutMs: number, gitEnvExtra: Record<string, string>): Promise<number> {
  let count = 0;
  await run(["ls-files", "-o", "--exclude-standard", "-z"], {
    cwd: root,
    env: gitEnvExtra,
    timeoutMs,
    onStdout: (c) => {
      for (let i = 0; i < c.length; i++) if (c[i] === 0) count++;
      return count <= limit;
    },
  });
  return count;
}

/**
 * Snapshot the working tree containing `cwd` into its shadow repo.
 * Returns undefined when cwd is not inside a git work tree.
 */
export async function snapshot(cwd: string, opts: SnapshotOptions = {}): Promise<RepoState | undefined> {
  const env = opts.env ?? process.env;
  const maxFiles = opts.maxFiles ?? DEFAULT_SNAPSHOT_MAX_FILES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const lay = await layout(cwd);
  if (!lay) return undefined;
  const root = lay.root;
  const [headSha, br, shadow] = await Promise.all([head(root), branch(root), ensureShadow(root, env, lay)]);
  const state: RepoState = { root, head: headSha, partial: false };
  if (br) state.branch = br;

  const tmpIndex = join(shadow, `tmp-index-${process.pid}-${randomBytes(6).toString("hex")}`);
  const objects = join(shadow, "objects");
  const genv: Record<string, string> = { GIT_INDEX_FILE: tmpIndex, GIT_OBJECT_DIRECTORY: objects };
  // Never let our writes produce split/shared index files next to the user's index.
  const cfg = ["-c", "core.splitIndex=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
  const userIndex = join(lay.gitDir, "index");

  const prepareIndex = async () => {
    rmQuiet(tmpIndex);
    rmQuiet(tmpIndex + ".lock");
    if (!seedIndex(userIndex, tmpIndex) && headSha) {
      await run([...cfg, "read-tree", headSha], { cwd: root, env: genv, timeoutMs });
    }
  };

  try {
    let partial = false;
    const started = Date.now();
    await prepareIndex();
    const tracked = indexEntryCount(tmpIndex);
    if (tracked > maxFiles) partial = true;
    else {
      try {
        const untracked = await countUntracked(root, maxFiles - tracked, timeoutMs, genv);
        if (tracked + untracked > maxFiles) partial = true;
      } catch (e) {
        if (e instanceof GitError && e.timedOut) partial = true;
        else throw e;
      }
    }
    if (!partial) {
      const left = timeoutMs - (Date.now() - started);
      try {
        if (left <= 0) throw new GitError("budget exhausted", { args: [], cwd: root, code: null, stderr: "", timedOut: true });
        await run([...cfg, "add", "-A", "--ignore-errors"], { cwd: root, env: genv, timeoutMs: left, allowFail: true });
      } catch (e) {
        if (!(e instanceof GitError && e.timedOut)) throw e;
        partial = true;
      }
    }
    if (partial) {
      await prepareIndex();
      try {
        await run([...cfg, "add", "-u", "--ignore-errors"], { cwd: root, env: genv, timeoutMs, allowFail: true });
      } catch (e) {
        if (e instanceof GitError && e.timedOut) {
          state.partial = true;
          return state; // no snapshot; head only
        }
        throw e;
      }
    }
    const tree = await git([...cfg, "write-tree"], { cwd: root, env: genv, timeoutMs });
    const msg = opts.message ?? `coding.sh snapshot${partial ? " (partial: tracked files only)" : ""}`;
    const commitArgs = ["commit-tree", tree, ...(headSha ? ["-p", headSha] : []), "-m", msg];
    const commit = await git([...cfg, ...commitArgs], { cwd: root, env: { ...genv, ...CODING_SH_IDENTITY }, timeoutMs });
    // Loose ref keeps the commit reachable for gc in the shadow repo.
    const refDir = join(shadow, "refs", "snapshots");
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, commit), commit + "\n");
    state.snapshot = commit;
    state.partial = partial;
    return state;
  } finally {
    rmQuiet(tmpIndex);
    rmQuiet(tmpIndex + ".lock");
  }
}

function emptyTreeFor(sha: string): string {
  return sha.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
}

function parseDiff(rawZ: string, numstatZ: string): FileDiff[] {
  const files = new Map<string, FileDiff>();
  // --raw -z: ":<mode> <mode> <sha> <sha> <status>\0<path>\0"
  const raw = rawZ.split("\0");
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i] ?? "";
    const path = raw[i + 1] ?? "";
    if (!meta.startsWith(":") || !path) continue;
    const s = meta.trim().split(" ").pop()?.[0];
    const status: FileDiff["status"] = s === "A" ? "add" : s === "D" ? "delete" : "modify";
    files.set(path, { path, status, additions: 0, deletions: 0 });
  }
  // --numstat -z (no renames): "<add>\t<del>\t<path>\0"
  for (const rec of numstatZ.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const f = files.get(m[3] ?? "");
    if (!f) continue;
    if (m[1] === "-") f.binary = true;
    else {
      f.additions = Number(m[1]);
      f.deletions = Number(m[2]);
    }
  }
  return [...files.values()];
}

async function diffTrees(a: string, b: string, gitOpts: { cwd: string; env?: Record<string, string> }): Promise<DiffResult> {
  const base = ["-c", "core.quotePath=false", "diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
  const [patch, rawZ, numZ] = await Promise.all([
    run([...base, "--binary", a, b], gitOpts),
    run([...base, "--raw", "-z", a, b], gitOpts),
    run([...base, "--numstat", "-z", a, b], gitOpts),
  ]);
  return { patch: patch.stdout, files: parseDiff(rawZ.stdout, numZ.stdout) };
}

/**
 * Diff two commits (snapshot or HEAD shas) of a repo, read from its shadow repo.
 * `a` may be "" (unborn) to diff against the empty tree.
 */
export async function diffSnapshots(repoRoot: string, a: string, b: string, env: NodeJS.ProcessEnv = process.env): Promise<DiffResult> {
  const shadow = shadowRepoPath(repoRoot, env);
  if (!existsSync(join(shadow, "HEAD"))) await ensureShadow(repoRoot, env);
  const from = a || emptyTreeFor(b);
  const to = b || emptyTreeFor(a);
  return diffTrees(from, to, { cwd: shadow, env: { GIT_DIR: shadow } });
}

/**
 * Create an independent working dir at `state.snapshot` (or `state.head` when
 * there is no snapshot). destDir must not exist or be empty. The dir gets a
 * fresh `.git` with a single root commit "coding.sh task start" (no history,
 * no alternates — the agent cannot see the user's other commits), referenced by
 * refs/coding.sh/start so diffWorkdir() works even if the agent commits.
 */
export async function materialize(state: RepoState, destDir: string, env: NodeJS.ProcessEnv = process.env): Promise<MaterializeResult> {
  const rev = state.snapshot || state.head;
  if (!rev) throw new Error("materialize: state has neither snapshot nor head");
  const shadow = shadowRepoPath(state.root, env);
  if (!existsSync(join(shadow, "HEAD"))) {
    if (!existsSync(state.root)) throw new Error(`materialize: no shadow repo for ${state.root}`);
    await ensureShadow(state.root, env);
  }
  mkdirSync(destDir, { recursive: true });
  if (readdirSync(destDir).length > 0) throw new Error(`materialize: destination is not empty: ${destDir}`);
  const dest = realRoot(destDir);
  const scratch = mkdtempSync(join(tmpdir(), "coding-sh-mat-"));
  try {
    const idx = join(scratch, "index");
    const senv = { GIT_DIR: shadow, GIT_INDEX_FILE: idx, GIT_WORK_TREE: dest };
    await run(["read-tree", `${rev}^{tree}`], { cwd: dest, env: senv, timeoutMs: MATERIALIZE_TIMEOUT_MS });
    await run(["checkout-index", "-a", "-f"], { cwd: dest, env: senv, timeoutMs: MATERIALIZE_TIMEOUT_MS });
  } finally {
    rmQuiet(scratch);
  }
  const quiet = ["-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
  await run([...quiet, "init", "-q"], { cwd: dest });
  // -f: files tracked-but-ignored upstream must be in the start commit too.
  await run([...quiet, "add", "-A", "-f"], { cwd: dest, timeoutMs: MATERIALIZE_TIMEOUT_MS });
  await run([...quiet, "commit", "-q", "--no-verify", "--allow-empty", "-m", "coding.sh task start"], { cwd: dest, env: CODING_SH_IDENTITY, timeoutMs: MATERIALIZE_TIMEOUT_MS });
  const startCommit = await git(["rev-parse", "HEAD"], { cwd: dest });
  await run(["update-ref", START_REF, startCommit], { cwd: dest });
  return { dir: dest, startCommit };
}

/**
 * Diff a materialized dir's current working tree (tracked + untracked,
 * non-ignored) against its start commit. Does not touch the dir's index or refs.
 */
export async function diffWorkdir(dir: string): Promise<DiffResult> {
  const lay = await layout(dir);
  if (!lay) throw new Error(`diffWorkdir: not a git repository: ${dir}`);
  let start = (await run(["rev-parse", "-q", "--verify", `${START_REF}^{commit}`], { cwd: lay.root, allowFail: true })).stdout.trim();
  if (!start) {
    const roots = await git(["rev-list", "--max-parents=0", "HEAD"], { cwd: lay.root });
    start = roots.split("\n").pop() ?? "";
  }
  if (!start) throw new Error(`diffWorkdir: no start commit in ${dir}`);
  const scratch = mkdtempSync(join(tmpdir(), "coding-sh-diff-"));
  try {
    const idx = join(scratch, "index");
    seedIndex(join(lay.gitDir, "index"), idx);
    const genv = { GIT_INDEX_FILE: idx };
    await run(["-c", "core.splitIndex=false", "add", "-A", "--ignore-errors"], { cwd: lay.root, env: genv, allowFail: true });
    const tree = await git(["write-tree"], { cwd: lay.root, env: genv });
    return await diffTrees(start, tree, { cwd: lay.root });
  } finally {
    rmQuiet(scratch);
  }
}
