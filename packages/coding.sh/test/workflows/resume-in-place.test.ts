// A Claude Code workflow stopped by the operator and resumed twice in the same run dir
// (writeInPlaceFixture): stopped agents, wall time across segments, cache hits from the record.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { run as workflowsCli } from "../../src/cli/commands/workflows.ts";
import { Output } from "../../src/cli/output.ts";
import { buildGantt } from "../../src/workflows/gantt.ts";
import { loadClaudeWorkflowDir } from "../../src/workflows/sources/claude-workflow.ts";
import { buildWorkflowTree, type WorkflowTree } from "../../src/workflows/tree.ts";
import { INPLACE, T1, writeClaudeWorkflowFixture, writeInPlaceFixture } from "./_fixtures.ts";

let root = "";
let tree: WorkflowTree;
let env: NodeJS.ProcessEnv = {};

before(async () => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-inplace-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: process.env.PATH, CI: "1" };
  const dir = writeInPlaceFixture(join(root, "claude", "projects"));
  tree = buildWorkflowTree((await loadClaudeWorkflowDir(dir, { concurrencyCap: 4 })).sources);
});
after(() => rmSync(root, { recursive: true, force: true }));

/** stdout and stderr together (show prints its header rows to stderr). */
async function cli(action: string, positionals: string[], json = false): Promise<string> {
  let stdout = "";
  const out = new Output({ json, env, stdout: { write: (x: string) => (stdout += x), isTTY: false }, stderr: { write: (x: string) => (stdout += x), isTTY: false }, stdin: { isTTY: false } });
  const code = await workflowsCli({ action, flags: {}, positionals, rest: [], out, env, cwd: root, debug: false, signal: new AbortController().signal });
  assert.equal(code, 0);
  return stdout;
}

const agents = () => tree.nodes.filter((n) => n.kind === "agent");

describe("stopped agents", () => {
  it("marks an agent the operator stopped as cancelled and a re-run label's first call as superseded", () => {
    assert.equal(tree.run.id, INPLACE);
    assert.equal(tree.run.status, "ok");
    assert.deepEqual(
      agents().map((n) => [n.name, n.status]),
      [
        ["plan", "ok"],
        ["review-x", "ok"],
        ["review-y", "cancelled"],
        ["qa-one", "superseded"],
        ["qa-two", "superseded"],
        ["qa-one", "ok"],
        ["qa-two", "ok"],
        ["fix", "ok"],
      ],
    );
    assert.ok(agents().every((n) => n.error === undefined), "a stopped agent has no 'no result recorded' error");
  });

  it("keeps stopped agents out of the failure count and rate, and counts them apart", () => {
    const s = tree.run.stats;
    assert.equal(s.failedAgents, 0);
    assert.equal(s.failRate, 0);
    assert.equal(s.agents, 5);
    assert.equal(s.cancelledAgents, 1);
    assert.equal(s.supersededAgents, 2);
    const qa = s.perPhase!.find((p) => p.phase === "QA")!;
    assert.equal(qa.agents, 2);
    assert.equal(qa.failures, 0);
    assert.equal(qa.superseded, 2);
    assert.equal(s.perPhase!.find((p) => p.phase === "Review")!.cancelled, 1);
    // They still spent time and tokens.
    assert.ok(s.agentMs >= 19_000 + 10_000 + 10_000);
  });

  it("leaves stopped agents off the critical path", () => {
    const stopped = new Set(agents().filter((n) => n.status === "cancelled" || n.status === "superseded").map((n) => n.id));
    assert.ok(tree.run.stats.criticalPath!.length > 0);
    assert.ok(tree.run.stats.criticalPath!.every((id) => !stopped.has(id)));
  });

  it("reads an unresumed stop as an aborted run when there is no record", () => {
    const j = [
      { type: "launched" },
      { type: "started", key: "k1", agentId: "x1", label: "one" },
      { type: "result", key: "k1", agentId: "x1", result: 1 },
      { type: "started", key: "k2", agentId: "x2", label: "two" },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    const ev = (kind: string, ts: number, payload: Record<string, unknown>) => ({ id: `${kind}${ts}`, sessionId: "s", agent: "claude-code", kind, ts, payload }) as never;
    const t = buildWorkflowTree({
      journal: j,
      agentEvents: {
        x1: [ev("user.message", 1000, { text: "go" }), ev("assistant.message", 2000, { text: "done" })],
        x2: [ev("user.message", 3000, { text: "go" }), ev("user.message", 4000, { text: "[Request interrupted by user]" })],
      },
    });
    assert.equal(t.nodes.find((n) => n.name === "two")!.status, "cancelled");
    assert.equal(t.run.status, "aborted");
    assert.equal(t.run.stats.failedAgents, 0);
    // Without the interrupt line it is still a failure.
    const failed = buildWorkflowTree({ journal: j, agentEvents: { x1: [ev("user.message", 1000, { text: "go" })], x2: [ev("user.message", 3000, { text: "go" })] } });
    assert.equal(failed.nodes.find((n) => n.name === "two")!.status, "running");
  });
});

describe("wall time across resumes", () => {
  it("runs from the first launch to the last result, not just the last segment the record covers", () => {
    assert.equal(tree.run.startedAt, T1);
    assert.equal(tree.run.endedAt, T1 + 100_000);
    assert.equal(tree.run.stats.wallMs, 100_000);
    assert.ok(tree.run.stats.criticalPathMs! <= tree.run.stats.wallMs!, "the critical path fits inside the wall time");
  });

  it("finds the segments from the operator's stops and the record's launch time, and reports active time", () => {
    assert.deepEqual(tree.run.segments, [
      { startedAt: T1, endedAt: T1 + 30_000 },
      { startedAt: T1 + 40_000, endedAt: T1 + 50_000 },
      { startedAt: T1 + 60_000, endedAt: T1 + 100_000 },
    ]);
    const s = tree.run.stats;
    assert.equal(s.segments, 3);
    assert.equal(s.activeMs, 80_000);
    // Parallelism and utilization are over active time.
    assert.equal(s.parallelism, s.agentMs / 80_000);
    assert.ok(s.utilization! <= 1);
    // Path plan → review-x → qa-one → fix. The 41 s between review-x and qa-one hold the two
    // 10 s stretches the run sat stopped, which are not orchestration overhead: 1 + 21 + 1 s.
    assert.equal(s.orchestrationGapMs, 23_000);
  });

  it("leaves a run launched once without segments", async () => {
    const t = buildWorkflowTree({
      journal: [{ type: "launched" }, { type: "started", key: "k", agentId: "x", label: "one" }, { type: "result", key: "k", agentId: "x", result: 1 }].map((x) => JSON.stringify(x)).join("\n"),
      record: { startTime: T1, durationMs: 5000, status: "completed" },
    });
    assert.equal(t.run.segments, undefined);
    assert.equal(t.run.stats.activeMs, undefined);
    assert.equal(t.run.stats.segments, undefined);
    assert.equal(t.run.stats.wallMs, 5000);
  });
});

describe("cache hits on a run resumed in place", () => {
  it("reads which calls the last segment replayed from the persisted record", () => {
    const plan = agents().find((n) => n.name === "plan")!;
    assert.equal(plan.cacheHit, true);
    assert.equal(plan.status, "ok", "it ran in an earlier segment");
    assert.equal(agents().filter((n) => n.cacheHit).length, 1);
    const s = tree.run.stats;
    assert.equal(s.cacheHits, 1);
    assert.equal(s.cacheHitRate, 1 / 8);
    // What replaying it saved is what it took when it ran: 10 s and its cost.
    assert.equal(s.resumeSavedMs, 10_000);
    assert.ok(Math.abs(s.resumeSavedUsd! - 0.4) < 1e-9, String(s.resumeSavedUsd));
  });

  it("takes an agent's time from the record when it has no transcript", () => {
    const t = buildWorkflowTree({
      journal: [{ type: "launched" }, { type: "started", key: "k", agentId: "x", label: "one" }, { type: "result", key: "k", agentId: "x", result: 1 }].map((x) => JSON.stringify(x)).join("\n"),
      record: { startTime: T1, durationMs: 9000, status: "completed", workflowProgress: [{ type: "workflow_agent", agentId: "x", startedAt: T1 + 1000, durationMs: 4000, state: "done" }] },
    });
    const a = t.nodes.find((n) => n.kind === "agent")!;
    assert.equal(a.startedAt, T1 + 1000);
    assert.equal(a.endedAt, T1 + 5000);
    assert.equal(a.cacheHit, undefined);
    assert.equal(t.run.stats.cacheHits, 0);
    assert.equal(t.run.stats.resumeSavedMs, undefined);
  });
});

describe("phase order", () => {
  it("orders phases by first start in stats, the tree and the Gantt, even one the script dropped", () => {
    // The last segment's script declares Plan, QA, Fix; Review ran first, then was removed.
    assert.deepEqual(tree.run.phases, ["Plan", "QA", "Fix", "Review"]);
    const want = ["Plan", "Review", "QA", "Fix"];
    assert.deepEqual(tree.run.stats.perPhase!.map((p) => p.phase), want);
    assert.deepEqual(buildGantt(tree.run, tree.nodes).phases.map((p) => p.name), want);
  });
});

describe("per-agent rows", () => {
  it("carry the agent id, the attempt for a re-run label and how the agent ended", () => {
    const rows = tree.run.stats.perAgent!.map((a) => [a.label, a.agentId, a.attempt, a.endReason]);
    assert.deepEqual(rows, [
      ["plan", "p0", 1, "ok"],
      ["review-x", "r0", 1, "ok"],
      ["review-y", "r1", 1, "cancelled"],
      ["qa-one", "q0", 1, "superseded"],
      ["qa-two", "q1", 1, "superseded"],
      ["qa-one", "q2", 2, "ok"],
      ["qa-two", "q3", 2, "ok"],
      ["fix", "f0", 1, "ok"],
    ]);
  });

  it("say schema-retry for an agent that returned after a StructuredOutput validation failure", async () => {
    const dirs = writeClaudeWorkflowFixture(join(root, "review-projects"));
    const t = buildWorkflowTree((await loadClaudeWorkflowDir(dirs.base)).sources);
    const byLabel = new Map(t.run.stats.perAgent!.map((a) => [a.label, a]));
    assert.equal(byLabel.get("verify-schema")!.endReason, "schema-retry");
    assert.equal(byLabel.get("verify-schema")!.status, "ok");
    assert.equal(byLabel.get("verify-null")!.endReason, "null");
    assert.equal(byLabel.get("find-a")!.endReason, "ok");
  });
});

describe("workflows show and stats on a run resumed in place", () => {
  it("show and stats list stopped agents apart from failures", async () => {
    await cli("import", []);
    const show = await cli("show", [INPLACE]);
    assert.match(show, /Stopped\s+1 cancelled, 2 superseded \(not failures\)/);
    assert.match(show, /agent review-y\s+cancelled/);
    assert.doesNotMatch(show, /no result recorded/);
    const stats = await cli("stats", [INPLACE]);
    assert.match(stats, /agents\t5 \(0 failed 0%, 0 null 0%\)/);
    assert.match(stats, /stopped\t1 cancelled, 2 superseded \(not failures\)/);
    assert.match(stats, /QA\t.*\t0 \(\+2 superseded\)\n/);
    assert.match(stats, /wall\t1m40s \(active 1m20s over 3 segments\)/);
    assert.match(show, /Cache hits\s+1 replayed on resume, saved 10s and \$0\.40/);
    assert.match(show, /agent plan\s+ok\s+10s\s+replayed on resume/);
    assert.match(stats, /cache hits\t1 \(13%\)/);
    assert.match(stats, /resume saved\t10s, \$0\.40/);
    const order = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);
    assert.deepEqual(order(show, /^  phase (\S+)/gm), ["Plan", "Review", "QA", "Fix"]);
    assert.deepEqual(order(stats, /^(Plan|Review|QA|Fix)\t/gm), ["Plan", "Review", "QA", "Fix"]);
    assert.match(stats, /\nqa-one #2\tQA\tok\t/);
    const doc = JSON.parse(await cli("stats", [INPLACE], true)) as { stats: { perAgent: { agentId?: string; attempt?: number; endReason?: string }[] } };
    assert.deepEqual(doc.stats.perAgent[3], { ...doc.stats.perAgent[3], agentId: "q0", attempt: 1, endReason: "superseded" });
    assert.match(show, /Wall\s+1m40s \(active 1m20s over 3 segments\)/);
  });
});
