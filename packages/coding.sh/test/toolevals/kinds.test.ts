// TB-12: task kinds in tool evals. Tasks carry an optional kind, arm summaries
// and comparisons split by it, and `validate --against <variant>` checks that a
// bad task fails on the variant it was written against.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compareToolArms, summarizeArm } from "../../src/toolevals/compare.ts";
import { parseTask, ToolEvalsConfigError } from "../../src/toolevals/config.ts";
import { formatArms, formatToolCompare } from "../../src/toolevals/report.ts";
import { againstRows, agentFacingFields, referenceAgainst, validateToolTask } from "../../src/toolevals/validate.ts";
import { checkAgainst } from "../../src/datasets/kinds.ts";
import type { CaseKind } from "../../src/datasets/types.ts";
import type { ToolTask, TrialResult } from "../../src/toolevals/types.ts";
import { cleanup, cliTarget, task, tmp, trial } from "./helpers.ts";

after(cleanup);

const D = "model:anthropic/fake";
const kinded = (t: TrialResult, kind: CaseKind): TrialResult => ({ ...t, kind });

describe("task kinds", () => {
  it("parseTask reads kind and rejects an unknown one", () => {
    assert.equal(parseTask({ id: "a", instruction: "do it", target: "fake", kind: "control" }, "t.toml").kind, "control");
    assert.equal("kind" in parseTask({ id: "a", instruction: "do it", target: "fake" }, "t.toml"), false);
    assert.throws(() => parseTask({ id: "a", instruction: "do it", target: "fake", kind: "regression" }, "t.toml"), (e: Error) => e instanceof ToolEvalsConfigError && /task a has kind "regression"; use bad, guard or control/.test(e.message));
  });

  it("summarizeArm splits pass rates by kind, and leaves them out without kinds", () => {
    const ts = [kinded(trial("b1", "base", D, 1, false), "bad"), kinded(trial("b2", "base", D, 1, true), "bad"), kinded(trial("c1", "base", D, 1, true), "control"), trial("p", "base", D, 1, true)];
    const s = summarizeArm(ts, `base@${D}`);
    assert.equal(s.kinds!.bad!.passed, 1);
    assert.equal(s.kinds!.bad!.n, 2);
    assert.equal(s.kinds!.control!.passed, 1);
    assert.equal(s.kinds!.guard, undefined);
    assert.match(formatArms([s]), /base@model:anthropic\/fake: bad 50\.0% \(1\/2\) · control 100\.0% \(1\/1\)/);
    assert.equal("kinds" in summarizeArm([trial("p", "base", D, 1, true)], `base@${D}`), false);
  });

  it("compare names an overcorrecting control in the verdict, the notes and the table", () => {
    const ts: TrialResult[] = [];
    // Old text: the two bad tasks fail; the guard and the controls pass. New text: bad fixed, one control broken.
    const plan: [string, CaseKind | undefined, boolean, boolean][] = [
      ["bad-1", "bad", false, true],
      ["bad-2", "bad", false, true],
      ["guard-1", "guard", true, true],
      ["ctl-1", "control", true, false],
      ["ctl-2", "control", true, true],
      ["plain", undefined, true, true],
    ];
    for (const [id, kind, old, fixed] of plan) {
      for (let a = 1; a <= 2; a++) {
        const x = trial(id, "old", D, a, old);
        const y = trial(id, "new", D, a, fixed);
        ts.push(kind ? kinded(x, kind) : x, kind ? kinded(y, kind) : y);
      }
    }
    const r = compareToolArms(ts, { baseline: `old@${D}`, candidate: `new@${D}`, iters: 500 });
    assert.deepEqual(r.kinds!.overcorrections, ["ctl-1"]);
    assert.deepEqual(r.kinds!.kinds.find((k) => k.kind === "bad")!.fixed, ["bad-1", "bad-2"]);
    assert.match(r.verdict.text, /; but 1 control task\(s\) broke \(overcorrection\)$/);
    assert.ok(r.notes.includes("overcorrection: 1 control case(s) passed on A and fail on B: ctl-1"), r.notes.join("\n"));
    const text = formatToolCompare(r);
    assert.match(text, /^bad tasks +0\.0% +100\.0% +2\/2 fixed$/m);
    assert.match(text, /^control tasks +100\.0% +50\.0% +1\/2 broke$/m);
    assert.match(text, /^guard tasks +100\.0% +100\.0% +0\/1 broke$/m);
  });

  it("compare has no kinds section when no task has a kind", () => {
    const ts = [trial("a", "old", D, 1, true), trial("a", "new", D, 1, true)];
    const r = compareToolArms(ts, { baseline: `old@${D}`, candidate: `new@${D}`, iters: 100 });
    assert.equal("kinds" in r, false);
    assert.doesNotMatch(formatToolCompare(r), /tasks {2}/);
  });
});

describe("validate --against", () => {
  // The old build of fake-cli has the bug the bad task was written for: it misspells the greeting (and has no --json).
  const dir = tmp("csh-te-kinds-");
  const OLD_CLI = join(dir, "old-cli.mjs");
  writeFileSync(OLD_CLI, `const a = process.argv.slice(2);\nif (a.includes("--json")) { process.stderr.write("error: unknown option --json\\n"); process.exit(1); }\nif (a[0] === "greet") { const i = a.indexOf("--name"); process.stdout.write("hullo " + (i >= 0 ? a[i + 1] : "world") + "\\n"); }\nelse if (a[0] === "sum") process.stdout.write(String(a.slice(1).reduce((s, x) => s + Number(x), 0)) + "\\n");\nelse process.exit(2);\n`);
  const target = cliTarget();
  const old = { name: "old", command: [process.execPath, OLD_CLI] };
  const bad = (over: Partial<ToolTask> = {}) => ({ ...task({ id: "greet-bob", reference: ["fake-cli greet --name bob"], checks: [{ kind: "output", contains: ["hello bob"] }] }), kind: "bad" as const, ...over });
  const guard = { ...task({ id: "sum", instruction: "Add 1 and 2 with fake-cli.", reference: ["fake-cli sum 1 2"], checks: [{ kind: "output", contains: ["3"] }] }), kind: "guard" as const };
  const leaky = { ...task({ id: "sum-bad", instruction: "Add 2 and 2 with fake-cli.", reference: ["fake-cli sum 2 2"], checks: [{ kind: "output", contains: ["4"] }] }), kind: "bad" as const };

  it("a bad task fails on the old build; a guard passes there; a bad task that passes on the old build is reported", async () => {
    const rows = [];
    for (const t of [bad(), guard, leaky]) rows.push(await referenceAgainst(t, target, { root: join(dir, "trials"), variant: old }));
    assert.deepEqual(
      rows.map((r) => [r.caseId, r.passes, r.trials]),
      [
        ["greet-bob", 0, 1],
        ["sum", 1, 1],
        ["sum-bad", 1, 1],
      ],
    );
    const report = checkAgainst(rows, "old");
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.cases.filter((c) => !c.ok).map((c) => c.caseId),
      ["sum-bad"],
    );
    assert.match(report.cases[2]!.problem!, /^bad case passes on old \(1\/1\): it doesn't reproduce the failure it was written for$/);
    // On the fixed build the same bad task passes its ordinary validation.
    const v = await validateToolTask(bad(), target, { root: join(dir, "trials") });
    assert.equal(v.reference?.pass, true, JSON.stringify(v));
  });

  it("a reference command that exits non-zero on the old build is a failing trial, a broken setup is an error", async () => {
    const failing = bad({ id: "greet-json", reference: ["fake-cli greet --json --name bob"] });
    const r = await referenceAgainst(failing, target, { root: join(dir, "trials"), variant: old });
    assert.deepEqual([r.passes, r.trials, r.error], [0, 1, undefined]);
    const broken = bad({ id: "broken", setup: { commands: ["exit 3"], files: {}, env: {} } });
    const e = await referenceAgainst(broken, target, { root: join(dir, "trials"), variant: old });
    assert.equal(e.trials, 0);
    assert.ok(e.error, "setup failure is an error");
    const none = await referenceAgainst(bad({ id: "none", reference: undefined }), target, { root: join(dir, "trials"), variant: old });
    assert.equal(none.error, "no reference commands to run");
  });

  it("agentFacingFields names what only an agent reads; againstRows leaves errored trials out", () => {
    assert.deepEqual(agentFacingFields({ name: "old", command: ["x"], env: { A: "1" } }), []);
    assert.deepEqual(agentFacingFields({ name: "old", descriptions: { greet: "x" }, bundle: "b" }), ["descriptions", "bundle"]);
    const t = bad();
    const rows = againstRows([t, { ...guard }], [trial("greet-bob", "old", D, 1, true), { ...trial("greet-bob", "old", D, 2, false), error: "rate limited" }, { ...trial("sum", "old", D, 1, false), error: "boom" }]);
    assert.deepEqual(rows, [
      { caseId: "greet-bob", kind: "bad", passes: 1, trials: 1 },
      { caseId: "sum", kind: "guard", passes: 0, trials: 0, error: "boom" },
    ]);
  });
});
