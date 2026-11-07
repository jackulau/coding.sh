import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  addCases,
  assignSplits,
  caseFromSession,
  casesFromCsv,
  createDataset,
  datasetToCsv,
  datasetToJsonl,
  datasetVersion,
  DatasetError,
  dedupeCases,
  loadDatasetFile,
  normalizeCase,
  parseCases,
  parseJsonl,
  slugify,
  splitFor,
} from "../../src/datasets/dataset.ts";
import { canonicalJson } from "../../src/datasets/hash.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { existsSync } from "node:fs";
import type { AgentEvent, Session } from "../../src/schema/index.ts";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "codingsh-ds-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined members", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
  it("rejects cycles and functions", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    assert.throws(() => canonicalJson(o), /circular/);
    assert.throws(() => canonicalJson({ f: () => 1 }), /function/);
  });
});

describe("cases and versions", () => {
  it("derives a stable content-hash id when none is given", () => {
    const a = normalizeCase({ input: { q: "x" }, expected: 1 });
    const b = normalizeCase({ expected: 1, input: { q: "x" } });
    assert.match(a.id, /^c_[0-9a-f]{16}$/);
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, normalizeCase({ input: { q: "y" }, expected: 1 }).id);
  });

  it("validates fields", () => {
    assert.throws(() => normalizeCase({}), /missing "input"/);
    assert.throws(() => normalizeCase({ input: 1, split: "validation" }), /split/);
    assert.throws(() => normalizeCase({ input: 1, tags: [1] }), /tags/);
  });

  it("version ignores case order but not content", () => {
    const c1 = normalizeCase({ id: "1", input: "a" });
    const c2 = normalizeCase({ id: "2", input: "b" });
    assert.equal(datasetVersion([c1, c2]), datasetVersion([c2, c1]));
    assert.notEqual(datasetVersion([c1, c2]), datasetVersion([c1, { ...c2, expected: "B" }]));
    assert.match(datasetVersion([c1]), /^[0-9a-f]{16}$/);
  });

  it("dedupes by input + expected, merging tags", () => {
    const { cases, duplicates } = dedupeCases([
      normalizeCase({ id: "a", input: "x", tags: ["one"] }),
      normalizeCase({ id: "b", input: "x", tags: ["two"] }),
      normalizeCase({ id: "c", input: "x", expected: "different" }),
    ]);
    assert.deepEqual(
      cases.map((c) => c.id),
      ["a", "c"],
    );
    assert.deepEqual(cases[0]?.tags, ["one", "two"]);
    assert.deepEqual(duplicates, [{ dropped: "b", kept: "a" }]);
  });

  it("rejects one id naming two different cases", () => {
    assert.throws(() => createDataset({ name: "x", cases: [{ id: "1", input: "a" }, { id: "1", input: "b" }] }), /duplicate case id/);
  });

  it("createDataset slugs the name and addCases re-versions", () => {
    const ds = createDataset({ name: "Support Bot — v2!", cases: [{ input: "hi" }] });
    assert.equal(ds.id, "support-bot-v2");
    const more = addCases(ds, [{ input: "hi" }, { input: "bye" }]);
    assert.equal(more.cases.length, 2);
    assert.equal(more.duplicates.length, 1);
    assert.notEqual(more.version, ds.version);
    assert.throws(() => slugify("!!!"), DatasetError);
  });
});

describe("splits", () => {
  const many = createDataset({ name: "many", cases: Array.from({ length: 2000 }, (_, i) => ({ id: `case-${i}`, input: i })) });

  it("is deterministic and roughly follows the ratios", () => {
    const a = assignSplits(many);
    const b = assignSplits(many);
    assert.deepEqual(
      a.cases.map((c) => c.split),
      b.cases.map((c) => c.split),
    );
    const counts = { train: 0, dev: 0, test: 0 };
    for (const c of a.cases) counts[c.split as keyof typeof counts]++;
    assert.ok(Math.abs(counts.train / 2000 - 0.6) < 0.04, JSON.stringify(counts));
    assert.ok(Math.abs(counts.dev / 2000 - 0.2) < 0.04, JSON.stringify(counts));
    assert.ok(Math.abs(counts.test / 2000 - 0.2) < 0.04, JSON.stringify(counts));
  });

  it("a case's split never depends on the other cases", () => {
    const small = assignSplits(createDataset({ name: "s", cases: [{ id: "case-7", input: 7 }] }));
    const big = assignSplits(many);
    assert.equal(small.cases[0]?.split, big.cases.find((c) => c.id === "case-7")?.split);
  });

  it("honors custom ratios, seeds, and existing splits", () => {
    assert.equal(splitFor("anything", { test: 1 }), "test");
    const seeded = many.cases.slice(0, 200).filter((c) => splitFor(c.id, undefined, "a") !== splitFor(c.id, undefined, "b"));
    assert.ok(seeded.length > 0);
    const pinned = createDataset({ name: "p", cases: [{ id: "x", input: 1, split: "dev" }] });
    assert.equal(assignSplits(pinned, { ratios: { test: 1 } }).cases[0]?.split, "dev");
    assert.equal(assignSplits(pinned, { ratios: { test: 1 }, overwrite: true }).cases[0]?.split, "test");
    assert.throws(() => splitFor("x", { train: 0 }), /positive sum/);
  });
});

describe("JSONL and CSV", () => {
  it("parses JSONL with BOM and blank lines; reports the bad line", () => {
    assert.deepEqual(parseJsonl('﻿{"input":1}\n\n{"input":2}\r\n'), [{ input: 1 }, { input: 2 }]);
    assert.throws(() => parseJsonl('{"input":1}\n{oops\n'), /line 2/);
  });

  it("round-trips through JSONL", () => {
    const ds = createDataset({ name: "rt", cases: [{ id: "a", input: { q: "x" }, expected: [1, 2], tags: ["t"], split: "test", metadata: { m: 1 } }] });
    const back = createDataset({ name: "rt", cases: parseCases(datasetToJsonl(ds), "jsonl") });
    assert.equal(back.version, ds.version);
  });

  it("maps CSV columns onto cases", () => {
    const csv = '﻿id,input.question,input.ctx,expected,tags,split,source\r\n1,"What is 2+2?","{""lang"":""en""}",4,math;easy,test,web\r\n';
    const [rec] = casesFromCsv(csv) as Record<string, unknown>[];
    assert.deepEqual(rec, {
      id: "1",
      input: { question: "What is 2+2?", ctx: { lang: "en" } },
      expected: "4",
      tags: ["math", "easy"],
      split: "test",
      metadata: { source: "web" },
    });
    assert.throws(() => casesFromCsv("question\nx\n"), /no "input" column/);
  });

  it("round-trips through CSV, including multi-line values", () => {
    const ds = createDataset({ name: "c", cases: [{ id: "a", input: "line1\nline2, with comma", expected: { ok: true }, tags: ["x"], metadata: { n: "1" } }] });
    const back = createDataset({ name: "c", cases: casesFromCsv(datasetToCsv(ds)) });
    assert.equal(back.version, ds.version);
  });

  it("loads files by extension", async () => {
    const f = join(dir, "golden.csv");
    await writeFile(f, "input,expected\nhello,HELLO\nhello,HELLO\n");
    const ds = await loadDatasetFile(f);
    assert.equal(ds.name, "golden");
    assert.equal(ds.cases.length, 1);
    assert.equal(ds.duplicates.length, 1);
    await assert.rejects(loadDatasetFile(join(dir, "x.txt")), /cannot infer/);
  });
});

describe("caseFromSession", () => {
  const session: Session = {
    id: "sess-1",
    agent: "claude-code",
    model: "m",
    startedAt: 1000,
    stats: { events: 4, turns: 2, toolCalls: 1, toolErrors: 0, filesChanged: 0 },
    flags: [],
  };
  const ev = (id: string, kind: AgentEvent["kind"], ts: number, text?: string): AgentEvent => ({
    id,
    v: 0,
    sessionId: "sess-1",
    ts,
    agent: "claude-code",
    kind,
    payload: text === undefined ? {} : { text },
  });
  const events = [
    ev("e3", "assistant.message", 30, "final answer"),
    ev("e1", "user.message", 10, "fix the bug"),
    ev("e2", "assistant.message", 20, "working on it"),
    ev("e4", "user.message", 25, "thanks"),
    ev("e5", "tool.start", 26),
  ];

  it("takes the first user message as input and the last assistant message as output", () => {
    const c = caseFromSession(session, events);
    assert.equal(c.input, "fix the bug");
    assert.equal(c.expected, undefined);
    assert.equal(c.metadata?.output, "final answer");
    assert.equal(c.metadata?.outputEventId, "e3");
    assert.equal(c.sourceSessionId, "sess-1");
    assert.deepEqual(c.tags, ["agent:claude-code"]);
    assert.equal(c.id, caseFromSession(session, [...events].reverse()).id);
  });

  it("promotes the output to expected when asked", () => {
    const c = caseFromSession(session, events, { asExpected: true, split: "test", tags: ["golden"] });
    assert.equal(c.expected, "final answer");
    assert.equal(c.metadata?.output, undefined);
    assert.equal(c.split, "test");
    assert.deepEqual(c.tags, ["golden", "agent:claude-code"]);
  });

  it("refuses sessions without a user message", () => {
    assert.throws(() => caseFromSession(session, [ev("x", "assistant.message", 1, "hi")]), /no user message/);
  });
});

describe("FileEvalStore", () => {
  it("stores immutable versions and tracks latest", async () => {
    const store = new FileEvalStore({ root: join(dir, "home") });
    const v1 = createDataset({ name: "qa", cases: [{ id: "1", input: "a" }] });
    const v2 = addCases(v1, [{ id: "2", input: "b" }]);
    assert.deepEqual(await store.putDataset(v1, { now: 1 }), { version: v1.version, created: true });
    assert.deepEqual(await store.putDataset(v1, { now: 2 }), { version: v1.version, created: false });
    await store.putDataset(v2, { now: 3, note: "added b" });
    assert.equal((await store.getDataset("qa"))?.version, v2.version);
    assert.equal((await store.getDataset("qa", v1.version))?.cases.length, 1);
    const history = await store.listDatasetVersions("qa");
    assert.deepEqual(
      history.map((h) => [h.version, h.cases, h.note]),
      [
        [v1.version, 1, undefined],
        [v2.version, 2, "added b"],
      ],
    );
    // Re-putting an old version moves latest back without rewriting the file.
    const before = await readFile(join(store.datasetsDir, "qa", "versions", `${v1.version}.json`), "utf8");
    await store.putDataset(v1);
    assert.equal((await store.getDataset("qa"))?.version, v1.version);
    assert.equal(await readFile(join(store.datasetsDir, "qa", "versions", `${v1.version}.json`), "utf8"), before);
    assert.deepEqual(
      (await store.listDatasets()).map((d) => [d.id, d.versions]),
      [["qa", 2]],
    );
    assert.equal(await store.getDataset("missing"), undefined);
  });

  it("rejects a version that does not match the content and unsafe ids", async () => {
    const store = new FileEvalStore({ root: join(dir, "home2") });
    const ds = createDataset({ name: "x", cases: [{ input: 1 }] });
    await assert.rejects(store.putDataset({ ...ds, version: "0000000000000000" }), /does not match/);
    await assert.rejects(store.getDataset("../etc"), /invalid dataset id/);
  });

  for (const [name, open] of [
    ["memory", async () => new MemoryIndexStore()],
    ["sqlite", () => SqliteIndexStore.open(":memory:")],
  ] as const) {
    it(`uses the IndexStore's dataset/experiment/judge methods when present (${name})`, async () => {
      const index = await open();
      const root = join(dir, `indexed-${name}`);
      const store = new FileEvalStore({ root, index });
      assert.equal(store.kind, "index");
      const v1 = createDataset({ name: "qa", cases: [{ id: "1", input: "a" }] });
      const v2 = addCases(v1, [{ id: "2", input: "b" }]);
      assert.deepEqual(await store.putDataset(v1, { now: 1 }), { version: v1.version, created: true });
      assert.deepEqual(await store.putDataset(v1, { now: 2 }), { version: v1.version, created: false });
      await store.putDataset(v2, { now: 3, note: "added b" });
      assert.equal((await store.getDataset("qa"))?.version, v2.version);
      assert.deepEqual((await store.listDatasetVersions("qa")).map((h) => [h.version, h.note]), [[v1.version, undefined], [v2.version, "added b"]]);
      assert.deepEqual((await store.listDatasets()).map((d) => [d.id, d.versions, d.cases]), [["qa", 2, 2]]);
      await assert.rejects(store.putDataset({ ...v1, version: "0000000000000000" }), /does not match/);
      await assert.rejects(store.getDataset("../etc"), /invalid dataset id/);
      const judge = { id: "helpful@abc", name: "helpful", criterion: "c", rubric: "r", provider: "p", model: "m", promptHash: "h", params: {}, status: "draft" as const, tunedOn: [], passThreshold: 0.5, createdAt: 1 };
      await store.putJudge(judge);
      assert.deepEqual(await index.getJudge!("helpful@abc"), judge);
      assert.equal((await store.promoteJudge("helpful@abc", { force: true })).status, "production");
      assert.equal(existsSync(root), false, "nothing is written to disk");
      await index.close();
    });
  }

  it("keeps files when the index lacks the optional methods", () => {
    const index = new MemoryIndexStore() as unknown as Record<string, unknown>;
    const partial = Object.create(index, { listJudges: { value: undefined } });
    assert.equal(new FileEvalStore({ root: join(dir, "partial"), index: partial }).kind, "file");
  });

  it("defaults its root to CODING_SH_HOME", () => {
    const store = new FileEvalStore({ env: { CODING_SH_HOME: join(dir, "envhome") } });
    assert.equal(store.datasetsDir, join(dir, "envhome", "datasets"));
  });
});
