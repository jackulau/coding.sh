// Commit-reveal seeds (seed = "secret"): each run reveals its salt and
// publishes the hash of the next date's; `bench show` checks the chain.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitFor, commitmentOf, maskSeed, nextDate, saltFor, verifySeed } from "../../src/bench/commit.ts";
import { buildReport, renderReportHtml } from "../../src/bench/report.ts";
import { runBench } from "../../src/bench/run.ts";
import { envRefs } from "../../src/bench/schedule.ts";
import { listRuns, putRun } from "../../src/bench/store.ts";
import type { BenchRun } from "../../src/bench/types.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const KEY = "k3y-for-tests-only-0123456789abcdef";
const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("bench commit-reveal seed", () => {
  test("helpers: salt is an HMAC of name:date, commitment its sha256", () => {
    assert.equal(nextDate("2026-12-31"), "2027-01-01");
    const c = commitFor(KEY, "arith", "2026-11-04");
    assert.equal(c.commit.salt, saltFor(KEY, "arith", "2026-11-04"));
    assert.equal(c.commit.commitment, commitmentOf(c.commit.salt));
    assert.equal(c.seed, `arith:2026-11-04:${c.commit.salt}`);
    assert.equal(c.commit.next!.date, "2026-11-05");
    assert.equal(c.commit.next!.commitment, commitFor(KEY, "arith", "2026-11-05").commit.commitment);
    assert.notEqual(commitFor("other-key", "arith", "2026-11-04").commit.salt, c.commit.salt);
    assert.ok(!maskSeed(c.seed, c.commit).includes(c.commit.salt));
  });

  test("needs the key, publishes tomorrow's commitment, and verifies against it", async () => {
    const p = project();
    const def = p.def('seed = "secret"');
    assert.equal(def.seedKeyEnv, "CODING_SH_BENCH_SEED_KEY");
    assert.ok(envRefs(def).includes("CODING_SH_BENCH_SEED_KEY"), "schedule passes the key as a secret");
    await assert.rejects(runBench({ def, env: p.env, now: day("2026-11-04") }), /seed = "secret" needs CODING_SH_BENCH_SEED_KEY set/);
    const env = { ...p.env, CODING_SH_BENCH_SEED_KEY: KEY };
    // A dry run hides the salt.
    const dry = await runBench({ def, env, now: day("2026-11-04"), dryRun: true });
    assert.ok(!dry.seed.includes(saltFor(KEY, "arith", "2026-11-04")));
    assert.equal(dry.commitment, commitmentOf(saltFor(KEY, "arith", "2026-11-04")));
    const r1 = (await runBench({ def, env, now: day("2026-11-04") })) as BenchRun;
    const r2 = (await runBench({ def, env, now: day("2026-11-05") })) as BenchRun;
    assert.equal(r1.seedCommit!.next!.date, "2026-11-05");
    assert.equal(r1.seedCommit!.next!.commitment, r2.seedCommit!.commitment, "day 1 published day 2's commitment");
    assert.ok(!JSON.stringify(r1).includes(KEY), "the key never reaches a record");
    const all = await listRuns("arith", p.env);
    const ok = verifySeed(r2, all)!;
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.deepEqual(ok.publishedBy, { run: r1.id, date: r1.date });
    assert.ok(verifySeed(r1, all)!.ok, "the first run has nothing to check against but is internally consistent");
    // Same key and date → same seed (the sample differs only by what the ledger now holds); another key → another seed.
    const again = (await runBench({ def, env, now: day("2026-11-05") + 3600e3, dryRun: true }));
    assert.equal(again.commitment, r2.seedCommit!.commitment);
    const other = await runBench({ def, env: { ...p.env, CODING_SH_BENCH_SEED_KEY: "a-different-key" }, now: day("2026-11-05") + 7200e3, dryRun: true });
    assert.notEqual(other.commitment, r2.seedCommit!.commitment);
    // Tampering: a salt that wasn't committed in advance fails.
    const forged: BenchRun = structuredClone(r2);
    forged.seedCommit!.salt = "f".repeat(64);
    forged.seedCommit!.commitment = commitmentOf(forged.seedCommit!.salt);
    forged.seed = `arith:2026-11-05:${forged.seedCommit!.salt}`;
    const bad = verifySeed(forged, all)!;
    assert.equal(bad.ok, false);
    assert.equal(bad.checks.find((x) => x.name === "published")!.ok, false);
    const mismatched: BenchRun = structuredClone(r2);
    mismatched.seed = "arith:2026-11-05:something-else";
    assert.equal(verifySeed(mismatched, all)!.checks.find((x) => x.name === "seed")!.ok, false);
    // The report reveals the salt and shows the next commitment.
    const html = renderReportHtml(buildReport([r1, r2]));
    assert.match(html, new RegExp(`Salt ${r2.seedCommit!.salt}`));
    assert.match(html, /verified<\/span>/);
    assert.match(html, new RegExp(r2.seedCommit!.next!.commitment));
    // bench show verifies, and fails on a forged record.
    const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: p.root, env: { ...p.env, NO_COLOR: "1" }, encoding: "utf8" });
    const shown = cli(["bench", "show", "arith", "--run", r2.id]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /Seed: verified/);
    assert.match(shown.stdout, /seed secret \(salt /);
    const forgedId = r2.id.slice(0, -4) + "ZZZZ";
    await putRun({ ...forged, id: forgedId }, p.env);
    const caught = cli(["bench", "show", "arith", "--run", forgedId, "--json"]);
    assert.equal(caught.status, 1);
    assert.equal(JSON.parse(caught.stdout).seedCheck.ok, false);
  });

  test("a custom key env, only with seed = \"secret\"", () => {
    const p = project();
    const def = p.def('seed = "secret"\nseedKeyEnv = "MY_BENCH_KEY"');
    assert.equal(def.seedKeyEnv, "MY_BENCH_KEY");
    assert.ok(envRefs(def).includes("MY_BENCH_KEY"));
    assert.throws(() => p.def('seedKeyEnv = "MY_BENCH_KEY"'), /only applies with seed = "secret"/);
    assert.throws(() => p.def('seed = "secret"\nseedKeyEnv = "lower"'), /env var name/);
    assert.equal(p.def('seed = "secret"\nseedKeyEnv = "MY_BENCH_KEY"').protocolHash, p.def('seed = "secret"').protocolHash, "renaming the key env doesn't break history");
  });
});
