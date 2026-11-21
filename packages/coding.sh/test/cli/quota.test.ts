// `coding.sh quota`, `quota wait` and the plan usage part of `coding.sh statusline`, run as the CLI.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { run } from "../../src/cli/commands/quota.ts";
import { Output } from "../../src/cli/output.ts";
import { statuslineLine } from "../../src/cli/statusline.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { CLI } from "../_cli.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-quota-cli-")));
  roots.push(root);
  return { HOME: root, USERPROFILE: root, CODING_SH_HOME: join(root, "csh"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), PATH: dirname(process.execPath), NO_COLOR: "1", TZ: "UTC" };
}

const cli = (args: string[], env: NodeJS.ProcessEnv, input?: string) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, input, encoding: "utf8", timeout: 30_000 });

function codexRollout(env: NodeJS.ProcessEnv, primary: unknown, secondary: unknown): void {
  const dir = join(env.CODEX_HOME!, "sessions", "2026", "11", "20");
  mkdirSync(dir, { recursive: true });
  const line = (ts: string, p: unknown, s: unknown) =>
    JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "codex", limit_name: null, primary: p, secondary: s, credits: null, plan_type: "plus" } } });
  writeFileSync(
    join(dir, "rollout-2026-11-20T10-00-00-01a1b9fe-432d-7523-b54c-549334a74440.jsonl"),
    ['{"timestamp":"2026-11-20T10:00:00.000Z","type":"session_meta","payload":{"id":"01a1b9fe-432d-7523-b54c-549334a74440","cwd":"/work/demo"}}', line("2026-11-20T10:00:01.000Z", null, null), line("2026-11-20T10:00:02.000Z", primary, secondary)].join("\n") + "\n",
  );
}

function claudeQuota(env: NodeJS.ProcessEnv, windows: { window: string; usedPercent: number; resetsAt?: number }[]): void {
  mkdirSync(env.CODING_SH_HOME!, { recursive: true });
  writeFileSync(join(env.CODING_SH_HOME!, "quota.json"), JSON.stringify({ agent: "claude-code", readAt: Date.now(), windows }));
}

describe("statusline plan usage", () => {
  test("rate_limits on stdin adds `5h 62%` and saves the reading", () => {
    const env = home();
    const r = cli(["statusline"], env, '{"session_id":"x","rate_limits":{"five_hour":{"used_percentage":62,"resets_at":1790000000}}}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${statuslineLine({ todayCostUsd: 0 })}  ·  5h 62%`);
    const saved = JSON.parse(readFileSync(join(env.CODING_SH_HOME!, "quota.json"), "utf8"));
    assert.deepEqual(saved.windows, [{ window: "5h", usedPercent: 62, resetsAt: 1790000000_000 }]);
    const q = JSON.parse(cli(["quota", "--json"], env).stdout);
    assert.deepEqual(q.windows.map((w: { agent: string; window: string; usedPercent: number }) => `${w.agent} ${w.window} ${w.usedPercent}`), ["claude-code 5h 62"]);
  });

  test("both windows, and --json carries them", () => {
    const env = home();
    const payload = '{"session_id":"x","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":62,"resets_at":1790000000},"seven_day":{"used_percentage":41.2,"resets_at":1790500000}}}';
    assert.match(cli(["statusline"], env, payload).stdout, /^Opus .* today {2}· {2}5h 62% 7d 41%\n$/);
    const j = JSON.parse(cli(["statusline", "--json"], env, payload).stdout);
    assert.deepEqual(j.quota, [
      { window: "5h", usedPercent: 62, resetsAt: new Date(1790000000_000).toISOString() },
      { window: "7d", usedPercent: 41.2, resetsAt: new Date(1790500000_000).toISOString() },
    ]);
  });

  test("without rate_limits the line is what it was, and nothing is saved", () => {
    const env = home();
    const r = cli(["statusline"], env, '{"session_id":"x","model":{"display_name":"Opus"}}');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, statuslineLine({ model: "Opus", todayCostUsd: 0 }) + "\n");
    assert.ok(!existsSync(join(env.CODING_SH_HOME!, "quota.json")));
    assert.equal(JSON.parse(cli(["statusline", "--json"], env, '{"session_id":"x"}').stdout).quota, undefined);
  });
});

describe("coding.sh quota", () => {
  test("--json over a Codex rollout lists codex 5h and 7d", () => {
    const env = home();
    codexRollout(env, { used_percent: 62, window_minutes: 300, resets_at: 1790000000 }, { used_percent: 41, window_minutes: 10080, resets_at: 1790500000 });
    const r = cli(["quota", "--json"], env);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(
      j.windows.map((w: Record<string, unknown>) => [w.agent, w.window, w.usedPercent, w.resetsAt, w.readAt]),
      [
        ["codex", "5h", 62, new Date(1790000000_000).toISOString(), "2026-11-20T10:00:02.000Z"],
        ["codex", "7d", 41, new Date(1790500000_000).toISOString(), "2026-11-20T10:00:02.000Z"],
      ],
    );
    assert.deepEqual(j.missing.map((m: { agent: string }) => m.agent), ["claude-code"]);
    const t = cli(["quota"], env);
    assert.match(t.stdout, /^AGENT\tWINDOW\tUSED\tRESETS\tREAD\ncodex\t5h\t62%\t/);
    assert.match(t.stderr, /claude-code: no reading\. .*coding\.sh statusline install/);
  });

  test("with no reading it says which agent sends it and how", () => {
    const env = home();
    const r = cli(["quota"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /claude-code: no reading\..*status line/);
    assert.match(r.stderr, /codex: no reading\..*rollouts under CODEX_HOME\/sessions/);
  });
});

describe("coding.sh quota wait", () => {
  test("a reset 2 s ahead: exits 0 once it passes", () => {
    const env = home();
    const t0 = Date.now();
    claudeQuota(env, [{ window: "5h", usedPercent: 95, resetsAt: t0 + 2000 }]);
    const r = cli(["quota", "wait"], env);
    const took = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Waiting for claude-code 5h at 95% to drop below 90% or reset at/);
    assert.ok(took >= 1900 && took < 5000, `took ${took} ms`);
  });

  test("room already: exits 0 at once; --below is the threshold", () => {
    const env = home();
    claudeQuota(env, [{ window: "5h", usedPercent: 50 }, { window: "7d", usedPercent: 95, resetsAt: Date.now() + 86400e3 }]);
    assert.equal(cli(["quota", "wait", "--window", "5h"], env).status, 0);
    assert.equal(cli(["quota", "wait", "--window", "7d", "--below", "96"], env).status, 0);
  });

  test("--window spend waits on the spend limit; its row shows the amounts", () => {
    const env = home();
    claudeQuota(env, [{ window: "5h", usedPercent: 95, resetsAt: Date.now() + 86400e3 }, { window: "spend", usedPercent: 40 }]);
    const r = cli(["quota", "wait", "--window", "spend", "--json"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).windows.map((w: { window: string }) => w.window), ["spend"]);
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });
    writeFileSync(join(env.CODING_SH_HOME!, "quota.json"), JSON.stringify({ agent: "claude-code", readAt: Date.now(), windows: [{ window: "spend", usedPercent: 63, usedUsd: 31.5, limitUsd: 50, period: "month" }] }));
    assert.match(cli(["quota"], env).stdout, /claude-code\s+spend\s+63% \(\$31\.50 of \$50\.00\)/);
  });

  test("no reading: exit 1; a bad flag: exit 2", () => {
    const env = home();
    const r = cli(["quota", "wait", "--agent", "codex"], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No plan usage reading for codex/);
    assert.equal(cli(["quota", "wait", "--window", "3h"], env).status, 2);
    assert.equal(cli(["quota", "wait", "--below", "0"], env).status, 2);
    assert.equal(cli(["quota", "wait", "--agent", "cursor"], env).status, 2);
  });

  test("Ctrl-C while waiting: 130", async () => {
    const env = home();
    claudeQuota(env, [{ window: "7d", usedPercent: 99, resetsAt: Date.now() + 86400e3 }]);
    const ac = new AbortController();
    const err: string[] = [];
    const out = new Output({ json: false, env, stdout: { write: () => true, isTTY: false }, stderr: { write: (s: string) => (err.push(s), true), isTTY: false }, stdin: { isTTY: false } });
    const c: CommandContext = { action: "wait", flags: {}, positionals: [], rest: [], out, env, cwd: env.HOME!, debug: false, signal: ac.signal };
    const p = run(c);
    setTimeout(() => ac.abort(), 100);
    assert.equal(await p, 130);
    assert.equal(err.filter((l) => /Waiting for/.test(l)).length, 1, "one line says what it waits for");
  });

  test("a Codex window with no reset time: the CLI keeps waiting and says what for", async () => {
    const env = home();
    codexRollout(env, { used_percent: 95, window_minutes: 300 }, null);
    const child = spawn(process.execPath, ["--no-warnings", CLI, "quota", "wait", "--agent", "codex"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    try {
      const deadline = Date.now() + 20_000;
      while (!/Waiting for codex 5h at 95% to drop below 90%\n/.test(stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.match(stderr, /Waiting for codex 5h at 95% to drop below 90%\n/);
      assert.equal(child.exitCode, null, "still waiting");
    } finally {
      const closed = new Promise((r) => child.once("close", r));
      child.kill();
      await closed;
    }
  });
});
