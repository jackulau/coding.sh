// The freshness ledger's content column (#16): each frozen case records a
// content hash; the same content under a new key isn't fresh, a key whose
// content changed is flagged, and regrade checks the stored inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseDefinition } from "../../src/bench/define.ts";
import { buildReport, renderReportHtml } from "../../src/bench/report.ts";
import { caseContentHash, regradeRun, runBench, verifyFrozen } from "../../src/bench/run.ts";
import { blobsDir, contentChanges, ledger, listRuns, putRun } from "../../src/bench/store.ts";
import type { BenchRun } from "../../src/bench/types.ts";
import { contentHash } from "../../src/datasets/hash.ts";
import { cleanup, day, project } from "./helpers.ts";

after(cleanup);

const run = (o: Parameters<typeof runBench>[0]) => runBench(o) as Promise<BenchRun>;

function pagesSource(p: ReturnType<typeof project>, name: string, extra = "") {
  const pages = new Map<string, string>();
  const fetch = async (u: string) => {
    if (u.endsWith("sitemap.xml")) return new Response(`<urlset>${[...pages.keys()].map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>`);
    return new Response(pages.get(u) ?? "missing", { status: pages.has(u) ? 200 : 404, headers: { "content-type": "text/html" } });
  };
  p.write("echo.cjs", `const u = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify(u));`);
  const toml = `name = "${name}"\n${extra}\n[source]\nkind = "urls"\nsitemap = "https://docs.example.test/sitemap.xml"\n[[contenders]]\nname = "a"\ncommand = "node echo.cjs"\n[[contenders]]\nname = "b"\ncommand = "node echo.cjs"\n`;
  const def = parseDefinition(toml, p.write(`bench/${name}.toml`, toml));
  return { pages, fetch, def };
}

describe("bench ledger: content hashes", () => {
  test("every frozen case records what it measured: {input, expected} by default", async () => {
    const p = project();
    const r = await run({ def: p.def(), env: p.env, now: day("2026-11-04") });
    for (const c of r.cases) assert.equal(c.contentSha256, contentHash({ input: c.input, expected: c.expected ?? null }));
    assert.equal(ledger([r]).content.size, 12);
    assert.deepEqual(await verifyFrozen(r, p.env), []);
  });

  test("the same content under a new key is not fresh", async () => {
    const p = project();
    // Ten cases whose keys change every day but whose content doesn't.
    p.write("gen.mjs", `const d = process.env.CODING_SH_BENCH_DATE; for (let i = 0; i < 10; i++) console.log(JSON.stringify({ input: { a: i, b: 1 }, expected: i + 1, metadata: { k: d + "-" + i } }));`);
    p.def('dedupeBy = "metadata.k"');
    const d = parseDefinition((await import("node:fs")).readFileSync(p.file, "utf8").replace("cases = 12", "cases = 4"), p.file);
    assert.equal(d.dedupeBy, "metadata.k");
    const r1 = await run({ def: d, env: p.env, now: day("2026-11-04") });
    const r2 = await run({ def: d, env: p.env, now: day("2026-11-05") });
    assert.equal(r1.cases.length, 4);
    assert.equal(r2.cases.length, 4);
    const seen = new Set(r1.cases.map((c) => c.contentSha256));
    assert.ok(r2.cases.every((c) => !seen.has(c.contentSha256)), "day 2 skips content day 1 tested, though every key is new");
    assert.equal(r2.sampling.contentSeen, 4);
    assert.equal(r2.sampling.excludedSeen, 0);
  });

  test("urls: a page whose body was already tested is swapped for the next candidate", async () => {
    const p = project();
    const { pages, fetch, def } = pagesSource(p, "docs", "cases = 4");
    for (const [i, body] of ["same", "same", "two", "three"].entries()) pages.set(`https://docs.example.test/p${i}`, body);
    const r1 = await run({ def, env: p.env, now: day("2026-11-04"), fetch });
    assert.equal(r1.cases.length, 3, "p0 and p1 share a body: one is dropped");
    assert.equal(r1.sampling.contentSeen, 1);
    assert.equal(new Set(r1.cases.map((c) => c.contentSha256)).size, 3);
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    assert.ok(r1.cases.every((c) => c.contentSha256 === sha(pages.get(String(c.input))!)), "urls hash the page body");
    // Day 2: p4 serves a body day 1 tested; so does the p0/p1 twin day 1 dropped (a new key, old content).
    pages.set("https://docs.example.test/p4", "two");
    pages.set("https://docs.example.test/p5", "five");
    pages.set("https://docs.example.test/p6", "six");
    const r2 = await run({ def, env: p.env, now: day("2026-11-05"), fetch });
    assert.deepEqual(r2.cases.map((c) => c.input).sort(), ["https://docs.example.test/p5", "https://docs.example.test/p6"]);
    assert.equal(r2.sampling.contentSeen, 2);
    assert.match(r2.warnings.join("\n"), /asked for 4 cases, got 2 \(source returned 7, 3 already tested, 2 with content already tested\)/);
  });

  test("a key whose content changed is flagged in history, the report and the MCP tool", async () => {
    const p = project();
    const { pages, fetch, def } = pagesSource(p, "pages", "cases = 2\nfresh = false\nseed = \"fixed\"");
    for (const i of [0, 1, 2]) pages.set(`https://docs.example.test/p${i}`, `v1:${i}`);
    const r1 = await run({ def, env: p.env, now: day("2026-11-04"), fetch });
    for (const i of [0, 1, 2]) pages.set(`https://docs.example.test/p${i}`, `v2:${i}`);
    const r2 = await run({ def, env: p.env, now: day("2026-11-05"), fetch });
    assert.deepEqual(r2.cases.map((c) => c.key), r1.cases.map((c) => c.key));
    const ch = contentChanges(await listRuns("pages", p.env));
    assert.equal(ch.length, 2);
    assert.equal(ch[0]!.from.run, r1.id);
    assert.equal(ch[0]!.to.run, r2.id);
    assert.equal(ch[0]!.anchor, false);
    const rep = buildReport(await listRuns("pages", p.env));
    assert.equal(rep.contentChanges.length, 2);
    assert.match(renderReportHtml(rep), /changed content between 2026-11-04 and 2026-11-05/);
    const { buildTools } = await import("../../src/mcp/tools.ts");
    const tool = buildTools().find((t) => t.name === "benchmarks")!;
    const h = (await tool.run({ name: "pages", metric: "pass" }, { env: p.env, cwd: p.root } as never)) as { contentChanges: { key: string }[] };
    assert.equal(h.contentChanges.length, 2);
  });

  test("regrade warns when the stored inputs no longer match their hashes", async () => {
    const p = project();
    const { pages, fetch, def } = pagesSource(p, "site", "cases = 2\nfresh = false");
    for (const i of [0, 1]) pages.set(`https://docs.example.test/p${i}`, `body ${i}`);
    const r = await run({ def, env: p.env, now: day("2026-11-04"), fetch });
    assert.deepEqual(await verifyFrozen(r, p.env), []);
    const clean = await regradeRun(r, { def, env: p.env });
    assert.ok(!clean.warnings.some((w) => /hash|changed on disk/.test(w)));
    // Someone edits a snapshot blob and a case in the record.
    const snap = r.cases[0]!.metadata!.snapshot as { sha256: string };
    writeFileSync(join(blobsDir("site", p.env), snap.sha256), "tampered");
    const edited: BenchRun = structuredClone(r);
    edited.cases[1]!.metadata = { ...edited.cases[1]!.metadata, snapshot: { ...(edited.cases[1]!.metadata!.snapshot as object), sha256: "0".repeat(64) } };
    await putRun(edited, p.env);
    const warned = await regradeRun(edited, { def, env: p.env });
    const w = warned.warnings.join("\n");
    assert.match(w, /no longer hash to the recorded dataset sha256/);
    assert.match(w, /no longer match the content hash recorded at freeze/);
    assert.match(w, /changed on disk since freeze/);
    assert.match(w, /missing from site\/blobs/);
    assert.notEqual(caseContentHash(edited.cases[1]!), edited.cases[1]!.contentSha256);
  });
});
