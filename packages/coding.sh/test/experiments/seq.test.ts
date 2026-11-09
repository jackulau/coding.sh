// AC-9: exp run --seq K, sequential attempts with grader feedback. Function,
// command (a node script) and HTTP (a local server) tasks; temp dirs only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison, renderExperiment } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { hideExpected, SEQ_BIT, seqPrompt, seqTaskError } from "../../src/experiments/seq.ts";
import type { TaskContext } from "../../src/experiments/task.ts";
import { exactGrader } from "../../src/graders/builtin.ts";
import { passAtK } from "../../src/stats/seqk.ts";
import { pathOf } from "../_bin.ts";

const one = createDataset({ name: "one", createdAt: 1, cases: [{ id: "q", input: "what is 6*7?", expected: 42 }] });
const ten = createDataset({ name: "ten", createdAt: 1, cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: i, expected: i })) });
/** Wrong on the first attempt, right once it has history. */
const learner = (x: unknown, ctx: TaskContext) => (ctx.history?.length ? (x === "what is 6*7?" ? 42 : x) : -1);

describe("exp run --seq (function tasks)", () => {
  it("wrong on attempt 1, right with history: pass=false, solvedAt=2, 2 attempts, curve [0,1,1]", async () => {
    const seen: TaskContext[] = [];
    const r = await runExperiment({ name: "s", dataset: one, task: (x: unknown, ctx: TaskContext) => (seen.push(ctx), learner(x, ctx)), graders: [exactGrader()], seq: { k: 3, feedback: "bit" } });
    const run = r.runs[0]!;
    assert.equal(run.pass, false);
    assert.equal(run.output, -1, "the run's output stays the first attempt's");
    assert.equal(run.seq?.solvedAt, 2);
    assert.equal(run.seq?.attempts.length, 2);
    assert.deepEqual(run.seq?.attempts.map((a) => a.pass), [false, true]);
    assert.equal(run.seq?.attempts[0]!.feedback, SEQ_BIT);
    assert.deepEqual(r.summary.seq?.curve.map((p) => p.rate), [0, 1, 1]);
    assert.equal(r.summary.passRate.p, 0, "pass rate is Seq@1");
    assert.equal(r.summary.seq?.egs, 1);
    assert.equal(r.summary.seq?.lgs, 0);
    assert.deepEqual(seen.map((c) => [c.attempt, c.k, c.history?.length]), [[1, 3, 0], [2, 3, 1]]);
    assert.deepEqual(seen[1]!.history, [{ output: -1, feedback: SEQ_BIT }]);
    assert.deepEqual(r.metadata?.seq, { k: 3, feedback: "bit", history: "full" });
    const text = renderExperiment(r, { color: false });
    assert.match(text, /^sequential feedback \(K 3, feedback bit, history full\)/m);
    assert.match(text, /^seq@k {3}1: 0\.0% .*2: 100\.0% .*3: 100\.0%/m);
    assert.match(text, /^gain {4}EGS 1\.00, LGS 0\.00/m);
  });

  it("without seq nothing changes: no ctx.attempt, no seq fields, the same JSON", async () => {
    const seen: TaskContext[] = [];
    const plain = await runExperiment({ name: "p", id: "exp_x", dataset: ten, task: (x: unknown, ctx: TaskContext) => (seen.push(ctx), x), graders: [exactGrader()], seed: 1 });
    assert.ok(seen.every((c) => !("attempt" in c) && !("history" in c) && !("k" in c)));
    assert.equal(plain.metadata, undefined);
    assert.equal("seq" in plain.summary, false);
    assert.ok(plain.runs.every((x) => !("seq" in x)));
    assert.doesNotMatch(renderExperiment(plain, { color: false }), /sequential/);
  });

  it("reasons: failed graders' reasons, clipped, expected hidden; stops at the first pass and never exceeds K", async () => {
    const long = "x".repeat(400);
    const leaky: Grader = { id: "leaky", version: "1", kind: "custom", grade: async (ctx) => ({ score: 0, pass: ctx.output === 42, reason: `wanted 42, got ${String(ctx.output)}. ${long}` }) };
    const quiet: Grader = { id: "quiet", version: "1", kind: "custom", grade: async () => ({ score: 1, pass: true, reason: "fine" }) };
    let calls = 0;
    const histories: TaskContext["history"][] = [];
    const never = (_x: unknown, ctx: TaskContext) => (calls++, histories.push(ctx.history), 7);
    const r = await runExperiment({ name: "r", dataset: one, task: never, graders: [leaky, quiet], seq: { k: 4, feedback: "reasons" } });
    assert.equal(calls, 4, "never more than K attempts");
    const run = r.runs[0]!;
    assert.equal(run.seq?.solvedAt, undefined);
    assert.equal(run.seq?.attempts.length, 4);
    const fb = histories[1]![0]!.feedback;
    assert.ok(fb.startsWith("leaky: wanted [hidden], got 7."), fb);
    assert.doesNotMatch(fb, /42/);
    assert.doesNotMatch(fb, /quiet/, "passing graders give no feedback");
    assert.equal(fb.length, "leaky: ".length + 300);
    assert.ok(fb.endsWith("…"));
    // Every attempt repeated the same output.
    assert.deepEqual(run.seq?.attempts.slice(1).map((a) => a.unchanged), [true, true, true]);
    assert.equal(r.summary.seq?.unchangedRate, 1);
    assert.equal(r.summary.seq?.egs, undefined, "no gain, no gain shares");
    // A pass on attempt 2 ends it.
    let n = 0;
    const r2 = await runExperiment({ name: "r2", dataset: one, task: () => (++n === 2 ? 42 : 0), graders: [leaky], seq: { k: 5, feedback: "reasons" } });
    assert.equal(n, 2);
    assert.equal(r2.runs[0]!.seq?.solvedAt, 2);
  });

  it("an errored attempt is a failed attempt whose message is the feedback", async () => {
    let n = 0;
    const flaky = (_x: unknown, ctx: TaskContext) => {
      if (++n === 1) throw new Error("bad answer format, wanted 42");
      return ctx.history?.[0]?.feedback;
    };
    const r = await runExperiment({ name: "e", dataset: one, task: flaky, graders: [exactGrader()], seq: { k: 2, feedback: "reasons" } });
    const run = r.runs[0]!;
    assert.equal(run.error, "bad answer format, wanted 42");
    assert.equal(run.seq?.attempts[0]!.error, "bad answer format, wanted 42");
    assert.equal(run.seq?.attempts[0]!.feedback, "The previous attempt failed with an error: bad answer format, wanted [hidden]");
  });

  it("critic: its reason is the feedback, its cost goes to criticCostUsd, and it never gates", async () => {
    let criticCalls = 0;
    const critic: Grader = {
      id: "critic",
      version: "1",
      kind: "custom",
      // Says pass to everything: a gate on it would end the trajectory at once.
      grade: async (ctx) => (criticCalls++, Object.assign({ score: 1, pass: true, reason: `multiply, don't add (you said ${String(ctx.output)}; expected ${String(ctx.expected)})` }, { costUsd: 0.002 })),
    };
    const seen: string[] = [];
    let n = 0;
    const task = (_x: unknown, ctx: TaskContext) => {
      if (ctx.history?.length) seen.push(ctx.history.at(-1)!.feedback);
      return Object.assign(++n < 3 ? { answer: 13 } : { answer: 42 }, { costUsd: 0.01 });
    };
    const answer: Grader = { id: "answer", version: "1", kind: "custom", grade: async (ctx) => ({ score: 0, pass: (ctx.output as { answer: number }).answer === 42 }) };
    const r = await runExperiment({ name: "c", dataset: one, task, graders: [answer], seq: { k: 3, feedback: { critic } } });
    const run = r.runs[0]!;
    assert.equal(criticCalls, 2);
    assert.equal(run.seq?.solvedAt, 3);
    assert.equal(run.seq?.feedback, "critic:critic");
    assert.match(seen[0]!, /^multiply, don't add \(you said \[object Object\]; expected \[hidden\]\)$/);
    assert.deepEqual(run.seq?.attempts.map((a) => a.criticCostUsd), [0.002, 0.002, undefined]);
    assert.deepEqual(run.seq?.attempts.map((a) => a.costUsd), [0.01, 0.01, 0.01]);
    // (3 attempts × 0.01 + 2 critiques × 0.002) over 1 solved trial.
    assert.ok(Math.abs(r.summary.seq!.costToSolve! - 0.034) < 1e-12);
  });

  it("history last shows only the attempt before; seqPrompt renders the A.2 template", async () => {
    const lens: number[] = [];
    await runExperiment({ name: "h", dataset: one, task: (_x: unknown, ctx: TaskContext) => (lens.push(ctx.history!.length), 0), graders: [exactGrader()], seq: { k: 4, feedback: "bit", history: "last" } });
    assert.deepEqual(lens, [0, 1, 1, 1]);
    assert.equal(seqPrompt("task", {}), "task");
    assert.equal(
      seqPrompt({ q: 1 }, { attempt: 3, k: 3, history: [{ output: "a", feedback: "f1" }, { output: { x: 1 }, feedback: "f2" }] }),
      [
        '{"q":1}',
        "",
        "This is attempt 3 of 3. Review your previous attempt(s) and the feedback below, then provide an improved answer.",
        "",
        "<PreviousAttempt 1>",
        "a",
        "</PreviousAttempt 1>",
        "<Feedback 1>",
        "f1",
        "</Feedback 1>",
        "",
        "<PreviousAttempt 2>",
        '{"x":1}',
        "</PreviousAttempt 2>",
        "<Feedback 2>",
        "f2",
        "</Feedback 2>",
      ].join("\n"),
    );
    // With history: last, the numbering still names the attempt it came from.
    assert.match(seqPrompt("t", { attempt: 4, k: 4, history: [{ output: "c", feedback: "f3" }] }), /<PreviousAttempt 3>/);
    assert.equal(hideExpected("got 42 not 420", 42), "got [hidden] not [hidden]0");
    assert.equal(hideExpected('use {"a":"pear"}', { a: "pear" }), "use [hidden]");
  });

  it("trials 4, K 3: pass@k matches the unbiased estimator and the front has both protocols; one trial omits them", async () => {
    // Case i passes its first attempt on trials ≤ i % 4 + ...: a fixed pattern per case and trial; the retry always passes.
    const cases = createDataset({ name: "four", createdAt: 1, cases: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, input: i, expected: i })) });
    const task = (x: unknown, ctx: TaskContext) => (ctx.history?.length || (Number(x) + ctx.trial) % 3 === 0 ? x : -1);
    const r = await runExperiment({ name: "f", dataset: cases, task, graders: [exactGrader()], trials: 4, seq: { k: 3, feedback: "bit" } });
    const q = r.summary.seq!;
    assert.equal(q.passAtK?.length, 3);
    for (const p of q.passAtK!) {
      const want = cases.cases.reduce((s, c) => s + passAtK(4, r.runs.filter((x) => x.caseId === c.id && x.pass).length, p.k), 0) / cases.cases.length;
      assert.ok(Math.abs(p.rate - want) < 1e-12, `pass@${p.k}`);
    }
    assert.deepEqual([...new Set(q.front!.map((p) => p.protocol))].sort(), ["pass@k", "seq@k"]);
    assert.equal(q.costUnit, "attempts");
    assert.match(renderExperiment(r, { color: false }), /^front {3}pass@1 /m);
    const single = await runExperiment({ name: "g", dataset: cases, task, graders: [exactGrader()], seq: { k: 3, feedback: "bit" } });
    assert.equal(single.summary.seq?.passAtK, undefined);
    assert.equal(single.summary.seq?.front, undefined);
  });

  it("cancel drops the trial mid-trajectory; resume reuses finished trajectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "csh-seq-"));
    try {
      const store = new FileEvalStore({ env: { CODING_SH_HOME: dir } });
      const ctrl = new AbortController();
      let calls = 0;
      let hang = true;
      // Case c5's second attempt hangs until cancelled.
      const task = async (x: unknown, ctx: TaskContext) => {
        calls++;
        if (hang && x === 5 && ctx.attempt === 2) await new Promise((_r, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("killed")), { once: true }));
        return ctx.attempt === 1 && Number(x) % 2 === 1 ? -1 : x;
      };
      const running = runExperiment({ name: "k", dataset: ten, task, graders: [exactGrader()], concurrency: 1, store, signal: ctrl.signal, seq: { k: 3, feedback: "bit" } });
      // c0..c4 take 7 calls; the 9th is c5's hanging second attempt.
      while (calls < 9) await new Promise((r) => setTimeout(r, 5));
      ctrl.abort();
      const cut = await running;
      hang = false;
      assert.equal(cut.status, "cancelled");
      assert.deepEqual(cut.runs.map((r) => r.caseId), ["c0", "c1", "c2", "c3", "c4"]);
      assert.ok(cut.runs.every((r) => r.seq && r.seq.attempts.length === (Number(r.caseId.slice(1)) % 2 ? 2 : 1)));
      let again = 0;
      const resumed = await runExperiment({ name: "k", dataset: ten, task: Object.defineProperty(async (x: unknown, ctx: TaskContext) => (again++, await task(x, ctx)), "name", { value: "task" }), graders: [exactGrader()], store, resumeFrom: cut, seq: { k: 3, feedback: "bit" } });
      // c5..c9: odd cases take 2 attempts, even ones 1.
      assert.equal(again, 2 + 1 + 2 + 1 + 2);
      assert.equal(resumed.runs.length, 10);
      assert.deepEqual(resumed.summary.seq?.curve.map((p) => p.rate), [0.5, 1, 1]);
      // A different --seq setting refuses to resume.
      await assert.rejects(runExperiment({ name: "k", dataset: ten, task, graders: [exactGrader()], resumeFrom: cut, seq: { k: 4, feedback: "bit" } }), /--seq settings changed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bad options throw before any run", async () => {
    let calls = 0;
    const t = () => calls++;
    await assert.rejects(runExperiment({ name: "x", dataset: one, task: t, graders: [exactGrader()], seq: { k: 1, feedback: "bit" } }), RangeError);
    await assert.rejects(runExperiment({ name: "x", dataset: one, task: t, graders: [exactGrader()], seq: { k: 11, feedback: "bit" } }), RangeError);
    await assert.rejects(runExperiment({ name: "x", dataset: one, task: { kind: "command", command: process.execPath, args: ["-e", "1"] }, graders: [exactGrader()], seq: { k: 2, feedback: "bit" } }), /envelope": true/);
    assert.equal(calls, 0);
    assert.match(seqTaskError({ kind: "http", url: "http://x" })!, /"envelope": true/);
    assert.equal(seqTaskError({ kind: "http", url: "http://x", envelope: true }), undefined);
  });
});

describe("exp run --seq (command and http tasks with an envelope)", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "csh-seq-io-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("a command gets attempt, k and history on stdin, and CODING_SH_ATTEMPT / CODING_SH_SEQ_K", async () => {
    const script = join(dir, "agent.cjs");
    const log = join(dir, "log.jsonl");
    await writeFile(
      script,
      `const fs=require("node:fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);` +
        `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({e,attempt:process.env.CODING_SH_ATTEMPT,k:process.env.CODING_SH_SEQ_K})+"\\n");` +
        `process.stdout.write(JSON.stringify(e.history.length?42:0))});\n`,
    );
    const r = await runExperiment({ name: "cmd", dataset: one, task: { kind: "command", command: process.execPath, args: [script], envelope: true }, graders: [exactGrader()], seq: { k: 3, feedback: "bit" } });
    assert.equal(r.runs[0]!.seq?.solvedAt, 2);
    const rows = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => [x.attempt, x.k, x.e.attempt, x.e.k, x.e.history.length]), [["1", "3", 1, 3, 0], ["2", "3", 2, 3, 1]]);
    assert.deepEqual(rows[1].e.history, [{ output: 0, feedback: SEQ_BIT }]);
    assert.equal(rows[0].e.input, "what is 6*7?");
  });

  it("an http task gets them in the envelope body", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let s = "";
      req.on("data", (d) => (s += d)).on("end", () => {
        const b = JSON.parse(s) as { history: unknown[] };
        bodies.push(b as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b.history.length ? 42 : 1));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const r = await runExperiment({ name: "http", dataset: one, task: { kind: "http", url, envelope: true }, graders: [exactGrader()], seq: { k: 2, feedback: "bit" } });
      assert.equal(r.runs[0]!.seq?.solvedAt, 2);
      assert.deepEqual(bodies.map((b) => [b.attempt, b.k, (b.history as unknown[]).length]), [[1, 2, 0], [2, 2, 1]]);
    } finally {
      server.close();
    }
  });
});

describe("exp compare with --seq runs", () => {
  // 30 cases; both fail every first attempt. A never recovers; B fixes everything on attempt 2.
  const ds = createDataset({ name: "thirty", createdAt: 1, cases: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, input: i, expected: i })) });
  const stuck = (_x: unknown) => -1;
  const fixer = (x: unknown, ctx: TaskContext) => (ctx.history?.length ? x : -1);

  it("equal K and feedback: a Seq@K row; --verdict seq reads it where the first attempts tie", async () => {
    const a = await runExperiment({ name: "a", dataset: ds, task: stuck, graders: [exactGrader()], seq: { k: 3, feedback: "bit" } });
    const b = await runExperiment({ name: "b", dataset: ds, task: fixer, graders: [exactGrader()], seq: { k: 3, feedback: "bit" } });
    const plain = compareExperiments(a, b, { iters: 500 });
    assert.equal(plain.verdict, "inconclusive", "first attempts tie at 0%");
    assert.deepEqual([plain.seqK?.k, plain.seqK?.a, plain.seqK?.b, plain.seqK?.n], [3, 0, 1, 30]);
    assert.equal(plain.seqK?.diff.mean, 1);
    assert.equal("verdictOn" in plain, false);
    const onSeq = compareExperiments(a, b, { iters: 500, verdictOn: "seq" });
    assert.equal(onSeq.verdict, "better");
    assert.equal(onSeq.verdictOn, "seq");
    const text = renderComparison(onSeq, { color: false });
    assert.match(text, /^seq@3 {3}A 0\.0% {2}B 100\.0% {2}B − A \+100\.0pp \[\+100\.0pp, \+100\.0pp\] \(solved within 3 attempts, bit feedback, 30 paired cases/m);
    assert.match(text, /^verdict B is better \(on Seq@3\)$/m);
  });

  it("unequal K refuses with a note; runs without --seq have neither", async () => {
    const a = await runExperiment({ name: "a", dataset: ds, task: stuck, graders: [exactGrader()], seq: { k: 3, feedback: "bit" } });
    const b = await runExperiment({ name: "b", dataset: ds, task: fixer, graders: [exactGrader()], seq: { k: 4, feedback: "bit" } });
    const c = compareExperiments(a, b, { iters: 200, verdictOn: "seq" });
    assert.equal(c.seqK, undefined);
    assert.equal(c.seqNote, "Seq@K not compared: A ran K 3 with bit feedback, B ran K 4 with bit feedback; run both with the same --seq and --feedback");
    assert.equal(c.verdictOn, "pass");
    assert.match(renderComparison(c, { color: false }), /^! --verdict seq: no Seq@K row/m);
    const p1 = await runExperiment({ name: "p1", dataset: ds, task: stuck, graders: [exactGrader()] });
    const p2 = await runExperiment({ name: "p2", dataset: ds, task: stuck, graders: [exactGrader()] });
    const none = compareExperiments(p1, p2, { iters: 200 });
    assert.equal("seqK" in none || "seqNote" in none, false);
  });
});

describe("exp run --seq from the CLI", () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  const CLI = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: root, encoding: "utf8", timeout: 120_000 });
  before(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "csh-seq-cli-")));
    env = { HOME: root, CODING_SH_HOME: join(root, ".coding.sh"), XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, ".data"), PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"), TMPDIR: tmpdir(), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
    const cases = Array.from({ length: 4 }, (_, i) => ["--case", JSON.stringify({ id: `c${i}`, input: i, expected: i })]).flat();
    assert.equal(cli(["dataset", "add", "four", ...cases]).status, 0);
    await writeFile(join(root, "agent.cjs"), `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify(e.history&&e.history.length?e.input:-1))});\n`);
  });
  after(() => rm(root, { recursive: true, force: true }));
  const task = (envelope: boolean) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(root, "agent.cjs")], ...(envelope ? { envelope: true } : {}) });

  it("flags are checked before any run; an envelope task runs and prints the block", () => {
    // [flags, envelope]: a task without an envelope, then bad flags on one with it.
    const bads: [string[], boolean][] = [[["--seq", "3"], false], [["--feedback", "bit"], true], [["--seq", "1"], true], [["--seq", "3", "--feedback", "loud"], true], [["--seq", "3", "--seq-history", "some"], true]];
    for (const [bad, envelope] of bads) {
      const r = cli(["exp", "run", "-d", "four", "--task", task(envelope), "-g", '{"kind":"exact"}', ...bad]);
      assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
    }
    const noEnv = cli(["exp", "run", "-d", "four", "--task", task(false), "-g", '{"kind":"exact"}', "--seq", "3"]);
    assert.match(noEnv.stderr, /"envelope": true/);
    assert.equal(JSON.parse(cli(["exp", "list", "--json"]).stdout).experiments.length, 0);
    const ok = cli(["exp", "run", "-d", "four", "--task", task(true), "-g", '{"kind":"exact"}', "--seq", "3", "--feedback", "bit"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^sequential feedback \(K 3, feedback bit, history full\)/m);
    assert.match(ok.stdout, /^seq@k {3}1: 0\.0% .*2: 100\.0%/m);
    const stored = JSON.parse(cli(["exp", "show", "--json", JSON.parse(cli(["exp", "list", "--json"]).stdout).experiments[0].id]).stdout);
    const e = stored.experiment ?? stored;
    assert.deepEqual(e.summary.seq.curve.map((p: { rate: number }) => p.rate), [0, 1, 1]);
  });
});
