// Pairwise judge (EM-14): parsing, both-order combination, caching,
// calibration through calibrate(), and a fixed-seed simulation of a
// position-biased judge.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Hex } from "../../src/core/ids.ts";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import { summarizeRuns } from "../../src/experiments/run.ts";
import { runPairwise } from "../../src/experiments/pairwise.ts";
import { renderPairwise } from "../../src/experiments/render.ts";
import { createGrader, createPairwiseJudgeFromSpec } from "../../src/graders/index.ts";
import { MemoryJudgeCache } from "../../src/judge/cache.ts";
import { calibratePairwise, combineOrders, createPairwiseJudge, PAIRWISE_SCHEMA, parsePairReply, parseSlot, type PairLabel } from "../../src/judge/pairwise.ts";
import type { ChatProvider, ChatRequest } from "../../src/judge/providers.ts";
import { mulberry32 } from "../../src/stats/prng.ts";

const inner = (text: string, tag: string) => text.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];

/** A provider that answers from the two responses it is shown. */
function provider(pick: (r1: string, r2: string, req: ChatRequest) => "1" | "2" | "tie", calls: ChatRequest[] = []): ChatProvider {
  return {
    name: "fake",
    model: "fake-1",
    params: {},
    async complete(req) {
      calls.push(req);
      const winner = pick(inner(req.user, "response_1") ?? "", inner(req.user, "response_2") ?? "", req);
      return { text: `Sure. {"winner": "${winner}", "reason": "r${winner}"}`, model: "fake-1" };
    },
  };
}

function experiment(id: string, outputs: Record<string, unknown>, errors: string[] = []): ExperimentResult {
  const runs = Object.entries(outputs).map(([caseId, output]) => ({
    caseId,
    trial: 1,
    latencyMs: 1,
    grades: [],
    pass: true,
    startedAt: 0,
    ...(errors.includes(caseId) ? { error: "boom" } : { output }),
  }));
  return {
    id,
    name: id,
    dataset: { id: "d", name: "d", version: "v1" },
    task: { kind: "function", ref: id },
    graders: [],
    trials: 1,
    createdAt: 0,
    finishedAt: 0,
    runs,
    summary: summarizeRuns(runs, [], 1),
  };
}

describe("pairwise reply parsing", () => {
  it("reads the winner in its usual spellings", () => {
    assert.equal(parseSlot("1"), 1);
    assert.equal(parseSlot(2), 2);
    assert.equal(parseSlot("Response 2"), 2);
    assert.equal(parseSlot("TIE"), "tie");
    assert.equal(parseSlot("maybe"), undefined);
    assert.deepEqual(parsePairReply('```json\n{"winner":"2","reason":" shorter "}\n```'), { slot: 2, reason: "shorter" });
    assert.throws(() => parsePairReply('{"score": 1}'), /no JSON winner/);
    assert.throws(() => parsePairReply('{"winner": "3"}'), /not "1", "2" or "tie"/);
  });

  it("counts a win only when both orders agree", () => {
    // [A shown first, B shown first]
    assert.deepEqual(combineOrders(2, 1), { winner: "b", orders: ["b", "b"], consistent: true });
    assert.deepEqual(combineOrders(1, 2), { winner: "a", orders: ["a", "a"], consistent: true });
    assert.deepEqual(combineOrders("tie", "tie"), { winner: "tie", orders: ["tie", "tie"], consistent: true });
    // Always the first position: an order flip, recorded as a tie that favored the first slot.
    assert.deepEqual(combineOrders(1, 1), { winner: "tie", orders: ["a", "b"], consistent: false, favored: "first" });
    assert.deepEqual(combineOrders(2, 2), { winner: "tie", orders: ["b", "a"], consistent: false, favored: "second" });
    assert.deepEqual(combineOrders(1, "tie"), { winner: "tie", orders: ["a", "tie"], consistent: false });
  });
});

describe("createPairwiseJudge", () => {
  it("asks both orders, caches each, and has its own judge version", async () => {
    const calls: ChatRequest[] = [];
    const cache = new MemoryJudgeCache();
    const p = provider((r1, r2) => (r1.length > r2.length ? "1" : r2.length > r1.length ? "2" : "tie"), calls);
    const judge = createPairwiseJudge({ name: "Detail", rubric: "Prefer the more detailed answer.", provider: p, cache });
    const v = await judge.compare({ input: "q", a: "short", b: "much longer answer" });
    assert.equal(v.winner, "b");
    assert.equal(v.consistent, true);
    assert.deepEqual(v.reasons, ["r2", "r1"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.jsonSchema, PAIRWISE_SCHEMA);
    assert.match(calls[0]!.user, /<response_1>\nshort\n<\/response_1>/);
    assert.match(calls[1]!.user, /<response_1>\nmuch longer answer\n<\/response_1>/);
    assert.match(calls[0]!.system, /order of the responses means nothing/);
    // Cached: no new calls, same verdict.
    const again = await judge.compare({ input: "q", a: "short", b: "much longer answer" });
    assert.equal(calls.length, 2);
    assert.equal(again.cached, true);
    assert.equal(again.winner, "b");
    assert.match(judge.version.id, /^detail@[0-9a-f]{12}$/);
    // A pointwise judge with the same name and rubric is a different version.
    const pointwise = await createGrader({ kind: "llm", name: "Detail", rubric: "Prefer the more detailed answer.", provider: "mock" });
    const pairMock = createPairwiseJudgeFromSpec({ kind: "pairwise", name: "Detail", rubric: "Prefer the more detailed answer.", provider: "mock" });
    assert.notEqual(pointwise.version, pairMock.version.id);
    // The mock provider never picks a side.
    assert.equal((await pairMock.compare({ input: 1, a: "x", b: "y" })).winner, "tie");
    await assert.rejects(createGrader({ kind: "pairwise", name: "x", rubric: "y" }), /exp compare A B --pairwise/);
  });

  it("retries an unparseable reply once, then fails", async () => {
    let n = 0;
    const flaky: ChatProvider = { name: "f", model: "f", params: {}, complete: async () => ({ text: n++ % 3 === 0 ? "hmm" : '{"winner":"tie"}', model: "f" }) };
    const judge = createPairwiseJudge({ name: "x", rubric: "r", provider: flaky });
    assert.equal((await judge.ask({ input: 1 }, "a", "b")).slot, "tie");
    const never: ChatProvider = { name: "f", model: "f", params: {}, complete: async () => ({ text: "no idea", model: "f" }) };
    await assert.rejects(createPairwiseJudge({ name: "x", rubric: "r", provider: never }).ask({ input: 1 }, "a", "b"), /after 2 attempts/);
  });
});

describe("calibratePairwise", () => {
  it("runs calibrate() with B as pass, A as fail, and judge ties as abstentions", () => {
    const labels: PairLabel[] = [];
    const verdicts = new Map<string, { winner: "a" | "b" | "tie" }>();
    const splits = new Map<string, "test" | "dev">();
    // 30 held-out cases: the judge agrees on 26, disagrees on 2, ties on 2.
    for (let i = 0; i < 30; i++) {
      const id = `t${i}`;
      const human = i % 2 ? "b" : "a";
      labels.push({ caseId: id, winner: human });
      splits.set(id, "test");
      verdicts.set(id, { winner: i < 26 ? human : i < 28 ? (human === "a" ? "b" : "a") : "tie" });
    }
    labels.push({ caseId: "tie1", winner: "tie" });
    splits.set("tie1", "test");
    verdicts.set("tie1", { winner: "b" });
    const { report, abstained } = calibratePairwise({ judge: { id: "j@1", tunedOn: ["dev"] }, labels, verdicts, splits, now: 1 });
    assert.equal(abstained, 2);
    assert.equal(report.n, 28);
    assert.equal(report.agreement, 26 / 28);
    assert.equal(report.heldOut, true);
    assert.equal(report.state, "calibrated");
    assert.equal(report.excluded.noVerdict, 2, "judge ties on human-decisive cases have no verdict");
    // Sensitivity is P(judge says B | human says B).
    const humanB = [...Array(28).keys()].filter((i) => i % 2).length;
    assert.equal(report.status.positives, humanB);
    assert.ok(report.status.sensitivity! > 0.85);
  });
});

describe("pairwise simulation (fixed seed)", () => {
  // 400 cases. B is truly better on 60% of them. On each call the judge picks
  // the first response with probability 0.3 (position bias), else the truly
  // better one. The randomness is a hash of the prompt, so it does not depend
  // on call order, and swapping A and B shows the judge the same prompts.
  const N = 400;
  const truth = mulberry32(2026);
  const outputs = { a: {} as Record<string, string>, b: {} as Record<string, string> };
  const better = new Map<string, "a" | "b">();
  for (let i = 0; i < N; i++) {
    const id = `c${String(i).padStart(3, "0")}`;
    const bWins = truth() < 0.6;
    better.set(id, bWins ? "b" : "a");
    outputs.a[id] = `${id}:a:${bWins ? "worse" : "better"}`;
    outputs.b[id] = `${id}:b:${bWins ? "better" : "worse"}`;
  }
  const biased = provider((r1, r2, req) => {
    const u = parseInt(sha256Hex(req.user).slice(0, 8), 16) / 2 ** 32;
    if (u < 0.3) return "1";
    return r1.endsWith("better") ? "1" : "2";
  });
  const judge = createPairwiseJudge({ name: "sim", rubric: "pick the better one", provider: biased, concurrency: 16 });
  const cases = new Map([...better.keys()].map((id) => [id, { input: id }]));
  const A = experiment("A", outputs.a);
  const B = experiment("B", outputs.b);

  it("records order flips as ties, reports the bias rate, and beats a single order", async () => {
    const s = await runPairwise(judge, A, B, { cases, concurrency: 16, iters: 2000 });
    assert.equal(s.n, N);
    assert.equal(s.wins.a + s.wins.b + s.ties, N);
    // Expected flip rate 0.3, all toward the first position.
    assert.ok(s.positionBias.rate > 0.24 && s.positionBias.rate < 0.36, `flip rate ${s.positionBias.rate}`);
    assert.equal(s.positionBias.first, s.inconsistent);
    assert.equal(s.positionBias.second, 0);
    assert.equal(s.ties, s.inconsistent, "this judge never answers tie itself");
    // A decisive win is always the truly better output.
    for (const c of s.cases) if (c.winner !== "tie") assert.equal(c.winner, better.get(c.caseId));
    // A single order (A shown first) is biased toward A: expected B rate 0.42 vs the true 0.6.
    const single = s.cases.filter((c) => c.orders[0] === "b").length / N;
    const trueRate = [...better.values()].filter((w) => w === "b").length / N;
    assert.ok(single < 0.48, `single-order rate ${single}`);
    assert.ok(Math.abs(s.winRate.b - trueRate) < Math.abs(single - trueRate));
    assert.ok(s.winRate.lo < s.winRate.b && s.winRate.b < s.winRate.hi);
    assert.equal(s.verdict, "better");
    assert.ok(s.signTest.p < 0.05);
    assert.match(s.warnings.join("\n"), /changed its answer with the order on \d+% of cases/);
    const text = renderPairwise(s, { color: false });
    assert.match(text, /^order {3}answer changed with the order on \d+ of 400 \(\d+\.\d%\): \d+ favored the first response, 0 the second$/m);
    assert.match(text, /^verdict B is better$/m);
  });

  it("is symmetric: swapping A and B mirrors every number", async () => {
    const s = await runPairwise(judge, A, B, { cases, iters: 500 });
    const t = await runPairwise(judge, B, A, { cases, iters: 500 });
    assert.deepEqual(t.wins, { a: s.wins.b, b: s.wins.a });
    assert.equal(t.inconsistent, s.inconsistent);
    assert.ok(Math.abs(t.winRate.b - (1 - s.winRate.b)) < 1e-12);
  });

  it("leaves out cases with no output on one side and counts judge errors", async () => {
    const failing = createPairwiseJudge({
      name: "f",
      rubric: "r",
      provider: { name: "f", model: "f", params: {}, complete: async (req) => (req.user.includes("c001") ? Promise.reject(new Error("HTTP 503")) : { text: '{"winner":"1"}', model: "f" }) },
    });
    const a = experiment("A", { c000: "x", c001: "y", c002: "z" }, ["c002"]);
    const b = experiment("B", { c000: "x", c001: "y", c002: "z", c003: "w" });
    const s = await runPairwise(failing, a, b, { cases, iters: 100 });
    assert.equal(s.n, 1);
    assert.deepEqual(s.skipped, { noOutput: 1, judgeErrors: 1, firstError: "HTTP 503" });
    assert.match(s.warnings.join("\n"), /1 case\(s\) left out after a judge error: HTTP 503/);
  });
});
