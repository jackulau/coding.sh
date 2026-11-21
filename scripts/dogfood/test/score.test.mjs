import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentVersions, compare, gateTestEnv, headline, normalized, passedAlone, testsGate, WEIGHTS } from "../score.mjs";
import { meets } from "../bench.mjs";
import { parseTapSummary } from "../conformance.mjs";
import { bootstrapMedianDiff, nearestRank, quantile, wilson } from "../lib/util.mjs";

const gatesOk = { typecheck: true, tests: true, build: true, siteBuild: true };

test("weights sum to 100", () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test("headline is null with gated list when a gate fails", () => {
  const h = headline({ ...gatesOk, tests: false }, { "cli.guidelines": { value: 1 } });
  assert.equal(h.headline, null);
  assert.deepEqual(h.gated, ["tests"]);
});

test("headline is 100 when every component is perfect", () => {
  const c = {
    "cli.heldout.success": { value: 1 },
    "cli.invalidRate": { value: 0 },
    "cli.guidelines": { value: 1 },
    "replay.success": { value: 1 },
    "conformance.fixtures": { value: 1 },
    "conformance.smoke": { value: 1 },
    "capture.health": { value: 1 },
    "perf.hook": { value: 5, met: true },
    "site.js": { value: 1, met: true },
    "site.council": { value: 2 },
  };
  const h = headline(gatesOk, c);
  assert.equal(h.headline, 100);
  assert.equal(h.coverage, 1);
});

test("normalization follows the doc table and rescales missing weight", () => {
  const n = normalized({ "cli.invalidRate": { value: 0.1 }, "perf.hook": { met: true }, "perf.help": { met: false }, "site.js": { met: true }, "site.council": { value: 0 } });
  assert.equal(n["cli.invalidRate"], 0.5);
  assert.equal(n.perf, 0.5);
  assert.equal(n.site, 0.6 * 1 + 0.4 * 0.5);
  const h = headline(gatesOk, { "cli.guidelines": { value: 0.5 }, "perf.hook": { met: true } });
  // guidelines 10 × 0.5 + perf 10 × 1 over 20 weight
  assert.equal(h.headline, 75);
  assert.equal(h.coverage, 0.2);
  assert.ok(h.missing.includes("cli.heldout.success"));
});

test("compare is direction-aware", () => {
  const r = compare({ headline: 1, components: { "perf.hook": { value: 8 }, "cli.guidelines": { value: 0.9 } } }, { headline: 1, components: { "perf.hook": { value: 9 }, "cli.guidelines": { value: 1 } } });
  assert.equal(r.components["perf.hook"].direction, "better");
  assert.equal(r.components["cli.guidelines"].direction, "worse");
});

test("compare reads lower-is-better from every perf ceiling, LCP and the dev - heldout gap", () => {
  const prev = { "site.vitals": 1200, "cli.gap": 5, "perf.hookSh": 3, "perf.collectorP95": 90, "perf.ingest": 5000, "perf.collectorSpans": 5000 };
  const cur = { "site.vitals": 1500, "cli.gap": 12, "perf.hookSh": 4, "perf.collectorP95": 70, "perf.ingest": 5200, "perf.collectorSpans": 4800 };
  const wrap = (o) => ({ headline: 1, components: Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value }])) });
  const r = compare(wrap(cur), wrap(prev)).components;
  assert.equal(r["site.vitals"].direction, "worse");
  assert.equal(r["cli.gap"].direction, "worse");
  assert.equal(r["perf.hookSh"].direction, "worse");
  assert.equal(r["perf.collectorP95"].direction, "better");
  assert.equal(r["perf.ingest"].direction, "better");
  assert.equal(r["perf.collectorSpans"].direction, "worse");
});

test("perf budgets", () => {
  assert.equal(meets("perf.hook", 10), true);
  assert.equal(meets("perf.hook", 10.1), false);
  assert.equal(meets("perf.ingest", 5000), true);
  assert.equal(meets("perf.ingest", 4999), false);
  assert.equal(meets("perf.storeSize", 2.5), false);
  assert.equal(meets("perf.viewerTti", null), undefined);
  // CI's tolerance: the desk runner's 10.7 ms and 3.18 ms pass at 20%, a real regression does not.
  assert.equal(meets("perf.hook", 10.7, 20), true);
  assert.equal(meets("perf.hookSh", 3.18, 20), true);
  assert.equal(meets("perf.hook", 12.1, 20), false);
  assert.equal(meets("perf.ingest", 4100, 20), true);
  assert.equal(meets("perf.ingest", 3900, 20), false);
});

test("TAP summary parsing", () => {
  assert.deepEqual(parseTapSummary("# tests 150\n# suites 53\n# pass 149\n# fail 1\n# skipped 0\n"), { tests: 150, pass: 149, fail: 1, skipped: 0, todo: undefined, cancelled: undefined });
});

test("stats helpers", () => {
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(nearestRank([1, 2, 3, 4], 50), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo > 0.2 && lo < 0.25 && hi > 0.75 && hi < 0.8);
  const d = bootstrapMedianDiff([10, 11, 12, 10, 11, 12, 10, 11], [20, 21, 22, 20, 21, 22, 20, 21]);
  assert.equal(d.diff, 10);
  assert.ok(d.ci[0] > 8 && d.ci[1] < 12);
});

test("agentVersions never starts a CLI named in CODING_SH_DOGFOOD_SKIP_AGENTS", () => {
  const started = [];
  const run = (cmd) => (started.push(cmd), { code: 0, stdout: `${cmd} 1.2.3\n` });
  assert.deepEqual(agentVersions({ CODING_SH_DOGFOOD_SKIP_AGENTS: " codex " }, run), { "claude-code": "1.2.3", codex: null });
  assert.deepEqual(started, ["claude"]);
  started.length = 0;
  assert.deepEqual(agentVersions({}, run), { "claude-code": "1.2.3", codex: "1.2.3" });
  assert.deepEqual(started, ["claude", "codex"]);
});

test("the tests gate isolates USERPROFILE and the agent homes, not only HOME", () => {
  const env = gateTestEnv({ PATH: "/bin", USERPROFILE: "/real", HOME: "/real", CODING_SH_DEV_REAL_STORE: "1", CODING_SH_STORE_URL: "x" }, "/t");
  assert.equal(env.PATH, "/bin");
  for (const k of ["HOME", "USERPROFILE"]) assert.equal(env[k], join("/t", "home"));
  for (const k of ["CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) assert.ok(env[k].startsWith(env.HOME), k);
  // Chrome on Windows starts with remote debugging only when LOCALAPPDATA is inside USERPROFILE.
  assert.equal(env.LOCALAPPDATA, join("/t", "home", "AppData", "Local"));
  assert.equal(env.CODING_SH_NO_AUTO_INGEST, "1");
  assert.equal(env.CODING_SH_DEV_REAL_STORE, undefined);
  assert.equal(env.CODING_SH_STORE_URL, undefined);
  // test-ci.mjs would run one shard, or only the files a diff reaches.
  const ci = gateTestEnv({ SHARD: "1/6", TEST_SELECT: "origin/main", TEST_DURATIONS_OUT: "/d.json" }, "/t");
  for (const k of ["SHARD", "TEST_SELECT", "TEST_DURATIONS_OUT"]) assert.equal(ci[k], undefined, k);
});

test("the tests gate passes a test file that fails in the full run and passes alone, and names it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "score-tests-gate-"));
  try {
    mkdirSync(join(dir, "test"));
    // Fails the first time it runs, as a timing test can on a busy machine.
    writeFileSync(join(dir, "test", "a.test.ts"), `import { it } from "node:test"; import { existsSync, writeFileSync } from "node:fs";
it("fails the first time only", () => { if (!existsSync(process.env.FLAKE_FLAG)) { writeFileSync(process.env.FLAKE_FLAG, "1"); throw new Error("under load"); } });\n`);
    writeFileSync(join(dir, "test", "b.test.ts"), `import { it } from "node:test"; it("passes", () => {});\n`);
    const env = { ...gateTestEnv(process.env, dir), FLAKE_FLAG: join(dir, "flag") };
    delete env.NODE_TEST_CONTEXT; // else the runs inside report to this test run
    const g = await testsGate(env, dir);
    assert.equal(g.ok, true, g.tail);
    assert.deepEqual(g.passedAlone, [join("test", "a.test.ts")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passedAlone reads test-ci.mjs's warning once per file, and nothing from a plain failure", () => {
  const warn = "::warning title=Passed when run alone::test/cli/usage.test.ts failed in the full run and passed alone (a timing test under load?)";
  assert.deepEqual(passedAlone(`Rerunning test/cli/usage.test.ts alone\n${warn}\n${warn}\n`), ["test/cli/usage.test.ts"]);
  assert.deepEqual(passedAlone("✖ over 100,000 events it answers in under 2 s (17231.74ms)\n✖ failing tests:\n"), []);
});
