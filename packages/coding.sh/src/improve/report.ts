// The improve report: what to fix first in a repo's recent sessions, and
// whether the harness changes already made helped. Shared by `coding.sh
// improve` and the MCP improve / harness_changes tools.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import { redactShown } from "../core/redact.ts";
import type { IndexStore } from "../core/types.ts";
import { insideDir } from "../eval/decision.ts";
import { extractTestCommand, guessVerifierFromEvents, guessVerifierFromRepo, inspectRepo } from "../eval/task.ts";
import { autoCliProvider, CLI_PLAN, isCliProvider, type CliProvider } from "../judge/subscription.ts";
import { changeEffects, currentVersion, sessionVersions, type ChangeEffect, type GroupStats } from "./changes.ts";
import { failureRecords, rankIssues, type FailureRecord, type Issue } from "./issues.ts";

export interface ImproveScope {
  /** Only sessions at or under this directory (a repo root); undefined: every repo. */
  repo?: string;
  since: number;
  agents?: readonly string[];
  /** Keep headless sessions (isHeadless); left out by default. */
  headless?: boolean;
}

/** Most sessions read for one report, and most whose events are read for failures. */
export const MAX_SESSIONS = 2000;
const SCOPE_PAGE = 500;
const MAX_EVENT_SESSIONS = 300;
const DAY = 86_400_000;

/**
 * A session the agent ran headless: `claude -p`, an Agent SDK, `codex exec` (Session.stats.launch,
 * from the agent's own record of how it started). Mostly scripts, judges and evals: one-shot
 * prompts nobody watched, whose habits a CLAUDE.md line is not meant to change.
 */
export const isHeadless = (s: Session): boolean => s.stats.launch === "headless";

/** The sessions in scope, and how many more were in scope but past the cap. */
export interface ReadScope {
  /** Newest first, at most `max`. */
  sessions: Session[];
  /** Sessions in scope that the cap left out, the oldest ones; 0 when none. */
  notRead: number;
  /** Headless top-level sessions left out (without `headless`); 0 when none. */
  headlessLeftOut: number;
}

/**
 * The sessions in scope, newest first, at most `max` (MAX_SESSIONS): top-level
 * sessions and their subagents and delegates, no eval or benchmark runs, and no
 * headless top-level ones unless `headless`. A child is in scope when the
 * session it hangs from is (its own launch is headless because that session
 * started it), and starts after `since` and runs a chosen agent. `match`
 * replaces the repo test (`--place`).
 */
export async function readScope(index: IndexStore, s: ImproveScope, o: { match?: (x: Session) => boolean; max?: number } = {}): Promise<ReadScope> {
  const max = o.max ?? MAX_SESSIONS;
  const inPlace = o.match ?? ((x: Session) => !s.repo || insideDir(s.repo, x.repo?.root) || insideDir(s.repo, x.cwd));
  const agentOk = (x: Session) => !s.agents?.length || s.agents.includes(x.agent);
  const listed: Session[] = [];
  for (let offset = 0; ; offset += SCOPE_PAGE) {
    const page = await index.listSessions({ runId: null, since: s.since, limit: SCOPE_PAGE, offset });
    listed.push(...page);
    if (page.length < SCOPE_PAGE) break;
  }
  const byId = new Map(listed.map((x) => [x.id, x]));
  // The session a child hangs from, up the chain: from this listing, else from the store (it started before `since`).
  const fetched = new Map<string, Session | undefined>();
  const parentOf = async (x: Session): Promise<Session | undefined> => {
    const id = x.parent?.sessionId;
    if (!id) return undefined;
    if (byId.has(id)) return byId.get(id);
    if (!fetched.has(id)) fetched.set(id, await index.getSession(id));
    return fetched.get(id);
  };
  // Whether the top of a session's chain is in scope: "in", "out", or "headless" (in scope but for --headless).
  type Root = "in" | "out" | "headless";
  const rootKept = new Map<string, Root>();
  const keptRoot = async (x: Session): Promise<Root> => {
    const chain: Session[] = [];
    let at: Session | undefined = x;
    while (at && !rootKept.has(at.id) && chain.length < 16) {
      chain.push(at);
      at = at.parent ? await parentOf(at) : undefined;
    }
    let ok: Root;
    if (at && rootKept.has(at.id)) ok = rootKept.get(at.id)!;
    else {
      // The top of the chain: a top-level session, or a child whose parent the store no longer has (judged on its own).
      const top = chain.at(-1)!;
      ok = chain.some((c) => c.runId) || !inPlace(top) ? "out" : s.headless || top.parent || !isHeadless(top) ? "in" : "headless";
    }
    for (const c of chain) rootKept.set(c.id, ok);
    return ok;
  };
  const kept: Session[] = [];
  let headlessLeftOut = 0;
  for (const x of listed) {
    if (x.startedAt < s.since || x.runId || !agentOk(x)) continue;
    const root = await keptRoot(x);
    if (root === "in") kept.push(x);
    else if (root === "headless" && !x.parent) headlessLeftOut++;
  }
  // A store lists newest first; a session it does not order is placed by its start.
  kept.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
  return { sessions: kept.slice(0, max), notRead: Math.max(0, kept.length - max), headlessLeftOut };
}

/** What the cap left out, as a sentence: `read` sessions were read and `notRead` older ones were not. "" when none was left out. */
export const notReadLine = (read: number, notRead: number): string =>
  notRead ? `Read the newest ${read} sessions in scope; ${notRead} older ${notRead === 1 ? "session" : "sessions"} not read. A shorter --since reads them all.` : "";

/** The sessions in scope, newest first (readScope without the count past the cap). */
export async function scopeSessions(index: IndexStore, s: ImproveScope): Promise<Session[]> {
  return (await readScope(index, s)).sessions;
}

/**
 * The repo's own test command, e.g. `npm test`: from its manifests, else the
 * first one its AGENTS.md (or CLAUDE.md) names in code. Undefined when neither has one.
 */
export async function testCommandOf(root: string | undefined): Promise<string | undefined> {
  if (!root || !existsSync(root)) return undefined;
  try {
    return guessVerifierFromRepo(await inspectRepo(root)) ?? namedTestCommand(root);
  } catch {
    return undefined;
  }
}

/** The first test command an instructions file names in a code span or block. */
export function namedTestCommand(root: string): string | undefined {
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split("\n"));
    for (const line of code) {
      const t = extractTestCommand(line.replace(/\s+#.*$/, "").trim(), root);
      if (t) return t;
    }
  }
  return undefined;
}

/** The test command most sessions ran last (ties: the newest session's), or undefined. */
async function sessionTestCommand(index: IndexStore, sessions: readonly Session[], repoRoot: string | undefined): Promise<string | undefined> {
  const counts = new Map<string, number>();
  for (const s of sessions.filter((x) => x.stats.toolCalls > 0).slice(0, MAX_EVENT_SESSIONS)) {
    const t = guessVerifierFromEvents(await index.listEvents(s.id, { kinds: ["tool.start"], limit: 5000 }), repoRoot ?? s.repo?.root);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: [string, number] | undefined;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best?.[0];
}

/**
 * Sessions flagged no-verification that never said anything (a `coding.sh run`
 * wrapper records the command, not the agent's words): with no claim of being
 * done there is nothing unverified, so the flag is left out of the report.
 */
async function withoutSilentClaims(index: IndexStore, sessions: readonly Session[]): Promise<Session[]> {
  const out: Session[] = [];
  let read = 0;
  for (const s of sessions) {
    if (!s.flags?.includes("no-verification")) {
      out.push(s);
      continue;
    }
    const silent = s.agent === "wrapper" || (read++ < MAX_EVENT_SESSIONS && !(await index.listEvents(s.id, { kinds: ["assistant.message"], limit: 1 })).length);
    out.push(silent ? { ...s, flags: s.flags.filter((f) => f !== "no-verification") } : s);
  }
  return out;
}

/** The ranked issues in `sessions`. */
export async function findIssues(index: IndexStore, sessions: readonly Session[], o: { repoRoot?: string; testCommand?: string } = {}): Promise<Issue[]> {
  sessions = await withoutSilentClaims(index, sessions);
  const testCommand = o.testCommand ?? (await sessionTestCommand(index, sessions, o.repoRoot));
  const failures = new Map<string, FailureRecord[]>();
  const withFailures = sessions.filter((s) => s.stats.toolErrors > 0 || (s.stats.testsFailed ?? 0) > 0).slice(0, MAX_EVENT_SESSIONS);
  for (const s of withFailures) {
    const events = await index.listEvents(s.id, { kinds: ["tool.start", "tool.end", "test.result", "file.change"], limit: 5000 });
    const recs = failureRecords(events, o.repoRoot ?? s.repo?.root);
    if (recs.length) failures.set(s.id, recs);
  }
  const ranked = rankIssues(sessions, failures, testCommand ? { testCommand } : {}).map(shownIssue);
  return o.repoRoot ? markQuiet(o.repoRoot, sessions, ranked) : ranked;
}

/**
 * An issue as improve shows it: the text that comes from sessions (example titles,
 * the error line, the command) goes through redactShown. Stored events were
 * redacted for secrets at capture, but by the rules of that day and not for
 * emails, and the report is what gets pasted into issues and sent to a model.
 */
export function shownIssue(i: Issue): Issue {
  return {
    ...i,
    title: redactShown(i.title),
    fix: redactShown(i.fix),
    examples: i.examples.map((x) => (x.title ? { ...x, title: redactShown(x.title) } : x)),
    ...(i.command !== undefined ? { command: redactShown(i.command) } : {}),
    ...(i.sample !== undefined ? { sample: redactShown(i.sample) } : {}),
  };
}

const shownGroup = (g: GroupStats): GroupStats => ({ ...g, flaggedSessions: g.flaggedSessions.map((s) => (s.title ? { ...s, title: redactShown(s.title) } : s)) });

/** A harness change as improve shows it: session titles, the subject and the changed lines through redactShown. */
export function shownChange(e: ChangeEffect): ChangeEffect {
  const c = e.change;
  return {
    ...e,
    change: { ...c, subject: redactShown(c.subject), added: c.added.map(redactShown), removed: c.removed.map(redactShown) },
    before: shownGroup(e.before),
    after: shownGroup(e.after),
    rules: e.rules.map((r) => ({ ...r, text: redactShown(r.text) })),
  };
}

/**
 * Harness changes in `root` since `since` (newest first, at most `limit`), with the
 * sessions before and after each. Sessions are read from 30 days before `since`,
 * so the oldest change still has a baseline; from under `root`, or `sessionsIn`
 * (another dir, or "all": the project's other checkouts and worktrees).
 */
export async function findChanges(index: IndexStore, root: string, o: { since: number; limit?: number; agents?: readonly string[]; sessionsIn?: string; headless?: boolean }): Promise<ChangeEffect[]> {
  const repo = o.sessionsIn === "all" ? undefined : (o.sessionsIn ?? root);
  const sessions = await scopeSessions(index, { ...(repo ? { repo } : {}), since: o.since - 30 * DAY, ...(o.agents ? { agents: o.agents } : {}), ...(o.headless ? { headless: true } : {}) });
  try {
    const effects = await changeEffects(root, sessions, {
      since: o.since,
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
      events: (id: string): Promise<AgentEvent[]> => index.listEvents(id, { kinds: ["tool.start", "tool.end", "file.change"], limit: 5000 }),
    });
    return effects.map(shownChange);
  } catch {
    // git missing or the repo unreadable: no change history to report.
    return [];
  }
}

/** The largest chance that sessions on the current harness all miss an issue by luck for improve to call it quiet. */
export const QUIET_CHANCE = 0.2;

/**
 * Marks the issues no session on the repo's current harness version had, when that
 * absence is unlikely to be luck: the last harness change may have fixed them. With
 * `rate` the share of `sessions` that had the issue and `n` the sessions on the current
 * version, an issue is quiet only when (1 - rate)^n < QUIET_CHANCE, the chance that n
 * sessions miss it with nothing changed. Quiet issues move after the others, in their
 * order; the rest stay where they were.
 */
export async function markQuiet(root: string, sessions: readonly Session[], issues: readonly Issue[]): Promise<Issue[]> {
  try {
    const current = await currentVersion(root);
    if (!current) return [...issues];
    const versions = await sessionVersions(root, sessions);
    const onCurrent = new Set(sessions.filter((s) => versions.get(s.id) === current).map((s) => s.id));
    if (!onCurrent.size) return [...issues];
    const quietSince = { commit: current.slice(0, 7), sessions: onCurrent.size };
    const unlikelyByChance = (i: Issue) => (1 - Math.min(1, i.sessionIds.length / sessions.length)) ** onCurrent.size < QUIET_CHANCE;
    const marked = issues.map((i) => (i.sessionIds.some((id) => onCurrent.has(id)) || !unlikelyByChance(i) ? i : { ...i, quietSince }));
    return [...marked.filter((i) => !i.quietSince), ...marked.filter((i) => i.quietSince)];
  } catch {
    return [...issues];
  }
}

export interface Step {
  /** What it gets you, in a few words. */
  label: string;
  command: string;
}

export type ModelProvider = "anthropic" | "openai" | CliProvider;

/**
 * The provider exp ab can call: anthropic (its default) when its key is set,
 * then openai, then a logged-in Claude Code or Codex (a subscription);
 * undefined with none of them.
 */
export function modelProvider(env: NodeJS.ProcessEnv): ModelProvider | undefined {
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  return autoCliProvider(env)?.provider;
}

/** What testing an edit needs when modelProvider finds nothing. */
export const NEEDS_MODEL = "needs ANTHROPIC_API_KEY, OPENAI_API_KEY, or Claude Code or Codex logged in";

/** The exp ab command that replays one behavior's decision points with that provider (exp ab picks a logged-in Claude Code by itself). */
export const abCommand = (behavior: string, provider: ModelProvider | undefined): string =>
  `coding.sh exp ab --behavior ${behavior}${provider === "openai" || provider === "codex" ? ` --provider ${provider}` : ""}`;

/** The commands that take one issue through the loop: look, edit, test, keep. `n` is its 1-based rank; `provider` undefined: no model API key. */
export function stepsFor(issue: Issue, n: number, o: { provider: ModelProvider | undefined }): Step[] {
  const steps: Step[] = [];
  const ex = issue.examples[0];
  if (ex) steps.push({ label: "See it happen", command: `coding.sh show ${ex.sessionId}` });
  if (issue.quietSince) {
    steps.push({ label: `See whether ${issue.quietSince.commit} fixed it`, command: "coding.sh improve check" });
    return steps;
  }
  if (issue.rule) steps.push({ label: "Add the line to your instructions file (uncommitted)", command: `coding.sh improve fix ${n}` });
  if (issue.behavior) {
    steps.push(
      o.provider
        ? { label: `Test the edit on the moments it went wrong${isCliProvider(o.provider) ? ` (on your ${CLI_PLAN[o.provider]})` : ""}`, command: abCommand(issue.behavior, o.provider) }
        : { label: `Test the edit on the moments it went wrong (${NEEDS_MODEL})`, command: `${abCommand(issue.behavior, undefined)} --dry-run` },
    );
  }
  if (issue.rule) steps.push({ label: "Commit it, then check new sessions against it", command: "coding.sh improve check" });
  if (issue.kind === "failure" && issue.command) steps.push({ label: "Find every time it failed", command: `coding.sh search ${JSON.stringify(issue.command)}` });
  if (issue.kind === "cost") {
    steps.push({ label: "See the cache by repo, with each cause", command: "coding.sh usage --cache --by repo" });
    steps.push({ label: "List the sessions whose breaks cost most", command: "coding.sh sessions --where 'cache.breaks>0 sort:-cache.cost'" });
  }
  return steps;
}

/**
 * The step after a change the agent follows, or that adds work, without fewer failures
 * (followed-no-effect, costlier): test the harness without it. Undefined otherwise, and
 * for a change with no previous harness commit to go back to.
 */
export function removalStep(e: ChangeEffect): Step | undefined {
  if ((e.verdict !== "followed-no-effect" && e.verdict !== "costlier") || !e.change.previous) return undefined;
  return { label: "Test whether the harness does as well without this change", command: `coding.sh refine test git:${e.change.previous.slice(0, 7)}` };
}

/**
 * Where a fix line goes: the context file most of the issue's agents load.
 * Claude Code reads CLAUDE.md and never AGENTS.md; Codex and most others read
 * AGENTS.md; Gemini CLI reads GEMINI.md. With no agents, the file the repo has.
 */
export function targetFile(root: string, agents: readonly string[]): string {
  const has = (f: string) => existsSync(join(root, f));
  const claude = agents.filter((a) => a === "claude-code").length;
  const gemini = agents.filter((a) => a === "gemini-cli").length;
  const other = agents.length - claude - gemini;
  if (!agents.length) return has("AGENTS.md") && !has("CLAUDE.md") ? "AGENTS.md" : "CLAUDE.md";
  if (claude >= other && claude >= gemini) return "CLAUDE.md";
  if (gemini > other && has("GEMINI.md")) return "GEMINI.md";
  return "AGENTS.md";
}
