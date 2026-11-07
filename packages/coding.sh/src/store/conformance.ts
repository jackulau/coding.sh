// Conformance suites any IndexStore/BlobStore backend can run to prove it
// implements the contract (`node --test` style):
//
//   import { runIndexStoreConformance } from "coding.sh/…/store/conformance.ts";
//   runIndexStoreConformance("postgres", async () => PgIndexStore.open(url));
//
// Each test gets a fresh store from `make` and closes it afterwards.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "../schema/index.ts";
import type { BlobStore, EvalTask, HarnessBundle, IndexStore, Label, RunResult } from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "./common.ts";

let seq = 0;
const REF = (s: string) => sha256Hex(s);

export function fixtureEvent(over: Partial<AgentEvent> = {}): AgentEvent {
  seq++;
  return {
    id: `evt-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    v: 0,
    sessionId: "s1",
    ts: 1_700_000_000_000 + seq,
    agent: "claude-code",
    kind: "notification",
    payload: {},
    ...over,
  };
}

export function fixtureSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude-code",
    startedAt: 1_700_000_000_000,
    stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
    flags: [],
    ...over,
  };
}

export function fixtureTask(over: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "t1",
    name: "fix the parser",
    status: "draft",
    start: { repoRoot: "/repo", snapshot: "abc", head: "def" },
    instruction: "Fix it",
    setup: [],
    verifier: { command: "npm test", hiddenFiles: { "test/a.test.ts": REF("hidden") }, timeoutMs: 60_000 },
    tags: [],
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

export function fixtureBundle(over: Partial<HarnessBundle> = {}): HarnessBundle {
  return {
    id: "b1",
    name: "baseline",
    agent: "claude-code",
    flags: [],
    env: {},
    files: { "CLAUDE.md": REF("claude.md") },
    remove: [],
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

export function fixtureRun(over: Partial<RunResult> = {}): RunResult {
  return {
    id: "r1",
    taskId: "t1",
    bundleId: "b1",
    attempt: 1,
    pass: true,
    verifierExit: 0,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "" },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...over,
  };
}

export function runIndexStoreConformance(name: string, make: () => Promise<IndexStore>): void {
  const withStore = (fn: (s: IndexStore) => Promise<void>) => async () => {
    const s = await make();
    try {
      await fn(s);
    } finally {
      await s.close();
    }
  };

  describe(`IndexStore conformance: ${name}`, () => {
    it("migrate is idempotent", withStore(async (s) => {
      await s.migrate();
      await s.migrate();
      assert.equal(typeof s.kind, "string");
    }));

    it("putEvents is idempotent on id and reports inserted count", withStore(async (s) => {
      const a = fixtureEvent();
      const b = fixtureEvent();
      assert.deepEqual(await s.putEvents([a, b]), { inserted: 2 });
      assert.deepEqual(await s.putEvents([a, b]), { inserted: 0 });
      assert.deepEqual(await s.putEvents([]), { inserted: 0 });
      const c = fixtureEvent();
      assert.deepEqual(await s.putEvents([a, c, c]), { inserted: 1 });
    }));

    it("round-trips every event field", withStore(async (s) => {
      const e: AgentEvent = {
        id: "full",
        v: 0,
        sessionId: "s-full",
        turnId: "turn-1",
        parentId: "p-1",
        ts: 1_700_000_000_123,
        durationMs: 42.5,
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        parentSpanId: "fedcba9876543210",
        subagentId: "sub-1",
        agent: "codex",
        agentVersion: "1.2.3",
        model: "gpt-x",
        kind: "tool.end",
        cwd: "/work/repo",
        repo: { root: "/work/repo", head: "abc", snapshot: "def", partial: true, branch: "main" },
        payload: { tool: "Bash", toolUseId: "tu1", ok: false, nested: { a: [1, "two", null] } },
        blobs: [REF("x"), REF("y")],
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.01 },
        runId: "run-1",
        source: "hook",
      };
      await s.putEvents([e]);
      assert.deepEqual(await s.listEvents("s-full"), [e]);
      const minimal = fixtureEvent({ sessionId: "s-min" });
      await s.putEvents([minimal]);
      assert.deepEqual(await s.listEvents("s-min"), [minimal]);
    }));

    it("listEvents orders by ts and filters by kind, limit, offset", withStore(async (s) => {
      const evs = [
        fixtureEvent({ id: "e3", ts: 3, kind: "tool.start" }),
        fixtureEvent({ id: "e1", ts: 1, kind: "user.message", payload: { text: "hi" } }),
        fixtureEvent({ id: "e2", ts: 2, kind: "tool.end" }),
        fixtureEvent({ id: "other", ts: 0, sessionId: "s2" }),
      ];
      await s.putEvents(evs);
      assert.deepEqual((await s.listEvents("s1")).map((e) => e.id), ["e1", "e2", "e3"]);
      assert.deepEqual((await s.listEvents("s1", { kinds: ["tool.start", "tool.end"] })).map((e) => e.id), ["e2", "e3"]);
      assert.deepEqual((await s.listEvents("s1", { limit: 1, offset: 1 })).map((e) => e.id), ["e2"]);
      assert.deepEqual(await s.listEvents("missing"), []);
    }));

    it("search finds message text with snippets and filters by agent", withStore(async (s) => {
      await s.putEvents([
        fixtureEvent({ id: "u1", kind: "user.message", payload: { text: "Please refactor the tokenizer module" } }),
        fixtureEvent({ id: "a1", kind: "assistant.message", agent: "codex", payload: { text: "I refactored the tokenizer and added tests" } }),
        fixtureEvent({ id: "n1", kind: "notification", payload: { text: "tokenizer" } }),
      ]);
      const hits = await s.search("tokenizer");
      assert.deepEqual(hits.map((h) => h.event.id).sort(), ["a1", "u1"], "only searchable kinds are indexed");
      for (const h of hits) assert.ok(h.snippet.includes(`${SNIPPET_OPEN}tokenizer${SNIPPET_CLOSE}`), h.snippet);
      assert.deepEqual((await s.search("tokenizer", { agent: "codex" })).map((h) => h.event.id), ["a1"]);
      assert.deepEqual((await s.search("refactor tokeni")).length, 2, "every term is a word prefix");
      assert.deepEqual(await s.search("nonexistentword"), []);
      await s.putEvents([fixtureEvent({ id: "cafe", kind: "user.message", payload: { text: "Meet at the Café Zürich" } })]);
      assert.deepEqual((await s.search("cafe zurich")).map((h) => h.event.id), ["cafe"], "diacritics are folded");
      assert.deepEqual(await s.search("   "), []);
      assert.deepEqual(await s.search('"); DROP TABLE events; --'), [], "query syntax is escaped");
      assert.equal((await s.search("tokenizer", { limit: 1 })).length, 1);
    }));

    it("search covers tool calls, tool output and subagent launches", withStore(async (s) => {
      await s.putEvents([
        fixtureEvent({ id: "ts", kind: "tool.start", payload: { tool: "Bash", toolUseId: "x1", input: { command: "pgrep -fl vision_connector.py || echo none", description: "Check the connector" } } }),
        fixtureEvent({ id: "te", kind: "tool.end", payload: { tool: "Bash", toolUseId: "x1", ok: true, output: "4242 python vision_connector.py --watch" } }),
        fixtureEvent({ id: "ws", kind: "tool.start", payload: { tool: "WebSearch", toolUseId: "x2", input: { query: "Emil Kowalski design engineering" } } }),
        fixtureEvent({ id: "rd", kind: "tool.start", payload: { tool: "Read", toolUseId: "x3", input: { file_path: "/repo/src/zebra_parser.ts", limit: 40 } } }),
        fixtureEvent({ id: "mcp", kind: "tool.start", payload: { tool: "TaskStop", server: "tasks", toolUseId: "x4", input: { task_id: "wh0a5clc7" } } }),
        fixtureEvent({ id: "obj", kind: "tool.end", payload: { tool: "Grep", toolUseId: "x5", ok: true, output: { matches: [{ line: "quokka found" }] } } }),
        fixtureEvent({ id: "sub", kind: "subagent.start", payload: { subagentId: "a1", type: "general-purpose", description: "Research narwhal pricing", prompt: "Look up narwhal tiers" } }),
        fixtureEvent({ id: "big", kind: "tool.start", payload: { tool: "Write", toolUseId: "x6", input: { file_path: "/big.txt", content: `${"filler ".repeat(1000)} lastwordmarker` } } }),
      ]);
      const ids = async (q: string) => (await s.search(q)).map((h) => h.event.id).sort();
      assert.deepEqual(await ids("vision_connector.py"), ["te", "ts"], "tool input and output; '_' and '.' split words like FTS");
      assert.deepEqual(await ids("pgrep"), ["ts"]);
      assert.deepEqual(await ids("connector"), ["te", "ts"]);
      assert.deepEqual(await ids("kowalski"), ["ws"], "WebSearch query");
      assert.deepEqual(await ids("zebra_parser"), ["rd"], "file path");
      assert.deepEqual(await ids("TaskStop"), ["mcp"], "tool name");
      assert.deepEqual(await ids("wh0a5clc7"), ["mcp"]);
      assert.deepEqual(await ids("quokka"), ["obj"], "structured output is flattened");
      assert.deepEqual(await ids("narwhal"), ["sub"], "subagent description and prompt");
      assert.deepEqual(await ids("big.txt"), ["big"]);
      assert.deepEqual(await ids("lastwordmarker"), [], "tool text is capped");
      const [hit] = await s.search("pgrep");
      assert.ok(hit!.snippet.includes(`${SNIPPET_OPEN}pgrep${SNIPPET_CLOSE}`), hit!.snippet);
    }));

    it("upserts, gets and lists sessions with filters", withStore(async (s) => {
      await s.upsertSession(fixtureSession({ id: "a", startedAt: 1, agent: "codex", repo: { root: "/r1", head: "h" }, flags: ["compaction"] }));
      await s.upsertSession(fixtureSession({ id: "b", startedAt: 2, runId: "run-1", parent: { sessionId: "a", subagentId: "x", type: "explore" } }));
      await s.upsertSession(fixtureSession({ id: "c", startedAt: 3, title: "hello", endedAt: 4, model: "m" }));
      assert.equal(await s.getSession("missing"), undefined);
      const c = await s.getSession("c");
      assert.equal(c?.title, "hello");
      assert.equal(c?.endedAt, 4);
      assert.deepEqual((await s.getSession("b"))?.parent, { sessionId: "a", subagentId: "x", type: "explore" });
      const ids = async (f?: Parameters<IndexStore["listSessions"]>[0]) => (await s.listSessions(f)).map((x) => x.id);
      assert.deepEqual(await ids(), ["c", "b", "a"], "newest first");
      assert.deepEqual(await ids({ agent: "codex" }), ["a"]);
      assert.deepEqual(await ids({ repoRoot: "/r1" }), ["a"]);
      assert.deepEqual(await ids({ runId: "run-1" }), ["b"]);
      assert.deepEqual(await ids({ runId: null }), ["c", "a"]);
      assert.deepEqual(await ids({ flag: "compaction" }), ["a"]);
      assert.deepEqual(await ids({ parentSessionId: "a" }), ["b"]);
      assert.deepEqual(await ids({ parentSessionId: null }), ["c", "a"]);
      if (s.childCounts) {
        const counts = await s.childCounts(["a", "b", "c"]);
        assert.deepEqual([counts.a ?? 0, counts.b ?? 0, counts.c ?? 0], [1, 0, 0]);
        assert.deepEqual(await s.childCounts([]), {});
        assert.equal((await s.childCounts(["a"], { project: "elsewhere" })).a ?? 0, 0, "only children in the project");
      }
      assert.deepEqual(await ids({ since: 2 }), ["c", "b"]);
      assert.deepEqual(await ids({ until: 2 }), ["a"]);
      assert.deepEqual(await ids({ limit: 1, offset: 1 }), ["b"]);
      // Upsert replaces the row, including clearing optional fields.
      await s.upsertSession(fixtureSession({ id: "c", startedAt: 3, flags: ["no-verification"] }));
      const c2 = await s.getSession("c");
      assert.equal(c2?.title, undefined);
      assert.deepEqual(c2?.flags, ["no-verification"]);
      const full = fixtureSession({
        id: "full",
        agentVersion: "1",
        cwd: "/x",
        endSnapshot: "snap",
        traceIds: ["0123456789abcdef0123456789abcdef"],
        stats: { events: 5, turns: 1, toolCalls: 2, toolErrors: 1, filesChanged: 1, testsPassed: 3, testsFailed: 0, usage: { inputTokens: 5 }, latency: { wallMs: 10, llmCalls: 1 } },
      });
      await s.upsertSession(full);
      assert.deepEqual(await s.getSession("full"), full);
    }));

    it("cursors default to 0 and persist", withStore(async (s) => {
      assert.equal(await s.getCursor("codex/a.jsonl"), 0);
      await s.setCursor("codex/a.jsonl", 123);
      await s.setCursor("codex/a.jsonl", 456);
      assert.equal(await s.getCursor("codex/a.jsonl"), 456);
      assert.equal(await s.getCursor("sink:otel:codex/a.jsonl"), 0);
    }));

    it("stores tasks, bundles, runs and labels", withStore(async (s) => {
      await s.putTask(fixtureTask({ id: "t1", tags: ["parser"], createdAt: 1 }));
      await s.putTask(fixtureTask({ id: "t2", status: "validated", createdAt: 2 }));
      assert.equal((await s.getTask("t1"))?.name, "fix the parser");
      assert.equal(await s.getTask("nope"), undefined);
      assert.deepEqual((await s.listTasks()).map((t) => t.id), ["t2", "t1"]);
      assert.deepEqual((await s.listTasks({ status: "validated" })).map((t) => t.id), ["t2"]);
      assert.deepEqual((await s.listTasks({ tag: "parser" })).map((t) => t.id), ["t1"]);
      await s.putTask(fixtureTask({ id: "t1", status: "archived", createdAt: 1 }));
      assert.equal((await s.getTask("t1"))?.status, "archived");

      await s.putBundle(fixtureBundle({ id: "b1", name: "baseline", createdAt: 1 }));
      await s.putBundle(fixtureBundle({ id: "b2", name: "baseline", createdAt: 2 }));
      assert.equal((await s.getBundle("b1"))?.id, "b1");
      assert.equal((await s.getBundle("baseline"))?.id, "b2", "by name → newest");
      assert.equal(await s.getBundle("none"), undefined);
      assert.deepEqual((await s.listBundles()).map((b) => b.id), ["b2", "b1"]);

      await s.putRun(fixtureRun({ id: "r1", taskId: "t1", bundleId: "b1", experimentId: "x1", startedAt: 1 }));
      await s.putRun(fixtureRun({ id: "r2", taskId: "t2", bundleId: "b2", startedAt: 2, pass: false }));
      assert.deepEqual((await s.listRuns()).map((r) => r.id), ["r1", "r2"]);
      assert.deepEqual((await s.listRuns({ taskId: "t2" })).map((r) => r.id), ["r2"]);
      assert.deepEqual((await s.listRuns({ bundleId: "b1" })).map((r) => r.id), ["r1"]);
      assert.deepEqual((await s.listRuns({ experimentId: "x1" })).map((r) => r.id), ["r1"]);
      assert.equal((await s.listRuns({ taskId: "t2" }))[0]?.pass, false);

      const label: Label = { id: "l1", sessionId: "s1", criterion: "outcome", value: "pass", note: "ok", by: "me", ts: 1 };
      await s.putLabel(label);
      await s.putLabel({ id: "l2", sessionId: "s2", criterion: "judge:x", value: "fail", by: "me", ts: 2 });
      assert.deepEqual(await s.listLabels({ sessionId: "s1" }), [label]);
      assert.deepEqual((await s.listLabels({ criterion: "judge:x" })).map((l) => l.id), ["l2"]);
      assert.equal((await s.listLabels()).length, 2);
    }));

    it("optional kv round-trips and deletes", withStore(async (s) => {
      if (!s.kvGet || !s.kvSet) return;
      assert.equal(await s.kvGet("otel:trace:abc"), undefined);
      await s.kvSet("otel:trace:abc", "sess-1");
      await s.kvSet("otel:trace:abc", "sess-2");
      assert.equal(await s.kvGet("otel:trace:abc"), "sess-2");
      await s.kvSet("otel:trace:abc", undefined);
      assert.equal(await s.kvGet("otel:trace:abc"), undefined);
    }));

    it("optional transaction commits everything on resolve and nothing on throw", withStore(async (s) => {
      if (!s.transaction) return;
      const kept = fixtureEvent({ sessionId: "tx-ok" });
      const out = await s.transaction(async () => {
        await s.putEvents([kept]);
        await s.upsertSession(fixtureSession({ id: "tx-ok" }));
        await s.setCursor("claude-code/tx.jsonl", 10);
        // Reads inside see the transaction's own writes.
        assert.equal((await s.listEvents("tx-ok")).length, 1);
        return "done";
      });
      assert.equal(out, "done");
      const lost = fixtureEvent({ sessionId: "tx-bad" });
      await assert.rejects(
        s.transaction(async () => {
          await s.putEvents([lost]);
          await s.upsertSession(fixtureSession({ id: "tx-bad" }));
          await s.setCursor("claude-code/tx.jsonl", 20);
          // A nested transaction joins the outer one and is undone with it.
          await s.transaction!(async () => s.setCursor("claude-code/nested.jsonl", 5));
          throw new Error("crash");
        }),
        /crash/,
      );
      assert.equal((await s.listEvents("tx-ok")).length, 1);
      assert.ok(await s.getSession("tx-ok"));
      assert.equal(await s.getCursor("claude-code/tx.jsonl"), 10);
      assert.equal((await s.listEvents("tx-bad")).length, 0);
      assert.equal(await s.getSession("tx-bad"), undefined);
      assert.equal(await s.getCursor("claude-code/nested.jsonl"), 0);
      // The store is usable afterwards (no transaction left open).
      assert.deepEqual(await s.putEvents([lost]), { inserted: 1 });
    }));

    it("session parseVersion round-trips and survives an upsert that leaves it unset", withStore(async (s) => {
      const base: Session = { id: "pv", agent: "codex", startedAt: 1, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] };
      await s.upsertSession(base);
      assert.equal((await s.getSession("pv"))?.parseVersion, undefined);
      await s.upsertSession({ ...base, parseVersion: 2 });
      await s.upsertSession({ ...base, title: "later" });
      assert.equal((await s.getSession("pv"))?.parseVersion, 2);
      assert.equal((await s.getSession("pv"))?.title, "later");
    }));

    it("optional replaceSessionEvents swaps one session's rows atomically", withStore(async (s) => {
      if (!s.replaceSessionEvents) return;
      const a1 = fixtureEvent({ sessionId: "ra", kind: "user.message", payload: { text: "zebra crossing" } });
      const a2 = fixtureEvent({ sessionId: "ra" });
      const b1 = fixtureEvent({ sessionId: "rb" });
      await s.putEvents([a1, a2, b1]);
      const a3 = fixtureEvent({ sessionId: "ra", kind: "user.message", payload: { text: "giraffe" } });
      const r = await s.replaceSessionEvents("ra", [a1.id, b1.id, "missing"], [a3]);
      assert.deepEqual(r, { removed: 1, inserted: 1 });
      assert.deepEqual((await s.listEvents("ra")).map((e) => e.id).sort(), [a2.id, a3.id].sort());
      assert.deepEqual((await s.listEvents("rb")).map((e) => e.id), [b1.id], "another session's id is ignored");
      assert.deepEqual(await s.search("zebra"), []);
      assert.deepEqual((await s.search("giraffe")).map((h) => h.event.id), [a3.id]);
    }));

    it("optional datasets are immutable per version with a latest pointer", withStore(async (s) => {
      if (!s.putDataset || !s.getDataset || !s.listDatasets) return;
      const v1 = { id: "qa", name: "QA", version: "v1", cases: [{ id: "c1", input: "a" }] };
      const v2 = { id: "qa", name: "QA", version: "v2", cases: [{ id: "c1", input: "a" }, { id: "c2", input: "b", expected: 2 }] };
      assert.deepEqual(await s.putDataset(v1, { now: 1, note: "first" }), { version: "v1", created: true });
      assert.deepEqual(await s.putDataset(v1, { now: 5 }), { version: "v1", created: false });
      assert.deepEqual(await s.putDataset(v2, { now: 2 }), { version: "v2", created: true });
      assert.equal((await s.getDataset("qa"))?.version, "v2");
      assert.equal((await s.getDataset("qa", "latest"))?.cases.length, 2);
      assert.deepEqual((await s.getDataset("qa", "v1"))?.cases, v1.cases);
      assert.equal((await s.getDataset("qa", "v1"))?.createdAt, 1, "re-put keeps the first createdAt");
      assert.equal(await s.getDataset("qa", "nope"), undefined);
      assert.equal(await s.getDataset("missing"), undefined);
      assert.deepEqual(await s.listDatasets(), [{ id: "qa", name: "QA", latest: "v2", versions: 2, cases: 2 }]);
      if (s.listDatasetVersions) {
        assert.deepEqual(await s.listDatasetVersions("qa"), [
          { version: "v1", cases: 1, createdAt: 1, note: "first" },
          { version: "v2", cases: 2, createdAt: 2 },
        ]);
      }
      // Re-putting an old version moves latest back to it.
      await s.putDataset(v1);
      assert.equal((await s.getDataset("qa"))?.version, "v1");
    }));

    it("optional experiments and judges round-trip", withStore(async (s) => {
      if (s.putExperiment && s.getExperiment && s.listExperiments) {
        const exp = (id: string, datasetId: string, name = "base") => ({
          id, name, dataset: { id: datasetId, name: datasetId, version: "v1" }, task: { kind: "command" as const, ref: "echo" },
          graders: [], trials: 1, createdAt: 1, finishedAt: 2, runs: [],
          summary: { n: 0, cases: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0 }, ciMethod: "wilson" as const, graders: [], latencyMs: { mean: 0, median: 0, p90: 0, max: 0 } },
        });
        await s.putExperiment(exp("x1", "qa"));
        await s.putExperiment(exp("x2", "qa", "tuned"));
        await s.putExperiment(exp("x3", "other"));
        assert.deepEqual(await s.getExperiment("x2"), exp("x2", "qa", "tuned"));
        assert.equal(await s.getExperiment("nope"), undefined);
        assert.deepEqual((await s.listExperiments()).map((r) => r.id), ["x3", "x2", "x1"], "newest first");
        assert.deepEqual((await s.listExperiments({ datasetId: "qa" })).map((r) => r.id), ["x2", "x1"]);
        assert.deepEqual((await s.listExperiments({ name: "tuned" })).map((r) => r.id), ["x2"]);
        assert.deepEqual((await s.listExperiments({ limit: 1 })).map((r) => r.id), ["x3"]);
      }
      if (s.putJudge && s.getJudge && s.listJudges) {
        const judge = (id: string, status: "draft" | "production" = "draft") => ({
          id, name: id.split("@")[0]!, criterion: "helpful", rubric: "r", provider: "anthropic", model: "m", promptHash: "h",
          params: {}, status, tunedOn: ["dev" as const], passThreshold: 0.5, createdAt: 1,
        });
        await s.putJudge(judge("b@2"));
        await s.putJudge(judge("a@1"));
        await s.putJudge(judge("b@2", "production"));
        assert.equal((await s.getJudge("b@2"))?.status, "production");
        assert.equal(await s.getJudge("c@3"), undefined);
        assert.deepEqual((await s.listJudges()).map((j) => j.id), ["a@1", "b@2"]);
      }
    }));

    it("round-trips projects and filters sessions by project", withStore(async (s) => {
      const scoped = fixtureEvent({ id: "p-e1", sessionId: "demo/s1", project: "demo" });
      const plain = fixtureEvent({ id: "p-e2", sessionId: "s-plain" });
      const explicitDefault = fixtureEvent({ id: "p-e3", sessionId: "s-plain", project: "default" });
      await s.putEvents([scoped, plain, explicitDefault]);
      assert.deepEqual(await s.listEvents("demo/s1"), [scoped]);
      const back = await s.listEvents("s-plain");
      assert.deepEqual(back.map((e) => e.id), ["p-e2", "p-e3"]);
      for (const e of back) assert.equal(e.project, undefined, "'default' reads back as unset");
      await s.upsertSession(fixtureSession({ id: "demo/s1", startedAt: 3, project: "demo" }));
      await s.upsertSession(fixtureSession({ id: "other/s1", startedAt: 2, project: "other" }));
      await s.upsertSession(fixtureSession({ id: "s-plain", startedAt: 1 }));
      await s.upsertSession(fixtureSession({ id: "s-default", startedAt: 0, project: "default" }));
      assert.equal((await s.getSession("demo/s1"))?.project, "demo");
      assert.equal((await s.getSession("s-default"))?.project, undefined);
      const ids = async (project?: string) => (await s.listSessions(project === undefined ? {} : { project })).map((x) => x.id);
      assert.deepEqual(await ids(), ["demo/s1", "other/s1", "s-plain", "s-default"]);
      assert.deepEqual(await ids("demo"), ["demo/s1"]);
      assert.deepEqual(await ids("default"), ["s-plain", "s-default"]);
      assert.deepEqual(await ids("nope"), []);
    }));

    it("search filters by project", withStore(async (s) => {
      await s.putEvents([
        fixtureEvent({ id: "sp1", sessionId: "demo/a", project: "demo", kind: "user.message", payload: { text: "pong from demo" } }),
        fixtureEvent({ id: "sp2", sessionId: "flood/a", project: "flood", kind: "user.message", payload: { text: "pong from flood" } }),
        fixtureEvent({ id: "sp3", sessionId: "local", kind: "assistant.message", payload: { text: "pong locally" } }),
      ]);
      const ids = async (project?: string) => (await s.search("pong", project === undefined ? {} : { project })).map((h) => h.event.id).sort();
      assert.deepEqual(await ids(), ["sp1", "sp2", "sp3"]);
      assert.deepEqual(await ids("demo"), ["sp1"]);
      assert.deepEqual(await ids("default"), ["sp3"]);
      const [hit] = await s.search("pong", { project: "demo" });
      assert.equal(hit!.event.project, "demo");
    }));

    it("optional deleteBefore drops old sessions with their events and labels", withStore(async (s) => {
      if (!s.deleteBefore) return;
      await s.putEvents([
        fixtureEvent({ id: "old-1", sessionId: "old", ts: 10, kind: "user.message", payload: { text: "ancient zebrafish" } }),
        fixtureEvent({ id: "old-2", sessionId: "old", ts: 11 }),
        fixtureEvent({ id: "ended-1", sessionId: "ended-late", ts: 10 }),
        fixtureEvent({ id: "new-1", sessionId: "new", ts: 500, kind: "user.message", payload: { text: "fresh zebrafish" } }),
        fixtureEvent({ id: "demo-1", sessionId: "demo/old", ts: 10, project: "demo" }),
      ]);
      await s.upsertSession(fixtureSession({ id: "old", startedAt: 10, endedAt: 20 }));
      await s.upsertSession(fixtureSession({ id: "ended-late", startedAt: 10, endedAt: 400 }));
      await s.upsertSession(fixtureSession({ id: "new", startedAt: 500 }));
      await s.upsertSession(fixtureSession({ id: "demo/old", startedAt: 10, project: "demo" }));
      await s.putLabel({ id: "lab-old", sessionId: "old", criterion: "outcome", value: "pass", by: "me", ts: 1 });
      await s.putLabel({ id: "lab-new", sessionId: "new", criterion: "outcome", value: "pass", by: "me", ts: 2 });
      await s.putTask(fixtureTask({ id: "keep-task", sourceSessionId: "old" }));

      assert.deepEqual(await s.deleteBefore(100, { project: "default" }), { sessions: 1, events: 2 });
      assert.equal(await s.getSession("old"), undefined);
      assert.deepEqual(await s.listEvents("old"), []);
      assert.ok(await s.getSession("ended-late"), "endedAt counts as activity, not only startedAt");
      assert.ok(await s.getSession("demo/old"), "other projects are untouched");
      assert.deepEqual((await s.listLabels()).map((l) => l.id), ["lab-new"]);
      assert.ok(await s.getTask("keep-task"), "eval assets are never deleted");
      assert.deepEqual((await s.search("zebrafish")).map((h) => h.event.id), ["new-1"], "search index forgets deleted events");

      assert.deepEqual(await s.deleteBefore(100), { sessions: 1, events: 1 });
      assert.equal(await s.getSession("demo/old"), undefined);
      assert.deepEqual(await s.deleteBefore(100), { sessions: 0, events: 0 });
    }));

    it("optional deleteBefore judges a session by its last activity, not its recorded end", withStore(async (s) => {
      if (!s.deleteBefore) return;
      await s.putEvents([
        // Resumed: the first run ended long ago, the resumed run is still writing.
        fixtureEvent({ id: "res-1", sessionId: "resumed", ts: 10, kind: "session.start" }),
        fixtureEvent({ id: "res-2", sessionId: "resumed", ts: 20, kind: "session.end" }),
        fixtureEvent({ id: "res-3", sessionId: "resumed", ts: 600, kind: "user.message", payload: { text: "still going" } }),
        // Never sent session.end; its last tool call ends after the cutoff.
        fixtureEvent({ id: "open-1", sessionId: "open", ts: 10, kind: "session.start" }),
        fixtureEvent({ id: "open-2", sessionId: "open", ts: 50, durationMs: 100, kind: "tool.end", payload: { tool: "Bash" } }),
        fixtureEvent({ id: "stale-1", sessionId: "stale", ts: 10 }),
        fixtureEvent({ id: "stale-2", sessionId: "stale", ts: 90, durationMs: 5 }),
      ]);
      await s.upsertSession(fixtureSession({ id: "resumed", startedAt: 10, endedAt: 20 }));
      await s.upsertSession(fixtureSession({ id: "open", startedAt: 10 }));
      await s.upsertSession(fixtureSession({ id: "stale", startedAt: 10, endedAt: 95 }));
      assert.deepEqual(await s.deleteBefore(100), { sessions: 1, events: 2 });
      assert.equal(await s.getSession("stale"), undefined);
      assert.ok(await s.getSession("resumed"), "an event after the cutoff keeps a session that ended before it");
      assert.equal((await s.listEvents("resumed")).length, 3);
      assert.ok(await s.getSession("open"), "an event's end (ts + durationMs) counts as activity");
      assert.deepEqual(await s.deleteBefore(601), { sessions: 2, events: 5 });
    }));

    it("optional deleteBefore keeps search working when messages have empty text", withStore(async (s) => {
      if (!s.deleteBefore) return;
      const msg = (id: string, sessionId: string, ts: number, text: string) =>
        fixtureEvent({ id, sessionId, ts, kind: id.startsWith("u") ? "user.message" : "assistant.message", payload: { text } });
      await s.putEvents([
        msg("a-empty-1", "all-empty", 10, ""),
        msg("u-empty-2", "all-empty", 11, ""),
        msg("a-mixed-1", "mixed", 10, ""),
        msg("u-mixed-2", "mixed", 11, "hello world"),
        msg("a-keep", "keep", 500, "refactor the tokenizer"),
        msg("u-keep-empty", "keep", 501, ""),
      ]);
      await s.upsertSession(fixtureSession({ id: "all-empty", startedAt: 10, endedAt: 11 }));
      await s.upsertSession(fixtureSession({ id: "mixed", startedAt: 10, endedAt: 11 }));
      await s.upsertSession(fixtureSession({ id: "keep", startedAt: 500 }));
      assert.deepEqual(await s.deleteBefore(100), { sessions: 2, events: 4 });
      assert.deepEqual((await s.search("tokeni")).map((h) => h.event.id), ["a-keep"]);
      assert.deepEqual(await s.search("hello"), []);
      assert.deepEqual(await s.deleteBefore(100), { sessions: 0, events: 0 });
      assert.deepEqual(await s.deleteBefore(1000), { sessions: 1, events: 2 });
      assert.deepEqual(await s.search("tokeni"), []);
    }));

    it("getBundle by name breaks a createdAt tie by the greatest id", withStore(async (s) => {
      await s.putBundle(fixtureBundle({ id: "b-aaa", name: "tied", createdAt: 1 }));
      await s.putBundle(fixtureBundle({ id: "b-zzz", name: "tied", createdAt: 1 }));
      await s.putBundle(fixtureBundle({ id: "b-mmm", name: "tied", createdAt: 1 }));
      assert.equal((await s.getBundle("tied"))?.id, "b-zzz");
    }));

    it("optional listExperiments: limit 0 is none, negative is no limit", withStore(async (s) => {
      if (!s.putExperiment || !s.listExperiments) return;
      for (const id of ["x1", "x2"]) {
        await s.putExperiment({
          id, name: "e", dataset: { id: "d", name: "d", version: "v" }, task: { kind: "command", ref: "echo" }, graders: [], trials: 1, createdAt: 1, finishedAt: 2, runs: [],
          summary: { n: 0, cases: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0 }, ciMethod: "wilson", graders: [], latencyMs: { mean: 0, median: 0, p90: 0, max: 0 } },
        });
      }
      assert.deepEqual(await s.listExperiments({ limit: 0 }), []);
      assert.deepEqual((await s.listExperiments({ limit: -1 })).map((r) => r.id), ["x2", "x1"]);
      assert.deepEqual((await s.listExperiments({})).map((r) => r.id), ["x2", "x1"]);
    }));

    it("optional listDatasetVersions keeps insertion order whatever createdAt says", withStore(async (s) => {
      if (!s.putDataset || !s.listDatasetVersions) return;
      await s.putDataset({ id: "d", name: "d", version: "v-new", cases: [] }, { now: 2000 });
      await s.putDataset({ id: "d", name: "d", version: "v-old", cases: [] }, { now: 1000 });
      await s.putDataset({ id: "d", name: "d", version: "v-new", cases: [] }, { now: 3000 });
      assert.deepEqual((await s.listDatasetVersions("d")).map((v) => [v.version, v.createdAt]), [["v-new", 2000], ["v-old", 1000]]);
    }));

    it("concurrent overlapping putEvents insert each id once", withStore(async (s) => {
      const evs = Array.from({ length: 60 }, (_, i) => fixtureEvent({ id: `cc-${i}`, sessionId: `cc-${i % 3}` }));
      const [a, b] = await Promise.all([s.putEvents(evs.slice(0, 40)), s.putEvents(evs.slice(20))]);
      assert.equal(a.inserted + b.inserted, 60);
      let stored = 0;
      for (const id of ["cc-0", "cc-1", "cc-2"]) stored += (await s.listEvents(id)).length;
      assert.equal(stored, 60);
    }));

    it("optional ping and writer lock", withStore(async (s) => {
      if (s.ping) await s.ping();
      if (!s.acquireWriterLock) return;
      const lock = await s.acquireWriterLock();
      assert.ok(lock, "the first caller gets the lock");
      assert.equal(await s.acquireWriterLock(), undefined, "a second caller does not");
      await lock.release();
      const again = await s.acquireWriterLock();
      assert.ok(again, "released locks can be taken again");
      await again.release();
    }));

    it("referencedBlobs covers events, tasks, bundles and runs without duplicates", withStore(async (s) => {
      const shared = REF("shared");
      await s.putEvents([fixtureEvent({ blobs: [shared, REF("e1")] }), fixtureEvent({ blobs: [shared] }), fixtureEvent()]);
      await s.putTask(fixtureTask({
        referencePatch: REF("patch"),
        nearMissPatches: [REF("nm1")],
        validation: {
          ok: true, ts: 1, noopFails: true, referencePasses: { passed: 1, of: 1 }, nearMissesFail: { failed: 1, of: 1 }, leakage: [],
          impossible: { gameable: false, tried: 1, passedByReference: [], variant: { label: "flip", noopFails: true, hiddenFiles: { "test/a.test.ts": REF("variant-hidden"), "test/b.test.ts": shared } } },
        },
      }));
      await s.putTask(fixtureTask({ id: "t-variant-without-files", verifier: { command: "x", hiddenFiles: {}, timeoutMs: 1 }, validation: {
        ok: true, ts: 1, noopFails: true, referencePasses: { passed: 1, of: 1 }, nearMissesFail: { failed: 0, of: 0 }, leakage: [],
        impossible: { gameable: true, tried: 1, passedByReference: ["flip"] },
      } }));
      await s.putBundle(fixtureBundle());
      await s.putRun(fixtureRun({ diffBlob: REF("diff") }));
      // toolevals trials keep their tap log on the run (RunResult.tapBlob).
      await s.putRun({ ...fixtureRun({ id: "r-tap" }), tapBlob: REF("tap") } as RunResult);
      const refs: string[] = [];
      for await (const r of s.referencedBlobs()) refs.push(r);
      assert.deepEqual(refs.sort(), [shared, REF("e1"), REF("patch"), REF("nm1"), REF("hidden"), REF("variant-hidden"), REF("claude.md"), REF("diff"), REF("tap")].sort());
    }));
  });
}

export function runBlobStoreConformance(name: string, make: () => Promise<BlobStore>): void {
  const withStore = (fn: (s: BlobStore) => Promise<void>) => async () => {
    const s = await make();
    await fn(s);
  };

  describe(`BlobStore conformance: ${name}`, () => {
    it("put returns the sha256 of the uncompressed bytes and round-trips", withStore(async (s) => {
      const bytes = new Uint8Array([0, 1, 2, 255, 254]);
      const ref = await s.put(bytes);
      assert.equal(ref, sha256Hex(bytes));
      assert.deepEqual(await s.get(ref), bytes);
      const tref = await s.put("héllo wörld ✓");
      assert.equal(tref, sha256Hex("héllo wörld ✓"));
      assert.equal(await s.getText(tref), "héllo wörld ✓");
      const empty = await s.put("");
      assert.equal(await s.getText(empty), "");
    }));

    it("dedupes identical content (string and bytes alike)", withStore(async (s) => {
      const a = await s.put("same content");
      const b = await s.put(new TextEncoder().encode("same content"));
      assert.equal(a, b);
      const listed: string[] = [];
      for await (const r of s.list()) listed.push(r);
      assert.deepEqual(listed, [a]);
    }));

    it("handles concurrent puts of the same content", withStore(async (s) => {
      const big = "x".repeat(200_000) + Math.random();
      const refs = await Promise.all(Array.from({ length: 16 }, () => s.put(big)));
      assert.equal(new Set(refs).size, 1);
      assert.equal(await s.getText(refs[0]!), big);
    }));

    it("has() checks a batch; get() of a missing blob is undefined", withStore(async (s) => {
      const a = await s.put("a");
      const missing = sha256Hex("never stored");
      assert.deepEqual(await s.has([a, missing, a]), [true, false, true]);
      assert.deepEqual(await s.has([]), []);
      assert.equal(await s.get(missing), undefined);
      assert.equal(await s.getText(missing), undefined);
    }));

    it("lists and deletes", withStore(async (s) => {
      const refs = [await s.put("one"), await s.put("two"), await s.put("three")];
      const listed: string[] = [];
      for await (const r of s.list()) listed.push(r);
      assert.deepEqual(listed.sort(), [...refs].sort());
      await s.delete(refs[0]!);
      await s.delete(refs[0]!); // deleting twice is fine
      assert.deepEqual(await s.has(refs), [false, true, true]);
      if (s.size) assert.ok((await s.size()) > 0);
    }));

    it("rejects malformed refs instead of touching arbitrary paths", withStore(async (s) => {
      await assert.rejects(() => s.get("../../etc/passwd"));
      await assert.rejects(() => s.delete("not-a-ref"));
    }));

    it("optional batch: puts return refs at once, read back through the batch, and land on flush", withStore(async (s) => {
      if (!s.batch) return;
      const b = s.batch();
      const texts = Array.from({ length: 40 }, (_, i) => `batched blob ${i} ${Math.random()}`);
      const refs = await Promise.all(texts.map((t) => b.put(t)));
      assert.deepEqual(refs, texts.map((t) => sha256Hex(t)));
      assert.equal(await b.put(texts[0]!), refs[0], "a repeat put in the batch is the same ref");
      assert.equal(await b.getText(refs[3]!), texts[3]);
      assert.deepEqual(await b.has([refs[5]!, sha256Hex("never stored")]), [true, false]);
      await b.flush();
      for (const [i, ref] of refs.entries()) assert.equal(await s.getText(ref), texts[i]);
      await b.flush(); // nothing left: a no-op
      // The batch stays usable after a flush.
      const later = await b.put("after the flush");
      await b.flush();
      assert.equal(await s.getText(later), "after the flush");
    }));
  });
}
