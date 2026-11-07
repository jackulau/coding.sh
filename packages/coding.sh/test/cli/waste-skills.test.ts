// The real Claude Code capture (test/fixtures/adapters/claude-code/real, from
// scripts/e2e/claude-transcript-capture.mjs) through the CLI: `show` reports
// re-fetches, cache breaks and skills, `usage` totals the waste, and
// `sessions --flag skill:<name>` filters on the skill tags; the MCP session_get
// digest and usage tool carry the same.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { usage } from "../../src/mcp/data.ts";
import { sessionDigest } from "../../src/mcp/digest.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { collect, testCtx, tmpEnv } from "../adapters/_helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../fixtures/adapters/claude-code/real/config", import.meta.url));
const SID = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";
let root = "";
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r;
};
const cli = (...args: string[]) => run(...args).stdout;

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-waste-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: CONFIG,
    CODEX_HOME: join(root, "codex"),
    T3CODE_HOME: join(root, "t3"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TZ: "UTC",
  };
  cli("ingest", "--backfill", "--agent", "claude-code");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("waste and skills in the CLI", () => {
  test("show: re-fetches, cache breaks by cause, skills, and harness loads in the timeline", () => {
    const text = cli("show", SID);
    assert.match(text, /Re-fetches\s+1 of 5 read-only calls repeated with the same result/);
    assert.match(text, /Cache breaks\s+2: \S+ prompt tokens billed again, \$0\.1086 extra \(other 1, compaction 1\)/);
    assert.match(text, /Skills\s+greet \(project, invoked, ran, first\) · hello \(personal, read\)/);
    assert.match(text, /harness\s+loaded \/work\/demo\/sub\/CLAUDE\.md/);
    assert.match(text, /harness\s+skills restored: greet/);
  });

  test("show --json: the stats and the skill rollup", () => {
    const j = JSON.parse(cli("show", SID, "--json")) as { session: { stats: Record<string, { count?: number; duplicateFetches?: number }> }; skills: { name: string; scope: string; via: string[] }[] };
    assert.equal(j.session.stats.waste?.duplicateFetches, 1);
    assert.equal(j.session.stats.cacheBreaks?.count, 2);
    assert.deepEqual(
      j.skills.map((s) => [s.name, s.scope, s.via]),
      [
        ["greet", "project", ["invoke", "run"]],
        ["hello", "personal", ["read"]],
      ],
    );
  });

  test("usage totals the waste; sessions --flag skill:<name> filters on skill tags", () => {
    const u = JSON.parse(cli("usage", "--since", "2026-11-01", "--json")) as { total: Record<string, number> };
    assert.deepEqual([u.total.duplicateFetches, u.total.cacheBreaks, u.total.cacheBreakTokens, u.total.cacheBreakUsd], [1, 2, 31_480, 0.1086]);
    // Notes go to stderr.
    assert.match(run("usage", "--since", "2026-11-01").stderr, /Cache breaks: 2, 31\.5k prompt tokens billed again \(~\$0\.1086 extra\)/);
    const ids = (flag: string) => (JSON.parse(cli("sessions", "--flag", flag, "--since", "2026-11-01", "--json")) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    assert.deepEqual(ids("skill:greet"), [SID]);
    assert.deepEqual(ids("skill:pdf"), []);
  });
});

describe("waste and skills over MCP", () => {
  test("session_get's digest has the waste stats and the skills; usage the totals", async () => {
    const restore = tmpEnv();
    process.env.CLAUDE_CONFIG_DIR = CONFIG;
    try {
      const events = await collect(claudeCode.backfill!(testCtx().ctx));
      const index = new MemoryIndexStore();
      await index.putEvents(events);
      const s = buildSession(events);
      await index.upsertSession(s);
      const d = await sessionDigest(index, s, { limit: 5, offset: 0, from: "head", now: s.startedAt });
      const summary = d.session as { waste?: { duplicateFetches: number }; cacheBreaks?: { count: number; byCause: Record<string, unknown> } };
      assert.equal(summary.waste?.duplicateFetches, 1);
      assert.deepEqual([summary.cacheBreaks?.count, Object.keys(summary.cacheBreaks?.byCause ?? {})], [2, ["other", "compaction"]]);
      assert.deepEqual(
        (d.skills as { name: string }[]).map((x) => x.name),
        ["greet", "hello"],
      );
      const u = (await usage(index, { since: 0, topLevel: false }, "agent", 5)) as { total: Record<string, number>; notes: string[] };
      assert.equal(u.total.cacheBreaks, 2);
      assert.ok(u.notes.some((n) => n.startsWith("2 prompt-cache breaks billed 31480 prompt tokens again")));
    } finally {
      restore.restore();
    }
  });
});
