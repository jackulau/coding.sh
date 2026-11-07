// §15.7: description compression against a deterministic fake evaluator whose
// success depends on one keyword in one tool's description.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compressDescriptions, descriptionsFile, dropExamples, nonInferior, repeatsName, ruleCandidate, textBytes, toolText, truncateSentences, type Evaluate } from "../../src/toolevals/compress.ts";
import { applyToolOverrides } from "../../src/toolevals/tap/mcp-proxy.ts";
import type { McpTarget, McpTool, TrialResult } from "../../src/toolevals/types.ts";
import { task, trial } from "./helpers.ts";

const KEYWORD = "BM25";
const TOOLS: McpTool[] = [
  {
    name: "search_docs",
    description:
      `Search the documentation index with ${KEYWORD} ranking and return matching pages. ` +
      "The index is rebuilt every night from the main branch of every repository that the organisation owns. " +
      "Results are sorted by relevance and include a short excerpt, the page title and a stable URL that can be shared. " +
      "Use this tool whenever the user asks a question that the documentation might answer. " +
      "Example: search_docs({ query: 'rate limits' }) returns the rate limit page first.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "The query." }, limit: { type: "number", description: "Maximum number of results to return, between 1 and 50. Defaults to 10 when omitted." } }, required: ["query"] },
  },
  {
    name: "echo",
    description:
      "Echo the given text back to the caller unchanged. This is useful for testing the connection to the server and for checking that arguments are passed through correctly. " +
      "It has no side effects of any kind and never fails for valid string input. (e.g. echo({ text: 'hi' }) returns 'hi').",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The text parameter." } }, required: ["text"] },
  },
];
const target: McpTarget = { name: "fake", kind: "mcp", transport: "stdio", command: ["unused"] };
const D = "model:anthropic/fake";

/** Every trial passes iff search_docs' effective description still mentions the keyword. */
const keywordEval =
  (calls: { variant: string; split: string; k: number }[]): Evaluate =>
  async (variant, tasks, k) => {
    calls.push({ variant: variant.name, split: tasks[0]!.split, k });
    const tools = applyToolOverrides(TOOLS, variant);
    const ok = (tools.find((t) => t.name === "search_docs")!.description ?? "").includes(KEYWORD);
    const out: TrialResult[] = [];
    for (const t of tasks) for (let a = 1; a <= k; a++) out.push(trial(t.id, variant.name, D, a, ok));
    return out;
  };

const tasks = [
  ...Array.from({ length: 6 }, (_, i) => task({ id: `dev${i}`, target: "fake", split: "dev" })),
  ...Array.from({ length: 4 }, (_, i) => task({ id: `held${i}`, target: "fake", split: "heldout" })),
];

describe("compressDescriptions", () => {
  it("keeps the load-bearing keyword, removes the rest and confirms on heldout", async () => {
    const calls: { variant: string; split: string; k: number }[] = [];
    const r = await compressDescriptions({ target, tasks, driver: { kind: "model", provider: "anthropic", model: "fake", apiKeyEnv: "X" }, k: 2, maxEvals: 60, tools: TOOLS, evaluate: keywordEval(calls), seed: 1, iters: 500 });
    const after = applyToolOverrides(TOOLS, { descriptions: r.final, paramDescriptions: r.finalParams });
    const search = after.find((t) => t.name === "search_docs")!.description!;
    assert.ok(search.includes(KEYWORD), search);
    assert.ok(Buffer.byteLength(search) < 100, search);
    assert.ok(r.bytesAfter < r.bytesBefore * 0.3, `${r.bytesAfter} vs ${r.bytesBefore}`);
    assert.ok(r.surfaceTokensAfter < r.surfaceTokensBefore);
    assert.ok(r.steps.some((s) => !s.accepted), "some candidate that dropped the keyword was rejected");
    assert.ok(r.steps.every((s) => s.accepted || s.evidence.lostTasks.length > 0 || s.evidence.reason));
    assert.equal(r.evals, r.steps.length);
    assert.equal(r.overfit, false);
    assert.ok(r.heldout, "heldout report present");
    assert.notEqual(r.heldout.verdict.kind, "worse");
    // Heldout ran with k = max(5, k), on heldout tasks only.
    assert.ok(calls.some((c) => c.split === "heldout" && c.k === 5));
    assert.ok(calls.filter((c) => c.split === "dev").every((c) => c.k === 2));
    const file = descriptionsFile(r);
    assert.ok(Object.keys(file).length > 0);
  });

  it("respects maxEvals", async () => {
    const r = await compressDescriptions({ target, tasks, driver: { kind: "model", provider: "anthropic", model: "fake", apiKeyEnv: "X" }, k: 1, maxEvals: 2, tools: TOOLS, evaluate: keywordEval([]) });
    assert.equal(r.evals, 2);
    assert.ok(r.notes.some((n) => /max-evals/.test(n)));
  });

  it("reverts to the base when heldout disagrees (overfit)", async () => {
    // Dev always passes, heldout passes only with the full base description.
    const base = applyToolOverrides(TOOLS, {}).find((t) => t.name === "echo")!.description!;
    const evaluate: Evaluate = async (variant, ts, k) => {
      const d = applyToolOverrides(TOOLS, variant).find((t) => t.name === "echo")!.description!;
      const out: TrialResult[] = [];
      for (const t of ts) for (let a = 1; a <= k; a++) out.push(trial(t.id, variant.name, D, a, t.split === "dev" || d === base));
      return out;
    };
    const r = await compressDescriptions({ target, tasks, driver: { kind: "model", provider: "anthropic", model: "fake", apiKeyEnv: "X" }, k: 1, maxEvals: 20, tools: TOOLS, evaluate, iters: 300 });
    assert.equal(r.overfit, true);
    assert.equal(r.final.echo, undefined);
    assert.ok(r.notes.some((n) => /held-out confirmation failed/.test(n)));
  });

  it("needs dev tasks", async () => {
    await assert.rejects(() => compressDescriptions({ target, tasks: tasks.filter((t) => t.split === "heldout"), driver: { kind: "model", provider: "anthropic", model: "fake", apiKeyEnv: "X" }, k: 1, maxEvals: 1, tools: TOOLS, evaluate: keywordEval([]) }), /dev tasks/);
  });
});

describe("rule helpers", () => {
  it("drops examples and name-repeating parameter descriptions", () => {
    assert.equal(dropExamples("Search pages. Example: search({q:1}) returns x."), "Search pages.");
    assert.equal(dropExamples("Echo text (e.g. 'hi') back."), "Echo text back.");
    assert.equal(repeatsName("text", "The text parameter."), true);
    assert.equal(repeatsName("query", "The query."), true);
    assert.equal(repeatsName("limit", "Maximum number of results."), false);
  });

  it("truncates by sentence, then by word", () => {
    assert.equal(truncateSentences("One two. Three four. Five.", 12), "One two.");
    assert.equal(truncateSentences("alpha beta gamma delta", 11), "alpha beta");
    assert.equal(truncateSentences("short", 100), "short");
  });

  it("ruleCandidate meets the byte target", () => {
    const t = toolText(TOOLS[0]!);
    for (const level of [0.75, 0.5, 0.25]) {
      const target = Math.floor(textBytes(t) * level);
      assert.ok(textBytes(ruleCandidate(t, target)) <= target, String(level));
    }
    assert.equal(ruleCandidate(t, 1000).params.query, "");
  });

  it("nonInferior accepts equal arms and rejects a lost task", () => {
    const a = [trial("x", "a", D, 1, true), trial("y", "a", D, 1, true)];
    const same = [trial("x", "b", D, 1, true), trial("y", "b", D, 1, true)];
    assert.equal(nonInferior(a, same, { margin: 0.03 }).ok, true);
    const lost = nonInferior(a, [trial("x", "b", D, 1, false), trial("y", "b", D, 1, true)], { margin: 0.03 });
    assert.equal(lost.ok, false);
    assert.deepEqual(lost.lostTasks, ["x"]);
  });
});
