// Work items for workflow runs (core/work.ts): one item per run with its phases, the
// session that ran the workflow kept as its own item; failures that age out of needs-you
// or that a later passing item supersedes; the approval stageWhy that quotes the agent;
// the evidence ownCheckout needs; and one changed-file count for show, work show and the fold.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildSession, changeKey, FLAGS, parentOf } from "../../src/core/sessions.ts";
import { buildWorkQueue, gitFileAt, itemWorkflowAgents, needYou, ownCheckout, PROBABLY_CLOSED_MS, rootCheckouts, workFiles, workflowRunKey, workItemId, workItemJson, workJson } from "../../src/core/work.ts";
import type { AgentEvent, Session, Waiting } from "../../src/schema/index.ts";
import { mkSession } from "../cli/_cmd.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const MIN = 60e3;
const HOUR = 60 * MIN;
const ago = (ms: number) => NOW - ms;
type Extra = Parameters<typeof mkSession>[2];
const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, ago(startAgo), { cwd: "/work/demo", ...extra });
const open = (id: string, quietFor: number, extra: Extra = {}): Session =>
  sess(id, quietFor + MIN, { endedAt: undefined, ...extra, stats: { latency: { wallMs: MIN }, ...extra?.stats } as Partial<Session["stats"]> });
const queue = (sessions: Session[], opts: Parameters<typeof buildWorkQueue>[1] = {}) => buildWorkQueue(sessions, { now: NOW, ...opts });
const cost = (usd: number) => ({ usage: { estimatedCostUsd: usd } }) as Partial<Session["stats"]>;
const failedApi = { flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } } as Partial<Session["stats"]> };

/** A workflow agent of `run`, started by `lead`. */
function agent(id: string, run: string, phase: string | undefined, startAgo: number, extra: Extra = {}, name?: string): Session {
  const parent: NonNullable<Session["parent"]> = { sessionId: "lead", subagentId: id, workflowId: run };
  if (name) parent.workflowName = name;
  if (phase) parent.phase = phase;
  parent.label = `${phase ?? "agent"}:${id}`;
  return sess(`lead:sub:${id}`, startAgo, { ...extra, parent });
}

/** A lead session and 12 workflow agents over 3 phases from two runs. */
function fleet(): Session[] {
  const lead = sess("lead", 3 * HOUR, { title: "run the round", endedAt: ago(10 * MIN) });
  const a = (id: string, phase: string, at: number, extra: Extra = {}) => agent(id, "run-a", phase, at, extra, "round 7");
  const b = (id: string, phase: string, at: number, extra: Extra = {}) => agent(id, "run-b-12345678", phase, at, extra);
  return [
    lead,
    a("r1", "research", 170 * MIN, { stats: cost(0.1) }),
    a("r2", "research", 169 * MIN, { stats: cost(0.1) }),
    a("r3", "research", 168 * MIN, { stats: cost(0.1) }),
    a("b1", "build", 120 * MIN, { stats: cost(0.5) }),
    a("b2", "build", 119 * MIN, { stats: cost(0.5) }),
    a("b3", "build", 118 * MIN, { ...failedApi, stats: { ...failedApi.stats, ...cost(0.25) } }),
    // Two reviewers still at work.
    { ...a("v1", "review", 20 * MIN, { stats: cost(0.05) }), endedAt: undefined },
    { ...a("v2", "review", 19 * MIN), endedAt: undefined },
    b("x1", "research", 100 * MIN, { stats: cost(0.2) }),
    b("x2", "research", 99 * MIN, { stats: cost(0.2) }),
    b("y1", "build", 90 * MIN, { stats: cost(1) }),
    b("y2", "build", 89 * MIN, { stats: cost(1) }),
  ];
}

describe("one work item per workflow run", () => {
  test("12 agents of two runs over 3 phases give two run items with phases, started by the lead, which stays its own item", () => {
    const q = queue(fleet(), { all: true });
    const lead = q.items.find((i) => i.rootId === "lead" && !i.workflow)!;
    assert.deepEqual(lead.sessionIds, ["lead"]);
    assert.equal(lead.id, workItemId("lead"));
    const runA = q.items.find((i) => i.workflow?.id === "run-a")!;
    const runB = q.items.find((i) => i.workflow?.id === "run-b-12345678")!;
    assert.equal(q.items.length, 3);
    assert.equal(runA.id, workItemId(workflowRunKey("lead", "run-a")));
    assert.equal(runB.id, workItemId(workflowRunKey("lead", "run-b-12345678")));
    assert.equal(runA.startedBy, lead.id);
    assert.equal(runB.startedBy, lead.id);
    assert.equal(runA.sessionIds.length, 8);
    assert.equal(runB.sessionIds.length, 4);
    assert.equal(runA.title, "round 7");
    assert.equal(runB.title, "Workflow run-b-12");
    assert.deepEqual(runA.workflow, {
      id: "run-a",
      name: "round 7",
      phases: [
        { name: "research", agents: 3, running: 0, failed: 0, done: 3, costUsd: 0.3 },
        { name: "build", agents: 3, running: 0, failed: 1, done: 2, costUsd: 1.25 },
        { name: "review", agents: 2, running: 2, failed: 0, done: 0, costUsd: 0.05 },
      ],
    });
    assert.deepEqual(runB.workflow, {
      id: "run-b-12345678",
      phases: [
        { name: "research", agents: 2, running: 0, failed: 0, done: 2, costUsd: 0.4 },
        { name: "build", agents: 2, running: 0, failed: 0, done: 2, costUsd: 2 },
      ],
    });
    // An agent still runs, so the failed builder does not put the run in the failed bucket.
    assert.notEqual(runA.bucket, "failed");
    assert.equal(q.counts.failed, 0);
  });

  test("a run whose agents all stopped is failed on its failed agents; one ack covers them", () => {
    const stopped = fleet().map((s) => (s.endedAt === undefined ? { ...s, endedAt: s.startedAt + MIN } : s));
    const q = queue(stopped);
    const run = q.items.find((i) => i.workflow?.id === "run-a")!;
    assert.equal(run.bucket, "failed");
    assert.equal(run.cause?.failure, "api 529");
    assert.equal(run.cause?.sessionId, "lead:sub:b3");
    assert.deepEqual(run.workflow!.phases.map((p) => [p.name, p.failed, p.done]), [["research", 0, 3], ["build", 1, 2], ["review", 0, 2]]);
  });

  test("a subagent of a workflow agent joins its run and its phase's cost", () => {
    const sub = sess("lead:sub:b1:sub:s1", 115 * MIN, { parent: { sessionId: "lead:sub:b1", subagentId: "s1" }, stats: cost(0.5) });
    const q = queue([...fleet(), sub], { all: true });
    const run = q.items.find((i) => i.workflow?.id === "run-a")!;
    assert.ok(run.sessionIds.includes(sub.id));
    const build = run.workflow!.phases.find((p) => p.name === "build")!;
    assert.equal(build.agents, 3, "a subagent is not a workflow agent");
    assert.equal(build.costUsd, 1.75);
    const agents = itemWorkflowAgents(run, [...fleet(), sub], NOW);
    assert.equal(agents.length, 8);
    assert.equal(agents.find((a) => a.sessionId === "lead:sub:b1")!.sessions, 2);
  });

  test("the run items' ids and startedBy are the same with and without the lead session", () => {
    const withLead = queue(fleet(), { all: true }).items.filter((i) => i.workflow);
    const without = queue(fleet().filter((s) => s.id !== "lead"), { all: true }).items.filter((i) => i.workflow);
    const ids = (items: typeof withLead) => items.map((i) => [i.id, i.startedBy, i.sessionIds.length]).sort();
    assert.deepEqual(ids(without), ids(withLead));
  });

  test("work --json carries the workflow with its phases", () => {
    const q = queue(fleet(), { all: true });
    const doc = JSON.parse(JSON.stringify(workJson(q, { since: 0, limit: 20 })));
    const run = doc.items.find((i: { workflow?: { id: string } }) => i.workflow?.id === "run-b-12345678");
    assert.deepEqual(run.workflow.phases.map((p: { name: string; agents: number }) => [p.name, p.agents]), [["research", 2], ["build", 2]]);
    assert.equal(typeof doc.needYou, "number");
    assert.equal(workItemJson(q.items.find((i) => !i.workflow)!).workflow, undefined);
  });

  test("agents that name no phase share one unnamed phase, after the named ones", () => {
    const lead = sess("lead", 2 * HOUR);
    const q = queue([lead, agent("p", "run-c", undefined, 30 * MIN), agent("q", "run-c", "build", 20 * MIN)], { all: true });
    const run = q.items.find((i) => i.workflow)!;
    assert.deepEqual(run.workflow!.phases.map((p) => p.name), ["build", undefined]);
  });

  test("parentOf reads the run, phase and label from a session.start payload", () => {
    const start = { id: "e1", v: 0, sessionId: "lead:sub:a", ts: NOW, agent: "claude-code", kind: "session.start", payload: { parentSessionId: "lead", workflowId: " run-a ", workflowName: "round 7", workflowPhase: "build", workflowLabel: "build:a" } } as unknown as AgentEvent; // slop-allow chained-as: an event with only the fields parentOf reads
    assert.deepEqual(parentOf([start]), { sessionId: "lead", workflowId: "run-a", workflowName: "round 7", phase: "build", label: "build:a" });
    const plain = { ...start, payload: { parentSessionId: "lead", workflowPhase: "build" } } as AgentEvent;
    assert.deepEqual(parentOf([plain]), { sessionId: "lead" });
  });
});

describe("failures age out of needs-you, and leave it when a later item passes", () => {
  const repo = (root: string, branch: string) => ({ root, head: "", branch }) as never;

  test("a failure 13 h old is probably closed and not in needYou; the bucket count stays", () => {
    const q = queue([sess("old", 13 * HOUR, failedApi)]);
    const item = q.items[0]!;
    assert.equal(item.bucket, "failed");
    assert.equal(item.probablyClosed, true);
    assert.equal(q.counts.failed, 1);
    assert.equal(q.needYou, 0);
    assert.equal(needYou(q), 0);
    assert.equal(workJson(q, { since: 0, limit: 20 }).needYou, 0);
    const fresh = queue([sess("new", 2 * MIN, failedApi)]);
    assert.equal(fresh.items[0]!.probablyClosed, undefined);
    assert.equal(needYou(fresh), 1);
    assert.ok(PROBABLY_CLOSED_MS < 13 * HOUR);
  });

  test("a later item on the same repo and branch that ended with no failure supersedes it; one on another branch does not", () => {
    const failed = sess("failed", 60 * MIN, { ...failedApi, repo: repo("/work/demo", "main") });
    const passed = sess("passed", 30 * MIN, { repo: repo("/work/demo", "main"), stats: { filesChanged: 1 } });
    const other = sess("other", 30 * MIN, { repo: repo("/work/demo", "feature") });
    const q = queue([failed, passed]);
    const item = q.items.find((i) => i.primaryId === "failed")!;
    assert.equal(item.supersededBy, workItemId("passed"));
    assert.match(item.reason, new RegExp(`superseded by ${workItemId("passed")}, which started later on the same branch and ended with no failure`));
    assert.equal(q.counts.failed, 1);
    assert.equal(q.needYou, 0);
    assert.equal(workItemJson(item).supersededBy, workItemId("passed"));
    const q2 = queue([failed, other]);
    assert.equal(q2.items.find((i) => i.primaryId === "failed")!.supersededBy, undefined);
    assert.equal(q2.needYou, 1);
  });

  test("an item that started before the failure, still runs or failed too does not supersede it", () => {
    const failed = sess("failed", 60 * MIN, failedApi);
    const before = sess("before", 90 * MIN, { endedAt: ago(10 * MIN) });
    const running = open("running", MIN);
    const failedToo = sess("again", 30 * MIN, { stats: { testsFailed: 2 } });
    const q = queue([failed, before, running, failedToo]);
    assert.equal(q.items.find((i) => i.primaryId === "failed")!.supersededBy, undefined);
    // With no repo, the same cwd is the same place.
    const q2 = queue([failed, sess("later", 30 * MIN)]);
    assert.match(q2.items.find((i) => i.primaryId === "failed")!.reason, /in the same folder/);
  });

  test("a blocked wait that is probably closed leaves needYou too", () => {
    const w: Waiting = { kind: "permission", at: ago(13 * HOUR), toolUseId: "t1" };
    const q = queue([open("b", 13 * HOUR, { stats: { waiting: w } })]);
    assert.equal(q.counts.blocked, 1);
    assert.equal(q.needYou, 0);
  });
});

describe("review fixes", () => {
  const fc = (sessionId: string, path: string, cwd?: string) => ({ id: `${sessionId}${path}${cwd ?? ""}`, v: 0, sessionId, ts: ago(MIN), agent: "claude-code", kind: "file.change", cwd, payload: { path } }) as AgentEvent;
  const repo = (root: string, branch: string, main?: string) => ({ root, head: "", branch, main }) as never;

  test("an approval item keeps the agent's quoted question in stageWhy", async () => {
    const w: Waiting = { kind: "permission", at: ago(MIN), toolUseId: "t1", text: "Apply it? changed 9 files" };
    const s = open("a", MIN, { stats: { waiting: w, filesChanged: 1 } });
    const item = queue([s]).items[0]!;
    assert.equal(item.stage, "approval");
    const before = item.stageWhy;
    assert.match(before, /changed 9 files/);
    await workFiles({ listEvents: async () => [fc("a", "src/one.ts")] }, item, [s], NOW);
    assert.equal(item.stageWhy, before);
  });

  test("a branch difference alone is not a separate checkout", () => {
    const main = sess("main", 30 * MIN, { cwd: "/work/demo", repo: repo("/work/demo", "main") });
    const sub = sess("sub", 5 * MIN, { cwd: "/work/demo/packages/app", repo: repo("/work/demo", "feature/login"), stats: { filesChanged: 1 } });
    const none = () => false;
    assert.equal(queue([main, sub], { isCheckout: none }).items.find((i) => i.primaryId === "sub")!.repo, "/work/demo");
    const checkouts = rootCheckouts([main, sub]);
    assert.equal(ownCheckout(sub, checkouts, none), false);
    // Evidence: a .git file between the cwd and the root, a different main, or a worktree layout.
    assert.equal(ownCheckout(sub, checkouts, () => true), true);
    assert.equal(ownCheckout({ ...sub, repo: repo("/work/demo", "feature/login", "/work/main") }, checkouts, none), true);
    assert.equal(ownCheckout({ ...sub, cwd: "/work/demo/.claude/worktrees/login" }, checkouts, none), true);
    assert.equal(ownCheckout({ ...sub, cwd: "/work/demo/.worktrees/login" }, checkouts, none), true);
  });

  test("gitFileAt finds a .git file between the cwd and the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-gitfile-"));
    try {
      const wt = join(dir, "nested", "wt");
      mkdirSync(join(wt, "src"), { recursive: true });
      assert.equal(gitFileAt(join(wt, "src"), dir), false);
      writeFileSync(join(wt, ".git"), "gitdir: elsewhere\n");
      assert.equal(gitFileAt(join(wt, "src"), dir), true);
      mkdirSync(join(dir, "plain", ".git"), { recursive: true });
      assert.equal(gitFileAt(join(dir, "plain"), dir), false, "a .git folder is a repo of its own, not a linked worktree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file edited from two folders counts once in the fold, and work show's list agrees", async () => {
    const start = { id: "s0", v: 0, sessionId: "m", ts: ago(10 * MIN), agent: "claude-code", kind: "session.start", cwd: "/work/demo", payload: {} } as AgentEvent;
    const events = [start, fc("m", "packages/app/src/x.ts", "/work/demo"), fc("m", "src/x.ts", "/work/demo/packages/app"), fc("m", "/work/demo/packages/app/src/y.ts", "/work/demo/packages/app"), fc("m", "/elsewhere/z.ts", "/work/demo")];
    const s = buildSession(events);
    assert.equal(s.cwd, "/work/demo");
    assert.equal(s.stats.filesChanged, 3);
    const item = queue([s], { all: true }).items[0]!;
    const files = await workFiles({ listEvents: async () => events }, item, [s], NOW);
    assert.equal(files.length, s.stats.filesChanged);
    assert.equal(item.filesChanged, s.stats.filesChanged);
    assert.equal(changeKey("src/x.ts", "/work/demo/packages/app", "/work/demo"), "packages/app/src/x.ts");
    assert.equal(changeKey("/elsewhere/z.ts", "/work/demo/app", "/work/demo"), "/elsewhere/z.ts");
    assert.equal(changeKey("src/x.ts", undefined, "/work/demo"), "src/x.ts");
  });
});
