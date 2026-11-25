// scripts/e2e/temp-base.ts: the check each capture that runs Claude Code makes on the folder it
// makes its temp folder in. Claude Code reads CLAUDE.md files, skills and agents from the folders
// above its project, so a capture made below your own would record them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAbove, tempBase } from "../../../../scripts/e2e/temp-base.ts";

const E2E = fileURLToPath(new URL("../../../../scripts/e2e/", import.meta.url));

test("every script that installs Claude Code passes the temp folder through tempBase", () => {
  const scripts = readdirSync(E2E).filter((f) => f.endsWith(".mjs") && readFileSync(join(E2E, f), "utf8").includes("@anthropic-ai/claude-code@"));
  assert.ok(scripts.includes("claude-transcript-capture.mjs"), scripts.join(", "));
  for (const f of scripts) {
    const lines = readFileSync(join(E2E, f), "utf8").split("\n");
    assert.ok(lines.includes('import { tempBase } from "./temp-base.ts";'), `${f} does not import tempBase`);
    const uses = lines.filter((line) => line.includes("tmpdir()"));
    assert.ok(uses.length > 0, `${f} does not use the temp folder`);
    assert.deepEqual(uses.filter((line) => !line.includes("tempBase(")), [], `${f} uses the temp folder without tempBase`);
  }
});

test("readAbove finds Claude Code's files and a git repository in the folder and each folder above it, nearest first", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "csh-temp-base-")));
  try {
    const dir = join(top, "a", "b", "c");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.local.md"), "");
    writeFileSync(join(top, "a", "b", "CLAUDE.md"), "");
    mkdirSync(join(top, "a", ".claude"));
    // A worktree's .git is a file.
    writeFileSync(join(top, "a", ".git"), "gitdir: ../elsewhere\n");
    const found = readAbove(dir);
    assert.deepEqual(found.slice(0, 4), [join(dir, "CLAUDE.local.md"), join(top, "a", "b", "CLAUDE.md"), join(top, "a", ".claude"), join(top, "a", ".git")]);
    // What the real temp folder has above it comes after.
    assert.deepEqual(found.slice(4), readAbove(top));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("tempBase throws, naming what Claude Code would read and how to pick another folder", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "csh-temp-base-")));
  try {
    const dir = join(top, "tmp");
    mkdirSync(dir);
    mkdirSync(join(top, ".claude"));
    assert.throws(() => tempBase(dir), (e: Error) => {
      assert.ok(e.message.startsWith(`Claude Code would read ${join(top, ".claude")}`), e.message);
      assert.ok(e.message.endsWith(": set TEMP (TMPDIR on Linux and macOS) to a folder that has none of them above it"), e.message);
      return true;
    });
    assert.throws(() => tempBase(dir, "pass --tmp <dir>"), /: pass --tmp <dir>$/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("tempBase returns the folder it is given when nothing above it would reach a capture", { skip: readAbove(tmpdir()).length > 0 && "the temp folder has Claude Code's files or a git repository above it" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "csh-temp-base-"));
  try {
    assert.equal(tempBase(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
