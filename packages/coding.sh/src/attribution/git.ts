// Read-only git for attribution. Every command here reads: log, diff, blame,
// rev-parse. Nothing writes to the user's repository (refs, index, notes,
// objects) or to the shadow repo. Snapshot diffs read the shadow repo of
// core/snapshot.ts only when it already exists.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../core/git.ts";
import { shadowRepoPath } from "../core/snapshot.ts";
import { parseUnifiedDiff, unquoteGitPath, type FilePatch } from "./lines.ts";

export const GIT_AI_NOTES_REF = "refs/notes/ai";

export interface CommitPatch {
  sha: string;
  parents: string[];
  /** Committer time, ms. */
  committedAt: number;
  /** Author time, ms (kept by a rebase). */
  authoredAt: number;
  author: string;
  subject: string;
  files: FilePatch[];
  /** The commit's git-ai note, when asked for and present. */
  note?: string;
}

const DIFF_FLAGS = ["--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "-U0"];
/** git log output for a long range can be large; attribution never needs more than this. */
const MAX_LOG_BYTES = 512 * 1024 * 1024;

export async function resolveCommit(root: string, rev: string): Promise<string | undefined> {
  const r = await run(["rev-parse", "-q", "--verify", `${rev}^{commit}`], { cwd: root, allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** True when the repo has git-ai notes (checked first: `--notes` on a missing ref prints a warning). */
export async function hasGitAiNotes(root: string): Promise<boolean> {
  return (await run(["rev-parse", "-q", "--verify", GIT_AI_NOTES_REF], { cwd: root, allowFail: true })).code === 0;
}

export interface LogOptions {
  rev?: string;
  /** Only commits committed at or after this time (ms). */
  since?: number;
  /** Only these commits (full shas): each is read with `git show`, in the order given. */
  commits?: string[];
  /** Also read each commit's git-ai note. */
  notes?: boolean;
  timeoutMs?: number;
}

const FORMAT = "%x01%H%x09%P%x09%ct%x09%at%x09%an%x09%s";

function parseLog(text: string, notes: boolean): CommitPatch[] {
  const out: CommitPatch[] = [];
  for (const rec of text.split("\x01")) {
    if (!rec) continue;
    const nl = rec.indexOf("\n");
    let header = nl < 0 ? rec : rec.slice(0, nl);
    let body = nl < 0 ? "" : rec.slice(nl + 1);
    let note: string | undefined;
    if (notes) {
      // FORMAT + "%x02%N%x03": the note may span lines, so the header ends at \x03.
      const a = rec.indexOf("\x02");
      const b = rec.indexOf("\x03", a + 1);
      if (a >= 0 && b > a) {
        header = rec.slice(0, a);
        note = rec.slice(a + 1, b).trim() || undefined;
        body = rec.slice(b + 1);
      }
    }
    const [sha, parents, ct, at, author, ...subject] = header.split("\t");
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    out.push({
      sha,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      committedAt: Number(ct) * 1000,
      authoredAt: Number(at) * 1000,
      author: author ?? "",
      subject: subject.join("\t"),
      files: parseUnifiedDiff(body),
      ...(note ? { note } : {}),
    });
  }
  return out;
}

/**
 * Non-merge commits reachable from `rev` (default HEAD), oldest first, each
 * with the lines it added (`-U0`, against its first parent; a root commit
 * against the empty tree).
 */
export async function readCommits(root: string, opts: LogOptions = {}): Promise<CommitPatch[]> {
  const notes = opts.notes === true;
  const format = notes ? `${FORMAT}%x02%N%x03` : FORMAT;
  const base = ["-c", "core.quotePath=false", "-c", "log.showSignature=false"];
  const noteArgs = notes ? [`--notes=${GIT_AI_NOTES_REF}`] : ["--no-notes"];
  const timeoutMs = opts.timeoutMs ?? 120_000;
  if (opts.commits) {
    if (!opts.commits.length) return [];
    const r = await run([...base, "show", "--no-walk=unsorted", "-p", ...DIFF_FLAGS, ...noteArgs, `--format=${format}`, ...opts.commits, "--"], {
      cwd: root,
      timeoutMs,
      maxBuffer: MAX_LOG_BYTES,
    });
    return parseLog(r.stdout, notes);
  }
  const args = [...base, "log", "--reverse", "--topo-order", "--no-merges", "-p", ...DIFF_FLAGS, ...noteArgs, `--format=${format}`];
  if (opts.since !== undefined) args.push(`--since=${new Date(opts.since).toISOString()}`);
  args.push(opts.rev ?? "HEAD", "--");
  const r = await run(args, { cwd: root, timeoutMs, maxBuffer: MAX_LOG_BYTES });
  return parseLog(r.stdout, notes);
}

/**
 * The files a session changed, as added lines: the diff from `from` (its
 * start snapshot or HEAD) to `to` (its end snapshot), read from the shadow
 * repo. Undefined when the shadow repo or either commit is gone.
 */
export async function snapshotPatch(root: string, from: string, to: string, env: NodeJS.ProcessEnv): Promise<FilePatch[] | undefined> {
  const shadow = shadowRepoPath(root, env);
  if (!existsSync(join(shadow, "HEAD"))) return undefined;
  const r = await run(["-c", "core.quotePath=false", "diff", ...DIFF_FLAGS, from, to, "--"], {
    cwd: shadow,
    env: { GIT_DIR: shadow },
    allowFail: true,
    timeoutMs: 60_000,
    maxBuffer: MAX_LOG_BYTES,
  });
  if (r.code !== 0) return undefined;
  return parseUnifiedDiff(r.stdout);
}

export interface BlameLine {
  /** 1-based line in the file at the blamed revision. */
  line: number;
  commit: string;
  /** Line number and path in `commit`'s version of the file. */
  origLine: number;
  origPath: string;
  text: string;
  /** The line predates the history git walked (`boundary`). */
  boundary?: boolean;
}

/** `git blame --porcelain` of one file at `rev`, optionally only lines [from, to]. */
export async function blame(root: string, path: string, rev: string, lines?: [number, number]): Promise<BlameLine[]> {
  const args = ["-c", "core.quotePath=false", "blame", "--porcelain"];
  if (lines) args.push("-L", `${lines[0]},${lines[1]}`);
  args.push(rev, "--", path);
  const r = await run(args, { cwd: root, timeoutMs: 120_000, maxBuffer: MAX_LOG_BYTES });
  const out: BlameLine[] = [];
  const info = new Map<string, { path?: string; boundary?: boolean }>();
  let cur: { commit: string; orig: number; final: number } | undefined;
  for (const l of r.stdout.split("\n")) {
    const head = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(l);
    if (head) {
      cur = { commit: head[1]!, orig: Number(head[2]), final: Number(head[3]) };
      if (!info.has(cur.commit)) info.set(cur.commit, {});
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("\t")) {
      const i = info.get(cur.commit)!;
      out.push({ line: cur.final, commit: cur.commit, origLine: cur.orig, origPath: i.path ?? path, text: l.slice(1), ...(i.boundary ? { boundary: true } : {}) });
      cur = undefined;
      continue;
    }
    if (l.startsWith("filename ")) info.get(cur.commit)!.path = unquoteGitPath(l.slice(9));
    else if (l === "boundary") info.get(cur.commit)!.boundary = true;
  }
  return out;
}
