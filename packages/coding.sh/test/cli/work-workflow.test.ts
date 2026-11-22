// coding.sh work on a workflow run against a throwaway store: one item per run with a phase
// line, `work show` listing the phases with their agents, and `show` and `work show` giving
// one count of files changed for a session that edited a file from two folders.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import * as work from "../../src/cli/commands/work.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { workflowRunKey, workItemId } from "../../src/core/work.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const MIN = 60e3;
const now = Date.now();
type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { cwd: "/work/demo", ...extra });
const agent = (id: string, phase: string, startAgo: number, extra: Extra = {}): Session =>
  sess(`lead:sub:${id}`, startAgo, { title: `${phase} ${id}`, ...extra, parent: { sessionId: "lead", subagentId: id, workflowId: "run-1", workflowName: "nightly", phase, label: `${phase}:${id}` } });
const RUN = workItemId(workflowRunKey("lead", "run-1"));

describe("work on a workflow run", () => {
  let sb: Sandbox;
  let edited: Session;
  before(async () => {
    sb = sandbox();
    const lead = sess("lead", 60 * MIN, { title: "start the run" });
    const agents = [
      agent("a", "research", 50 * MIN, { stats: { usage: { estimatedCostUsd: 0.25 } } as Extra["stats"] }),
      agent("b", "research", 49 * MIN),
      agent("c", "build", 40 * MIN, { flags: ["api-stall"], stats: { llmErrors: { count: 2, statusCode: 529 } } as Extra["stats"] }),
      agent("d", "build", 2 * MIN, { endedAt: undefined, stats: { latency: { wallMs: MIN } } as Extra["stats"] }),
    ];
    // A session that edited one file from the repo root and again from the package folder.
    const fc = (n: number, path: string, cwd: string) => ({ id: `f${n}`, v: 0, sessionId: "edit", ts: now - (20 - n) * MIN, agent: "claude-code", kind: "file.change", cwd, payload: { path } }) as AgentEvent;
    const events = [
      { id: "f0", v: 0, sessionId: "edit", ts: now - 21 * MIN, agent: "claude-code", kind: "session.start", cwd: "/work/demo", payload: {} } as AgentEvent,
      fc(1, "packages/app/src/x.ts", "/work/demo"),
      fc(2, "src/x.ts", "/work/demo/packages/app"),
      fc(3, "src/y.ts", "/work/demo/packages/app"),
      { id: "f9", v: 0, sessionId: "edit", ts: now - 15 * MIN, agent: "claude-code", kind: "session.end", cwd: "/work/demo", payload: {} } as AgentEvent,
    ];
    edited = buildSession(events);
    await sb.seed([lead, ...agents, edited], events);
  });
  after(() => sb.cleanup());

  test("--json gives one valid document with the run's phases, started by the lead", async () => {
    const r = await runCmd(work, sb, { json: true, flags: { all: true } });
    assert.equal(r.error, undefined, r.error?.stack);
    const doc = JSON.parse(r.stdout);
    const run = doc.items.find((i: { id: string }) => i.id === RUN);
    assert.ok(run, "the run is one item");
    assert.equal(run.title, "nightly");
    assert.equal(run.sessions, 4);
    assert.equal(run.startedBy, workItemId("lead"));
    assert.deepEqual(run.workflow, {
      id: "run-1",
      name: "nightly",
      phases: [
        { name: "research", agents: 2, running: 0, failed: 0, done: 2, costUsd: 0.25 },
        { name: "build", agents: 2, running: 1, failed: 1, done: 0 },
      ],
    });
    assert.notEqual(run.bucket, "failed", "an agent still runs");
    assert.equal(typeof doc.needYou, "number");
    assert.ok(doc.items.some((i: { id: string; sessions: number }) => i.id === workItemId("lead") && i.sessions === 1));
  });

  test("the text view prints a phase line under the run", async () => {
    const r = await runCmd(work, sb, { flags: { all: true } });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, new RegExp(`${RUN} {2}nightly`));
    assert.match(r.stdout, /phases: research: 2 done · build: 1 running, 1 failed/);
  });

  test("work show lists the phases with their agents, states and cost", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: [RUN] });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /Workflow +nightly, run run-1, 4 agents/);
    assert.match(r.stdout, /research: 2 done {2}\$0\.25/);
    assert.match(r.stdout, /lead:sub:c {2}failed {2}build:c/);
    assert.match(r.stdout, /lead:sub:d {2}running {2}build:d/);
    const j = await runCmd(work, sb, { action: "show", positionals: [RUN], json: true });
    assert.deepEqual(j.json.workflowAgents.map((a: { sessionId: string; state: string; phase: string }) => [a.sessionId, a.phase, a.state]), [
      ["lead:sub:a", "research", "done"],
      ["lead:sub:b", "research", "done"],
      ["lead:sub:c", "build", "failed"],
      ["lead:sub:d", "build", "running"],
    ]);
    // The lead's own id names its own item, not the run it started.
    const lead = await runCmd(work, sb, { action: "show", positionals: ["lead"], json: true });
    assert.equal(lead.json.id, workItemId("lead"));
  });

  test("show and work show give one count of files changed", async () => {
    assert.equal(edited.stats.filesChanged, 2);
    const ws = await runCmd(work, sb, { action: "show", positionals: ["edit"], json: true });
    assert.equal(ws.error, undefined, ws.error?.stack);
    assert.equal(ws.json.filesChanged, 2);
    assert.deepEqual([...ws.json.files].sort(), ["packages/app/src/x.ts", "packages/app/src/y.ts"]);
    const s = await runCmd(show, sb, { positionals: ["edit"] });
    assert.equal(s.error, undefined, s.error?.stack);
    assert.match(s.stdout, /2 files changed/);
  });
});
