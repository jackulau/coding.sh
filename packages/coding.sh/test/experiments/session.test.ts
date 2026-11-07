// X-12 experiment sessions and the X-21 regrade they use: a run in a session is
// compared with the previous run on the same dataset (the numbers `exp compare`
// prints), notes join the timeline, and a regrade grades stored outputs again
// without calling the task.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDataset } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderSessionSummary } from "../../src/experiments/render.ts";
import { regradeExperiment, runExperiment } from "../../src/experiments/run.ts";
import { appendBlock, findSession, newSession, readTimeline, recordExperiment, SESSION_ENV, sessionDelta, timelinePath } from "../../src/experiments/session.ts";
import { exactGrader } from "../../src/graders/builtin.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

const cases = ["a", "b", "c", "d", "e", "f"].map((q) => ({ id: q, input: { q }, expected: q.toUpperCase() }));
const ds = createDataset({ name: "upper", createdAt: 1, cases });
/** Upper-cases every input except the ones in `wrong`. */
const agent = (wrong: string[], calls = { n: 0 }) => ({
  kind: "function" as const,
  name: "agent",
  fn: (input: unknown) => {
    calls.n++;
    const q = (input as { q: string }).q;
    return wrong.includes(q) ? "nope" : q.toUpperCase();
  },
});
const strict = (bad: string[]): Grader => ({ id: "exact", version: "strict", kind: "exact", grade: async (ctx) => ({ pass: !bad.includes(ctx.caseId!) && ctx.output === ctx.expected, score: 0 }) });

describe("regradeExperiment", () => {
  it("grades the stored outputs again without calling the task", async () => {
    const calls = { n: 0 };
    const first = await runExperiment({ name: "base", dataset: ds, task: agent(["f"], calls), graders: [exactGrader()] });
    assert.equal(calls.n, 6);
    const same = await regradeExperiment({ result: first, dataset: ds, graders: [exactGrader()] });
    assert.equal(calls.n, 6, "the task is never called");
    assert.equal(same.summary.passed, 5);
    assert.equal(same.metadata?.regradeOf, first.id);
    assert.equal(same.metadata?.regradeNoTrace, true);
    const same0 = compareExperiments(first, same);
    assert.equal(same0.regressions.length + same0.improvements.length, 0, "an identical regrade flips nothing");
    const stricter = await regradeExperiment({ result: first, dataset: ds, graders: [strict(["a", "b"])] });
    const cmp = compareExperiments(first, stricter);
    assert.deepEqual(cmp.regressions.map((x) => x.caseId).sort(), ["a", "b"]);
    assert.equal(stricter.summary.passed, 3);
  });

  it("leaves a case ungraded when a grader throws, copies task errors, checks the dataset", async () => {
    const first = await runExperiment({
      name: "base",
      dataset: ds,
      task: { kind: "function", fn: (i: unknown) => { if ((i as { q: string }).q === "e") throw new Error("crash"); return (i as { q: string }).q.toUpperCase(); } },
      graders: [exactGrader()],
    });
    const throwing: Grader = { id: "exact", version: "t", kind: "exact", grade: async (ctx) => { if (ctx.caseId === "a") throw new Error("judge down"); return { pass: ctx.output === ctx.expected, score: 1 }; } };
    const r = await regradeExperiment({ result: first, dataset: ds, graders: [throwing] });
    const a = r.runs.find((x) => x.caseId === "a")!;
    assert.equal(a.ungraded, true);
    assert.equal(a.pass, false);
    // 6 runs: a ungraded (left out), e a task error (a fail), the other 4 pass.
    assert.equal(r.summary.passRate.p, 4 / 5, "the ungraded case is left out, not failed");
    assert.equal(r.runs.find((x) => x.caseId === "e")!.error, "crash");
    await assert.rejects(regradeExperiment({ result: first, dataset: { ...ds, id: "other" }, graders: [exactGrader()] }), /ran on dataset upper, not other/);
    const warns: string[] = [];
    await regradeExperiment({ result: first, dataset: { ...ds, version: "v2" }, graders: [exactGrader()], onWarn: (m) => warns.push(m) });
    assert.match(warns.join("\n"), /version v2/);
  });

  it("returns a cancelled result on abort and stores nothing", async () => {
    const root = temp("csh-regrade-");
    const store = new FileEvalStore({ root });
    const first = await runExperiment({ name: "base", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const ac = new AbortController();
    const slow: Grader = { id: "exact", version: "s", kind: "exact", grade: async () => { ac.abort(); return { pass: true, score: 1 }; } };
    const r = await regradeExperiment({ result: first, dataset: ds, graders: [slow], signal: ac.signal, store, concurrency: 1 });
    assert.equal(r.status, "cancelled");
    assert.equal((await store.listExperiments({})).length, 0);
  });
});

describe("findSession / newSession", () => {
  it("walks up from a subdirectory, keeps the folder out of git, and the env var wins", () => {
    const dir = temp("csh-session-");
    const s = newSession({ cwd: dir, name: "prompt", now: 5 });
    assert.match(s.id, /^xs_/);
    assert.equal(readFileSync(join(dir, ".coding-sh", ".gitignore"), "utf8"), "*\n");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    const found = findSession({ cwd: join(dir, "a", "b") });
    assert.equal(found?.id, s.id);
    assert.equal(found?.name, "prompt");
    assert.equal(findSession({ cwd: join(dir, "a"), env: { [SESSION_ENV]: "xs_other" } })?.id, "xs_other");
    assert.equal(findSession({ cwd: temp("csh-nosession-") }), undefined);
    assert.throws(() => timelinePath(dir, "../x"), /invalid session id/);
  });
});

describe("recordExperiment", () => {
  it("compares with the previous run on the dataset, like exp compare", async () => {
    const root = temp("csh-timeline-");
    const store = new FileEvalStore({ root });
    const s = { id: "xs_test" };
    const load = (id: string) => store.getExperiment(id);
    const a = await runExperiment({ name: "a", dataset: ds, task: agent(["a", "b", "c"]), graders: [exactGrader()], store });
    const first = await recordExperiment(root, s, a, { load, files: { "agent.mjs": "h1" } });
    assert.equal(first.delta, undefined);
    await appendBlock(root, s.id, { kind: "note", at: 2, text: "hypothesis: fixing c" });
    const b = await runExperiment({ name: "b", dataset: ds, task: agent(["a", "d"]), graders: [exactGrader()], store });
    const second = await recordExperiment(root, s, b, { load, files: { "agent.mjs": "h2" } });
    const cmp = compareExperiments(a, b);
    const d = second.delta!;
    assert.equal(d.paired, true);
    assert.equal(d.vs, a.id);
    assert.ok(Math.abs(d.diff!.mean - cmp.diff.mean) < 1e-4 && Math.abs(d.diff!.lo - cmp.diff.lo) < 1e-4 && Math.abs(d.diff!.hi - cmp.diff.hi) < 1e-4);
    assert.deepEqual(d.fixed!.sort(), ["b", "c"]);
    assert.deepEqual(d.broke, ["d"]);
    assert.deepEqual(second.changed, ["agent.mjs"]);
    const blocks = await readTimeline(root, s.id);
    assert.deepEqual(blocks.map((x) => x.kind), ["experiment", "note", "experiment"]);
    const text = renderSessionSummary({ id: s.id, name: "t" }, blocks, { color: false });
    assert.match(text, /note {2}hypothesis: fixing c/);
    assert.match(text, /fixed 2 broke 1/);
    // A new dataset version is not paired.
    const v2 = createDataset({ name: "upper", createdAt: 1, cases: [...cases, { id: "g", input: { q: "g" }, expected: "G" }] });
    assert.equal(sessionDelta(b, { ...b, dataset: { ...b.dataset, version: v2.version } }).paired, false);
  });
});

// The CLI end to end: a session in a folder, a second run from a subdirectory, notes, summary, --no-session.
describe("exp session CLI", () => {
  const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const root = temp("csh-session-cli-");
  const home = join(root, "home");
  mkdirSync(join(home, "proj", "sub"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
  };
  const cli = (args: string[], cwd = join(home, "proj")) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
  const agentFile = join(home, "proj", "agent.mjs");
  const write = (wrong: string[]) =>
    writeFileSync(agentFile, `let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const q=JSON.parse(s).q;process.stdout.write(${JSON.stringify(JSON.stringify(wrong))}.includes(q)?"nope":q.toUpperCase());});\n`);
  const spec = join(home, "proj", "spec.json");
  writeFileSync(spec, JSON.stringify({ dataset: "upper", task: { kind: "command", command: process.execPath, args: [agentFile] }, graders: [{ kind: "exact" }] }));

  it("prints the delta of the second run, equal to exp compare, and rebuilds the history", () => {
    const add = cli(["dataset", "add", "upper", ...cases.flatMap((c) => ["--case", JSON.stringify(c)])]);
    assert.equal(add.status, 0, add.stderr);
    const made = cli(["exp", "session", "new", "--name", "upper-fix", "--json"]);
    assert.equal(made.status, 0, made.stderr);
    const sid = JSON.parse(made.stdout).session.id as string;
    assert.equal(cli(["exp", "session", "note", "hypothesis:", "fixing", "d", "and", "e"]).status, 0);
    write(["d", "e", "f"]);
    const r1 = cli(["exp", "run", spec, "--json"]);
    assert.equal(r1.status, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout);
    assert.equal(j1.session.id, sid);
    assert.equal(j1.session.block.delta, undefined);
    write(["f"]);
    const r2 = cli(["exp", "run", "../spec.json"], join(home, "proj", "sub"));
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /session upper-fix: vs exp_/);
    assert.match(r2.stdout, /pass {4}50\.0% → 83\.3% {2}Δ \+33\.3pp \[/);
    assert.match(r2.stdout, /fixed {3}2: d, e/);
    assert.match(r2.stdout, /changed agent\.mjs/);
    const ids = [...r2.stdout.matchAll(/^(exp_\w+)$/gm)].map((m) => m[1]);
    const cmp = JSON.parse(cli(["exp", "compare", j1.experiment.id, ids[0]!, "--json"]).stdout).comparison;
    const sum = JSON.parse(cli(["exp", "session", "summary", "--json"], join(home, "proj", "sub")).stdout);
    const exps = sum.blocks.filter((b: { kind: string }) => b.kind === "experiment");
    assert.equal(exps.length, 2);
    const d = exps[1].delta;
    for (const k of ["mean", "lo", "hi"] as const) assert.ok(Math.abs(d.diff[k] - cmp.diff[k]) < 1e-4, `${k}: ${d.diff[k]} vs ${cmp.diff[k]}`);
    assert.equal(d.p, Math.round(cmp.mcnemar.p * 1e4) / 1e4);
    assert.deepEqual(sum.blocks.map((b: { kind: string }) => b.kind), ["note", "command", "experiment", "command", "experiment"]);
    assert.match(cli(["exp", "session", "summary"]).stdout, /^session upper-fix xs_/);

    // --no-session writes nothing.
    const timeline = join(home, ".coding.sh", "exp-sessions", `${sid}.jsonl`);
    const before = readFileSync(timeline, "utf8");
    const r3 = cli(["exp", "run", spec, "--no-session", "--json"]);
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(JSON.parse(r3.stdout).session, undefined);
    assert.equal(readFileSync(timeline, "utf8"), before);
  });

  it("points to exp session new when there is no session", () => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "exp", "session", "note", "x", "--json"], { env, cwd: root, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /exp session new --name <topic>/);
    assert.ok(!existsSync(join(root, ".coding-sh")));
  });
});
