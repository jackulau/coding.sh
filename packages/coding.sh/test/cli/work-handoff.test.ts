// `coding.sh handoff --work <id>` and multi-session `coding.sh work show <id>` timeline
// through the CLI in a throwaway HOME and repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { WorkHandoffPacket, WorkTimelineEntry } from "../../src/core/handoff.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { workItemId } from "../../src/core/work.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { CLI } from "../_cli.ts";

const DAY = 86_400_000;
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

let root = "";
let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};
let workId = "";
let singleHighId = "";
const SECRET_KEY = ["sk-ant-api03-", "Z".repeat(40)].join("");

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeEvents(
  sessionId: string,
  startTs: number,
  agent: string,
  steps: [AgentEvent["kind"], Record<string, unknown>][],
): AgentEvent[] {
  let ts = startTs;
  return steps.map(([kind, payload], i) => {
    ts += 1000;
    return {
      id: `${sessionId}-${i}`,
      v: 0,
      sessionId,
      ts,
      agent,
      cwd: repo,
      repo: { root: repo, branch: "feat/multiday-handoff", head: "bf255bb5" },
      kind,
      payload,
    };
  });
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-work-handoff-")));
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
    CODING_SH_NO_AUTO_INGEST: "1",
  };

  // Place 3 sessions across 3 distinct UTC calendar days within the last 5 days so both
  // `work show` (default 7d) and `handoff --work` (default 30d) resolve the work item.
  const nowDayMidnight = Math.floor(Date.now() / DAY) * DAY;
  const day1 = nowDayMidnight - 3 * DAY + 10 * 3600_000;
  const day2 = nowDayMidnight - 2 * DAY + 14 * 3600_000;
  const day3 = nowDayMidnight - 1 * DAY + 9 * 3600_000;

  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const ev1 = makeEvents("wday-1111", day1, "claude-code", [
      ["session.start", {}],
      ["user.message", { text: `Implement token rotation without printing ${SECRET_KEY}.` }],
      ["file.change", { path: "src/tokens.ts", op: "modify", diff: diff("src/tokens.ts", "-const v = 1;", "+const v = 2;") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "ok" }],
      ["tool.start", { tool: "Bash", toolUseId: "d1", input: { command: "node scripts/bad-step.mjs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d1", ok: false, output: "Error: bad step day 1" }],
      ["session.end", {}],
    ]);
    const s1 = buildSession(ev1);
    await ctx.index.upsertSession(s1);
    await ctx.index.putEvents(ev1);

    const ev2 = makeEvents("wday-2222", day2, "claude-code", [
      ["session.start", {}],
      ["user.message", { text: "Pivot: prove rotation safety in Proof/Rotate.lean without sorry." }],
      ["file.change", { path: "Proof/Rotate.lean", op: "modify", diff: diff("Proof/Rotate.lean", " theorem rot : True := by", "-  trivial", "+  sorry") }],
      ["context.compact", { trigger: "auto", tokensBefore: 150_000 }],
      ["tool.start", { tool: "Bash", toolUseId: "d2", input: { command: "node scripts/bad-step.mjs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d2", ok: false, output: "Error: bad step day 2" }],
      ["tool.start", { tool: "Bash", toolUseId: "p1", input: { command: "lake env lean Proof/Rotate.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p1", ok: false, output: "Proof/Rotate.lean:2:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p2", input: { command: "lake env lean Proof/Rotate.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p2", ok: false, output: "Proof/Rotate.lean:3:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p3", input: { command: "lake env lean Proof/Rotate.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p3", ok: false, output: "Proof/Rotate.lean:4:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p4", input: { command: "lake env lean Proof/Rotate.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p4", ok: false, output: "Proof/Rotate.lean:5:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p5", input: { command: "lake env lean Proof/Rotate.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p5", ok: false, output: "Proof/Rotate.lean:6:2: error: unsolved goals" }],
      ["session.end", {}],
    ]);
    const s2 = buildSession(ev2);
    s2.parent = { sessionId: "wday-1111", type: "fork" };
    await ctx.index.upsertSession(s2);
    await ctx.index.putEvents(ev2);

    const ev3 = makeEvents("wday-3333", day3, "codex", [
      ["session.start", {}],
      ["user.message", { text: "Finish src/rotate-cli.ts and keep npm test green." }],
      ["file.change", { path: "src/rotate-cli.ts", op: "modify", diff: diff("src/rotate-cli.ts", "+export const cli = true;") }],
      ["tool.start", { tool: "Bash", toolUseId: "c3", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c3", ok: true, output: "ok" }],
      ["session.end", {}],
    ]);
    const s3 = buildSession(ev3);
    s3.parent = { sessionId: "wday-2222", type: "provider-switch" };
    await ctx.index.upsertSession(s3);
    await ctx.index.putEvents(ev3);

    workId = workItemId("wday-1111");

    // Also seed a single-session high-risk work item to verify single-session behavior stays intact.
    const evSingle = makeEvents("solo-high-9999", day3 + 3600_000, "claude-code", [
      ["session.start", {}],
      ["user.message", { text: "Fix solo proof." }],
      ["file.change", { path: "Proof/Solo.lean", op: "modify", diff: diff("Proof/Solo.lean", " theorem solo : True := by", "-  trivial", "+  sorry") }],
      ["tool.start", { tool: "Bash", toolUseId: "s1", input: { command: "lake env lean Proof/Solo.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "s1", ok: false, output: "Proof/Solo.lean:2:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "s2", input: { command: "lake env lean Proof/Solo.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "s2", ok: false, output: "Proof/Solo.lean:3:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "s3", input: { command: "lake env lean Proof/Solo.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "s3", ok: false, output: "Proof/Solo.lean:4:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "s4", input: { command: "lake env lean Proof/Solo.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "s4", ok: false, output: "Proof/Solo.lean:5:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "s5", input: { command: "lake env lean Proof/Solo.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "s5", ok: false, output: "Proof/Solo.lean:6:2: error: unsolved goals" }],
      ["session.end", {}],
    ]);
    const solo = buildSession(evSingle);
    await ctx.index.upsertSession(solo);
    await ctx.index.putEvents(evSingle);
    singleHighId = workItemId("solo-high-9999");
  } finally {
    await ctx.close();
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("coding.sh handoff --work and work show timeline", () => {
  it("builds a multi-day Markdown brief via --work <id> and unique prefix with secret redaction", () => {
    const res = cli("handoff", "--work", workId.slice(0, 5));
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^# Work Handoff\n/);
    assert.match(res.stdout, /3 sessions across 3 days/);
    assert.match(res.stdout, /\*\*Original goal:\*\*/);
    assert.match(res.stdout, /\*\*Latest direction:\*\*/);
    assert.match(res.stdout, /## Multi-Day Timeline/);
    assert.match(res.stdout, /## Files Changed/);
    assert.match(res.stdout, /src\/tokens\.ts/);
    assert.match(res.stdout, /Proof\/Rotate\.lean/);
    assert.match(res.stdout, /src\/rotate-cli\.ts/);
    assert.match(res.stdout, /## Passing Checks/);
    assert.match(res.stdout, /## Formal Proofs/);
    assert.match(res.stdout, /## Do Not Repeat/);
    assert.match(res.stdout, /## Next Step/);
    assert.ok(!res.stdout.includes(SECRET_KEY), "secret redacted from stdout");
    assert.match(res.stderr, new RegExp(`Work handoff brief for ${workId} \\(3 sessions, 3 days`));
  });

  it("supports --json, --max-dead-ends, --max-sessions, and --out for --work", () => {
    const rJson = cli("handoff", "--work", workId, "--max-dead-ends", "1", "--max-sessions", "2", "--json");
    assert.equal(rJson.status, 0, rJson.stdout + rJson.stderr);
    const doc = JSON.parse(rJson.stdout) as WorkHandoffPacket;
    assert.equal(doc.workId, workId);
    assert.equal(doc.spanDays, 3);
    assert.equal(doc.totalSessions, 3);
    assert.equal(doc.omittedSessions, 1);
    assert.equal(doc.timeline.length, 2);
    assert.equal(doc.deadEnds.length, 1);
    assert.equal(doc.deadEnds[0]!.command, "lake env lean Proof/Rotate.lean");
    assert.equal(doc.proof?.verdict, "incomplete");
    assert.equal(doc.proof?.escapesRemaining, 1);
    assert.equal(doc.risk?.level, "high");
    assert.deepEqual(doc.contextResets, { compactions: 1, sessionHandoffs: 2, total: 3 });
    assert.ok(doc.goal?.startsWith("Implement token rotation"));
    assert.equal(doc.latestDirection, "Finish src/rotate-cli.ts and keep npm test green.");
    assert.ok(!JSON.stringify(doc).includes(SECRET_KEY));

    const mdPath = join(root, "out", "work-handoff.md");
    const rOut = cli("handoff", "--work", workId, "--out", mdPath);
    assert.equal(rOut.status, 0, rOut.stdout + rOut.stderr);
    assert.equal(rOut.stdout.trim(), mdPath);
    assert.match(rOut.stderr, /Wrote work handoff brief/);
    const written = readFileSync(mdPath, "utf8");
    assert.match(written, /^# Work Handoff\n/);
    assert.ok(!written.includes(SECRET_KEY));
  });

  it("validates mutually exclusive <session> and --work arguments and reports unknown work ids", () => {
    const neither = cli("handoff");
    assert.equal(neither.status, 2);
    assert.match(neither.stderr, /Missing <session> or --work <id>/);

    const both = cli("handoff", "wday-1111", "--work", workId);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /Pass either <session> or --work <id>, not both/);

    const emptyWork = cli("handoff", "--work", "");
    assert.equal(emptyWork.status, 2);
    assert.match(emptyWork.stderr, /--work needs a work item id/);

    const badMaxSessions = cli("handoff", "--work", workId, "--max-sessions", "0");
    assert.equal(badMaxSessions.status, 2);
    assert.match(badMaxSessions.stderr, /--max-sessions must be a whole number from 1/);

    const missing = cli("handoff", "--work", "w000000");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Can't find work item "w000000"/);
  });

  it("surfaces Timeline in work show (text and --json) and suggests handoff --work for multi-session high-risk items", () => {
    const showText = cli("work", "show", workId);
    assert.equal(showText.status, 0, showText.stdout + showText.stderr);
    assert.match(showText.stdout, /Timeline +3 sessions across 3 days/);
    assert.match(showText.stdout, /wday-1111|wday-1/);
    assert.match(showText.stdout, /risk:high/);
    assert.match(showText.stdout, /proof:incomplete/);
    assert.match(showText.stderr, new RegExp(`(?:coding\\.sh|codingsh) handoff --work ${workId}`));

    const showJson = cli("work", "show", workId, "--json");
    assert.equal(showJson.status, 0, showJson.stdout + showJson.stderr);
    const parsed = JSON.parse(showJson.stdout) as { id: string; spanDays?: number; timeline?: WorkTimelineEntry[] };
    assert.equal(parsed.id, workId);
    assert.equal(parsed.spanDays, 3);
    assert.equal(parsed.timeline?.length, 3);
    assert.deepEqual(
      parsed.timeline?.map((e) => e.sessionId),
      ["wday-1111", "wday-2222", "wday-3333"],
    );

    // Single-session high-risk item omits timeline and keeps single-session handoff hint.
    const soloJson = cli("work", "show", singleHighId, "--json");
    assert.equal(soloJson.status, 0, soloJson.stdout + soloJson.stderr);
    const soloParsed = JSON.parse(soloJson.stdout) as { id: string; timeline?: WorkTimelineEntry[] };
    assert.equal(soloParsed.timeline, undefined);

    const soloText = cli("work", "show", singleHighId);
    assert.equal(soloText.status, 0, soloText.stdout + soloText.stderr);
    assert.doesNotMatch(soloText.stdout, /\bTimeline\b/);
    assert.doesNotMatch(soloText.stderr, /handoff --work/);
    assert.match(soloText.stderr, /(?:coding\.sh|codingsh) handoff solo/);
  });
});
