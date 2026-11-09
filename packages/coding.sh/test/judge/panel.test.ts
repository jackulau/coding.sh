// Judge panel (TB-11 / EM-16): one judge per provider, 1-10, hidden target,
// anchors re-scored each round with drift, advisory members.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GradeContext } from "../../src/datasets/types.ts";
import {
  createPanel,
  formatPanelRound,
  JudgeParseError,
  MemoryJudgeCache,
  panelGrader,
  panelVersionFor,
  parsePanelScore,
  targetInflation,
  type ChatProvider,
  type PanelOptions,
} from "../../src/judge/index.ts";

type Stub = ChatProvider & { calls: number; prompts: string[] };

/** A provider whose reply is a function of the user prompt (and how many calls it has had). */
function stub(name: string, scoreOf: (user: string, call: number) => number | string): Stub {
  const p: Stub = {
    name,
    model: `${name}-1`,
    params: {},
    calls: 0,
    prompts: [],
    async complete(req) {
      p.calls++;
      p.prompts.push(`${req.system}\n${req.user}`);
      const s = scoreOf(req.user, p.calls);
      return { text: typeof s === "string" ? s : JSON.stringify({ score: s, reason: `${name} says ${s}` }), model: p.model };
    },
  };
  return p;
}

/** Scores 5 unless the prompt tells it the author's target, then agrees with the target. */
const sycophant = (name: string) => stub(name, (u) => (/aiming for a score of (\d+)/.exec(u) ? Number(/aiming for a score of (\d+)/.exec(u)![1]) : 5));
const honest = (name: string, s = 5) => stub(name, () => s);

const ctx = (output: string): GradeContext => ({ caseId: output, input: "write the summary", output });
const base = (members: PanelOptions["members"], extra: Partial<PanelOptions> = {}): PanelOptions => ({ name: "summary panel", rubric: "Accurate, complete, short.", members, createdAt: 1, ...extra });

describe("panel: one judge per provider, 1-10", () => {
  it("scores with the median of voting members and passes at the target", async () => {
    const a = honest("anthropic", 8);
    const b = honest("openai", 6);
    const c = honest("google", 9);
    const panel = createPanel(base([{ provider: a }, { provider: b }, { provider: c }], { target: 8 }));
    const v = await panel.score(ctx("A short accurate summary."));
    assert.equal(v.score, 8);
    assert.equal(v.pass, true);
    assert.equal(v.spread, 3);
    assert.deepEqual(v.members.map((m) => [m.id, m.score]), [["anthropic", 8], ["openai", 6], ["google", 9]]);
    const mean = createPanel(base([{ provider: honest("a", 8) }, { provider: honest("b", 6) }, { provider: honest("c", 9) }], { target: 8, aggregate: "mean" }));
    const mv = await mean.score(ctx("x"));
    assert.ok(Math.abs(mv.score - 23 / 3) < 1e-9);
    assert.equal(mv.pass, false);
  });

  it("refuses two members from the same provider, and a panel with no voting member", () => {
    assert.throws(() => panelVersionFor(base([{ provider: honest("openai") }, { provider: honest("openai") }])), /one judge per provider, and openai appears twice/);
    assert.throws(() => panelVersionFor(base([{ provider: honest("openai"), advisory: true }])), /not advisory/);
    assert.throws(() => panelVersionFor(base([])), /at least one member/);
    assert.throws(() => panelVersionFor(base([{ provider: honest("a") }], { target: 11 })), /between 1 and 10/);
  });

  it("parses scores as numbers or 'n/10', clamps to 1..10, and retries an unparseable reply once", async () => {
    assert.deepEqual(parsePanelScore('{"score": 7, "reason": "fine"}'), { score: 7, reason: "fine" });
    assert.equal(parsePanelScore('Sure. {"score": "8/10", "reason": "x"}').score, 8);
    assert.equal(parsePanelScore('{"score": 14}').score, 10);
    assert.equal(parsePanelScore('{"score": 0}').score, 1);
    assert.throws(() => parsePanelScore("eight"), JudgeParseError);
    const flaky = stub("flaky", (_u, n) => (n === 1 ? "I'd say about eight" : 8));
    const v = await createPanel(base([{ provider: flaky }])).score(ctx("x"));
    assert.equal(v.score, 8);
    assert.equal(flaky.calls, 2);
    const broken = stub("broken", () => "no idea");
    await assert.rejects(createPanel(base([{ provider: broken }])).score(ctx("x")), /after 2 attempts/);
  });

  it("caches per member: a second score of the same case makes no calls", async () => {
    const a = honest("a", 7);
    const b = honest("b", 9);
    const cache = new MemoryJudgeCache();
    const panel = createPanel(base([{ provider: a }, { provider: b }], { cache }));
    await panel.score(ctx("same"));
    const again = await panel.score(ctx("same"));
    assert.equal(again.cached, true);
    assert.equal(again.score, 8);
    assert.equal(a.calls + b.calls, 2);
  });
});

describe("panel: the target is never in the prompt", () => {
  it("no member's prompt carries the target, the pass line or the word 'target'", async () => {
    const members = [sycophant("anthropic"), sycophant("openai"), sycophant("google")];
    const panel = createPanel(base(members.map((provider) => ({ provider })), { target: 9 }));
    const v = await panel.score(ctx("A summary."));
    assert.equal(v.score, 5);
    for (const m of members) for (const p of m.prompts) {
      assert.doesNotMatch(p, /target|aiming|\b9\s*\/\s*10\b/i, "target leaked into the prompt");
    }
  });

  it("stub judges shown the target inflate; with it hidden they don't (targetInflation)", async () => {
    const cases = ["one", "two", "three", "four"].map(ctx);
    const syc = await targetInflation(base([{ provider: sycophant("anthropic") }, { provider: sycophant("openai") }, { provider: honest("google", 5) }], { target: 9 }), cases);
    assert.equal(syc.hidden, 5);
    assert.equal(syc.shown, 9, "two of three members agree with the shown target");
    assert.equal(syc.inflation, 4);
    assert.deepEqual(syc.byMember.map((m) => [m.id, m.inflation]), [["anthropic", 4], ["openai", 4], ["google", 0]]);
    const fair = await targetInflation(base([{ provider: honest("anthropic", 6) }, { provider: honest("openai", 7) }], { target: 9 }), cases);
    assert.equal(fair.inflation, 0);
  });

  it("showing the target is part of the version, so its scores never share a cache entry", () => {
    const hidden = panelVersionFor(base([{ provider: honest("a") }]));
    const shown = panelVersionFor(base([{ provider: honest("a") }], { unsafeShowTarget: true }));
    assert.notEqual(hidden.id, shown.id);
    assert.notEqual(hidden.promptHash, shown.promptHash);
    assert.equal(shown.params.showTarget, true);
    assert.equal("showTarget" in hidden.params, false);
    // The target itself changes the id (it decides pass), but never the prompt.
    const t8 = panelVersionFor(base([{ provider: honest("a") }], { target: 8 }));
    assert.notEqual(hidden.id, t8.id);
    assert.equal(hidden.promptHash, t8.promptHash);
  });
});

describe("panel: advisory members", () => {
  it("are scored and shown, never counted", async () => {
    const panel = createPanel(base([{ provider: honest("anthropic", 6) }, { provider: honest("openai", 6) }, { provider: honest("google", 10), advisory: true }], { target: 7 }));
    const v = await panel.score(ctx("x"));
    assert.equal(v.score, 6);
    assert.equal(v.pass, false);
    assert.equal(v.spread, 0);
    assert.deepEqual(v.members.map((m) => [m.id, m.score, m.advisory ?? false]), [["anthropic", 6, false], ["openai", 6, false], ["google", 10, true]]);
    assert.match(panel.version.model, /google\/google-1 \(advisory\)/);
  });
});

describe("panel: anchors and drift", () => {
  const anchors = [
    { id: "good", ctx: { input: "write the summary", output: "ANCHOR good summary" }, score: 8 },
    { id: "bad", ctx: { input: "write the summary", output: "ANCHOR bad summary" }, score: 3 },
  ];
  /** Steady judge: scores anchors at their reference. Drifter: the good anchor moves +1 in round 2, both move +2 in round 3. */
  const steady = () => stub("anthropic", (u) => (u.includes("ANCHOR good") ? 8 : u.includes("ANCHOR bad") ? 3 : 6));
  function drifter() {
    let round = 0;
    const table: Record<number, [number, number]> = { 1: [8, 3], 2: [9, 3], 3: [10, 5] };
    const p = stub("openai", (u) => (u.includes("ANCHOR good") ? table[round]![0] : u.includes("ANCHOR bad") ? table[round]![1] : 6));
    return { p, next: () => round++ };
  }

  it("re-scores anchors every round, bypassing the cache, and flags the member whose anchors moved", async () => {
    const s = steady();
    const d = drifter();
    const panel = createPanel(base([{ provider: s }, { provider: d.p }], { anchors, cache: new MemoryJudgeCache() }));
    d.next();
    const r1 = await panel.round([{ id: "case-1", ctx: ctx("case one") }]);
    assert.deepEqual(r1.drifted, []);
    assert.equal(r1.anchors.length, 2);
    d.next();
    const r2 = await panel.round([]);
    assert.deepEqual(r2.drifted, [], "a mean move of 0.5 is under the 1-point threshold");
    assert.equal(r2.drift.find((x) => x.id === "openai")!.meanDelta, 0.5);
    assert.equal(r2.drift.find((x) => x.id === "openai")!.maxAbsDelta, 1);
    d.next();
    const r3 = await panel.round([]);
    assert.deepEqual(r3.drifted, ["openai"]);
    const od = r3.drift.find((x) => x.id === "openai")!;
    assert.equal(od.meanDelta, 2);
    assert.equal(od.drifted, true);
    assert.equal(r3.drift.find((x) => x.id === "anthropic")!.drifted, false);
    // 3 rounds × 2 anchors, plus one case: anchors never come from the cache.
    assert.equal(s.calls, 7);
    assert.equal(panel.history.length, 3);
    assert.match(formatPanelRound(r3), /openai: anchor drift \+2\.00 \(max 2\.00\)  DRIFTED/);
    assert.match(formatPanelRound(r3), /drifted: openai: their scores this round are not comparable/);
  });

  it("drift is against the member's own first round; a constant offset from the reference is bias, not drift", async () => {
    const harsh = stub("google", (u) => (u.includes("ANCHOR good") ? 5 : u.includes("ANCHOR bad") ? 1 : 4));
    const panel = createPanel(base([{ provider: steady() }, { provider: harsh }], { anchors }));
    await panel.round();
    const r2 = await panel.round();
    assert.deepEqual(r2.drifted, []);
    assert.deepEqual(r2.anchors.map((a) => a.members.find((m) => m.id === "google")!.offset), [-3, -2]);
    assert.deepEqual(r2.anchors.map((a) => a.members.find((m) => m.id === "google")!.delta), [0, 0]);
  });

  it("without a reference score, there is no offset, and the first round is still the baseline", async () => {
    let calls = 0;
    const creeping = stub("google", (u) => (u.includes("ANCHOR") ? 4 + calls++ : 5));
    const panel = createPanel(base([{ provider: creeping }], { anchors: [{ id: "a", ctx: { input: "q", output: "ANCHOR a" } }] }));
    const r1 = await panel.round();
    assert.equal(r1.anchors[0]!.members[0]!.baseline, 4);
    assert.equal(r1.anchors[0]!.members[0]!.delta, 0);
    assert.equal("offset" in r1.anchors[0]!.members[0]!, false);
    await panel.round();
    const r3 = await panel.round();
    assert.equal(r3.anchors[0]!.members[0]!.delta, 2);
    assert.deepEqual(r3.drifted, ["google"]);
  });
});

describe("panel as a grader", () => {
  it("maps 1-10 to 0..1, passes at the target, names members, and reports anchor drift", async () => {
    let anchorCalls = 0;
    const a = stub("anthropic", (u) => (u.includes("ANCHOR") ? 5 + anchorCalls++ * 2 : 8));
    const b = stub("openai", (u) => (u.includes("ANCHOR") ? 5 : 7));
    const g = panelGrader(createPanel(base([{ provider: a }, { provider: b }, { provider: honest("google", 2), advisory: true }], { target: 7, anchors: [{ id: "x", ctx: { input: "q", output: "ANCHOR" }, score: 5 }] })), { anchorEvery: 1 });
    assert.equal(g.kind, "llm-panel");
    const r1 = await g.grade(ctx("first"));
    assert.ok(Math.abs(r1.score - 6.5 / 9) < 1e-9);
    assert.equal(r1.pass, true);
    assert.equal(r1.reason, "panel 7.5/10, target 7 (anthropic 8, openai 7; advisory google 2)");
    const r2 = await g.grade(ctx("second"));
    assert.match(r2.reason ?? "", /; anchor drift in anthropic$/);
  });
});

describe("llm-panel grader spec", () => {
  it("builds a panel from provider specs; the mock provider answers 10 (yes) or 1 (no)", async () => {
    const { createGrader } = await import("../../src/graders/index.ts");
    const yes = await createGrader({ kind: "llm-panel", name: "dry run", rubric: "Correct.", members: [{ provider: "mock" }] });
    const r = await yes.grade(ctx("x"));
    assert.equal(yes.kind, "llm-panel");
    assert.deepEqual([r.score, r.pass, r.reason], [1, true, "panel 10/10, target 7 (mock 10)"]);
    const no = await createGrader({ kind: "llm-panel", name: "dry run", rubric: "Correct.", members: [{ provider: "mock", mockAnswer: "no" }] });
    assert.equal((await no.grade(ctx("x"))).pass, false);
  });

  it("refuses two members on one provider, even when a test overrides deps.provider", async () => {
    const { createGrader } = await import("../../src/graders/index.ts");
    const env = { ["ANTHROPIC" + "_API_KEY"]: "test-key", ["OPENAI" + "_API_KEY"]: "test-key" };
    await assert.rejects(createGrader({ kind: "llm-panel", name: "p", rubric: "r", members: [{ provider: "anthropic" }, { provider: "anthropic", model: "other" }] }, { env }), /one judge per provider, and anthropic appears twice/);
    const g = await createGrader({ kind: "llm-panel", name: "p", rubric: "r", members: [{ provider: "anthropic" }, { provider: "openai", model: "gpt-5", advisory: true }] }, { env, provider: honest("override") });
    assert.match(g.judgeVersion!.model, /^anthropic\/.+, openai\/.+ \(advisory\)$/);
  });
});
