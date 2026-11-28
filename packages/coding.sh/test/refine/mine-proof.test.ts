// `refine mine` proof-failure detector: clusters recurring formal-verification
// checker failures across sessions, respects minSupport/runId/redaction, and
// stays silent on non-proof sessions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/core/types.ts";
import { findingId, formatFindings, mineFindings } from "../../src/refine/mine.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { sessionEvents } from "../helpers-decision.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const CWD = "/work/demo";

type Step = [AgentEvent["kind"], Record<string, unknown>];

const opening: Step[] = [["session.start", {}], ["user.message", { text: "Prove the module lemmas." }]];

const shellFail = (id: string, command: string, output: string): Step[] => [
  ["tool.start", { tool: "Bash", toolUseId: id, input: { command } }],
  ["tool.end", { tool: "Bash", toolUseId: id, ok: false, output }],
];

async function indexOf(sessions: { id: string; day: number; steps: Step[]; runId?: string }[]): Promise<MemoryIndexStore> {
  const index = new MemoryIndexStore();
  for (const s of sessions) {
    const opts: { cwd: string; startedAt: number; runId?: string } = { cwd: CWD, startedAt: T0 + s.day * DAY };
    if (s.runId) opts.runId = s.runId;
    const evs = sessionEvents(s.id, opts, s.steps);
    await index.putEvents(evs);
    const built = buildSession(evs);
    await index.upsertSession(s.runId ? { ...built, runId: s.runId } : built);
  }
  return index;
}

describe("refine mine proof-failure detector", () => {
  it("clusters recurring Lean, Verus, Dafny and slow whole-project failures into proof-failure patterns", async () => {
    const sessions = [
      {
        id: "p0",
        day: 0,
        steps: [
          ...opening,
          ...shellFail("p0-1", "lake env lean Proof/A.lean", "Proof/A.lean:12:4: error: simp made no progress\n⊢ x + 0 = x"),
          ...shellFail("p0-2", "verus src/a.rs", "error: assertion failed\n  --> src/a.rs:14:9"),
          ...shellFail("p0-3", "dafny verify src/A.dfy", "src/A.dfy(20,4): Error: failure to decrease termination metric"),
          ...shellFail("p0-4", "lake build", "Error: exec command timed out after 120000ms"),
        ],
      },
      {
        id: "p1",
        day: 0,
        steps: [
          ...opening,
          ...shellFail("p1-1", "lake env lean Proof/B.lean", "Proof/B.lean:88:2: error: simp made no progress\n⊢ y * 1 = y"),
          ...shellFail("p1-2", "verus src/b.rs", "error: assertion failed\n  --> src/b.rs:51:5"),
          ...shellFail("p1-3", "dafny verify src/B.dfy", "src/B.dfy(41,2): Error: failure to decrease termination metric"),
          ...shellFail("p1-4", "lake build", "Error: command timed out"),
        ],
      },
      {
        id: "p2",
        day: 1,
        steps: [
          ...opening,
          ...shellFail("p2-1", "lake env lean Proof/C.lean", "Proof/C.lean:5:6: error: simp made no progress"),
          ...shellFail("p2-2", "verus src/c.rs", "error: assertion failed\n  --> src/c.rs:9:1"),
          ...shellFail("p2-3", "dafny verify src/C.dfy", "src/C.dfy(9,1): Error: failure to decrease termination metric"),
          ...shellFail("p2-4", "lake build", "Error: exec command timed out after 90000ms"),
        ],
      },
    ];

    const r = await mineFindings({ index: await indexOf(sessions) });
    const proofs = r.findings.filter((f) => f.kind === "proof-failure");
    const labels = proofs.map((f) => f.label).sort();
    assert.deepEqual(labels, [
      "dafny: decreases failure",
      "lean: simp made no progress",
      "proof: slow whole-project build",
      "verus: assertion failed",
    ]);

    for (const f of proofs) {
      assert.equal(f.count, 3);
      assert.deepEqual(f.support, { sessions: 3, days: 2, repos: 1 });
      assert.equal(f.id, findingId("proof-failure", f.signature));
      assert.equal(f.impact.wastedToolCalls, 3);
    }

    const lines = formatFindings(proofs);
    assert.ok(lines.some((l) => /proof {2}3x in 3 sessions over 2 days: lean: simp made no progress/.test(l)));
  });

  it("respects minSupport, excludes runId sessions, and redacts secrets", async () => {
    const secret = ["sk-ant-api03-", "K".repeat(40)].join("");
    const mk = (id: string, day: number, runId?: string) => ({
      id,
      day,
      runId,
      steps: [
        ...opening,
        ...shellFail(`${id}-1`, "lake env lean Proof/Secret.lean", `Proof/Secret.lean:3:1: error: omega could not prove goal with token ${secret}`),
      ] as Step[],
    });

    const below = await mineFindings({ index: await indexOf([mk("o1", 0), mk("o2", 1), mk("e1", 1, "run_1"), mk("e2", 2, "run_2")]), evalRuns: false });
    assert.equal(below.findings.filter((f) => f.kind === "proof-failure").length, 0, "eval runs excluded, leaving only 2 organic sessions");

    const ok = await mineFindings({ index: await indexOf([mk("o1", 0), mk("o2", 0), mk("o3", 1)]), evalRuns: false });
    const found = ok.findings.filter((f) => f.kind === "proof-failure");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.label, "lean: omega could not prove");
    assert.ok(!JSON.stringify(ok).includes(secret), "secret is redacted from mined output");
    assert.ok(!formatFindings(found).join("\n").includes(secret));
  });

  it("normalizes Lean timeout, Rocq unify, Verus quantifier trigger and Dafny loop invariant and stays silent on non-proof sessions", async () => {
    const mkProof = (n: number, day: number) => ({
      id: `m${n}`,
      day,
      steps: [
        ...opening,
        ...shellFail(`m${n}-1`, "lake env lean Foo.lean", "Foo.lean:10:0: error: (deterministic) timeout at 'whnf'"),
        ...shellFail(`m${n}-2`, "coqc Bar.v", 'File "Bar.v", line 7, characters 2-9:\nError: Unable to unify "n + 0" with "n".'),
        ...shellFail(`m${n}-3`, "verus src/q.rs", "error: Could not automatically infer triggers for this quantifier"),
        ...shellFail(`m${n}-4`, "dafny verify Loop.dfy", "Loop.dfy(14,4): Error: This loop invariant might not be maintained by the loop."),
      ] as Step[],
    });

    const r = await mineFindings({ index: await indexOf([mkProof(0, 0), mkProof(1, 0), mkProof(2, 1)]) });
    assert.deepEqual(
      r.findings.filter((f) => f.kind === "proof-failure").map((f) => f.label).sort(),
      ["dafny: loop invariant", "lean: deterministic timeout", "rocq: unable to unify", "verus: quantifier trigger"],
    );

    const nonProof = [0, 1, 2].map((d) => ({
      id: `np${d}`,
      day: d,
      steps: [
        ...opening,
        ...shellFail(`np${d}-1`, "npx tsc --noEmit", "src/a.ts(3,1): error TS2307: Cannot find module './x.ts'."),
        ...shellFail(`np${d}-2`, "npm test", "AssertionError: expected 1 to equal 2"),
      ] as Step[],
    }));
    const np = await mineFindings({ index: await indexOf(nonProof) });
    assert.deepEqual(np.findings.filter((f) => f.kind === "proof-failure"), []);
  });
});
