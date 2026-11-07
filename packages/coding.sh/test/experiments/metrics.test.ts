// Metric experiments (XR-4): interleaved pairs over commands that print numbers,
// the per-metric statistics and verdicts, and `coding.sh exp metrics` itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeMetrics,
  flattenMetrics,
  MetricRunError,
  metricMatches,
  metricUnit,
  pairOrder,
  renderMetrics,
  runMetrics,
  type MetricArm,
  type MetricRun,
} from "../../src/experiments/metrics.ts";
import { mulberry32 } from "../../src/stats/prng.ts";
import { pairedBootstrapMedian, signTest } from "../../src/stats/index.ts";

/** Standard normal draws from a seeded uniform (Box–Muller). */
function normal(rand: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

const fnArm = (name: string, fn: (input: unknown) => unknown): MetricArm => ({ name, task: { kind: "function", name, fn } });

describe("metric parsing", () => {
  it("flattens nested numbers into dotted names and skips everything else", () => {
    assert.deepEqual(flattenMetrics({ mobile: { home: { lcp_ms: 2310, ok: true, url: "/" } }, js_bytes: 120, list: [1, 2], nan: null }), {
      "mobile.home.lcp_ms": 2310,
      js_bytes: 120,
    });
    assert.throws(() => flattenMetrics([1, 2]), /JSON object of numbers/);
    assert.throws(() => flattenMetrics("fast"), /JSON object of numbers/);
  });

  it("matches * wildcards and reads units from suffixes", () => {
    assert.ok(metricMatches("mobile.home.score", ["*.score"]));
    assert.ok(metricMatches("score", ["score"]));
    assert.ok(!metricMatches("mobile.home.score", ["score"]));
    assert.ok(!metricMatches("mobileXhome", ["mobile.home"]), "a dot is literal");
    assert.equal(metricUnit("mobile.home.lcp_ms"), "ms");
    assert.equal(metricUnit("js_bytes"), "bytes");
    assert.equal(metricUnit("cls"), "count");
    assert.equal(metricUnit("items"), "count");
  });

  it("balances arm order across pairs and repeats it for a seed", () => {
    const o = pairOrder(11, 7);
    assert.equal(o.length, 11);
    assert.equal(o.filter((x) => x === "AB").length, 6);
    assert.equal(o.filter((x) => x === "BA").length, 5);
    assert.deepEqual(pairOrder(11, 7), o);
    assert.notDeepEqual(pairOrder(11, 8), o);
  });
});

describe("stats for metrics", () => {
  it("bootstraps the median paired delta", () => {
    const r = pairedBootstrapMedian([5, 1, 3, 2, 4], { iters: 2000 });
    assert.equal(r.median, 3);
    assert.equal(r.mean, 3);
    assert.ok(r.lo >= 1 && r.lo <= 3 && r.hi >= 3 && r.hi <= 5, `[${r.lo}, ${r.hi}]`);
    assert.ok(Number.isNaN(pairedBootstrapMedian([]).median));
  });

  it("sign test: exact p, ties left out", () => {
    const all = signTest(Array.from({ length: 11 }, () => -1));
    assert.deepEqual({ pos: all.pos, neg: all.neg, ties: all.ties }, { pos: 0, neg: 11, ties: 0 });
    assert.ok(Math.abs(all.p - 2 / 2048) < 1e-12);
    assert.equal(signTest([0, 0, 0]).p, 1);
    assert.ok(Math.abs(signTest([1, 1, 1, 1, 1, 1, 1, 1, 1, -1, 0]).p - (2 * 11) / 1024) < 1e-12, "9 vs 1, one tie: n = 10");
  });
});

describe("runMetrics", () => {
  it("runs pairs back to back in the recorded order and passes the arm on stdin", async () => {
    const calls: string[] = [];
    const arm = (name: string) => fnArm(name, (i) => (calls.push(`${(i as { arm: string }).arm}:${(i as { pair: number }).pair}`), { t_ms: 1 }));
    const r = await runMetrics({ arms: [arm("base"), arm("cand")], pairs: 6, warmup: 1, seed: 3, iters: 200 });
    assert.equal(calls.length, 14);
    assert.deepEqual(calls.slice(0, 2), ["base:0", "cand:0"], "warm-up round first");
    for (let p = 1; p <= 6; p++) {
      const pair = calls.slice(2 * p, 2 * p + 2);
      assert.deepEqual(pair.map((x) => x.split(":")[1]), [String(p), String(p)], "a pair's runs are adjacent");
      const first = r.order[p - 1] === "AB" ? "base" : "cand";
      assert.equal(pair[0]!.split(":")[0], first);
    }
    assert.equal(r.summary.pairsComplete, 6);
    assert.equal(r.runs.filter((x) => x.warmup).length, 2);
    assert.equal(r.seed, 3);
  });

  it("calls a consistent shift better (lower is better) and a fixed byte change worse", async () => {
    const rand = normal(mulberry32(11));
    const r = await runMetrics({
      arms: [fnArm("a", () => ({ lcp_ms: 2000 + 30 * rand(), js_bytes: 50_000 })), fnArm("b", () => ({ lcp_ms: 1700 + 30 * rand(), js_bytes: 51_200 }))],
      pairs: 11,
      seed: 1,
    });
    const lcp = r.metrics.find((m) => m.name === "lcp_ms")!;
    assert.equal(lcp.verdict, "better");
    assert.ok(lcp.delta.median < -200 && lcp.delta.hi < 0, JSON.stringify(lcp.delta));
    assert.ok(lcp.pAdjusted < 0.05);
    const js = r.metrics.find((m) => m.name === "js_bytes")!;
    assert.equal(js.deterministic, true);
    assert.equal(js.delta.median, 1200);
    assert.equal(js.verdict, "worse");
    assert.deepEqual([r.summary.better, r.summary.worse, r.summary.inconclusive], [1, 1, 0]);
    const text = renderMetrics(r, { color: false });
    assert.match(text, /lcp_ms .* better/);
    assert.match(text, /js_bytes .*fixed.* worse/);
  });

  it("--higher flips the direction", async () => {
    const r = await runMetrics({
      arms: [fnArm("a", () => ({ score: 70 })), fnArm("b", () => ({ score: 80 }))],
      pairs: 5,
      seed: 1,
      higher: ["score"],
      iters: 200,
    });
    assert.equal(r.metrics[0]!.better, "higher");
    assert.equal(r.metrics[0]!.verdict, "better");
  });

  it("keeps an A/A run quiet across many noisy metrics (Holm over the sign tests)", () => {
    // 300 simulated A/A experiments, 11 pairs, 30 noisy metrics each: the
    // family-wise false positive rate must stay near alpha, not near 1 − 0.95^30.
    const rand = mulberry32(42);
    const z = normal(rand);
    let flagged = 0;
    for (let e = 0; e < 300; e++) {
      const runs: MetricRun[] = [];
      for (let p = 1; p <= 11; p++) {
        for (const arm of [0, 1] as const) {
          const metrics: Record<string, number> = { same_bytes: 4096 };
          for (let k = 0; k < 30; k++) metrics[`m${k}_ms`] = 1000 + 50 * z();
          runs.push({ pair: p, arm, startedAt: 0, durationMs: 0, metrics });
        }
      }
      const r = analyzeMetrics(runs, { iters: 300, seed: e });
      if (r.metrics.some((m) => m.verdict !== "inconclusive")) flagged++;
    }
    assert.ok(flagged / 300 <= 0.06, `A/A flagged a metric in ${flagged}/300 runs`);
    // Without the correction, the same runs flag far more often.
    let raw = 0;
    const rand2 = normal(mulberry32(42));
    for (let e = 0; e < 100; e++) {
      const runs: MetricRun[] = [];
      for (let p = 1; p <= 11; p++) {
        for (const arm of [0, 1] as const) {
          const metrics: Record<string, number> = {};
          for (let k = 0; k < 30; k++) metrics[`m${k}_ms`] = 1000 + 50 * rand2();
          runs.push({ pair: p, arm, startedAt: 0, durationMs: 0, metrics });
        }
      }
      if (analyzeMetrics(runs, { iters: 300, seed: e, correction: "none" }).metrics.some((m) => m.verdict !== "inconclusive")) raw++;
    }
    assert.ok(raw > flagged / 3, `uncorrected ${raw}/100 vs corrected ${flagged}/300`);
  });

  it("stops when an arm's first run fails, and drops later failed pairs", async () => {
    await assert.rejects(
      runMetrics({ arms: [fnArm("a", () => ({ t_ms: 1 })), fnArm("b", () => "not numbers")], pairs: 3, seed: 1, iters: 100 }),
      (e: unknown) => e instanceof MetricRunError && e.arm === "b" && /JSON object of numbers/.test(e.message),
    );
    let n = 0;
    const r = await runMetrics({
      arms: [
        fnArm("a", () => ({ t_ms: 1 })),
        fnArm("b", () => {
          if (++n === 3) throw new Error("boom");
          return { t_ms: 2 };
        }),
      ],
      pairs: 5,
      seed: 1,
      iters: 100,
    });
    assert.equal(r.summary.failedRuns, 1);
    assert.equal(r.summary.pairsComplete, 4);
    assert.equal(r.metrics[0]!.n, 4);
    assert.match(r.notes.join("\n"), /1 run\(s\) failed/);
  });

  it("an interrupt stops new runs and marks the result cancelled", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const arm = (name: string) =>
      fnArm(name, () => {
        if (++calls === 4) ctrl.abort();
        return { t_ms: calls };
      });
    const r = await runMetrics({ arms: [arm("a"), arm("b")], pairs: 10, seed: 1, signal: ctrl.signal, iters: 100 });
    assert.equal(r.status, "cancelled");
    assert.equal(r.runs.length, 3, "the run the abort cut short is not kept");
    assert.match(r.notes[0]!, /cancelled after 1 of 10 pairs/);
  });
});

describe("coding.sh exp metrics", () => {
  const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: root, encoding: "utf8", timeout: 60_000 });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-metrics-cli-")));
    env = {
      HOME: join(root, "home"),
      CODING_SH_HOME: join(root, "home", ".coding.sh"),
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      NO_COLOR: "1",
    };
    // Prints {lcp_ms, js_bytes} shifted by argv[2]; checks its stdin names the arm.
    writeFileSync(
      join(root, "bench.mjs"),
      `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const i = JSON.parse(s); if (!i.arm || !(i.pair >= 0)) process.exit(9);
        const off = Number(process.argv[2] ?? 0);
        console.log(JSON.stringify({ desktop: { lcp_ms: 1000 + off, js_bytes: 40000 + off } }));
      });`,
    );
    writeFileSync(join(root, "cand.json"), JSON.stringify({ kind: "command", command: process.execPath, args: [join(root, "bench.mjs"), "50"] }));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("prints one JSON document with per-metric verdicts", () => {
    const r = cli(["exp", "metrics", "--arm", `base=node bench.mjs`, "--arm", "cand=cand.json", "--pairs", "3", "--seed", "5", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { outcome: string; experiment: { pairs: number; order: string[]; metrics: { name: string; verdict: string; delta: { median: number } }[] } };
    assert.equal(doc.outcome, "completed");
    assert.equal(doc.experiment.pairs, 3);
    assert.equal(doc.experiment.order.length, 3);
    const byName = Object.fromEntries(doc.experiment.metrics.map((m) => [m.name, m]));
    assert.equal(byName["desktop.lcp_ms"]!.delta.median, 50);
    assert.equal(byName["desktop.lcp_ms"]!.verdict, "worse");
    assert.equal(byName["desktop.js_bytes"]!.verdict, "worse");
  });

  it("--fail-on-worse exits 1; an A/A run exits 0 with every metric the same", () => {
    const worse = cli(["exp", "metrics", "--arm", "base=node bench.mjs", "--arm", "cand=node bench.mjs 50", "--pairs", "3", "--fail-on-worse"]);
    assert.equal(worse.status, 1, worse.stderr);
    assert.match(worse.stdout, /desktop\.lcp_ms .* worse/);
    const aa = cli(["exp", "metrics", "--arm", "a=node bench.mjs", "--arm", "b=node bench.mjs", "--pairs", "3", "--fail-on-worse"]);
    assert.equal(aa.status, 0, aa.stderr);
    assert.match(aa.stdout, /0 better · 0 worse · 2 inconclusive/);
  });

  it("usage errors exit 2 and a broken arm exits 1 with the next step", () => {
    const one = cli(["exp", "metrics", "--arm", "a=node bench.mjs"]);
    assert.equal(one.status, 2);
    assert.match(one.stderr, /exactly two --arm/);
    const same = cli(["exp", "metrics", "--arm", "a=node bench.mjs", "--arm", "a=node bench.mjs"]);
    assert.equal(same.status, 2);
    const broken = cli(["exp", "metrics", "--arm", "a=node missing.mjs", "--arm", "b=node bench.mjs", "--pairs", "2", "--json"]);
    assert.equal(broken.status, 1);
    const err = JSON.parse(broken.stderr) as { status: string; reason: string; next: string[] };
    assert.equal(err.status, "error");
    assert.equal(err.reason, "arm_failed");
    assert.equal(err.next.length, 2);
  });
});
