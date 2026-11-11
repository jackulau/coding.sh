// docs/reference/api.md lists every HTTP route `coding.sh serve` answers. There is
// no route table to import, so this reads the dispatchers in src/server/serve.ts,
// src/viewer/server.ts and src/otel/receiver.ts and fails when a route is added
// or removed without updating the doc's "## Routes" table.
//
// The page also says every example ran against the server it describes. The last
// suite starts that server, sends the page's /v1/ingest example and runs each
// example that reads the session it made.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";

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

/** The ```json block printed right under the ```sh block that `at` is in, or undefined. */
function responseUnder(doc: string, at: number): string | undefined {
  const rest = doc.slice(doc.indexOf("\n```\n", at) + 5);
  return /^\n```json\n([\s\S]*?)\n```\n/.exec(rest)?.[1];
}

/** The key each shell variable of "Running the examples" holds, and the environment the server starts with. */
function exampleSetup(doc: string): { keys: Record<string, string>; env: Record<string, string> } {
  const at = doc.indexOf("**Running the examples.**");
  const block = /\n```sh\n([\s\S]*?)\n```\n/.exec(doc.slice(at))?.[1];
  assert.ok(at >= 0 && block, "api.md says how the example server was started");
  const keys: Record<string, string> = {};
  for (const m of block.matchAll(/^(\w+)=\$\(coding\.sh serve keygen( --read)?\b/gm)) keys[m[1]!] = generateKey(m[2] ? "read" : "ingest");
  const env: Record<string, string> = {};
  for (const m of block.matchAll(/^(CODING_SH_\w+)="([^"]*)"/gm)) env[m[1]!] = m[2]!.replace(/\$(\w+)/g, (_, name: string) => keys[name] ?? assert.fail(`$${name} is not set above`));
  return { keys, env };
}

/** Whether `got` is what the page prints: the same JSON, with an id the page cuts short (`"54b366d0…"`) matching by its start. */
function printedAs(got: unknown, shown: unknown): boolean {
  if (typeof shown === "string" && shown.endsWith("…")) return typeof got === "string" && got.startsWith(shown.slice(0, -1));
  if (Array.isArray(shown)) return Array.isArray(got) && got.length === shown.length && shown.every((v, i) => printedAs(got[i], v));
  if (shown && typeof shown === "object") {
    if (!got || typeof got !== "object" || Array.isArray(got)) return false;
    const [a, b] = [got as Record<string, unknown>, shown as Record<string, unknown>];
    return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((k) => k in a && printedAs(a[k], b[k]));
  }
  return got === shown;
}

describe("docs/reference/api.md examples", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const SESSION = "/api/sessions/team%2Fchat-1";
  const reads = [...doc.matchAll(/^curl -sS "\$CSH(\/[^"]*)" -H "Authorization: Bearer \$(\w+)"$/gm)]
    .filter((m) => m[1]!.startsWith(SESSION))
    .map((m) => ({ path: m[1]!, key: m[2]!, shown: responseUnder(doc, m.index) }));
  let root = "";
  let server: ServeHandle | undefined;
  let keys: Record<string, string> = {};
  const get = async (path: string, key: string) => {
    const res = await fetch(server!.url + path, { headers: { authorization: `Bearer ${keys[key] ?? assert.fail(`$${key} is not a key of the example server`)}` } });
    return { status: res.status, text: await res.text() };
  };

  before(async () => {
    // The documented server: a fresh CODING_SH_HOME, the documented keys, the SQLite store.
    root = mkdtempSync(join(tmpdir(), "csh-api-doc-"));
    mkdirSync(join(root, "home"));
    const setup = exampleSetup(doc);
    keys = setup.keys;
    const cfg = resolveServeConfig({ port: 0 }, { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), ...setup.env });
    server = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false });

    // The page's /v1/ingest example: the batch that makes team/chat-1.
    const post = /^curl -sS -X POST "\$CSH\/v1\/ingest" \\\n  -H "Authorization: Bearer \$(\w+)" \\\n(?:  .*\\\n)*  --data-binary @- <<'EOF'\n([\s\S]*?)\nEOF\n/m.exec(doc);
    assert.ok(post && post[2]!.includes('"chat-1"'), "api.md has the /v1/ingest example that sends chat-1");
    const res = await fetch(`${server.url}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${keys[post[1]!]}`, "content-type": "application/json" }, body: post[2]! });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), JSON.parse(responseUnder(doc, post.index) ?? "null"), "the /v1/ingest example prints what the server answers");
  });
  after(async () => {
    await server?.shutdown().catch(() => {});
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("finds the examples that read team/chat-1", () => {
    assert.ok(reads.length >= 5, `found ${reads.length}`);
    for (const sub of ["", "/events", "/outline", "/rows"]) assert.ok(reads.some((r) => r.path.split("?")[0] === SESSION + sub), `an example of GET ${SESSION}${sub}`);
  });

  it("answers every example that reads team/chat-1", async () => {
    const wrong: string[] = [];
    for (const r of reads) {
      // 200, unless the page prints an error under the example (`{"error":"session not found","status":404}`).
      const shown = /^\{"error":.*"status":(\d+)\}$/.exec(r.shown ?? "");
      const got = await get(r.path, r.key);
      if (got.status !== Number(shown?.[1] ?? 200)) wrong.push(`${r.path} with $${r.key}: ${got.status} ${got.text.slice(0, 200)}`);
    }
    assert.deepEqual(wrong, [], `these examples of docs/reference/api.md do not answer as the page says:\n${wrong.join("\n")}`);
  });

  it("prints the rows the server answers", async () => {
    const r = reads.find((x) => x.path.startsWith(`${SESSION}/rows`))!;
    const got = await get(r.path, r.key);
    assert.ok(r.shown, "the rows example prints its response");
    assert.ok(printedAs(JSON.parse(got.text), JSON.parse(r.shown)), `GET ${r.path} answers\n${got.text}\nand docs/reference/api.md prints\n${r.shown}`);
  });
});
