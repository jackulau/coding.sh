// `coding.sh steer <session>` through the CLI in a throwaway HOME and repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SteerAdvice } from "../../src/core/steer.ts";
import { CLI } from "../_cli.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

let root = "";
let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-steer-")));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
  };

  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    await putSession(
      ctx.index,
      sessionEvents("steer-clean-1111", { cwd: repo, startedAt: T0 }, [
        ["session.start", {}],
        ["user.message", { text: "Clean edit and test." }],
        ["file.change", { path: "src/ok.ts", op: "modify", diff: diff("src/ok.ts", "+export const ok = true;") }],
        ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
        ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "ok" }],
      ]),
    );

    await putSession(
      ctx.index,
      sessionEvents("steer-nudge-2222", { cwd: repo, startedAt: T0 + 60_000 }, [
        ["session.start", {}],
        ["user.message", { text: "Batch edits without checking." }],
        ["file.change", { path: "src/a.ts", op: "modify", diff: diff("src/a.ts", "+export const a = 1;") }],
        ["file.change", { path: "src/b.ts", op: "modify", diff: diff("src/b.ts", "+export const b = 2;") }],
        ["file.change", { path: "src/c.ts", op: "modify", diff: diff("src/c.ts", "+export const c = 3;") }],
      ]),
    );

    await putSession(
      ctx.index,
      sessionEvents("steer-intervene-3333", { cwd: repo, startedAt: T0 + 120_000 }, [
        ["session.start", {}],
        ["user.message", { text: "Prove theorem in Proof/Goal.lean." }],
        ["file.change", { path: "Proof/Goal.lean", op: "modify", diff: diff("Proof/Goal.lean", " theorem g : True := by", "+  sorry") }],
        ["tool.start", { tool: "Bash", toolUseId: "l1", input: { command: "lake build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "l1", ok: false, output: "Proof/Goal.lean:4:2: error: unsolved goals" }],
        ["tool.start", { tool: "Bash", toolUseId: "l2", input: { command: "lake build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "l2", ok: false, output: "Proof/Goal.lean:5:2: error: unsolved goals" }],
        ["tool.start", { tool: "Bash", toolUseId: "l3", input: { command: "lake build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "l3", ok: false, output: "Proof/Goal.lean:6:2: error: unsolved goals" }],
      ]),
    );
  } finally {
    await ctx.close();
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("coding.sh steer", () => {
  it("prints continue card, empty --prompt stdout, and exits 0 with --strict for healthy sessions", () => {
    const text = cli("steer", "steer-clean", "--strict");
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /Status\s+continue/);
    assert.match(text.stdout, /Risk\s+low/);
    assert.match(text.stdout, /No intervention needed/);

    const promptOnly = cli("steer", "steer-clean-1111", "--prompt", "--strict");
    assert.equal(promptOnly.status, 0, promptOnly.stdout + promptOnly.stderr);
    assert.equal(promptOnly.stdout, "");

    const json = cli("steer", "steer-clean-1111", "--json");
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const doc = JSON.parse(json.stdout) as SteerAdvice;
    assert.equal(doc.status, "continue");
    assert.equal(doc.suggestedSteer, undefined);
  });

  it("exits 0 with --strict on nudge and prints only suggestedSteer with --prompt", () => {
    const strict = cli("steer", "steer-nudge-2222", "--strict", "--json");
    assert.equal(strict.status, 0, strict.stdout + strict.stderr);
    const doc = JSON.parse(strict.stdout) as SteerAdvice;
    assert.equal(doc.status, "nudge");
    assert.ok(doc.suggestedSteer);

    const promptOnly = cli("steer", "steer-nudge-2222", "--prompt");
    assert.equal(promptOnly.status, 0, promptOnly.stdout + promptOnly.stderr);
    assert.equal(promptOnly.stdout.trim(), doc.suggestedSteer);
  });

  it("resolves latest with --fresh, shows directives and steer prompt, and exits 1 under --strict on intervene", () => {
    const text = cli("steer", "latest", "--fresh");
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /Status\s+intervene/);
    assert.match(text.stdout, /\[break-oscillation\]/);
    assert.match(text.stdout, /Suggested steer/);
    assert.match(text.stdout, /Proof\/Goal\.lean/);

    const strict = cli("steer", "latest", "--strict");
    assert.equal(strict.status, 1, "strict exits 1 on intervene");

    const promptStrict = cli("steer", "latest", "--prompt", "--strict");
    assert.equal(promptStrict.status, 1, "strict + prompt still exits 1 on intervene");
    assert.match(promptStrict.stdout, /Proof\/Goal\.lean/);
    assert.doesNotMatch(promptStrict.stdout, /Directives/);

    const json = cli("steer", "latest", "--json");
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const doc = JSON.parse(json.stdout) as SteerAdvice;
    assert.equal(doc.sessionId, "steer-intervene-3333");
    assert.equal(doc.status, "intervene");
    assert.ok(doc.directives.some((d) => d.kind === "break-oscillation"));
  });
});
