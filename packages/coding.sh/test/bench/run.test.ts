// runBench end to end on temp projects: frozen-set identity across
// contenders, scheduled vs adhoc, freshness, exclusions, retries, budget,
// redaction, regrade, page snapshots, the GitHub created_at window and the
// definition rules behind them.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { parseDefinition } from "../../src/bench/define.ts";
import { casesSha256, estimateCost, exclusionOf, regradeRun, runBench } from "../../src/bench/run.ts";
import { getBlob, historyRuns, listRuns, seenKeys } from "../../src/bench/store.ts";
import type { BenchRun } from "../../src/bench/types.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const run = (o: Parameters<typeof runBench>[0]) => runBench(o) as Promise<BenchRun>;

describe("bench run: fairness", () => {
  test("every contender runs exactly the frozen set, interleaved, and the hash is recomputable", async () => {
    const p = project();
    const def = p.def("trials = 2");
    const evalStore = new FileEvalStore({ env: p.env });
    const r = await run({ def, env: p.env, now: day("2026-11-04"), evalStore });
    assert.equal(r.cases.length, 12);
    for (const c of ["good", "bad"]) {
      const mine = r.cells.filter((x) => x.contender === c);
      assert.equal(mine.length, 24);
      assert.deepEqual([...new Set(mine.map((x) => x.caseId))].sort(), r.cases.map((x) => x.id).sort(), `${c} ran the frozen set`);
    }
    assert.equal(casesSha256(r.cases), r.dataset.sha256);
    const ds = await evalStore.getDataset(r.dataset.id, r.dataset.version);
    assert.deepEqual(ds!.cases.map((c) => c.id).sort(), r.cases.map((c) => c.id).sort());
    // Global order: positions are a permutation, and "good" isn't always first within a case.
    assert.deepEqual(r.cells.map((x) => x.position).sort((a, b) => a - b), [...Array(48).keys()]);
    const firstOf = new Map<string, string>();
    for (const x of [...r.cells].sort((a, b) => a.position - b.position)) if (!firstOf.has(`${x.caseId}:${x.trial}`)) firstOf.set(`${x.caseId}:${x.trial}`, x.contender);
    assert.equal(new Set(firstOf.values()).size, 2, "both contenders go first sometimes");
    assert.equal(r.order, "interleaved-random");
    // Records: versions and models.
    assert.ok(r.codingShVersion);
    assert.equal(r.contenders.find((c) => c.name === "good")!.model, "good-1");
    assert.equal(r.summaries[0]!.contender, "good");
    assert.equal(r.summaries[0]!.ciMethod, "cluster-bootstrap");
    assert.ok(r.cells.every((x) => x.error || x.outputSha256), "every answer is stored in full");
    const blob = await getBlob("arith", r.cells.find((x) => x.outputSha256)!.outputSha256!, p.env);
    assert.ok(blob && blob.length > 0);
    assert.deepEqual(r.policy, { timeoutMs: 300_000, retries: 0 });
  });

  test("a new day gets fresh cases; same-day reruns and --seed runs are adhoc and don't touch the ledger", async () => {
    const p = project();
    const def = p.def();
    const d1 = await run({ def, env: p.env, now: day("2026-11-04") });
    const rerun = await run({ def, env: p.env, now: day("2026-11-04") + 3600e3 });
    const fixed = await run({ def, env: p.env, now: day("2026-11-04") + 7200e3, seed: "try" });
    const d2 = await run({ def, env: p.env, now: day("2026-11-05") });
    assert.equal(d1.mode, "scheduled");
    assert.equal(rerun.mode, "adhoc");
    assert.equal(fixed.mode, "adhoc");
    assert.equal(d2.mode, "scheduled");
    const k1 = new Set(d1.cases.map((c) => c.key));
    assert.ok(d2.cases.every((c) => !k1.has(c.key)), "day 2 shares no case with day 1");
    const all = await listRuns("arith", p.env);
    assert.deepEqual(historyRuns(all).map((r) => r.id), [d1.id, d2.id]);
    const seen = seenKeys(all);
    assert.ok(fixed.cases.some((c) => !seen.has(c.key)), "the adhoc run's cases stay unconsumed");
  });

  test("quota answers exclude the case for every contender; timeouts stay failures", async () => {
    const p = project();
    // Rate-limited on every third case (by a: a % 3 == 0), slow on a % 7 == 1.
    p.write("limited.cjs", `const i = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (Math.abs(i.a) % 3 === 0) { console.error("HTTP 429 Too Many Requests"); process.exit(1); }
if (Math.abs(i.a) % 7 === 1) setTimeout(() => console.log(JSON.stringify(i.a + i.b)), 5000);
else console.log(JSON.stringify(i.a + i.b));`);
    const text = (await import("node:fs")).readFileSync(p.file, "utf8").replace("node bad.cjs", "node limited.cjs").replace("cases = 12", "cases = 30\ntimeoutMs = 1500");
    const def = parseDefinition(text, p.file);
    const r = await run({ def, env: p.env, now: day("2026-11-04") });
    const limited = r.cells.filter((x) => x.contender === "bad" && x.excluded === "quota");
    assert.ok(limited.length > 0, "some calls were rate limited");
    assert.equal(r.excluded!.cases, limited.length);
    assert.equal(r.excluded!.byReason.quota, limited.length);
    for (const s of r.summaries) assert.equal(s.n, r.cases.length - limited.length, `${s.contender} is scored on the same cases`);
    const timeouts = r.cells.filter((x) => x.failure === "timeout");
    assert.ok(timeouts.every((x) => !x.excluded), "a timeout is the contender's failure, not an exclusion");
    assert.equal(r.comparisons[0]!.paired, r.cases.length - limited.length);
  });

  test("exclusionOf: 401/402/429 and quota text, never timeouts", () => {
    assert.equal(exclusionOf("POST https://x: HTTP 402 Payment Required"), "quota");
    assert.equal(exclusionOf("exited 1: insufficient_quota"), "quota");
    assert.equal(exclusionOf("exited 1: rate limited, retry later"), "quota");
    assert.equal(exclusionOf("timed out after 100 ms (rate limit?)"), undefined);
    assert.equal(exclusionOf("exited 3: boom"), undefined);
    assert.equal(exclusionOf(undefined, { failure: "quota" }), "quota");
  });

  test("retries are shared: a flaky first call recovers with retries = 1", async () => {
    const p = project();
    p.write("flaky.cjs", `const fs = require("fs"); const i = JSON.parse(fs.readFileSync(0, "utf8"));
const f = require("path").join(__dirname, "seen-" + process.env.CODING_SH_CASE_ID);
if (!fs.existsSync(f)) { fs.writeFileSync(f, "1"); process.exit(2); }
console.log(JSON.stringify(i.a + i.b));`);
    const text = (await import("node:fs")).readFileSync(p.file, "utf8").replace("node bad.cjs", "node flaky.cjs").replace("cases = 12", "cases = 5\nretries = 1");
    const r = await run({ def: parseDefinition(text, p.file), env: p.env, now: day("2026-11-04") });
    const flaky = r.cells.filter((x) => x.contender === "bad");
    assert.ok(flaky.every((x) => x.pass && x.attempts === 2));
    assert.ok(r.cells.filter((x) => x.contender === "good").every((x) => x.attempts === 1));
  });

  test("budget: refuses above the estimate, stops at the cap, and an incomplete run stays out of history", async () => {
    const p = project();
    const first = await run({ def: p.def(), env: p.env, now: day("2026-11-04") });
    // Known cost now: 12 cases × ($0.002 + $0.0005).
    const est = estimateCost(p.def(), [first], 12);
    assert.equal(Math.round(est.usd! * 1e4) / 1e4, 0.03);
    await assert.rejects(run({ def: p.def("budget_usd = 0.01"), env: p.env, now: day("2026-11-05") }), /over budget_usd/);
    // Fresh project, no history: unknown estimate, so it starts, then stops at the cap.
    const q = project();
    const r = await run({ def: q.def("budget_usd = 0.005"), env: q.env, now: day("2026-11-04") });
    assert.equal(r.status, "incomplete");
    assert.equal(r.stopReason, "budget");
    assert.ok(r.budget!.spentUsd <= 0.005 + 0.002 * 3 + 1e-9, `spent ${r.budget!.spentUsd}`);
    assert.ok(r.cells.length < 24);
    const all = await listRuns("arith", q.env);
    assert.equal(historyRuns(all).length, 0);
    assert.equal(seenKeys(all).size, 0, "an incomplete run doesn't consume cases");
  });

  test("secrets in cases are redacted at freeze", async () => {
    const p = project();
    const key = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    p.write("gen.mjs", `for (let i = 0; i < 4; i++) console.log(JSON.stringify({ input: { a: i, b: 1, note: i === 0 ? "token ${key}" : "" }, expected: i + 1 }));`);
    const r = await run({ def: p.def(), env: p.env, now: day("2026-11-04") });
    assert.equal(r.redacted, 1);
    assert.ok(!JSON.stringify(r).includes(key), "the token never reaches the record");
  });

  test("regrade re-scores stored outputs into a new record that history prefers", async () => {
    const p = project();
    const orig = await run({ def: p.def(), env: p.env, now: day("2026-11-04") });
    assert.ok(orig.summaries.find((s) => s.contender === "bad")!.passed < 12);
    // A lenient grader: any number within 1 passes.
    const text = (await import("node:fs")).readFileSync(p.file, "utf8").replace('kind = "exact"', 'kind = "numeric"\nabs = 1');
    const def = parseDefinition(text, p.file);
    const re = await regradeRun(orig, { def, env: p.env });
    assert.equal(re.regradeOf, orig.id);
    assert.deepEqual(re.cases, orig.cases);
    const badOrig = orig.cells.filter((x) => x.contender === "bad");
    const badNew = re.cells.filter((x) => x.contender === "bad");
    assert.deepEqual(badNew.map((x) => x.latencyMs), badOrig.map((x) => x.latencyMs), "no contender was called again");
    assert.ok(badNew.filter((x) => x.pass).length > badOrig.filter((x) => x.pass).length, "off-by-one answers now pass");
    assert.deepEqual(historyRuns(await listRuns("arith", p.env)).map((r) => r.id), [re.id]);
  });
});

describe("bench sources", () => {
  test("urls: shuffled before caps, each page snapshotted once at freeze, body hash in the frozen set", async () => {
    const p = project();
    const urls = Array.from({ length: 8 }, (_, i) => `https://docs.example.test/p${i}`);
    const pages = new Map(urls.map((u) => [u, `page:${u}`]));
    let fetches = 0;
    const fetch = async (u: string) => {
      if (u.endsWith("sitemap.xml")) return new Response(`<urlset>${urls.map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>`);
      fetches++;
      return new Response(pages.get(u) ?? "missing", { status: pages.has(u) ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
    };
    p.write("echo.cjs", `const u = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify("page:" + u));`);
    p.write("wrong.cjs", `console.log(JSON.stringify("nope"));`);
    const toml = `name = "pages"
cases = 4
seed = "fixed"
fresh = false
maxPerOrg = 10
[source]
kind = "urls"
sitemap = "https://docs.example.test/sitemap.xml"
[[contenders]]
name = "echo"
command = "node echo.cjs"
[[contenders]]
name = "wrong"
command = "node wrong.cjs"
[[graders]]
kind = "exact"
`;
    const file = p.write("bench/pages.toml", toml);
    const def = parseDefinition(toml, file);
    assert.equal(def.visibility, "public");
    const r = await run({ def, env: p.env, now: day("2026-11-04"), fetch });
    assert.equal(fetches, 4, "one fetch per sampled page");
    assert.deepEqual(r.snapshots, { fetched: 4, ok: 4 });
    for (const c of r.cases) {
      const snap = c.metadata!.snapshot as { sha256: string; status: number; contentType: string };
      assert.equal(snap.status, 200);
      assert.equal(snap.contentType, "text/html");
      assert.equal((await getBlob("pages", snap.sha256, p.env))!.toString(), `page:${c.input}`);
      assert.equal(c.metadata!.org, "example.test");
    }
    // Graders compare against the snapshot.
    assert.equal(r.summaries.find((s) => s.contender === "echo")!.passed, 4);
    assert.equal(r.summaries.find((s) => s.contender === "wrong")!.passed, 0);
    // Same URLs, changed content → a different frozen set.
    for (const u of urls) pages.set(u, `changed:${u}`);
    const r2 = await run({ def, env: p.env, now: day("2026-11-05"), fetch });
    assert.deepEqual(r2.cases.map((c) => c.id), r.cases.map((c) => c.id));
    assert.notEqual(r2.dataset.sha256, r.dataset.sha256);
  });

  test("github: the window is on created_at, sorted by created, no author logins", async () => {
    const p = project();
    const now = day("2026-11-06");
    const iso = (daysAgo: number) => new Date(now - daysAgo * 86400e3).toISOString();
    const items = [
      { number: 9, title: "new bug", body: "b", created_at: iso(1), updated_at: iso(0), user: { login: "someone" }, labels: [{ name: "bug" }] },
      { number: 8, title: "new pr", body: "b", created_at: iso(2), updated_at: iso(0), pull_request: {}, user: { login: "x" }, labels: [] },
      { number: 3, title: "old but active", body: "b", created_at: iso(40), updated_at: iso(0), user: { login: "y" }, labels: [] },
    ];
    let asked = "";
    const fetch = async (u: string) => {
      asked = u;
      return new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } });
    };
    const toml = `name = "triage"\ncases = 5\n[source]\nkind = "github"\nrepo = "example-org/tool"\nsince = "7d"\napiUrl = "https://gh.test"\n[[contenders]]\nname = "a"\ncommand = "node good.cjs"\n[[contenders]]\nname = "b"\ncommand = "node bad.cjs"\n`;
    const def = parseDefinition(toml, p.write("bench/triage.toml", toml));
    const r = (await runBench({ def, env: p.env, now, fetch, dryRun: true }));
    assert.match(asked, /sort=created/);
    assert.doesNotMatch(asked, /since=/);
    assert.deepEqual(r.cases.map((c) => (c.input as { number: number }).number), [9]);
    assert.equal(r.cases[0]!.createdAt, iso(1));
    assert.equal(r.cases[0]!.metadata!.org, "example-org");
    assert.ok(!JSON.stringify(r.cases).includes("someone"));
  });
});

describe("bench definitions", () => {
  const base = (extra = "", contenders = '[[contenders]]\nname = "a"\ncommand = "x"\n[[contenders]]\nname = "b"\ncommand = "y"\n') => `name = "t"\n${extra}\n[source]\nkind = "command"\ncommand = "gen"\n${contenders}`;

  test("adding a contender keeps the protocol hash and the others' hashes", () => {
    const a = parseDefinition(base(), "/p/bench/t.toml");
    const b = parseDefinition(base("", '[[contenders]]\nname = "a"\ncommand = "x"\n[[contenders]]\nname = "b"\ncommand = "y"\n[[contenders]]\nname = "c"\ncommand = "z"\n'), "/p/bench/t.toml");
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.protocolHash, b.protocolHash);
    assert.equal(a.contenderHashes.a, b.contenderHashes.a);
    const c = parseDefinition(base("cases = 9"), "/p/bench/t.toml");
    assert.notEqual(c.protocolHash, a.protocolHash, "sampling is part of the protocol");
    assert.equal(parseDefinition(base("budget_usd = 3"), "/p/bench/t.toml").protocolHash, a.protocolHash, "the budget isn't");
  });

  test("limits are bench-level only", () => {
    assert.throws(() => parseDefinition(base("", '[[contenders]]\nname = "a"\ncommand = "x"\ntimeoutMs = 5\n[[contenders]]\nname = "b"\ncommand = "y"\n'), "/p/t.toml"), /top of the file/);
    assert.equal(parseDefinition(base("timeoutMs = 9000\nretries = 2"), "/p/t.toml").timeoutMs, 9000);
  });

  test("sessions source with agent contenders is rejected", () => {
    const t = `name = "s"\n[source]\nkind = "sessions"\n[[contenders]]\nname = "a"\nagent = "claude-code"\n[[contenders]]\nname = "b"\nagent = "codex"\n`;
    assert.throws(() => parseDefinition(t, "/p/s.toml"), /sessions source can't be paired with agent contenders/);
  });

  test("visibility defaults by source and reference must be a contender", () => {
    assert.equal(parseDefinition(base(), "/p/t.toml").visibility, "private");
    assert.equal(parseDefinition(base(), "/p/t.toml").reference, "a");
    assert.throws(() => parseDefinition(base('reference = "zz"'), "/p/t.toml"), /reference must name/);
  });
});
