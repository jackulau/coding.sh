import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";

const root = mkdtempSync(join(tmpdir(), "csh-ctx-"));
// Retries: on Windows a child the hand-off test started may still hold the folder for a moment as it exits.
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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

  it("starts a background ingest when the wake-up marker is back after the last pass", async () => {
    const home = join(root, "home4");
    mkdirSync(join(home, "spool"), { recursive: true });
    const ctx = await openContext({ env: { CODING_SH_HOME: home, HOME: root } });
    // Stands in for the CLI init records: it writes down the arguments it was started with.
    const args = join(root, "handoff-args.json");
    const cli = join(root, "handoff-cli.mjs");
    writeFileSync(cli, `import { renameSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(args + ".tmp")}, JSON.stringify(process.argv.slice(2)));\nrenameSync(${JSON.stringify(args + ".tmp")}, ${JSON.stringify(args)});\n`);
    mkdirSync(dirname(ctx.paths.cliPointer), { recursive: true });
    writeFileSync(ctx.paths.cliPointer, cli);
    const marker = join(home, "spool", ".ingest.pending");
    try {
      // A hook touches the marker during each of the three passes.
      await ctx.ingest({ onProgress: () => writeFileSync(marker, "") });
      assert.equal(existsSync(marker), true, "the marker stays for the ingest it starts");
      for (let waited = 0; !existsSync(args) && waited < 20_000; waited += 50) await sleep(50);
      assert.deepEqual(JSON.parse(readFileSync(args, "utf8")), ["ingest", "--background"]);
    } finally {
      await ctx.close();
    }
  });

  it("starts no background ingest for a store from --store or CODING_SH_STORE_URL", async () => {
    const home = join(root, "home5");
    mkdirSync(join(home, "spool"), { recursive: true });
    const ctx = await openContext({ env: { CODING_SH_HOME: home, HOME: root, CODING_SH_STORE_URL: `sqlite://${join(root, "other.db")}` } });
    assert.equal(ctx.storeOverridden, true);
    const started = join(root, "override-started.json");
    const cli = join(root, "override-cli.mjs");
    writeFileSync(cli, `import { renameSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(started + ".tmp")}, JSON.stringify({ argv: process.argv.slice(2), store: process.env.CODING_SH_STORE_URL }));\nrenameSync(${JSON.stringify(started + ".tmp")}, ${JSON.stringify(started)});\n`);
    mkdirSync(dirname(ctx.paths.cliPointer), { recursive: true });
    writeFileSync(ctx.paths.cliPointer, cli);
    const marker = join(home, "spool", ".ingest.pending");
    try {
      await ctx.ingest({ onProgress: () => writeFileSync(marker, "") });
      for (let waited = 0; !existsSync(started) && waited < 3000; waited += 50) await sleep(50);
      assert.equal(existsSync(started), false, existsSync(started) ? `a background ingest started: ${readFileSync(started, "utf8")}` : "");
    } finally {
      await ctx.close();
    }
  });

  it("an ingest whose background hand-off cannot start node does not crash the process", () => {
    const home = join(root, "home6");
    const cli = join(root, "crash-cli.mjs");
    writeFileSync(cli, "");
    const script = join(root, "crash-ingest.mjs");
    // The node binary this process started from is gone (an upgrade removed it): spawn reports ENOENT on 'error', after it returns.
    writeFileSync(
      script,
      [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { dirname, join } from "node:path";`,
        `const [ctxUrl, home, cli] = process.argv.slice(2);`,
        `const { openContext } = await import(ctxUrl);`,
        `mkdirSync(join(home, "spool"), { recursive: true });`,
        `const ctx = await openContext({ env: { CODING_SH_HOME: home, HOME: dirname(home) } });`,
        `mkdirSync(dirname(ctx.paths.cliPointer), { recursive: true });`,
        `writeFileSync(ctx.paths.cliPointer, cli);`,
        `process.execPath = join(home, "gone", "node");`,
        `const marker = join(home, "spool", ".ingest.pending");`,
        `await ctx.ingest({ onProgress: () => writeFileSync(marker, "") });`,
        `await new Promise((r) => setTimeout(r, 200));`,
        `await ctx.close();`,
        `process.stdout.write("survived\\n");`,
      ].join("\n"),
    );
    const ctxUrl = new URL("../../src/core/context.ts", import.meta.url).href;
    const r = spawnSync(process.execPath, ["--no-warnings", script, ctxUrl, home, cli], { encoding: "utf8", timeout: 60_000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: undefined } });
    assert.equal(r.stdout.trim(), "survived", `exit ${r.status}: ${r.stderr.split("\n").filter((l) => /Error|spawn/.test(l)).slice(0, 3).join(" | ")}`);
  });
});
