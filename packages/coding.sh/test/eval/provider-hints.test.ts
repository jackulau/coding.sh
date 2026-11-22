// QA round 7: a mistyped judge provider in a grader spec gets the same "did you mean" hint
// `monitor add --provider` gives, and a --judge monitor whose provider has no key names
// that key at run time and in `monitor list`, as `monitor add` does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as judgeCmd from "../../src/cli/commands/judge.ts";
import * as monitorCmd from "../../src/cli/commands/monitor.ts";
import { paths } from "../../src/core/paths.ts";
import { providerFromSpec } from "../../src/graders/index.ts";
import { NO_PROVIDER } from "../../src/monitor/run.ts";
import { readMonitors } from "../../src/monitor/state.ts";
import { runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "spool", "hook.ts");
const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

function box(): Sandbox {
  const sb = sandbox({ T3CODE_HOME: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, AI_GATEWAY_API_KEY: undefined, GEMINI_API_KEY: undefined });
  sb.env.T3CODE_HOME = join(sb.root, "t3");
  boxes.push(sb);
  return sb;
}

/** One finished Claude Code session captured by the hook, timestamped now. */
function capture(sb: Sandbox, sessionId: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...sb.env };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_DEV_REAL_STORE", "CODING_SH_DISABLE", "T3CODE_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const lines: [string, Record<string, unknown>][] = [
    ["SessionStart", { source: "startup" }],
    ["UserPromptSubmit", { prompt: "fix the failing test" }],
    ["Stop", { last_assistant_message: "The test passes now." }],
    ["SessionEnd", { reason: "exit" }],
  ];
  for (const [event, extra] of lines) {
    const input = JSON.stringify({ session_id: sessionId, cwd: "/work/demo", hook_event_name: event, ...extra });
    const r = spawnSync(process.execPath, ["--no-warnings", HOOK, "claude-code", event], { env, input, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
  }
}

describe("judge provider hints", () => {
  it("a mistyped provider in a grader spec suggests the close one", async () => {
    assert.throws(() => providerFromSpec({ provider: "gemnii" as "gemini" }), /Did you mean "gemini"\?/);
    assert.throws(() => providerFromSpec({ provider: "zzzzzzzz" as "gemini" }), (e: Error) => !/Did you mean/.test(e.message));
    const sb = box();
    const out = join(sb.root, "out.txt");
    writeFileSync(out, "answer\n");
    const grader = JSON.stringify({ kind: "llm", name: "q", rubric: "Is it good?", provider: "gemnii" });
    const r = await runCmd(judgeCmd, sb, { action: "grade", flags: { grader, output: out } });
    assert.match(String(r.error?.message), /unknown provider "gemnii".*Did you mean "gemini"\?/);
  });

  it("a --judge monitor with --provider and no key names the key at run time", async () => {
    const sb = box();
    const rubric = join(sb.root, "rubric.md");
    writeFileSync(rubric, "Is it helpful?\n");
    const added = await runCmd(monitorCmd, sb, { action: "add", positionals: ["g1"], flags: { judge: rubric, provider: "gemini" }, json: true });
    assert.equal(added.code, 0, added.stderr);
    capture(sb, "hint-nokey-1");
    const run = await runCmd(monitorCmd, sb, { action: "run", positionals: ["g1"], flags: { since: "1h" }, json: true });
    assert.equal(run.error, undefined, String(run.error));
    const m = run.json.monitors[0];
    assert.equal(m.stopped, "no-provider");
    assert.equal(m.error, `${NO_PROVIDER}: gemini: set GEMINI_API_KEY`);
    assert.equal(readMonitors(paths(sb.env).monitors).monitors[0]!.lastError!.message, `${NO_PROVIDER}: gemini: set GEMINI_API_KEY`);
    const list = await runCmd(monitorCmd, sb, { action: "list" });
    assert.match(list.stdout + list.stderr, /set GEMINI_API_KEY/);
  });
});
