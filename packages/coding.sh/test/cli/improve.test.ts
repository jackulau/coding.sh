// `coding.sh improve` end to end: a temp store and a git repo whose CLAUDE.md
// gained a line, with synthetic sessions recorded before and after it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { improveWorld, type World } from "../helpers-improve.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const RULE = "Run `npm test` before you say you are done, and say what it printed.";

let root = "";

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-improve-cli-")));
});
after(() => rmSync(root, { recursive: true, force: true }));

const world = (name: string, o: Parameters<typeof improveWorld>[2]) => improveWorld(root, name, o);

function cli(w: World, args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: w.repo, env: w.env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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
    assert.match(text.stdout, /Fix: Name the check in CLAUDE\.md or AGENTS\.md\. Add: "Run `npm test` before you say you are done, and say what it printed\."/);
    assert.match(text.stderr, /Start with the first one:\n\s+coding\.sh improve fix 1/);
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
    assert.match(text.stderr, /Nothing new since your last change; see whether it helped:\n\s+coding\.sh improve check/);
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
    assert.match(g.stdout, /Helped: [^\n]*\n\n/, "nothing listed under a change no session after it is flagged on");
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
    assert.match(text.stderr, /See the sessions that went wrong after it:\n\s+coding\.sh show after-5/);

    const all = cli(w, ["improve", "check", "--sessions"]);
    assert.match(all.stdout, /^ {4}after-0 /m);
    assert.doesNotMatch(all.stdout, /more \(--sessions/);
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

  it("outside a git repo, check and fix say why", async () => {
    const w = await world("norepo", { afterFlagged: 0 });
    const dir = join(root, "norepo", "plain");
    mkdirSync(dir);
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "improve", "check"], { cwd: dir, env: w.env, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Not in a git repo/);
  });
});
