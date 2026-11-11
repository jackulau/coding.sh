// A whole multi-agent run as one tree (core/tree.ts): a parent session and its
// subagents walk into one tree, a proxy-only child links from its calls, a
// fan-out of separate processes groups by run id, and totals/worst roll up the
// loop. The tree is derived from Session.parent and parent_session_id, so these
// build real Session rows with buildSession and store them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { buildRunTree, buildSessionTree, rootOf, subagentsOf, treeTotals, worstFirst, worstNode } from "../../src/core/tree.ts";
import type { AgentEvent, EventKind, Session } from "../../src/schema/index.ts";

const T0 = Date.UTC(2026, 10, 8, 9);
let n = 0;
const ev = (sessionId: string, kind: EventKind, dt: number, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++n}`,
  v: 0,
  sessionId,
  ts: T0 + dt * 1000,
  agent: "claude-code",
  kind,
  payload,
  ...o,
});

/** A session built from a start/call/end trio; `usage` and `flags` can be forced. */
function session(opts: {
  id: string;
  dt: number;
  dur: number;
  startPayload?: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  toolCalls?: number;
  runId?: string;
  callSource?: string;
  callPayload?: Record<string, unknown>;
}): Session {
  const { id, dt, dur, startPayload = {}, usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, toolCalls = 0, runId, callSource, callPayload = {} } = opts;
  const events: AgentEvent[] = [];
  events.push(ev(id, "session.start", dt, startPayload, runId ? { runId } : {}));
  events.push(ev(id, "user.message", dt + 1, { text: `task for ${id}` }, runId ? { runId } : {}));
  for (let i = 0; i < toolCalls; i++) {
    events.push(ev(id, "tool.start", dt + 2 + i, { tool: "Bash", toolUseId: `${id}-t${i}`, input: { command: `echo ${i}` } }, runId ? { runId } : {}));
    events.push(ev(id, "tool.end", dt + 2 + i, { tool: "Bash", toolUseId: `${id}-t${i}`, ok: true }, runId ? { runId } : {}));
  }
  events.push(ev(id, "llm.call", dt + 2, { ok: true, responseModel: "claude-sonnet-5", ...callPayload }, { model: "claude-sonnet-5", usage, ...(callSource ? { source: callSource } : {}), ...(runId ? { runId } : {}) }));
  events.push(ev(id, "session.end", dt + dur, {}, runId ? { runId } : {}));
  return buildSession(events);
}

describe("a parent session and its subagents are one tree", () => {
  it("walks from any node to the whole tree, with rolled-up totals and the worst flag", async () => {
    const index = new MemoryIndexStore();
    // Root → two subagents; one subagent has a third-level grandchild.
    const root = session({ id: "root", dt: 0, dur: 100, usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.1 }, toolCalls: 3 });
    const sub1 = session({ id: "root:sub:a1", dt: 5, dur: 30, startPayload: { source: "subagent", parentSessionId: "root", subagentId: "a1", subagentType: "reviewer" }, usage: { inputTokens: 400, outputTokens: 80, costUsd: 0.04 }, toolCalls: 2 });
    const sub2 = session({ id: "root:sub:a2", dt: 40, dur: 50, startPayload: { source: "subagent", parentSessionId: "root", subagentId: "a2", subagentType: "fixer" }, usage: { inputTokens: 600, outputTokens: 120, costUsd: 0.2 }, toolCalls: 1 });
    const grand = session({ id: "root:sub:a2:sub:b1", dt: 45, dur: 20, startPayload: { source: "subagent", parentSessionId: "root:sub:a2", subagentId: "b1", subagentType: "searcher" }, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 } });
    // Make the fixer subagent the one to fix: premature-completion.
    sub2.flags = [...sub2.flags, "premature-completion"];
    for (const s of [root, sub1, sub2, grand]) await index.upsertSession(s);

    assert.equal(await rootOf(index, "root:sub:a2:sub:b1"), "root", "walks up to the top-level agent");
    assert.equal(await rootOf(index, "root"), "root");

    // Building from a deep subagent gives the same whole tree as from the root.
    const fromGrand = await buildSessionTree(index, "root:sub:a2:sub:b1");
    const fromRoot = await buildSessionTree(index, "root");
    assert.ok(fromGrand && fromRoot);
    assert.equal(fromGrand.roots[0]!.session.id, "root");
    assert.equal(fromRoot.totals.sessions, 4);
    assert.deepEqual(
      fromRoot.roots[0]!.children.map((c) => c.session.id).sort(),
      ["root:sub:a1", "root:sub:a2"],
    );
    // The grandchild nests under the fixer.
    const fixer = fromRoot.roots[0]!.children.find((c) => c.session.id === "root:sub:a2")!;
    assert.equal(fixer.children[0]!.session.id, "root:sub:a2:sub:b1");
    assert.equal(fixer.depth, 1);
    assert.equal(fixer.children[0]!.depth, 2);

    const t = fromRoot.totals;
    assert.equal(t.usage.inputTokens, 1000 + 400 + 600 + 100);
    assert.equal(t.usage.outputTokens, 200 + 80 + 120 + 10);
    assert.ok(Math.abs((t.usage.costUsd ?? 0) - (0.1 + 0.04 + 0.2 + 0.01)) < 1e-9);
    assert.equal(t.toolCalls, 3 + 2 + 1 + 0);
    assert.ok(t.wallMs !== undefined && t.wallMs >= 100 * 1000, "wall spans the whole run");
    assert.ok(t.flags.includes("premature-completion"), "the subagent's flag rolls up to the loop");

    const worst = worstNode(fromRoot.roots);
    assert.equal(worst?.session.id, "root:sub:a2", "the flagged subagent is the one to fix first");
    assert.deepEqual(worstFirst(worst!.session.flags), ["premature-completion"]);
  });

  // A read of the newest N children counted N and dropped the first subagents.
  it("a fan-out wider than any page is read whole, oldest first", async () => {
    const index = new MemoryIndexStore();
    const WIDE = 1200;
    const kid = (i: number) => `wide:sub:${String(i).padStart(4, "0")}`;
    const root = session({ id: "wide", dt: 0, dur: 5000 });
    await index.upsertSession(root);
    for (let i = 0; i < WIDE; i++) await index.upsertSession(session({ id: kid(i), dt: 1 + i, dur: 2, startPayload: { source: "subagent", parentSessionId: "wide", subagentId: `k${i}`, subagentType: "reviewer" } }));
    await index.upsertSession(session({ id: `${kid(0)}:sub:g`, dt: 2, dur: 1, startPayload: { source: "subagent", parentSessionId: kid(0), subagentId: "g", subagentType: "searcher" } }));

    const tree = await buildSessionTree(index, kid(700));
    assert.equal(tree!.totals.sessions, WIDE + 2);
    assert.deepEqual(tree!.flat.slice(0, 4).map((x) => x.session.id), ["wide", kid(0), `${kid(0)}:sub:g`, kid(1)]);

    // The subagents under one session: the same walk, without the session itself.
    const subs = await subagentsOf(index, root);
    assert.equal(subs.length, WIDE);
    assert.deepEqual([subs[0]!.session.id, subs[0]!.depth, subs.at(-1)!.session.id], [kid(0), 1, kid(WIDE - 1)]);
    assert.deepEqual(subs[0]!.children.map((x) => [x.session.id, x.depth]), [[`${kid(0)}:sub:g`, 2]]);
    assert.deepEqual(await subagentsOf(index, subs[1]!.session), []);
  });
});

describe("a proxy-only subagent links from its calls", () => {
  it("a child session seen only through the proxy nests under the parent its calls name", async () => {
    const index = new MemoryIndexStore();
    const root = session({ id: "px-root", dt: 0, dur: 60, usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.05 } });
    // No session.start parent link: only the proxy calls carry the parent.
    const events: AgentEvent[] = [
      ev("px-root:sub:c1", "llm.call", 10, { ok: true, responseModel: "claude-sonnet-5", parentSessionId: "px-root", agentType: "reviewer", prompt: "review the diff" }, { model: "claude-sonnet-5", source: "proxy", usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.03 } }),
      ev("px-root:sub:c1", "llm.call", 20, { ok: true, responseModel: "claude-sonnet-5", parentSessionId: "px-root", agentType: "reviewer" }, { model: "claude-sonnet-5", source: "proxy", usage: { inputTokens: 200, outputTokens: 20, costUsd: 0.02 } }),
    ];
    const child = buildSession(events);
    assert.equal(child.parent?.sessionId, "px-root", "proxy call sets the parent");
    assert.equal(child.parent?.type, "reviewer");
    await index.upsertSession(root);
    await index.upsertSession(child);

    const tree = await buildSessionTree(index, "px-root");
    assert.ok(tree);
    assert.equal(tree.roots[0]!.children[0]!.session.id, "px-root:sub:c1");
    assert.equal(tree.totals.sessions, 2);
    assert.ok(Math.abs((tree.totals.usage.costUsd ?? 0) - 0.1) < 1e-9);
  });
});

describe("a fan-out of separate processes groups by run id", () => {
  it("every top-level agent of a run, and its subagents, form one tree", async () => {
    const index = new MemoryIndexStore();
    const RUN = "fanout-123";
    // Two separate top-level Claude Code processes share the run id; one spawned a subagent.
    const a = session({ id: "worker-a", dt: 0, dur: 40, runId: RUN, usage: { inputTokens: 300, outputTokens: 60, costUsd: 0.03 }, toolCalls: 2 });
    const b = session({ id: "worker-b", dt: 10, dur: 70, runId: RUN, usage: { inputTokens: 500, outputTokens: 90, costUsd: 0.07 }, toolCalls: 1 });
    const bSub = session({ id: "worker-b:sub:z1", dt: 20, dur: 20, runId: RUN, startPayload: { source: "subagent", parentSessionId: "worker-b", subagentId: "z1", subagentType: "tester" }, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } });
    // An unrelated session with no run id must not join.
    const other = session({ id: "unrelated", dt: 0, dur: 10 });
    for (const s of [a, b, bSub, other]) await index.upsertSession(s);

    const tree = await buildRunTree(index, RUN);
    assert.ok(tree);
    assert.equal(tree.runId, RUN);
    assert.deepEqual(tree.roots.map((r) => r.session.id), ["worker-a", "worker-b"], "both processes are roots, oldest first");
    assert.equal(tree.totals.sessions, 3, "three sessions in the run, not the unrelated one");
    assert.ok(Math.abs((tree.totals.usage.costUsd ?? 0) - 0.11) < 1e-9);
    assert.equal(tree.totals.toolCalls, 3);
    // worker-b's subagent nests under it.
    const wb = tree.roots.find((r) => r.session.id === "worker-b")!;
    assert.equal(wb.children[0]!.session.id, "worker-b:sub:z1");

    assert.equal(await buildRunTree(index, "no-such-run"), undefined);
  });
});

describe("guards", () => {
  it("a parent link cycle does not loop forever", async () => {
    const index = new MemoryIndexStore();
    const a = session({ id: "cyc-a", dt: 0, dur: 10, startPayload: { parentSessionId: "cyc-b" } });
    const b = session({ id: "cyc-b", dt: 1, dur: 10, startPayload: { parentSessionId: "cyc-a" } });
    await index.upsertSession(a);
    await index.upsertSession(b);
    const root = await rootOf(index, "cyc-a");
    assert.ok(root === "cyc-a" || root === "cyc-b");
    const tree = await buildSessionTree(index, "cyc-a");
    assert.ok(tree && tree.totals.sessions <= 2, "the cycle is broken, every session counted once");
  });

  it("treeTotals over an empty forest is zeroed", () => {
    const t = treeTotals([]);
    assert.equal(t.sessions, 0);
    assert.equal(t.toolCalls, 0);
    assert.deepEqual(t.flags, []);
    assert.equal(t.wallMs, undefined);
  });
});
