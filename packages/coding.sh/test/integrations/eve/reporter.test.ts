// codingShReporter → the in-process OTLP receiver (route /v1/evals/eve) → a
// dataset version and an experiment. The run is a real `eve eval` of
// examples/eve-agent (fixtures/evals/run.json), driven through eve's reporter
// lifecycle: onRunStart, onEvalComplete per eval, onRunComplete.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FileEvalStore } from "../../../src/datasets/store.ts";
import { codingShReporter, defaultEveDataset } from "../../../src/integrations/eve/reporter.ts";
import { createEveEvalsHandler, EVE_EVALS_PATH, eveEvalsToExperiment, parseEveEvalsUpload, type EveEvalInfo, type EveEvalResultLike, type StoredEveRun } from "../../../src/integrations/eve/evals.ts";
import { compactEveResult } from "../../../src/integrations/eve/upload.ts";
import { startReceiver, type Receiver } from "../../../src/otel/receiver.ts";
import { generateKey } from "../../../src/server/auth.ts";
import { resolveServeConfig } from "../../../src/server/config.ts";
import { createLogger } from "../../../src/server/log.ts";
import { startServe } from "../../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../src/store/memory.ts";
import { FIXTURES, readJson } from "./helpers.ts";

interface Fixture {
  evals: EveEvalInfo[];
  summary: { target: { kind: string; url: string }; startedAt: string; completedAt: string; results: EveEvalResultLike[] };
}
const RUN = readJson(join(FIXTURES, "evals", "run.json")) as Fixture;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "csh-eve-evals-"));
  dirs.push(d);
  return d;
};

async function receiver(): Promise<{ r: Receiver; index: MemoryIndexStore; store: FileEvalStore }> {
  const index = new MemoryIndexStore();
  const store = new FileEvalStore({ root: tmp(), index });
  const r = await startReceiver({ port: 0, store: index, blobs: new MemoryBlobStore(), routes: { [EVE_EVALS_PATH]: createEveEvalsHandler({ store }) } });
  closers.push(() => r.close());
  return { r, index, store };
}

/** Drive a reporter the way `eve eval` does. */
async function runEve(reporter: ReturnType<typeof codingShReporter>, run: Fixture): Promise<void> {
  reporter.onRunStart(run.evals, run.summary.target);
  for (const res of run.summary.results) reporter.onEvalComplete(res, { evaluation: run.evals.find((e) => e.id === res.id)! });
  await reporter.onRunComplete(run.summary);
}

function reporterTo(url: string, extra: Partial<Parameters<typeof codingShReporter>[0]> = {}) {
  const lines: string[] = [];
  const stored: StoredEveRun[] = [];
  const rep = codingShReporter({ url, dataset: "weather", log: (l) => lines.push(l), onStored: (s) => stored.push(s), env: {}, ...extra });
  return { rep, lines, stored };
}

/** A second run: Tokyo now fails a gate, the follow-up eval misses a soft threshold, a new eval is skipped. */
function changedRun(): Fixture {
  const run = clone(RUN);
  const tokyo = run.summary.results[1]!;
  tokyo.verdict = "failed";
  const inc = tokyo.assertions.find((a) => a.name.startsWith("includes("))!;
  Object.assign(inc, { score: 0, passed: false, message: 'expected the reply to include "Tokyo: Cloudy"' });
  const follow = run.summary.results[2]!;
  follow.verdict = "scored";
  follow.assertions = [...follow.assertions, { name: "judge.score", key: "tone", score: 0.4, severity: "soft", threshold: 0.7, passed: false, errored: false, message: "tone 0.4 < 0.7" }];
  run.evals.push({ id: "weather/0004", description: "a city the mock does not know yet", tags: ["weather"] });
  run.summary.results.push({ id: "weather/0004", verdict: "skipped", skipReason: "needs a real model", assertions: [], startedAt: run.summary.startedAt, completedAt: run.summary.startedAt });
  run.summary.startedAt = "2026-11-06T21:00:00.000Z";
  run.summary.completedAt = "2026-11-06T21:00:02.000Z";
  return run;
}

describe("eve EvalReporter (codingShReporter)", () => {
  it("stores a real eve eval run as a dataset version and an experiment with per-case scores", async () => {
    const { r, store } = await receiver();
    const { rep, lines, stored } = reporterTo(r.url);
    await runEve(rep, RUN);

    assert.equal(stored.length, 1, lines.join("\n"));
    const s = stored[0]!;
    assert.equal(s.dataset.id, "weather");
    assert.equal(s.dataset.created, true);
    assert.equal(s.dataset.cases, 4);
    assert.equal(s.experiment.created, true);
    assert.match(lines[0]!, /^coding\.sh: 4\/4 passed\. Experiment exp_\w+ on dataset weather@\w+ \(new version\)\. See it: coding\.sh exp show exp_\w+$/);

    const ds = await store.getDataset("weather");
    assert.ok(ds);
    assert.deepEqual(ds.cases.map((c) => c.id), ["weather/0000", "weather/0001", "weather/0002", "weather/0003"]);
    assert.deepEqual(ds.cases[3]!.input, { eval: "weather/0003", description: "unknown city: the tool fails and the agent says so" });
    assert.deepEqual(ds.cases[2]!.tags, ["weather", "multi-turn"]);
    assert.equal((await store.listDatasetVersions("weather")).length, 1);

    const exp = await store.getExperiment(s.experiment.id);
    assert.ok(exp);
    assert.equal(exp.status, "completed");
    assert.deepEqual(exp.dataset, { id: "weather", name: "weather", version: ds.version });
    assert.equal(exp.task.kind, "http");
    assert.equal(exp.task.ref, `eve eval (local) ${RUN.summary.target.url}`);
    assert.equal(exp.trials, 1);
    assert.equal(exp.runs.length, 4);
    assert.equal(exp.summary.passed, 4);
    assert.equal(exp.summary.passRate.p, 1);
    assert.deepEqual(exp.metadata?.eve, { passed: 4, failed: 0, scored: 0, skipped: 0, errored: 0 });

    // Per-case scores, one grader per eve assertion name (eve's own reporter naming).
    const paris = exp.runs.find((x) => x.caseId === "weather/0000")!;
    assert.deepEqual(paris.grades.map((g) => [g.graderId, g.result?.score, g.result?.pass]), [
      ["gate:succeeded", 1, true],
      ["gate:calledTool(get_weather)", 1, true],
      ["gate:calledAgent(forecaster)", 1, true],
      ["gate:includes(Paris: Sunny, 21°C. Outlook: staying clear through tomorrow.)", 1, true],
    ]);
    assert.equal(paris.latencyMs, 641);
    const out = paris.output as Record<string, unknown>;
    assert.equal(out.output, "Paris: Sunny, 21°C. Outlook: staying clear through tomorrow.");
    assert.equal(out.sessionId, "wrun_01M6S8RERRHAA7WM2A3H94NE5E", "links to the coding.sh session the OTel spans made");
    assert.deepEqual(out.toolCalls, ["get_weather", "forecaster", "eve__task_wait"], "eve's own derived.toolCalls, in order");
    assert.deepEqual(out.subagentCalls, ["forecaster"]);
    const tool = exp.summary.graders.find((g) => g.id === "gate:calledTool(get_weather)")!;
    assert.deepEqual([tool.kind, tool.n, tool.passed, tool.meanScore], ["eve-gate", 3, 3, 1]);
  });

  it("adds nothing when the same run is sent again", async () => {
    const { r, store } = await receiver();
    const first = reporterTo(r.url);
    await runEve(first.rep, RUN);
    const again = reporterTo(r.url);
    await runEve(again.rep, RUN);
    assert.equal(again.stored[0]!.experiment.created, false);
    assert.equal(again.stored[0]!.experiment.id, first.stored[0]!.experiment.id);
    assert.equal(again.stored[0]!.dataset.created, false);
    assert.equal((await store.listExperiments()).length, 1);
  });

  it("makes a new dataset version and records failed, scored and skipped evals", async () => {
    const { r, store } = await receiver();
    await runEve(reporterTo(r.url).rep, RUN);
    const second = reporterTo(r.url, { name: "weather v2", metadata: { commit: "abc123" } });
    await runEve(second.rep, changedRun());
    const s = second.stored[0]!;
    assert.equal(s.dataset.created, true);
    assert.equal(s.dataset.cases, 5);
    assert.equal((await store.listDatasetVersions("weather")).length, 2);
    assert.match(second.lines[0]!, /^coding\.sh: 2\/4 passed\./);

    const exp = (await store.getExperiment(s.experiment.id))!;
    assert.equal(exp.name, "weather v2");
    assert.equal(exp.metadata?.commit, "abc123");
    assert.equal(exp.runs.length, 4, "the skipped eval has no run");
    assert.deepEqual(exp.metadata?.skipped, [{ id: "weather/0004", reason: "needs a real model" }]);
    assert.deepEqual(exp.metadata?.eve, { passed: 2, failed: 1, scored: 1, skipped: 1, errored: 0 });
    const tokyo = exp.runs.find((x) => x.caseId === "weather/0001")!;
    assert.equal(tokyo.pass, false);
    const inc = tokyo.grades.find((g) => g.graderId.startsWith("gate:includes("))!;
    assert.deepEqual(inc.result, { score: 0, pass: false, reason: 'expected the reply to include "Tokyo: Cloudy"' });
    const follow = exp.runs.find((x) => x.caseId === "weather/0002")!;
    assert.equal(follow.pass, false, "scored (a soft threshold missed) is not a pass");
    assert.deepEqual(follow.grades.find((g) => g.graderId === "tone")?.result, { score: 0.4, pass: false, reason: "tone 0.4 < 0.7" });
    assert.equal(exp.summary.graders.find((g) => g.id === "tone")?.kind, "eve-score");
  });

  it("maps repeated attempts to trials", () => {
    const up = parseEveEvalsUpload({
      v: 1,
      source: "eve",
      startedAt: RUN.summary.startedAt,
      completedAt: RUN.summary.completedAt,
      evals: RUN.evals,
      results: RUN.summary.results.flatMap((x) => [1, 2].map((attempt) => compactEveResult({ ...x, attempt }))),
    });
    const { experiment } = eveEvalsToExperiment(up);
    assert.equal(experiment.trials, 2);
    assert.equal(experiment.runs.length, 8);
    assert.equal(experiment.summary.ciMethod, "cluster-bootstrap");
    assert.deepEqual([...new Set(experiment.runs.map((x) => x.trial))], [1, 2]);
  });

  it("redacts secrets before storing", async () => {
    const { r, store } = await receiver();
    const run = clone(RUN);
    const key = ["sk-ant-api03-", "A".repeat(80), "AA"].join("");
    (run.summary.results[0]!.result as { reply: string }).reply = `the key is ${key}`;
    const { stored } = reporterTo(r.url);
    await runEve(codingShReporter({ url: r.url, dataset: "weather", log: () => {}, onStored: (s) => stored.push(s), env: {} }), run);
    const exp = (await store.getExperiment(stored[0]!.experiment.id))!;
    const text = JSON.stringify(exp);
    assert.ok(!text.includes(key));
    assert.match(text, /\[redacted:/);
  });

  it("never fails the eve run when coding.sh is not running", async () => {
    const { r } = await receiver();
    const url = r.url;
    await r.close();
    const { rep, lines, stored } = reporterTo(url);
    await runEve(rep, RUN);
    assert.equal(stored.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^coding\.sh: could not send the eval run to http:\/\/127\.0\.0\.1:\d+ \(.+\)\. Start one with: coding\.sh collector$/);
  });

  it("names the dataset after the eve app by default and sends the ingest key", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/eve-agent-example" }));
    assert.equal(defaultEveDataset(dir), "eve-agent-example evals");
    mkdirSync(join(dir, "bare"));
    assert.equal(defaultEveDataset(join(dir, "bare")), "bare evals");
    const seen: { url: string; auth: string | null; body: { dataset: string } }[] = [];
    const fake: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ error: "nope" }), { status: 401 });
    };
    const lines: string[] = [];
    await runEve(codingShReporter({ cwd: dir, fetch: fake, log: (l) => lines.push(l), env: { CODING_SH_URL: "https://cs.example.com/", CODING_SH_INGEST_KEY: "csh_ik_test" } }), RUN);
    assert.equal(seen[0]!.url, "https://cs.example.com/v1/evals/eve");
    assert.equal(seen[0]!.auth, "Bearer csh_ik_test");
    assert.equal(seen[0]!.body.dataset, "eve-agent-example evals");
    assert.deepEqual(lines, ["coding.sh: the eval run was not stored (401: nope)"]);
  });

  it("refuses browsers, other content types, bad uploads and non-loopback hosts", async () => {
    const { r } = await receiver();
    const post = (body: string, headers: Record<string, string>) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request(`${r.url}${EVE_EVALS_PATH}`, { method: "POST", headers }, (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    const json = { "content-type": "application/json" };
    assert.equal((await post("{}", { ...json, origin: "https://evil.example" })).status, 403);
    assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
    const bad = await post(JSON.stringify({ v: 1, source: "eve", results: [{ id: "x", verdict: "maybe" }] }), json);
    assert.equal(bad.status, 400);
    assert.match(bad.text, /verdict must be one of/);
    assert.equal((await post("{not json", json)).status, 400);
    assert.equal((await post("{}", { ...json, host: "evil.example:4318" })).status, 403);
    // OTLP routes still answer as before.
    assert.equal((await fetch(`${r.url}/v1/traces`, { method: "POST", headers: json, body: "{}" })).status, 200);
  });

  it("stores runs on coding.sh serve with an ingest key", async () => {
    const root = tmp();
    const ik = generateKey("ingest");
    const rk = generateKey("read");
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_STORE_URL: "memory://", CODING_SH_INGEST_KEYS: `demo:${ik}`, CODING_SH_READ_KEYS: `*:${rk}` };
    mkdirSync(env.HOME);
    const cfg = resolveServeConfig({ port: 0 }, env);
    const h = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() } });
    closers.push(async () => void (await h.shutdown()));
    const denied = reporterTo(h.url);
    await runEve(denied.rep, RUN);
    assert.match(denied.lines[0]!, /not stored \(401: missing or invalid ingest key/);
    const ok = reporterTo(h.url, { key: ik });
    await runEve(ok.rep, RUN);
    const id = ok.stored[0]!.experiment.id;
    const res = await fetch(`${h.url}/api/experiments/${id}`, { headers: { authorization: `Bearer ${rk}` } });
    assert.equal(res.status, 200);
    const detail = (await res.json()) as { id: string };
    assert.equal(detail.id, id);
  });
});
