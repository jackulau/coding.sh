// `coding.sh improve` end to end: a temp store and a git repo whose CLAUDE.md
// gained a line, with synthetic sessions recorded before and after it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { putSession, sessionEvents } from "../helpers-decision.ts";
import { improveWorld, type World } from "../helpers-improve.ts";
import { CLI } from "../_cli.ts";

const RULE = "Run `npm test` before you say you are done, and say what it printed.";

let root = "";

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-improve-cli-")));
});
after(() => rmSync(root, { recursive: true, force: true }));

// SHELL set: the commands these tests read are the sh forms (`coding.sh ...`) on Windows too; a
// PowerShell or cmd run names codingsh (test/cli/qa-r9-cli.test.ts).
const world = async (name: string, o: Parameters<typeof improveWorld>[2]) => {
  const w = await improveWorld(root, name, o);
  w.env.SHELL ??= "/bin/sh";
  return w;
};

function cli(w: World, args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: w.repo, env: w.env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Commits one more CLAUDE.md line now: a harness change no session ran with yet. */
function commitRule(w: World, line: string, subject: string) {
  appendFileSync(join(w.repo, "CLAUDE.md"), `${line}\n`);
  const r = spawnSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qam", subject], { cwd: w.repo, env: w.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/** Headless sessions (`claude -p`) that ran `npm test` in `dir` at git HEAD `head`; `main` when dir is a linked worktree of that repo. */
async function headlessIn(w: World, rows: { id: string; dir: string; head: string; main?: string; daysAgo: number }[]) {
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env: w.env, cwd: w.repo });
  try {
    for (const r of rows) {
      const repo: { root: string; head: string; main?: string } = { root: r.dir, head: r.head };
      if (r.main) repo.main = r.main;
      const events = sessionEvents(r.id, { cwd: r.dir, startedAt: Date.now() - r.daysAgo * 86_400_000 }, [
        ["session.start", { entrypoint: "sdk-cli" }],
        ["user.message", { text: `Task ${r.id}` }],
        ["tool.start", { tool: "Bash", toolUseId: `${r.id}-t`, input: { command: "npm test" } }],
        ["tool.end", { tool: "Bash", toolUseId: `${r.id}-t`, ok: true, output: "ok" }],
        ["assistant.message", { text: "Done." }],
      ]);
      await putSession(ctx.index, events.map((e) => ({ ...e, repo })));
    }
  } finally {
    await ctx.close();
  }
}

describe("cli improve", () => {
  it("ranks what to fix with the commands that take it through the loop", async () => {
    const w = await world("still", { afterFlagged: 2 });
    const r = cli(w, ["improve", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { scope: { sessions: number }; issues: { rank: number; id: string; sessions: number; rule?: string; quietSince?: unknown; next: { command: string }[] }[] };
    assert.equal(j.scope.sessions, 12);
    const i = j.issues[0]!;
    assert.deepEqual([i.id, i.sessions, i.rule, i.quietSince], ["flag:no-verification", 6, RULE, undefined]);
    assert.deepEqual(
      i.next.map((s) => s.command),
      ["coding.sh show after-1", "coding.sh improve fix 1", "coding.sh exp ab --behavior unverified-claim --dry-run", "coding.sh improve check"],
    );
    const text = cli(w, ["improve"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^12 sessions in repo since 14d \(claude-code 12\)$/m);
    assert.match(text.stdout, /^1\. Says it is done without running anything to check$/m);
    assert.match(text.stdout, /Fix: Name the check in AGENTS\.md\. Add: "Run `npm test` before you say you are done, and say what it printed\."/);
    assert.match(text.stderr, /Start with the first one:\n\s+(?:coding\.sh|codingsh) improve fix 1/);
  });

  it("names the repo, not a relative path, when run from a subdirectory", async () => {
    const w = await world("subdir", { afterFlagged: 2 });
    const sub = join(w.repo, "pkg", "src");
    mkdirSync(sub, { recursive: true });
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "improve"], { cwd: sub, env: w.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^12 sessions in repo since 14d \(claude-code 12\)$/m);
    assert.doesNotMatch(r.stdout, /\.\./);
  });

  it("leaves headless sessions out and says how many; --headless counts them", async () => {
    const w = await world("headless", { afterFlagged: 0, headless: 3 });
    const j = (args: string[]) => {
      const r = cli(w, ["improve", "--json", ...args]);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as { scope: { sessions: number; headlessLeftOut?: number }; issues: { id: string; sessions: number }[] };
    };
    const out = j([]);
    assert.deepEqual([out.scope.sessions, out.scope.headlessLeftOut], [12, 3]);
    assert.equal(out.issues.find((i) => i.id === "flag:no-verification")?.sessions, 4, "the headless runs' flags are not counted");
    const all = j(["--headless"]);
    assert.deepEqual([all.scope.sessions, all.scope.headlessLeftOut], [15, undefined]);
    assert.equal(all.issues.find((i) => i.id === "flag:no-verification")?.sessions, 7);
    const text = cli(w, ["improve"]);
    assert.match(text.stdout, /^12 sessions in repo since 14d \(claude-code 12\); 3 headless sessions left out \(--headless\)$/m);
  });

  it("lists what lost prompt cache cost, with a fix per cause", async () => {
    const w = await world("cache", { afterFlagged: 0, cacheBreaks: true });
    const r = cli(w, ["improve", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { issues: { id: string; kind: string; sessions: number; usd?: number; causes?: { cause: string; breaks: number; fix: string }[]; next: { command: string }[] }[] };
    const cost = j.issues.find((i) => i.kind === "cost");
    assert.ok(cost, JSON.stringify(j.issues.map((i) => i.id)));
    assert.equal(cost.sessions, 12);
    assert.ok(cost.usd! > 1, String(cost.usd));
    assert.deepEqual(cost.causes!.map((k) => [k.cause, k.breaks]), [["idle", 12]]);
    const text = cli(w, ["improve"]);
    assert.match(text.stdout, /Pays \$[\d.,]+ again for prompt cache it lost \(12 cache breaks, \d+% of the spend\)/);
    assert.match(text.stdout, /^ {3}Fix, costliest cause first:\n {5}idle \(\$[\d.]+, 12 breaks\): the cache expired during a wait/m);
  });

  it("says the CLAUDE.md change helped, and an issue no session since it had is marked, not fixed again", async () => {
    const w = await world("helped", { afterFlagged: 0 });
    const r = cli(w, ["improve", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as {
      issues: { id: string; sessions: number; quietSince?: { commit: string; sessions: number }; next: { command: string }[] }[];
      changes: { subject: string; verdict: string; before: { sessions: number; flagged: number }; after: { sessions: number; flagged: number }; rules: { before: { acted: number; n: number }; after: { acted: number; n: number } }[] }[];
    };
    const i = j.issues[0]!;
    assert.deepEqual([i.id, i.sessions, i.quietSince], ["flag:no-verification", 4, { commit: w.commits.rule!.slice(0, 7), sessions: 6 }]);
    assert.deepEqual(
      i.next.map((s) => s.command),
      ["coding.sh show before-3", "coding.sh improve check"],
    );
    const ch = j.changes[0]!;
    assert.equal(ch.subject, "CLAUDE.md: run the tests");
    assert.equal(ch.verdict, "helped");
    assert.deepEqual([ch.before, ch.after].map((g) => [g.sessions, g.flagged]), [[4, 4], [6, 0]], "sessions with no tool call are left out");
    assert.deepEqual([ch.rules[0]!.before, ch.rules[0]!.after], [{ acted: 0, n: 4 }, { acted: 6, n: 6 }], "a session with no tool call is not scored on the line");
    assert.equal(j.changes[1]!.verdict, "no-baseline");

    const text = cli(w, ["improve"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`Not seen in the 6 sessions since ${w.commits.rule!.slice(0, 7)} changed the harness`));
    assert.doesNotMatch(text.stdout, /Fix: /);
    assert.match(text.stdout, /Helped: Fewer sessions went wrong after it: flagged sessions 4 of 4 before, 0 of 6 after/);
    assert.match(text.stderr, /Nothing new since your last change; see whether it helped:\n\s+(?:coding\.sh|codingsh) improve check/);
  });

  it("improve fix appends the line once, uncommitted; --dry-run writes nothing", async () => {
    const w = await world("fix", { afterFlagged: 0 });
    const file = join(w.repo, "CLAUDE.md");
    const before = readFileSync(file, "utf8");
    const dry = cli(w, ["improve", "fix", "1", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would add to CLAUDE\.md:\n\+ Run `npm test`/);
    assert.equal(readFileSync(file, "utf8"), before);

    const r = cli(w, ["improve", "fix", "1", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { file: string; line: string; changed: boolean; test: string };
    assert.deepEqual([j.file, j.line, j.changed, j.test], ["CLAUDE.md", RULE, true, "coding.sh exp ab --behavior unverified-claim"]);
    assert.equal(readFileSync(file, "utf8"), `${before}\n${RULE}\n`);

    const again = cli(w, ["improve", "fix", "flag:no-verification", "--json"]);
    assert.equal((JSON.parse(again.stdout) as { alreadyPresent: boolean }).alreadyPresent, true);
    assert.equal(readFileSync(file, "utf8"), `${before}\n${RULE}\n`, "not added twice");

    const missing = cli(w, ["improve", "fix", "9"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No issue "9"/);
  });

  it("improve fix on a file it just created: the printed commit step commits it", async () => {
    const w = await world("fix-new", { afterFlagged: 0 });
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: w.repo, env: w.env, encoding: "utf8" });
    assert.equal(git("rm", "-q", "CLAUDE.md").status, 0);
    assert.equal(git("commit", "-qm", "drop CLAUDE.md").status, 0);
    const r = cli(w, ["improve", "fix", "1"]);
    assert.equal(r.status, 0, r.stderr);
    // One `&&` line for sh; in PowerShell or cmd (windowsShell) one line per command.
    const steps = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("git "));
    assert.ok(steps.length, `a git step is printed:\n${r.stdout}${r.stderr}`);
    // Run it up to the improve check, with an identity for the commit.
    const commit = steps.map((l) => l.replace(/ && coding\.sh improve check$/, "")).join(" && ");
    const env = { ...w.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = spawnSync("sh", ["-c", commit], { cwd: w.repo, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(git("status", "--porcelain").stdout.trim(), "");
  });

  it("improve fix's commit step: one && line for sh; in PowerShell or cmd one command per line, quoted by quoteArg", async () => {
    const { commitSteps } = await import("../../src/cli/commands/improve.ts");
    const { quoteArg } = await import("../../src/cli/next-steps.ts");
    const msg = "CLAUDE.md: says it is done without running anything to check";
    const sh = commitSteps("CLAUDE.md", msg, { SHELL: "/bin/bash" }, "linux");
    assert.deepEqual(sh.map(([, c]) => c), [`git add CLAUDE.md && git commit -m '${msg}' && coding.sh improve check`]);
    const win = commitSteps("docs/My Rules.md", msg, {}, "win32");
    assert.deepEqual(win.map(([, c]) => c), [`git add ${quoteArg("docs/My Rules.md", {}, "win32")}`, `git commit -m ${quoteArg(msg, {}, "win32")}`, "coding.sh improve check"]);
    assert.deepEqual(win.map(([, c]) => c), ['git add "docs/My Rules.md"', `git commit -m "${msg}"`, "coding.sh improve check"]);
    assert.ok(win.every(([, c]) => !c.includes("&&")), "PowerShell 5.1 has no &&");
    // Git Bash on Windows is sh: one line again.
    assert.equal(commitSteps("CLAUDE.md", msg, { MSYSTEM: "MINGW64" }, "win32").length, 1);
  });

  it("improve check: when only headless sessions ran after a change, its reason says so, once, and names --headless", async () => {
    const w = await world("headless-after", { afterFlagged: 0, plan: { before: [{ test: true }, { test: true }, { test: true }], after: [{ headless: true }, { headless: true }] } });
    const reason = "Only headless sessions ran with this change: 2 (claude -p, an Agent SDK, codex exec). --headless counts them.";
    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`\n  ${reason}\n`), text.stdout);
    assert.doesNotMatch(text.stdout, /No sessions yet|No captured session ran|headless sessions after it/, "said once, and not as if no session ran");
    assert.match(text.stderr, /Count the headless sessions too:\n\s+(?:coding\.sh|codingsh) improve check --headless/);
    const j = JSON.parse(cli(w, ["improve", "check", "--json"]).stdout) as { changes: { commit: string; verdict: string; reason: string; headlessLeftOut?: number }[] };
    const ch = j.changes.find((c) => c.commit === w.commits.rule)!;
    assert.deepEqual([ch.verdict, ch.reason, ch.headlessLeftOut], ["no-sessions-after", reason, 2]);
    const all = JSON.parse(cli(w, ["improve", "check", "--json", "--headless"]).stdout) as typeof j;
    const counted = all.changes.find((c) => c.commit === w.commits.rule)!;
    assert.notEqual(counted.verdict, "no-sessions-after");
    assert.equal(counted.headlessLeftOut, undefined);
    // improve shows the change with the same reason.
    const report = JSON.parse(cli(w, ["improve", "--json"]).stdout) as { changes: { commit: string; reason: string }[] };
    assert.equal(report.changes.find((c) => c.commit === w.commits.rule)?.reason, reason);
    assert.ok(cli(w, ["improve"]).stdout.includes(`\n    ${reason}\n`));
  });

  it("improve check: a change no session ran with yet says so once", async () => {
    const w = await world("none-after", { afterFlagged: 0 });
    commitRule(w, "Keep commits small.", "CLAUDE.md: keep commits small");
    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /"CLAUDE\.md: keep commits small"\n {4}\+ Keep commits small\.\n {2}No captured session ran with this change yet\.\n/);
    assert.doesNotMatch(text.stdout, /No sessions yet/);
  });

  it("improve check cuts a long commit subject to one line, as sessions cuts titles; --json keeps it whole", async () => {
    const w = await world("long-subject", { afterFlagged: 0 });
    const subject = `CLAUDE.md: ${Array.from({ length: 30 }, (_, k) => `rule ${k} says what the tests printed`).join(", ")}`;
    assert.ok(subject.length > 600);
    commitRule(w, "Say what the tests printed.", subject);
    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 0, text.stderr);
    // Off a TTY, 100 characters, as the sessions table cuts a title.
    assert.ok(text.stdout.includes(` ${JSON.stringify(`${subject.slice(0, 99)}…`)}\n`), text.stdout);
    assert.ok(!text.stdout.includes(subject.slice(0, 101)));
    const j = JSON.parse(cli(w, ["improve", "check", "--json"]).stdout) as { changes: { subject: string }[] };
    assert.equal(j.changes[0]!.subject, subject);
  });

  it("improve check counts the headless sessions it left out in the folders it reads; sessions --where repo: counts by repo name", async () => {
    const w = await world("headless-folders", { afterFlagged: 0, headless: 2 });
    await headlessIn(w, [
      // A repo nested in the checkout's folder, at a commit this repo does not have.
      { id: "nested-0", dir: join(w.repo, "vendor", "lib"), head: "0".repeat(40), daysAgo: 3 },
      // A linked worktree of the repo outside its folder: check reads it only with --repo.
      { id: "worktree-0", dir: join(root, "headless-folders", "other"), head: w.commits.rule!, main: w.repo, daysAgo: 3 },
      { id: "worktree-1", dir: join(root, "headless-folders", "other"), head: w.commits.rule!, main: w.repo, daysAgo: 2.5 },
    ]);
    const check = (args: string[]) => {
      const r = cli(w, ["improve", "check", "--json", ...args]);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout) as { headlessLeftOut?: number; changes: { commit: string; after: { sessions: number } }[] };
    };
    // Under the checkout's folder: its own 2 and the nested repo's 1, not the worktree's 2.
    assert.equal(check([]).headlessLeftOut, 3);
    // --headless reads the same folders: the checkout's 2 count after the change; the nested repo's commit is not in this history.
    assert.equal(check(["--headless"]).changes.find((c) => c.commit === w.commits.rule)!.after.sessions, 8);
    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stderr, /3 headless sessions under [^\n]+ since 30d left out \(--headless\)/);
    // sessions counts by repo name: the checkout's 2 and the worktree's 2, not the nested repo (named lib).
    const s = cli(w, ["sessions", "--where", "repo:repo", "--since", "30d", "--facets", "launch", "--json"]);
    assert.equal(s.status, 0, s.stderr);
    const launch = (JSON.parse(s.stdout) as { facets: { launch: { value: string; count: number }[] } }).facets.launch;
    assert.equal(launch.find((f) => f.value === "headless")?.count, 4);
  });

  it("improve check exits 1 on a regression and 0 otherwise", async () => {
    const bad = await world("regressed", { afterFlagged: 6, beforeTested: true });
    const r = cli(bad, ["improve", "check", "--json"]);
    assert.equal(r.status, 1, r.stderr);
    const j = JSON.parse(r.stdout) as { regressed: string[]; changes: { verdict: string }[] };
    assert.deepEqual(j.regressed, [bad.commits.rule]);
    assert.equal(j.changes[0]!.verdict, "regressed");

    const good = await world("ok", { afterFlagged: 0 });
    const g = cli(good, ["improve", "check"]);
    assert.equal(g.status, 0, g.stderr);
    assert.match(g.stdout, /Helped: /);
    assert.match(g.stdout, /Helped: [^\n]*\n(?: {2}Left out: [^\n]*\n)?\n/, "nothing listed under a change no session after it is flagged on");
    // The world's sessions with no tool call are left out of the verdict, and counted.
    assert.match(g.stdout, /Left out: 2 sessions with no tool call \(2 before, 0 after\)/);
  });

  it("improve check lists the sessions still flagged after each change: 5 with a count of the rest, all with --sessions, every one in --json", async () => {
    const w = await world("flagged", { afterFlagged: 6, beforeTested: true });
    const j = JSON.parse(cli(w, ["improve", "check", "--json"]).stdout) as { changes: { after: { flagged: number; flaggedSessions: { id: string; at: string; title?: string; flags: string[] }[] }; before: { flaggedSessions: unknown[] } }[] };
    const after = j.changes[0]!.after;
    assert.equal(after.flagged, 6);
    assert.deepEqual(
      after.flaggedSessions.map((s) => s.id),
      ["after-5", "after-4", "after-3", "after-2", "after-1", "after-0"],
      "newest first",
    );
    assert.deepEqual(after.flaggedSessions[0], { id: "after-5", at: after.flaggedSessions[0]!.at, title: "Task after-5", flags: ["no-verification"] });
    assert.match(after.flaggedSessions[0]!.at, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(j.changes[0]!.before.flaggedSessions, []);

    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stdout, /^ {2}Still flagged after it, 6 of 6 sessions \(coding\.sh show <id>\):$/m);
    assert.match(text.stdout, /^ {4}after-5 {2}\w{3} \d+ (\d\d:\d\d|\d{4}) {2}no-verification {2}"Task after-5"$/m);
    assert.doesNotMatch(text.stdout, /^ {4}after-0 /m);
    assert.match(text.stdout, /… 1 more \(--sessions lists them all\)/);
    assert.match(text.stderr, /See the sessions that went wrong after it:\n\s+(?:coding\.sh|codingsh) show after-5/);

    const all = cli(w, ["improve", "check", "--sessions"]);
    assert.match(all.stdout, /^ {4}after-0 /m);
    assert.doesNotMatch(all.stdout, /more \(--sessions/);
  });

  it("improve check: a line the agent follows while flagged sessions stay put is 'Followed, no effect yet', exit 0, with a removal test", async () => {
    // 5 of 10 flagged on each side (a build failing three times), the npm test line acted on 0 of 10 → 9 of 10; equal work.
    const w = await world("followed", {
      afterFlagged: 0,
      plan: {
        before: [...Array.from({ length: 5 }, () => ({ failing: true, reads: 2 })), ...Array.from({ length: 5 }, () => ({ reads: 2 }))],
        after: [...Array.from({ length: 5 }, () => ({ failing: true, test: true, reads: 1 })), ...Array.from({ length: 4 }, () => ({ test: true, reads: 1 })), { reads: 2 }],
      },
    });
    const prev = w.commits.init!.slice(0, 7);
    const r = cli(w, ["improve", "check", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { regressed: string[]; changes: { verdict: string; reason: string; before: Record<string, unknown>; after: { flagged: number; sessions: number }; rules: { before: unknown; after: unknown }[]; work?: unknown; next?: string }[] };
    const ch = j.changes[0]!;
    assert.equal(ch.verdict, "followed-no-effect", ch.reason);
    assert.deepEqual(j.regressed, []);
    assert.deepEqual([ch.after.flagged, ch.after.sessions], [5, 10]);
    assert.deepEqual([ch.rules[0]!.before, ch.rules[0]!.after], [{ acted: 0, n: 10 }, { acted: 9, n: 10 }]);
    assert.equal(ch.work, undefined, "equal work: no work field");
    assert.equal("work" in ch.before, false, "per-session work stays out of the group counts");
    assert.equal(ch.next, `coding.sh refine test git:${prev}`);

    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(
      text.stdout,
      /^ {2}Followed, no effect yet: The agent follows the new line \(9 of 10 sessions after, 0 of 10 before, p < 0\.001\), but flagged sessions did not fall \(5 of 10 before, 5 of 10 after, p 1\.000\): following a line is not the same as fixing what it targets\.$/m,
    );
    assert.match(text.stderr, new RegExp(`Test whether the harness does as well without this change:\\n\\s+(?:coding\\.sh|codingsh) refine test git:${prev}`));
  });

  it("improve check: more tool calls after a change with the flags unchanged is 'Costlier', with both medians and a removal test", async () => {
    const w = await world("costlier", { afterFlagged: 0, plan: { before: Array.from({ length: 10 }, () => ({ reads: 20 })), after: Array.from({ length: 10 }, () => ({ reads: 45 })) } });
    const r = cli(w, ["improve", "check", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const ch = (JSON.parse(r.stdout) as { changes: { verdict: string; reason: string; work?: { toolCalls?: { before: number; after: number; p: number }; durationMs?: { before: number; after: number } }; next?: string }[] }).changes[0]!;
    assert.equal(ch.verdict, "costlier", ch.reason);
    assert.deepEqual([ch.work?.toolCalls?.before, ch.work?.toolCalls?.after], [20, 45]);
    assert.ok(ch.work!.toolCalls!.p <= 0.1);
    assert.equal(ch.work!.durationMs, undefined, "these sessions never ended (no session.end), so no wall time");
    assert.equal(ch.next, `coding.sh refine test git:${w.commits.init!.slice(0, 7)}`);
    const text = cli(w, ["improve", "check"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^ {2}Costlier: Sessions after it make more tool calls \(median 20 → 45, p < 0\.001\), and flagged sessions did not fall \(0 of 10 before, 0 of 10 after, p 1\.000\)\.$/m);
    assert.match(text.stderr, /Test whether the harness does as well without this change:\n\s+(?:coding\.sh|codingsh) refine test git:/);
  });

  it("improve check --repo counts sessions from another checkout of the repo against its history", async () => {
    const w = await world("checkouts", { afterFlagged: 0, elsewhere: true });
    const here = JSON.parse(cli(w, ["improve", "check", "--json"]).stdout) as { changes: { verdict: string; after: { sessions: number } }[] };
    assert.deepEqual([here.changes[0]!.verdict, here.changes[0]!.after.sessions], ["no-sessions-after", 0], "by default only this checkout's sessions count");
    for (const repo of ["all", join(root, "checkouts", "other")]) {
      const r = cli(w, ["improve", "check", "--repo", repo, "--json"]);
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout) as { changes: { verdict: string; before: { sessions: number }; after: { sessions: number } }[] };
      assert.deepEqual([j.changes[0]!.verdict, j.changes[0]!.before.sessions, j.changes[0]!.after.sessions], ["helped", 4, 6], `--repo ${repo}`);
    }
  });

  it("--repo as a repo name reads that repo's history, as the MCP improve tool does; an unknown name is an error", async () => {
    const w = await world("byname", { afterFlagged: 0 });
    const at = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: root, env: w.env, encoding: "utf8" });
    const want = (JSON.parse(cli(w, ["improve", "check", "--json"]).stdout) as { changes: { commit: string }[] }).changes.map((ch) => ch.commit);
    assert.ok(want.length > 0);
    // From a folder with no "repo" in it: the name is the captured repo's, not a path.
    for (const name of process.platform === "win32" ? ["repo", "REPO"] : ["repo"]) {
      const r = at(["improve", "check", "--repo", name, "--json"]);
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout) as { repo: string; changes: { commit: string }[] };
      assert.deepEqual(j.changes.map((ch) => ch.commit), want, `check --repo ${name}`);
      const rep = at(["improve", "--repo", name, "--json"]);
      assert.equal(rep.status, 0, rep.stderr);
      const jr = JSON.parse(rep.stdout) as { scope: { sessions: number }; changes: { commit: string }[] };
      assert.deepEqual(jr.changes.map((ch) => ch.commit), want.slice(0, jr.changes.length), `improve --repo ${name}`);
      assert.ok(jr.changes.length > 0 && jr.scope.sessions > 0);
    }
    const none = at(["improve", "check", "--repo", "no-such-repo"]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /No captured session in a git repo named "no-such-repo"/);
    assert.doesNotMatch(none.stdout + none.stderr, /No commits changed/);
  });

  it("outside a git repo, check and fix say why", async () => {
    const w = await world("norepo", { afterFlagged: 0 });
    const dir = join(root, "norepo", "plain");
    mkdirSync(dir);
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "improve", "check"], { cwd: dir, env: w.env, encoding: "utf8" });
    assert.equal(r.status, 1, "not a usage error: no argument is missing");
    assert.match(r.stderr, /Not in a git repo/);
    assert.match(r.stderr, /(?:coding\.sh|codingsh) improve check --repo <dir>/);
  });
});
