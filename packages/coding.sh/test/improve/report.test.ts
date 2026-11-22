// The improve report over a store: what it shows is redacted, whatever the
// stored events kept. Synthetic sessions in a memory index.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { Session } from "../../src/core/types.ts";
import type { ChangeEffect, Verdict } from "../../src/improve/changes.ts";
import type { Issue } from "../../src/improve/issues.ts";
import { findIssues, isHeadless, markQuiet, MAX_SESSIONS, notReadLine, readScope, removalStep, scopeSessions } from "../../src/improve/report.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const CWD = "/work/demo";
const T0 = Date.now() - 3 * 86_400_000;

describe("improve report", () => {
  it("shows no email address or token from a session's prompt or error output", async () => {
    const index = new MemoryIndexStore();
    for (let k = 0; k < 2; k++) {
      const id = `s${k}`;
      await putSession(
        index,
        sessionEvents(id, { cwd: CWD, startedAt: T0 + k * 3600_000 }, [
          ["session.start", {}],
          ["user.message", { text: "Email jane.doe@example.com when the deploy is done" }],
          ["tool.start", { tool: "Bash", toolUseId: `${id}-1`, input: { command: "npm run deploy" } }],
          ["tool.end", { tool: "Bash", toolUseId: `${id}-1`, ok: false, output: "Error: permission denied for ops+alerts@corp.example.org (key sk-ant-api03-Zq8Jx2Lm4Np6Rt0Vw3Yb5Kd7Hf9Gs1Ce)" }],
          ["assistant.message", { text: "The deploy failed." }],
          ["turn.end", {}],
        ]),
      );
    }
    const sessions = await scopeSessions(index, { since: 0 });
    const issues = await findIssues(index, sessions);
    const fail = issues.find((i) => i.kind === "failure");
    assert.ok(fail, JSON.stringify(issues));
    const shown = JSON.stringify(issues);
    assert.doesNotMatch(shown, /jane\.doe@example\.com|ops\+alerts@corp/, "emails are redacted");
    assert.doesNotMatch(shown, /sk-ant-api03-Zq8/, "a key the capture missed is redacted too");
    assert.equal(fail.examples[0]!.title, "Email [redacted:email] when the deploy is done");
    assert.match(fail.sample!, /permission denied for \[redacted:email\]/);
  });

  it("reads subagents and delegates: a failure that happens only in children is an issue", async () => {
    const index = new MemoryIndexStore();
    for (let k = 0; k < 2; k++) {
      const parent = `p${k}`;
      await putSession(index, sessionEvents(parent, { cwd: CWD, startedAt: T0 + k * 3600_000 }, [["session.start", {}], ["user.message", { text: "Build it" }], ["assistant.message", { text: "Delegating." }], ["turn.end", {}]]));
      const child = `${parent}-sub`;
      await putSession(
        index,
        sessionEvents(child, { cwd: CWD, startedAt: T0 + k * 3600_000 + 60_000 }, [
          // A delegate launched headless by its parent is in scope with it.
          ["session.start", { parentSessionId: parent, subagentType: "general-purpose", launch: "exec" }],
          ["tool.start", { tool: "Bash", toolUseId: `${child}-1`, input: { command: "cargo build" } }],
          ["tool.end", { tool: "Bash", toolUseId: `${child}-1`, ok: false, output: "error[E0425]: cannot find value `x` in this scope" }],
          ["assistant.message", { text: "The build fails." }],
          ["turn.end", {}],
        ]),
      );
    }
    const scope = await readScope(index, { since: 0 });
    assert.deepEqual(scope.sessions.map((s) => s.id).sort(), ["p0", "p0-sub", "p1", "p1-sub"]);
    assert.equal(scope.notRead, 0);
    const issues = await findIssues(index, scope.sessions);
    assert.ok(issues.some((i) => i.id === "fails:cmd:cargo build"), JSON.stringify(issues.map((i) => i.id)));
    // Another repo's scope has neither the parents nor their children.
    const other = await readScope(index, { since: 0, repo: "/work/other" });
    assert.deepEqual(other.sessions, []);
  });

  it("reads the newest sessions up to the cap and says how many it did not read", async () => {
    const index = new MemoryIndexStore();
    for (let k = 0; k < 5; k++) await putSession(index, sessionEvents(`s${k}`, { cwd: CWD, startedAt: T0 + k * 3600_000 }, [["session.start", {}], ["user.message", { text: "hi" }], ["turn.end", {}]]));
    const capped = await readScope(index, { since: 0 }, { max: 3 });
    assert.deepEqual(capped.sessions.map((s) => s.id), ["s4", "s3", "s2"]);
    assert.equal(capped.notRead, 2);
    assert.equal(notReadLine(capped.sessions.length, capped.notRead), "Read the newest 3 sessions in scope; 2 older sessions not read. A shorter --since reads them all.");
    assert.equal(notReadLine(5, 0), "");
    assert.equal(MAX_SESSIONS, 2000);
  });

  it("leaves headless sessions (claude -p, codex exec) out unless asked", async () => {
    const index = new MemoryIndexStore();
    const start = (id: string, k: number, payload: Record<string, unknown>) =>
      putSession(index, sessionEvents(id, { cwd: CWD, startedAt: T0 + k * 3600_000 }, [["session.start", payload], ["user.message", { text: "hi" }], ["turn.end", {}]]));
    await start("cli", 0, { entrypoint: "cli" });
    await start("print", 1, { entrypoint: "sdk-cli" });
    await start("exec", 2, { launch: "exec" });
    await start("unknown", 3, {});
    const ids = async (headless?: boolean) => (await scopeSessions(index, { since: 0, ...(headless ? { headless } : {}) })).map((s) => s.id).sort();
    assert.deepEqual(await ids(), ["cli", "unknown"], "a session that does not say how it started stays in");
    assert.deepEqual(await ids(true), ["cli", "exec", "print", "unknown"]);
    const all = await scopeSessions(index, { since: 0, headless: true });
    assert.deepEqual(all.filter(isHeadless).map((s) => s.id).sort(), ["exec", "print"]);
  });

  it("suggests testing the harness without a change only for followed-no-effect and costlier, and only with a previous commit", () => {
    const g = { sessions: 10, flagged: 5, byFlag: {}, examples: [], flaggedSessions: [] };
    const e = (verdict: Verdict, previous?: string): ChangeEffect => ({
      change: { commit: "b".repeat(40), short: "bbbbbbb", at: 0, subject: "s", files: [], added: [], removed: [], ...(previous ? { previous } : {}) },
      before: g,
      after: g,
      rules: [],
      verdict,
      reason: "",
    });
    const prev = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    assert.deepEqual(removalStep(e("followed-no-effect", prev)), { label: "Test whether the harness does as well without this change", command: "coding.sh refine test git:a1b2c3d" });
    assert.equal(removalStep(e("costlier", prev))?.command, "coding.sh refine test git:a1b2c3d");
    assert.equal(removalStep(e("costlier")), undefined, "no previous harness commit");
    for (const v of ["helped", "regressed", "no-clear-change", "too-early"] as const) assert.equal(removalStep(e(v, prev)), undefined, v);
  });
});

// A temp git repo with two harness versions: sessions on the old one had the issue
// at some rate, and `n` clean sessions ran on the current one.
describe("markQuiet", () => {
  let root = "";
  const heads: Record<string, string> = {};
  const git = (args: string[]): string => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (name: string, text: string): void => {
    writeFileSync(join(root, "CLAUDE.md"), text);
    git(["add", "-A"]);
    git(["commit", "-qm", name]);
    heads[name] = git(["rev-parse", "HEAD"]);
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-improve-quiet-")));
    git(["init", "-q"]);
    commit("old", "Keep answers short.\n");
    commit("new", "Keep answers short.\nRun the tests before you say you are done.\n");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const session = (id: string, head: string, k: number): Session => ({
    ...buildSession(sessionEvents(id, { cwd: root, startedAt: T0 + k * 60_000 }, [["user.message", { text: "Fix it." }], ["turn.end", {}]])),
    repo: { root, head },
  });
  const issue = (id: string, sessionIds: string[]): Issue => ({ id, kind: "failure", title: id, sessions: sessionIds.length, analyzed: 100, sessionIds, examples: [], severity: { score: 1, level: "low" }, fix: "Do the thing." });

  /** 100 sessions, `had` of them (all on the old harness) with the issue, `n` clean on the current one; whether it is quiet. */
  async function quiet(had: number, n: number): Promise<{ quiet: boolean; order: string[] }> {
    const sessions = Array.from({ length: 100 }, (_, k) => session(`s${k}`, k < n ? heads.new! : heads.old!, k));
    const target = issue("it", sessions.slice(n, n + had).map((s) => s.id));
    const ongoing = issue("ongoing", [sessions[0]!.id]);
    const marked = await markQuiet(root, sessions, [target, ongoing]);
    return { quiet: !!marked.find((i) => i.id === "it")!.quietSince, order: marked.map((i) => i.id) };
  }

  it("leaves an issue in 39% of sessions active after one clean session on the new harness", async () => {
    // 0.61^1 = 0.61: one clean session is likely by chance.
    assert.deepEqual(await quiet(39, 1), { quiet: false, order: ["it", "ongoing"] });
  });

  it("marks an issue in 39% of sessions quiet after ten clean sessions", async () => {
    // 0.61^10 = 0.007.
    const r = await quiet(39, 10);
    assert.deepEqual(r, { quiet: true, order: ["ongoing", "it"] });
  });

  it("leaves a rare issue (5%) active after three clean sessions", async () => {
    // 0.95^3 = 0.86.
    assert.deepEqual(await quiet(5, 3), { quiet: false, order: ["it", "ongoing"] });
  });
});
