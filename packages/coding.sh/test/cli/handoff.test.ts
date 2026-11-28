// `coding.sh handoff <session>` through the CLI in a throwaway HOME and repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HandoffPacket } from "../../src/core/handoff.ts";
import { CLI } from "../_cli.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const T0 = Date.UTC(2026, 9, 22, 16, 0, 0);
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

let root = "";
let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};
const SECRET_KEY = ["sk-ant-api03-", "Q".repeat(40)].join("");

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-handoff-")));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo, { recursive: true });
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
      sessionEvents("handoff-coding-1111", { cwd: repo, startedAt: T0 }, [
        ["session.start", {}],
        ["user.message", { text: `Fix cache invalidation without printing ${SECRET_KEY}.` }],
        ["file.change", { path: "src/cache.ts", op: "modify", diff: diff("src/cache.ts", "-const ttl = 1;", "+const ttl = 60;") }],
        ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "npm test" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "ok" }],
        ["tool.start", { tool: "Bash", toolUseId: "d1", input: { command: "node scripts/bad-a.mjs" } }],
        ["tool.end", { tool: "Bash", toolUseId: "d1", ok: false, output: "Error: bad-a failed" }],
        ["tool.start", { tool: "Bash", toolUseId: "d2", input: { command: "node scripts/bad-b.mjs" } }],
        ["tool.end", { tool: "Bash", toolUseId: "d2", ok: false, output: "Error: bad-b failed" }],
        ["tool.start", { tool: "Bash", toolUseId: "d3", input: { command: "node scripts/bad-b.mjs" } }],
        ["tool.end", { tool: "Bash", toolUseId: "d3", ok: false, output: "Error: bad-b failed again" }],
      ]),
    );

    await putSession(
      ctx.index,
      sessionEvents("handoff-lean-2222", { cwd: repo, startedAt: T0 + 60_000 }, [
        ["session.start", {}],
        ["user.message", { text: "Complete Proof/Sum.lean." }],
        ["file.change", { path: "Proof/Sum.lean", op: "modify", diff: diff("Proof/Sum.lean", " theorem sum_zero : 0 + 0 = 0 := by", "-  rfl", "+  sorry") }],
        ["tool.start", { tool: "Bash", toolUseId: "l1", input: { command: "lake env lean Proof/Sum.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "l1", ok: false, output: "Proof/Sum.lean:2:2: error: unsolved goals" }],
      ]),
    );
  } finally {
    await ctx.close();
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("coding.sh handoff", () => {
  it("prints clean Markdown to stdout and status note to stderr for id and unique prefix", () => {
    const res = cli("handoff", "handoff-coding");
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^# Context Handoff\n/);
    assert.match(res.stdout, /src\/cache\.ts/);
    assert.match(res.stdout, /npm test/);
    assert.match(res.stdout, /## Do Not Repeat/);
    assert.ok(!res.stdout.includes(SECRET_KEY), "secret redacted on stdout");
    assert.match(res.stderr, /Handoff brief for handoff-coding-1111/);
  });

  it("resolves latest and supports --json and --max-dead-ends", () => {
    const latest = cli("handoff", "latest", "--json");
    assert.equal(latest.status, 0, latest.stdout + latest.stderr);
    const leanDoc = JSON.parse(latest.stdout) as HandoffPacket;
    assert.equal(leanDoc.sessionId, "handoff-lean-2222");
    assert.equal(leanDoc.proof?.verdict, "incomplete");
    assert.equal(leanDoc.proof?.escapesRemaining, 1);
    assert.match(leanDoc.markdown, /## Formal Proof Status/);

    const capped = cli("handoff", "handoff-coding-1111", "--max-dead-ends", "1", "--json");
    assert.equal(capped.status, 0, capped.stdout + capped.stderr);
    const cappedDoc = JSON.parse(capped.stdout) as HandoffPacket;
    assert.equal(cappedDoc.deadEnds.length, 1);
    assert.equal(cappedDoc.deadEnds[0]!.command, "node scripts/bad-b.mjs");
    assert.equal(cappedDoc.deadEnds[0]!.count, 2);
  });

  it("writes Markdown or JSON with --out and exits 2 on invalid --max-dead-ends", () => {
    const mdOut = join(root, "out", "brief.md");
    const rMd = cli("handoff", "handoff-coding-1111", "--out", mdOut);
    assert.equal(rMd.status, 0, rMd.stdout + rMd.stderr);
    assert.equal(rMd.stdout.trim(), mdOut);
    assert.match(rMd.stderr, /Wrote handoff brief/);
    const writtenMd = readFileSync(mdOut, "utf8");
    assert.match(writtenMd, /^# Context Handoff\n/);
    assert.ok(!writtenMd.includes(SECRET_KEY));

    const jsonOut = join(root, "out", "brief.json");
    const rJson = cli("handoff", "handoff-lean-2222", "-o", jsonOut, "--json");
    assert.equal(rJson.status, 0, rJson.stdout + rJson.stderr);
    const writtenJson = JSON.parse(readFileSync(jsonOut, "utf8")) as HandoffPacket;
    assert.equal(writtenJson.sessionId, "handoff-lean-2222");
    assert.equal(writtenJson.proof?.verdict, "incomplete");

    const badZero = cli("handoff", "latest", "--max-dead-ends", "0");
    assert.equal(badZero.status, 2);
    assert.match(badZero.stderr, /--max-dead-ends must be a whole number from 1/);

    const badText = cli("handoff", "latest", "--max-dead-ends", "abc");
    assert.equal(badText.status, 2);
  });
});
