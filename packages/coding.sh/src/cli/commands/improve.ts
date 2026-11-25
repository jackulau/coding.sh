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
import { shortener } from "../../core/session-ref.ts";
import { HEADLESS_KINDS, type ChangeEffect, type GroupStats, type Verdict } from "../../improve/changes.ts";
import type { Issue } from "../../improve/issues.ts";
import { abCommand, findChanges, findIssues, headlessAfter, modelProvider, NEEDS_MODEL, notReadLine, readScope, removalStep, stepsFor, targetFile, testCommandOf, withHeadless, type ChangeOptions, type ImproveScope, type ModelProvider, type ReadScope } from "../../improve/report.ts";
import { CLI_PLAN, isCliProvider } from "../../judge/subscription.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { autoIngest, list, oneLine, pendingField, readIngest, str, withContext } from "../common.ts";
import { quoteArg, windowsShell } from "../next-steps.ts";
import { ago, clean, CliError, localTime, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { captureSetUp, START_NEW_SESSION } from "../first-session.ts";
import { matchesPlace, parsePlace, pathPlace, type Place } from "../../mcp/data.ts";
import { repoGroup } from "../../query/where.ts";
import { userHome } from "../../core/paths.ts";
import type { Session } from "../../schema/index.ts";

interface Opts {
  root: string | undefined;
  repo: string | undefined;
  /** Set when repo is a checkout's root or inside a linked worktree: the whole repo, every worktree of it included. */
  place: Place | undefined;
  sinceText: string;
  since: number;
  agents: string[];
  limit: number;
  /** --headless: keep headless sessions. */
  headless: boolean;
  /** --repo given as a bare name with no such folder here: the captured repo it names, found in the store (byName). */
  name?: string;
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
  const limit = positiveInt(c.flags.limit, "limit") ?? defaultLimit;
  const headless = c.flags.headless === true;
  // A bare name ("coding.sh") with no folder of that name here names a captured repo, as it does
  // for sessions --repo and the MCP improve tool: byName finds its checkout in the store.
  if (repoFlag && repoFlag !== "all" && repo && !existsSync(repo)) {
    const p = parsePlace(repoFlag, c.cwd, userHome(c.env));
    if (p.name !== undefined) return { root: undefined, repo: undefined, place: undefined, sinceText, since, agents, limit, headless, name: p.name };
  }
  const place = repo ? pathPlace(repo) : undefined;
  return { root: repoFlag && repoFlag !== "all" ? ((await repoRoot(repo!).catch(() => undefined)) ?? repo) : root, repo, place: place?.repo ? place : undefined, sinceText, since, agents, limit, headless };
}

/**
 * --repo as a repo name: the main checkout of the newest captured top-level session in a repo of
 * that name (a worktree's session names its main repo; on Windows the case does not count), so the
 * git history read is that repo's, and the sessions read are every worktree's. A name no captured
 * session has is an error, never a repo with no harness changes.
 */
async function byName(ctx: Context, o: Opts): Promise<Opts> {
  if (o.name === undefined) return o;
  const want: Place = { name: o.name };
  const recent = await ctx.index.listSessions({ parentSessionId: null, limit: 2000 });
  for (const s of recent) {
    if (!matchesPlace(s, want)) continue;
    const dir = repoGroup(s).path;
    const root = dir ? await repoRoot(dir).catch(() => undefined) : undefined;
    if (!root) continue;
    const place = pathPlace(root);
    return { ...o, root, repo: root, place: place.repo ? place : undefined };
  }
  throw new CliError(`No captured session in a git repo named ${JSON.stringify(o.name)}`, {
    reason: "not_a_repo",
    next: ["Pass the repo's folder instead:", "coding.sh improve --repo <dir>", "See the repos with sessions:", "coding.sh usage --by repo"],
  });
}

// The repo's own name from any folder inside it, never a path relative to the cwd ("..\..").
const repoName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() || repo;
// From a worktree, the repo it belongs to.
const where = (o: Opts) => (o.repo ? repoName(o.place?.repo ?? o.repo) : "every repo");

/** readScope, where a repo with worktrees counts the sessions of all of them (matchesPlace). */
async function sessionsOf(index: Context["index"], o: Opts, scope: ImproveScope): Promise<ReadScope> {
  if (!o.place) return readScope(index, scope);
  const { repo: _repo, ...wide } = scope;
  const place = o.place;
  return readScope(index, wide, { match: (s: Session) => matchesPlace(s, place) });
}

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "check") return check(c);
  if (c.action === "fix") return fix(c);
  return report(c);
}

// ---------------------------------------------------------------- report

/** A command as printed: `coding.sh` named for the user's shell (Output.command). */
type Cmd = (line: string) => string;
const asIs: Cmd = (line) => line;
/** How a printed line names a session: a reference that opens it when pasted (core/session-ref.ts shortener). */
type Ref = (id: string) => string;
const idAsIs: Ref = (id) => id;

function issueJson(i: Issue, n: number, provider: ModelProvider | undefined, cmd: Cmd, ref: Ref) {
  const { sessionIds: _ids, ...rest } = i;
  return { rank: n, ...rest, next: stepsFor(i, n, { provider, ref }).map((s) => ({ ...s, command: cmd(s.command) })) };
}

/** A group's counts, with every flagged session (id, ISO start, title, flags). */
const groupJson = ({ work: _work, ...g }: GroupStats) => ({ ...g, flaggedSessions: g.flaggedSessions.map((s) => ({ id: s.id, at: new Date(s.startedAt).toISOString(), ...(s.title ? { title: s.title } : {}), flags: s.flags })) });

export function changeJson(e: ChangeEffect, cmd: Cmd = asIs) {
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
    ...(e.work ? { work: workJson(e.work) } : {}),
    ...(removalStep(e) ? { next: cmd(removalStep(e)!.command) } : {}),
  };
}

const workJson = (w: NonNullable<ChangeEffect["work"]>) =>
  Object.fromEntries(Object.entries(w).map(([k, m]) => [k, { before: m.before, after: m.after, p: Math.round(m.p * 1000) / 1000 }]));

// No word for no-sessions-after: its reason says it whole ("No captured session ran with this change yet."), so the line is the reason alone.
const VERDICT_WORD: Record<Exclude<Verdict, "no-sessions-after">, string> = {
  helped: "Helped",
  "followed-no-effect": "Followed, no effect yet",
  costlier: "Costlier",
  regressed: "Regressed",
  "no-clear-change": "No clear change",
  "too-early": "Too early to tell",
  "no-baseline": "No sessions before it",
};

const verdictTone = (v: Verdict) => (v === "helped" ? "green" : v === "regressed" ? "red" : v === "costlier" || v === "followed-no-effect" ? "yellow" : "faint");

/** The verdict line: "Word: reason", or the reason alone for a change no counted session ran with. */
const verdictText = (out: Output, e: ChangeEffect): string => (e.verdict === "no-sessions-after" ? e.reason : `${out.style(VERDICT_WORD[e.verdict], verdictTone(e.verdict))}: ${e.reason}`);

/** A commit subject on one line, cut as the sessions table cuts a title (60 characters on a terminal, 100 off one); --json keeps it whole. */
const shownSubject = (out: Output, subject: string): string => JSON.stringify(oneLine(clean(subject), out.stdoutTTY ? 60 : 100));

/** Flagged sessions listed under each change by improve check, unless --sessions. */
const FLAGGED_SHOWN = 5;

/**
 * `flagged`: how many of the sessions still flagged after the change to list (0, the default: none), each
 * named by `ref` (default the id).
 * `headlessInWindow`: headless sessions in the window were left out, though none counted after this change
 * (with --headless they may still be left out for another reason, such as no git HEAD). One that did
 * count after it is in the change's reason (withHeadless).
 */
function printChange(c: CommandContext, e: ChangeEffect, o: { indent?: string; flagged?: number; headlessInWindow?: boolean; ref?: Ref } = {}): void {
  const { out } = c;
  const indent = o.indent ?? "  ";
  const ch = e.change;
  const files = ch.files.map((f) => `${f.path} +${f.added} -${f.removed}`).join(", ");
  out.print(`${indent}${out.style(ch.short, "bold")}  ${localTime(ch.at)}  ${files}  ${shownSubject(out, ch.subject)}`);
  // A change with no sessions before it (often the commit that added the file) has nothing to compare: one line is enough.
  if (e.verdict === "no-baseline") out.print(`${indent}  ${out.style(VERDICT_WORD[e.verdict], verdictTone(e.verdict))}: ${e.after.sessions} session(s) after it.`);
  else {
    for (const l of ch.added.slice(0, 3)) out.print(`${indent}    + ${l.length > 110 ? `${l.slice(0, 109)}…` : l}`);
    for (const l of ch.removed.slice(0, 2)) out.print(`${indent}    - ${l.length > 110 ? `${l.slice(0, 109)}…` : l}`);
    out.print(`${indent}  ${verdictText(out, e)}`);
  }
  if (o.headlessInWindow && e.verdict === "no-sessions-after") out.print(`${indent}  ${out.style(`Headless sessions (${HEADLESS_KINDS}) are left out; --headless counts them`, "faint")}`);
  // Sessions that never got to work (a chat, a refused login) are no evidence either way: say how many were left out.
  const idle = (e.before.idle ?? 0) + (e.after.idle ?? 0);
  if (idle) out.print(`${indent}  ${out.style(`Left out: ${plural(idle, "session")} with no tool call (${e.before.idle ?? 0} before, ${e.after.idle ?? 0} after), such as a chat or an agent that was not logged in`, "faint")}`);
  const list = e.after.flaggedSessions;
  if (!o.flagged || !list.length) return;
  out.print(`${indent}  Still flagged after it, ${e.after.flagged} of ${plural(e.after.sessions, "session")} (${out.command("coding.sh show <id>")}):`);
  const ref = o.ref ?? idAsIs;
  for (const s of list.slice(0, o.flagged)) out.print(`${indent}    ${ref(s.id)}  ${localTime(s.startedAt)}  ${s.flags.join(", ")}${s.title ? `  ${JSON.stringify(oneLine(s.title, 50))}` : ""}`);
  if (list.length > o.flagged) out.print(`${indent}    ${out.style(`… ${list.length - o.flagged} more (--sessions lists them all)`, "faint")}`);
}

async function report(c: CommandContext): Promise<number> {
  const { out } = c;
  const named = await options(c, "14d", 5);
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const o = await byName(ctx, named);
    const scope: ImproveScope = { since: o.since, ...(o.repo ? { repo: o.repo } : {}), ...(o.agents.length ? { agents: o.agents } : {}), headless: o.headless };
    const { sessions, notRead, headlessLeftOut } = await sessionsOf(ctx.index, o, scope);
    const children = sessions.filter((s) => s.parent).length;
    const testCommand = await testCommandOf(o.root);
    const issues = await findIssues(ctx.index, sessions, { ...(o.root ? { repoRoot: o.root } : {}), ...(testCommand ? { testCommand } : {}) });
    const changeOpts: ChangeOptions = { since: parseSince("30d"), limit: 3, sessionsIn: o.repo ?? "all", ...(o.agents.length ? { agents: o.agents } : {}), headless: o.headless };
    const found = o.root ? await findChanges(ctx.index, o.root, changeOpts) : [];
    const changes = o.root ? withHeadless(found, await headlessAfter(ctx.index, o.root, changeOpts, found)) : [];
    const provider = modelProvider(c.env);
    const top = issues.slice(0, o.limit);
    const cmd: Cmd = (line) => out.command(line);
    // A command names a session by a reference that opens it when pasted: a full id can need quoting, or be `latest`.
    const ref = top.length ? await shortener(ctx.index) : idAsIs;
    if (out.json) {
      out.data({
        scope: { repo: o.place?.repo ?? o.repo ?? null, since: new Date(o.since).toISOString(), agents: o.agents, sessions: sessions.length, subagents: children || undefined, notRead: notRead || undefined, headlessLeftOut: headlessLeftOut || undefined },
        issues: top.map((i, k) => issueJson(i, k + 1, provider, cmd, ref)),
        more: Math.max(0, issues.length - top.length),
        changes: changes.map((e) => changeJson(e, cmd)),
        ...pendingField(backlog),
      });
      return 0;
    }
    const leftOut = headlessLeftOut ? `; ${plural(headlessLeftOut, "headless session")} left out (--headless)` : "";
    if (!sessions.length) {
      out.note(`No sessions in ${where(o)} since ${o.sinceText}${leftOut}`);
      if (o.repo) out.next("Look in every repo", `coding.sh improve --repo all --since ${o.sinceText}`);
      else if (captureSetUp(c.env)) out.next(`${START_NEW_SESSION}. Then check capture`, "coding.sh doctor");
      else out.next("Capture your agents' sessions first", "coding.sh init");
      return 0;
    }
    const byAgent = new Map<string, number>();
    for (const s of sessions) byAgent.set(s.agent, (byAgent.get(s.agent) ?? 0) + 1);
    out.print(`${plural(sessions.length, "session")} in ${where(o)} since ${o.sinceText} (${[...byAgent].map(([a, n]) => `${a} ${n}`).join(", ")}${children ? `; ${children} of them subagents or delegates` : ""})${leftOut}`);
    if (notRead) out.print(out.style(notReadLine(sessions.length, notRead), "yellow"));
    out.print("");
    if (!top.length) out.print("Nothing to fix: no failure flags, no command or tool failing in two sessions, and no costly cache breaks.");
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
      for (const s of stepsFor(i, n, { provider, ref })) out.print(`   ${out.style("→", "faint")} ${s.label}: ${out.style(cmd(s.command), "cyan")}`);
      out.print("");
    });
    if (issues.length > top.length) out.print(`${plural(issues.length - top.length, "more issue")}: ${cmd(`coding.sh improve --limit ${issues.length}`)}\n`);
    if (changes.length) {
      out.print(out.style("Did your last changes help?", "bold"));
      for (const e of changes) printChange(c, e);
      out.print("");
    } else if (o.root) {
      out.print(out.style("Did your last changes help?", "faint"));
      out.print("  No commits changed AGENTS.md or another instructions file, a rule or a skill in the last 30 days.");
      out.print("");
    }
    if (top[0]?.quietSince) out.next("Nothing new since your last change; see whether it helped", "coding.sh improve check");
    else if (top[0]?.rule) out.next("Start with the first one", `coding.sh improve fix 1`);
    else if (top[0]?.examples[0]) out.next("Start with the first one", `coding.sh show ${ref(top[0].examples[0].sessionId)}`);
    if (top.length) out.note(`Turn these sessions into an eval you can rerun: ${cmd("coding.sh eval init --sessions")}`);
    return 0;
  });
}

// ---------------------------------------------------------------- fix

async function fix(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = c.positionals[0];
  if (!ref) throw new UsageError("Name the issue to fix: its number in coding.sh improve, or its id", { reason: "missing_argument", suggestion: "coding.sh improve fix 1" });
  const named = await options(c, "14d", 50);
  if (!named.root && named.name === undefined) throw notARepo(c, "improve fix edits this repo's AGENTS.md or other instructions file", "fix");
  return withContext(c, async (ctx: Context) => {
    await autoIngest(ctx, readIngest(c));
    const o = await byName(ctx, named);
    const root = o.root!;
    const { sessions } = await sessionsOf(ctx.index, o, { since: o.since, repo: o.repo ?? root, ...(o.agents.length ? { agents: o.agents } : {}), headless: o.headless });
    const testCommand = await testCommandOf(root);
    const issues = await findIssues(ctx.index, sessions, { repoRoot: root, ...(testCommand ? { testCommand } : {}) });
    const n = /^\d+$/.test(ref) ? Number(ref) : issues.findIndex((i) => i.id === ref) + 1;
    const issue = n >= 1 ? issues[n - 1] : undefined;
    if (!issue) throw new CliError(`No issue ${JSON.stringify(ref)} in ${plural(issues.length, "issue")} since ${o.sinceText}`, { reason: "not_found", next: ["List them:", `coding.sh improve --since ${o.sinceText}`] });
    if (!issue.rule) {
      const ex = issue.examples[0];
      throw new CliError(`Issue ${n} (${issue.title}) has no line that fixes it: ${issue.fix}`, {
        reason: "no_rule",
        next: ex ? ["See it happen:", `coding.sh show ${(await shortener(ctx.index))(ex.sessionId)}`] : [],
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
      out.data({ issue: { rank: n, id: issue.id, title: issue.title }, file: relative(root, abs) || target, line: issue.rule, changed: !present && !dryRun, alreadyPresent: present, dryRun, ...(test ? { test: out.command(test) } : {}), check: out.command("coding.sh improve check") });
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
        out.note(`Testing the edit on past sessions (${out.command(test)}) ${NEEDS_MODEL}.`);
        out.note("Without any of them: commit it and let new sessions tell you.");
      }
    }
    for (const [label, command] of commitSteps(target, `${target}: ${issue.title.toLowerCase()}`, c.env)) out.next(label, command);
    return 0;
  });
}

/**
 * The next steps after improve fix: stage the file, commit it, check new sessions against it. git
 * add comes first: `git commit <path>` refuses a file fix just created (untracked). One `&&` line
 * for sh; PowerShell 5.1 and cmd (windowsShell) get one command per step, each argument quoted
 * for them (quoteArg), since PowerShell 5.1 has no `&&`.
 */
export function commitSteps(target: string, message: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): [label: string, command: string][] {
  const add = `git add ${quoteArg(target, env, platform)}`;
  const commit = `git commit -m ${quoteArg(message, env, platform)}`;
  const check = "coding.sh improve check";
  if (!windowsShell(env, platform)) return [["Keep it: commit, then check new sessions against it", `${add} && ${commit} && ${check}`]];
  return [["Keep it: stage the file", add], ["Commit it", commit], ["Then check new sessions against it", check]];
}

/**
 * Run outside a git repo: fix and check need one (--repo all only widens the sessions read), so
 * the next step passes a repo. Not a usage error: no argument is missing.
 */
function notARepo(c: CommandContext, why: string, action: "check" | "fix"): CliError {
  const all = c.flags.repo === "all" ? " (--repo all picks the sessions; the repo is still needed)" : "";
  return new CliError(`Not in a git repo: ${why}${all}`, { reason: "not_a_repo", next: ["Run it inside a git repository, or pass one:", `coding.sh improve ${action}${action === "fix" ? " <n>" : ""} --repo <dir>`] });
}

// ---------------------------------------------------------------- check

const SECOND = 1000;

async function check(c: CommandContext): Promise<number> {
  const { out } = c;
  const named = await options(c, "30d", 5);
  if (!named.root && named.name === undefined) throw notARepo(c, "improve check reads the history of AGENTS.md and other instructions files, rules and skills", "check");
  const watch = c.flags.watch === true;
  if (watch && out.json) throw new UsageError("--watch prints a line per change; it does not combine with --json", { reason: "invalid_argument" });
  const interval = (positiveInt(c.flags.interval, "interval") ?? 60) * SECOND;
  return withContext(c, async (ctx) => {
    const o = await byName(ctx, named);
    const root = o.root!;
    const read = async () => {
      const backlog = await autoIngest(ctx, readIngest(c));
      const opts = changeOptions(o, o.headless);
      const found = await findChanges(ctx.index, root, opts);
      const leftOut = await headlessAfter(ctx.index, root, opts, found);
      return { changes: withHeadless(found, leftOut), leftOut, backlog };
    };
    const first = await read();
    const regressed = first.changes.filter((e) => e.verdict === "regressed");
    const leftOut = first.leftOut;
    // Headless sessions in the window, left out without --headless: plain improve says so, and so does
    // check. Counted in the folders the changes read (o.repo and under it, or every repo), as
    // findChanges reads them: not every worktree of the repo, which plain improve counts (sessionsOf).
    let windowLeftOut = 0;
    if (!o.headless) {
      const scope: ImproveScope = { since: o.since, headless: false };
      if (o.repo) scope.repo = o.repo;
      if (o.agents.length) scope.agents = o.agents;
      windowLeftOut = (await readScope(ctx.index, scope)).headlessLeftOut;
    }
    if (out.json) {
      const changes = first.changes.map((e) => {
        const j: ReturnType<typeof changeJson> & { headlessLeftOut?: number } = changeJson(e, (line) => out.command(line));
        const n = leftOut.get(e.change.commit);
        if (n) j.headlessLeftOut = n;
        return j;
      });
      const doc: Record<string, unknown> = { repo: root, since: new Date(o.since).toISOString(), changes, regressed: regressed.map((e) => e.change.commit) };
      if (windowLeftOut) doc.headlessLeftOut = windowLeftOut;
      out.data({ ...doc, ...pendingField(first.backlog) });
      return regressed.length ? 1 : 0;
    }
    if (!first.changes.length) {
      out.note(`No commits changed AGENTS.md or another instructions file, a rule or a skill in ${repoName(root)} since ${o.sinceText}`);
      out.next("Find something worth changing", "coding.sh improve");
      if (!watch) return 0;
    }
    const shown = c.flags.sessions === true ? Number.POSITIVE_INFINITY : FLAGGED_SHOWN;
    // The sessions listed and the next step are named by references that open them when pasted.
    const ref = first.changes.some((e) => e.after.sessions) ? await shortener(ctx.index) : idAsIs;
    for (const e of first.changes) {
      printChange(c, e, { indent: "", flagged: shown, headlessInWindow: windowLeftOut > 0 && !leftOut.has(e.change.commit), ref });
      out.print("");
    }
    // Where it counted: a folder and the folders under it, which is not what sessions --where repo:<name> counts (every checkout named so).
    if (windowLeftOut) out.note(`${plural(windowLeftOut, "headless session")} ${o.repo ? `under ${o.repo}` : "in every repo"} since ${o.sinceText} left out (--headless)`);
    if (!watch) {
      const after = regressed[0]?.after;
      const removal = first.changes.map(removalStep).find((s) => s !== undefined);
      // The command as given plus one flag, so --repo, --since and --agent still pick the same sessions.
      const given = c.argv ?? (o.repo ? ["improve", "check"] : ["improve", "check", "--repo", "all"]);
      const givenPlus = (flag: string) => ["coding.sh", ...[...given, flag].map((a) => quoteArg(a, c.env))].join(" ");
      const firstAfter = after?.flaggedSessions[0]?.id ?? after?.examples[0];
      if (after) out.next("See the sessions that went wrong after it", `coding.sh show ${firstAfter === undefined ? "latest" : ref(firstAfter)}`);
      else if (removal) out.next(removal.label, removal.command);
      else if (leftOut.size || windowLeftOut) out.next("Count the headless sessions too", givenPlus("--headless"));
      else if (first.changes.some((e) => e.verdict === "too-early" || e.verdict === "no-sessions-after")) out.next("Re-check as new sessions arrive", givenPlus("--watch"));
      return regressed.length ? 1 : 0;
    }
    return watchLoop(c, first.changes, read, interval);
  });
}

/** What improve check reads: the changes in the repo, with the headless sessions or without. */
function changeOptions(o: Opts, headless: boolean): ChangeOptions {
  const opts: ChangeOptions = { since: o.since, limit: o.limit, sessionsIn: o.repo ?? "all", headless };
  if (o.agents.length) opts.agents = o.agents;
  return opts;
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
        out.print(`${new Date().toTimeString().slice(0, 8)}  ${e.change.short} ${shownSubject(out, e.change.subject)}  ${verdictText(out, e)}`);
      }
    } catch (e) {
      out.warn(e instanceof Error ? e.message : String(e));
    }
  }
  return 0;
}
