// exp compare --given <grader>: the cases where a gate grader passes in both arms, compared on
// the other graders. The synthetic arms below differ in one way: B finishes more answers. Its
// accuracy among the answers both finish is the same, so B − A on `correct` is up overall and
// flat once the gate is applied.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok } from "../query/_seed.ts";

type Out = { answer: string; finish_reason: string };

const ids = Array.from({ length: 40 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
const ds = createDataset({ name: "given", createdAt: 1, cases: ids.map((id) => ({ id, input: id, expected: "ok" })) });
const num = (id: string) => Number(id.slice(1));

// A finishes c01..c20 and is right on all but c02. B finishes everything and is right everywhere
// except c01 (a finished case it gets wrong). A's cut answers (c21..c40) are wrong.
const arm = (finished: (n: number) => boolean, right: (n: number) => boolean) => (input: unknown): Out => {
  const n = num(String(input));
  return { answer: right(n) ? "ok" : "wrong", finish_reason: finished(n) ? "stop" : "length" };
};
const graders: Grader[] = [
  { id: "terminated", version: "1", kind: "custom", grade: async (c) => ((c.output as Out).finish_reason === "stop" ? { score: 1, pass: true } : { score: 0, pass: false }) },
  { id: "correct", version: "1", kind: "custom", grade: async (c) => ((c.output as Out).answer === "ok" ? { score: 1, pass: true } : { score: 0, pass: false }) },
];
const run = (name: string, task: (input: unknown) => Out) => runExperiment({ name, dataset: ds, task, graders });
const delta = (c: ReturnType<typeof compareExperiments>, id: string) => c.graders.find((g) => g.id === id)!;

describe("compareExperiments --given", () => {
  it("B's correct delta is up only because B terminates more; given terminated it is flat", async () => {
    const a = await run("base", arm((n) => n <= 20, (n) => n <= 20 && n !== 2));
    const b = await run("edited", arm(() => true, (n) => n !== 1));
    const all = compareExperiments(a, b, { seed: 1, iters: 4000 });
    assert.equal(all.given, undefined);
    assert.ok(delta(all, "terminated").diff.lo > 0, "terminated is up");
    assert.ok(delta(all, "correct").diff.lo > 0, `correct is up overall: ${JSON.stringify(delta(all, "correct").diff)}`);

    const given = compareExperiments(a, b, { seed: 1, iters: 4000, given: "terminated" });
    assert.deepEqual([given.given?.grader, given.given?.kept, given.given?.dropped], ["terminated", 20, 20]);
    assert.equal(given.paired, 20);
    const g = delta(given, "correct");
    assert.equal(g.n, 20);
    assert.ok(g.diff.lo <= 0 && g.diff.hi >= 0, `the CI covers 0: ${JSON.stringify(g.diff)}`);
    assert.equal(g.diff.mean, 0);
    // The gate grader passes everywhere that is kept, so it has no delta left to show.
    assert.equal(delta(given, "terminated").diff.mean, 0);
    assert.equal(given.mcnemar.p, 1);
    assert.match(given.given!.note, /conditioned on terminated.*20 case\(s\).*20 dropped/);
    const text = renderComparison(given, { color: false, a, b });
    assert.match(text, /! conditioned on terminated: only the 20 case\(s\) where terminated passes in both A and B are compared, 20 dropped/);
  });

  it("keeps a case only when the gate passes in both arms", async () => {
    // A finishes c01..c20, B finishes c11..c40: both finish c11..c20.
    const a = await run("a", arm((n) => n <= 20, () => true));
    const b = await run("b", arm((n) => n > 10, () => true));
    const c = compareExperiments(a, b, { given: "terminated" });
    assert.deepEqual([c.given?.kept, c.given?.dropped, c.paired], [10, 30, 10]);
  });

  it("names the graders that exist when the gate is unknown", async () => {
    const a = await run("a", arm(() => true, () => true));
    assert.throws(() => compareExperiments(a, a, { given: "nope" }), /no grader named "nope" in both experiments; graders in both: terminated, correct/);
  });

  it("with no case kept, says so and prints no statistics", async () => {
    const a = await run("stuck", arm(() => false, () => true));
    const b = await run("edited", arm(() => true, () => true));
    const c = compareExperiments(a, b, { given: "terminated" });
    assert.deepEqual([c.given?.kept, c.given?.dropped, c.paired], [0, 40, 0]);
    const text = renderComparison(c, { color: false, a, b });
    assert.match(text, /! --given terminated: no case passes terminated in both A and B \(40 dropped\), so there is nothing to compare/);
    assert.doesNotMatch(text, /B − A|mcnemar|verdict/);
  });
});

describe("exp compare --given from the CLI", () => {
  let env: TmpEnv;
  let proj = "";
  before(() => {
    env = tmpEnv();
    proj = join(env.root, "proj");
    mkdirSync(proj, { recursive: true });
    // MODEL=base finishes the first 6 cases and misses c2; edited finishes all and misses c1; stuck never finishes.
    writeFileSync(
      join(proj, "gen.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=Number(JSON.parse(s).slice(1));const m=process.env.MODEL;
const done=m==="edited"||(m==="base"&&n<=6);const right=m==="edited"?n!==1:m==="base"&&n<=6&&n!==2;
process.stdout.write(JSON.stringify({answer:right?"ok":"wrong",finish_reason:done?"stop":"length"}))});\n`,
    );
    const cases = Array.from({ length: 10 }, (_, i) => ["--case", JSON.stringify({ id: `c${i + 1}`, input: `c${i + 1}`, expected: "ok" })]).flat();
    ok(["dataset", "add", "gv", ...cases]);
    const task = (model: string) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(proj, "gen.mjs")], env: { MODEL: model } });
    const g = ['{"kind":"json-path","name":"terminated","path":"$.finish_reason","equals":"stop"}', '{"kind":"json-path","name":"correct","path":"$.answer"}'];
    for (const model of ["base", "edited", "stuck"]) ok(["exp", "run", "-d", "gv", "--task", task(model), "-g", g[0]!, "-g", g[1]!, "--name", model]);
  });
  after(() => env.restore());

  it("prints the kept and dropped counts and says the deltas are conditioned on the gate", () => {
    const r = ok(["exp", "compare", "base", "edited", "--given", "terminated"]);
    assert.match(r.stdout, /! conditioned on terminated: only the 6 case\(s\) where terminated passes in both A and B are compared, 4 dropped/);
    assert.match(r.stdout, /\(6 paired cases/);
  });

  it("--json carries given with grader, kept and dropped; without the flag there is none", () => {
    const given = JSON.parse(ok(["exp", "compare", "base", "edited", "--given", "terminated", "--json"]).stdout).comparison;
    assert.deepEqual([given.given.grader, given.given.kept, given.given.dropped], ["terminated", 6, 4]);
    assert.equal(given.paired, 6);
    assert.equal("given" in JSON.parse(ok(["exp", "compare", "base", "edited", "--json"]).stdout).comparison, false);
  });

  it("an unknown grader is a usage error that lists the graders that exist", () => {
    const r = cli(["exp", "compare", "base", "edited", "--given", "nope"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--given nope: no grader named "nope" in both experiments; graders in both: terminated, correct/);
  });

  it("with no case kept it says so and prints no statistics", () => {
    const r = ok(["exp", "compare", "stuck", "edited", "--given", "terminated"]);
    assert.match(r.stdout, /no case passes terminated in both A and B \(10 dropped\), so there is nothing to compare/);
    assert.doesNotMatch(r.stdout, /mcnemar|verdict/);
    const j = JSON.parse(ok(["exp", "compare", "stuck", "edited", "--given", "terminated", "--json"]).stdout).comparison;
    assert.deepEqual([j.given.kept, j.given.dropped], [0, 10]);
  });
});
