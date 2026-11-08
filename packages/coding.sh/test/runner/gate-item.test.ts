import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../../src/core/types.ts";
import type { ExposureState } from "../../src/core/exposure.ts";
import { itemGate, levelLabel, resolveRecheck, singleItemChange, type ItemGateOpts } from "../../src/runner/gate-item.ts";

function run(taskId: string, bundleId: string, attempt: number, pass: boolean, extra: Partial<RunResult> = {}): RunResult {
  return {
    id: `${bundleId}-${taskId}-${attempt}`,
    taskId,
    bundleId,
    attempt,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "" },
    startedAt: 0,
    endedAt: 2000,
    ...extra,
  };
}

/** Per task: [baseline passes, candidate passes] out of k; A = baseline, B = candidate. */
function sweep(spec: Record<string, [number, number]>, k = 3): RunResult[] {
  const rs: RunResult[] = [];
  for (const [t, [pb, pc]] of Object.entries(spec)) {
    for (let a = 1; a <= k; a++) {
      rs.push(run(t, "A", a, a <= pb));
      rs.push(run(t, "B", a, a <= pc));
    }
  }
  return rs;
}

/** Exposure for every run of `arm`, `state` by default, overridden per task. */
function exposure(rs: readonly RunResult[], arm: string, state: ExposureState = "in-context", per: Record<string, ExposureState> = {}): Map<string, ExposureState> {
  return new Map(rs.filter((r) => r.bundleId === arm).map((r) => [r.id, per[r.taskId] ?? state]));
}

const add = (rs: RunResult[], o: Partial<ItemGateOpts> = {}) => itemGate(rs, { baseline: "A", candidate: "B", mode: "add", exposure: exposure(rs, "B"), ...o });
const remove = (rs: RunResult[], o: Partial<ItemGateOpts> = {}) => itemGate(rs, { baseline: "A", candidate: "B", mode: "remove", exposure: exposure(rs, "A"), ...o });

describe("itemGate: additions", () => {
  it("paper example A: one task 2/3 → 0 drops .67 > τ, otherwise winning → RECHECK [t1]", () => {
    const g = add(sweep({ t1: [2, 0], t2: [0, 3], t3: [0, 3], t4: [1, 3] }));
    assert.equal(g.verdict, "RECHECK");
    assert.deepEqual(g.recheck, ["t1"]);
    assert.ok(Math.abs(g.D - 2 / 3) < 1e-9);
    assert.deepEqual(g.S, ["t1", "t2", "t3", "t4"]);
    assert.equal(g.kN, 6);
    assert.match(g.reasons[0] as string, /^g2: worst drop \.67 > τ \.34 \(t1\)$/);
  });

  it("paper example B: two tasks 2/3 → 1/3 each pass g2 (same summed regression as A)", () => {
    const g = add(sweep({ t1: [2, 1], t2: [2, 1], t3: [0, 3], t4: [0, 3] }));
    assert.ok(Math.abs(g.D - 1 / 3) < 1e-9);
    assert.equal(g.verdict, "KEEP");
    assert.deepEqual(g.reasons, []);
  });

  it("a task solved 3/3 that drops to 2/3 → RECHECK; a repeat drop kills, a clean recheck keeps", () => {
    const first = add(sweep({ t1: [3, 2], t2: [0, 3], t3: [0, 3] }));
    assert.equal(first.verdict, "RECHECK");
    assert.deepEqual(first.recheck, ["t1"]);
    assert.deepEqual(first.P, ["t1"]);
    assert.match(first.reasons.join("\n"), /^g3: a task solved every run without the change lost a run \(t1 3\/3 → 2\/3\)$/m);
    const again = resolveRecheck(first, sweep({ t1: [3, 2] }), { baseline: "A", candidate: "B" });
    assert.equal(again.verdict, "KILL");
    assert.deepEqual(again.reasons, ["regression recurred: t1"]);
    const clean = resolveRecheck(first, sweep({ t1: [3, 3] }), { baseline: "A", candidate: "B" });
    assert.equal(clean.verdict, "KEEP");
    assert.equal(clean.recheck, undefined);
    // Runs of other tasks in the recheck results are ignored.
    assert.equal(resolveRecheck(first, sweep({ t1: [3, 3], t9: [3, 0] }), { baseline: "A", candidate: "B" }).verdict, "KEEP");
    // A short recheck is not scorable.
    assert.equal(resolveRecheck(first, sweep({ t1: [2, 2] }, 2), { baseline: "A", candidate: "B" }).verdict, "RERUN");
  });

  it("a one-run net win does not count: net +1 → KILL (g4)", () => {
    const g = add(sweep({ t1: [1, 2], t2: [2, 2] }));
    assert.equal(g.verdict, "KILL");
    assert.equal(g.kN, 1);
    assert.deepEqual(g.reasons, ["g4: net +1 run < 2"]);
  });

  it("no improvement plus a big drop is KILL, not RECHECK", () => {
    const g = add(sweep({ t1: [2, 0], t2: [1, 1] }));
    assert.equal(g.verdict, "KILL");
    assert.ok(g.reasons.some((r) => r.startsWith("g1:")) && g.reasons.some((r) => r.startsWith("g2:")));
    assert.equal(g.recheck, undefined);
  });

  it("an item that was never in context → RERUN (S empty)", () => {
    const rs = sweep({ t1: [0, 3], t2: [0, 3] });
    const g = add(rs, { exposure: exposure(rs, "B", "not") });
    assert.equal(g.verdict, "RERUN");
    assert.deepEqual(g.S, []);
    assert.deepEqual(g.reasons, ["the item was never in context, so no task measures it"]);
    // A listed-but-unopened skill is not in context either.
    assert.equal(add(rs, { exposure: exposure(rs, "B", "listed") }).verdict, "RERUN");
  });

  it("tasks where the item never loaded do not count toward G, N or D", () => {
    const rs = sweep({ t1: [0, 3], t2: [0, 2], t3: [3, 0], t4: [2, 0] });
    const g = add(rs, { exposure: exposure(rs, "B", "in-context", { t3: "not", t4: "listed" }) });
    assert.deepEqual(g.S, ["t1", "t2"]);
    assert.equal(g.D, 0);
    assert.equal(g.kN, 5);
    assert.ok(Math.abs(g.G - 5 / 3) < 1e-9);
    assert.ok(Math.abs(g.N - 5 / 3) < 1e-9);
    assert.deepEqual(g.f, { fired: 6, rollouts: 12 });
    assert.equal(g.verdict, "KEEP");
  });

  it("every exposed task already passed every run without the item → RERUN", () => {
    const g = add(sweep({ t1: [3, 3], t2: [3, 3] }));
    assert.equal(g.verdict, "RERUN");
    assert.match(g.reasons[0] as string, /nothing to gain/);
  });

  it("kN is whole runs at k=2 and k=3 (no float ties at m)", () => {
    const k2 = add(sweep({ t1: [0, 1], t2: [0, 1] }, 2));
    assert.equal(k2.k, 2);
    assert.equal(k2.kN, 2);
    assert.equal(k2.verdict, "KEEP");
    const k3 = add(sweep({ t1: [0, 1], t2: [1, 2], t3: [2, 3] }));
    assert.ok(Number.isInteger(k3.kN));
    assert.equal(k3.kN, 3);
    assert.equal(k3.verdict, "KEEP");
    const k3b = add(sweep({ t1: [0, 1], t2: [1, 2] }));
    assert.equal(k3b.kN, 2);
    assert.equal(k3b.verdict, "KEEP");
  });
});

describe("itemGate: scorability (RERUN)", () => {
  it("one rollout with unknown exposure → RERUN", () => {
    const rs = sweep({ t1: [0, 3], t2: [0, 3] });
    const ex = exposure(rs, "B");
    ex.delete("B-t2-3");
    const g = add(rs, { exposure: ex });
    assert.equal(g.verdict, "RERUN");
    assert.deepEqual(g.reasons, ["exposure unknown on 1 of 6 candidate rollouts (no captured trace)"]);
  });

  it("two agent versions → RERUN", () => {
    const rs = sweep({ t1: [0, 3], t2: [0, 3] });
    const versions = new Map(rs.map((r) => [r.id, r.bundleId === "A" ? "2.1.0" : "2.2.0"]));
    const g = add(rs, { agentVersions: versions });
    assert.equal(g.verdict, "RERUN");
    assert.deepEqual(g.reasons, ["2 agent versions across runs (2.1.0, 2.2.0)"]);
    // One version (or none recorded) is fine.
    assert.equal(add(rs, { agentVersions: new Map(rs.map((r) => [r.id, "2.1.0"])) }).verdict, "KEEP");
  });

  it("4 of 30 runs errored (> 10%) → RERUN, and the errored tasks are incomplete", () => {
    const rs = sweep({ t1: [0, 3], t2: [0, 3], t3: [0, 3], t4: [1, 3], t5: [1, 3] });
    for (const id of ["A-t1-1", "B-t2-2", "A-t3-3", "B-t4-1"]) Object.assign(rs.find((r) => r.id === id)!, { error: "agent crashed" });
    const g = add(rs);
    assert.equal(g.verdict, "RERUN");
    assert.equal(g.invalid.runs, 4);
    assert.equal(g.invalid.of, 30);
    assert.ok(g.reasons.some((r) => r.startsWith("incomplete sweep: 4 tasks without 3 valid runs per arm")));
    assert.ok(g.reasons.includes("4 of 30 runs invalid (errored or cancelled) > 10%"));
  });

  it("cancelled runs are invalid; a task missing from one arm makes the sweep incomplete", () => {
    const rs = sweep({ t1: [0, 3], t2: [0, 3] });
    rs.push(run("t3", "A", 1, true), run("t3", "A", 2, true), run("t3", "A", 3, true));
    const g = add(rs);
    assert.equal(g.verdict, "RERUN");
    assert.match(g.reasons[0] as string, /^incomplete sweep: 1 task without 3 valid runs per arm \(t3\)$/);
  });
});

describe("itemGate: removals", () => {
  it("never fired in the base arm, with known exposure → UNMEASURED (keep)", () => {
    const rs = sweep({ t1: [1, 0], t2: [1, 1] });
    const g = remove(rs, { exposure: exposure(rs, "A", "not") });
    assert.equal(g.verdict, "UNMEASURED");
    assert.deepEqual(g.reasons, ["never fired in base rollouts; keep"]);
    assert.equal(g.f.fired, 0);
  });

  it("removal costs 2 runs net → REJECT", () => {
    const g = remove(sweep({ t1: [2, 1], t2: [2, 1], t3: [1, 1] }));
    assert.equal(g.verdict, "REJECT");
    assert.equal(g.kN, -2);
    assert.deepEqual(g.reasons, ["net −2 runs ≤ −2"]);
  });

  it("removal net 0, D = .33, no solved task loses a run, U ≥ .8 → ACCEPT", () => {
    const g = remove(sweep({ t1: [2, 1], t2: [2, 3], t3: [3, 3], t4: [3, 3], t5: [3, 3] }));
    assert.equal(g.verdict, "ACCEPT");
    assert.equal(g.kN, 0);
    assert.ok(Math.abs(g.D - 1 / 3) < 1e-9);
    assert.deepEqual(g.reasons, []);
    assert.ok(Math.abs(g.level!.U - 13 / 15) < 1e-9);
    assert.deepEqual(g.level!.labels, { between: 2, internalized: 3 });
  });

  it("the same gain-neutral removal with a low U → UNMEASURED, not ACCEPT (AC-12)", () => {
    const g = remove(sweep({ t1: [2, 1], t2: [1, 2] }));
    assert.equal(g.verdict, "UNMEASURED");
    assert.deepEqual(g.level, { U: 0.5, A: 0.5, labels: { between: 2 } });
    assert.match(g.reasons[0] as string, /^pass rate without the item \.50 is below the retire level \.80; .*; keep$/);
  });

  it("removal that costs a task solved every run one run → REJECT; a big drop → REJECT", () => {
    assert.equal(remove(sweep({ t1: [3, 2], t2: [1, 2] })).verdict, "REJECT");
    const g = remove(sweep({ t1: [2, 0], t2: [0, 2] }));
    assert.equal(g.verdict, "REJECT");
    assert.deepEqual(g.reasons, ["worst drop .67 > τ .34 (t1)"]);
  });

  it("removal reads exposure from the baseline arm", () => {
    const rs = sweep({ t1: [2, 1], t2: [1, 2] });
    // Candidate exposure only: the item arm (A) is all unknown.
    assert.equal(remove(rs, { exposure: exposure(rs, "B") }).verdict, "RERUN");
  });
});

describe("singleItemChange", () => {
  it("one added rule, one removed skill dir, one context file", () => {
    assert.deepEqual(singleItemChange({ added: [".claude/rules/clock.md"], removed: [] }, false), { mode: "add", path: ".claude/rules/clock.md" });
    assert.deepEqual(singleItemChange({ added: [], removed: [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/fill.py"] }, false), {
      mode: "remove",
      path: ".claude/skills/pdf/SKILL.md",
    });
    assert.deepEqual(singleItemChange({ added: ["AGENTS.md"], removed: [] }, false), { mode: "add", path: "AGENTS.md" });
  });
  it("anything else changing, two items, or a non-item file → none", () => {
    assert.equal(singleItemChange({ added: [".claude/rules/a.md"], removed: [] }, true), undefined);
    assert.equal(singleItemChange({ added: [".claude/rules/a.md", ".claude/rules/b.md"], removed: [] }, false), undefined);
    assert.equal(singleItemChange({ added: [".claude/rules/a.md", ".claude/hooks/x.sh"], removed: [] }, false), undefined);
    assert.equal(singleItemChange({ added: [".mcp.json"], removed: [] }, false), undefined);
    assert.equal(singleItemChange({ added: [".claude/rules/a.md"], removed: ["CLAUDE.md"] }, false), undefined);
    assert.equal(singleItemChange({ added: [], removed: [] }, false), undefined);
  });
});

// Wang et al., arXiv 2610.32322: retire on a high pass rate without the item, not on gain alone.
describe("itemGate: removal levels (AC-12)", () => {
  const four = (pb: number, pc: number) => sweep({ t1: [pb, pc], t2: [pb, pc], t3: [pb, pc], t4: [pb, pc] });

  it("4 × 0/3 → 0/3 → UNCOVERED, every task uncovered", () => {
    const g = remove(four(0, 0));
    assert.equal(g.verdict, "UNCOVERED");
    assert.deepEqual(g.level, { U: 0, A: 0, labels: { uncovered: 4 } });
    assert.deepEqual(g.reasons, ["neither arm solves the exposed tasks (U 0, A 0): the item does not deliver what it teaches; keep and repair it, or check the tasks"]);
  });

  it("4 × 3/3 → 3/3 → ACCEPT, every task internalized", () => {
    const g = remove(four(3, 3));
    assert.equal(g.verdict, "ACCEPT");
    assert.deepEqual(g.level, { U: 1, A: 1, labels: { internalized: 4 } });
    assert.deepEqual(g.reasons, []);
  });

  it("4 × 2/3 → 2/3 → UNMEASURED with the retire reason", () => {
    const g = remove(four(2, 2));
    assert.equal(g.verdict, "UNMEASURED");
    assert.equal(g.reasons.length, 1);
    assert.match(g.reasons[0] as string, /^pass rate without the item \.67 is below the retire level \.80/);
  });

  it("one task 3/3 → 2/3 is still REJECT", () => {
    assert.equal(remove(sweep({ t1: [3, 2] })).verdict, "REJECT");
  });

  it("one task 2/3 → 3/3 → ACCEPT, with the add-tasks note", () => {
    const g = remove(sweep({ t1: [2, 3] }));
    assert.equal(g.verdict, "ACCEPT");
    assert.deepEqual(g.reasons, ["near the retire level on 1 task: add tasks rather than runs (arXiv 2610.32322)"]);
  });

  it("never fired and incomplete sweeps are unchanged; add mode carries no levels", () => {
    const rs = four(0, 0);
    assert.equal(remove(rs, { exposure: exposure(rs, "A", "not") }).verdict, "UNMEASURED");
    assert.equal(remove(rs, { exposure: exposure(rs, "A", "not") }).level, undefined);
    assert.equal(remove(rs.filter((r) => !(r.taskId === "t1" && r.attempt === 3))).verdict, "RERUN");
    const a = add(sweep({ t1: [0, 3], t2: [1, 3] }));
    assert.equal(a.level, undefined);
    assert.ok(a.tasks.every((t) => t.label === undefined));
  });

  it("a removal that wins m runs net is ACCEPT below the retire level (the item hurts); both low stays UNCOVERED", () => {
    const g = remove(sweep({ sum: [0, 0], mul: [0, 3] }));
    assert.equal(g.verdict, "ACCEPT");
    assert.deepEqual(g.level!.labels, { uncovered: 1, hurts: 1 });
    assert.deepEqual(g.reasons, ["removing the item wins +3 runs net, so it hurts; the pass rate without it (.50) is still below the retire level .80"]);
    assert.equal(remove(four(0, 1)).verdict, "UNCOVERED");
  });

  it("custom levels move the retire line", () => {
    assert.equal(remove(four(2, 2), { levels: { retire: 0.6 } }).verdict, "ACCEPT");
  });

  it("labels at the .7 and .4 boundaries", () => {
    assert.equal(levelLabel(0.7, 0.7), "internalized");
    assert.equal(levelLabel(0.7 - 1e-12, 0.7), "internalized"); // within 1e-9
    assert.equal(levelLabel(0.69, 0.7), "between");
    assert.equal(levelLabel(0.7, 0.39), "works");
    assert.equal(levelLabel(0.7, 0.4), "between");
    assert.equal(levelLabel(0.39, 0.39), "uncovered");
    assert.equal(levelLabel(0.39, 0.7), "hurts");
    assert.equal(levelLabel(0.4, 0.4), "between");
  });
});
