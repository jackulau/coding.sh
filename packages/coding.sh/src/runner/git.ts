// Repo-state operations the runner and evals need. The real implementation is
// src/core/snapshot.ts (owned by the capture builder); every entry point here
// accepts an injected `SnapshotOps` so tests (and alternative backends, e.g. a
// Docker runner) can swap it.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoState } from "../core/types.ts";
import { execFileTail, type ExecResult } from "./exec.ts";

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface WorkdirDiff {
  patch: string;
  files: DiffFile[];
}

export interface SnapshotOps {
  /** Create an independent dir (own .git) whose HEAD commit is `state`'s snapshot. */
  materialize(state: RepoState, destDir: string): Promise<unknown>;
  /** Working tree (incl. untracked) vs the dir's start commit (refs/coding.sh/start). */
  diffWorkdir(dir: string): Promise<WorkdirDiff>;
  diffSnapshots(repoRoot: string, a: string, b: string): Promise<WorkdirDiff>;
}

let cached: SnapshotOps | undefined;

/** The injected ops, else src/core/snapshot.ts (loaded lazily so tests never need it). */
export async function snapshotOps(injected?: SnapshotOps): Promise<SnapshotOps> {
  if (injected) return injected;
  if (!cached) {
    const m = await import("../core/snapshot.ts");
    cached = { materialize: m.materialize, diffWorkdir: m.diffWorkdir, diffSnapshots: m.diffSnapshots };
  }
  return cached;
}

/**
 * Env for internal plumbing git calls. GIT_TRACE2_EVENT=0 overrides a user's
 * `trace2.eventTarget` (e.g. git-ai's daemon), whose async writes into .git/
 * otherwise race temp-dir cleanup and track throwaway sandboxes.
 */
export const QUIET_GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_TRACE2_EVENT: "0" };

/** rm -rf that tolerates late writers (retries ENOTEMPTY/EBUSY). */
export function rmrf(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<ExecResult> {
  return execFileTail("git", args, {
    cwd,
    timeoutMs,
    tailBytes: 1024 * 1024,
    env: { ...process.env, ...QUIET_GIT_ENV },
  });
}

export const GIT_IDENTITY = [
  "-c",
  "user.name=coding.sh",
  "-c",
  "user.email=runner@coding.sh",
  "-c",
  "commit.gpgsign=false",
];

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

/** `git apply` a patch (string) inside dir. Works with or without a .git in dir. */
export async function applyPatch(dir: string, patch: string, opts: { reverse?: boolean; check?: boolean } = {}): Promise<ApplyResult> {
  if (patch.trim() === "") return { ok: true };
  const tmp = await mkdtemp(join(tmpdir(), "csh-patch-"));
  try {
    const file = join(tmp, "p.patch");
    await writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`);
    const args = ["apply", "--whitespace=nowarn"];
    if (opts.reverse) args.push("-R");
    if (opts.check) args.push("--check");
    args.push(file);
    const r = await git(args, dir);
    return r.exitCode === 0 ? { ok: true } : { ok: false, error: (r.stderrTail || r.stdoutTail).trim() };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Same ref name as src/core/snapshot.ts START_REF (diffWorkdir diffs against it). */
export const START_REF = "refs/coding.sh/start";

/**
 * Commit everything in dir (if anything changed) and move refs/coding.sh/start
 * to it, so diffWorkdir() afterwards reports only what came later (the
 * agent's work, not setup output or the harness overlay) and the agent sees
 * a clean `git status`. Returns whether a commit was made.
 */
export async function rebaseStart(dir: string, message: string): Promise<boolean> {
  const add = await git(["add", "-A"], dir);
  if (add.exitCode !== 0) throw new Error(`git add failed in ${dir}: ${add.stderrTail.trim()}`);
  const st = await git(["diff", "--cached", "--quiet"], dir);
  if (st.exitCode === 0) return false;
  const c = await git([...GIT_IDENTITY, "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", message], dir);
  if (c.exitCode !== 0) throw new Error(`git commit failed in ${dir}: ${c.stderrTail.trim()}`);
  const u = await git(["update-ref", START_REF, "HEAD"], dir);
  if (u.exitCode !== 0) throw new Error(`git update-ref failed in ${dir}: ${u.stderrTail.trim()}`);
  return true;
}
