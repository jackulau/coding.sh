// The local viewer holds its guards against a web page in the user's browser and against
// markup in session content. It answers only its own Host names; every /api route needs the
// token, from a header or the cookie, never from the URL; a change needs the viewer's own
// page as its origin and a JSON body, so a page on another site or on another local port
// can't make one; a link from another site never signs the browser in; ids shaped like
// paths are refused; and markup in a session reaches the page escaped, under a CSP that
// runs no inline script.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { UpdateStatus } from "../../src/update/index.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { event, FakeBlobs, FakeIndex, session } from "../viewer/fakes.ts";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const MARKUP = `<img src=x onerror="alert(1)"></script><script>alert(2)</script>`;

/** Every route under /api/, as the viewer's router names them. */
const ROUTES = [
  "sessions", "sessions/s0", "sessions/s0/events", "sessions/s0/replay", "calls", "blobs/" + "0".repeat(64), "search?q=x", "facets",
  "where?q=x", "events/s0-e1", "tasks", "runs", "bundles", "experiments", "workflows", "benchmarks", "compare", "labels",
  "scores", "score-configs", "views", "review", "update", "star", "work", "ingest", "stats", "metrics", "playground", "projects",
];

describe("the local viewer", () => {
  const home = mkdtempSync(join(tmpdir(), "csh-sec-viewer-"));
  const index = new FakeIndex();
  const blobs = new FakeBlobs();
  let v: Viewer;
  let markupBlob: string;

  before(async () => {
    await index.upsertSession(session("s0"));
    await index.upsertSession(session("x1", { title: MARKUP, startedAt: 1_700_000_100_000 }));
    await index.putEvents([event("s0", 1), event("x1", 1, { payload: { text: MARKUP } })]);
    markupBlob = await blobs.put(MARKUP);
    // A readable workflow run, once in the runs folder and once one level above it.
    const run = JSON.stringify({ run: { id: "planted", framework: "claude-code", name: "planted run", startedAt: 1_700_000_000_000, status: "ok", stats: { agents: 0 } }, nodes: [] });
    mkdirSync(join(home, "store", "workflows", "runs"), { recursive: true });
    writeFileSync(join(home, "store", "workflows", "runs", "planted.json"), run);
    writeFileSync(join(home, "store", "workflows", "above.json"), run);
    const env = { CODING_SH_HOME: join(home, "store"), HOME: home, USERPROFILE: home };
    const status: UpdateStatus = { current: "0.0.0", latest: null, updateAvailable: false, url: null, notes: null, install: null, checkedAt: null, disabled: "test", error: null, command: "" };
    v = await startViewer({ index, blobs, port: 0, env, updateStatus: async () => status, work: { overlay: join(home, "work.json"), home, cwd: home } });
  });
  after(async () => {
    await v?.close();
    rmSync(home, { recursive: true, force: true });
  });

  const req = (path: string, o: { method?: string; headers?: Record<string, string>; body?: string; auth?: boolean } = {}): Promise<Res> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${v.port}`, ...o.headers };
      if (o.auth !== false && !headers.authorization && !headers.cookie) headers.authorization = `Bearer ${v.token}`;
      if (o.body !== undefined) headers["content-length"] = String(Buffer.byteLength(o.body));
      const r = request({ host: "127.0.0.1", port: v.port, path, method: o.method ?? "GET", headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      r.on("error", reject);
      r.end(o.body);
    });

  const label = (headers: Record<string, string>, body = JSON.stringify({ sessionId: "s0", criterion: "outcome", value: "pass" })) =>
    req("/api/labels", { method: "POST", headers, body });

  it("answers only its own Host names", async () => {
    for (const path of ["/", "/api/sessions"]) {
      assert.equal((await req(path, { headers: { host: `rebind.example:${v.port}` } })).status, 403, path);
      assert.equal((await req(path, { headers: { host: `localhost:${v.port}` } })).status, 200, path);
    }
  });

  it("needs the token on every /api route, from a header or the cookie, never from the URL", async () => {
    const wrong = v.token.replace(/^./, (c) => (c === "A" ? "B" : "A"));
    for (const route of ROUTES) {
      const sep = route.includes("?") ? "&" : "?";
      for (const r of [
        await req(`/api/${route}`, { auth: false }),
        await req(`/api/${route}`, { headers: { authorization: `Bearer ${wrong}` } }),
        await req(`/api/${route}`, { headers: { cookie: `csh_t_${v.port}=${wrong}` } }),
        await req(`/api/${route}${sep}t=${encodeURIComponent(v.token)}`, { auth: false }),
      ]) {
        assert.equal(r.status, 401, route);
        assert.doesNotMatch(r.body, /Session s0|alert/, route);
      }
    }
  });

  it("takes a change only as JSON from its own page, and answers no preflight", async () => {
    const own = `http://127.0.0.1:${v.port}`;
    const json = { "content-type": "application/json" };
    assert.equal((await label({ ...json, origin: "https://elsewhere.example" })).status, 403);
    assert.equal((await label({ ...json, origin: "null" })).status, 403, "an opaque origin");
    assert.equal((await label({ ...json, origin: `http://127.0.0.1:${v.port + 1}` })).status, 403, "a page on another local port");
    assert.equal((await label({ ...json, origin: `http://localhost:${v.port}` })).status, 403, "a page whose host is not the Host it sent to");
    assert.equal((await label({ "content-type": "text/plain", origin: own })).status, 415, "a body a page can send without a preflight");
    assert.equal((await label({ "content-type": "application/x-www-form-urlencoded" }, "sessionId=s0&criterion=outcome&value=pass")).status, 415);
    const preflight = await req("/api/labels", { method: "OPTIONS", auth: false, headers: { origin: "https://elsewhere.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(JSON.parse((await req("/api/labels?sessionId=s0")).body).items, [], "nothing was saved");
    assert.equal((await label({ ...json, origin: own })).status, 201, "the viewer's own page");
  });

  it("signs a browser in only from a link it followed itself or the key form on its own page", async () => {
    const link = `/?t=${encodeURIComponent(v.token)}`;
    const fromSite = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
    const crossSite = await req(link, { auth: false, headers: fromSite });
    assert.equal(crossSite.status, 200);
    assert.equal(crossSite.headers["set-cookie"], undefined, "a link from another site sets no cookie");
    const wrongKey = await req("/?t=not-the-key", { auth: false, headers: fromSite });
    assert.equal(wrongKey.body.replace("not-the-key", "KEY"), crossSite.body.replace(v.token, "KEY"), "the confirm page says nothing about the key");
    const marked = await req(`/?t=${encodeURIComponent(MARKUP)}`, { auth: false, headers: fromSite });
    assert.ok(!marked.body.includes("<script>alert(2)") && !marked.body.includes("<img src=x"), "a key with markup is escaped");
    assert.match(String(marked.headers["content-security-policy"]), /^default-src 'none';/);
    assert.doesNotMatch(String(marked.headers["content-security-policy"]), /script-src/);
    const direct = await req(link, { auth: false, headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" } });
    assert.equal(direct.status, 302);
    const cookie = String(direct.headers["set-cookie"]);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const form = `t=${encodeURIComponent(v.token)}`;
    const formHeaders = { "content-type": "application/x-www-form-urlencoded" };
    assert.equal((await req("/", { method: "POST", auth: false, body: form, headers: { ...formHeaders, origin: "https://elsewhere.example" } })).status, 403);
    assert.equal((await req("/", { method: "POST", auth: false, body: form, headers: { ...formHeaders, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await req("/", { method: "POST", auth: false, body: form, headers: { ...formHeaders, origin: `http://127.0.0.1:${v.port}` } })).status, 303);
  });

  it("refuses ids shaped like paths and malformed escapes", async () => {
    assert.equal((await req("/api/blobs/..%2F..%2Fconfig.toml")).status, 400);
    assert.equal((await req("/api/benchmarks/..%2F..%2Fconfig")).status, 400);
    assert.equal((await req("/api/sessions/a%00b")).status, 400);
    assert.equal((await req("/api/sessions/%E0%A4%A")).status, 400);
    assert.equal((await req("/api/workflows/planted")).status, 200, "a run in the runs folder");
    const above = await req("/api/workflows/..%2Fabove");
    assert.equal(above.status, 404, "a run id never names a file outside the runs folder");
    assert.doesNotMatch(above.body, /planted run/);
  });

  it("serves markup from a session escaped, under a CSP that runs no inline script", async () => {
    const page = await req("/");
    assert.equal(page.status, 200);
    const csp = String(page.headers["content-security-policy"]);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    for (const d of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
    assert.ok(page.body.includes("alert(1)"), "the first page shows the session's title");
    assert.ok(!page.body.includes("<img src=x"), "the title is escaped in the first page");
    assert.ok(!page.body.includes("<script>alert(2)"), "no script from the title");

    const api = await req("/api/sessions/x1/events");
    assert.equal(api.status, 200);
    assert.match(String(api.headers["content-type"]), /^application\/json/);
    assert.equal(api.headers["content-security-policy"], "default-src 'none'; sandbox; frame-ancestors 'none'");
    const blob = await req(`/api/blobs/${markupBlob}`);
    assert.equal(blob.status, 200);
    assert.doesNotMatch(String(blob.headers["content-type"]), /html/);
  });

  it("sends its hardening headers with the page and with every answer", async () => {
    for (const r of [await req("/"), await req("/api/sessions"), await req("/api/sessions", { auth: false })]) {
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
      assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
    }
    assert.equal((await req("/")).headers["cache-control"], "no-store");
    assert.equal((await req("/api/sessions")).headers["cache-control"], "no-store");
  });
});
