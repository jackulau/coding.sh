// `coding.sh statusline`: the rendered line, the worst-flag choice, and that
// install/uninstall put Claude Code's settings.json back byte-for-byte (a
// previous status line comes back).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { run } from "../../src/cli/commands/statusline.ts";
import { Output } from "../../src/cli/output.ts";
import { statuslineLine, worstFailureFlag } from "../../src/cli/statusline.ts";
import type { FlagValue } from "../../src/cli/args.ts";
import type { CommandContext } from "../../src/cli/types.ts";

describe("statuslineLine", () => {
  test("model, costs and the worst flag", () => {
    assert.equal(
      statuslineLine({ model: "Opus", sessionCostUsd: 1.5, todayCostUsd: 12.34, flags: ["no-verification"] }),
      "Opus  ·  $1.50 session  ·  $12.34 today  ·  ! no-verification",
    );
  });
  test("no flag part when there is no real failure", () => {
    assert.equal(statuslineLine({ model: "Opus", sessionCostUsd: 1.5, todayCostUsd: 12.34, flags: [] }), "Opus  ·  $1.50 session  ·  $12.34 today");
  });
  test("costs still print with no model or session", () => {
    assert.equal(statuslineLine({ sessionCostUsd: 0, todayCostUsd: 0 }), "$0.0000 session  ·  $0.0000 today");
  });
});

describe("worstFailureFlag", () => {
  test("a defect beats an inefficiency", () => {
    assert.equal(worstFailureFlag(["duplicate-fetch", "premature-completion"]), "premature-completion");
  });
  test("a risk beats an inefficiency", () => {
    assert.equal(worstFailureFlag(["looping", "no-verification"]), "no-verification");
  });
  test("tags and context-only flags are not failures", () => {
    assert.equal(worstFailureFlag(["model:switch", "compaction", "gateway:vercel"]), undefined);
    assert.equal(worstFailureFlag([]), undefined);
  });
});

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-statusline-")));
  roots.push(root);
  const claude = join(root, "claude");
  mkdirSync(claude, { recursive: true });
  return { HOME: root, CLAUDE_CONFIG_DIR: claude, CODING_SH_HOME: join(root, ".coding.sh"), PATH: process.env.PATH };
}

function ctx(e: NodeJS.ProcessEnv, action: string | undefined, flags: Record<string, FlagValue> = {}): CommandContext {
  const out = new Output({ json: false, env: e, stdout: { write: () => true, isTTY: false }, stderr: { write: () => true, isTTY: false }, stdin: { isTTY: false } });
  return { action, flags, positionals: [], rest: [], out, env: e, cwd: e.HOME!, debug: false, signal: new AbortController().signal };
}

const settings = (e: NodeJS.ProcessEnv) => join(e.CLAUDE_CONFIG_DIR!, "settings.json");

describe("statusline install / uninstall", () => {
  test("creates settings.json then deletes the one it created", async () => {
    const e = env();
    assert.equal(await run(ctx(e, "install")), 0);
    const cfg = JSON.parse(readFileSync(settings(e), "utf8"));
    assert.equal(cfg.statusLine.command, "coding.sh statusline");
    assert.equal(cfg.statusLine.type, "command");
    assert.equal(await run(ctx(e, "uninstall")), 0);
    assert.ok(!existsSync(settings(e)), "the file coding.sh created is removed");
  });

  test("restores an existing settings.json byte-for-byte", async () => {
    const e = env();
    const original = '{\n  "model": "opus"\n}\n';
    writeFileSync(settings(e), original);
    await run(ctx(e, "install"));
    assert.match(readFileSync(settings(e), "utf8"), /"statusLine"/);
    await run(ctx(e, "uninstall"));
    assert.equal(readFileSync(settings(e), "utf8"), original, "byte-for-byte restore");
  });

  test("refuses to replace another status line without --force", async () => {
    const e = env();
    const original = '{"statusLine":{"type":"command","command":"ccusage statusline"}}';
    writeFileSync(settings(e), original);
    await assert.rejects(run(ctx(e, "install")), /already has a status line/);
    assert.equal(readFileSync(settings(e), "utf8"), original, "file untouched on refusal");
  });

  test("--force replaces then restores the previous status line", async () => {
    const e = env();
    const original = '{\n  "statusLine": {\n    "type": "command",\n    "command": "ccusage statusline"\n  }\n}\n';
    writeFileSync(settings(e), original);
    await run(ctx(e, "install", { force: true }));
    assert.equal(JSON.parse(readFileSync(settings(e), "utf8")).statusLine.command, "coding.sh statusline");
    await run(ctx(e, "uninstall"));
    assert.equal(readFileSync(settings(e), "utf8"), original, "the previous status line comes back byte-for-byte");
  });
});
