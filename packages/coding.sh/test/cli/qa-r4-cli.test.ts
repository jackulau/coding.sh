// Hands-on QA, round 4: relative times never print "just now", blame and improve check outside a
// git repo name the fix with their own command, config set takes the [proxy] keys proxy --help
// documents, work snooze names its <DURATION> argument, a snooze end reads in local time, and
// the status line reads the hook spool before it counts what needs you.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as blame from "../../src/cli/commands/blame.ts";
import * as config from "../../src/cli/commands/config.ts";
import * as improve from "../../src/cli/commands/improve.ts";
import * as work from "../../src/cli/commands/work.ts";
import { nextText } from "../../src/cli/commands/work.ts";
import { ago, CliError, localTime } from "../../src/cli/output.ts";
import { UsageError } from "../../src/cli/args.ts";
import { nextStepBin } from "../../src/cli/next-steps.ts";
import { CLI } from "../_cli.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "spool", "hook.ts");
const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));
function box(): Sandbox {
  const sb = sandbox();
  boxes.push(sb);
  return sb;
}

describe("relative times", () => {
  test("under a second reads 0s ago, never the word just", () => {
    const now = Date.now();
    assert.equal(ago(now, { now }), "0s ago");
    assert.doesNotMatch(ago(now - 10, { now }), /\bjust\b/);
  });
});

describe("outside a git repo", () => {
  test("blame names blame --repo, not attribution", async () => {
    const sb = box();
    const dir = join(sb.root, "plain");
    mkdirSync(dir);
    const r = await runCmd(blame, sb, { positionals: ["AGENTS.md"], cwd: dir, json: true });
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.reason, "not_a_repo");
    assert.deepEqual(r.error.next, ["Run it inside a git repository, or pass one:", `${nextStepBin(sb.env)} blame <path> --repo <dir>`]);
  });

  test("improve check, with or without --repo all, is not_a_repo and names --repo <dir>", async () => {
    const sb = box();
    const dir = join(sb.root, "plain");
    mkdirSync(dir);
    for (const flags of [{}, { repo: "all" }]) {
      const r = await runCmd(improve, sb, { action: "check", flags, cwd: dir, json: true });
      assert.ok(r.error instanceof CliError && !(r.error instanceof UsageError), String(r.error));
      assert.equal(r.error.reason, "not_a_repo");
      assert.equal(r.error.exitCode, 1);
      assert.deepEqual(r.error.next, ["Run it inside a git repository, or pass one:", "coding.sh improve check --repo <dir>"]);
    }
  });
});

describe("config set", () => {
  test("takes the [proxy] keys proxy --help documents and refuses a bad value", async () => {
    const sb = box();
    const s = await runCmd(config, sb, { action: "set", positionals: ["proxy.port", "4400"], json: true });
    assert.equal(s.error, undefined, String(s.error));
    const g = await runCmd(config, sb, { action: "get", positionals: ["proxy.port"], json: true });
    assert.equal(g.json.value, 4400);
    assert.match(readFileSync(join(sb.env.CODING_SH_HOME!, "config.toml"), "utf8"), /\[proxy\]\r?\nport = 4400/);
    const h = await runCmd(config, sb, { action: "set", positionals: ["proxy.host", "0.0.0.0"], json: true });
    assert.equal(h.error, undefined, String(h.error));
    const bad = await runCmd(config, sb, { action: "set", positionals: ["proxy.port", "99999"] });
    assert.equal((bad.error as UsageError | undefined)?.reason, "invalid_value");
    const url = await runCmd(config, sb, { action: "set", positionals: ["proxy.anthropic_upstream", "ftp://x"] });
    assert.equal((url.error as UsageError | undefined)?.reason, "invalid_value");
  });

  test("a misspelled key gets a suggestion", async () => {
    const r = await runCmd(config, box(), { action: "set", positionals: ["retention.keepSpoolDay", "7"] });
    assert.ok(r.error instanceof UsageError);
    assert.equal(r.error.suggestion, "coding.sh config set retention.keepSpoolDays 7");
  });
});

describe("work snooze", () => {
  test("a bad duration names the <DURATION> argument, not a --duration flag", async () => {
    const r = await runCmd(work, box(), { action: "snooze", positionals: ["w000000", "1x"] });
    assert.ok(r.error instanceof UsageError);
    assert.equal(r.error.message, '<DURATION> needs a duration such as 30m, 2h, 1d or 2w, got "1x"');
    assert.doesNotMatch(r.error.message, /--duration/);
  });

  test("the text view gives a snooze end in local time; other next steps are kept", () => {
    const until = Date.now() + 3600e3;
    assert.equal(nextText(`snoozed until ${new Date(until).toISOString()}`), `snoozed until ${localTime(until)}`);
    assert.equal(nextText("nothing to do"), "nothing to do");
  });
});

describe("statusline reads the hook spool", () => {
  test("need you appears while a permission prompt is open and goes once it is answered", () => {
    const sb = box();
    const env: NodeJS.ProcessEnv = { ...process.env, ...sb.env, CLAUDE_CODE_ENTRYPOINT: "cli" };
    for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_DEV_REAL_STORE", "CODING_SH_DISABLE", "T3CODE_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CODING_SH_READ_BUDGET_MS"]) delete env[k];
    const sid = "bbbbbbbb-1111-4222-8333-444444444444";
    const cwd = join(sb.root, "p");
    mkdirSync(cwd);
    const hook = (event: string, extra: Record<string, unknown> = {}) => {
      const input = JSON.stringify({ session_id: sid, cwd, transcript_path: join(cwd, "t.jsonl"), hook_event_name: event, ...extra });
      const r = spawnSync(process.execPath, ["--no-warnings", HOOK, "claude-code", event], { env, input, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
    };
    const line = () => {
      const input = JSON.stringify({ session_id: sid, cwd, model: { display_name: "Opus" }, workspace: { current_dir: cwd } });
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "statusline", "--no-color"], { env, input, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    hook("SessionStart", { source: "startup" });
    hook("UserPromptSubmit", { prompt: "x" });
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } });
    hook("Notification", { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" });
    assert.match(line(), /·  1 need you/);
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" }, tool_response: { stdout: "" } });
    assert.doesNotMatch(line(), /need you/);
  });
});
