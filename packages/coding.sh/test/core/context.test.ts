import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";

const root = mkdtempSync(join(tmpdir(), "csh-ctx-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("openContext", () => {
  it("opens stores from CODING_SH_HOME and closes once", async () => {
    const env = { CODING_SH_HOME: join(root, "home"), HOME: root };
    const ctx = await openContext({ env });
    assert.equal(ctx.paths.root, join(root, "home"));
    assert.equal(ctx.config.home, join(root, "home"));
    assert.equal(ctx.index.kind, "sqlite");
    assert.equal(ctx.blobs.kind, "file");
    await ctx.index.setCursor("x", 1);
    assert.ok(existsSync(join(root, "home", "index.db")));
    await ctx.close();
    await ctx.close();
  });

  it("uses the configured stores and sinks", async () => {
    const home = join(root, "home2");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), '[store]\nindex = "memory://"\nblobs = "memory://"\n[[sinks]]\nkind = "http"\nendpoint = "http://127.0.0.1:1"\n');
    const ctx = await openContext({ env: { CODING_SH_HOME: home, HOME: root } });
    assert.equal(ctx.index.kind, "memory");
    assert.deepEqual(ctx.sinks.map((s) => [s.name, s.mode]), [["http", "metadata"]]);
    await ctx.close();
  });
});

describe("openContext ingest/gc", () => {
  it("drains a Claude Code hook spool line into the index lazily", async () => {
    const home = join(root, "home3");
    const env = { CODING_SH_HOME: home, HOME: root };
    const spool = join(home, "spool", "claude-code");
    mkdirSync(spool, { recursive: true });
    const line = { v: 0, agent: "claude-code", event: "UserPromptSubmit", ts: 1_762_400_000_000, pid: 1, cwd: root, raw: { session_id: "ctx-s1", hook_event_name: "UserPromptSubmit", prompt: "hello from ctx", cwd: root } };
    writeFileSync(join(spool, "2026-11-06.1.jsonl"), JSON.stringify(line) + "\n");
    const ctx = await openContext({ env });
    try {
      const r = await ctx.ingest();
      assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
      assert.equal(r.lines, 1);
      const s = await ctx.index.getSession("ctx-s1");
      assert.equal(s?.title, "hello from ctx");
      const g = await ctx.gc({ dryRun: true });
      assert.equal(g.dryRun, true);
      assert.equal(existsSync(join(home, "spool", ".ingest.lock")), false, "lock released");
    } finally {
      await ctx.close();
    }
  });
});
