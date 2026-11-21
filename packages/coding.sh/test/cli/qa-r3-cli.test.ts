// Regression tests for the third hands-on QA round on the CLI: float noise in --json, a
// misspelled --agent, typo suggestions for prefixes and shell habits, the printed MCP register
// command on Windows paths, and a statusline fed endless stdin.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { suggest } from "../../src/cli/args.ts";
import { commandArg } from "../../src/cli/commands/mcp.ts";
import * as sessions from "../../src/cli/commands/sessions.ts";
import { readStdin } from "../../src/cli/commands/statusline.ts";
import * as usage from "../../src/cli/commands/usage.ts";
import { tidyNumbers } from "../../src/cli/common.ts";
import { CLI } from "../_cli.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

describe("--json numbers", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([
      mkSession("noisy", Date.now() - 60_000, {
        stats: { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0041400000000000005, estimatedCostUsd: 0.0041400000000000005 }, latency: { wallMs: 30961.360107421875 } } as never,
      }),
    ]);
  });
  after(() => sb.cleanup());

  test("sessions --json rounds costs and durations", async () => {
    const r = await runCmd(sessions, sb, { json: true });
    const s = r.json.sessions[0];
    assert.equal(s.stats.usage.costUsd, 0.00414);
    assert.equal(s.stats.usage.estimatedCostUsd, 0.00414);
    assert.equal(s.stats.latency.wallMs, 30961);
    assert.equal(s.stats.usage.inputTokens, 10, "other numbers stay as they are");
  });

  test("tidyNumbers leaves integers, non-cost floats and strings alone", () => {
    assert.deepEqual(tidyNumbers({ costUsd: 0.1 + 0.2, waitMs: 1.6, ratio: 0.1 + 0.2, n: 3, s: "x" }), { costUsd: 0.3, waitMs: 2, ratio: 0.1 + 0.2, n: 3, s: "x" });
    // Maps of costs by name hold dollars under every key.
    assert.deepEqual(tidyNumbers({ estimatedCostByTokenType: { cacheRead: 0.1 + 0.2, output: 0.075 }, estimatedCostByTier: { batch: 0.1 + 0.2 } }), { estimatedCostByTokenType: { cacheRead: 0.3, output: 0.075 }, estimatedCostByTier: { batch: 0.3 } });
  });
});

describe("a misspelled --agent", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession("s1", Date.now() - 60_000), mkSession("sdk1", Date.now() - 60_000, { agent: "my-sdk-bot" as never })]);
  });
  after(() => sb.cleanup());

  test("sessions rejects it and names the agent it meant", async () => {
    const r = await runCmd(sessions, sb, { flags: { agent: "claud-code" } });
    assert.equal(r.error?.name, "UsageError");
    assert.match(r.error.message, /Unknown agent "claud-code"/);
    assert.equal(r.error.suggestion, "--agent claude-code");
  });

  test("usage rejects it too, in --json as well", async () => {
    const r = await runCmd(usage, sb, { flags: { agent: "claud-code" }, json: true });
    assert.equal(r.error?.suggestion, "--agent claude-code");
  });

  test("an agent id far from every adapter (an SDK agent) still filters to an empty list", async () => {
    const r = await runCmd(sessions, sb, { flags: { agent: "nothing-like-this" } });
    assert.equal(r.error, undefined);
    assert.match(r.stdout + r.stderr, /No sessions/);
  });

  test("usage for an agent with no session points at every agent, not a wider window", async () => {
    const r = await runCmd(usage, sb, { flags: { agent: "nothing-like-this" } });
    assert.equal(r.error, undefined);
    const text = r.stdout + r.stderr;
    assert.match(text, /No sessions from nothing-like-this/);
    assert.doesNotMatch(text, /--since 90d/);
  });
});

describe("typo suggestions", () => {
  test("an unambiguous prefix suggests the whole name", () => {
    assert.equal(suggest("dry", ["dry-run", "json", "older-than"]), "dry-run");
    assert.equal(suggest("dr", ["dry-run", "json"]), undefined, "too short to be a prefix guess");
    assert.equal(suggest("re", ["repo", "reprice"]), undefined);
    assert.equal(suggest("rep", ["repo", "reprice"]), "repo", "edit distance comes first");
  });
  test("shell habits map to the command", () => {
    assert.equal(suggest("ls", ["list", "show", "new"]), "list");
    assert.equal(suggest("rm", ["list", "delete"]), "delete");
    assert.equal(suggest("ls", ["show", "new"]), undefined);
  });
  test("end to end: gc --dry and exp ls", () => {
    const sb = sandbox();
    try {
      const gc = spawnSync(process.execPath, ["--no-warnings", CLI, "gc", "--dry"], { env: sb.env, encoding: "utf8" });
      assert.equal(gc.status, 2);
      assert.match(gc.stderr, /--dry-run/);
      const exp = spawnSync(process.execPath, ["--no-warnings", CLI, "exp", "ls"], { env: sb.env, encoding: "utf8" });
      assert.equal(exp.status, 2);
      assert.match(exp.stderr, /exp list/);
    } finally {
      sb.cleanup();
    }
  });
});

describe("mcp config register command", () => {
  test("Windows paths take forward slashes, and spaces take double quotes", () => {
    assert.equal(commandArg("C:\\Program Files\\nodejs\\node.exe"), '"C:/Program Files/nodejs/node.exe"');
    assert.equal(commandArg("C:\\Users\\me\\.t3\\dist\\cli.mjs"), "C:/Users/me/.t3/dist/cli.mjs");
    assert.equal(commandArg("\\\\server\\share\\cli.mjs"), "//server/share/cli.mjs");
    assert.equal(commandArg("mcp"), "mcp");
    assert.equal(commandArg("/home/o'brien/cli.mjs"), "\"/home/o'brien/cli.mjs\"");
    assert.equal(commandArg("/opt/$x/cli.mjs"), "'/opt/$x/cli.mjs'");
  });

  test("a POSIX shell reads each argument back whole", { skip: spawnSync("sh", ["-c", "true"]).status !== 0 && "no sh on PATH" }, () => {
    const args = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\me\\dist\\cli.mjs", "mcp"];
    const r = spawnSync("sh", ["-c", `for a in ${args.map(commandArg).join(" ")}; do printf '%s\\n' "$a"; done`], { encoding: "utf8" });
    assert.deepEqual(r.stdout.trim().split("\n"), ["C:/Program Files/nodejs/node.exe", "C:/Users/me/dist/cli.mjs", "mcp"]);
  });
});

describe("statusline stdin", () => {
  test("endless input stops at the cap instead of filling memory", async () => {
    const s = new PassThrough();
    const feed = setInterval(() => s.write(Buffer.alloc(64 * 1024)), 1);
    try {
      assert.equal(await readStdin(new AbortController().signal, s, 256 * 1024), "");
    } finally {
      clearInterval(feed);
    }
  });

  test("Ctrl-C while waiting for input ends the read", async () => {
    const s = new PassThrough();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    assert.equal(await readStdin(ac.signal, s), undefined);
  });

  test("a whole payload reads as before", async () => {
    const s = new PassThrough();
    s.end('{"session_id":"x"}');
    assert.equal(await readStdin(new AbortController().signal, s), '{"session_id":"x"}');
  });

  test("the CLI prints its fallback line when stdin never ends", async () => {
    const sb = sandbox();
    try {
      const child = spawn(process.execPath, ["--no-warnings", CLI, "statusline"], { env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stdin.on("error", () => {}); // EPIPE once it stops reading
      const chunk = Buffer.alloc(256 * 1024);
      const feed = setInterval(() => child.stdin.writable && child.stdin.write(chunk), 5);
      const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      clearInterval(feed);
      clearTimeout(killer);
      assert.equal(code, 0, "exits on its own, before the 20 s kill");
      assert.match(stdout, /\$/, "prints the status line");
    } finally {
      sb.cleanup();
    }
  });
});
