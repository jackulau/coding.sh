// The improve report over a store: what it shows is redacted, whatever the
// stored events kept. Synthetic sessions in a memory index.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangeEffect, Verdict } from "../../src/improve/changes.ts";
import { findIssues, isHeadless, removalStep, scopeSessions } from "../../src/improve/report.ts";
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
