// The improve report over a store: what it shows is redacted, whatever the
// stored events kept. Synthetic sessions in a memory index.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findIssues, isHeadless, scopeSessions } from "../../src/improve/report.ts";
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
});
