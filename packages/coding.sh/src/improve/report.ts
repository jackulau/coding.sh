// The improve report: what to fix first in a repo's recent sessions, and
// whether the harness changes already made helped. Shared by `coding.sh
// improve` and the MCP improve / harness_changes tools.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import { redactShown } from "../core/redact.ts";
import type { IndexStore } from "../core/types.ts";
import { insideDir } from "../eval/decision.ts";
import { guessVerifierFromRepo, inspectRepo } from "../eval/task.ts";
import { autoCliProvider, CLI_PLAN, isCliProvider, type CliProvider } from "../judge/subscription.ts";
import { changeEffects, currentVersion, sessionVersions, type ChangeEffect, type GroupStats } from "./changes.ts";
import { failureRecords, rankIssues, type FailureRecord, type Issue } from "./issues.ts";

export interface ImproveScope {
  /** Only sessions at or under this directory (a repo root); undefined: every repo. */
  repo?: string;
  since: number;
  agents?: readonly string[];
}

/** Most sessions read for one report, and most whose events are read for failures. */
const MAX_SESSIONS = 2000;
const MAX_EVENT_SESSIONS = 300;
const DAY = 86_400_000;

/** Top-level sessions in scope, newest first: no subagents, no eval or benchmark runs. */
export async function scopeSessions(index: IndexStore, s: ImproveScope): Promise<Session[]> {
  const all = await index.listSessions({ parentSessionId: null, runId: null, since: s.since, limit: MAX_SESSIONS });
  return all.filter((x) => x.startedAt >= s.since && (!s.agents?.length || s.agents.includes(x.agent)) && (!s.repo || insideDir(s.repo, x.repo?.root) || insideDir(s.repo, x.cwd)));
}

/** The repo's own test command, e.g. `npm test` (undefined when none is obvious). */
export async function testCommandOf(root: string | undefined): Promise<string | undefined> {
  if (!root || !existsSync(root)) return undefined;
  try {
    return guessVerifierFromRepo(await inspectRepo(root));
  } catch {
    return undefined;
  }
}

/** The ranked issues in `sessions`. */
export async function findIssues(index: IndexStore, sessions: readonly Session[], o: { repoRoot?: string; testCommand?: string } = {}): Promise<Issue[]> {
  const failures = new Map<string, FailureRecord[]>();
  const withFailures = sessions.filter((s) => s.stats.toolErrors > 0 || (s.stats.testsFailed ?? 0) > 0).slice(0, MAX_EVENT_SESSIONS);
  for (const s of withFailures) {
    const events = await index.listEvents(s.id, { kinds: ["tool.start", "tool.end", "test.result", "file.change"], limit: 5000 });
    const recs = failureRecords(events, o.repoRoot ?? s.repo?.root);
    if (recs.length) failures.set(s.id, recs);
  }
  const ranked = rankIssues(sessions, failures, o.testCommand ? { testCommand: o.testCommand } : {}).map(shownIssue);
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
export async function findChanges(index: IndexStore, root: string, o: { since: number; limit?: number; agents?: readonly string[]; sessionsIn?: string }): Promise<ChangeEffect[]> {
  const repo = o.sessionsIn === "all" ? undefined : (o.sessionsIn ?? root);
  const sessions = await scopeSessions(index, { ...(repo ? { repo } : {}), since: o.since - 30 * DAY, ...(o.agents ? { agents: o.agents } : {}) });
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

/**
 * Marks the issues no session on the repo's current harness version had, when at least
 * one session ran on it: the last harness change may have fixed them. They move after
 * the issues still happening, in their order.
 */
export async function markQuiet(root: string, sessions: readonly Session[], issues: readonly Issue[]): Promise<Issue[]> {
  try {
    const current = await currentVersion(root);
    if (!current) return [...issues];
    const versions = await sessionVersions(root, sessions);
    const onCurrent = new Set(sessions.filter((s) => versions.get(s.id) === current).map((s) => s.id));
    if (!onCurrent.size) return [...issues];
    const quietSince = { commit: current.slice(0, 7), sessions: onCurrent.size };
    const marked = issues.map((i) => (i.sessionIds.some((id) => onCurrent.has(id)) ? i : { ...i, quietSince }));
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
  if (issue.rule) steps.push({ label: "Add the line to CLAUDE.md or AGENTS.md (uncommitted)", command: `coding.sh improve fix ${n}` });
  if (issue.behavior) {
    steps.push(
      o.provider
        ? { label: `Test the edit on the moments it went wrong${isCliProvider(o.provider) ? ` (on your ${CLI_PLAN[o.provider]})` : ""}`, command: abCommand(issue.behavior, o.provider) }
        : { label: `Test the edit on the moments it went wrong (${NEEDS_MODEL})`, command: `${abCommand(issue.behavior, undefined)} --dry-run` },
    );
  }
  if (issue.rule) steps.push({ label: "Commit it, then check new sessions against it", command: "coding.sh improve check" });
  if (issue.kind === "failure" && issue.command) steps.push({ label: "Find every time it failed", command: `coding.sh search ${JSON.stringify(issue.command)}` });
  return steps;
}

/** Where a fix line goes: the context file the issue's agents read, else the one the repo has. */
export function targetFile(root: string, agents: readonly string[]): string {
  const has = (f: string) => existsSync(join(root, f));
  const claude = agents.filter((a) => a === "claude-code").length;
  const other = agents.length - claude;
  if (has("CLAUDE.md") && has("AGENTS.md")) return claude >= other ? "CLAUDE.md" : "AGENTS.md";
  if (has("CLAUDE.md")) return "CLAUDE.md";
  if (has("AGENTS.md")) return "AGENTS.md";
  if (has("GEMINI.md") && agents.includes("gemini-cli")) return "GEMINI.md";
  return claude >= other ? "CLAUDE.md" : "AGENTS.md";
}
