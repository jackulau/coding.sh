// Repo state for sessions whose capture path does no git work (agent hooks,
// transcript backfill). Filled at ingest, once per session, from its cwd:
//
// - root:   `git rev-parse --show-toplevel` of the cwd (cached per cwd per run).
// - head:   the commit the agent reported at session start (Codex session_meta
//           git.commit_hash → session.start payload.gitCommit), else HEAD at
//           session start read from the reflog, else (live capture only) the
//           current HEAD. "" when unknown, which eval drafting refuses.
// - branch: the agent's own record (Claude Code gitBranch, Codex git.branch →
//           session.start payload.gitBranch), else (live capture only) the
//           current branch.
//
// No snapshot: the working tree at session start is gone by the time ingest
// runs, so this is a HEAD-only start state (eval drafting marks it partial).
import type { AgentEvent, RepoState, Session } from "../schema/index.ts";
import { branch as currentBranch, head as currentHead, headAt, repoRoot } from "./git.ts";
import { isBackfillEvent } from "./sessions.ts";

export interface RepoResolver {
  /** Start repo state for a session that has none, or undefined (no cwd, not a git work tree). */
  start(session: Session, events: readonly AgentEvent[]): Promise<RepoState | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Git facts an adapter recorded on session.start (payload.gitBranch / gitCommit, or a nested payload.git). */
function startMeta(events: readonly AgentEvent[]): { branch?: string; commit?: string } {
  const start = events.find((e) => e.kind === "session.start");
  if (!start) return {};
  const p = start.payload;
  const git = typeof p.git === "object" && p.git !== null ? (p.git as Record<string, unknown>) : {};
  const out: { branch?: string; commit?: string } = {};
  const branch = str(p.gitBranch) ?? str(git.branch);
  // Claude Code records "HEAD" for a detached head: not a branch name.
  if (branch && branch !== "HEAD") out.branch = branch;
  const commit = str(p.gitCommit) ?? str(git.commit_hash) ?? str(git.commit);
  if (commit && /^[0-9a-f]{7,64}$/i.test(commit)) out.commit = commit;
  return out;
}

export function repoResolver(): RepoResolver {
  const roots = new Map<string, Promise<string | undefined>>();
  const rootOf = (cwd: string) => {
    let p = roots.get(cwd);
    if (!p) roots.set(cwd, (p = repoRoot(cwd).catch(() => undefined)));
    return p;
  };
  const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
  return {
    async start(session, events) {
      if (session.repo || !session.cwd) return undefined;
      const root = await rootOf(session.cwd);
      if (!root) return undefined;
      const meta = startMeta(events);
      const live = events.some((e) => !isBackfillEvent(e));
      let head = meta.commit ?? (await quiet(headAt(root, session.startedAt)));
      if (head === undefined && live) head = await quiet(currentHead(root));
      const state: RepoState = { root, head: head ?? "" };
      const branch = meta.branch ?? (live ? await quiet(currentBranch(root)) : undefined);
      if (branch) state.branch = branch;
      return state;
    },
  };
}
