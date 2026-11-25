// The MCP improve and harness_changes tools: the `coding.sh improve` report
// and `coding.sh improve check`, compact enough to read in one turn. Read-only;
// the agent edits CLAUDE.md or AGENTS.md with its own tools.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { Context } from "../core/context.ts";
import { repoRoot } from "../core/git.ts";
import { parseSince } from "../cli/args.ts";
import type { ChangeEffect, GroupStats } from "../improve/changes.ts";
import { findChanges, findIssues, headlessAfter, isHeadless, modelProvider, removalStep, scopeSessions, stepsFor, targetFile, testCommandOf, withHeadless, type ChangeOptions } from "../improve/report.ts";
import { clip, iso, matchesPlace, pathPlace } from "./data.ts";
import { ToolError } from "./protocol.ts";

type Obj = Record<string, unknown>;

export interface ImproveArgs {
  repo?: string | undefined;
  since?: string | undefined;
  agent?: string | undefined;
  limit?: number | undefined;
  /** Keep headless sessions (claude -p, codex exec), left out by default. */
  headless?: boolean | undefined;
}

const DAY = 86_400_000;

function since(text: string | undefined, dflt: string, now: number): number {
  const t = text ?? dflt;
  try {
    return parseSince(t, now);
  } catch {
    throw new ToolError(`since must be a duration like 7d or 12h, or an ISO date: got ${JSON.stringify(t)}`);
  }
}

/**
 * The repo to read: `repo` as a path (its git root, or the path), as a bare folder
 * name (the newest captured session's repo with that name), "all" for every repo,
 * else the git repo the server runs in, else every repo. `git` says `root` is a git repo's root.
 */
async function place(ctx: Context, repo: string | undefined, cwd: string, env: NodeJS.ProcessEnv): Promise<{ dir?: string; root?: string; git?: boolean }> {
  const r = repo?.trim();
  if (r === "all") return {};
  if (!r) {
    const root = await repoRoot(cwd).catch(() => undefined);
    return root ? { dir: root, root, git: true } : {};
  }
  if (r === "~" || r.startsWith("~/") || isAbsolute(r) || r.startsWith(".") || /[\\/]/.test(r)) {
    const dir = r === "~" || r.startsWith("~/") ? resolve(env.HOME ?? homedir(), r.slice(2)) : resolve(cwd, r);
    const root = await repoRoot(dir).catch(() => undefined);
    return root ? { dir, root, git: true } : { dir, root: dir };
  }
  const recent = await ctx.index.listSessions({ parentSessionId: null, limit: 500 });
  const hit = recent.find((s) => (s.repo?.root && basename(s.repo.root) === r) || (s.cwd && basename(s.cwd) === r));
  const dir = hit?.repo?.root ?? hit?.cwd;
  if (!dir) throw new ToolError(`No captured session in a repo named ${JSON.stringify(r)}. Pass an absolute path, or call sessions_list to see the repos.`);
  return { dir, root: dir, git: !!(await repoRoot(dir).catch(() => undefined)) };
}

/** Sessions still flagged after a change, listed per change by harness_changes: a few when listing changes, more for one commit. */
const FLAGGED_LIST = 5;
const FLAGGED_COMMIT = 20;

/** The newest `max` flagged sessions in a group (id, start, flags, title), and how many more there are. */
function flaggedList(g: GroupStats, max: number): Obj {
  const list = g.flaggedSessions;
  return {
    flaggedSessions: list.slice(0, max).map((s) => ({ sessionId: s.id, at: iso(s.startedAt), flags: s.flags, ...(s.title ? { title: clip(s.title, 80) } : {}) })),
    ...(list.length > max ? { moreFlagged: list.length - max } : {}),
  };
}

/**
 * One change, compact: what changed, the verdict and why, and the counts behind it.
 * `full` adds the lines, the before/after counts with the sessions still flagged
 * after it (up to `flagged`), and the new lines' uptake. `headlessLeftOut`: the
 * headless sessions that ran after a change no counted session ran with.
 */
export function changeSummary(e: ChangeEffect, o: { full?: boolean; flagged?: number; headlessLeftOut?: number | undefined } = {}): Obj {
  const c = e.change;
  return {
    commit: c.short,
    at: iso(c.at),
    subject: clip(c.subject, 120),
    files: c.files.map((f) => f.path),
    verdict: e.verdict,
    reason: e.reason,
    ...(o.headlessLeftOut ? { headlessLeftOut: o.headlessLeftOut } : {}),
    ...(o.full
      ? {
          added: c.added.slice(0, 8).map((l) => clip(l, 200)),
          removed: c.removed.slice(0, 5).map((l) => clip(l, 200)),
          before: { sessions: e.before.sessions, flagged: e.before.flagged, byFlag: e.before.byFlag },
          after: { sessions: e.after.sessions, flagged: e.after.flagged, byFlag: e.after.byFlag, examples: e.after.examples.slice(0, 3), ...flaggedList(e.after, o.flagged ?? FLAGGED_LIST) },
          ...(e.p !== undefined ? { p: Math.round(e.p * 1000) / 1000 } : {}),
          rules: e.rules.map((r) => ({ line: clip(r.text, 160), followedBefore: `${r.before.acted}/${r.before.n}`, followedAfter: `${r.after.acted}/${r.after.n}`, ...(r.p !== undefined ? { p: Math.round(r.p * 1000) / 1000 } : {}) })),
          ...(e.work ? { work: Object.fromEntries(Object.entries(e.work).map(([k, m]) => [k, { ...m, p: Math.round(m.p * 1000) / 1000 }])) } : {}),
          ...(removalStep(e) ? { next: removalStep(e)!.command } : {}),
        }
      : {}),
  };
}

/** What a change's reason says counts the headless sessions it leaves out: the tools' argument, not the CLI's --headless. */
const HEADLESS_ARG = "headless: true";

/**
 * The changes, compact (changeSummary). One no counted session ran with while headless
 * sessions did says so, how many (headlessLeftOut) and that `headless: true` counts them,
 * where "No captured session ran" would be false.
 */
async function summaries(ctx: Context, root: string, opts: ChangeOptions, changes: readonly ChangeEffect[], o: { full?: boolean; flagged?: number } = {}): Promise<Obj[]> {
  const leftOut = await headlessAfter(ctx.index, root, opts, changes);
  return withHeadless(changes, leftOut, HEADLESS_ARG).map((e) => changeSummary(e, { ...o, headlessLeftOut: leftOut.get(e.change.commit) }));
}

/** The improve tool: ranked issues with the line that fixes each, then the recent harness changes' verdicts. `c.ref` names a session in a `next` command (default the id). */
export async function improveReport(ctx: Context, a: ImproveArgs, c: { cwd: string; env: NodeJS.ProcessEnv; now: number; ref?: (id: string) => string }): Promise<Obj> {
  const p = await place(ctx, a.repo, c.cwd, c.env);
  const from = since(a.since, "14d", c.now);
  const agents = a.agent ? [a.agent] : [];
  // At a checkout's root or in a linked worktree: the whole repo, every worktree's sessions included.
  const whole = p.dir ? pathPlace(p.dir) : undefined;
  const scope = { since: from, ...(agents.length ? { agents } : {}), headless: true };
  const all = whole?.repo
    ? (await scopeSessions(ctx.index, scope)).filter((s) => matchesPlace(s, whole))
    : await scopeSessions(ctx.index, { ...scope, ...(p.dir ? { repo: p.dir } : {}) });
  const sessions = a.headless ? all : all.filter((s) => !isHeadless(s));
  const testCommand = await testCommandOf(p.root);
  const issues = await findIssues(ctx.index, sessions, { ...(p.root ? { repoRoot: p.root } : {}), ...(testCommand ? { testCommand } : {}) });
  const changeOpts: ChangeOptions = { since: c.now - 30 * DAY, limit: 3, ...(agents.length ? { agents } : {}), headless: a.headless === true };
  const changes = p.root ? await summaries(ctx, p.root, changeOpts, await findChanges(ctx.index, p.root, changeOpts)) : [];
  const provider = modelProvider(c.env);
  const limit = a.limit ?? 5;
  const top = issues.slice(0, limit);
  return {
    scope: { repo: whole?.repo ?? p.dir ?? null, since: iso(from), sessions: sessions.length, ...(all.length > sessions.length ? { headlessLeftOut: all.length - sessions.length } : {}) },
    issues: top.map((i, k) => {
      const ex = i.examples[0];
      const agentsOf = sessions.filter((s) => i.examples.some((x) => x.sessionId === s.id)).map((s) => s.agent);
      return {
        rank: k + 1,
        id: i.id,
        title: i.title,
        sessions: i.sessions,
        severity: i.severity.level,
        ...(ex ? { example: { sessionId: ex.sessionId, ...(ex.title ? { title: clip(ex.title, 100) } : {}) } } : {}),
        ...(i.quietSince ? { quietSince: i.quietSince } : {}),
        ...(i.sample ? { error: i.sample } : {}),
        fix: i.fix,
        ...(i.usd !== undefined ? { usd: i.usd } : {}),
        ...(i.causes ? { causes: i.causes.map((k) => ({ cause: k.cause, breaks: k.breaks, usd: k.usd, fix: k.fix })) } : {}),
        ...(i.rule && !i.quietSince ? { line: i.rule, file: p.root ? targetFile(p.root, agentsOf) : "AGENTS.md or CLAUDE.md" } : {}),
        next: stepsFor(i, k + 1, { provider, ref: c.ref }).map((s) => s.command),
      };
    }),
    ...(issues.length > top.length ? { more: issues.length - top.length } : {}),
    changes,
    ...(p.root ? {} : { note: "Not in a git repo: pass repo to see whether its AGENTS.md or CLAUDE.md changes helped." }),
  };
}

/** The harness_changes tool: each committed harness change, before vs after. */
export async function harnessChangesReport(ctx: Context, a: ImproveArgs & { commit?: string | undefined }, c: { cwd: string; env: NodeJS.ProcessEnv; now: number }): Promise<Obj> {
  const p = await place(ctx, a.repo, c.cwd, c.env);
  if (!p.root) throw new ToolError("harness_changes reads a repo's git history: pass repo (a path or a captured repo's folder name), or run the server inside the repo.");
  // A path with no git history has no changes to report: say so, not "no commits changed AGENTS.md".
  if (!p.git) {
    const why = existsSync(p.root) ? "is not in a git repo" : "does not exist";
    throw new ToolError(`repo ${p.root} ${why}: harness_changes reads a repo's git history. Pass a git repo's path or a captured repo's folder name (sessions_list shows them).`);
  }
  const from = since(a.since, a.commit ? "365d" : "30d", c.now);
  const opts: ChangeOptions = { since: from, limit: a.commit ? 50 : (a.limit ?? 5), ...(a.agent ? { agents: [a.agent] } : {}), headless: a.headless === true };
  const all = await findChanges(ctx.index, p.root, opts);
  const commit = a.commit?.trim().toLowerCase();
  const picked = commit ? all.filter((e) => e.change.commit.startsWith(commit)) : all;
  if (commit && !picked.length) throw new ToolError(`No harness change ${JSON.stringify(a.commit)} in ${p.root} since ${iso(from)}. Call harness_changes without commit to list them.`);
  return {
    repo: p.root,
    changes: await summaries(ctx, p.root, opts, picked, { full: true, flagged: commit ? FLAGGED_COMMIT : FLAGGED_LIST }),
    ...(picked.length ? {} : { note: "No commits changed AGENTS.md, CLAUDE.md, GEMINI.md, a rule or a skill in this window." }),
  };
}
