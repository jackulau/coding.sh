// Small, dependency-free helpers around the `git` binary.
//
// - Never goes through a shell: arguments are passed as an argv array.
// - Repo-location variables (GIT_DIR, GIT_INDEX_FILE, …) inherited from the
//   caller's environment are stripped, so a coding.sh call made from inside a
//   git hook or an agent with odd env never operates on the wrong repository.
//   Callers that *want* them pass them explicitly via `opts.env`.
// - GIT_OPTIONAL_LOCKS=0 so read-only commands never refresh/rewrite the
//   user's index behind their back.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Env vars that change which repository/index/object store git operates on. */
const LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

export interface GitRunOptions {
  cwd?: string;
  /** Merged over the (sanitized) process env. A value of undefined removes the var. */
  env?: Record<string, string | undefined>;
  /** Written to git's stdin, which is then closed. Stdin is always closed. */
  input?: string | Uint8Array;
  /** Kill git (SIGKILL) after this many ms. Default 30 s. */
  timeoutMs?: number;
  /** Resolve instead of throwing on a non-zero exit (timeouts and spawn errors still throw). */
  allowFail?: boolean;
  /**
   * Stream stdout here instead of buffering it (result.stdout is then "").
   * Return false to stop early: git is killed and the promise resolves with
   * `stopped: true` (no error).
   */
  onStdout?: (chunk: Buffer) => boolean | void;
  /** Max buffered stdout bytes. Default 256 MB. */
  maxBuffer?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when onStdout returned false and git was killed on purpose. */
  stopped?: boolean;
}

export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly code: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  constructor(message: string, info: { args: string[]; cwd: string; code: number | null; stderr: string; timedOut: boolean }) {
    super(message);
    this.name = "GitError";
    this.args = info.args;
    this.cwd = info.cwd;
    this.code = info.code;
    this.stderr = info.stderr;
    this.timedOut = info.timedOut;
  }
}

export function gitEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of LOCATION_VARS) delete env[k];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  // Our internal git calls must not feed trace2 consumers configured in the user's
  // gitconfig (e.g. git-ai's daemon writes .git/ai into the repo after every git run).
  env.GIT_TRACE2 = "0";
  env.GIT_TRACE2_EVENT = "0";
  env.GIT_TRACE2_PERF = "0";
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

function describe(args: string[]): string {
  const s = args.join(" ");
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

function spawnGit(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

/** Run `git <args>`. Throws GitError on non-zero exit (unless allowFail), timeout, or spawn failure. */
export function run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? 256 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawnGit>;
    try {
      child = spawnGit(args, cwd, gitEnv(opts.env));
    } catch (e) {
      reject(new GitError(`git ${describe(args)}: could not start git: ${(e as Error).message}`, { args, cwd, code: null, stderr: "", timedOut: false }));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (c: Buffer) => {
      if (opts.onStdout) {
        if (stopped) return;
        let keepGoing: boolean | void = true;
        try {
          keepGoing = opts.onStdout(c);
        } catch {
          keepGoing = false;
        }
        if (keepGoing === false) {
          stopped = true;
          child.kill("SIGKILL");
        }
        return;
      }
      outBytes += c.length;
      if (outBytes > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      // Keep only the first 64 KB of stderr: enough for any error message.
      if (errBytes < 65536) err.push(c);
      errBytes += c.length;
    });
    child.stdin.on("error", () => {}); // EPIPE when git exits before reading input
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = e.code === "ENOENT" ? "git not found on PATH" : e.message;
      reject(new GitError(`git ${describe(args)}: ${msg}`, { args, cwd, code: null, stderr: "", timedOut: false }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      const info = { args, cwd, code, stderr, timedOut };
      if (stopped && !timedOut) return resolvePromise({ stdout, stderr, code: code ?? -1, stopped: true });
      if (timedOut) return reject(new GitError(`git ${describe(args)} timed out after ${timeoutMs} ms (in ${cwd})`, info));
      if (overflow) return reject(new GitError(`git ${describe(args)}: output exceeded ${maxBuffer} bytes (in ${cwd})`, info));
      if (code === null) return reject(new GitError(`git ${describe(args)} killed by ${signal} (in ${cwd})`, info));
      if (code !== 0 && !opts.allowFail) {
        const detail = stderr.trim().split("\n").slice(0, 5).join("\n") || "(no stderr)";
        return reject(new GitError(`git ${describe(args)} failed with exit ${code} (in ${cwd}): ${detail}`, info));
      }
      resolvePromise({ stdout, stderr, code });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run git and return trimmed stdout (trailing newline removed). Throws on failure. */
export async function git(args: string[], opts: GitRunOptions = {}): Promise<string> {
  const r = await run(args, opts);
  return r.stdout.replace(/\r?\n$/, "");
}

/** Top-level directory of the work tree containing `cwd`, or undefined when not inside one. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  if (!existsSync(cwd)) return undefined;
  const r = await run(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  const root = r.stdout.trim();
  return r.code === 0 && root ? root : undefined;
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await repoRoot(cwd)) !== undefined;
}

/** HEAD commit sha, or "" on an unborn branch. */
export async function head(root: string): Promise<string> {
  const r = await run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: root, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * HEAD commit at a past moment (ms epoch), read from the HEAD reflog. Undefined
 * when the reflog doesn't reach back that far (or is off): git would otherwise
 * answer with its oldest entry, a later HEAD than the one at that moment.
 */
export async function headAt(root: string, tsMs: number): Promise<string | undefined> {
  const at = `HEAD@{@${Math.floor(tsMs / 1000)}}^{commit}`;
  // LC_ALL=C: the "only goes back to" warning is matched below.
  const r = await run(["rev-parse", "--verify", at], { cwd: root, allowFail: true, env: { LC_ALL: "C", LANGUAGE: undefined } });
  if (r.code !== 0 || /only goes back to/.test(r.stderr)) return undefined;
  return r.stdout.trim() || undefined;
}

/** Current branch short name, or undefined when HEAD is detached. Works on unborn branches. */
export async function branch(root: string): Promise<string | undefined> {
  const r = await run(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: root, allowFail: true });
  const b = r.stdout.trim();
  return r.code === 0 && b ? b : undefined;
}

export interface RepoLayout {
  root: string;
  /** Per-worktree git dir (holds HEAD and index). */
  gitDir: string;
  /** Shared git dir (holds objects, refs, info/). Equals gitDir outside linked worktrees. */
  commonDir: string;
  objectFormat: "sha1" | "sha256";
}

/** Locations of a repo's git dirs. Handles linked worktrees and submodules (gitdir files). */
export async function layout(cwd: string): Promise<RepoLayout | undefined> {
  if (!existsSync(cwd)) return undefined;
  const r = await run(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-object-format"], {
    cwd,
    allowFail: true,
  });
  if (r.code !== 0) return undefined;
  const [root, gitDir, commonDir, fmt] = r.stdout.split("\n").map((l) => l.trim());
  if (!root || !gitDir || !commonDir) return undefined;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  return { root, gitDir: abs(gitDir), commonDir: abs(commonDir), objectFormat: fmt === "sha256" ? "sha256" : "sha1" };
}

export const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/** Identity env for commits coding.sh creates, so they never depend on the user's git config. */
export const CODING_SH_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "coding.sh",
  GIT_AUTHOR_EMAIL: "snapshot@coding.sh.invalid",
  GIT_COMMITTER_NAME: "coding.sh",
  GIT_COMMITTER_EMAIL: "snapshot@coding.sh.invalid",
};
