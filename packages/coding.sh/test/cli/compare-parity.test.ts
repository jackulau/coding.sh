// compare --parity: two stub servers that differ in canonical and one JSON-LD type report exactly
// those diffs; identical pages report parity. Plus the page reader on its own.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { diffParity, readPage, type ParitySide } from "../../src/cli/commands/compare-parity.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { spawn } from "node:child_process";
import { CLI, cli as cliSync } from "../query/_seed.ts";

/** The CLI, run without blocking this process: the stub servers live here and must keep answering. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1", TZ: "UTC" };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const page = (o: { canonical: string; type: string; host: string }) => `<!doctype html>
<html lang="en"><head>
<title>Docs &amp; guides</title>
<meta name="description" content="How it works">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${o.canonical}">
<link rel="alternate" hreflang="en" href="/en/docs"><link rel="alternate" hreflang="de" href="/de/docs">
<meta property="og:title" content="Docs">
<meta property="og:url" content="${o.host}/docs">
<meta name="twitter:card" content="summary_large_image">
<!-- <meta name="robots" content="noindex"> -->
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"${o.type}"}]}</script>
<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>
</head><body>hi</body></html>`;

/** A stub site: / redirects to /docs, /docs is the page. */
function site(render: (host: string) => string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const host = `http://${req.headers.host}`;
      if (req.url === "/") {
        res.writeHead(301, { location: "/docs" });
        res.end();
      } else if (req.url === "/docs") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(render(host));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

describe("compare --parity", () => {
  let env: TmpEnv;
  const sites: Server[] = [];
  let a: string;
  let b: string;
  let same: string;
  before(async () => {
    env = tmpEnv();
    const sa = await site((h) => page({ canonical: `${h}/docs`, type: "TechArticle", host: h }));
    // Differs in canonical (another path) and one JSON-LD type; its og:url names its own host, which reads the same.
    const sb = await site((h) => page({ canonical: `${h}/docs/`, type: "Article", host: h }));
    const sc = await site((h) => page({ canonical: `${h}/docs`, type: "TechArticle", host: h }));
    sites.push(sa.server, sb.server, sc.server);
    [a, b, same] = [sa.url, sb.url, sc.url];
  });
  after(() => {
    for (const s of sites) s.close();
    env.restore();
  });

  test("two sites that differ in canonical and one JSON-LD type report exactly those diffs", async () => {
    const r = await cli(["compare", "--parity", `${a}/`, `${b}/`, "--json"]);
    assert.equal(r.status, 1, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.parity, false);
    assert.deepEqual(doc.diffs, [
      { field: "canonical", a: "/docs", b: "/docs/" },
      { field: "jsonld", a: ["Organization", "TechArticle", "WebSite"], b: ["Article", "Organization", "WebSite"] },
    ]);
    assert.deepEqual(doc.a.page.redirects, [{ status: 301, location: `${a}/docs` }]);
    assert.equal(doc.a.page.status, 200);
    assert.equal(doc.a.finalUrl, `${a}/docs`);
  });

  test("the human form lists the differing fields and exits 1", async () => {
    const r = await cli(["compare", "--parity", `${a}/`, `${b}/`]);
    assert.equal(r.status, 1);
    const rows = r.stdout.trim().split("\n");
    assert.match(rows[0]!, /^FIELD\s+A\s+B$/);
    assert.deepEqual(rows.slice(1).map((l) => l.split(/\s+/)[0]), ["canonical", "jsonld"]);
    assert.match(r.stderr, /2 of \d+ fields differ/);
  });

  test("identical pages on two hosts report parity and exit 0", async () => {
    const r = await cli(["compare", "--parity", `${a}/`, `${same}/`, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.parity, true);
    assert.deepEqual(doc.diffs, []);
    const human = await cli(["compare", "--parity", `${a}/`, `${same}/`]);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /^Parity: \d+ fields read the same\n$/);
  });

  test("a command's stdout is a page too; a redirect is a difference against it", async () => {
    const html = page({ canonical: "https://example.com/docs", type: "TechArticle", host: "https://example.com" });
    // The page is printed by a script file: its text would need quoting that sh and cmd.exe do not share.
    const script = join(env.home, "page.cjs");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(html)});\n`);
    const cmd = `"${process.execPath}" "${script}"`;
    const r = await cli(["compare", "--parity", cmd, `${a}/`, "--json"]);
    assert.equal(r.status, 1, r.stderr);
    const fields = JSON.parse(r.stdout).diffs.map((d: { field: string }) => d.field);
    assert.deepEqual(fields, ["status", "redirects", "canonical", "og:url"]);
  });

  test("an unreachable URL is a fetch_failed error; --user-agent alone is a usage error", async () => {
    const r = await cli(["compare", "--parity", "http://127.0.0.1:9/", `${a}/`, "--json"]);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout || r.stderr).error?.reason ?? JSON.parse(r.stdout || r.stderr).reason, "fetch_failed");
    assert.equal(cliSync(["compare", "a", "b", "--user-agent", "x"]).status, 2);
  });
});

describe("readPage", () => {
  test("reads tags in any attribute order and quoting, and skips commented-out ones", () => {
    const p = readPage(page({ canonical: "/docs", type: "Article", host: "https://x.dev" }), "https://x.dev/docs");
    assert.equal(p.title, "Docs & guides");
    assert.equal(p.description, "How it works");
    assert.equal(p.robots, "index,follow", "the commented noindex is not read");
    assert.equal(p.canonical, "https://x.dev/docs", "resolved against the page URL");
    assert.equal(p.hreflang, 2);
    assert.deepEqual(p.social, { "og:title": "Docs", "og:url": "https://x.dev/docs", "twitter:card": "summary_large_image" });
    assert.deepEqual(p.jsonLdTypes, ["Article", "Organization", "WebSite"]);
    assert.equal(p.lang, "en");
    const q = readPage(`<META content='a' NAME=description><script type="application/ld+json">{oops</script>`);
    assert.equal(q.description, "a");
    assert.equal(q.jsonLdErrors, 1);
  });
  test("a raw '>' inside a quoted attribute value does not end the tag", () => {
    assert.equal(readPage('<meta name="description" content="a > b">').description, "a > b");
    assert.equal(readPage("<meta name='description' content='Fast -> faster: a > b' >").description, "Fast -> faster: a > b");
    const p = readPage(
      `<html data-note="x > y" lang="en"><head><title data-x="1 > 0">T > U</title>
<link data-x="a > b" rel="canonical" href="/docs">
<meta content="it's > that" name=description><meta name=robots content=it's><meta property="og:title" content="A => B">
<script data-x="a > b" type="application/ld+json">{"@type":"Article"}</script></head></html>`,
      "https://x.dev/",
    );
    assert.equal(p.lang, "en");
    assert.equal(p.title, "T > U");
    assert.equal(p.canonical, "https://x.dev/docs");
    assert.equal(p.description, "it's > that");
    assert.deepEqual(p.social, { "og:title": "A => B" }, "the apostrophe in the unquoted value before it opens nothing");
    assert.deepEqual(p.jsonLdTypes, ["Article"]);
  });
  test("diffParity sees a difference after a raw '>', and reads &gt; and > the same", () => {
    const side = (html: string): ParitySide => ({ input: "x", page: { redirects: [], ...readPage(html) } });
    const meta = (content: string) => `<meta name="description" content="${content}">`;
    assert.deepEqual(diffParity(side(meta("Fast -> faster: a > b")), side(meta("Fast -> faster: a > c"))), [{ field: "description", a: "Fast -> faster: a > b", b: "Fast -> faster: a > c" }]);
    assert.deepEqual(diffParity(side(meta("a &gt; b")), side(meta("a > b"))), []);
  });
  test("diffParity on identical sides is empty", () => {
    const side: ParitySide = { input: "x", page: { redirects: [], social: {}, hreflang: 0, jsonLdTypes: [], jsonLdErrors: 0 } };
    assert.deepEqual(diffParity(side, structuredClone(side)), []);
  });
});
