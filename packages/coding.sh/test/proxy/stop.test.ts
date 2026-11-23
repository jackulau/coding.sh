// The proxy's stop path, where `proxy stop` POSTs the secret from the proxy's state file. Anything
// without that secret is answered by the proxy itself: never forwarded, and the proxy keeps
// running. And close(), which a stop runs: the calls in flight finish, and nothing after.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, describe, it } from "node:test";
import { STOP_HEADER, STOP_PATH, startProxy, type ProxyServer } from "../../src/proxy/server.ts";
import { probeProxy, requestStop } from "../../src/proxy/state.ts";
import { anthropicStream, call, sleep, startUpstream, type Upstream } from "./_helpers.ts";

const ups: Upstream[] = [];
const proxies: ProxyServer[] = [];
after(async () => {
  for (const p of proxies) if (p.server.listening) await p.close();
  for (const u of ups) await u.close();
});

async function upstream(handle: Parameters<typeof startUpstream>[0]): Promise<Upstream> {
  const up = await startUpstream(handle);
  ups.push(up);
  return up;
}

async function proxy(o: Parameters<typeof startProxy>[0]): Promise<ProxyServer> {
  const p = await startProxy(o);
  proxies.push(p);
  return p;
}

const messages = JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 5, messages: [{ role: "user", content: "hi" }] });

describe("proxy: the stop path", () => {
  it("answers a request without the right secret itself: not forwarded, onStop not called, still running", async () => {
    const up = await upstream((_r, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const secret = randomBytes(32).toString("hex");
    let stops = 0;
    const p = await proxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url }, stop: { secret, onStop: () => stops++ } });
    const refused: [string, { method?: string; path?: string; headers?: Record<string, string> }, number][] = [
      ["no secret", {}, 403],
      ["a wrong secret of the same length", { headers: { [STOP_HEADER]: randomBytes(32).toString("hex") } }, 403],
      ["a wrong secret of another length", { headers: { [STOP_HEADER]: secret.slice(0, 10) } }, 403],
      ["the secret with more after it", { headers: { [STOP_HEADER]: `${secret}0` } }, 403],
      ["the secret in the query", { path: `${STOP_PATH}?secret=${secret}` }, 403],
      // Browsers send an Origin; the page's own server or a local one gets no further.
      ["the secret from a web page", { headers: { [STOP_HEADER]: secret, origin: "https://example.com" } }, 403],
      ["the secret from a local page", { headers: { [STOP_HEADER]: secret, origin: "http://localhost:3000" } }, 403],
      ["a GET", { method: "GET", headers: { [STOP_HEADER]: secret } }, 405],
      ["a CORS preflight", { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST", "access-control-request-headers": STOP_HEADER } }, 405],
    ];
    for (const [what, o, status] of refused) {
      const r = await call(p.url, { method: o.method ?? "POST", path: o.path ?? STOP_PATH, headers: o.headers });
      assert.equal(r.status, status, what);
      // No CORS headers: a preflight fails, so a page's POST with the header never goes out.
      assert.equal(r.headers["access-control-allow-origin"], undefined, what);
      assert.equal(r.headers["access-control-allow-headers"], undefined, what);
      assert.match(r.body.toString(), /coding\.sh proxy/, what);
    }
    assert.equal(up.seen.length, 0);
    assert.equal(stops, 0);
    assert.ok(await probeProxy(p.url), "still answers");
    // And still forwards calls.
    const r = await call(p.url, { path: "/v1/messages", body: messages, headers: { "content-type": "application/json" } });
    assert.equal(r.status, 200);
    assert.equal(up.seen.length, 1);
  });

  it("calls onStop for a POST with the right secret, which requestStop sends", async () => {
    const secret = randomBytes(32).toString("hex");
    let stops = 0;
    const p = await proxy({ port: 0, stop: { secret, onStop: () => stops++ } });
    const r = await call(p.url, { path: STOP_PATH, headers: { [STOP_HEADER]: secret } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), { ok: true, stopping: true });
    assert.equal(stops, 1);
    assert.equal(await requestStop(p.url, secret), 200);
    assert.equal(stops, 2);
    assert.equal(await requestStop(p.url, secret.toUpperCase()), 403);
    assert.equal(stops, 2);
  });

  it("is a 404 on a proxy started with no stop secret (serve's), and is not forwarded", async () => {
    const up = await upstream((_r, res) => {
      res.writeHead(200).end("{}");
    });
    const p = await proxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url } });
    assert.equal(await requestStop(p.url, "anything"), 404);
    assert.equal(up.seen.length, 0);
  });

  it("requestStop resolves 0 when nothing answers", async () => {
    const p = await proxy({ port: 0 });
    await p.close();
    assert.equal(await requestStop(p.url, "anything", 1000), 0);
  });
});

/** A streamed call over `agent`; `onData` runs for each chunk. */
function keepAliveCall(base: string, agent: http.Agent, onData?: () => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL("/v1/messages", base), { method: "POST", agent, headers: { "content-type": "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => {
        body += d;
        onData?.();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(messages);
  });
}

describe("proxy: close()", () => {
  it("lets a call in flight finish, then closes its keep-alive connection: a later call on it is not served", async () => {
    const parts = anthropicStream({ text: "finished" });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const up = await upstream(async (_r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(parts[0]);
      // Only the first call is held until the test lets it go.
      if (++calls === 1) await held;
      for (const s of parts.slice(1)) res.write(s);
      res.end();
    });
    const p = await proxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url } });
    // A client that keeps its connection open for the next call, as agents' SDKs do.
    const agent = new http.Agent({ keepAlive: true });
    try {
      let first: () => void = () => {};
      const started = new Promise<void>((r) => (first = r));
      const inFlight = keepAliveCall(p.url, agent, () => first());
      await started;
      let closedAt = 0;
      const closing = p.close().then(() => (closedAt = Date.now()));
      release();
      const r = await inFlight;
      const endedAt = Date.now();
      assert.equal(r.status, 200);
      assert.equal(r.body, parts.join(""));
      await sleep(400);
      await assert.rejects(keepAliveCall(p.url, agent), "a call after close() began is not served");
      assert.equal(up.seen.length, 1);
      await closing;
      // Not when the client or the server's keep-alive timeout (5 s) gets to the connection.
      assert.ok(closedAt - endedAt < 2000, `closed ${closedAt - endedAt} ms after the call ended`);
    } finally {
      release();
      agent.destroy();
    }
  });
});
