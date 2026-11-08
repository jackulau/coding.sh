import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaseRun } from "../../src/datasets/types.ts";
import { allTrialsPass, casesFor, exactPowerText, normalQuantile, pairedPower, passHatK } from "../../src/experiments/power.ts";

const close = (x: number, y: number, eps = 1e-8) => assert.ok(Math.abs(x - y) < eps, `${x} ≉ ${y}`);
const rep = (v: number, k: number) => Array.from({ length: k }, () => v);
const Z = 1.959963984540054 + 0.8416212335729143; // z.975 + z.8

describe("normalQuantile", () => {
  it("matches reference quantiles in the centre and both tails", () => {
    close(normalQuantile(0.5), 0);
    close(normalQuantile(0.975), 1.959963984540054);
    close(normalQuantile(0.8), 0.8416212335729143);
    close(normalQuantile(0.995), 2.5758293035489);
    close(normalQuantile(0.001), -3.090232306167813);
    close(normalQuantile(1e-6), -4.753424308822899, 1e-7);
    close(normalQuantile(0.3), -normalQuantile(0.7));
    assert.equal(normalQuantile(0), -Infinity);
    assert.equal(normalQuantile(1), Infinity);
    assert.ok(Number.isNaN(normalQuantile(1.5)));
  });
});

describe("pairedPower", () => {
  it("MDE = (z₁₋α/₂ + z_power) · sd(Δ) / √n", () => {
    // 7 improvements, 3 regressions, 10 unchanged.
    const diffs = [...rep(1, 7), ...rep(-1, 3), ...rep(0, 10)];
    const p = pairedPower(diffs);
    close(p.observed, 0.2);
    close(p.sd, Math.sqrt(9.2 / 19));
    close(p.mde, (Z * Math.sqrt(9.2 / 19)) / Math.sqrt(20));
    assert.equal(p.alpha, 0.05);
    assert.equal(p.power, 0.8);
    assert.deepEqual(p.warnings.map((w) => w.code), ["small-n", "below-mde"]);
  });

  it("works on fractional per-case rates (trials > 1)", () => {
    const diffs = [0.5, -0.5, 0, 0, 1, 0.25];
    const m = diffs.reduce((s, x) => s + x, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - m) ** 2, 0) / (diffs.length - 1));
    close(pairedPower(diffs).mde, (Z * sd) / Math.sqrt(diffs.length));
  });

  it("MDE shrinks like 1/√n and grows with stricter alpha or higher power", () => {
    const base = [...rep(1, 3), ...rep(-1, 2), ...rep(0, 15)];
    const big = Array.from({ length: 16 }, () => base).flat();
    const a = pairedPower(base);
    const b = pairedPower(big);
    // Same distribution, 16× the cases: MDE ≈ 1/4 (sample-sd n−1 adds a little).
    close(b.mde / a.mde, 0.25 * (b.sd / a.sd));
    assert.ok(pairedPower(base, { alpha: 0.01 }).mde > a.mde);
    assert.ok(pairedPower(base, { power: 0.9 }).mde > a.mde);
  });

  it("a large suite with a clear effect has no warnings", () => {
    const p = pairedPower([...rep(1, 100), ...rep(0, 150)]);
    assert.ok(p.mde < p.observed);
    assert.deepEqual(p.warnings, []);
  });

  it("flags a small difference even on a large suite", () => {
    const p = pairedPower([...rep(1, 11), ...rep(-1, 9), ...rep(0, 230)]);
    assert.ok(Math.abs(p.observed) < p.mde);
    assert.deepEqual(p.warnings.map((w) => w.code), ["below-mde"]);
    assert.match(p.warnings[0]!.message, /observed \|B − A\| 0\.8pp is below the minimum detectable effect \d+\.\dpp \(α 0\.05, power 80%\)/);
  });

  it("a significant result below the MDE is flagged near-mde, not undetectable", () => {
    // QA: 24 paired cases, 6 regressions, CI [-41.7pp, -8.3pp], McNemar p=0.031, MDE 25.3pp.
    const diffs = [...rep(-1, 6), ...rep(0, 18)];
    const sig = pairedPower(diffs, { significant: true });
    close(sig.mde, (Z * Math.sqrt(4.5 / 23)) / Math.sqrt(24));
    assert.ok(Math.abs(sig.observed) < sig.mde);
    assert.deepEqual(sig.warnings.map((w) => w.code), ["small-n", "near-mde"]);
    const near = sig.warnings[1]!.message;
    assert.match(near, /observed \|B − A\| 25\.0pp is significant but below the minimum detectable effect 25\.3pp/);
    assert.match(near, /magnitude may be overstated/);
    assert.doesNotMatch(near, /cannot reliably detect/);
    // Without significance it is still the null-result warning.
    assert.deepEqual(pairedPower(diffs).warnings.map((w) => w.code), ["small-n", "below-mde"]);
  });

  it("minPaired sets the small-suite threshold", () => {
    const diffs = [...rep(1, 14), ...rep(0, 6)];
    assert.deepEqual(pairedPower(diffs).warnings.map((w) => w.code), ["small-n"]);
    assert.deepEqual(pairedPower(diffs, { minPaired: 20 }).warnings, []);
  });

  it("degenerate inputs: too few cases, no change, no spread", () => {
    for (const diffs of [[], [1]]) {
      const p = pairedPower(diffs);
      assert.ok(Number.isNaN(p.mde));
      assert.deepEqual(p.warnings.map((w) => w.code), ["too-few"]);
    }
    const none = pairedPower(rep(0, 250));
    assert.ok(Number.isNaN(none.mde));
    assert.deepEqual(none.warnings.map((w) => w.code), ["no-change"]);
    // Every case improved: no spread, so no MDE, but nothing to warn about either.
    const all = pairedPower(rep(1, 250));
    assert.ok(Number.isNaN(all.mde));
    assert.deepEqual(all.warnings, []);
  });

  it("rejects alpha or power outside (0, 1)", () => {
    assert.throws(() => pairedPower([0, 1], { alpha: 0 }), RangeError);
    assert.throws(() => pairedPower([0, 1], { power: 1 }), RangeError);
  });
});

describe("A/A noise floor in power planning", () => {
  const noise = { sd: 0.5, flipRate: 0.25, paired: 40 };

  it("the floor replaces a smaller observed SD, and is ignored when the observed one is larger", () => {
    const quiet = [...rep(1, 2), ...rep(0, 248)];
    const p = pairedPower(quiet, { noise });
    close(p.mde, (Z * 0.5) / Math.sqrt(250));
    assert.deepEqual(p.noise, { ...noise, used: true });
    assert.ok(p.mde > pairedPower(quiet).mde);
    const loud = [...rep(1, 125), ...rep(-1, 125)];
    const q = pairedPower(loud, { noise: { ...noise, sd: 0.1 } });
    close(q.mde, pairedPower(loud).mde);
    assert.equal(q.noise?.used, false);
  });

  it("with no change at all the floor still gives an MDE instead of no-change", () => {
    const p = pairedPower(rep(0, 250), { noise });
    close(p.mde, (Z * 0.5) / Math.sqrt(250));
    assert.deepEqual(p.warnings.map((w) => w.code), ["below-mde"]);
  });

  it("casesFor inverts the MDE", () => {
    assert.equal(casesFor(0.1, 0.5), Math.ceil(((Z * 0.5) / 0.1) ** 2));
    assert.equal(casesFor(0.05, 0.5), Math.ceil(((Z * 0.5) / 0.05) ** 2));
    assert.ok(casesFor(0.1, 0.5, { alpha: 0.01 }) > casesFor(0.1, 0.5));
    assert.ok(Number.isNaN(casesFor(0.1, 0)));
    // At the planned n the MDE is at or just below the target effect.
    const n = casesFor(0.1, 0.5);
    assert.ok((Z * 0.5) / Math.sqrt(n) <= 0.1 && (Z * 0.5) / Math.sqrt(n - 1) > 0.1);
  });
});

describe("exact McNemar power in pairedPower (AD-9)", () => {
  // 45 cases, 3 regressions and 4 improvements: 7 of 45 discordant (15.6%).
  const d45 = [...rep(-1, 3), ...rep(1, 4), ...rep(0, 38)];

  it("45 cases with 7 discordant: no gap reaches 80% power", () => {
    const p = pairedPower(d45, { discordant: { b: 3, c: 4 } });
    assert.equal(p.exact?.n, 45);
    close(p.exact?.discordance ?? NaN, 7 / 45);
    assert.ok(Number.isNaN(p.exact?.mde));
    assert.ok((p.exact?.ceiling ?? 1) < 0.8);
    // The normal MDE is finite and claims about 20pp; the exact test disagrees.
    assert.ok(Number.isFinite(p.mde));
    assert.deepEqual(p.warnings.map((w) => w.code), ["small-n", "no-power"]);
    assert.match(
      p.warnings[1]!.message,
      /^at 45 paired cases and 16% discordance no difference reaches 80% power \(the exact McNemar ceiling is \d+%; it needs at least 6 discordant cases to reject at alpha 0\.05\)$/,
    );
    assert.equal(exactPowerText(p), ` · no 80% power at this n (exact McNemar ceiling ${Math.round(p.exact!.ceiling * 100)}%)`);
  });

  it("447 cases at 14% discordance have an exact MDE and no no-power warning", () => {
    const diffs = [...rep(-1, 31), ...rep(1, 32), ...rep(0, 384)];
    const p = pairedPower(diffs, { discordant: { b: 31, c: 32 } });
    assert.ok(Math.abs((p.exact?.mde ?? NaN) - 0.051) < 0.002);
    assert.deepEqual(p.warnings.map((w) => w.code), ["below-mde"]);
    // below-mde uses the larger of the two MDEs.
    assert.match(p.warnings[0]!.message, new RegExp(`minimum detectable effect ${(Math.max(p.mde, p.exact!.mde) * 100).toFixed(1)}pp`));
    assert.match(exactPowerText(p), /^ · exact MDE 5\.\dpp$/);
  });

  it("the A/A flip rate raises the discordance when it is larger", () => {
    const diffs = [...rep(-1, 10), ...rep(1, 10), ...rep(0, 180)];
    const low = pairedPower(diffs, { discordant: { b: 10, c: 10 } });
    close(low.exact?.discordance ?? NaN, 0.1);
    const raised = pairedPower(diffs, { discordant: { b: 10, c: 10 }, noise: { sd: 0.1, flipRate: 0.3, paired: 50 } });
    close(raised.exact?.discordance ?? NaN, 0.3);
    assert.ok((raised.exact?.mde ?? 0) > (low.exact?.mde ?? 1));
    // A smaller flip rate leaves the observed discordance alone.
    close(pairedPower(diffs, { discordant: { b: 10, c: 10 }, noise: { sd: 0.1, flipRate: 0.05, paired: 50 } }).exact?.discordance ?? NaN, 0.1);
  });

  it("no discordant case: no exact design, no-change stands", () => {
    const p = pairedPower(rep(0, 250), { discordant: { b: 0, c: 0 } });
    assert.equal(p.exact, undefined);
    assert.deepEqual(p.warnings.map((w) => w.code), ["no-change"]);
    assert.equal(exactPowerText(p), "");
  });

  it("output is unchanged without discordant counts", () => {
    for (const diffs of [d45, [...rep(1, 7), ...rep(-1, 3), ...rep(0, 10)], rep(0, 250)]) {
      const p = pairedPower(diffs);
      assert.equal("exact" in p, false);
      assert.ok(!p.warnings.some((w) => w.code === "no-power"));
    }
  });

  it("a significant result without power says the effect is likely exaggerated", () => {
    const p = pairedPower([...rep(-1, 6), ...rep(0, 18)], { significant: true, discordant: { b: 6, c: 0 } });
    assert.deepEqual(p.warnings.map((w) => w.code), ["small-n", "no-power"]);
    assert.match(p.warnings[1]!.message, /tends to exaggerate the effect$/);
  });
});

describe("pass^k", () => {
  const r = (caseId: string, trial: number, pass: boolean): CaseRun => ({ caseId, trial, pass, latencyMs: 0, grades: [], startedAt: 0 });
  const runs = [r("a", 0, true), r("a", 1, true), r("a", 2, true), r("b", 0, true), r("b", 1, false), r("b", 2, true), r("c", 0, false), r("c", 1, false), r("c", 2, false)];

  it("a case counts only when every trial passed", () => {
    assert.deepEqual([...allTrialsPass(runs)], [["a", true], ["b", false], ["c", false]]);
    close(passHatK(runs, ["a", "b", "c"]), 1 / 3);
    close(passHatK(runs, ["a"]), 1);
    // Restricted to the given (paired) ids; unknown ids count as not passing.
    close(passHatK(runs, ["a", "zzz"]), 0.5);
    assert.ok(Number.isNaN(passHatK(runs, [])));
  });
});
