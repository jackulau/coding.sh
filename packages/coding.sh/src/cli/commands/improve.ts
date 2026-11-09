// coding.sh improve: what to fix first in this repo's sessions, a line that
// fixes it, and whether the harness changes you kept helped.
//
//   improve          ranked issues with the next command for each, then the
//                    recent CLAUDE.md / AGENTS.md / rule / skill changes
//   improve fix <N>  append issue N's line to CLAUDE.md or AGENTS.md (uncommitted)
//   improve check    each kept (committed) change, before vs after, and the
//                    sessions still flagged after it; exit 1 on a regression;
//                    --watch re-checks as new sessions arrive
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import { repoRoot } from "../../core/git.ts";
import type { ChangeEffect, GroupStats, Verdict } from "../../improve/changes.ts";
import type { Issue } from "../../improve/issues.ts";
import { abCommand, findChanges, findIssues, isHeadless, modelProvider, NEEDS_MODEL, scopeSessions, stepsFor, targetFile, testCommandOf, type ImproveScope, type ModelProvider } from "../../improve/report.ts";
import { CLI_PLAN, isCliProvider } from "../../judge/subscription.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { autoIngest, list, oneLine, pendingField, readIngest, str, withContext } from "../common.ts";
import { ago, CliError, localTime, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { captureSetUp, START_NEW_SESSION } from "../first-session.ts";

interface Opts {
  root: string | undefined;
  repo: string | undefined;
  sinceText: string;
  since: number;
  agents: string[];
  limit: number;
  /** --headless: keep headless sessions. */
  headless: boolean;
}

async function options(c: CommandContext, defaultSince: string, defaultLimit: number): Promise<Opts> {
  const root = await repoRoot(c.cwd).catch(() => undefined);
  const repoFlag = str(c.flags.repo);
  const repo = repoFlag === "all" ? undefined : repoFlag ? resolve(c.cwd, repoFlag) : (root ?? c.cwd);
  const sinceText = str(c.flags.since) ?? defaultSince;
  let since: number;
  try {
    since = parseSince(sinceText);
  } catch {
    throw new UsageError(`--since must be a duration like 7d or 12h, or a date: got ${JSON.stringify(sinceText)}`, { reason: "invalid_argument" });
  }
  const agents = list(c.flags.agent).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  return { root: repoFlag && repoFlag !== "all" ? ((await repoRoot(repo!).catch(() => undefined)) ?? repo) : root, repo, sinceText, since, agents, limit: positiveInt(c.flags.limit, "limit") ?? defaultLimit, headless: c.flags.headless === true };
}

const where = (o: Opts, cwd: string) => (o.repo ? relative(cwd, o.repo) || o.repo.split(/[\\/]/).pop() || o.repo : "every repo");

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "check") return check(c);
  if (c.action === "fix") return fix(c);
  return report(c);
}

// ---------------------------------------------------------------- report

function issueJson(i: Issue, n: number, provider: ModelProvider | undefined) {
  const { sessionIds: _ids, ...rest } = i;
  return { rank: n, ...rest, next: stepsFor(i, n, { provider }) };
}

/** A group's counts, with every flagged session (id, ISO start, title, flags). */
const groupJson = (g: GroupStats) => ({ ...g, flaggedSessions: g.flaggedSessions.map((s) => ({ id: s.id, at: new Date(s.startedAt).toISOString(), ...(s.title ? { title: s.title } : {}), flags: s.flags })) });

export function changeJson(e: ChangeEffect) {
  return {
    commit: e.change.commit,
    at: new Date(e.change.at).toISOString(),
    subject: e.change.subject,
    files: e.change.files,
    added: e.change.added.slice(0, 10),
    removed: e.change.removed.slice(0, 10),
    verdict: e.verdict,
    reason: e.reason,
    ...(e.p !== undefined ? { p: Math.round(e.p * 1000) / 1000 } : {}),
    before: groupJson(e.before),
    after: groupJson(e.after),
    rules: e.rules.map((r) => ({ ...r, ...(r.p !== undefined ? { p: Math.round(r.p * 1000) / 1000 } : {}) })),
  };
}

const VERDICT_WORD: Record<Verdict, string> = {
  helped: "Helped",
  regressed: "Regressed",
  "no-clear-change": "No clear change",
  "too-early": "Too early to tell",
  "no-sessions-after": "No sessions yet",
  "no-baseline": "No sessions before it",
};

/** Flagged sessions listed under each change by improve check, unless --sessions. */
const FLAGGED_SHOWN = 5;

/** `flagged`: how many of the sessions still flagged after the change to list (0, the default: none). */
function printChange(c: CommandContext, e: ChangeEffect, o: { indent?: string; flagged?: number } = {}): void {
  const { out } = c;
  const indent = o.indent ?? "  ";
  const ch = e.change;
  const files = ch.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join(", ");
  const tone = e.verdict === "helped" ? "green" : e.verdict === "regressed" ? "red" : "faint";
  out.print(`${indent}${out.style(ch.short, "bold")}  ${localTime(ch.at)}  ${files}  ${JSON.stringify(ch.subject)}`);
  // A change with no sessions before it (often the commit that added the file) has nothing to compare: one line is enough.
  if (e.verdict === "no-baseline") out.print(`${indent}  ${out.style(VERDICT_WORD[e.verdict], tone)}: ${e.after.sessions} session(s) after it.`);
  else {
    for (const l of ch.added.slice(0, 3)) out.print(`${indent}    + ${l.length > 110 ? `${l.slice(0, 109)}…` : l}`);
    for (const l of ch.removed.slice(0, 2)) out.print(`${indent}    - ${l.length > 110 ? `${l.slice(0, 109)}…` : l}`);
    out.print(`${indent}  ${out.style(VERDICT_WORD[e.verdict], tone)}: ${e.reason}`);
  }
  // Sessions that never got to work (a chat, a refused login) are no evidence either way: say how many were left out.
  const idle = (e.before.idle ?? 0) + (e.after.idle ?? 0);
  if (idle) out.print(`${indent}  ${out.style(`Left out: ${plural(idle, "session")} with no tool call (${e.before.idle ?? 0} before, ${e.after.idle ?? 0} after), such as a chat or an agent that was not logged in`, "faint")}`);
  const list = e.after.flaggedSessions;
  if (!o.flagged || !list.length) return;
  out.print(`${indent}  Still flagged after it, ${e.after.flagged} of ${plural(e.after.sessions, "session")} (coding.sh show <id>):`);
  for (const s of list.slice(0, o.flagged)) out.print(`${indent}    ${s.id}  ${localTime(s.startedAt)}  ${s.flags.join(", ")}${s.title ? `  ${JSON.stringify(oneLine(s.title, 50))}` : ""}`);
  if (list.length > o.flagged) out.print(`${indent}    ${out.style(`… ${list.length - o.flagged} more (--sessions lists them all)`, "faint")}`);
}

async function report(c: CommandContext): Promise<number> {
  const { out } = c;
  const o = await options(c, "14d", 5);
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const scope: ImproveScope = { since: o.since, ...(o.repo ? { repo: o.repo } : {}), ...(o.agents.length ? { agents: o.agents } : {}), headless: true };
    const all = await scopeSessions(ctx.index, scope);
    const sessions = o.headless ? all : all.filter((s) => !isHeadless(s));
    const headlessLeftOut = all.length - sessions.length;
    const testCommand = await testCommandOf(o.root);
    const issues = await findIssues(ctx.index, sessions, { ...(o.root ? { repoRoot: o.root } : {}), ...(testCommand ? { testCommand } : {}) });
    const changes = o.root ? await findChanges(ctx.index, o.root, { since: parseSince("30d"), limit: 3, sessionsIn: o.repo ?? "all", ...(o.agents.length ? { agents: o.agents } : {}), ...(o.headless ? { headless: true } : {}) }) : [];
    const provider = modelProvider(c.env);
    const top = issues.slice(0, o.limit);
    if (out.json) {
      out.data({
        scope: { repo: o.repo ?? null, since: new Date(o.since).toISOString(), agents: o.agents, sessions: sessions.length, ...(headlessLeftOut ? { headlessLeftOut } : {}) },
        issues: top.map((i, k) => issueJson(i, k + 1, provider)),
        more: Math.max(0, issues.length - top.length),
        changes: changes.map(changeJson),
        ...pendingField(backlog),
      });
      return 0;
    }
    const leftOut = headlessLeftOut ? `; ${plural(headlessLeftOut, "headless session")} left out (--headless)` : "";
    if (!sessions.length) {
      out.note(`No sessions in ${where(o, c.cwd)} since ${o.sinceText}${leftOut}`);
      if (o.repo) out.next("Look in every repo", `coding.sh improve --repo all --since ${o.sinceText}`);
      else if (captureSetUp(c.env)) out.next(`${START_NEW_SESSION}. Then check capture`, "coding.sh doctor");
      else out.next("Capture your agents' sessions first", "coding.sh init");
      return 0;
    }
    const byAgent = new Map<string, number>();
    for (const s of sessions) byAgent.set(s.agent, (byAgent.get(s.agent) ?? 0) + 1);
    out.print(`${plural(sessions.length, "session")} in ${where(o, c.cwd)} since ${o.sinceText} (${[...byAgent].map(([a, n]) => `${a} ${n}`).join(", ")})${leftOut}`);
    out.print("");
    if (!top.length) out.print("Nothing to fix: no failure flags, no command failing the same way in two sessions, and no costly cache breaks.");
    else out.print(out.style("Fix first", "bold"));
    top.forEach((i, k) => {
      const n = k + 1;
      const ex = i.examples[0];
      out.print(`${n}. ${i.title}`);
      out.print(`   ${i.sessions} of ${i.analyzed} sessions, ${i.severity.level} ${i.severity.score}${i.beforeEdits ? `; failed before any edit in ${i.beforeEdits}` : ""}${ex ? `; latest ${ago(ex.startedAt)}` : ""}`);
      if (i.quietSince) out.print(`   ${out.style(`Not seen in the ${plural(i.quietSince.sessions, "session")} since ${i.quietSince.commit} changed the harness`, "green")}`);
      if (ex?.title) out.print(`   e.g. ${JSON.stringify(ex.title.length > 80 ? `${ex.title.slice(0, 79)}…` : ex.title)}`);
      if (i.sample) out.print(`   error: ${i.sample}`);
      if (!i.quietSince && i.causes?.length) {
        out.print("   Fix, costliest cause first:");
        for (const k of i.causes) out.print(`     ${k.cause} (${k.usd ? `$${k.usd.toFixed(2)}, ` : ""}${plural(k.breaks, "break")}): ${k.fix}`);
      } else if (!i.quietSince) out.print(`   Fix: ${i.fix}${i.rule ? ` Add: "${i.rule}"` : ""}`);
      for (const s of stepsFor(i, n, { provider })) out.print(`   ${out.style("→", "faint")} ${s.label}: ${out.style(s.command, "cyan")}`);
      out.print("");
    });
    if (issues.length > top.length) out.print(`${plural(issues.length - top.length, "more issue")}: coding.sh improve --limit ${issues.length}\n`);
    if (changes.length) {
      out.print(out.style("Did your last changes help?", "bold"));
      for (const e of changes) printChange(c, e);
      out.print("");
    } else if (o.root) {
      out.print(out.style("Did your last changes help?", "faint"));
      out.print("  No commits changed CLAUDE.md, AGENTS.md, a rule or a skill in the last 30 days.");
      out.print("");
    }
    if (top[0]?.quietSince) out.next("Nothing new since your last change; see whether it helped", "coding.sh improve check");
    else if (top[0]?.rule) out.next("Start with the first one", `coding.sh improve fix 1`);
    else if (top[0]?.examples[0]) out.next("Start with the first one", `coding.sh show ${top[0].examples[0].sessionId}`);
    if (top.length) out.note("Turn these sessions into an eval you can rerun: coding.sh eval init --sessions");
    return 0;
  });
}

// ---------------------------------------------------------------- fix

async function fix(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = c.positionals[0];
  if (!ref) throw new UsageError("Name the issue to fix: its number in coding.sh improve, or its id", { reason: "missing_argument", suggestion: "coding.sh improve fix 1" });
  const o = await options(c, "14d", 50);
  if (!o.root) throw new UsageError("Not in a git repo: improve fix edits this repo's CLAUDE.md or AGENTS.md", { reason: "missing_argument" });
  const root = o.root;
  return withContext(c, async (ctx: Context) => {
    await autoIngest(ctx, readIngest(c));
    const sessions = await scopeSessions(ctx.index, { since: o.since, repo: o.repo ?? root, ...(o.agents.length ? { agents: o.agents } : {}), ...(o.headless ? { headless: true } : {}) });
    const testCommand = await testCommandOf(root);
    const issues = await findIssues(ctx.index, sessions, { repoRoot: root, ...(testCommand ? { testCommand } : {}) });
    const n = /^\d+$/.test(ref) ? Number(ref) : issues.findIndex((i) => i.id === ref) + 1;
    const issue = n >= 1 ? issues[n - 1] : undefined;
    if (!issue) throw new CliError(`No issue ${JSON.stringify(ref)} in ${plural(issues.length, "issue")} since ${o.sinceText}`, { reason: "not_found", next: ["List them:", `coding.sh improve --since ${o.sinceText}`] });
    if (!issue.rule) {
      throw new CliError(`Issue ${n} (${issue.title}) has no line that fixes it: ${issue.fix}`, {
        reason: "no_rule",
        next: issue.examples[0] ? ["See it happen:", `coding.sh show ${issue.examples[0].sessionId}`] : [],
      });
    }
    const agents = sessions.filter((s) => issue.examples.some((x) => x.sessionId === s.id)).map((s) => s.agent);
    const target = str(c.flags.target) ?? targetFile(root, agents);
    const abs = resolve(root, target);
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const present = before.split("\n").some((l) => l.trim() === issue.rule);
    const dryRun = c.flags["dry-run"] === true;
    const after = present ? before : `${before}${before && !before.endsWith("\n") ? "\n" : ""}${before.trim() ? "\n" : ""}${issue.rule}\n`;
    const behavior = issue.behavior;
    const provider = modelProvider(c.env);
    const hasKey = provider !== undefined;
    const onPlan = isCliProvider(provider) ? `, on your ${CLI_PLAN[provider]}` : "";
    const test = behavior ? abCommand(behavior, provider) : undefined;
    if (out.json) {
      if (!present && !dryRun) writeFileSync(abs, after);
      out.data({ issue: { rank: n, id: issue.id, title: issue.title }, file: relative(root, abs) || target, line: issue.rule, changed: !present && !dryRun, alreadyPresent: present, dryRun, ...(test ? { test } : {}), check: "coding.sh improve check" });
      return 0;
    }
    if (present) {
      out.warn(`${target} already has this line: ${issue.rule}`);
      out.note(`It is not stopping "${issue.title.toLowerCase()}" (${issue.sessions} of ${issue.analyzed} sessions). Reword it, or put it nearer the top, then test the edit:`);
      if (test) out.next(hasKey ? `Test your rewording on the moments it went wrong${onPlan}` : `Test your rewording (${NEEDS_MODEL})`, hasKey ? test : `${test} --dry-run`);
      return 0;
    }
    if (dryRun) {
      out.print(`Would add to ${target}:`);
      out.print(`+ ${issue.rule}`);
      return 0;
    }
    writeFileSync(abs, after);
    out.ok(`Added to ${target} (not committed):`);
    out.print(`+ ${issue.rule}`);
    if (test) {
      if (hasKey) out.next(`Test it on the ${issue.sessions > 1 ? "moments" : "moment"} it went wrong (A = committed, B = your edit)${onPlan}`, test);
      else {
        out.note("");
        out.note(`Testing the edit on past sessions (${test}) ${NEEDS_MODEL}.`);
        out.note("Without any of them: commit it and let new sessions tell you.");
      }
    }
    out.next("Keep it: commit, then check new sessions against it", `git commit ${target} -m "${target}: ${issue.title.toLowerCase()}" && coding.sh improve check`);
    return 0;
  });
}

// ---------------------------------------------------------------- check

const SECOND = 1000;

async function check(c: CommandContext): Promise<number> {
  const { out } = c;
  const o = await options(c, "30d", 5);
  if (!o.root) throw new UsageError("Not in a git repo: improve check reads the history of CLAUDE.md, AGENTS.md, rules and skills", { reason: "missing_argument" });
  const root = o.root;
  const watch = c.flags.watch === true;
  if (watch && out.json) throw new UsageError("--watch prints a line per change; it does not combine with --json", { reason: "invalid_argument" });
  const interval = (positiveInt(c.flags.interval, "interval") ?? 60) * SECOND;
  return withContext(c, async (ctx) => {
    const read = async () => {
      const backlog = await autoIngest(ctx, readIngest(c));
      return { changes: await findChanges(ctx.index, root, { since: o.since, limit: o.limit, sessionsIn: o.repo ?? "all", ...(o.agents.length ? { agents: o.agents } : {}), ...(o.headless ? { headless: true } : {}) }), backlog };
    };
    const first = await read();
    const regressed = first.changes.filter((e) => e.verdict === "regressed");
    if (out.json) {
      out.data({ repo: root, since: new Date(o.since).toISOString(), changes: first.changes.map(changeJson), regressed: regressed.map((e) => e.change.commit), ...pendingField(first.backlog) });
      return regressed.length ? 1 : 0;
    }
    if (!first.changes.length) {
      out.note(`No commits changed CLAUDE.md, AGENTS.md, GEMINI.md, a rule or a skill in ${relative(c.cwd, root) || "this repo"} since ${o.sinceText}`);
      out.next("Find something worth changing", "coding.sh improve");
      if (!watch) return 0;
    }
    const shown = c.flags.sessions === true ? Number.POSITIVE_INFINITY : FLAGGED_SHOWN;
    for (const e of first.changes) {
      printChange(c, e, { indent: "", flagged: shown });
      out.print("");
    }
    if (!watch) {
      const after = regressed[0]?.after;
      if (after) out.next("See the sessions that went wrong after it", `coding.sh show ${after.flaggedSessions[0]?.id ?? after.examples[0] ?? "latest"}`);
      else if (first.changes.some((e) => e.verdict === "too-early" || e.verdict === "no-sessions-after")) out.next("Re-check as new sessions arrive", "coding.sh improve check --watch");
      return regressed.length ? 1 : 0;
    }
    return watchLoop(c, first.changes, read, interval);
  });
}

async function watchLoop(c: CommandContext, initial: readonly ChangeEffect[], read: () => Promise<{ changes: ChangeEffect[] }>, interval: number): Promise<number> {
  const { out } = c;
  c.interruptExit?.(0);
  const stop = c.drain ?? c.signal;
  process.stderr.write(`Re-checking every ${Math.round(interval / SECOND)}s as new sessions arrive; Ctrl-C to stop.\n`);
  const key = (e: ChangeEffect) => `${e.verdict}|${e.before.sessions}|${e.after.sessions}|${e.after.flagged}`;
  const seen = new Map(initial.map((e) => [e.change.commit, key(e)]));
  while (!stop.aborted) {
    await new Promise<void>((r) => {
      const t = setTimeout(r, interval);
      stop.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
    if (stop.aborted) break;
    try {
      const { changes } = await read();
      for (const e of changes) {
        const k = key(e);
        if (seen.get(e.change.commit) === k) continue;
        seen.set(e.change.commit, k);
        const word = VERDICT_WORD[e.verdict];
        out.print(`${new Date().toTimeString().slice(0, 8)}  ${e.change.short} ${JSON.stringify(e.change.subject)}  ${out.style(word, e.verdict === "regressed" ? "red" : e.verdict === "helped" ? "green" : "faint")}: ${e.reason}`);
      }
    } catch (e) {
      out.warn(e instanceof Error ? e.message : String(e));
    }
  }
  return 0;
}
