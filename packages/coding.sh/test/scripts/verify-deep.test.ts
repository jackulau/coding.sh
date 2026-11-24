import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOB_VARS, NIGHTLY, childEnv, formatTime, plan, replayCommand, summary, verifyFiles } from "../../scripts/verify-deep.ts";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../scripts/verify-deep.ts", import.meta.url));

/** Runs the script on `files` (written to a temp folder) and returns its exit code, output, and the files it wrote. */
function runScript(files: Record<string, string>, env: NodeJS.ProcessEnv, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "verify-deep-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const step = join(dir, "step-summary.md");
    writeFileSync(step, "earlier step\n");
    // Knobs set for this test run would reach the script's files and its summary.
    const full: NodeJS.ProcessEnv = { ...process.env };
    for (const v of KNOB_VARS) delete full[v];
    Object.assign(full, env, { GITHUB_STEP_SUMMARY: step });
    delete full.NODE_TEST_CONTEXT; // else the script's files report to this test run instead of their own output
    delete full.GITHUB_ACTIONS;
    const out = join(dir, "out");
    const args = ["--no-warnings", SCRIPT, "--out", out, ...extra, ...Object.keys(files).map((f) => join(dir, f))];
    const r = spawnSync(process.execPath, args, { cwd: PKG, env: full, encoding: "utf8", timeout: 120_000 });
    const read = (name: string): string => readFileSync(join(out, name), "utf8");
    const logs = Object.fromEntries(readdirSync(out).filter((f) => f.endsWith(".log")).map((f) => [f, read(f)]));
    return { code: r.status, stdout: r.stdout, all: r.stdout + r.stderr, summary: read("summary.md"), seed: read("seed.txt"), step: readFileSync(step, "utf8"), logs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scripts/verify-deep.ts", () => {
  it("has a row for every verify file, naming the knobs that file reads", () => {
    const names = verifyFiles();
    assert.ok(names.includes("lock-model") && names.includes("fold-prop"), names.join(" "));
    assert.deepEqual(Object.keys(NIGHTLY).sort(), names);
    for (const name of names) {
      const src = readFileSync(join(PKG, "test", "verify", `${name}.test.ts`), "utf8");
      const row = NIGHTLY[name] ?? {};
      assert.equal(row.bound !== undefined, /\benv\.CODING_SH_MODEL_BOUND\b/.test(src), `${name}: a bound in NIGHTLY when the file reads CODING_SH_MODEL_BOUND`);
      // prop.test.ts checks forAll itself and gives each call an environment of its own.
      const props = name !== "prop" && /from "\.\.\/_prop\.ts"/.test(src);
      assert.equal(row.runs !== undefined, props, `${name}: runs in NIGHTLY when the file's properties read CODING_SH_PROP_RUNS`);
    }
  });

  it("puts a knob from the environment in place of the table's, reads an empty one as unset, and gives the seed to property files", () => {
    const p = plan(["lock-model", "fold-prop", "model"], { CODING_SH_MODEL_BOUND: "1", CODING_SH_PROP_RUNS: "", CODING_SH_PROP_SEED: " 7 " });
    assert.equal(p.seed, 7);
    assert.equal(p.seedFrom, "CODING_SH_PROP_SEED");
    assert.deepEqual(p.given, { CODING_SH_MODEL_BOUND: "1", CODING_SH_PROP_SEED: "7" });
    assert.deepEqual(
      p.files.map((f) => [f.name, f.file, f.vars]),
      [
        ["lock-model", "test/verify/lock-model.test.ts", { CODING_SH_MODEL_BOUND: "1" }],
        ["fold-prop", "test/verify/fold-prop.test.ts", { CODING_SH_PROP_RUNS: String(NIGHTLY["fold-prop"]?.runs), CODING_SH_PROP_SEED: "7" }],
        ["model", "test/verify/model.test.ts", {}],
      ],
    );
    assert.equal(replayCommand(p.files[1]!), `CODING_SH_PROP_RUNS=${NIGHTLY["fold-prop"]?.runs} CODING_SH_PROP_SEED=7 node --no-warnings --test test/verify/fold-prop.test.ts`);
    assert.deepEqual(plan(["lock-model.test.ts"], {}).files[0]?.vars, { CODING_SH_MODEL_BOUND: String(NIGHTLY["lock-model"]?.bound) });
  });

  it("picks the seed at random when none is given, or when it is \"random\"", () => {
    for (const env of [{}, { CODING_SH_PROP_SEED: "" }, { CODING_SH_PROP_SEED: "random" }]) {
      const p = plan(["fold-prop"], env, () => 99);
      assert.equal(p.seed, 99);
      assert.equal(p.seedFrom, "random");
    }
  });

  it("refuses a bound or runs that are not whole numbers, runs of 0, a bad seed, and a file it cannot find", () => {
    assert.throws(() => plan(["lock-model"], { CODING_SH_MODEL_BOUND: "-1" }), /CODING_SH_MODEL_BOUND must be a whole number/);
    assert.throws(() => plan(["lock-model"], { CODING_SH_MODEL_BOUND: "1.5" }), /CODING_SH_MODEL_BOUND/);
    assert.throws(() => plan(["fold-prop"], { CODING_SH_PROP_RUNS: "0" }), /CODING_SH_PROP_RUNS must be a whole number above 0/);
    assert.throws(() => plan(["fold-prop"], { CODING_SH_PROP_SEED: "4294967296" }), /CODING_SH_PROP_SEED must be/);
    assert.throws(() => plan(["no-such-file"], {}), /no test file no-such-file/);
  });

  it("keeps the run's NODE_OPTIONS in each replay command, and quotes a word sh would read", () => {
    const f = { name: "lock-model", file: "test/verify/lock-model.test.ts", vars: { CODING_SH_MODEL_BOUND: "2" } };
    assert.equal(replayCommand(f, "--max-old-space-size=12288"), "NODE_OPTIONS=--max-old-space-size=12288 CODING_SH_MODEL_BOUND=2 node --no-warnings --test test/verify/lock-model.test.ts");
    assert.equal(replayCommand(f, "--max-old-space-size=8192 --trace-gc"), "NODE_OPTIONS='--max-old-space-size=8192 --trace-gc' CODING_SH_MODEL_BOUND=2 node --no-warnings --test test/verify/lock-model.test.ts");
    assert.equal(replayCommand({ ...f, file: "/tmp/it's here/a.test.ts" }), `CODING_SH_MODEL_BOUND=2 node --no-warnings --test '/tmp/it'\\''s here/a.test.ts'`);
    const p = plan(["lock-model"], { CODING_SH_MODEL_BOUND: "2" });
    const md = summary(p, [{ ...p.files[0]!, result: "out of memory", ms: 1000 }], 20, "--max-old-space-size=12288");
    assert.match(md, /^NODE_OPTIONS=--max-old-space-size=12288 CODING_SH_MODEL_BOUND=2 node --no-warnings --test test\/verify\/lock-model\.test\.ts$/m);
  });

  it("runs a file without the knobs it does not read, and outside any test run", () => {
    const env = childEnv({ PATH: "x", CODING_SH_MODEL_BOUND: "3", CODING_SH_PROP_RUNS: "9", CODING_SH_PROP_SEED: "1", NODE_TEST_CONTEXT: "child-v8" }, { CODING_SH_PROP_RUNS: "5" });
    assert.deepEqual(env, { PATH: "x", CODING_SH_PROP_RUNS: "5" });
  });

  it("writes times in seconds, and in minutes past one", () => {
    assert.equal(formatTime(1234), "1.2 s");
    assert.equal(formatTime(59_940), "59.9 s");
    assert.equal(formatTime(59_960), "1 min 0 s");
    assert.equal(formatTime(245_400), "4 min 5 s");
  });

  it("runs each file in its own process, prints the seed first, and writes the summary, the seed and each file's output", () => {
    const seen = `import { test } from "node:test"; import assert from "node:assert/strict";
test("gets the knobs set in the environment", () => {
  assert.equal(process.env.CODING_SH_MODEL_BOUND, undefined);
  assert.equal(process.env.CODING_SH_PROP_RUNS, "3");
  assert.equal(process.env.CODING_SH_PROP_SEED, "42");
  assert.equal(process.env.NODE_TEST_CONTEXT, undefined);
});`;
    const fails = `import { test } from "node:test"; test("always fails", () => { throw new Error("a broken invariant"); });`;
    const r = runScript({ "knobs-seen.test.ts": seen, "always-fails.test.ts": fails }, { CODING_SH_MODEL_BOUND: "", CODING_SH_PROP_RUNS: "3", CODING_SH_PROP_SEED: "42" });
    assert.equal(r.code, 1, r.all);
    assert.match(r.stdout.split("\n")[0] ?? "", /^seed 42 \(from CODING_SH_PROP_SEED\)/);
    assert.equal(r.seed, "42\n");
    assert.match(r.summary, /^## Verify past the default bounds\n/);
    assert.match(r.summary, /Seed 42, from CODING_SH_PROP_SEED\. Set in the environment: `CODING_SH_PROP_RUNS=3`, `CODING_SH_PROP_SEED=42`\./);
    assert.match(r.summary, /\| knobs-seen \| `CODING_SH_PROP_RUNS=3` `CODING_SH_PROP_SEED=42` \| pass \| \d+\.\d s \|/);
    assert.match(r.summary, /\| always-fails \| .* \| fail \| /);
    assert.match(r.summary, /1 passed, 1 failed, in /);
    assert.match(r.summary, /CODING_SH_PROP_RUNS=3 CODING_SH_PROP_SEED=42 node --no-warnings --test .*always-fails\.test\.ts/);
    assert.doesNotMatch(r.summary, /--test .*knobs-seen/);
    assert.equal(r.step, `earlier step\n${r.summary}`);
    assert.deepEqual(Object.keys(r.logs).sort(), ["always-fails.log", "knobs-seen.log"]);
    assert.match(r.logs["always-fails.log"] ?? "", /a broken invariant/);
    assert.match(r.logs["knobs-seen.log"] ?? "", /gets the knobs set in the environment/);
  });

  it("stops a file past its time limit and counts it as failed", () => {
    const hangs = `import { test } from "node:test"; test("never ends", () => new Promise(() => setInterval(() => {}, 1000)));`;
    const passes = `import { test } from "node:test"; test("passes", () => {});`;
    const r = runScript({ "never-ends.test.ts": hangs }, {}, ["--minutes", "0.03"]);
    assert.equal(r.code, 1, r.all);
    assert.match(r.summary, /\| never-ends \| `CODING_SH_PROP_SEED=\d+` \| timed out \| /);
    assert.equal(runScript({ "passes.test.ts": passes }, {}).code, 0);
  });

  it("refuses a time limit that is not a number above 0 and at most 35791 minutes, before any file runs", () => {
    for (const minutes of ["0", "abc", "Infinity", "35791.2", "35792", "40000"]) {
      const r = spawnSync(process.execPath, ["--no-warnings", SCRIPT, `--minutes=${minutes}`, "model"], { cwd: PKG, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 2, `${minutes}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^verify:deep: --minutes must be a number above 0 and at most 35791/, minutes);
      assert.doesNotMatch(r.stdout, /^seed /m, minutes);
    }
  });

  it("takes a time limit of 35791 minutes, the most its timer can wait", () => {
    // A timer past 2^31 - 1 ms fires at once, which would stop the file as timed out.
    const passes = `import { test } from "node:test"; test("passes", () => {});`;
    const r = runScript({ "passes.test.ts": passes }, {}, ["--minutes", "35791"]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.summary, /Each file had 35791 minutes\./);
    assert.match(r.summary, /\| passes \| .* \| pass \| /);
  });

  it("writes the summary and the step summary again after each file, after what the step summary held before", () => {
    // The second file runs after the first, so it finds the first one's row in both.
    const first = `import { test } from "node:test"; test("passes", () => {});`;
    const second = `import { test } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import { dirname, join } from "node:path";
test("finds the first file in both summaries", () => {
  const step = readFileSync(process.env.GITHUB_STEP_SUMMARY ?? "", "utf8");
  assert.match(step, /^earlier step\\n## Verify past the default bounds\\n/);
  assert.match(step, /\\| first-file \\| .* \\| pass \\| /);
  assert.match(step, /1 passed, 0 failed, in .*\\. Not run yet: second-file\\.\\n/);
  assert.equal(step, "earlier step\\n" + readFileSync(join(dirname(process.env.GITHUB_STEP_SUMMARY ?? ""), "out", "summary.md"), "utf8"));
});`;
    const r = runScript({ "first-file.test.ts": first, "second-file.test.ts": second }, {});
    assert.equal(r.code, 0, r.all);
    assert.match(r.summary, /2 passed, 0 failed, in /);
    assert.doesNotMatch(r.summary, /Not run yet/);
    assert.equal(r.step, `earlier step\n${r.summary}`);
  });

  it("counts a failed file that ran out of heap as out of memory, and a passing file that prints those words as a pass", () => {
    const line = JSON.stringify("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
    const crashes = `import { test } from "node:test"; test("crashes", () => { console.error(${line}); throw new Error("stopped"); });`;
    const prints = `import { test } from "node:test"; test("prints", () => { console.log(${line}); });`;
    const r = runScript({ "heap-crash.test.ts": crashes, "heap-words.test.ts": prints }, {});
    assert.equal(r.code, 1, r.all);
    assert.match(r.summary, /\| heap-crash \| .* \| out of memory \| /);
    assert.match(r.summary, /\| heap-words \| .* \| pass \| /);
  });
});
