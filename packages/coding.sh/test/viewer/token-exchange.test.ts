// Trading a key for a viewer cookie: a link opened from the address bar or from the same site
// signs in; a link followed from another site does not until the user confirms with a POST from
// the viewer's own page; the key form posts, so the key never sits in a URL.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { FakeBlobs, FakeIndex } from "./fakes.ts";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

const form = (port: number, t: string, headers: Record<string, string> = {}) =>
  send(port, "/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...headers },
    body: new URLSearchParams({ t }).toString(),
  });

const cookieOf = (r: Res): string | undefined => (r.headers["set-cookie"] ? String(r.headers["set-cookie"]) : undefined);

describe("token exchange (local viewer)", () => {
  let v: Viewer;
  before(async () => {
    v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });

  for (const site of [undefined, "none", "same-origin"]) {
    test(`/?t= from ${site === undefined ? "a client that sends no Sec-Fetch-Site" : `Sec-Fetch-Site: ${site}`} signs in`, async () => {
      const r = await send(v.port, `/?t=${v.token}`, { headers: site ? { "sec-fetch-site": site } : {} });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, "/");
      assert.match(cookieOf(r) ?? "", /HttpOnly; SameSite=Strict/);
    });
  }

  test("/?t= followed from another site sets no cookie and asks the user to confirm with a POST", async () => {
    const r = await send(v.port, `/?t=${v.token}`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(cookieOf(r), undefined);
    assert.equal(r.status, 200);
    assert.match(r.body, /<form method=post action="\/">/);
    assert.match(String(r.headers["content-security-policy"]), /form-action 'self'/);
    assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(r.headers["cache-control"], "no-store");
  });

  test("a wrong key from another site gets the same confirm page, so it tells nothing", async () => {
    const good = await send(v.port, `/?t=${v.token}`, { headers: { "sec-fetch-site": "cross-site" } });
    const bad = await send(v.port, "/?t=wrong", { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(bad.status, good.status);
    assert.equal(cookieOf(bad), undefined);
  });

  test("a key in the confirm page is HTML-escaped", async () => {
    const r = await send(v.port, `/?t=${encodeURIComponent('"><script>x</script>')}`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.doesNotMatch(r.body, /<script>/);
    assert.match(r.body, /&quot;&gt;&lt;script&gt;/);
  });

  test("POST / with the key signs in and redirects with 303", async () => {
    const r = await form(v.port, v.token);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    const pair = (cookieOf(r) ?? "").split(";")[0]!;
    assert.ok(pair.includes(v.token));
    assert.equal((await send(v.port, "/api/stats", { headers: { cookie: pair } })).status, 200);
  });

  test("POST / with a wrong or missing key is 401 and sets no cookie", async () => {
    for (const r of [await form(v.port, "wrong"), await send(v.port, "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: "" })]) {
      assert.equal(r.status, 401);
      assert.equal(cookieOf(r), undefined);
    }
  });

  test("POST / from another origin or another site is 403", async () => {
    const foreign = await form(v.port, v.token, { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    assert.equal(cookieOf(foreign), undefined);
    const cross = await form(v.port, v.token, { origin: "null", "sec-fetch-site": "cross-site" });
    assert.equal(cross.status, 403);
    assert.equal(cookieOf(cross), undefined);
  });

  test("POST / takes only a small form body", async () => {
    const json = await send(v.port, "/", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ t: v.token }) });
    assert.equal(json.status, 415);
    const big = await form(v.port, "x".repeat(10_000));
    assert.equal(big.status, 413);
  });
});

describe("token exchange (serve)", () => {
  let h: ServeHandle;
  let root: string;
  const rk = generateKey("read");
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-token-exchange-"));
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_STORE_URL: "memory://", CODING_SH_LOG: "json", CODING_SH_INGEST_KEYS: `demo:${generateKey("ingest")}`, CODING_SH_READ_KEYS: rk };
    const cfg = resolveServeConfig({ port: 0 }, env);
    h = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() } });
  });
  after(async () => {
    await h.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  test("the key form posts, so the key never lands in a URL", async () => {
    const r = await send(h.port, "/", { headers: { accept: "text/html" } });
    assert.equal(r.status, 401);
    assert.match(r.body, /<form method=post action="\/"><input name=t /);
    assert.doesNotMatch(r.body, /method=get/);
    assert.match(String(r.headers["content-security-policy"]), /form-action 'self'/);
  });

  test("the form's POST signs in", async () => {
    const r = await form(h.port, rk);
    assert.equal(r.status, 303);
    assert.match(cookieOf(r) ?? "", /^csh_rk=.*HttpOnly; SameSite=Strict/);
  });

  test("/?t= followed from another site sets no cookie", async () => {
    const r = await send(h.port, `/?t=${rk}`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(cookieOf(r), undefined);
    assert.match(r.body, /<form method=post action="\/">/);
  });

  test("/?t= opened from the address bar still signs in", async () => {
    const r = await send(h.port, `/?t=${rk}`, { headers: { "sec-fetch-site": "none" } });
    assert.equal(r.status, 302);
    assert.match(cookieOf(r) ?? "", /^csh_rk=/);
  });
});

describe("token exchange over HTTPS (serve behind a TLS proxy)", () => {
  let h: ServeHandle;
  let plain: ServeHandle;
  let root: string;
  const rk = generateKey("read");
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-token-exchange-tls-"));
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_STORE_URL: "memory://", CODING_SH_LOG: "json", CODING_SH_INGEST_KEYS: `demo:${generateKey("ingest")}`, CODING_SH_READ_KEYS: rk };
    const start = (extra: NodeJS.ProcessEnv) =>
      startServe(resolveServeConfig({ port: 0 }, { ...env, ...extra }), { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() } });
    h = await start({ CODING_SH_TRUST_PROXY: "1" });
    plain = await start({});
  });
  after(async () => {
    await h.shutdown();
    await plain.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const https = { "x-forwarded-proto": "https" };

  test("an HTTPS sign-in sets a __Host- cookie marked Secure, and the cookie works", async () => {
    for (const r of [await send(h.port, `/?t=${rk}`, { headers: { ...https, "sec-fetch-site": "none" } }), await form(h.port, rk, https)]) {
      const cookie = cookieOf(r) ?? "";
      assert.match(cookie, /^__Host-csh_rk=csh_rk_[^;]+; HttpOnly; SameSite=Strict; Path=\/; Secure$/);
      const pair = cookie.split(";")[0]!;
      assert.equal((await send(h.port, "/api/sessions", { headers: { ...https, cookie: pair } })).status, 200);
    }
  });

  test("every HTTPS answer carries Strict-Transport-Security", async () => {
    for (const path of ["/", "/api/sessions", "/healthz", `/?t=${rk}`]) {
      const r = await send(h.port, path, { headers: https });
      assert.match(String(r.headers["strict-transport-security"]), /^max-age=31536000$/, path);
    }
  });

  test("a csh_rk cookie from before the upgrade still signs in over HTTPS", async () => {
    assert.equal((await send(h.port, "/api/sessions", { headers: { ...https, cookie: `csh_rk=${rk}` } })).status, 200);
  });

  test("plain HTTP on loopback keeps the csh_rk cookie, without Secure or HSTS", async () => {
    for (const port of [h.port, plain.port]) {
      const r = await send(port, `/?t=${rk}`, { headers: { "sec-fetch-site": "none" } });
      const cookie = cookieOf(r) ?? "";
      assert.match(cookie, /^csh_rk=csh_rk_[^;]+; HttpOnly; SameSite=Strict; Path=\/$/);
      assert.equal(r.headers["strict-transport-security"], undefined);
      assert.equal((await send(port, "/api/sessions", { headers: { cookie: cookie.split(";")[0]! } })).status, 200);
    }
  });

  test("X-Forwarded-Proto counts only with trust_proxy set", async () => {
    const r = await send(plain.port, `/?t=${rk}`, { headers: { ...https, "sec-fetch-site": "none" } });
    assert.match(cookieOf(r) ?? "", /^csh_rk=/);
    assert.equal(r.headers["strict-transport-security"], undefined);
  });
});
