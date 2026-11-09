// docs/reference/api.md lists every HTTP route `coding.sh serve` answers. There is
// no route table to import, so this reads the dispatchers in src/server/serve.ts,
// src/viewer/server.ts and src/otel/receiver.ts and fails when a route is added
// or removed without updating the doc's "## Routes" table.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = join(pkg, "..", "..");
const DOC_PATH = join(repo, "docs", "reference", "api.md");
const src = (p: string) => readFileSync(join(pkg, "src", p), "utf8");

/** "METHOD /path" with every `{param}` written as `{}`. */
const key = (method: string, path: string) => `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`;

/** Keys of an object literal like `const NAME: Record<string, Signal> = { "/v1/traces": "traces", … }`. */
function literalKeys(text: string, name: string): string[] {
  const m = new RegExp(`const ${name}\\b[^=]*=\\s*\\{([^}]*)\\}`).exec(text);
  assert.ok(m, `found ${name}`);
  return [...m[1]!.matchAll(/"(\/[^"]+)"\s*:/g)].map((x) => x[1]!);
}

/** Every route the server source dispatches, mapped to the processes that serve it. */
function serverRoutes(): Map<string, string> {
  const serve = src("server/serve.ts");
  const viewer = src("viewer/server.ts");
  const receiver = src("otel/receiver.ts");
  const routes = new Map<string, string>();

  // serve.ts: its own paths, the OTLP signals, then everything else falls through to the viewer.
  // Ingest handlers (native and OTLP) take POST only; health and metrics are read with GET.
  // The native ingest handler lives in routes.ts, shared with the serverless fetch handler.
  assert.match(src("server/routes.ts"), /req\.method !== "POST"/, "native ingest is POST only");
  assert.match(receiver, /req\.method !== "POST"/, "OTLP is POST only");
  assert.match(serve, /return viewer\(req, res\)/, "serve falls through to the viewer handler");
  const collector = new Set(literalKeys(receiver, "ROUTES"));
  const servePaths = [...serve.matchAll(/path === "(\/[^"]*)"/g)].map((m) => m[1]!);
  for (const path of new Set([...servePaths, ...literalKeys(serve, "SIGNALS")])) {
    routes.set(key(path.startsWith("/v1/") ? "POST" : "GET", path), collector.has(path) ? "serve, collector" : "serve");
  }

  // The model API proxy's mount: every path under PROXY_PREFIX (documented as POST, what agents send).
  const prefix = /export const PROXY_PREFIX = "(\/[^"]+\/)"/.exec(serve)?.[1];
  if (prefix && /path\.startsWith\(PROXY_PREFIX\)\) return proxy\(req, res\)/.test(serve)) routes.set(key("POST", `${prefix}{path}`), "serve");

  // viewer/server.ts: the page, then routeApi's switch. Served by `serve` and `ui`.
  assert.match(viewer, /req\.method !== "GET" && req\.method !== "HEAD"/, "the page is GET/HEAD");
  for (const m of viewer.matchAll(/path === "(\/[^"]*)"/g)) routes.set(key("GET", m[1]!), "serve, ui");
  const start = viewer.indexOf("async function routeApi(");
  const end = viewer.indexOf("    default:", start);
  assert.ok(start > 0 && end > start, "found routeApi's switch");
  const body = viewer.slice(start, end);
  const cases = [...body.matchAll(/case "([a-z-]+)": \{/g)];
  assert.ok(cases.length >= 10, "found the /api cases");
  cases.forEach((c, i) => {
    const block = body.slice(c.index!, cases[i + 1]?.index ?? body.length);
    const methods = new Set([...block.matchAll(/method === "([A-Z]+)"/g)].map((m) => m[1]!));
    if (/\bget\(\);/.test(block)) methods.add("GET");
    assert.ok(methods.size > 0, `methods of /api/${c[1]}`);
    const base = `/api/${c[1]}`;
    // A case with named sub-routes (`if (id === "calls")`): the bare path, then each name with
    // its own methods, `/{}` after it when it reads `sub` as an id. One behind `if (!ctx.<source>)`
    // is only in `coding.sh ui`, which passes that source.
    const named = [...block.matchAll(/if \(id === "([a-z-]+)"\)/g)];
    if (named.length) {
      const by = /if \(!ctx\.\w+\) throw new HttpError\(404/.test(block) ? "ui" : "serve, ui";
      if (/\bget\(\);/.test(block.slice(0, named[0]!.index))) routes.set(key("GET", base), by);
      named.forEach((n, j) => {
        const seg = block.slice(n.index!, named[j + 1]?.index ?? block.length);
        const ms = new Set([...seg.matchAll(/method [!=]== "([A-Z]+)"/g)].map((m) => m[1]!));
        if (/\bget\(\);/.test(seg)) ms.add("GET");
        for (const m of ms) routes.set(key(m, `${base}/${n[1]}${/checkId\(sub\b/.test(seg) ? "/{}" : ""}`), by);
      });
      return;
    }
    const collectionOnly = /if \(id !== undefined\) throw new HttpError\(404/.test(block);
    const itemOnly = /if \(id === undefined \|\| sub !== undefined\) throw new HttpError\(404/.test(block) || /if \(id === undefined \|\| id === "" \|\| \(sub !== undefined && !\w+\)\) throw notFound\(\)/.test(block);
    const paths: string[] = [];
    if (!itemOnly) paths.push(base);
    if (!collectionOnly) paths.push(`${base}/{}`);
    // A sub-route with a method of its own (`if (sub === "fork") { … method !== "POST" … }`) answers that
    // method too; one behind `if (!ctx.fork)` is only in `coding.sh ui`, which passes the fork source.
    const own: [string, Set<string>, string][] = [];
    const subs = [...block.matchAll(/(?:if \()?sub === "([a-z-]+)"/g)];
    subs.forEach((s, j) => {
      const path = `${base}/{}/${s[1]}`;
      paths.push(path);
      const sb = block.slice(s.index!, subs[j + 1]?.index ?? block.length);
      const extra = new Set([...sb.matchAll(/method [!=]== "([A-Z]+)"/g)].map((m) => m[1]!));
      if (extra.size) own.push([path, extra, /if \(!ctx\.fork\)/.test(sb) ? "ui" : "serve, ui"]);
    });
    for (const method of methods) for (const path of paths) routes.set(key(method, path), "serve, ui");
    for (const [path, ms, by] of own) for (const method of new Set([...ms, "GET"])) routes.set(key(method, path), by);
  });
  return routes;
}

interface DocRoute {
  method: string;
  path: string;
  servedBy: string;
}

/** Rows of the table under "## Routes": | Method | Path | Auth | Served by |. */
function docRoutes(doc: string): DocRoute[] {
  const start = doc.indexOf("\n## Routes\n");
  assert.ok(start >= 0, "api.md has a ## Routes section");
  const end = doc.indexOf("\n## ", start + 1);
  const rows: DocRoute[] = [];
  for (const line of doc.slice(start, end === -1 ? undefined : end).split("\n")) {
    if (!line.startsWith("|") || /^\|[\s:|-]+\|$/.test(line.trim())) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells[0] === "Method") continue;
    const path = /`([^`]+)`/.exec(cells[1] ?? "")?.[1];
    assert.ok(path, `route row has a path: ${line}`);
    rows.push({ method: cells[0]!, path, servedBy: cells[3] ?? "" });
  }
  return rows;
}

describe("docs/reference/api.md", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const server = serverRoutes();
  const rows = docRoutes(doc);
  const documented = new Map(rows.map((r) => [key(r.method, r.path), r]));

  it("finds the server's routes", () => {
    assert.ok(server.size >= 20, `found ${server.size} routes`);
    for (const r of ["POST /v1/ingest", "POST /v1/traces", "GET /healthz", "GET /api/sessions/{}/events", "POST /api/labels", "POST /proxy/{}"]) {
      assert.ok(server.has(r), r);
    }
  });

  it("lists every route the server answers", () => {
    const missing = [...server.keys()].filter((k) => !documented.has(k));
    assert.deepEqual(missing, [], `add these routes to the ## Routes table in docs/reference/api.md: ${missing.join(", ")}`);
  });

  it("lists no route the server lacks", () => {
    const extra = [...documented.keys()].filter((k) => !server.has(k));
    assert.deepEqual(extra, [], `docs/reference/api.md lists routes the server does not answer: ${extra.join(", ")}`);
  });

  it("lists each route once", () => {
    assert.equal(documented.size, rows.length, "a route appears twice in the ## Routes table");
  });

  it("says which processes serve each route", () => {
    for (const [k, by] of server) assert.equal(documented.get(k)?.servedBy, by, `Served by for ${k}`);
  });

  it("has a section for every route", () => {
    const headings = doc.split("\n").filter((l) => l.startsWith("### "));
    for (const r of rows) {
      assert.ok(headings.some((h) => h.includes(`\`${r.method} ${r.path}\``)), `add a ### heading with \`${r.method} ${r.path}\``);
    }
  });

  it("follows the docs page format", () => {
    assert.ok(doc.startsWith("# REST API reference\n"), "title");
    assert.ok(doc.includes("Site version: [coding.sh/docs/api](https://coding.sh/docs/api)."), "site link");
    assert.ok(!/acme/i.test(doc), "no banned names");
  });
});
