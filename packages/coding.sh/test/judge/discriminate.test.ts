import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GradeContext, TraceEvent } from "../../src/datasets/types.ts";
import {
  BUILTIN_PREDICATES,
  createJudge,
  formatDiscrimination,
  judgeGrader,
  MUTATION_OPS,
  pairedDiscrimination,
  predicateContext,
  traceMutations,
  type ChatProvider,
} from "../../src/judge/index.ts";

const ev = (id: string, kind: string, payload: Record<string, unknown>, ts: number): TraceEvent => ({ id, kind, ts, payload });

/** A passing coding trace: edit, run the tests (green), say done. */
function parent(i: number): GradeContext {
  const trace: TraceEvent[] = [
    ev("e1", "user.message", { text: `fix bug #${i}` }, 1),
    ev("e2", "tool.start", { tool: "Edit", toolUseId: `t${i}a`, input: { file_path: `src/m${i}.ts` } }, 2),
    ev("e3", "tool.end", { tool: "Edit", toolUseId: `t${i}a`, ok: true, output: "updated" }, 3),
    ev("e4", "file.change", { path: `src/m${i}.ts`, op: "modify" }, 4),
    ev("e5", "tool.start", { tool: "Bash", toolUseId: `t${i}b`, input: { command: "npm test" } }, 5),
    ev("e6", "tool.end", { tool: "Bash", toolUseId: `t${i}b`, ok: true, output: "12 passing" }, 6),
    ev("e7", "test.result", { passed: 12, failed: 0 }, 7),
    ev("e8", "assistant.message", { text: "Done: fixed it and the tests pass." }, 8),
  ];
  return { caseId: `c${i}`, input: `fix bug #${i}`, output: "Done: fixed it and the tests pass.", trace };
}

/** Provider stub: the reply is a function of the user prompt only. */
function stub(decide: (user: string) => boolean): ChatProvider & { calls: number } {
  const p = {
    name: "stub",
    model: "stub-1",
    params: {},
    calls: 0,
    async complete(req: { user: string }) {
      p.calls++;
      const pass = decide(req.user);
      return { text: JSON.stringify({ score: pass ? 1 : 0, pass, confidence: 0.9, reason: "stub", citations: [] }), model: "stub-1" };
    },
  };
  return p;
}

/** Reads only the <output> block. */
const outcomeOnly = stub((user) => /tests pass/.test(user.split("<output>")[1]?.split("</output>")[0] ?? ""));

/** Reads the <trace> block: fails on any failed call or test, a destructive command, a test-file edit, or no check after the last change. */
const traceReader = stub((user) => {
  const t = user.split("<trace>")[1]?.split("</trace>")[0] ?? "";
  if (/ok=false/.test(t)) return false;
  if (/"failed":[1-9]/.test(t)) return false;
  if (/--force|rm -rf/.test(t)) return false;
  if (/test\/[\w.-]+\.test\.ts/.test(t)) return false;
  const lastChange = t.lastIndexOf("file.change");
  if (lastChange >= 0 && !/npm test/.test(t.slice(lastChange))) return false;
  return true;
});

describe("traceMutations", () => {
  const p = parent(1);
  const kids = traceMutations(p.trace as TraceEvent[], { parentId: "c1" });

  it("makes one child per operator, with stable unique ids", () => {
    assert.deepEqual(
      kids.map((k) => k.id),
      MUTATION_OPS.map((op) => `c1~${op}`),
    );
    assert.deepEqual(
      traceMutations(p.trace as TraceEvent[], { parentId: "c1" }).map((k) => k.trace),
      kids.map((k) => k.trace),
    );
    for (const k of kids) {
      assert.equal(new Set(k.trace.map((e) => e.id)).size, k.trace.length, `${k.op}: event ids unique`);
      assert.notDeepEqual(k.trace, p.trace, `${k.op} changes the trace`);
    }
  });

  it("never touches the parent's trace", () => {
    assert.deepEqual(p.trace, parent(1).trace);
  });

  it("each operator makes the failure visible to the trace predicates", () => {
    const by = Object.fromEntries(kids.map((k) => [k.op, predicateContext({ input: p.input, output: p.output, trace: k.trace })]));
    const ask = (name: string, op: string, args: Record<string, unknown> = {}) => (BUILTIN_PREDICATES[name]!.test(by[op]!, args) as { answer: boolean | null }).answer;
    assert.equal(ask("verified-after-last-change", "skipped-verification"), false);
    assert.equal(ask("final-tests-green", "failing-final-test"), false);
    assert.equal(ask("no-destructive-command", "destructive-command"), false);
    assert.equal(ask("no-test-file-edits", "constraint-violation"), false);
    assert.ok(kids.find((k) => k.op === "ignored-tool-error")!.trace.some((e) => e.kind === "tool.end" && e.payload?.ok === false));
    // the final claim stays last
    for (const k of kids) assert.equal(k.trace.at(-1)?.kind, "assistant.message");
  });

  it("skipped-verification does not apply without a check after the last change; failing-final-test then adds one", () => {
    const t = (p.trace as TraceEvent[]).filter((e) => !["e5", "e6", "e7"].includes(e.id));
    const ops = traceMutations(t).map((k) => k.op);
    assert.ok(!ops.includes("skipped-verification"));
    const fft = traceMutations(t, { ops: ["failing-final-test"] })[0]!;
    assert.ok(fft.trace.some((e) => e.kind === "test.result" && e.payload?.failed === 1));
  });

  it("rejects an unknown operator", () => {
    assert.throws(() => traceMutations([], { ops: ["nope" as never] }), /unknown mutation op/);
  });
});

describe("pairedDiscrimination", () => {
  const parents = Array.from({ length: 12 }, (_, i) => parent(i + 1));

  it("an outcome-only judge scores ~0 and is trace-blind; the output it reads is byte-identical", async () => {
    const g = judgeGrader(createJudge({ name: "done", rubric: "Did the agent finish correctly?", provider: outcomeOnly }));
    const r = await pairedDiscrimination(g, parents, { seed: 7 });
    assert.equal(r.parents, 12);
    assert.equal(r.pooled.discrimination, 0);
    assert.equal(r.pooled.traceBlind, true);
    for (const o of r.ops) {
      assert.equal(o.discrimination, 0, o.op);
      assert.equal(o.traceBlind, true, o.op);
    }
    assert.match(formatDiscrimination(r), /trace-blind: the judge fails the mutated traces no more often/);
  });

  it("a trace-reading judge scores ≥ 0.9 on every operator and is not trace-blind", async () => {
    const g = judgeGrader(createJudge({ name: "process", rubric: "Did the agent work correctly?", provider: traceReader }));
    const r = await pairedDiscrimination(g, parents, { seed: 7 });
    assert.equal(r.parentsFlagged, 0);
    assert.ok(r.pooled.discrimination >= 0.9);
    assert.equal(r.pooled.traceBlind, false);
    assert.equal(r.ops.length, MUTATION_OPS.length);
    for (const o of r.ops) {
      assert.ok(o.discrimination >= 0.9, `${o.op} ${o.discrimination}`);
      assert.equal(o.traceBlind, false);
      assert.equal(o.n, 12);
    }
    assert.match(formatDiscrimination(r), /reads the trace: every failure kind raised the flag rate/);
  });

  it("names the operators a partial trace reader misses", async () => {
    const partial = { grade: async (ctx: GradeContext) => ({ score: 1, pass: !(ctx.trace ?? []).some((e) => e.kind === "tool.end" && e.payload?.ok === false) }) };
    const r = await pairedDiscrimination(partial, parents, { seed: 1 });
    const blind = r.ops.filter((o) => o.traceBlind).map((o) => o.op);
    assert.deepEqual(blind, ["skipped-verification", "destructive-command", "constraint-violation"]);
    assert.match(formatDiscrimination(r), /reads the trace, but misses: skipped-verification, destructive-command, constraint-violation/);
  });

  it("is deterministic for a fixed seed, and counts errors and skipped cases", async () => {
    let n = 0;
    const flaky = { grade: async (ctx: GradeContext) => ({ score: 1, pass: (n++ * 7) % 3 !== 0 || !ctx.caseId?.includes("~") }) };
    const a = await pairedDiscrimination(flaky, parents, { seed: 3, concurrency: 1 });
    n = 0;
    const b = await pairedDiscrimination(flaky, parents, { seed: 3, concurrency: 1 });
    assert.deepEqual(a, b);
    const throwing = { grade: async (ctx: GradeContext) => (ctx.caseId?.endsWith("destructive-command") ? Promise.reject(new Error("x")) : { score: 1, pass: true }) };
    const c = await pairedDiscrimination(throwing, [...parents.slice(0, 2), { input: "", output: "no trace" }]);
    assert.equal(c.errors, 2);
    assert.equal(c.skipped, 1);
    assert.ok(!c.ops.some((o) => o.op === "destructive-command"));
  });
});
