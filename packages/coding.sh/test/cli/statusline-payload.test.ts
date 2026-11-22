// `coding.sh statusline` run as the CLI on Claude Code's stdin payload: the context fill
// (`ctx 62%`), the spend limit (`spend 63%`), a stdin that never closes, the session part only
// for a session the store knows, and no number in --json with more than 4 decimals.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import * as budget from "../../src/cli/commands/budget.ts";
import { STATUSLINE_STDIN_MS } from "../../src/cli/commands/statusline.ts";
import { markIngestStopped } from "../../src/core/ingest-health.ts";
import { CLI } from "../_cli.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const boxes: Sandbox[] = [];
after(() => {
  for (const b of boxes) b.cleanup();
});
const box = () => {
  const b = sandbox();
  boxes.push(b);
  return b;
};

const line = (b: Sandbox, payload: unknown, ...args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, "statusline", ...args], { env: b.env, input: JSON.stringify(payload), encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** Every number in a JSON document that has more than 4 decimals, with its path. */
function longFloats(v: unknown, path = "$"): string[] {
  if (typeof v === "number") return Math.round(v * 1e4) / 1e4 === v ? [] : [`${path}=${v}`];
  if (Array.isArray(v)) return v.flatMap((x, i) => longFloats(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => longFloats(x, `${path}.${k}`));
  return [];
}

describe("statusline context fill", () => {
  test("used_percentage 62 prints ctx 62% after the model; --json has contextPercent", () => {
    const b = box();
    const payload = { session_id: "x", model: { display_name: "Opus" }, context_window: { used_percentage: 62 } };
    assert.match(line(b, payload), /^Opus {2}· {2}ctx 62% {2}· {2}\$0\.0000 today\n$/);
    assert.equal(JSON.parse(line(b, payload, "--json")).contextPercent, 62);
  });

  test("87 prints ctx 87% full; no context_window, no ctx and no contextPercent", () => {
    const b = box();
    assert.match(line(b, { context_window: { used_percentage: 87 } }), /ctx 87% full/);
    assert.match(line(b, { context_window: { used_percentage: 84 } }), /ctx 84%(?! full)/);
    assert.doesNotMatch(line(b, { model: { display_name: "Opus" } }), /ctx/);
    assert.doesNotMatch(line(b, { context_window: { used_percentage: 140 } }), /ctx/, "out of range is no reading");
    assert.doesNotMatch(line(b, { context_window: { used_percentage: "62" } }), /ctx/);
    assert.equal("contextPercent" in JSON.parse(line(b, { session_id: "x" }, "--json")), false);
  });

  test("a store that can't be opened: the stopped-ingest line shows ctx too", () => {
    const b = box();
    mkdirSync(join(b.env.CODING_SH_HOME!, "index.db"), { recursive: true }); // a folder where the index should be
    markIngestStopped(join(b.env.CODING_SH_HOME!, "ingest-stopped.json"), { reason: "store_unreadable", why: "the index can't be opened", version: "0.0.0" });
    const payload = { model: { display_name: "Opus" }, context_window: { used_percentage: 91 } };
    assert.match(line(b, payload), /^Opus {2}· {2}ctx 91% full {2}· {2}! ingest stopped /);
    const j = JSON.parse(line(b, payload, "--json"));
    assert.equal(j.contextPercent, 91);
    assert.ok(j.ingestStopped);
    assert.equal(j.todayCostUsd, null, "the catch path printed");
  });
});

describe("statusline spend limit", () => {
  test("spend_limit prints spend 63% after 5h and 7d; quota --json lists a spend row", () => {
    const b = box();
    const payload = {
      session_id: "x",
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 1790000000 },
        seven_day: { used_percentage: 41 },
        spend_limit: { used_percentage: 63, resets_at: 1792000000, used_usd: 31.5, limit_usd: 50, period: "month" },
      },
    };
    assert.match(line(b, payload), / {2}· {2}5h 12% 7d 41% spend 63%\n$/);
    const j = JSON.parse(line(b, payload, "--json"));
    assert.deepEqual(j.quota[2], { window: "spend", usedPercent: 63, resetsAt: new Date(1792000000_000).toISOString(), usedUsd: 31.5, limitUsd: 50, period: "month" });
    const q = spawnSync(process.execPath, ["--no-warnings", CLI, "quota", "--json"], { env: b.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(q.status, 0, q.stderr);
    const spend = JSON.parse(q.stdout).windows.find((w: { window: string }) => w.window === "spend");
    assert.equal(spend.agent, "claude-code");
    assert.equal(spend.usedPercent, 63);
    assert.equal(spend.usedUsd, 31.5);
    assert.equal(spend.limitUsd, 50);
    assert.equal(spend.period, "month");
  });

  test("over the limit: spend 112%", () => {
    assert.match(line(box(), { rate_limits: { spend_limit: { used_percentage: 112 } } }), /spend 112%\n$/);
  });
});

describe("statusline session part", () => {
  test("an unknown session_id prints no session part; a known session that cost $0 does", async () => {
    const b = box();
    await b.seed([mkSession("known", Date.now() - 60_000, { stats: { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } })]);
    const unknown = line(b, { session_id: "nope", model: { display_name: "Opus" } });
    assert.doesNotMatch(unknown, /session/);
    assert.equal(unknown, "Opus  ·  $0.0000 today\n");
    assert.equal(JSON.parse(line(b, { session_id: "nope" }, "--json")).sessionCostUsd, null);
    assert.equal(line(b, { session_id: "known", model: { display_name: "Opus" } }), "Opus  ·  $0.0000 session  ·  $0.0000 today\n");
    assert.equal(JSON.parse(line(b, { session_id: "known" }, "--json")).sessionCostUsd, 0);
  });
});

describe("statusline and quota --json numbers", () => {
  test("no number has more than 4 decimals", async () => {
    const b = box();
    const priced = (id: string, costUsd: number) => mkSession(id, Date.now() - 60_000, { stats: { usage: { inputTokens: 1000, outputTokens: 100, costUsd, estimatedCostUsd: costUsd } } });
    await b.seed([priced("a", 0.1), priced("b", 0.2), priced("c", 0.123456789)]);
    await runCmd(budget, b, { action: "set", positionals: ["day", "0.5"] }); // 0.423... of 0.5: past 80%, so the part shows
    const payload = {
      session_id: "c",
      context_window: { used_percentage: 62.123456789 },
      rate_limits: {
        five_hour: { used_percentage: 23.456789123, resets_at: 1790000000 },
        spend_limit: { used_percentage: 63.123456789, used_usd: 31.561234567, limit_usd: 50.000001234, period: "month" },
      },
    };
    const j = JSON.parse(line(b, payload, "--json"));
    assert.ok(j.budget, "the budget part is there");
    assert.equal(j.sessionCostUsd, 0.1235);
    assert.equal(j.todayCostUsd, 0.4235);
    assert.deepEqual(longFloats(j), []);
    const q = spawnSync(process.execPath, ["--no-warnings", CLI, "quota", "--json"], { env: b.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(q.status, 0, q.stderr);
    const doc = JSON.parse(q.stdout);
    assert.equal(doc.windows.find((w: { window: string }) => w.window === "spend").usedUsd, 31.5612);
    assert.deepEqual(longFloats(doc), []);
  });
});

describe("statusline on a stdin that never closes", () => {
  /** Writes the payload and keeps stdin open; resolves with what the CLI printed once it exits by itself. */
  function openStdin(b: Sandbox, payload: unknown, args: string[]): Promise<{ code: number | null; stdout: string; ms: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", CLI, "statusline", ...args], { env: b.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let written = 0;
      child.stdout.on("data", (d) => (stdout += d));
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("statusline still waiting on an open stdin after 30 s"));
      }, 30_000);
      child.on("exit", (code) => {
        clearTimeout(kill);
        child.stdin.destroy();
        resolve({ code, stdout, ms: Date.now() - written });
      });
      child.stdin.on("error", () => {}); // the CLI closing its end
      child.stdin.write(JSON.stringify(payload) + "\n", () => (written = Date.now()));
    });
  }

  const payload = { session_id: "x", model: { display_name: "Opus" }, context_window: { used_percentage: 62 } };

  test("text: prints from what arrived and exits", async () => {
    const r = await openStdin(box(), payload, []);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Opus {2}· {2}ctx 62% {2}· {2}\$0\.0000 today\n$/);
    assert.ok(r.ms >= STATUSLINE_STDIN_MS - 100, `waited ${r.ms} ms for more input first`);
  });

  test("--json: prints from what arrived and exits", async () => {
    const r = await openStdin(box(), payload, ["--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.model, "Opus");
    assert.equal(j.contextPercent, 62);
  });
});
