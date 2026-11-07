import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { exactGrader, jsonPathGrader } from "../../src/graders/builtin.ts";
import { compareExperiments, IncompleteExperimentError } from "../../src/experiments/compare.ts";
import { renderExperiment } from "../../src/experiments/render.ts";
import { runExperiment, withTrace } from "../../src/experiments/run.ts";
import { resolveTask, safeUrl, splitCommandLine } from "../../src/experiments/task.ts";
import { createJudge, judgeGrader } from "../../src/judge/judge.ts";
import type { ChatProvider } from "../../src/judge/providers.ts";
import { wilson } from "../../src/stats/interval.ts";
import { nodeBin } from "../_bin.ts";

const AGENT = fileURLToPath(new URL("./fixtures/agent.mjs", import.meta.url));
const ANSI = /\u001b\[/;

const ds = createDataset({
  name: "upper",
  createdAt: 1,
  cases: [
    { id: "a", input: { q: "a" }, expected: "A" },
    { id: "b", input: { q: "b" }, expected: "B" },
    { id: "c", input: { q: "c" }, expected: "C" },
    { id: "d", input: { q: "d" }, expected: "nope" },
  ],
});

const upper = (input: unknown) => String((input as { q: string }).q).toUpperCase();

describe("runExperiment: function task", () => {
  it("grades each case and reports a Wilson interval", async () => {
    const seen: string[] = [];
    const r = await runExperiment({
      name: "fn",
      dataset: ds,
      task: upper,
      graders: [exactGrader()],
      onProgress: (run, done, total) => seen.push(`${run.caseId}:${done}/${total}`),
    });
    assert.match(r.id, /^exp_/);
    assert.equal(r.summary.n, 4);
    assert.equal(r.summary.passed, 3);
    assert.equal(r.summary.ciMethod, "wilson");
    assert.deepEqual(r.summary.passRate, wilson(3, 4));
    assert.equal(r.task.kind, "function");
    assert.equal(r.task.ref, "upper");
    assert.deepEqual(r.dataset, { id: ds.id, name: "upper", version: ds.version });
    assert.equal(seen.length, 4);
    assert.ok(seen.includes("d:4/4") || seen.some((s) => s.endsWith("4/4")));
    const d = r.runs.find((x) => x.caseId === "d");
    assert.equal(d?.pass, false);
    assert.equal(d?.output, "D");
    assert.match(d?.grades[0]?.result?.reason ?? "", /expected "nope", got "D"/);
    assert.equal(r.summary.graders[0]?.passed, 3);
    assert.equal(r.summary.graders[0]?.meanScore, 0.75);
  });

  it("task and grader errors are recorded, not thrown", async () => {
    const throwing: Grader = {
      id: "flaky",
      version: "1",
      kind: "custom",
      grade: async (ctx) => {
        if (ctx.caseId === "b") throw new Error("grader exploded");
        return { score: 1, pass: true };
      },
    };
    const r = await runExperiment({
      name: "errs",
      dataset: ds,
      task: (input) => {
        if ((input as { q: string }).q === "a") throw new Error("task blew up");
        return upper(input);
      },
      graders: [throwing],
      concurrency: 1,
    });
    const a = r.runs.find((x) => x.caseId === "a");
    assert.equal(a?.error, "task blew up");
    assert.deepEqual(a?.grades, []);
    const b = r.runs.find((x) => x.caseId === "b");
    assert.equal(b?.pass, false);
    assert.equal(b?.grades[0]?.error, "grader exploded");
    assert.equal(r.summary.errors, 1);
    assert.equal(r.summary.passed, 2);
    assert.equal(r.summary.graders[0]?.errors, 1);
    assert.equal(r.summary.graders[0]?.n, 2);
    const text = renderExperiment(r, { color: false });
    assert.match(text, /errors {2}1 task error/);
    assert.match(text, /a\s+error: task blew up/);
    assert.match(text, /b\s+flaky: grader error: grader exploded/);
  });

  it("rejects duplicate grader ids and bad trial counts", async () => {
    await assert.rejects(runExperiment({ name: "x", dataset: ds, task: upper, graders: [exactGrader(), exactGrader()] }), /share the id/);
    await assert.rejects(runExperiment({ name: "x", dataset: ds, task: upper, graders: [], trials: 0 }), RangeError);
  });

  it("trials > 1 uses a cluster bootstrap over cases", async () => {
    let calls = 0;
    const r = await runExperiment({
      name: "trials",
      dataset: ds,
      // Case c alternates pass/fail across trials.
      task: (input, ctx) => {
        calls++;
        const q = (input as { q: string }).q;
        return q === "c" && ctx.trial % 2 === 0 ? "wrong" : q.toUpperCase();
      },
      graders: [exactGrader()],
      trials: 2,
      seed: 3,
      bootstrapIters: 500,
    });
    assert.equal(calls, 8);
    assert.equal(r.summary.n, 8);
    assert.equal(r.summary.cases, 4);
    assert.equal(r.summary.passed, 5);
    assert.equal(r.summary.ciMethod, "cluster-bootstrap");
    assert.equal(r.summary.passRate.p, 5 / 8);
    assert.ok(r.summary.passRate.lo <= 5 / 8 && 5 / 8 <= r.summary.passRate.hi);
    assert.match(renderExperiment(r, { color: false }), /5\/8 over 4 cases, 95% cluster bootstrap/);
  });

  it("split and filter narrow the cases", async () => {
    const split = createDataset({
      name: "s",
      cases: [
        { id: "x", input: { q: "x" }, expected: "X", split: "test" },
        { id: "y", input: { q: "y" }, expected: "Y", split: "train" },
      ],
    });
    const r = await runExperiment({ name: "s", dataset: split, task: upper, graders: [exactGrader()], split: "test" });
    assert.deepEqual(r.runs.map((x) => x.caseId), ["x"]);
    assert.equal(r.dataset.split, "test");
    const f = await runExperiment({ name: "f", dataset: ds, task: upper, graders: [], filter: (c) => c.id !== "a" });
    assert.equal(f.runs.length, 3);
  });

  it("withTrace hands the trace to graders and keeps output clean", async () => {
    let gotTrace: unknown;
    const g: Grader = {
      id: "trace",
      version: "1",
      kind: "custom",
      grade: async (ctx) => {
        gotTrace = ctx.trace;
        return { score: 1, pass: ctx.output === "A" };
      },
    };
    const one = createDataset({ name: "one", cases: [{ id: "a", input: { q: "a" } }] });
    const r = await runExperiment({
      name: "t",
      dataset: one,
      task: () => withTrace("A", [{ id: "e1", kind: "tool.call", payload: { name: "bash" } }]),
      graders: [g],
    });
    assert.deepEqual(gotTrace, [{ id: "e1", kind: "tool.call", payload: { name: "bash" } }]);
    assert.equal(r.runs[0]?.output, "A");
    assert.equal(r.runs[0]?.pass, true);
  });

  it("an experiment aborted before it starts runs nothing and is cancelled", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    const r = await runExperiment({ name: "ab", dataset: ds, task: () => calls++, graders: [], signal: ctrl.signal });
    assert.equal(calls, 0);
    assert.equal(r.status, "cancelled");
    assert.deepEqual(r.runs, [], "never-started cases are not runs");
    const text = renderExperiment(r, { color: false });
    assert.match(text, /cancelled before any case run finished: nothing was graded/);
    assert.doesNotMatch(text, /pass|latency/, "no empty pass rate or grader table");
  });

  // EXP-6: a grader error makes the outcome unknown, not a failure.
  it("grader errors leave runs ungraded, out of the pass rate and of compare", async () => {
    const flaky = (fail: (id: string) => boolean): Grader => ({
      id: "judge",
      version: "1",
      kind: "custom",
      grade: async (ctx) => {
        if (fail(ctx.caseId ?? "")) throw new Error("HTTP 529 overloaded");
        return { score: 1, pass: true };
      },
    });
    const cases = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, input: { q: `c${i}` }, expected: `C${i}` }));
    const big = createDataset({ name: "big", createdAt: 1, cases });
    const a = await runExperiment({ name: "A", dataset: big, task: upper, graders: [flaky(() => false)] });
    const b = await runExperiment({ name: "B", dataset: big, task: upper, graders: [flaky((id) => Number(id.slice(1)) % 2 === 0)] });
    assert.equal(b.summary.ungraded, 6);
    assert.equal(b.summary.errors, 0);
    assert.equal(b.summary.passRate.p, 1, "pass rate over graded runs only");
    assert.ok(b.runs.filter((r) => r.ungraded).every((r) => !r.pass && r.grades[0]?.error));
    const cmp = compareExperiments(a, b, { iters: 500 });
    assert.notEqual(cmp.verdict, "worse");
    assert.equal(cmp.regressions.length, 0);
    assert.deepEqual(cmp.ungraded, { a: 0, b: 6 });
    assert.equal(cmp.paired, 6);
    assert.match(cmp.gradeWarning ?? "", /6 run\(s\) had a grader error/);
    assert.match(renderExperiment(b, { color: false }), /ungraded 6 run\(s\) with a grader error/);
  });
});

// EXP-1 / EXP-3: an interrupted experiment is stored as cancelled with only its finished runs,
// its progress is on disk while it runs, and compare refuses it unless forced.
describe("runExperiment: cancellation", () => {
  it("an abort mid-run stores status cancelled with only finished runs; compare and name lookup refuse it", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-sh-exp-cancel-"));
    try {
      const store = new FileEvalStore({ root });
      const done = await runExperiment({ name: "same", dataset: ds, task: upper, graders: [exactGrader()], store });
      const ctrl = new AbortController();
      let started = 0;
      let logged: Awaited<ReturnType<FileEvalStore["readExperimentLog"]>> = [];
      const task = async (input: unknown, ctx: { signal?: AbortSignal }) => {
        started++;
        if (started <= 2) return upper(input);
        // Third case hangs until aborted, like an agent mid-run; capture the progress log first.
        logged = await store.readExperimentLog(id);
        setTimeout(() => ctrl.abort(), 10);
        await new Promise((_, reject) => ctx.signal?.addEventListener("abort", () => reject(new Error("killed")), { once: true }));
        return "never";
      };
      const id = "exp_cancel_test";
      const r = await runExperiment({ name: "same", dataset: ds, task, graders: [exactGrader()], store, id, concurrency: 1, signal: ctrl.signal });
      assert.equal(r.status, "cancelled");
      assert.deepEqual(r.runs.map((x) => x.caseId), ["a", "b"], "only the finished case-trials");
      assert.ok(r.runs.every((x) => x.error === undefined && x.pass));
      assert.equal(r.summary.n, 2);
      // While running, finished case-trials were already on disk, with a running status.
      assert.deepEqual(logged.map((e) => e.type), ["start", "run", "run"]);
      assert.equal((logged[0] as { status: string }).status, "running");
      assert.deepEqual(await store.readExperimentLog(id), [], "log removed once the result is stored");
      const back = await store.getExperiment(id);
      assert.equal(back?.status, "cancelled");
      // By name, the cancelled run never shadows the last complete one.
      assert.equal((await store.resolveExperiment("same"))?.id, done.id);
      assert.equal((await store.resolveExperiment("same", { includeCancelled: true }))?.id, id);
      assert.throws(() => compareExperiments(done, back!), IncompleteExperimentError);
      assert.equal(compareExperiments(done, back!, { force: true }).paired, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runExperiment: command task", () => {
  it("pipes input on stdin, sets env ids, parses JSON stdout", async () => {
    const r = await runExperiment({
      name: "cmd",
      id: "exp_cmd",
      dataset: ds,
      task: { kind: "command", command: process.execPath, args: [AGENT], timeoutMs: 20_000 },
      graders: [jsonPathGrader({ path: "$.answer" })],
      concurrency: 2,
    });
    assert.equal(r.task.kind, "command");
    assert.match(r.task.ref, /agent\.mjs/);
    const a = r.runs.find((x) => x.caseId === "a");
    assert.deepEqual(a?.output, { answer: "A", caseId: "a", runId: "exp_cmd", trial: "1" });
    assert.equal(r.summary.passed, 3);
  });

  it("non-zero exit is a task error with stderr; text output is a string", async () => {
    const mixed = createDataset({
      name: "mixed",
      cases: [
        { id: "boom", input: { crash: true } },
        { id: "txt", input: { text: true, q: "hi" }, expected: "plain hi" },
      ],
    });
    const r = await runExperiment({
      name: "cmd2",
      dataset: mixed,
      task: { kind: "command", command: process.execPath, args: [AGENT], timeoutMs: 20_000 },
      graders: [exactGrader()],
    });
    const boom = r.runs.find((x) => x.caseId === "boom");
    assert.match(boom?.error ?? "", /exit(ed)? (code )?3/);
    assert.match(boom?.error ?? "", /agent crashed/);
    const txt = r.runs.find((x) => x.caseId === "txt");
    assert.equal(txt?.output, "plain hi");
    assert.equal(txt?.pass, true);
  });

  it("a one-string command line (the --help form) is split into command + args", async () => {
    // QA: {"kind":"command","command":"python3 good.py"} spawned a binary named "python3 good.py" → ENOENT on every case.
    const r = await runExperiment({
      name: "cmdline",
      dataset: ds,
      task: { kind: "command", command: `${JSON.stringify(process.execPath)} '${AGENT}'`, timeoutMs: 20_000 },
      graders: [jsonPathGrader({ path: "$.answer" })],
    });
    assert.equal(r.summary.errors, 0, r.runs[0]?.error);
    assert.equal(r.summary.passed, 3);
    // The ref is the split argv (two words), not the whole line as one quoted program name.
    assert.deepEqual(splitCommandLine(r.task.ref), [process.execPath, AGENT]);
  });

  it("a command that is an existing path with spaces is not split", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-sh-cmd-"));
    try {
      await mkdir(join(root, "my agent"));
      // Windows runs the npm-style `run me.cmd` shim nodeBin writes next to the script.
      const script = nodeBin(join(root, "my agent"), "run me", `process.stdout.write(JSON.stringify("spaced"));\n`) + (process.platform === "win32" ? ".cmd" : "");
      const one = createDataset({ name: "one", cases: [{ id: "a", input: 1, expected: "spaced" }] });
      const r = await runExperiment({ name: "spaced", dataset: one, task: { kind: "command", command: script, timeoutMs: 20_000 }, graders: [exactGrader()] });
      assert.equal(r.runs[0]?.error, undefined);
      assert.equal(r.runs[0]?.pass, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("splitCommandLine follows shell word rules; an unterminated quote points to args", () => {
    assert.deepEqual(splitCommandLine("python3 good.py"), ["python3", "good.py"]);
    assert.deepEqual(splitCommandLine("  a\t b  "), ["a", "b"]);
    assert.deepEqual(splitCommandLine(`node "my agent.mjs" 'x y' a\\ b "q\\"t" ''`), ["node", "my agent.mjs", "x y", "a b", 'q"t', ""]);
    assert.deepEqual(splitCommandLine(`'a\\b' "c\\d"`), ["a\\b", "c\\d"]);
    assert.throws(() => splitCommandLine(`python3 "good.py`), /unterminated " quote.*"args": \[\.\.\.\]/);
    assert.throws(() => resolveTask({ kind: "command", command: `python3 'x` }), /"args"/);
    // Explicit args: command is taken literally.
    assert.equal(resolveTask({ kind: "command", command: "my tool", args: ["x"] }).info.ref, '"my tool" x');
  });

  it("output: json rejects non-JSON stdout", async () => {
    const one = createDataset({ name: "one", cases: [{ id: "txt", input: { text: true, q: "hi" } }] });
    const r = await runExperiment({
      name: "cmd3",
      dataset: one,
      task: { kind: "command", command: process.execPath, args: [AGENT], output: "json", timeoutMs: 20_000 },
      graders: [],
    });
    assert.match(r.runs[0]?.error ?? "", /stdout is not JSON/);
  });
});

describe("runExperiment: http task", () => {
  it("posts an envelope with headers from env, selects responsePath", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body)) as { input: { q: string } };
      return new Response(JSON.stringify({ data: { output: body.input.q.toUpperCase() } }), { status: 200 });
    };
    const r = await runExperiment({
      name: "http",
      id: "exp_http",
      dataset: ds,
      task: {
        kind: "http",
        url: "https://user:pw@agent.example/run?token=secret",
        envelope: true,
        headerEnv: { authorization: "AGENT_TOKEN" },
        env: { AGENT_TOKEN: "Bearer t0k" },
        responsePath: "$.data.output",
        fetch,
      },
      graders: [exactGrader()],
      concurrency: 1,
    });
    assert.equal(r.summary.passed, 3);
    assert.equal(r.task.ref, "POST https://agent.example/run");
    assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("t0k"));
    const first = calls[0];
    const h = first?.init.headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer t0k");
    assert.equal(h["x-coding-sh-run-id"], "exp_http");
    assert.equal(h["x-coding-sh-case-id"], "a");
    const sent = JSON.parse(String(first?.init.body));
    assert.deepEqual(sent, { input: { q: "a" }, caseId: "a", trial: 1, runId: "exp_http" });
  });

  it("HTTP errors and missing header env become task errors", async () => {
    const one = createDataset({ name: "one", cases: [{ id: "a", input: 1 }] });
    const r = await runExperiment({
      name: "h500",
      dataset: one,
      task: { kind: "http", url: "https://x.example/?k=v", fetch: async () => new Response("down", { status: 503 }) },
      graders: [],
    });
    assert.equal(r.runs[0]?.error, "https://x.example/: HTTP 503: down");
    const r2 = await runExperiment({
      name: "noenv",
      dataset: one,
      task: { kind: "http", url: "https://x.example/", headerEnv: { authorization: "NOPE_UNSET" }, env: {}, fetch: async () => new Response("{}") },
      graders: [],
    });
    assert.match(r2.runs[0]?.error ?? "", /env NOPE_UNSET/);
  });

  it("safeUrl strips credentials and query", () => {
    assert.equal(safeUrl("https://u:p@h.example/p?q=1#f"), "https://h.example/p");
    assert.equal(safeUrl("not a url"), "(invalid url)");
  });
});

describe("runExperiment: persistence and rendering", () => {
  it("stores the result and reads it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-sh-exp-"));
    try {
      const store = new FileEvalStore({ root });
      const r = await runExperiment({ name: "persist", dataset: ds, task: upper, graders: [exactGrader()], store });
      const back = await store.getExperiment(r.id);
      assert.deepEqual(back, r);
      const list = await store.listExperiments({ name: "persist" });
      assert.deepEqual(list.map((x) => x.id), [r.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks uncalibrated judge scores with * and stays plain without color", async () => {
    const judge: Grader = {
      id: "helpful",
      version: "helpful@abc",
      kind: "llm",
      calibration: { state: "uncalibrated", reason: "never calibrated against held-out human labels" },
      grade: async () => ({ score: 0.9, pass: true }),
    };
    const r = await runExperiment({ name: "judged", dataset: ds, task: upper, graders: [exactGrader(), judge] });
    const plain = renderExperiment(r, { color: false });
    assert.ok(!ANSI.test(plain));
    assert.match(plain, /^pass {4}75\.0%\* \[/m);
    assert.match(plain, /helpful\s+llm\s+100\.0%\*/);
    assert.match(plain, /exact\s+exact\s+75\.0% .*deterministic/);
    assert.match(plain, /\* helpful: UNCALIBRATED — never calibrated against held-out human labels/);
    assert.ok(ANSI.test(renderExperiment(r, { color: true })));

    const det = renderExperiment(await runExperiment({ name: "det", dataset: ds, task: upper, graders: [exactGrader()] }), { color: false });
    assert.match(det, /^pass {4}75\.0% \[/m);
    assert.ok(!det.includes("*"));
  });
});

describe("runExperiment: judge versions", () => {
  const provider: ChatProvider = {
    name: "fake",
    model: "fake-1",
    params: {},
    complete: async () => ({ text: '{"score": 1, "pass": true, "reason": "ok"}', model: "fake-1" }),
  };
  const grader = () => judgeGrader(createJudge({ name: "correct", rubric: "is it right", provider, tunedOn: ["dev"] }));

  it("stores the judge version on first run, then grades with its stored calibration", async () => {
    // QA: exp run never stored the judge, so `judge calibrate` needed --tuned-on, saved nothing,
    // and every later run still printed "UNCALIBRATED — never calibrated".
    const root = await mkdtemp(join(tmpdir(), "coding-sh-exp-judge-"));
    try {
      const store = new FileEvalStore({ root });
      const g1 = grader();
      const r1 = await runExperiment({ name: "j1", dataset: ds, task: upper, graders: [g1], store });
      const stored = await store.getJudge(g1.version);
      assert.ok(stored, "judge version is stored");
      assert.equal(stored.id, g1.version);
      assert.deepEqual(stored.tunedOn, ["dev"]);
      assert.equal(stored.calibration, undefined);
      assert.equal(r1.graders[0]?.calibration?.state, "uncalibrated");

      // What `judge calibrate` does once it finds the stored version.
      const calibration = { state: "calibrated" as const, kappa: 0.75, n: 8, split: "test" as const, ts: 1 };
      await store.putJudge({ ...stored, calibration });

      const r2 = await runExperiment({ name: "j2", dataset: ds, task: upper, graders: [grader()], store });
      assert.deepEqual(r2.graders[0]?.calibration, calibration);
      assert.deepEqual(r2.summary.graders[0]?.calibration, calibration);
      assert.equal(r2.summary.graders[0]?.passed, 4, "the wrapped grader still grades");
      const text = renderExperiment(r2, { color: false });
      assert.doesNotMatch(text, /UNCALIBRATED/);
      assert.doesNotMatch(text, /\*/);
      // A later run never overwrites the stored record (calibration kept).
      assert.deepEqual((await store.getJudge(g1.version))?.calibration, calibration);
      assert.deepEqual((await store.listJudges()).map((j) => j.id), [g1.version]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deterministic graders and store-less runs write no judges", async () => {
    const root = await mkdtemp(join(tmpdir(), "coding-sh-exp-judge-"));
    try {
      const store = new FileEvalStore({ root });
      await runExperiment({ name: "det", dataset: ds, task: upper, graders: [exactGrader()], store });
      await runExperiment({ name: "nostore", dataset: ds, task: upper, graders: [grader()] });
      assert.deepEqual(await store.listJudges(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
