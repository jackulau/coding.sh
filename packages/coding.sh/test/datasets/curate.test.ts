import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  caseDifficulty,
  computeDatasetStats,
  countNearDuplicatePairs,
  dedupeNearCases,
  filterDatasetCases,
  inputSimilarity,
  mineDatasetSessions,
  minedCaseFromSession,
  parseMinScore,
  sessionComplexity,
  validateThreshold,
} from "../../src/datasets/curate.ts";
import { createDataset, DatasetError, normalizeCase } from "../../src/datasets/dataset.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent: "claude-code",
    startedAt: 1_700_000_000_000,
    stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
    flags: [],
    ...overrides,
  };
}

function makeEvents(sessionId: string, prompt: string, reply = "done"): AgentEvent[] {
  return [
    { id: `${sessionId}-u`, v: 0, sessionId, ts: 1000, agent: "claude-code", kind: "user.message", payload: { text: prompt } },
    { id: `${sessionId}-a`, v: 0, sessionId, ts: 2000, agent: "claude-code", kind: "assistant.message", payload: { text: reply } },
  ];
}

describe("sessionComplexity and minedCaseFromSession", () => {
  it("classifies easy, medium, and hard sessions deterministically", () => {
    assert.deepEqual(sessionComplexity({ turns: 1, toolCalls: 2, filesChanged: 1 }), {
      difficulty: "easy",
      turns: 1,
      toolCalls: 2,
      filesChanged: 1,
    });
    assert.equal(sessionComplexity({ turns: 3, toolCalls: 1, filesChanged: 0 }).difficulty, "medium");
    assert.equal(sessionComplexity({ turns: 1, toolCalls: 5, filesChanged: 0 }).difficulty, "medium");
    assert.equal(sessionComplexity({ turns: 1, toolCalls: 1, filesChanged: 2 }).difficulty, "medium");
    assert.equal(sessionComplexity({ turns: 6, toolCalls: 1, filesChanged: 0 }).difficulty, "hard");
    assert.equal(sessionComplexity({ turns: 2, toolCalls: 15, filesChanged: 0 }).difficulty, "hard");
    assert.equal(sessionComplexity({ turns: 2, toolCalls: 4, filesChanged: 5 }).difficulty, "hard");
  });

  it("attaches complexity metadata and difficulty tag on mined cases", () => {
    const s = makeSession("s-hard", { stats: { events: 20, turns: 7, toolCalls: 18, toolErrors: 0, filesChanged: 6 } });
    const c = minedCaseFromSession(s, makeEvents(s.id, "Refactor the query planner for joins"));
    assert.equal(c.metadata?.difficulty, "hard");
    assert.equal(c.metadata?.turns, 7);
    assert.equal(c.metadata?.toolCalls, 18);
    assert.equal(c.metadata?.filesChanged, 6);
    assert.ok(c.tags?.includes("difficulty:hard"));
    assert.ok(c.tags?.includes("agent:claude-code"));
    assert.equal(caseDifficulty(c), "hard");
  });

  it("reads difficulty from metadata or tag and leaves plain cases undefined", () => {
    assert.equal(caseDifficulty(normalizeCase({ input: "plain" })), undefined);
    assert.equal(caseDifficulty(normalizeCase({ input: "tagged", tags: ["difficulty:medium"] })), "medium");
    assert.equal(caseDifficulty(normalizeCase({ input: "meta", metadata: { difficulty: "easy" }, tags: ["difficulty:hard"] })), "easy");
  });
});

describe("near-duplicate similarity and dedupeNearCases", () => {
  it("rejects invalid thresholds", () => {
    for (const bad of [0, -0.2, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => validateThreshold(bad), DatasetError);
      assert.throws(() => dedupeNearCases([], bad), DatasetError);
    }
    assert.equal(validateThreshold(0.8), 0.8);
    assert.equal(validateThreshold(1), 1);
  });

  it("drops exact and near-duplicate prompts while keeping distinct prompts", () => {
    const base = "Refactor the authentication middleware to verify JWT expiry timestamps cleanly";
    const near = "Refactor the authentication middleware to verify JWT expiry timestamps clean";
    const distinct = "Add a CSV export command for billing invoices with UTF-8 BOM support";
    assert.ok(inputSimilarity(base, near) >= 0.8);
    assert.ok(inputSimilarity(base, distinct) < 0.2);

    const cases = [
      normalizeCase({ id: "c1", input: base, tags: ["first"] }),
      normalizeCase({ id: "c2", input: base, tags: ["dup"] }),
      normalizeCase({ id: "c3", input: near }),
      normalizeCase({ id: "c4", input: distinct }),
    ];
    const report = dedupeNearCases(cases, 0.8);
    assert.deepEqual(report.cases.map((c) => c.id), ["c1", "c4"]);
    assert.equal(report.exactDropped, 1);
    assert.equal(report.nearDropped, 1);
    assert.equal(report.duplicates.length, 2);
    assert.equal(report.duplicates[0]?.kind, "exact");
    assert.equal(report.duplicates[1]?.kind, "near");
    assert.equal(report.duplicates[1]?.kept, "c1");
    assert.ok(report.cases[0]?.tags?.includes("dup"));
  });

  it("deduplicates against existing dataset cases without returning them", () => {
    const existing = [normalizeCase({ id: "old", input: "Write unit tests for the cache invalidation module in src/cache.ts" })];
    const incoming = [
      normalizeCase({ id: "new-near", input: "Write unit tests for the cache invalidation module in src/cache.ts!" }),
      normalizeCase({ id: "new-distinct", input: "Implement retry backoff for outbound webhook deliveries" }),
    ];
    const report = dedupeNearCases(incoming, 0.8, { existing });
    assert.deepEqual(report.cases.map((c) => c.id), ["new-distinct"]);
    assert.equal(report.nearDropped, 1);
    assert.equal(report.duplicates[0]?.kept, "old");
  });
});

describe("parseMinScore", () => {
  it("parses = and >= syntax and rejects invalid values", () => {
    assert.deepEqual(parseMinScore("quality=0.8"), { name: "quality", min: 0.8 });
    assert.deepEqual(parseMinScore("judge:helpful>=4"), { name: "judge:helpful", min: 4 });
    assert.deepEqual(parseMinScore("delta=-0.5"), { name: "delta", min: -0.5 });
    assert.throws(() => parseMinScore("quality>0.8"), DatasetError);
    assert.throws(() => parseMinScore("quality=abc"), DatasetError);
    assert.throws(() => parseMinScore("=0.8"), DatasetError);
  });
});

describe("mineDatasetSessions", () => {
  it("applies minTurns, minScores, excludeFlagged (keeping note flags), dedupeNear, and limit", async () => {
    const sClean = makeSession("s1", {
      stats: { events: 6, turns: 3, toolCalls: 6, toolErrors: 0, filesChanged: 2 },
      flags: ["compaction", "step-retried", "resumed", "gateway:vercel", "skill:pdf"],
    });
    const sNear = makeSession("s2", {
      stats: { events: 6, turns: 4, toolCalls: 4, toolErrors: 0, filesChanged: 1 },
      flags: [],
    });
    const sFlagged = makeSession("s3", {
      stats: { events: 6, turns: 4, toolCalls: 8, toolErrors: 2, filesChanged: 1 },
      flags: ["no-verification", "compaction"],
    });
    const sShort = makeSession("s4", {
      stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
      flags: [],
    });
    const sLowScore = makeSession("s5", {
      stats: { events: 6, turns: 3, toolCalls: 2, toolErrors: 0, filesChanged: 1 },
      flags: [],
    });
    const sNoPrompt = makeSession("s6", {
      stats: { events: 2, turns: 3, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
      flags: [],
    });
    const sSecondKept = makeSession("s7", {
      stats: { events: 14, turns: 6, toolCalls: 16, toolErrors: 0, filesChanged: 5 },
      flags: [],
    });
    const sCapped = makeSession("s8", {
      stats: { events: 6, turns: 3, toolCalls: 2, toolErrors: 0, filesChanged: 1 },
      flags: [],
    });

    const events = new Map<string, AgentEvent[]>([
      ["s1", makeEvents("s1", "Fix the pagination cursor bug in the SQLite event query path")],
      ["s2", makeEvents("s2", "Fix the pagination cursor bug in the SQLite event query paths")],
      ["s3", makeEvents("s3", "Add streaming parser support for NDJSON logs")],
      ["s4", makeEvents("s4", "What version of Node is installed?")],
      ["s5", makeEvents("s5", "Update README installation instructions for Windows")],
      ["s6", [{ id: "e-only", v: 0, sessionId: "s6", ts: 1000, agent: "claude-code", kind: "assistant.message", payload: { text: "hi" } }]],
      ["s7", makeEvents("s7", "Design a deterministic retry policy for S3 blob uploads")],
      ["s8", makeEvents("s8", "Generate OpenAPI schema for session endpoints")],
    ]);

    const scores = new Map<string, Map<string, number>>([
      ["s1", new Map([["quality", 0.9]])],
      ["s2", new Map([["quality", 0.95]])],
      ["s3", new Map([["quality", 0.95]])],
      ["s4", new Map([["quality", 0.95]])],
      ["s5", new Map([["quality", 0.4]])],
      ["s6", new Map([["quality", 0.95]])],
      ["s7", new Map([["quality", 0.85]])],
      ["s8", new Map([["quality", 0.9]])],
    ]);

    const report = await mineDatasetSessions({
      sessions: [sClean, sNear, sFlagged, sShort, sLowScore, sNoPrompt, sSecondKept, sCapped],
      getEvents: async (id) => events.get(id) ?? [],
      scores,
      minTurns: 2,
      minScores: [parseMinScore("quality>=0.8")],
      excludeFlagged: true,
      dedupeNear: 0.8,
      limit: 2,
    });

    assert.equal(report.matched, 8);
    assert.equal(report.kept, 2);
    assert.equal(report.dropped, 6);
    assert.deepEqual(report.cases.map((c) => c.sourceSessionId), ["s1", "s7"]);
    assert.equal(report.cases[0]?.metadata?.difficulty, "medium");
    assert.equal(report.cases[1]?.metadata?.difficulty, "hard");
    assert.deepEqual(report.droppedBy, {
      "near-duplicate": 1,
      flagged: 1,
      "min-turns": 1,
      "min-score": 1,
      "no-user-message": 1,
      limit: 1,
    });
  });
});

describe("computeDatasetStats and filterDatasetCases", () => {
  const ds = createDataset({
    name: "sample-set",
    cases: [
      { id: "a", input: "Explain how TLS handshakes negotiate cipher suites in HTTP/2", split: "train", kind: "bad", tags: ["net", "difficulty:easy"], metadata: { difficulty: "easy" } },
      { id: "b", input: "Explain how TLS handshakes negotiate cipher suites in HTTP/3", split: "train", kind: "guard", tags: ["net", "difficulty:medium"], metadata: { difficulty: "medium" } },
      { id: "c", input: "Write a lock-free ring buffer in Rust with atomic indices", split: "dev", tags: ["rust", "difficulty:hard"], metadata: { difficulty: "hard" } },
      { id: "d", input: "Hi", split: "test", tags: ["short", "difficulty:easy"], metadata: { difficulty: "easy" } },
    ],
  });

  it("computes splits, kinds, tags, difficulty, input length summary, and near-duplicate pairs", () => {
    const stats = computeDatasetStats(ds, { nearThreshold: 0.8 });
    assert.equal(stats.id, "sample-set");
    assert.equal(stats.version, ds.version);
    assert.equal(stats.total, 4);
    assert.deepEqual(stats.splits, { train: 2, dev: 1, test: 1 });
    assert.deepEqual(stats.kinds, { bad: 1, guard: 1 });
    assert.deepEqual(stats.difficulty, { easy: 2, medium: 1, hard: 1 });
    assert.equal(stats.tags.net, 2);
    assert.deepEqual(stats.inputChars, { min: 2, median: 58.5, max: 60 });
    assert.equal(stats.nearDuplicates.threshold, 0.8);
    assert.equal(stats.nearDuplicates.pairs, 1);
    assert.equal(countNearDuplicatePairs(ds.cases, 0.99), 0);
  });

  it("omits kinds and difficulty when absent on cases", () => {
    const plain = createDataset({ name: "plain", cases: [{ id: "1", input: "hello", split: "train" }] });
    const stats = computeDatasetStats(plain);
    assert.equal("kinds" in stats, false);
    assert.equal("difficulty" in stats, false);
  });

  it("filters by split, tag, difficulty, input length, near-dedup, and limit", () => {
    const r1 = filterDatasetCases(ds.cases, {
      splits: ["train", "dev"],
      minChars: 10,
      dedupeNear: 0.8,
    });
    assert.deepEqual(r1.cases.map((c) => c.id), ["a", "c"]);
    assert.deepEqual(r1.droppedBy, { "near-duplicate": 1, split: 1 });

    const r2 = filterDatasetCases(ds.cases, { difficulties: ["hard"], tags: ["rust"] });
    assert.deepEqual(r2.cases.map((c) => c.id), ["c"]);

    const r3 = filterDatasetCases(ds.cases, { maxChars: 10 });
    assert.deepEqual(r3.cases.map((c) => c.id), ["d"]);
    assert.equal(r3.droppedBy["max-chars"], 3);

    const r4 = filterDatasetCases(ds.cases, { limit: 2 });
    assert.equal(r4.kept, 2);
    assert.equal(r4.droppedBy.limit, 2);

    assert.throws(() => filterDatasetCases(ds.cases, { minChars: 50, maxChars: 10 }), DatasetError);
  });
});
