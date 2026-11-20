// Plan usage readings (src/quota): Claude Code's status-line rate_limits, the saved quota.json,
// and the token_count rate_limits in the tail of Codex's newest rollouts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import {
  claudeRateLimits,
  codexRateLimits,
  hasRoom,
  newestRollouts,
  quotaJson,
  quotaPart,
  quotaReport,
  readClaudeQuota,
  readCodexQuota,
  ROLLOUT_TAIL_BYTES,
  saveClaudeQuota,
  windowLabel,
} from "../../src/quota/index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters", "codex");

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), "csh-quota-"));
  roots.push(r);
  return r;
}

/** A Codex token_count line, as rollouts write it (hand-written; the recorded fixtures carry null windows). */
function tokenCount(ts: string, primary: unknown, secondary: unknown): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 150 }, model_context_window: 258400 },
      rate_limits: { limit_id: "codex", limit_name: null, primary, secondary, credits: null, individual_limit: null, spend_control_reached: null, plan_type: "plus", rate_limit_reached_type: null },
    },
  });
}

function rollout(home: string, day: string, name: string, lines: string[]): string {
  const dir = join(home, "sessions", ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

describe("Claude Code rate_limits", () => {
  test("reads the 5-hour and 7-day windows, resets_at in epoch seconds", () => {
    const w = claudeRateLimits({ session_id: "x", rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } }, 1000);
    assert.deepEqual(w, [
      { agent: "claude-code", window: "5h", usedPercent: 23.5, resetsAt: 1738425600_000, readAt: 1000 },
      { agent: "claude-code", window: "7d", usedPercent: 41.2, resetsAt: 1738857600_000, readAt: 1000 },
    ]);
    assert.equal(quotaPart(w), "5h 24% 7d 41%");
  });
  test("only the windows there are; none without rate_limits", () => {
    const w = claudeRateLimits({ rate_limits: { five_hour: { used_percentage: 62, resets_at: 1790000000 } } });
    assert.equal(quotaPart(w), "5h 62%");
    assert.deepEqual(claudeRateLimits({ session_id: "x", model: { id: "m" } }), []);
    assert.deepEqual(claudeRateLimits({ rate_limits: { five_hour: { resets_at: 1 }, seven_day: null } }), []);
    assert.deepEqual(claudeRateLimits(null), []);
    assert.equal(quotaPart([]), "");
  });
  test("quota.json round-trips through a rename, leaving no temp file", () => {
    const dir = tmp();
    const file = join(dir, "csh", "quota.json"); // the folder does not exist yet
    const w = claudeRateLimits({ rate_limits: { five_hour: { used_percentage: 62, resets_at: 1790000000 }, seven_day: { used_percentage: 41 } } }, 5000);
    saveClaudeQuota(file, w);
    assert.deepEqual(readClaudeQuota(file), w);
    assert.deepEqual(readdirSync(join(dir, "csh")), ["quota.json"]);
    saveClaudeQuota(join(dir, "none.json"), []);
    assert.ok(!existsSync(join(dir, "none.json")), "no reading, no file");
    writeFileSync(file, "{not json");
    assert.deepEqual(readClaudeQuota(file), []);
  });
});

describe("Codex rate_limits", () => {
  test("window labels from window_minutes", () => {
    assert.equal(windowLabel(300), "5h");
    assert.equal(windowLabel(10080), "7d");
    assert.equal(windowLabel(90), "90m");
  });

  test("the last token_count with windows wins; null windows are no reading", () => {
    const text = [
      tokenCount("2026-11-20T10:00:00.000Z", { used_percent: 10, window_minutes: 300, resets_at: 1790000000 }, { used_percent: 5, window_minutes: 10080, resets_at: 1790500000 }),
      tokenCount("2026-11-20T10:05:00.000Z", { used_percent: 62, window_minutes: 300, resets_at: 1790000000 }, { used_percent: 41, window_minutes: 10080, resets_at: 1790500000 }),
      tokenCount("2026-11-20T10:06:00.000Z", null, null),
      '{"timestamp":"2026-11-20T10:07:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"prim', // cut mid-write
    ].join("\n");
    const at = Date.parse("2026-11-20T10:05:00.000Z");
    assert.deepEqual(codexRateLimits(text), [
      { agent: "codex", window: "5h", usedPercent: 62, resetsAt: 1790000000_000, readAt: at },
      { agent: "codex", window: "7d", usedPercent: 41, resetsAt: 1790500000_000, readAt: at },
    ]);
  });

  test("older Codex: resets_in_seconds counts from the event", () => {
    const [w] = codexRateLimits(tokenCount("2026-11-20T10:00:00.000Z", { used_percent: 3, window_minutes: 300, resets_in_seconds: 60 }, null));
    assert.equal(w!.resetsAt, Date.parse("2026-11-20T10:00:00.000Z") + 60_000);
  });

  test("the recorded fixtures (null windows) have no reading", () => {
    assert.deepEqual(readCodexQuota(join(FIXTURES, "skill")), []);
  });

  test("reads the newest rollout by mtime, from the two newest day folders only", () => {
    const home = tmp();
    const old = rollout(home, "2026/11/18", "a", [tokenCount("2026-11-18T10:00:00.000Z", { used_percent: 99, window_minutes: 300 }, null)]);
    const y = rollout(home, "2026/11/19", "b", [tokenCount("2026-11-19T10:00:00.000Z", { used_percent: 50, window_minutes: 300 }, null)]);
    const t = rollout(home, "2026/11/20", "c", [tokenCount("2026-11-20T10:00:00.000Z", { used_percent: 20, window_minutes: 300 }, null)]);
    mkdirSync(join(home, "sessions", "2026", "11", "21"), { recursive: true }); // empty: skipped
    const s = (ms: number) => new Date(ms);
    utimesSync(old, s(4e12), s(4e12)); // newest mtime, but a day folder past the two newest
    utimesSync(y, s(3e12), s(3e12)); // a session started yesterday, still writing
    utimesSync(t, s(2e12), s(2e12));
    assert.deepEqual(newestRollouts(home), [y, t]);
    assert.equal(readCodexQuota(home)[0]!.usedPercent, 50);
  });

  test("a newest rollout with no reading yet falls back to the next", () => {
    const home = tmp();
    const a = rollout(home, "2026/11/20", "a", [tokenCount("2026-11-20T09:00:00.000Z", { used_percent: 33, window_minutes: 300 }, { used_percent: 7, window_minutes: 10080 })]);
    const b = rollout(home, "2026/11/20", "b", ['{"timestamp":"2026-11-20T10:00:00.000Z","type":"session_meta","payload":{}}']);
    utimesSync(a, new Date(1e12), new Date(1e12));
    utimesSync(b, new Date(2e12), new Date(2e12));
    assert.deepEqual(readCodexQuota(home).map((w) => `${w.window} ${w.usedPercent}`), ["5h 33", "7d 7"]);
  });

  test("only the last 256 KB is read", () => {
    const home = tmp();
    const filler = '{"timestamp":"2026-11-20T10:00:01.000Z","type":"response_item","payload":{"type":"message","content":"' + "x".repeat(1000) + '"}}';
    const lines = [tokenCount("2026-11-20T10:00:00.000Z", { used_percent: 70, window_minutes: 300 }, null)];
    for (let n = 0; n * 1000 < ROLLOUT_TAIL_BYTES + 10_000; n++) lines.push(filler);
    rollout(home, "2026/11/20", "big", lines);
    assert.deepEqual(readCodexQuota(home), [], "a reading before the tail is not read");
    rollout(home, "2026/11/20", "big", [...lines, tokenCount("2026-11-20T10:09:00.000Z", { used_percent: 71, window_minutes: 300 }, null)]);
    assert.equal(readCodexQuota(home)[0]!.usedPercent, 71);
  });
});

describe("report", () => {
  test("rows per agent and window, and how to get a missing one", () => {
    const dir = tmp();
    const claudeFile = join(dir, "quota.json");
    saveClaudeQuota(claudeFile, claudeRateLimits({ rate_limits: { seven_day: { used_percentage: 41, resets_at: 2 }, five_hour: { used_percentage: 62, resets_at: 4_000_000_000 } } }, 1_000_000));
    const r = quotaReport({ claudeFile, codexHome: join(dir, "codex") });
    assert.deepEqual(r.windows.map((w) => `${w.agent} ${w.window}`), ["claude-code 5h", "claude-code 7d"]);
    assert.deepEqual(r.missing.map((m) => m.agent), ["codex"]);
    assert.match(r.missing[0]!.how, /CODEX_HOME\/sessions/);
    const j = quotaJson(r, 1_060_000);
    assert.deepEqual(j.windows[0], { agent: "claude-code", window: "5h", usedPercent: 62, resetsAt: new Date(4_000_000_000_000).toISOString(), reset: false, readAt: new Date(1_000_000).toISOString(), ageSeconds: 60 });
    assert.equal(j.windows[1]!.reset, true);
  });

  test("room: under the threshold, or the window has reset", () => {
    const w = { agent: "codex" as const, window: "5h", usedPercent: 95, resetsAt: 10_000, readAt: 0 };
    assert.equal(hasRoom(w, 90, 5_000), false);
    assert.equal(hasRoom(w, 96, 5_000), true);
    assert.equal(hasRoom(w, 90, 10_000), true);
    assert.equal(hasRoom({ ...w, resetsAt: undefined }, 90, 1e15), false);
  });
});
