// Hands-on QA, round 6: detect never launches another tool's `agent` (Grok's makes ~/.grok),
// uninstall names an MCP install it could not reach, diff-calls says "not recorded" instead of
// "same" when no requests are stored, cache doctor names a compaction break as usage does, and
// the hints of export, config set, views save and review create name what the user typed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { isCursorAgentPath } from "../../src/adapters/cursor.ts";
import { UsageError } from "../../src/cli/args.ts";
import { CACHE_CAUSES } from "../../src/cli/cache-health.ts";
import * as config from "../../src/cli/commands/config.ts";
import { printDiff, recordedOf } from "../../src/cli/commands/diff-calls.ts";
import * as exportCmd from "../../src/cli/commands/export.ts";
import * as review from "../../src/cli/commands/review.ts";
import * as views from "../../src/cli/commands/views.ts";
import { CliError, Output } from "../../src/cli/output.ts";
import type { CallDiff } from "../../src/proxy/calls.ts";
import type { AgentEvent, CacheBreakCause } from "../../src/schema/index.ts";
import { writeFile } from "../adapters/_helpers.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { CLI } from "../_cli.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));
function box(): Sandbox {
  const sb = sandbox();
  boxes.push(sb);
  return sb;
}

/** A stand-in for dist/hook.mjs, which init installs: a run from source without a build has none (CI's Node 22 and Windows legs). */
function standInHook(sb: Sandbox): string {
  const hook = join(sb.root, "dist", "hook.mjs");
  if (!existsSync(hook)) writeFile(hook, "// hook\n");
  return hook;
}

const cli = (sb: Sandbox, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: sb.env.HOME, env: { ...sb.env, XDG_CONFIG_HOME: join(sb.root, "xdg"), APPDATA: join(sb.root, "appdata"), NO_UPDATE_NOTIFIER: "1", CODING_SH_HOOK_SOURCE: standInHook(sb), ...env }, encoding: "utf8", timeout: 120_000 });

describe("agent detection", () => {
  test("init --dry-run and doctor never launch a generic `agent` that is not Cursor's", () => {
    const sb = box();
    const bin = join(sb.root, "bin");
    // Grok's `agent` makes its home folder whenever it runs.
    nodeBin(bin, "agent", 'require("fs").mkdirSync(require("path").join(require("os").homedir(), ".grok"), { recursive: true });\nconsole.log("1.0.0");\n');
    const PATH = pathOf(bin, dirname(process.execPath));
    for (const args of [["init", "--dry-run"], ["doctor", "--json"]]) {
      cli(sb, args, { PATH });
      assert.ok(!existsSync(join(sb.env.HOME!, ".grok")), `${args.join(" ")} launched the foreign agent`);
    }
  });

  test("an `agent` in a cursor folder is still Cursor's", () => {
    assert.equal(isCursorAgentPath(join("x", "cursor-agent", "agent")), true);
    assert.equal(isCursorAgentPath(join("x", ".grok", "bin", "agent")), false);
  });
});

describe("uninstall", () => {
  test("names an OpenCode install made under another OPENCODE_CONFIG_DIR, and does not report full success", () => {
    const sb = box();
    const alt = join(sb.root, "alt", "oc");
    const init = cli(sb, ["init", "--yes", "--no-import", "--agent", "opencode"], { OPENCODE_CONFIG_DIR: alt, PATH: dirname(process.execPath) });
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(alt, "opencode.json")));
    const r = cli(sb, ["uninstall", "--yes"], { PATH: dirname(process.execPath) });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /OpenCode: .*opencode\.json holds a coding\.sh install outside the config dir uninstall looked in/);
    // `VAR=value cmd` is sh syntax: in PowerShell or cmd (no SHELL or MSYSTEM) it names the variable to set.
    if (process.platform === "win32") assert.match(r.stderr, /Remove it: set OPENCODE_CONFIG_DIR to .*oc as at init, then run:\n {4}codingsh uninstall --agent opencode$/m);
    else assert.match(r.stderr, /OPENCODE_CONFIG_DIR=.* coding\.sh uninstall --agent opencode/);
    const j = cli(sb, ["uninstall", "--yes", "--json"], { PATH: dirname(process.execPath) });
    assert.equal(JSON.parse(j.stdout).outcome, "partial");
    // The command it names removes both files.
    const again = cli(sb, ["uninstall", "--yes", "--agent", "opencode"], { OPENCODE_CONFIG_DIR: alt, PATH: dirname(process.execPath) });
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!existsSync(join(alt, "opencode.json")));
    assert.doesNotMatch(readFileSync(join(sb.env.CODING_SH_HOME!, "installs.json"), "utf8"), /opencode\.json/);
  });
});

describe("diff-calls without stored requests", () => {
  test("tools, system and messages read not recorded, never same or 0 → 0", () => {
    const ev = (id: string, ts: number) => ({ id, sessionId: "s", kind: "llm.call", ts, model: "m", payload: {}, source: "transcript" }) as unknown as AgentEvent; // slop-allow chained-as: a call event with only the fields recordedOf reads
    const rec = recordedOf(ev("a", 1), ev("b", 2));
    assert.deepEqual(rec, { tools: false, system: false, messages: false });
    const side = (id: string, ts: number) => ({ id, sessionId: "s", ts, model: "m", usage: {} });
    const d = {
      a: side("aaaaaaaaaaaaaaaa", 1),
      b: side("bbbbbbbbbbbbbbbb", 2),
      content: "metadata",
      params: [],
      tools: { same: true, added: [], removed: [], changed: [], reordered: false },
      system: { same: true },
      messages: { a: 0, b: 0, shared: 0, rewritten: false },
      cache: { reused: false, expected: 100, read: 0, write: 100, gapMs: 1000, cause: "these calls came from the agent's records, which keep no requests" },
    } as unknown as CallDiff; // slop-allow chained-as: a diff with only the fields printDiff prints here
    let text = "";
    printDiff(new Output({ json: false, noColor: true, env: {}, stdout: { write: (x: string) => ((text += x), true), isTTY: false }, stdin: { isTTY: false } }), d, rec);
    assert.match(text, /^Tools {5}not recorded$/m);
    assert.match(text, /^System {4}not recorded$/m);
    assert.match(text, /^Messages {2}not recorded$/m);
    assert.doesNotMatch(text, /^(Tools|System|Messages) .*(same|0 → 0)/m);
  });
});

describe("cache break causes", () => {
  test("cache doctor names every stored cause as usage --cache and improve do", () => {
    const stored: CacheBreakCause[] = ["compaction", "model-switch", "idle", "other"];
    for (const c of stored) assert.ok((CACHE_CAUSES as readonly string[]).includes(c), `${c} is a cache doctor cause`);
  });
});

describe("hints that name what the user typed", () => {
  test("export sesions suggests export sessions", async () => {
    const r = await runCmd(exportCmd, box(), { positionals: ["sesions"] });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, "coding.sh export sessions");
  });

  test("config set capture.mode ful suggests full", async () => {
    const r = await runCmd(config, box(), { action: "set", positionals: ["capture.mode", "ful"] });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.match(r.error.message, /must be one of/);
    assert.equal(r.error.suggestion, "coding.sh config set capture.mode full");
  });

  test("config get prints nothing on stdout for a known key that is not set", async () => {
    const r = await runCmd(config, box(), { action: "get", positionals: ["refine.maxCostRise"] });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /refine\.maxCostRise is not set/);
  });

  test("views save hints the is:flagged filter, not the word flagged", async () => {
    for (const flags of [{}, { where: "" }, { where: "  " }]) {
      const r = await runCmd(views, box(), { action: "save", positionals: ["v1"], flags });
      assert.ok(r.error instanceof UsageError, String(r.error));
      assert.match(r.error.message, /'is:flagged agent:codex'/);
    }
  });

  test("review create with a missing config names that config in the next step", async () => {
    const sb = box();
    const r = await runCmd(review, sb, { action: "create", positionals: ["q"], flags: { where: "since:7d", config: "helpfulness" } });
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.deepEqual(r.error.next, ["Add a config, e.g.:", "coding.sh score config helpfulness --type boolean"]);
  });
});
