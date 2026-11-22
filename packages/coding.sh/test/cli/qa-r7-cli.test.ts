// Hands-on QA, round 7: doctor counts the sessions tagged by the gateway it says an agent routes
// through, gateway status puts where a route is set on its row, --json sessions name a worktree's
// main checkout (repoMain), the status line creates no store, quota wait says why it did not wait,
// and exp ab / refine diagnose take --provider gemini.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import * as doctor from "../../src/cli/commands/doctor.ts";
import { abOptions, continuationTask, trialSetup } from "../../src/cli/commands/exp-ab.ts";
import * as gateway from "../../src/cli/commands/gateway.ts";
import { diagnoseProvider } from "../../src/cli/commands/refine-diagnose.ts";
import * as sessions from "../../src/cli/commands/sessions.ts";
import * as show from "../../src/cli/commands/show.ts";
import { UsageError } from "../../src/cli/args.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import type { Session } from "../../src/core/types.ts";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_BASE } from "../../src/graders/index.ts";
import { CLI } from "../_cli.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));
/** A sandbox whose PATH holds only node: no agent CLI on it is ever run. */
function box(extra: NodeJS.ProcessEnv = {}): Sandbox {
  const sb = sandbox({ PATH: dirname(process.execPath), ...extra });
  boxes.push(sb);
  return sb;
}

const T0 = Date.parse("2026-11-20T10:00:00Z");
function session(id: string, over: Partial<Session> = {}): Session {
  return { id, agent: "claude-code", startedAt: T0, endedAt: T0 + 60_000, title: `session ${id}`, stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [], ...over };
}

const cli = (sb: Sandbox, args: string[], input?: string) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...sb.env, TZ: "UTC" }, cwd: sb.env.HOME, encoding: "utf8", timeout: 60_000, input });

describe("gateway tagged sessions", () => {
  const proxied = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" };

  test("doctor counts the sessions tagged by the gateway an agent routes through", async () => {
    const sb = box(proxied);
    await sb.seed([session("gw-1", { flags: ["gateway:cliproxyapi"] }), session("plain-1")]);
    const r = await runCmd(doctor, sb, { json: true });
    const gw = r.json.gateway;
    assert.equal(gw.configured[0].gateway, "cliproxyapi");
    assert.ok(gw.counted.includes("cliproxyapi"), JSON.stringify(gw.counted));
    assert.equal(gw.sessions, 1);
    const text = await runCmd(doctor, sb);
    assert.match(text.stdout, /AI Gateway\s+routes claude-code via cliproxyapi, no key, 1 tagged sessions/);
  });

  test("gateway status puts where the route is set on the agent's row", async () => {
    const sb = box(proxied);
    await sb.seed([session("gw-1", { flags: ["gateway:cliproxyapi"] })]);
    const r = await runCmd(gateway, sb, { action: "status" });
    const lines = r.stderr.split("\n");
    const row = lines.find((l) => l.includes("claude-code") && l.includes("CLIProxyAPI"));
    assert.ok(row, r.stderr);
    assert.match(row, /ANTHROPIC_BASE_URL → 127\.0\.0\.1 \(env\)$/);
    assert.ok(!lines.some((l) => l.trim() === "env"), r.stderr);
  });
});

describe("--json sessions in a linked worktree", () => {
  const main = join("/work", "demo");
  const wt = join("/work", "demo-wt");
  const seed = (sb: Sandbox) =>
    sb.seed([
      session("wt-1", { cwd: wt, repo: { root: wt, head: "abc123", branch: "demo-wt", main } }),
      session("main-1", { cwd: main, repo: { root: main, head: "abc123", branch: "main" } }),
    ]);

  test("show --json has repoMain for the worktree's session and none for the main checkout's", async () => {
    const sb = box();
    await seed(sb);
    const wtDoc = (await runCmd(show, sb, { positionals: ["wt-1"], json: true })).json;
    assert.equal(wtDoc.session.repo, wt);
    assert.equal(wtDoc.session.repoMain, main);
    const mainDoc = (await runCmd(show, sb, { positionals: ["main-1"], json: true })).json;
    assert.equal(mainDoc.session.repo, main);
    assert.ok(!("repoMain" in mainDoc.session));
  });

  test("sessions --json has it too, and --fields picks it", async () => {
    const sb = box();
    await seed(sb);
    const all = (await runCmd(sessions, sb, { json: true })).json.sessions as Record<string, unknown>[];
    assert.equal(all.find((s) => s.id === "wt-1")?.repoMain, main);
    assert.ok(!("repoMain" in all.find((s) => s.id === "main-1")!));
    const picked = (await runCmd(sessions, sb, { json: true, flags: { fields: ["id", "repoMain"] } })).json.sessions as Record<string, unknown>[];
    assert.deepEqual(picked.find((s) => s.id === "wt-1"), { id: "wt-1", repoMain: main });
  });
});

describe("status line before the first capture", () => {
  test("prints the model and $0 today, and creates no store", () => {
    const sb = box();
    const r = cli(sb, ["statusline"], '{"session_id":"x","model":{"display_name":"Opus 5.5"}}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "Opus 5.5  ·  $0.0000 today");
    assert.equal(existsSync(join(sb.env.CODING_SH_HOME!, "index.db")), false);
  });
});

describe("quota wait with room already", () => {
  test("says on stderr which window it checked and why it did not wait", () => {
    const sb = box();
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(sb.env.CODING_SH_HOME!, "quota.json"), JSON.stringify({ agent: "claude-code", readAt: Date.now(), windows: [{ window: "spend", usedPercent: 63, usedUsd: 31.5, limitUsd: 50, period: "month" }] }));
    const r = cli(sb, ["quota", "wait", "--window", "spend"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /claude-code spend at 63%, under 90%/);
  });
});

describe("--provider gemini", () => {
  function ctx(flags: Record<string, string>): CommandContext {
    const sink = { write: (_s: string) => true, isTTY: false };
    return { flags, positionals: [], rest: [], out: new Output({ json: false, env: {}, stdout: sink, stderr: sink, stdin: { isTTY: false } }), env: {}, cwd: "/work/demo", debug: false, signal: new AbortController().signal };
  }

  test("exp ab replays through Google's OpenAI-compatible endpoint with GEMINI_API_KEY", () => {
    const o = abOptions(ctx({ provider: "gemini" }), "/work/demo");
    assert.equal(o.provider, "openai-compatible");
    assert.equal(o.baseURL, GEMINI_API_BASE);
    assert.equal(o.apiKeyEnv, "GEMINI_API_KEY");
    assert.equal(o.model, DEFAULT_GEMINI_MODEL);
    const t = trialSetup(o, [], {});
    assert.equal(t.judge.apiKeyEnv, "GEMINI_API_KEY");
    assert.equal(t.judge.baseURL, GEMINI_API_BASE);
    const task = continuationTask(t, { label: "a", files: [], watch: [] });
    assert.equal(task.apiKeyEnv, "GEMINI_API_KEY");
    assert.equal(task.baseURL, GEMINI_API_BASE);
    assert.equal(task.model, DEFAULT_GEMINI_MODEL);
  });

  test("exp ab and refine diagnose list gemini in their help", () => {
    const sb = box();
    for (const args of [["exp", "ab", "--help"], ["refine", "diagnose", "--help"]]) {
      const r = cli(sb, args);
      const line = r.stdout.split("\n").find((l) => l.includes("--provider"));
      assert.ok(line && /\bgemini\b/.test(line), `${args.join(" ")}: ${line}`);
    }
  });

  test("refine diagnose takes gemini and suggests it for a typo, never an unrelated provider", () => {
    assert.equal(diagnoseProvider({ provider: "gemini" }, {}), "gemini");
    const typo = (p: string) => {
      try {
        diagnoseProvider({ provider: p }, {});
      } catch (e) {
        assert.ok(e instanceof UsageError);
        return e.suggestion;
      }
      assert.fail(`--provider ${p} was taken`);
    };
    assert.equal(typo("gemnii"), "coding.sh refine diagnose --provider gemini");
    assert.equal(typo("zzzzzzzz"), undefined);
  });
});
