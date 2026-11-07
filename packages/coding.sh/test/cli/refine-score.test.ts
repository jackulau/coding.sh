// `coding.sh refine score` with a temp HOME: prediction files, repeat
// agreement, --json, exit codes, and the flag mode on a temp store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSession } from "../../src/core/sessions.ts";
import { claimSession } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-score-")));
after(() => rmSync(root, { recursive: true, force: true }));

const line = (sessionId: string, signalId: string, name: string, typeIds: string[], type = "tool") => JSON.stringify({ sessionId, signalId, component: { type, name }, typeIds });
const LABELS = [line("s1", "edit-miss", "Edit", ["tool.invalid-args"]), line("s2", "edit-miss", "Edit", ["tool.invalid-args"]), line("s3", "claim", "main", ["out.false-success"], "agent"), JSON.stringify({ sessionId: "s4" })].join("\n");

function setup(name: string) {
  const home = join(root, name, "home");
  const dir = join(root, name, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  const write = (f: string, text: string) => writeFileSync(join(dir, f), text);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: dir, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { home, dir, env, write, cli };
}

describe("cli refine score", () => {
  it("scores prediction files, every number with its n, and adds repeat agreement for 2+ files", () => {
    const e = setup("pred");
    e.write("labels.jsonl", LABELS);
    // run 1: finds both Edit misses (name in another case), a false alarm in s4, one prediction in an unlabelled session; misses the claim.
    e.write("run1.jsonl", [line("s1", "p", "edit", ["tool.contract-mismatch", "tool.invalid-args"]), line("s2", "p", "EDIT", ["tool.invalid-args"]), line("s4", "q", "Bash", ["eff.retry-thrash"]), line("zz", "q", "Bash", ["eff.retry-thrash"])].join("\n"));
    e.write("run2.jsonl", [line("s1", "p", "Edit", ["tool.invalid-args"]), line("s3", "c", "main", ["out.incomplete-result", "out.false-success"], "agent")].join("\n"));
    const t = e.cli("refine", "score", "labels.jsonl", "--pred", "run1.jsonl", "--pred", "run2.jsonl");
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^Labels: labels\.jsonl, 3 occurrences in 2 Signals over 4 sessions$/m);
    assert.match(t.stdout, /^run1\.jsonl \(3 predictions; 1 in unlabelled sessions left out\)$/m);
    assert.match(t.stdout, /^ {2}occurrences P 66\.7% \(2\/3\) {2}R 66\.7% \(2\/3\) {2}F1 66\.7%$/m);
    assert.match(t.stdout, /^ {2}signals {5}P 50\.0% \(1\/2\) {2}R 50\.0% \(1\/2\) {2}F1 50\.0%$/m);
    assert.match(t.stdout, /^ {2}coverage {4}>=1 matched 50\.0% \(1\/2\) {2}>=half matched 50\.0% \(1\/2\) of labelled Signals$/m);
    assert.match(t.stdout, /^ {2}recall {6}out 0\.0% \(0\/1\), tool 100\.0% \(2\/2\)$/m);
    assert.match(t.stdout, /^run2\.jsonl \(2 predictions\)$/m);
    assert.match(t.stdout, /^ {2}occurrences P 100\.0% \(2\/2\) {2}R 66\.7% \(2\/3\) {2}F1 80\.0%$/m);
    // presence: run1 says s1 s2 s4, run2 says s1 s3 -> agree on s1 only of s1..s4.
    assert.match(t.stdout, /^repeat agreement 25\.0% \(2 runs, 1 pair, 4 sessions\)$/m);
    assert.doesNotMatch(t.stdout, /flag /);

    const j = e.cli("refine", "score", "labels.jsonl", "--pred", "run2.jsonl", "--pred", "run1.jsonl", "--json");
    assert.equal(j.status, 0, j.stderr);
    const d = JSON.parse(j.stdout);
    assert.equal(d.mode, "pred");
    assert.deepEqual(d.labels, { file: "labels.jsonl", occurrences: 3, signals: 2, sessions: 4 });
    assert.deepEqual(d.runs.map((r: { source: string }) => r.source), ["run2.jsonl", "run1.jsonl"]);
    assert.deepEqual(d.runs[1].occurrences, { tp: 2, fp: 1, fn: 1, precision: 2 / 3, recall: 2 / 3, f1: 2 / 3 });
    assert.equal(d.runs[1].ignored, 1);
    assert.deepEqual(d.runs[1].byFamily, { out: { n: 1, tp: 0, recall: 0 }, tool: { n: 2, tp: 2, recall: 1 } });
    assert.deepEqual(d.agreement, { agreement: 0.25, runs: 2, pairs: 1, sessions: 4 });
    assert.equal(d.runs[0].byFlag, undefined);

    // An empty prediction file: precision has nothing to divide by.
    e.write("empty.jsonl", "");
    const z = JSON.parse(e.cli("refine", "score", "labels.jsonl", "--pred", "empty.jsonl", "--json").stdout);
    assert.equal(z.runs[0].occurrences.precision, null);
    assert.deepEqual(z.runs[0].occurrences.empty, ["precision"]);
    assert.equal(z.agreement, undefined);
    assert.match(e.cli("refine", "score", "labels.jsonl", "--pred", "empty.jsonl").stdout, /occurrences P — \(0\/0\) {2}R 0\.0% \(0\/3\)/);
    assert.deepEqual(readdirSync(e.home), [], "writes nothing");
  });

  it("exits 1 with line numbers on bad labels, 1 on a missing file, 2 without a labels file", () => {
    const e = setup("bad");
    e.write("labels.jsonl", `${LABELS}\n${line("s5", "x", "Edit", ["tool.invalid-arg"])}\n`);
    const bad = e.cli("refine", "score", "labels.jsonl", "--pred", "labels.jsonl");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /labels\.jsonl:5: unknown type id "tool\.invalid-arg"/);
    assert.match(bad.stderr, /1 problem in labels labels\.jsonl/);
    const badJson = e.cli("refine", "score", "labels.jsonl", "--json");
    assert.equal(badJson.status, 1);
    assert.match(badJson.stdout + badJson.stderr, /invalid_file/);

    e.write("ok.jsonl", LABELS);
    e.write("pred.jsonl", '{"sessionId": "s1", "signalId": "p", "component": {"type": "tool"}, "typeIds": ["tool.invalid-args"]}\n');
    const badPred = e.cli("refine", "score", "ok.jsonl", "--pred", "pred.jsonl");
    assert.equal(badPred.status, 1);
    assert.match(badPred.stderr, /pred\.jsonl:1: component\.name must be a non-empty string/);
    assert.equal(e.cli("refine", "score", "nope.jsonl", "--pred", "ok.jsonl").status, 1);
    assert.equal(e.cli("refine", "score").status, 2);
  });

  it("without --pred scores the labelled sessions' flags from the store, with per-flag precision", async () => {
    const e = setup("flags");
    const { openContext } = await import("../../src/core/context.ts");
    const ctx = await openContext({ env: e.env, cwd: e.dir });
    try {
      const put = async (id: string, flags: string[]) => {
        const events = claimSession(id, { cwd: "/work/demo", startedAt: Date.UTC(2026, 9, 1) });
        await ctx.index.putEvents(events);
        await ctx.index.upsertSession({ ...buildSession(events), flags });
      };
      await put("s1", ["repeated-tool-failure"]);
      await put("s2", []);
      await put("s3", ["premature-completion", "compaction"]);
      await put("s4", ["premature-completion"]);
    } finally {
      await ctx.close();
    }
    e.write("labels.jsonl", `${LABELS}\n${line("s9", "edit-miss", "Edit", ["tool.invalid-args"])}\n`);
    const t = e.cli("refine", "score", "labels.jsonl");
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stderr, /1 labelled session not in the store, left out: s9/);
    assert.match(t.stdout, /^Labels: labels\.jsonl, 3 occurrences in 2 Signals over 4 sessions$/m);
    assert.match(t.stdout, /^flags \(3 predictions\)$/m);
    // s3's premature-completion matches the agent claim through out.false-success; s1's flag and s4's are false alarms.
    assert.match(t.stdout, /^ {2}occurrences P 33\.3% \(1\/3\) {2}R 33\.3% \(1\/3\) {2}F1 33\.3%$/m);
    assert.match(t.stdout, /^ {2}flag {8}premature-completion P 50\.0% \(1\/2\)$/m);
    assert.match(t.stdout, /^ {2}flag {8}repeated-tool-failure P 0\.0% \(0\/1\)$/m);
    assert.match(t.stderr, /Flags name no component/);

    const d = JSON.parse(e.cli("refine", "score", "labels.jsonl", "--json").stdout);
    assert.equal(d.mode, "flags");
    assert.deepEqual(d.missing, ["s9"]);
    assert.deepEqual(d.runs[0].byFlag, [
      { flag: "premature-completion", n: 2, tp: 1, precision: 0.5 },
      { flag: "repeated-tool-failure", n: 1, tp: 0, precision: 0 },
    ]);

    e.write("gone.jsonl", line("x1", "a", "Edit", ["tool.invalid-args"]));
    assert.equal(e.cli("refine", "score", "gone.jsonl").status, 1);
  });
});
