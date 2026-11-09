// Session → commit attribution for one repository: which captured agent
// session wrote each line the commits on a branch added.
//
//   sessions (index, by repo root and its worktrees) ──sources.ts──▶ line pools
//   git log -p -U0 (oldest first, no merges)        ──git.ts─────▶ added lines
//                                                    ──match.ts───▶ Attribution[]
//
// Read-only on git. Results per commit are kept in the index key/value store
// (`attribution:commit:<sha>`) when asked, so other surfaces can read them
// without git. See docs/how-to/attribute-commits.md.
import { resolve } from "node:path";
import { repoRoot, run } from "../core/git.ts";
import type { Session } from "../core/types.ts";
import { hasGitAiNotes, readCommits, resolveCommit } from "./git.ts";
import { CLOCK_SKEW_MS, DEFAULT_WINDOW_MS, matchCommits, type CommitAttribution, type SessionSource } from "./match.ts";
import { sessionSource, type SourceContext } from "./sources.ts";

export type { Attribution, AttributedRange, AttributionMethod, CommitAttribution, SessionSource, SourceFile } from "./match.ts";

export class AttributionError extends Error {
  readonly reason: "not_a_repo" | "unknown_rev" | "not_found";
  constructor(message: string, reason: AttributionError["reason"]) {
    super(message);
    this.name = "AttributionError";
    this.reason = reason;
  }
}

export interface AttributeOptions {
  /** A directory inside the repository. */
  cwd: string;
  /** Branch or commit to walk back from. Default HEAD. */
  rev?: string;
  /** Only commits committed at or after this time (ms). Default: the first captured session in the repo. */
  since?: number;
  /** Days after a session's start that its lines can still be committed. Default 21. */
  windowMs?: number;
  /** Read git-ai notes (refs/notes/ai) when the repo has them. Default true. */
  gitAi?: boolean;
  /** Keep each commit's attributions in the index key/value store. */
  store?: boolean;
  /** Use these sessions instead of the index's (tests). */
  sessions?: Session[];
}

export interface SessionSummary {
  id: string;
  agent: string;
  model?: string;
  startedAt: number;
  /** Lines of this session found in the commits. */
  lines: number;
  commits: number;
}

export interface AttributionReport {
  root: string;
  /** The commit `rev` named. */
  rev: string;
  since: number;
  /** Sessions in the repo that had lines to match (with what they added). */
  sources: number;
  /** Sessions credited with at least one line, most lines first. */
  sessions: SessionSummary[];
  commits: CommitAttribution[];
  /** True when git-ai notes were read. */
  gitAi: boolean;
}

/** The repo root (and the roots of its other worktrees, where agents often work). */
export async function worktreeRoots(root: string): Promise<string[]> {
  const r = await run(["worktree", "list", "--porcelain"], { cwd: root, allowFail: true });
  const roots = new Set([root]);
  if (r.code === 0) for (const l of r.stdout.split("\n")) if (l.startsWith("worktree ")) roots.add(resolve(l.slice(9).trim())); // native separators: git prints C:/… on Windows
  return [...roots];
}

async function repoSessions(ctx: SourceContext, roots: string[], since: number | undefined): Promise<Session[]> {
  const seen = new Map<string, Session>();
  for (const root of roots) {
    const list = await ctx.index.listSessions({ repoRoot: root, ...(since !== undefined ? { since } : {}), limit: 1_000_000 });
    for (const s of list) seen.set(s.id, s);
  }
  return [...seen.values()].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export const commitKey = (sha: string) => `attribution:commit:${sha}`;

export async function attributeRepo(ctx: SourceContext, opts: AttributeOptions): Promise<AttributionReport> {
  const root = await repoRoot(opts.cwd);
  if (!root) throw new AttributionError(`not a git repository: ${opts.cwd}`, "not_a_repo");
  const rev = await resolveCommit(root, opts.rev ?? "HEAD");
  if (!rev) throw new AttributionError(`no commit named ${opts.rev ?? "HEAD"} in ${root}`, "unknown_rev");
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  const roots = await worktreeRoots(root);
  const sessions = opts.sessions ?? (await repoSessions(ctx, roots, opts.since !== undefined ? opts.since - windowMs : undefined));
  const sources = (await mapLimit(sessions, 4, (s) => sessionSource(ctx, s).catch(() => undefined))).filter((s): s is SessionSource => s !== undefined);

  const gitAi = opts.gitAi !== false && (await hasGitAiNotes(root));
  const firstStart = sessions.length ? sessions[0]!.startedAt - CLOCK_SKEW_MS : undefined;
  // No sessions and no notes: nothing can be credited, so read only the last 30 days of commits.
  const since = opts.since ?? firstStart ?? Date.now() - 30 * 24 * 3600_000;
  const commits = await readCommits(root, { rev, since, notes: gitAi });
  const matched = matchCommits(commits, sources, { windowMs });

  if (opts.store && ctx.index.kvSet) {
    for (const c of matched) {
      try {
        await ctx.index.kvSet(commitKey(c.commit), JSON.stringify({ added: c.added, attributed: c.attributed, attributions: c.attributions }));
      } catch {
        break; // read-only store
      }
    }
  }

  const byId = new Map<string, SessionSummary>();
  const meta = new Map(sources.map((s) => [s.sessionId, s]));
  for (const c of matched) {
    const inCommit = new Set<string>();
    for (const a of c.attributions) {
      let s = byId.get(a.sessionId);
      if (!s) {
        const src = meta.get(a.sessionId);
        s = { id: a.sessionId, agent: a.agent, ...(a.model ? { model: a.model } : {}), startedAt: src?.startedAt ?? 0, lines: 0, commits: 0 };
        byId.set(a.sessionId, s);
      }
      s.lines += a.lines;
      if (!inCommit.has(a.sessionId)) {
        inCommit.add(a.sessionId);
        s.commits++;
      }
    }
  }
  return {
    root,
    rev,
    since,
    sources: sources.length,
    sessions: [...byId.values()].sort((a, b) => b.lines - a.lines || a.startedAt - b.startedAt),
    commits: matched,
    gitAi,
  };
}
