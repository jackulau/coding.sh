// `coding.sh statusline`: the rendered line, the worst-flag choice, and that
// install/uninstall put Claude Code's settings.json back byte-for-byte (a
// previous status line comes back).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { PassThrough } from "node:stream";
import { MAX_STATUSLINE_STDIN, readStdin, run, STATUSLINE_STDIN_MS, statuslineCommand } from "../../src/cli/commands/statusline.ts";
import { type CliError, Output } from "../../src/cli/output.ts";
import { contextPart, statuslineLine, worstFailureFlag } from "../../src/cli/statusline.ts";
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
  test("no session part for a session the store does not know", () => {
    assert.equal(statuslineLine({ model: "Opus", todayCostUsd: 1.5 }), "Opus  ·  $1.50 today");
  });
  test("context fill after the model: ctx 62%, and full from 85%", () => {
    assert.equal(statuslineLine({ model: "Opus", contextPercent: 62, sessionCostUsd: 1.5, todayCostUsd: 2 }), "Opus  ·  ctx 62%  ·  $1.50 session  ·  $2.00 today");
    assert.equal(contextPart(87), "ctx 87% full");
    assert.equal(contextPart(85), "ctx 85% full");
    assert.equal(contextPart(84.4), "ctx 84%");
    assert.equal(contextPart(0), "ctx 0%");
  });
});

describe("statusline stdin", () => {
  test("a stdin that stays open ends the read after the limit, with what arrived", async () => {
    const stdin = new PassThrough();
    stdin.write('{"session_id":"x"}');
    const started = Date.now();
    const text = await readStdin(new AbortController().signal, stdin, MAX_STATUSLINE_STDIN, 150);
    assert.equal(text, '{"session_id":"x"}');
    assert.ok(Date.now() - started >= 140, "it waited for the limit");
    assert.ok(stdin.destroyed, "no more reads keep the process alive");
  });
  test("a stdin that closes is read at once", async () => {
    const stdin = new PassThrough();
    stdin.end("{}");
    const started = Date.now();
    assert.equal(await readStdin(new AbortController().signal, stdin, MAX_STATUSLINE_STDIN, 10_000), "{}");
    assert.ok(Date.now() - started < 5_000);
  });
  test("the limit fits the status line's time budget", () => {
    assert.ok(STATUSLINE_STDIN_MS >= 1000 && STATUSLINE_STDIN_MS <= 2000);
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

// What install writes here: on Windows, Claude Code may run it through PowerShell, where coding.sh fails.
const COMMAND = process.platform === "win32" ? "codingsh.cmd statusline" : "coding.sh statusline";

describe("the status line command", () => {
  test("is codingsh.cmd on Windows, which Git Bash and PowerShell both run, and coding.sh elsewhere", () => {
    assert.equal(statuslineCommand("win32"), "codingsh.cmd statusline");
    assert.equal(statuslineCommand("linux"), "coding.sh statusline");
    assert.equal(statuslineCommand("darwin"), "coding.sh statusline");
  });
});

describe("statusline install / uninstall", () => {
  test("creates settings.json then deletes the one it created", async () => {
    const e = env();
    assert.equal(await run(ctx(e, "install")), 0);
    const cfg = JSON.parse(readFileSync(settings(e), "utf8"));
    assert.equal(cfg.statusLine.command, COMMAND);
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

  test("keeps a CRLF settings.json's line ends and one-line arrays, and still restores it byte-for-byte", async () => {
    const e = env();
    const crlf = (lines: string[]) => lines.map((l) => `${l}\r\n`).join("");
    const original = crlf(["{", '  "model": "opus",', '  "permissions": {', '    "allow": ["Bash(ls)", "Bash(git status)"]', "  }", "}"]);
    writeFileSync(settings(e), original);
    assert.equal(await run(ctx(e, "install")), 0);
    // Only the statusLine member is new: the rest keeps its bytes, CRLF included.
    const statusLine = ['  "statusLine": {', '    "type": "command",', `    "command": ${JSON.stringify(COMMAND)},`, '    "padding": 0', "  }"];
    const installed = crlf(["{", '  "model": "opus",', '  "permissions": {', '    "allow": ["Bash(ls)", "Bash(git status)"]', "  },", ...statusLine, "}"]);
    assert.equal(readFileSync(settings(e), "utf8"), installed);
    assert.equal(await run(ctx(e, "uninstall")), 0);
    assert.equal(readFileSync(settings(e), "utf8"), original, "byte-for-byte restore");
  });

  test("a CRLF settings.json changed after install keeps its layout when uninstall removes only ours", async () => {
    const e = env();
    const crlf = (lines: string[]) => lines.map((l) => `${l}\r\n`).join("");
    writeFileSync(settings(e), crlf(["{", '  "model": "opus",', '  "env": { "A": "1" }', "}"]));
    await run(ctx(e, "install"));
    // An edit after install: uninstall can't restore the backup, so it removes the statusLine member.
    writeFileSync(settings(e), readFileSync(settings(e), "utf8").replace('"opus"', '"sonnet"'));
    assert.equal(await run(ctx(e, "uninstall")), 0);
    assert.equal(readFileSync(settings(e), "utf8"), crlf(["{", '  "model": "sonnet",', '  "env": { "A": "1" }', "}"]));
  });

  test("refuses to replace another status line without --force", async () => {
    const e = env();
    const original = '{"statusLine":{"type":"command","command":"ccusage statusline"}}';
    writeFileSync(settings(e), original);
    await assert.rejects(run(ctx(e, "install")), (err: CliError) => {
      assert.match(err.message, /already has a status line/);
      // env() sets no SHELL or MSYSTEM: PowerShell or cmd on Windows, where only codingsh runs.
      assert.deepEqual(err.next, ["Replace it (the old one is restored on uninstall):", `${process.platform === "win32" ? "codingsh" : "coding.sh"} statusline install --force`]);
      return true;
    });
    assert.equal(readFileSync(settings(e), "utf8"), original, "file untouched on refusal");
  });

  test("--force replaces then restores the previous status line", async () => {
    const e = env();
    const original = '{\n  "statusLine": {\n    "type": "command",\n    "command": "ccusage statusline"\n  }\n}\n';
    writeFileSync(settings(e), original);
    await run(ctx(e, "install", { force: true }));
    assert.equal(JSON.parse(readFileSync(settings(e), "utf8")).statusLine.command, COMMAND);
    await run(ctx(e, "uninstall"));
    assert.equal(readFileSync(settings(e), "utf8"), original, "the previous status line comes back byte-for-byte");
  });

  test("--force, then settings.json changes: uninstall keeps the change and brings back the replaced status line", async () => {
    const e = env();
    writeFileSync(settings(e), '{"statusLine":{"type":"command","command":"my-line"}}\n');
    await run(ctx(e, "install", { force: true }));
    // Claude Code (or init) writes to the file after the install.
    const cfg = JSON.parse(readFileSync(settings(e), "utf8"));
    writeFileSync(settings(e), JSON.stringify({ ...cfg, permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n");
    assert.equal(await run(ctx(e, "uninstall")), 0);
    const after = JSON.parse(readFileSync(settings(e), "utf8"));
    assert.deepEqual(after.statusLine, { type: "command", command: "my-line" });
    assert.deepEqual(after.permissions, { allow: ["Bash(ls)"] }, "the later change stays");
  });

  test("coding.sh, codingsh and codingsh.cmd are all ours: install updates the line, uninstall removes it", async () => {
    for (const command of ["coding.sh statusline", "codingsh statusline", "codingsh.cmd statusline"]) {
      const e = env();
      writeFileSync(settings(e), JSON.stringify({ model: "opus", statusLine: { type: "command", command, padding: 0 } }) + "\n");
      assert.equal(await run(ctx(e, "install")), 0, command);
      assert.equal(JSON.parse(readFileSync(settings(e), "utf8")).statusLine.command, COMMAND, command);
      assert.equal(await run(ctx(e, "uninstall")), 0, command);
      assert.deepEqual(JSON.parse(readFileSync(settings(e), "utf8")), { model: "opus" }, command);
    }
  });

  test("no earlier status line, then settings.json changes: uninstall removes only ours", async () => {
    const e = env();
    writeFileSync(settings(e), '{"model":"opus"}\n');
    await run(ctx(e, "install"));
    const cfg = JSON.parse(readFileSync(settings(e), "utf8"));
    writeFileSync(settings(e), JSON.stringify({ ...cfg, theme: "dark" }) + "\n");
    await run(ctx(e, "uninstall"));
    assert.deepEqual(JSON.parse(readFileSync(settings(e), "utf8")), { model: "opus", theme: "dark" });
  });
});
