// exp run --weights <SHA256>: the checkpoint an experiment ran, stored as metadata.weights and
// shown by exp compare, so "base vs edited" names both checkpoints and a comparison of one
// checkpoint with itself is called out. The hashes below are of labels, not of files: the CLI
// never hashes anything itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { ExperimentResult, Grader } from "../../src/datasets/types.ts";
import { runAb } from "../../src/experiments/ab.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison, renderExperiment } from "../../src/experiments/render.ts";
import { regradeExperiment, ResumeMismatchError, runExperiment } from "../../src/experiments/run.ts";
import { parseWeights, weightsOf } from "../../src/experiments/weights.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { CLI, cli, ok } from "../query/_seed.ts";

const sha = (label: string) => createHash("sha256").update(label).digest("hex");
const BASE = sha("base checkpoint");
const EDITED = sha("edited checkpoint");
const short = (s: string) => s.slice(0, 12);
const stamp = (r: ExperimentResult) => (r.metadata?.weights as { sha256?: string } | undefined)?.sha256;
const stamped = (r: ExperimentResult) => Object.hasOwn(r.metadata ?? {}, "weights");

const ds = createDataset({ name: "wt", createdAt: 1, cases: [1, 2, 3, 4].map((n) => ({ id: `m${n}`, input: n, expected: n })) });
const exact: Grader = { id: "exact", version: "1", kind: "custom", grade: async (c) => (c.output === c.expected ? { score: 1, pass: true } : { score: 0, pass: false }) };
const run = (name: string, weights?: string, task: (n: unknown) => unknown = (n) => n) =>
  runExperiment({ name, dataset: ds, task, graders: [exact], metadata: weights ? { weights: { sha256: weights } } : undefined });

describe("the weights stamp in compareExperiments", () => {
  it("different stamps: each side carries its own, with no warning; no stamps: nothing about weights", async () => {
    const c = compareExperiments(await run("base", BASE), await run("edited", EDITED));
    assert.deepEqual([c.a.weights, c.b.weights], [{ sha256: BASE }, { sha256: EDITED }]);
    assert.equal(Object.hasOwn(c, "weightsWarning"), false);

    const a = await run("a");
    assert.equal(stamped(a), false);
    const none = compareExperiments(a, await run("b"));
    assert.equal(Object.hasOwn(none.a, "weights"), false);
    assert.equal(Object.hasOwn(none.b, "weights"), false);
    assert.equal(Object.hasOwn(none, "weightsWarning"), false);
    assert.doesNotMatch(renderComparison(none, { color: false }), /weights/);
  });

  it("the same stamp on both sides warns; a regrade of the other side does not", async () => {
    const a = await run("base", BASE);
    const twin = await run("twin", BASE);
    const c = compareExperiments(a, twin);
    assert.match(c.weightsWarning!, new RegExp(`^A and B ran the same weights \\(${short(BASE)}\\)`));
    assert.match(renderComparison(c, { color: false }), new RegExp(`^! A and B ran the same weights \\(${short(BASE)}\\)`, "m"));

    const regraded = await regradeExperiment({ result: a, dataset: ds, graders: [exact] });
    assert.equal(stamp(regraded), BASE, "a regrade inherits the stamp of the outputs it grades");
    for (const [x, y] of [[a, regraded], [regraded, a]] as const) {
      const r = compareExperiments(x, y);
      assert.deepEqual([r.a.weights, r.b.weights], [{ sha256: BASE }, { sha256: BASE }]);
      assert.equal(Object.hasOwn(r, "weightsWarning"), false);
    }
  });

  it("a stamp on one side only is said plainly", async () => {
    const c = compareExperiments(await run("plain"), await run("edited", EDITED));
    assert.equal(Object.hasOwn(c.a, "weights"), false);
    assert.match(c.weightsWarning!, new RegExp(`^only B records which weights it ran \\(${short(EDITED)}\\); A was run without --weights`));
    const text = renderComparison(c, { color: false });
    assert.match(text, /^A plain \S+ {2}pass 100\.0% {2}weights not recorded$/m);
    assert.match(text, new RegExp(`^B edited \\S+ {2}pass 100\\.0% {2}weights ${short(EDITED)}$`, "m"));
    assert.match(text, /^! only B records which weights it ran/m);
  });

  it("both headers show the stamps: the normal one and the one --given prints when no case is kept", async () => {
    const gate: Grader = { id: "even", version: "1", kind: "custom", grade: async (c) => ((c.output as number) % 2 === 0 ? { score: 1, pass: true } : { score: 0, pass: false }) };
    const of = (name: string, weights: string, task: (n: unknown) => unknown) => runExperiment({ name, dataset: ds, task, graders: [gate, exact], metadata: { weights: { sha256: weights } } });
    const a = await of("base", BASE, () => 1);
    const b = await of("edited", EDITED, (n) => n);
    const none = compareExperiments(a, b, { given: "even" });
    assert.equal(none.given?.kept, 0);
    for (const c of [compareExperiments(a, b), none]) {
      const text = renderComparison(c, { color: false });
      assert.match(text, new RegExp(`^A base \\S+.* {2}weights ${short(BASE)}$`, "m"));
      assert.match(text, new RegExp(`^B edited \\S+.* {2}weights ${short(EDITED)}$`, "m"));
    }
    assert.match(renderComparison(none, { color: false }), /nothing to compare/);
    assert.match(renderExperiment(a, { color: false }), new RegExp(`^weights ${BASE}$`, "m"));
    assert.doesNotMatch(renderExperiment(await run("plain"), { color: false }), /weights/);
  });

  it("a stored value that is not a SHA-256 is not a stamp; any case reads as lowercase", () => {
    assert.equal(weightsOf({ metadata: { weights: { sha256: "abc" } } }), undefined);
    assert.equal(weightsOf({ metadata: { weights: BASE } }), undefined);
    assert.equal(weightsOf({ metadata: { checkpoint: { done: 1, total: 4, at: 1 } } }), undefined);
    assert.equal(weightsOf({ metadata: { weights: { sha256: BASE.toUpperCase() } } }), BASE);
    assert.equal(parseWeights(`  ${BASE.toUpperCase()}\n`), BASE);
    assert.equal(parseWeights(BASE.slice(1)), undefined);
    assert.equal(parseWeights(`${BASE.slice(2)}zz`), undefined);
  });
});

describe("the weights stamp across resume and A/B runs", () => {
  const flaky = (broken: () => boolean) => (n: unknown) => {
    if (n === 2 && broken()) throw new Error("boom");
    return n;
  };

  it("a resumed run keeps the stored stamp when none is given, and refuses a different one", async () => {
    let broken = true;
    const task = flaky(() => broken);
    const first = await runExperiment({ name: "r", dataset: ds, task, graders: [exact], metadata: { weights: { sha256: BASE } } });
    assert.equal(first.summary.errors, 1);
    broken = false;
    const again = await runExperiment({ name: "r", dataset: ds, task, graders: [exact], resumeFrom: first, retryErrors: true });
    assert.equal(again.summary.errors, 0);
    assert.equal(stamp(again), BASE);
    const same = await runExperiment({ name: "r", dataset: ds, task, graders: [exact], resumeFrom: first, retryErrors: true, metadata: { weights: { sha256: BASE } } });
    assert.equal(stamp(same), BASE);
    await assert.rejects(
      runExperiment({ name: "r", dataset: ds, task, graders: [exact], resumeFrom: first, retryErrors: true, metadata: { weights: { sha256: EDITED } } }),
      (e: unknown) => e instanceof ResumeMismatchError && e.fields.includes("weights") && new RegExp(`weights changed \\(${short(BASE)} → ${short(EDITED)}\\)`).test(e.message),
    );
  });

  it("a run stored without a stamp does not gain one on resume", async () => {
    let broken = true;
    const task = flaky(() => broken);
    const first = await runExperiment({ name: "r", dataset: ds, task, graders: [exact] });
    broken = false;
    await assert.rejects(
      runExperiment({ name: "r", dataset: ds, task, graders: [exact], resumeFrom: first, retryErrors: true, metadata: { weights: { sha256: EDITED } } }),
      (e: unknown) => e instanceof ResumeMismatchError && /weights changed \(none → /.test(e.message),
    );
    const again = await runExperiment({ name: "r", dataset: ds, task, graders: [exact], resumeFrom: first, retryErrors: true });
    assert.equal(stamped(again), false);
  });

  it("runAb stamps each arm with its own weights, and an arm without any stays unstamped", async () => {
    const both = await runAb({ name: "ab", dataset: ds, graders: [exact], seed: 1, arms: [{ name: "base", task: (n: unknown) => n, weights: BASE }, { name: "edited", task: (n: unknown) => n, weights: EDITED }] });
    assert.deepEqual([stamp(both.a), stamp(both.b)], [BASE, EDITED]);
    const one = await runAb({ name: "ab", dataset: ds, graders: [exact], seed: 1, arms: [{ name: "base", task: (n: unknown) => n }, { name: "edited", task: (n: unknown) => n, weights: EDITED }] });
    assert.equal(stamped(one.a), false);
    assert.equal(stamp(one.b), EDITED);
  });
});

describe("exp run --weights from the CLI", () => {
  let env: TmpEnv;
  let proj = "";
  let edited = "";
  const G = ['{"kind":"json-path","name":"terminated","path":"$.finish_reason","equals":"stop"}', '{"kind":"json-path","name":"correct","path":"$.answer"}'];
  const task = (model: string) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(proj, "gen.mjs")], env: { MODEL: model } });
  const runArgs = (model: string, name: string, ...more: string[]) => ["exp", "run", "-d", "wt", "--task", task(model), "-g", G[0]!, "-g", G[1]!, "--name", name, ...more];
  const exp = (r: { stdout: string }) => (JSON.parse(r.stdout) as { experiment: ExperimentResult }).experiment;
  const names = () => (JSON.parse(ok(["exp", "list", "--json"]).stdout) as { experiments: { name: string }[] }).experiments.map((e) => e.name);

  before(() => {
    env = tmpEnv();
    proj = join(env.root, "proj");
    mkdirSync(proj, { recursive: true });
    // MODEL=base finishes m1 and m2; edited finishes every case and misses m3; stuck finishes none.
    // m2 exits 1 while ./broken exists, and m3 hangs while ./hang exists.
    writeFileSync(
      join(proj, "gen.mjs"),
      `import {existsSync} from "node:fs";let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=Number(JSON.parse(s).slice(1));const m=process.env.MODEL;
if(n===2&&existsSync(${JSON.stringify(join(proj, "broken"))}))process.exit(1);
if(n===3&&existsSync(${JSON.stringify(join(proj, "hang"))})){setInterval(()=>{},1000);return}
const done=m==="edited"||(m==="base"&&n<=2);const right=m==="edited"?n!==3:m==="base"&&n<=2;
process.stdout.write(JSON.stringify({answer:right?"ok":"wrong",finish_reason:done?"stop":"length"}))});\n`,
    );
    const cases = [1, 2, 3, 4].map((n) => ["--case", JSON.stringify({ id: `m${n}`, input: `m${n}`, expected: { answer: "ok" } })]).flat();
    ok(["dataset", "add", "wt", ...cases]);
    ok(runArgs("base", "base", "--weights", BASE));
    // Uppercase in, as some hashing tools print it.
    edited = ok(runArgs("edited", "edited", "--weights", EDITED.toUpperCase())).stdout;
    ok(runArgs("base", "twin", "--weights", BASE));
    ok(runArgs("stuck", "stuck", "--weights", sha("stuck checkpoint")));
    ok(runArgs("base", "plain"));
  });
  after(() => env.restore());

  it("stores metadata.weights lowercase, and shows it in the run summary and exp show", () => {
    assert.match(edited, new RegExp(`^weights ${EDITED}$`, "m"));
    const shown = ok(["exp", "show", "edited"]).stdout;
    assert.match(shown, new RegExp(`^weights ${EDITED}$`, "m"));
    const e = exp(ok(["exp", "show", "edited", "--json"]));
    assert.deepEqual(e.metadata?.weights, { sha256: EDITED });
  });

  it("without the flag, metadata.weights is absent", () => {
    const e = exp(ok(["exp", "show", "plain", "--json"]));
    assert.equal(stamped(e), false);
    assert.doesNotMatch(ok(["exp", "show", "plain"]).stdout, /weights/);
  });

  it("exp compare shows both stamps in the header: short in text, whole in --json", () => {
    const text = ok(["exp", "compare", "base", "edited"]).stdout;
    assert.match(text, new RegExp(`^A base exp_\\w+ {2}pass [\\d.]+% {2}weights ${short(BASE)}$`, "m"));
    assert.match(text, new RegExp(`^B edited exp_\\w+ {2}pass [\\d.]+% {2}weights ${short(EDITED)}$`, "m"));
    assert.doesNotMatch(text, /same weights|only [AB] records/);
    const c = JSON.parse(ok(["exp", "compare", "base", "edited", "--json"]).stdout).comparison;
    assert.deepEqual([c.a.weights, c.b.weights], [{ sha256: BASE }, { sha256: EDITED }]);
    assert.equal("weightsWarning" in c, false);
  });

  it("the --given header shows them too, with cases kept and with none", () => {
    const kept = ok(["exp", "compare", "base", "edited", "--given", "terminated"]).stdout;
    assert.match(kept, new RegExp(`^A base exp_\\w+ {2}pass [\\d.]+% {2}weights ${short(BASE)}$`, "m"));
    assert.match(kept, new RegExp(`^B edited exp_\\w+ {2}pass [\\d.]+% {2}weights ${short(EDITED)}$`, "m"));
    const none = ok(["exp", "compare", "stuck", "edited", "--given", "terminated"]).stdout;
    assert.match(none, /nothing to compare/);
    assert.match(none, new RegExp(`^A stuck exp_\\w+ {2}weights ${short(sha("stuck checkpoint"))}$`, "m"));
    assert.match(none, new RegExp(`^B edited exp_\\w+ {2}weights ${short(EDITED)}$`, "m"));
  });

  it("equal stamps warn in text and --json", () => {
    const text = ok(["exp", "compare", "base", "twin"]).stdout;
    assert.match(text, new RegExp(`^! A and B ran the same weights \\(${short(BASE)}\\): B − A is not a difference between two models$`, "m"));
    const c = JSON.parse(ok(["exp", "compare", "base", "twin", "--json"]).stdout).comparison;
    assert.match(c.weightsWarning, /^A and B ran the same weights/);
  });

  it("a regrade inherits the stamp and its pair does not warn", () => {
    const r = exp(ok(["exp", "regrade", "base", "-g", G[1]!, "--name", "regraded", "--json"]));
    assert.deepEqual(r.metadata?.weights, { sha256: BASE });
    assert.equal(typeof r.metadata?.regradeOf, "string");
    const text = ok(["exp", "compare", "base", "regraded"]).stdout;
    assert.match(text, new RegExp(`^B regraded exp_\\w+ {2}pass [\\d.]+% {2}weights ${short(BASE)}$`, "m"));
    assert.doesNotMatch(text, /same weights/);
  });

  it("a stamp on one side only says so; no stamp on either says nothing", () => {
    const text = ok(["exp", "compare", "plain", "edited"]).stdout;
    assert.match(text, /^A plain exp_\w+ {2}pass [\d.]+% {2}weights not recorded$/m);
    assert.match(text, /^! only B records which weights it ran \(\w{12}\); A was run without --weights/m);
    ok(runArgs("edited", "plain2"));
    const bare = ok(["exp", "compare", "plain", "plain2"]);
    assert.doesNotMatch(bare.stdout, /weights/);
    assert.equal("weights" in JSON.parse(ok(["exp", "compare", "plain", "plain2", "--json"]).stdout).comparison.a, false);
  });

  it("a value that is not 64 hex characters is a usage error and nothing runs", () => {
    for (const bad of [BASE.slice(0, 40), `${BASE.slice(2)}zz`, "model.safetensors", `sha256:${BASE}`]) {
      const r = cli(runArgs("base", "bad", "--weights", bad));
      assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
      assert.match(r.stderr, /--weights takes the SHA-256 of the checkpoint file: 64 hex characters/);
    }
    const two = cli(runArgs("base", "bad", "--weights", BASE, "--weights", EDITED));
    assert.equal(two.status, 2);
    assert.match(two.stderr, /--weights takes one SHA-256 for a run of one task/);
    const named = cli(runArgs("base", "bad", "--weights", `base=${BASE}`));
    assert.equal(named.status, 2);
    assert.match(named.stderr, /--weights ARM=<SHA256> needs two --arm options/);
    assert.equal(names().includes("bad"), false);
  });

  it("--arm takes one stamp per arm, by name", () => {
    const arms = ["--arm", `base=${task("base")}`, "--arm", `edited=${task("edited")}`];
    const args = ["exp", "run", "-d", "wt", "-g", G[0]!, "-g", G[1]!, ...arms, "--seed", "1"];
    const r = JSON.parse(ok([...args, "--name", "ab", "--weights", `edited=${EDITED}`, "--weights", `base=${BASE.toUpperCase()}`, "--json"]).stdout) as { experiments: ExperimentResult[]; comparison: { a: { weights: unknown }; b: { weights: unknown } } };
    assert.deepEqual(r.experiments.map((e) => [e.name, e.metadata?.weights]), [["ab-base", { sha256: BASE }], ["ab-edited", { sha256: EDITED }]]);
    assert.deepEqual([r.comparison.a.weights, r.comparison.b.weights], [{ sha256: BASE }, { sha256: EDITED }]);

    const text = ok([...args, "--name", "ab1", "--weights", `edited=${EDITED}`]).stdout;
    assert.match(text, /^A ab1-base exp_\w+ {2}pass [\d.]+% {2}weights not recorded$/m);
    assert.match(text, new RegExp(`^B ab1-edited exp_\\w+ {2}pass [\\d.]+% {2}weights ${short(EDITED)}$`, "m"));
    assert.equal(stamped(exp(ok(["exp", "show", "ab1-base", "--json"]))), false);

    for (const [bad, why] of [
      [["--weights", BASE], /with --arm, name the arm each stamp belongs to: --weights base=<SHA256> --weights edited=<SHA256>/],
      [["--weights", `nope=${BASE}`], /--weights nope=…: no arm named "nope" \(arms: base, edited\)/],
      [["--weights", `base=${BASE}`, "--weights", `base=${EDITED}`], /--weights names arm "base" twice/],
      [["--weights", "base=abc"], /--weights takes the SHA-256 of the checkpoint file: 64 hex characters/],
    ] as const) {
      const x = cli([...args, "--name", "abbad", ...bad]);
      assert.equal(x.status, 2, `${bad.join(" ")}: ${x.stderr}`);
      assert.match(x.stderr, why);
    }
    assert.equal(names().some((n) => n.startsWith("abbad")), false);
  });

  it("--watch and a matrix spec refuse the flag before anything runs", () => {
    const watch = cli(runArgs("base", "w", "--weights", BASE, "--watch"));
    assert.equal(watch.status, 2, watch.stderr);
    assert.match(watch.stderr, /--weights stamps one run with one checkpoint; it does not combine with --watch/);
    const spec = join(proj, "matrix.json");
    writeFileSync(spec, JSON.stringify({ dataset: "wt", graders: [JSON.parse(G[1]!)], variants: { base: { task: JSON.parse(task("base")) }, edited: { task: JSON.parse(task("edited")) } }, baseline: "base" }));
    const matrix = cli(["exp", "run", spec, "--weights", BASE]);
    assert.equal(matrix.status, 2, matrix.stderr);
    assert.match(matrix.stderr, /--weights stamps one run with one checkpoint; it does not combine with a matrix spec/);
    assert.deepEqual(names().filter((n) => n === "w" || n.includes("matrix")), []);
  });

  it("--resume <experiment> --retry-errors keeps the stamp, and refuses a different one", () => {
    writeFileSync(join(proj, "broken"), "");
    const first = exp(ok(runArgs("edited", "flaky", "--weights", BASE, "--json")));
    assert.equal(first.summary.errors, 1);
    rmSync(join(proj, "broken"));
    const other = cli(runArgs("edited", "flaky", "--resume", first.id, "--retry-errors", "--weights", EDITED));
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, new RegExp(`can't resume ${first.id}: weights changed \\(${short(BASE)} → ${short(EDITED)}\\)`));
    const again = exp(ok(runArgs("edited", "flaky", "--resume", first.id, "--retry-errors", "--json")));
    assert.equal(again.id, first.id);
    assert.equal(again.summary.errors, 0);
    assert.deepEqual(again.metadata?.weights, { sha256: BASE });
  });

  /** Start a run that hangs on m3, wait until `ready` returns its id, then kill it. */
  async function killMidRun(args: string[], ready: () => string | undefined): Promise<string> {
    writeFileSync(join(proj, "hang"), "");
    const childEnv = { ...process.env, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args, "-c", "1"], { env: childEnv, stdio: "ignore" });
    let id: string | undefined;
    for (let i = 0; i < 80 && !id; i++) {
      await new Promise((r) => setTimeout(r, 250));
      id = ready();
    }
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    rmSync(join(proj, "hang"));
    assert.ok(id, `the run never got far enough to kill (home ${existsSync(env.dataHome) ? "exists" : "missing"})`);
    return id;
  }

  it("a killed run resumes with its stamp, and neither a different stamp nor a bare --resume takes it over", async () => {
    const id = await killMidRun(runArgs("edited", "killed", "--weights", BASE), () => {
      const l = cli(["exp", "list", "--json"]);
      const e = l.status === 0 ? (JSON.parse(l.stdout) as { experiments: { id: string; name: string; partial?: boolean; runs: number }[] }).experiments.find((x) => x.name === "killed") : undefined;
      return e?.partial && e.runs >= 2 ? e.id : undefined;
    });
    // The partial record written mid-run already carries the stamp.
    assert.deepEqual(exp(ok(["exp", "show", id, "--json"])).metadata?.weights, { sha256: BASE });

    const other = cli(runArgs("edited", "killed", "--resume", id, "--weights", EDITED));
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, new RegExp(`Can't resume ${id}: it ran weights ${short(BASE)}, and --weights gives ${short(EDITED)}`));
    // Without an id, --resume finds a run by its config, and the stamp is part of it.
    const bare = cli(runArgs("edited", "killed", "--resume"));
    assert.equal(bare.status, 1, bare.stderr);
    assert.match(bare.stderr, /its config changed since it started \(weights\)/);

    const done = exp(ok(runArgs("edited", "killed", "--resume", id, "--json")));
    assert.equal(done.id, id);
    assert.equal(done.status, "completed");
    assert.equal(done.runs.length, 4);
    assert.deepEqual(done.metadata?.weights, { sha256: BASE });
  });

  it("a killed --arm run resumes with each arm's stamp, and refuses a different one", async () => {
    const args = ["exp", "run", "-d", "wt", "-g", G[0]!, "-g", G[1]!, "--arm", `base=${task("base")}`, "--arm", `edited=${task("edited")}`, "--seed", "1", "--name", "abk"];
    const id = await killMidRun([...args, "--weights", `base=${BASE}`, "--weights", `edited=${EDITED}`], () => {
      const l = cli(["exp", "status", "--json"]);
      const runs = l.status === 0 ? (JSON.parse(l.stdout) as { runs: { id: string; name: string; done: number }[] }).runs : [];
      return runs.find((x) => x.name === "abk" && x.done >= 2)?.id;
    });
    const other = cli([...args, "--resume", id, "--weights", `base=${BASE}`, "--weights", `edited=${BASE}`]);
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, new RegExp(`Can't resume ${id}: arm edited ran weights ${short(EDITED)}, and --weights gives ${short(BASE)}`));
    const done = JSON.parse(ok([...args, "--resume", id, "--json"]).stdout) as { outcome: string; experiments: ExperimentResult[] };
    assert.equal(done.outcome, "completed");
    assert.deepEqual(done.experiments.map((e) => [e.name, e.runs.length, e.metadata?.weights]), [["abk-base", 4, { sha256: BASE }], ["abk-edited", 4, { sha256: EDITED }]]);
  });
});
