// The job checkpoint (src/jobs): trial lines survive torn writes, progress and
// ETA come from the lines, a dead owner reads as interrupted, config hashes name
// what changed, and only infrastructure errors are retried.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { configChanges, jobConfig, taskFingerprint } from "../../src/jobs/config.ts";
import { backoffMs, DEFAULT_STOP_AFTER, infraKind, infraStopFor, infraStopText, retryAfterMs, retryPolicy, voidText, withRetries } from "../../src/jobs/retry.ts";
import { JobStore, liveStatus, parseLines, progressOf, STALE_MS, type JobHeader } from "../../src/jobs/store.ts";

const root = mkdtempSync(join(tmpdir(), "csh-jobs-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("JobStore", () => {
  it("checkpoints trials, skips a torn last line, and resumes with the finished ones", async () => {
    const store = new JobStore(root);
    const job = await store.create({ id: "exp_a1", kind: "exp run", name: "a", config: jobConfig({ x: 1 }), total: 3, concurrency: 2 });
    await job.record({ key: "c1", at: Date.now(), ms: 100, outcome: "pass", costUsd: 0.5 });
    await job.record({ key: "c2", at: Date.now(), ms: 200, infra: "rate-limit", attempts: 4 });
    appendFileSync(store.logPath("exp_a1"), '{"key":"c3","at":1,"ms'); // killed mid-write
    await job.finish("interrupted");
    const v = (await store.get("exp_a1"))!;
    assert.equal(v.status, "interrupted");
    assert.deepEqual([...v.lines.keys()], ["c1", "c2"]);
    assert.equal(v.progress.done, 1);
    assert.equal(v.progress.infra, 1);
    assert.equal(v.progress.retries, 3);
    assert.equal(v.progress.costUsd, 0.5);
    const again = await store.resume("exp_a1");
    assert.equal(again.resumed, true);
    assert.equal(again.lines.size, 2);
    // The infra trial runs again; its new line wins.
    await again.record({ key: "c2", at: Date.now(), ms: 50, outcome: "fail" });
    await again.finish("completed");
    assert.equal((await store.get("exp_a1"))!.progress.done, 2);
    assert.equal((await store.find("exp_a1"))?.header.id, "exp_a1");
  });

  it("finds a job by a record it produced, lists newest first, guards a failed start", async () => {
    const store = new JobStore(join(root, "two"));
    const a = await store.create({ id: "pair_x", kind: "exp ab", name: "p", config: jobConfig({}), total: 0, concurrency: 1, now: 1000 });
    await a.addRefs("exp_left", "exp_right");
    await a.finish("completed");
    const b = await store.create({ id: "sweep_y", kind: "exp sweep", name: "s", config: jobConfig({}), total: 0, concurrency: 1, now: 2000 });
    await assert.rejects(b.guard(async () => Promise.reject(new Error("bad flag"))), /bad flag/);
    assert.equal(await store.get("sweep_y"), undefined, "nothing ran: the job is gone");
    assert.equal((await store.find("exp_right"))?.header.id, "pair_x");
    assert.deepEqual((await store.list()).map((v) => v.header.id), ["pair_x"]);
    assert.equal(await store.get("../etc"), undefined);
  });

  it("parseLines keeps the last line per key", () => {
    const m = parseLines('{"key":"a","at":1,"ms":1,"outcome":"fail"}\n\n{"key":"a","at":2,"ms":1,"outcome":"pass"}\nnot json\n');
    assert.equal(m.get("a")?.outcome, "pass");
    assert.equal(m.size, 1);
  });
});

describe("liveStatus and progress", () => {
  const header = (o: Partial<JobHeader> = {}): JobHeader => ({
    v: 1,
    id: "j",
    kind: "exp run",
    name: "j",
    config: jobConfig({}),
    total: 10,
    concurrency: 2,
    createdAt: 0,
    updatedAt: 0,
    status: "running",
    sessions: [{ pid: process.pid, host: hostname(), startedAt: 0 }],
    refs: [],
    state: {},
    ...o,
  });
  it("a running job whose owner died or went quiet is interrupted", () => {
    assert.equal(liveStatus(header(), 1000, 2000), "running");
    assert.equal(liveStatus(header({ sessions: [{ pid: 2 ** 30, host: hostname(), startedAt: 0 }] }), 1000, 2000), "interrupted", "dead pid on this host");
    assert.equal(liveStatus(header({ sessions: [{ pid: 1, host: "elsewhere", startedAt: 0 }] }), 0, STALE_MS + 1), "interrupted", "no heartbeat for 5 min");
    assert.equal(liveStatus(header({ status: "completed" }), 0, 10 ** 12), "completed");
  });
  it("ETA from this session's pace; cost from trials that report it", () => {
    const h = header({ sessions: [{ pid: 1, host: "x", startedAt: 0, endedAt: 1000 }, { pid: process.pid, host: hostname(), startedAt: 5000 }] });
    const lines = parseLines(
      [
        { key: "1", at: 500, ms: 400, outcome: "pass", costUsd: 0.25 },
        { key: "2", at: 900, ms: 400, outcome: "fail" },
        { key: "3", at: 6000, ms: 1000, outcome: "pass", costUsd: 0.25 },
        { key: "4", at: 7000, ms: 1000, outcome: "pass" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const p = progressOf(h, lines, "running", 9000);
    assert.equal(p.done, 4);
    assert.equal(p.costUsd, 0.5);
    assert.equal(p.costKnown, 2);
    // 2 done in the 4000 ms since the resume; 6 left → 12000 ms.
    assert.equal(p.etaMs, 12000);
    assert.equal(p.activeMs, 1000 + 4000, "idle time between sessions left out");
    assert.equal(progressOf(h, lines, "interrupted", 9000).etaMs, undefined);
  });
});

describe("config hash", () => {
  it("names the parts that changed; concurrency is not part of it", () => {
    const a = jobConfig({ dataset: "d@1", task: { kind: "command", command: "x" }, trials: 2, seed: undefined });
    const b = jobConfig({ dataset: "d@2", task: { kind: "command", command: "x" }, trials: 2 });
    assert.equal(a.hash, jobConfig({ trials: 2, task: { command: "x", kind: "command" }, dataset: "d@1" }).hash, "key order does not matter");
    assert.deepEqual(configChanges(a, b), ["dataset"]);
    assert.deepEqual(configChanges(a, jobConfig({ dataset: "d@1", task: { kind: "command", command: "x" }, trials: 2, timeoutMs: 5 })), ["timeoutMs"]);
  });
  it("a command task's fingerprint changes with the agent script it runs", () => {
    const dir = mkdtempSync(join(root, "fp-"));
    writeFileSync(join(dir, "agent.mjs"), "console.log(1)");
    const spec = { kind: "command", command: "node agent.mjs" };
    const one = jobConfig({ task: taskFingerprint(spec, dir) });
    writeFileSync(join(dir, "agent.mjs"), "console.log(2)");
    assert.notEqual(jobConfig({ task: taskFingerprint(spec, dir) }).hash, one.hash);
    assert.deepEqual(taskFingerprint({ kind: "http", url: "u" }, dir), { kind: "http", url: "u" });
  });
});

describe("retries: infrastructure errors only", () => {
  it("classifies rate limits, 5xx, network errors and exit 75; never the task's own failures", () => {
    assert.equal(infraKind("node agent.mjs: exited 1: HTTP 429 Too Many Requests"), "rate-limit");
    assert.equal(infraKind("Error: rate limit exceeded"), "rate-limit");
    assert.equal(infraKind('{"type":"overloaded_error"}'), "rate-limit");
    assert.equal(infraKind("API error: 503 Service Unavailable"), "server");
    assert.equal(infraKind("HTTP 502 Bad Gateway"), "server");
    assert.equal(infraKind("connect ECONNREFUSED 127.0.0.1:443"), "network");
    assert.equal(infraKind("TypeError: fetch failed"), "network");
    assert.equal(infraKind("./agent: exited 75"), "tempfail");
    assert.equal(infraKind("./agent: exited 3: boom"), undefined, "a crash is the agent's failure");
    assert.equal(infraKind("timed out after 600000 ms"), undefined, "the task's own timeout is a failure");
    assert.equal(infraKind("wrong answer: expected 503 got 502"), undefined);
    assert.equal(infraKind(undefined), undefined);
  });
  it("backoff doubles with jitter, honors Retry-After, caps at maxMs", () => {
    const p = { retries: 5, baseMs: 1000, maxMs: 5000 };
    assert.equal(backoffMs(1, p, () => 1), 1000);
    assert.equal(backoffMs(3, p, () => 1), 4000);
    assert.equal(backoffMs(9, p, () => 1), 5000);
    assert.equal(backoffMs(1, p, () => 0), 500);
    assert.equal(retryAfterMs("429; retry-after: 7"), 7000);
    assert.equal(retryAfterMs("Retry-After 250ms"), 250);
    assert.equal(retryPolicy({ CODING_SH_RETRY_BASE_MS: "0" }, 2).baseMs, 0);
    assert.equal(retryPolicy({}).retries, 3);
  });
  it("retries infra errors, never task failures, and stops on a signal", async () => {
    const policy = { retries: 3, baseMs: 0, maxMs: 0 };
    let n = 0;
    const flaky = await withRetries(async () => (++n < 3 ? "HTTP 503" : "ok"), { policy, errorOf: (r) => (r === "ok" ? undefined : r) });
    assert.deepEqual([flaky.result, flaky.attempts, flaky.infra, flaky.retried], ["ok", 3, undefined, ["HTTP 503", "HTTP 503"]]);
    n = 0;
    const failing = await withRetries(async () => (++n, "exited 1: assertion failed"), { policy, errorOf: (r) => r });
    assert.equal(failing.attempts, 1, "a task failure is never retried");
    assert.equal(n, 1);
    const down = await withRetries(async () => "ECONNRESET", { policy, errorOf: (r) => r });
    assert.deepEqual([down.attempts, down.infra], [4, "network"]);
    const stop = new AbortController();
    stop.abort();
    const stopped = await withRetries(async () => "HTTP 429", { policy: { ...policy, baseMs: 60_000, maxMs: 60_000 }, errorOf: (r) => r, stop: [stop.signal] });
    assert.deepEqual([stopped.attempts, stopped.infra], [1, "rate-limit"], "an interrupt starts no new attempt");
  });
  it("reads a refused login as infra, not a task failure", () => {
    assert.equal(infraKind("claude: exited 1: Invalid API key · Please run /login"), "auth");
    assert.equal(infraKind("codex: exited 1: Not logged in"), "auth");
    assert.equal(infraKind("Error: 401 Unauthorized"), "auth");
    assert.equal(infraKind('API Error: 401 {"type":"authentication_error"}'), "auth");
    assert.equal(infraKind("OAuth token has expired. Please run /login"), "auth");
    assert.equal(infraKind("Incorrect API key provided: sk-…"), "auth");
    assert.equal(infraKind("expected 401 from the endpoint, got 200"), undefined, "a number in a task's own output is not a login");
    assert.equal(infraKind("./agent: exited 1: assertion failed"), undefined);
  });
  it("never retries a refused login and retries a failed setup once, whatever --retries says", async () => {
    const policy = { retries: 3, baseMs: 0, maxMs: 0 };
    let n = 0;
    const login = await withRetries(async () => (++n, "Not logged in · Please run /login"), { policy, errorOf: (r) => r });
    assert.deepEqual([login.attempts, login.infra, n], [1, "auth", 1], "a login does not come back after a backoff");
    n = 0;
    const setup = await withRetries(async () => (++n, "setup `exit 1` exited 1"), { policy, errorOf: (r) => r, classify: () => "setup" });
    assert.deepEqual([setup.attempts, setup.infra, n], [2, "setup", 2], "one retry, then the trial is infra-unknown");
    n = 0;
    const noRetry = await withRetries(async () => (++n, "setup failed"), { policy: { ...policy, retries: 0 }, errorOf: (r) => r, classify: () => "setup" });
    assert.equal(noRetry.attempts, 1, "--retries 0 turns the setup retry off too");
    n = 0;
    const fixed = await withRetries(async () => (++n < 2 ? "setup failed" : "ok"), { policy, errorOf: (r) => r, classify: (r) => (r === "ok" ? undefined : "setup") });
    assert.deepEqual([fixed.result, fixed.attempts, fixed.infra], ["ok", 2, undefined], "a setup that works the second time is a normal trial");
  });
  it("stops after N trials in a row end on infra; a known outcome resets the count", () => {
    assert.equal(retryPolicy({}).stopAfter, DEFAULT_STOP_AFTER);
    assert.equal(retryPolicy({}, 3, 0).stopAfter, 0);
    assert.equal(infraStopFor(retryPolicy({}, 3, 0)), undefined, "0 never stops");
    const stop = infraStopFor(retryPolicy({}, 3, 3))!;
    stop.add("auth");
    stop.add("auth");
    stop.add(undefined);
    stop.add("auth");
    stop.add("setup");
    assert.equal(stop.signal.aborted, false, "the pass in between reset the streak");
    stop.add("auth");
    assert.equal(stop.signal.aborted, true);
    assert.deepEqual(stop.report, { after: 3, kinds: { auth: 2, setup: 1 } });
    assert.match(infraStopText(stop.report!), /^Stopped: 3 trials in a row failed on infrastructure \(login 2, setup 1\), so the rest did not run and this is no quality verdict\. The agent is not logged in/);
    assert.match(voidText(4, { auth: 4 }), /^void: 4 trials failed on infrastructure \(login 4\), leaving no outcome to compare, so this is no quality verdict/);
  });
});
