// Y-6: scoring diagnoses against labels by code (Signals, arXiv 2611.04507v2
// §6.1-6.4): name normalization, maximum one-to-one matching, P/R/F1,
// Signal coverage and matching, session presence and repeat agreement.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flagPrecision,
  flagPredictions,
  maxMatching,
  normalizeComponentName,
  occurrencesMatch,
  parseLabels,
  repeatAgreement,
  scoreOccurrences,
  scoreSignals,
  sessionPresence,
  signalCoverage,
  type Occurrence,
} from "../../src/refine/index.ts";

const occ = (sessionId: string, signalId: string, name: string, typeIds: string[], type: "tool" | "agent" = "tool"): Occurrence => ({ sessionId, signalId, component: { type, name }, typeIds });

describe("normalizeComponentName", () => {
  it("treats case, camelCase, separators and Unicode width alike", () => {
    for (const s of ["createPayment", "create_payment", "Create Payment", "create-payment", " create.payment ", "CreatePayment", "ｃreate＿payment", "ｃreatePayment"]) assert.equal(normalizeComponentName(s), "create-payment", s);
    assert.equal(normalizeComponentName("HTTPServer"), "http-server");
    assert.equal(normalizeComponentName("s3Bucket"), normalizeComponentName("s3_bucket"));
    assert.equal(normalizeComponentName("v2"), "v-2");
    assert.notEqual(normalizeComponentName("createPayment"), normalizeComponentName("createPayments"));
  });
});

describe("maxMatching", () => {
  it("finds the maximum, not the greedy, matching", () => {
    const L = [{ id: "A" }, { id: "B" }];
    const R = [{ id: "r1" }, { id: "r2" }];
    const edges = new Set(["A-r1", "A-r2", "B-r1"]);
    const pairs = maxMatching(L, R, (l, r) => edges.has(`${l.id}-${r.id}`));
    assert.deepEqual(
      pairs.map(([l, r]) => `${l.id}-${r.id}`),
      ["A-r2", "B-r1"],
    );
    assert.deepEqual(maxMatching([...L].reverse(), [...R].reverse(), (l, r) => edges.has(`${l.id}-${r.id}`)), pairs);
  });

  it("is one-to-one", () => {
    const pairs = maxMatching([{ id: "a" }, { id: "b" }], [{ id: "x" }], () => true);
    assert.equal(pairs.length, 1);
  });
});

describe("scoreOccurrences", () => {
  it("never matches across sessions", () => {
    assert.equal(occurrencesMatch(occ("s1", "x", "Edit", ["tool.invalid-args"]), occ("s2", "x", "Edit", ["tool.invalid-args"])), false);
    const s = scoreOccurrences([occ("s1", "x", "Edit", ["tool.invalid-args"])], [occ("s2", "x", "Edit", ["tool.invalid-args"])]);
    assert.deepEqual([s.tp, s.fp, s.fn], [0, 1, 1]);
  });

  it("needs the same component type and normalized name", () => {
    assert.equal(occurrencesMatch(occ("s", "x", "createPayment", ["tool.invalid-args"]), occ("s", "y", "create_payment", ["tool.invalid-args"])), true);
    assert.equal(occurrencesMatch(occ("s", "x", "Edit", ["tool.invalid-args"], "agent"), occ("s", "x", "Edit", ["tool.invalid-args"], "tool")), false);
    assert.equal(occurrencesMatch(occ("s", "x", "Edit", ["tool.invalid-args"]), occ("s", "x", "Write", ["tool.invalid-args"])), false);
  });

  it("matches through the 3rd-ranked candidate, and ignores a 4th", () => {
    const ref = occ("s", "x", "Bash", ["eff.retry-thrash"]);
    assert.equal(occurrencesMatch(occ("s", "y", "Bash", ["tool.invalid-args", "tool.wrong-tool", "eff.retry-thrash"]), ref), true);
    assert.equal(occurrencesMatch(occ("s", "y", "Bash", ["tool.invalid-args", "tool.wrong-tool", "tool.call-omitted", "eff.retry-thrash"]), ref), false);
  });

  it("uses a maximum matching: pred A fits ref 1 and 2, pred B only ref 1 -> 2 matches", () => {
    // A sorts first and takes ref 1 (error-unhandled sorts first); only an augmenting path frees it for B.
    const ref = [occ("s", "r", "Bash", ["tool.invalid-args"]), occ("s", "r", "Bash", ["tool.error-unhandled"])];
    const pred = [occ("s", "a", "Bash", ["tool.invalid-args", "tool.error-unhandled"]), occ("s", "b", "Bash", ["tool.error-unhandled"])];
    const s = scoreOccurrences(pred, ref);
    assert.equal(s.tp, 2);
    assert.deepEqual([s.fp, s.fn], [0, 0]);
  });

  it("3 predictions, 2 labels, 2 matched -> P 2/3, R 1, F1 0.8", () => {
    const ref = [occ("s1", "a", "Edit", ["tool.invalid-args"]), occ("s2", "b", "Bash", ["eff.retry-thrash"])];
    const pred = [occ("s1", "x", "Edit", ["tool.invalid-args"]), occ("s2", "y", "Bash", ["eff.retry-thrash"]), occ("s2", "z", "Read", ["ctx.stale-context"])];
    const s = scoreOccurrences(pred, ref);
    assert.deepEqual([s.tp, s.fp, s.fn], [2, 1, 0]);
    assert.equal(s.precision, 2 / 3);
    assert.equal(s.recall, 1);
    assert.ok(Math.abs(s.f1 - 0.8) < 1e-12);
    assert.equal(s.empty, undefined);
    assert.deepEqual(s.byFamily, { tool: { n: 1, tp: 1, recall: 1 }, eff: { n: 1, tp: 1, recall: 1 } });
  });

  it("per-family recall keeps misses in the denominator", () => {
    const ref = [occ("s1", "a", "Edit", ["tool.invalid-args"]), occ("s1", "b", "Bash", ["tool.error-unhandled"]), occ("s1", "c", "agent", ["out.false-success"], "agent")];
    const s = scoreOccurrences([occ("s1", "x", "Edit", ["tool.invalid-args"])], ref);
    assert.deepEqual(s.byFamily, { out: { n: 1, tp: 0, recall: 0 }, tool: { n: 2, tp: 1, recall: 0.5 } });
  });

  it("empty sides give NaN and say so, never 1", () => {
    const none = scoreOccurrences([], []);
    assert.ok(Number.isNaN(none.precision) && Number.isNaN(none.recall) && Number.isNaN(none.f1));
    assert.deepEqual(none.empty, ["precision", "recall", "f1"]);
    const noPred = scoreOccurrences([], [occ("s", "a", "Edit", ["tool.invalid-args"])]);
    assert.ok(Number.isNaN(noPred.precision));
    assert.equal(noPred.recall, 0);
    assert.equal(noPred.f1, 0);
    assert.deepEqual(noPred.empty, ["precision"]);
    assert.deepEqual(sessionPresence([], []).empty, ["precision", "recall", "f1"]);
    assert.equal(signalCoverage([], []).empty, true);
    assert.ok(Number.isNaN(signalCoverage([], []).atLeastOneRate));
  });

  it("gives identical results for shuffled inputs", () => {
    const ref = [occ("s1", "a", "Edit", ["tool.invalid-args"]), occ("s1", "a", "Edit", ["tool.invalid-args"]), occ("s1", "b", "Bash", ["tool.error-unhandled"]), occ("s2", "c", "Bash", ["eff.retry-thrash"]), occ("s3", "c", "Bash", ["eff.retry-thrash"])];
    const pred = [occ("s1", "x", "edit", ["tool.invalid-args", "tool.error-unhandled"]), occ("s1", "y", "Bash", ["tool.error-unhandled", "tool.invalid-args"]), occ("s1", "x", "EDIT", ["tool.invalid-args"]), occ("s2", "z", "bash", ["eff.retry-thrash"]), occ("s4", "z", "Bash", ["eff.retry-thrash"])];
    const a = JSON.stringify({ o: scoreOccurrences(pred, ref), s: scoreSignals(pred, ref), p: sessionPresence(pred, ref), c: signalCoverage(scoreOccurrences(pred, ref).pairs, ref) });
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 20; k++) {
      const sh = <T>(xs: T[]) => xs.map((x) => [rnd(), x] as const).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
      const p2 = sh(pred);
      const r2 = sh(ref);
      assert.equal(JSON.stringify({ o: scoreOccurrences(p2, r2), s: scoreSignals(p2, r2), p: sessionPresence(p2, r2), c: signalCoverage(scoreOccurrences(p2, r2).pairs, r2) }), a);
    }
  });
});

describe("Signals and sessions", () => {
  it("coverage: 2 of 4 matched counts for >=1 and >=half, 1 of 4 only for >=1", () => {
    const ref = [
      ...["s1", "s2", "s3", "s4"].map((s) => occ(s, "A", "Edit", ["tool.invalid-args"])),
      ...["s1", "s2", "s3", "s4"].map((s) => occ(s, "B", "Bash", ["eff.retry-thrash"])),
      occ("s5", "C", "Read", ["ctx.stale-context"]),
    ];
    const pred = [occ("s1", "x", "Edit", ["tool.invalid-args"]), occ("s2", "x", "Edit", ["tool.invalid-args"]), occ("s1", "y", "Bash", ["eff.retry-thrash"])];
    const c = signalCoverage(scoreOccurrences(pred, ref).pairs, ref);
    assert.deepEqual(c, { signals: 3, atLeastOne: 2, atLeastHalf: 1, atLeastOneRate: 2 / 3, atLeastHalfRate: 1 / 3 });
  });

  it("Signal matching ignores occurrence counts", () => {
    const ref = ["s1", "s2", "s3", "s4", "s5"].map((s) => occ(s, "edit-misses", "Edit", ["tool.invalid-args"]));
    const pred = [occ("s9", "p1", "edit", ["tool.contract-mismatch", "tool.invalid-args"])];
    const s = scoreSignals(pred, ref);
    assert.deepEqual([s.tp, s.fp, s.fn], [1, 0, 0]);
    assert.deepEqual(s.pairs, [{ pred: "p1", ref: "edit-misses" }]);
    const two = scoreSignals([...pred, occ("s1", "p2", "Edit", ["tool.invalid-args"])], ref);
    assert.deepEqual([two.tp, two.fp, two.fn], [1, 1, 0]);
  });

  it("Signals in different batches do not match", () => {
    const ref = [occ("s1", "A", "Edit", ["tool.invalid-args"])];
    const pred = [occ("s2", "P", "Edit", ["tool.invalid-args"])];
    assert.equal(scoreSignals(pred, ref).tp, 1);
    assert.equal(scoreSignals(pred, ref, { batchOf: (sid) => sid }).tp, 0);
  });

  it("session presence counts sessions with any occurrence", () => {
    const ref = [occ("s1", "a", "Edit", ["tool.invalid-args"]), occ("s1", "b", "Bash", ["eff.retry-thrash"]), occ("s2", "a", "Edit", ["tool.invalid-args"])];
    const pred = [occ("s1", "x", "Read", ["ctx.stale-context"]), occ("s3", "x", "Read", ["ctx.stale-context"])];
    const p = sessionPresence(pred, ref);
    assert.deepEqual([p.tp, p.fp, p.fn, p.precision, p.recall], [1, 1, 1, 0.5, 0.5]);
  });

  it("repeat agreement: runs agreeing on 9 of 10 sessions -> 0.9", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const run1 = sessions.slice(0, 5).map((s) => occ(s, "a", "Edit", ["tool.invalid-args"]));
    const run2 = sessions.slice(0, 6).map((s) => occ(s, "b", "Bash", ["eff.retry-thrash"]));
    const a = repeatAgreement([run1, run2], sessions);
    assert.equal(a.agreement, 0.9);
    assert.deepEqual([a.runs, a.pairs, a.sessions], [2, 1, 10]);
    const three = repeatAgreement([run1, run2, run1], sessions);
    assert.ok(Math.abs(three.agreement - (0.9 + 1 + 0.9) / 3) < 1e-12);
    assert.equal(three.pairs, 3);
    assert.equal(repeatAgreement([run1], sessions).empty, true);
    assert.ok(Number.isNaN(repeatAgreement([run1], sessions).agreement));
  });
});

describe("flags", () => {
  it("one component-free prediction per diagnosed flag; tags and context-only flags are skipped", () => {
    const pred = flagPredictions([
      { id: "s1", flags: ["premature-completion", "compaction", "gateway:vercel", "premature-completion"] },
      { id: "s2", flags: ["no-verification"] },
      { id: "s3" },
    ]);
    assert.deepEqual(pred, [
      { sessionId: "s1", signalId: "flag:premature-completion", typeIds: ["out.false-success", "out.incomplete-result"], nature: "defect", flag: "premature-completion" },
      { sessionId: "s2", signalId: "flag:no-verification", typeIds: ["out.verification-absent"], nature: "risk", flag: "no-verification" },
    ]);
  });

  it("a flag matches any component in its session that shares a type; per-flag precision", () => {
    const ref = [occ("s1", "A", "agent", ["out.incomplete-result"], "agent"), occ("s3", "B", "Bash", ["out.verification-absent"])];
    const pred = flagPredictions([
      { id: "s1", flags: ["premature-completion"] },
      { id: "s2", flags: ["premature-completion", "no-verification"] },
      { id: "s3", flags: ["no-verification"] },
    ]);
    const s = scoreOccurrences(pred, ref);
    assert.deepEqual([s.tp, s.fp, s.fn], [2, 2, 0]);
    assert.deepEqual(flagPrecision(pred, ref), [
      { flag: "no-verification", n: 2, tp: 1, precision: 0.5 },
      { flag: "premature-completion", n: 2, tp: 1, precision: 0.5 },
    ]);
  });
});

describe("parseLabels", () => {
  it("parses occurrences and clean sessions, and reports bad lines with their numbers", () => {
    const text = [
      JSON.stringify({ sessionId: "s1", signalId: "A", component: { type: "tool", name: "Edit" }, typeIds: ["tool.invalid-args"], nature: "defect" }),
      "",
      JSON.stringify({ sessionId: "s2" }),
      JSON.stringify({ sessionId: "s3", signalId: "B", component: { type: "tool", name: "Bash" }, typeIds: ["tool.invalid-args", "out.fals-success"] }),
      "{not json",
      JSON.stringify({ sessionId: "s4", signalId: "C", component: { type: "widget", name: "x" }, typeIds: [] }),
      JSON.stringify({ sessionId: "s5", signalId: "D", component: { type: "tool", name: "Bash" }, typeIds: ["eff.retry-thrash"], nature: "risk" }),
    ].join("\n");
    const l = parseLabels(text);
    assert.deepEqual(l.occurrences, [{ sessionId: "s1", signalId: "A", component: { type: "tool", name: "Edit" }, typeIds: ["tool.invalid-args"], nature: "defect" }]);
    assert.deepEqual(l.sessions, ["s1", "s2"]);
    assert.deepEqual(
      l.errors.map((e) => [e.line, e.message.split(" (")[0]]),
      [
        [4, 'unknown type id "out.fals-success"'],
        [5, "not valid JSON"],
        [6, 'unknown component type "widget"'],
        [6, "typeIds must be a list of 1 to 3 type ids"],
        [7, 'nature "risk" is not allowed for eff.retry-thrash'],
      ],
    );
  });
});
