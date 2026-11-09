// AD-2: the checklist's abstain outlet (arXiv 2611.02676). With the tool calls
// missing, a judge that can say "cannot_decide" abstains instead of failing the
// step; abstentions are counted apart from "no".
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { TraceEvent } from "../../src/datasets/types.ts";
import {
  ABSTAIN_RULE,
  anthropicProvider,
  calibrate,
  checklistDiagnostics,
  checklistGrader,
  createChecklistJudge,
  renderCalibration,
  formatChecklistDiagnostics,
  JudgeParseError,
  MemoryJudgeCache,
  parseBatchAnswers,
  parseItemAnswer,
  scoreChecklist,
  type ChecklistItem,
  type ChecklistVerdict,
} from "../../src/judge/index.ts";

interface Seen {
  system: string;
  user: string;
  schema?: Record<string, unknown>;
}

function mockFetch(reply: (user: string, i: number) => string) {
  const seen: Seen[] = [];
  const fn = async (_url: string, init: RequestInit): Promise<Response> => {
    const b = JSON.parse(String(init.body)) as { system: string; messages: { content: string }[]; output_config?: { format?: { schema?: Record<string, unknown> } } };
    const s: Seen = { system: b.system, user: b.messages[0]?.content ?? "" };
    if (b.output_config?.format?.schema) s.schema = b.output_config.format.schema;
    seen.push(s);
    return new Response(JSON.stringify({ model: "m", content: [{ type: "text", text: reply(s.user, seen.length - 1) }], stop_reason: "end_turn" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, seen };
}
const provider = (fetch: (url: string, init: RequestInit) => Promise<Response>) => anthropicProvider({ env: { ANTHROPIC_API_KEY: "k" }, fetch, retry: { sleep: async () => {}, random: () => 0.5 } });

const ITEMS: ChecklistItem[] = [
  { id: "a", question: "Did it run the tests?", critical: true },
  { id: "b", question: "Did it explain the change?" },
];
const CTX = { input: "fix", output: "done", trace: [{ id: "e1", kind: "tool.start", payload: { tool: "Bash", input: { command: "npm test" } } }] as TraceEvent[] };
const yes = JSON.stringify({ answer: "yes", explanation: "x", citations: [] });
const batchYes = JSON.stringify({
  answers: [
    { id: "a", answer: "yes", explanation: "x", citations: [] },
    { id: "b", answer: "no", explanation: "y", citations: [] },
  ],
});
const cannot = (missing: string) => JSON.stringify({ answer: "cannot_decide", missing, explanation: "the trace shows no tool call", citations: [] });

describe("abstain: false keeps prompts and versions byte-identical (golden)", () => {
  // Golden values computed from the checklist before the abstain option existed.
  const GOLDEN = {
    "per-item": { id: "golden@c43e9291069f", promptHash: "ce5af03ce63cbef690eec2317ccfafbe35c3e20dd94f876339aa714a91fddfc0" },
    batched: { id: "golden@81aeab6856f5", promptHash: "4733cffac798cf1ce9d4e4e5185a5b03a5cf3a32d808356c7bc01e38b5cb88e9" },
    prompts: "d16f80453294a131357dd189dbd79641e8501d31c8f9e43376e9ee667e02e295",
  };
  for (const flag of [undefined, false]) {
    it(`abstain ${String(flag)}`, async () => {
      const m = mockFetch((u) => (u.includes("Questions:") ? batchYes : yes));
      const p = provider(m.fn);
      const got: Record<string, unknown> = {};
      for (const mode of ["per-item", "batched"] as const) {
        const j = createChecklistJudge({ name: "golden", items: ITEMS, provider: p, mode, createdAt: 0, ...(flag === undefined ? {} : { abstain: flag }) });
        await j.evaluate(CTX);
        got[mode] = { id: j.version.id, promptHash: j.version.promptHash };
      }
      got.prompts = createHash("sha256").update(JSON.stringify(m.seen)).digest("hex");
      assert.deepEqual(got, GOLDEN);
    });
  }

  it("abstain: true changes the version, the system prompt and the schema", async () => {
    const m = mockFetch(() => yes);
    const j = createChecklistJudge({ name: "golden", items: ITEMS, provider: provider(m.fn), createdAt: 0, abstain: true });
    assert.notEqual(j.version.id, "golden@c43e9291069f");
    assert.equal(j.version.params.abstain, true);
    await j.evaluate(CTX);
    assert.ok(m.seen[0]!.system.endsWith(ABSTAIN_RULE));
    assert.match(m.seen[0]!.user, /"cannot_decide"/);
    assert.deepEqual((m.seen[0]!.schema!.properties as Record<string, { enum?: string[] }>).answer!.enum, ["yes", "no", "cannot_decide"]);
  });
});

describe("parsing cannot_decide", () => {
  it("is null with the missing text only when abstain is on", () => {
    const a = parseItemAnswer(cannot("the npm test call"), true);
    assert.equal(a.answer, null);
    assert.equal(a.missing, "the npm test call");
    assert.throws(() => parseItemAnswer(cannot("x")), JudgeParseError);
    assert.equal(parseItemAnswer(JSON.stringify({ answer: "unsure", explanation: "no tool calls shown" }), true).missing, "no tool calls shown");
    const b = parseBatchAnswers(JSON.stringify({ answers: [{ id: "a", answer: "cannot_decide", missing: "m" }, { id: "b", answer: "yes" }] }), ["a", "b"], true);
    assert.equal(b.get("a")?.answer, null);
    assert.equal(b.get("b")?.answer, true);
    assert.throws(() => parseBatchAnswers(JSON.stringify({ answers: [{ id: "a", answer: "cannot_decide" }, { id: "b", answer: "yes" }] }), ["a", "b"]), JudgeParseError);
  });

  it("with abstain off, a cannot_decide reply raises JudgeParseError and retries", async () => {
    let calls = 0;
    const m = mockFetch(() => (calls++ === 0 ? cannot("x") : yes));
    const j = createChecklistJudge({ name: "c", items: [ITEMS[1]!], provider: provider(m.fn) });
    const v = await j.evaluate(CTX);
    assert.equal(calls, 2);
    assert.equal(v.items[0]!.answer, true);
    const m2 = mockFetch(() => cannot("x"));
    await assert.rejects(createChecklistJudge({ name: "c", items: [ITEMS[1]!], provider: provider(m2.fn) }).evaluate(CTX), JudgeParseError);
  });
});

describe("abstained items", () => {
  it("a non-critical abstention is out of the score and counted", async () => {
    const m = mockFetch((u) => (u.includes("explain") ? cannot("the final message") : yes));
    const j = createChecklistJudge({ name: "c", items: ITEMS, provider: provider(m.fn), abstain: true });
    const v = await j.evaluate(CTX);
    const b = v.items.find((x) => x.id === "b")!;
    assert.equal(b.answer, null);
    assert.equal(b.abstained, true);
    assert.equal(b.missing, "the final message");
    assert.equal(b.unverifiedNo, undefined);
    assert.equal(v.answered, 1);
    assert.equal(v.score, 1);
    assert.equal(v.pass, true);
    assert.equal(v.abstained, 1);
    assert.equal(v.undecided, undefined);
    assert.match(v.reason!, /abstained: b/);
  });

  it("a critical abstention gives pass=false, undecided and an 'undecided' reason (per-item and batched)", async () => {
    for (const mode of ["per-item", "batched"] as const) {
      const m = mockFetch((u) =>
        mode === "batched"
          ? JSON.stringify({ answers: [{ id: "a", answer: "cannot_decide", missing: "the test command and its result", explanation: "", citations: [] }, { id: "b", answer: "yes", missing: "", explanation: "x", citations: [] }] })
          : u.includes("run the tests")
            ? cannot("the test command and its result")
            : yes,
      );
      const v = await createChecklistJudge({ name: "c", items: ITEMS, provider: provider(m.fn), abstain: true, mode }).evaluate(CTX);
      assert.equal(v.pass, false, mode);
      assert.equal(v.undecided, true);
      assert.equal(v.abstained, 1);
      assert.deepEqual(v.gatedBy, []);
      assert.match(v.reason!, /^undecided: a \(missing: the test command and its result\)/);
    }
  });

  it("the grader passes undecided and abstained through", async () => {
    const m = mockFetch((u) => (u.includes("run the tests") ? cannot("x") : yes));
    const r = (await checklistGrader(createChecklistJudge({ name: "c", items: ITEMS, provider: provider(m.fn), abstain: true })).grade(CTX)) as unknown as ChecklistVerdict;
    assert.equal(r.pass, false);
    assert.equal(r.undecided, true);
    assert.equal(r.abstained, 1);
  });

  it("scoreChecklist: abstained items are absent when there are none", () => {
    const s = scoreChecklist([{ id: "a", answer: true, critical: true, weight: 1 }]);
    assert.deepEqual(s, { score: 1, pass: true, gatedBy: [], yes: 1, answered: 1 });
  });

  it("a cached abstention replays as one, with no model call", async () => {
    const cache = new MemoryJudgeCache();
    let calls = 0;
    const m = mockFetch((u) => (calls++, u.includes("run the tests") ? cannot("the test run") : yes));
    const mk = () => createChecklistJudge({ name: "c", items: ITEMS, provider: provider(m.fn), abstain: true, cache });
    const a = await mk().evaluate(CTX);
    const n = calls;
    const b = await mk().evaluate(CTX);
    assert.equal(calls, n);
    assert.equal(b.cached, true);
    assert.deepEqual(b.items, a.items);
    assert.equal(b.undecided, true);
    const entry = [...cache.map.values()].find((e) => e.abstained);
    assert.equal(entry?.missing, "the test run");
  });

  it("diagnostics report a per-item abstention rate", () => {
    const run = (caseId: string, abstain: boolean) => ({
      caseId,
      verdict: { score: 1, pass: true, items: [abstain ? { id: "a", answer: null, abstained: true as const, missing: "m", source: "llm" as const, critical: false, weight: 1 } : { id: "a", answer: true, source: "llm" as const, critical: false, weight: 1 }] },
    });
    const d = checklistDiagnostics([run("1", true), run("2", false), run("3", false), run("4", true)]);
    assert.equal(d.items[0]!.abstained, 2);
    assert.equal(d.items[0]!.abstainRate, 0.5);
    assert.match(formatChecklistDiagnostics(d), /\[abstained 0\.50\]/);
  });
});

describe("calibration leaves undecided verdicts out", () => {
  it("excludes them from κ and counts excluded.undecided", () => {
    const labels = [];
    const verdicts = [];
    const splits: Record<string, "test"> = {};
    for (let i = 0; i < 30; i++) {
      const id = `c${i}`;
      splits[id] = "test";
      const human = i % 3 !== 0;
      labels.push({ caseId: id, value: human ? ("pass" as const) : ("fail" as const) });
      // c0..c5: the judge abstained; as "fail" they would look like agreement on human-fail cases and disagreement on the rest
      verdicts.push(i < 6 ? { caseId: id, pass: false, undecided: true } : { caseId: id, pass: human });
    }
    const r = calibrate({ judge: { id: "j@1", tunedOn: ["dev"] }, labels, verdicts, splits, minN: 10 });
    assert.equal(r.n, 24);
    assert.equal(r.excluded.undecided, 6);
    assert.equal(r.kappa, 1);
    assert.match(renderCalibration(r, { color: false }), /6 undecided \(judge abstained\)/);
    const none = calibrate({ judge: { id: "j@1", tunedOn: ["dev"] }, labels, verdicts: verdicts.map((v) => ({ caseId: v.caseId, pass: v.pass })), splits, minN: 10 });
    assert.equal(none.excluded.undecided, undefined);
    assert.equal(none.n, 30);
  });
});

describe("end to end: blank vs restored tool calls (arXiv 2611.02676)", () => {
  // The stub abstains when no tool line appears in the trace, and answers from the tool line otherwise.
  const judgeReply = (user: string) => {
    const trace = user.split("<trace>")[1]?.split("</trace>")[0] ?? "";
    if (!/tool=Bash/.test(trace)) return cannot("the tool call the step made");
    return /ok=true/.test(trace) ? yes : JSON.stringify({ answer: "no", missing: "", explanation: "the call failed", citations: [{ eventId: "e2", quote: "ok=false" }] });
  };
  const items: ChecklistItem[] = [{ id: "step-ok", question: "Did the agent's tool call in this step succeed?", critical: true }];
  const blank: TraceEvent[] = [
    { id: "e1", kind: "tool.start", payload: {} },
    { id: "e2", kind: "tool.end", payload: {} },
  ];
  const restored: TraceEvent[] = [
    { id: "e1", kind: "tool.start", payload: { tool: "Bash", toolUseId: "u1", input: { command: "npm test" } } },
    { id: "e2", kind: "tool.end", payload: { tool: "Bash", toolUseId: "u1", ok: true, output: "ok" } },
  ];

  it("blank steps are undecided; restored steps get a decided verdict", async () => {
    const m = mockFetch(judgeReply);
    const j = createChecklistJudge({ name: "step", items, provider: provider(m.fn), abstain: true });
    const b = await j.evaluate({ input: "x", output: "y", trace: blank });
    assert.equal(b.undecided, true);
    assert.equal(b.pass, false);
    const r = await j.evaluate({ input: "x", output: "y", trace: restored });
    assert.equal(r.undecided, undefined);
    assert.equal(r.pass, true);
  });

  it("without the outlet, the same blank step is a confident critical 'no' (the paper's failure)", async () => {
    const m = mockFetch((u) => (/tool=Bash/.test(u) ? yes : JSON.stringify({ answer: "no", explanation: "no evidence the call succeeded", citations: [] })));
    const v = await createChecklistJudge({ name: "step", items, provider: provider(m.fn) }).evaluate({ input: "x", output: "y", trace: blank });
    assert.deepEqual(v.gatedBy, ["step-ok"]);
    assert.equal(v.undecided, undefined);
  });
});
