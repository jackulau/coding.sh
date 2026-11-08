// The repo and HEAD commit a session starts from, read by the hook with fs
// calls alone: no git binary, no child process, no network.
//
// On the hook's hot path. It may only import node:fs and node:path.
//
// Resolves what `git rev-parse --show-toplevel`, `git rev-parse HEAD` and
// `git symbolic-ref --short HEAD` would print for `cwd`:
// - walks up from cwd (at most MAX_DEPTH levels) to the first `.git`, a
//   directory or a `gitdir: <path>` file (linked worktrees, submodules);
// - reads `<gitdir>/HEAD`: a sha (detached) or `ref: refs/heads/<branch>`;
// - resolves the ref as a loose file under the gitdir, then under the common
//   dir (`<gitdir>/commondir`, which linked worktrees have), then in the
//   common dir's packed-refs. A branch with no commit yet (unborn) gives
//   head "".
// It gives up (undefined) on anything it cannot read exactly, such as a
// reftable ref store, and never throws.
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Hook events where a session starts or a prompt is sent: the ones whose spool line records HEAD. */
export const GIT_HEAD_EVENT = /^(session[._-]?start|UserPromptSubmit|beforeSubmitPrompt)$/i;

export interface GitHead {
  /** The work tree root (the directory holding `.git`). */
  root: string;
  /** The commit HEAD points at: 40 hex chars (64 in a SHA-256 repo), or "" on an unborn branch. */
  head: string;
  /** The checked-out branch, absent when HEAD is detached. */
  branch?: string;
}

const MAX_DEPTH = 40;
/** HEAD, loose refs, commondir and gitdir files are tiny; anything bigger is not one. */
const MAX_SMALL_FILE = 4096;
/** packed-refs is read up to this many bytes. */
const MAX_PACKED_REFS = 8 * 1024 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The first `max` bytes of a file as utf8, or undefined when it can't be read. */
function readHead(path: string, max: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const want = Math.min(max, fstatSync(fd).size);
    const buf = Buffer.allocUnsafe(want);
    let n = 0;
    while (n < want) {
      const r = readSync(fd, buf, n, want - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.toString("utf8", 0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // read-only fd: nothing to lose
      }
    }
  }
}

/** The work tree root as `git rev-parse --show-toplevel` prints it: the real path
 * (symlinks and Windows 8.3 short names resolved) with forward slashes. */
function gitStyleRoot(dir: string): string {
  let real = dir;
  try {
    real = realpathSync.native(dir);
  } catch {
    // keep `dir`: the directory exists (we found its .git), but a realpath hiccup is no reason to drop the read
  }
  return sep === "\\" ? real.split(sep).join("/") : real;
}

/** The `.git` entry at or above `cwd`: the work tree root and the git dir. */
function findGitDir(cwd: string): { root: string; gitDir: string } | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = join(dir, ".git");
    const st = statSync(dotGit, { throwIfNoEntry: false });
    if (st?.isDirectory()) return { root: dir, gitDir: dotGit };
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readHead(dotGit, MAX_SMALL_FILE) ?? "");
      return m ? { root: dir, gitDir: resolve(dir, m[1]!) } : undefined;
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** The sha `ref` names in packed-refs, scanning raw bytes (a 1 MB file takes well under a millisecond). */
function packedRef(commonDir: string, ref: string): string | undefined {
  const text = readHead(join(commonDir, "packed-refs"), MAX_PACKED_REFS);
  if (!text) return undefined;
  const needle = " " + ref;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const next = text.charCodeAt(end);
    if (end < text.length && next !== 10 && next !== 13) continue; // a longer ref with this prefix
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const sha = text.slice(lineStart, at);
    if (SHA.test(sha)) return sha;
  }
  return undefined;
}

/** The sha a ref points at; "" when it does not exist (unborn); undefined when unreadable. */
function resolveRef(gitDir: string, commonDir: string, ref: string, hops = 0): string | undefined {
  if (hops > 4 || !/^refs\/[^\0\\]+$/.test(ref) || ref.includes("..")) return undefined;
  for (const base of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
    const text = readHead(join(base, ref), MAX_SMALL_FILE);
    if (text === undefined) continue;
    const v = text.trim();
    if (SHA.test(v)) return v;
    const sym = /^ref:\s*(\S+)$/.exec(v);
    if (sym) return resolveRef(gitDir, commonDir, sym[1]!, hops + 1);
    return undefined;
  }
  return packedRef(commonDir, ref) ?? "";
}

/** The work tree root, HEAD commit and branch for `cwd`, or undefined (not a repo, unreadable). Never throws. */
export function readGitHead(cwd: string): GitHead | undefined {
  try {
    if (!cwd) return undefined;
    const found = findGitDir(cwd);
    if (!found) return undefined;
    const { gitDir } = found;
    const root = gitStyleRoot(found.root);
    const headText = readHead(join(gitDir, "HEAD"), MAX_SMALL_FILE);
    if (headText === undefined) return undefined;
    const v = headText.trim();
    if (SHA.test(v)) return { root, head: v };
    const m = /^ref:\s*(\S+)$/.exec(v);
    if (!m) return undefined;
    const ref = m[1]!;
    // reftable repos keep a placeholder HEAD; the refs live in binary tables.
    if (ref === "refs/heads/.invalid") return undefined;
    const common = readHead(join(gitDir, "commondir"), MAX_SMALL_FILE)?.trim();
    const commonDir = common ? resolve(gitDir, common) : gitDir;
    const head = resolveRef(gitDir, commonDir, ref);
    if (head === undefined) return undefined;
    const out: GitHead = { root, head };
    out.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    return out;
  } catch {
    return undefined;
  }
}
