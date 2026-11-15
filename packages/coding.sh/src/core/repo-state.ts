// Repo state for sessions whose capture path does no git work (agent hooks,
// transcript backfill). Filled at ingest, once per session, from its cwd:
//
// - root:   `git rev-parse --show-toplevel` of the cwd (cached per cwd per run;
//           the current HEAD and branch are cached per root, HEAD at a time per
//           root and second).
// - head:   the commit the agent reported at session start (Codex session_meta
//           git.commit_hash → session.start payload.gitCommit, or the HEAD a
//           0.1.3 hook read from .git → payload.git.commit), else HEAD at
//           session start read from the reflog, else (live capture only) the
//           current HEAD. "" when unknown, which eval drafting refuses.
// - branch: the agent's own record (Claude Code gitBranch, Codex git.branch →
//           session.start payload.gitBranch), else (live capture only) the
//           current branch.
//
// No snapshot: the working tree at session start is gone by the time ingest
// runs, so this is a HEAD-only start state (eval drafting marks it partial).
import type { RepoState, Session } from "../schema/index.ts";
import { branch as currentBranch, head as currentHead, headAt, repoRoot } from "./git.ts";

/** What a session's events say about its repo: the first session.start's payload (its git facts), and whether any event was captured live. */
export interface RepoFacts {
  start?: Record<string, unknown>;
  live: boolean;
}

export interface RepoResolver {
  /** Start repo state for a session that has none, or undefined (no cwd, not a git work tree). */
  start(session: Session, facts: RepoFacts): Promise<RepoState | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Git facts an adapter recorded on session.start (payload.gitBranch / gitCommit, or a nested payload.git). */
function startMeta(p: Record<string, unknown> | undefined): { branch?: string; commit?: string } {
  if (!p) return {};
  const git = typeof p.git === "object" && p.git !== null ? (p.git as Record<string, unknown>) : {};
  const out: { branch?: string; commit?: string } = {};
  const branch = str(p.gitBranch) ?? str(git.branch);
  // Claude Code records "HEAD" for a detached head: not a branch name.
  if (branch && branch !== "HEAD") out.branch = branch;
  const commit = str(p.gitCommit) ?? str(git.commit_hash) ?? str(git.commit);
  if (commit && /^[0-9a-f]{7,64}$/i.test(commit)) out.commit = commit;
  return out;
}

export interface RepoResolverOptions {
  /**
   * True once git must wait (a budgeted read past its deadline, a stopped run): start()
   * then runs no git and returns undefined, after calling `skipped` with the session id
   * so the caller can leave the session for a later ingest (core/ingest-deferred.ts).
   */
  stop?: () => boolean;
  skipped?: (sessionId: string) => void;
}

export function repoResolver(o: RepoResolverOptions = {}): RepoResolver {
  // One git call per cwd, root, or root and second for the whole run: an import of a few hundred
  // sessions in one big repo otherwise ran the same git commands hundreds of times.
  const roots = new Map<string, Promise<string | undefined>>();
  const heads = new Map<string, Promise<string | undefined>>();
  const branches = new Map<string, Promise<string | undefined>>();
  const headsAt = new Map<string, Promise<string | undefined>>();
  const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
  const once = <T>(m: Map<string, Promise<T | undefined>>, key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    let p = m.get(key);
    if (!p) m.set(key, (p = quiet(fn())));
    return p;
  };
  return {
    async start(session, facts) {
      if (session.repo || !session.cwd) return undefined;
      const cwd = session.cwd;
      if (o.stop?.() && !roots.has(cwd)) {
        o.skipped?.(session.id);
        return undefined;
      }
      const root = await once(roots, cwd, () => repoRoot(cwd));
      if (!root) return undefined;
      const meta = startMeta(facts.start);
      const live = facts.live;
      const needsGit = meta.commit === undefined || (meta.branch === undefined && live);
      if (needsGit && o.stop?.()) {
        o.skipped?.(session.id);
        return undefined;
      }
      let head = meta.commit ?? (await once(headsAt, `${root}\0${Math.floor(session.startedAt / 1000)}`, () => headAt(root, session.startedAt)));
      if (head === undefined && live) head = await once(heads, root, () => currentHead(root));
      const state: RepoState = { root, head: head ?? "" };
      const branch = meta.branch ?? (live ? await once(branches, root, () => currentBranch(root)) : undefined);
      if (branch) state.branch = branch;
      return state;
    },
  };
}
