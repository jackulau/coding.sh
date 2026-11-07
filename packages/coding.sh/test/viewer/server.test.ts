import assert from "node:assert/strict";
import { request as httpRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { BLOB_CAP_BYTES, MAX_BODY_BYTES, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { FakeBlobs, FakeIndex, event, session } from "./fakes.ts";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): any;
}

function req(
  v: Viewer,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; auth?: boolean; fresh?: boolean } = {},
): Promise<Res> {
  const headers: Record<string, string> = { host: `127.0.0.1:${v.port}`, ...opts.headers };
  if (opts.auth !== false && !headers.authorization && !headers.cookie) headers.authorization = `Bearer ${v.token}`;
  return new Promise((resolve, reject) => {
    const agent = opts.fresh ? false : undefined;
    const r = httpRequest({ host: "127.0.0.1", port: v.port, path, method: opts.method ?? "GET", headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
      });
      res.on("error", reject);
    });
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

const post = (v: Viewer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(v, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("viewer server", () => {
  const index = new FakeIndex();
  const blobs = new FakeBlobs();
  let v: Viewer;
  let smallBlob: string;
  let bigBlob: string;

  before(async () => {
    for (let i = 0; i < 7; i++) {
      await index.upsertSession(
        session(`s${i}`, {
          startedAt: 1_700_000_000_000 + i * 60_000,
          agent: i % 2 ? "codex" : "claude-code",
          flags: i === 3 ? ["premature-completion"] : [],
          repo: { root: i < 4 ? "/work/api" : "/work/web", head: "abc1234" },
        }),
      );
    }
    await index.putEvents([
      event("s0", 1, { payload: { text: "add retry with backoff" } }),
      event("s0", 2, { kind: "tool.start", payload: { tool: "Read", toolUseId: "t1", input: { file_path: "a.ts" } } }),
      event("s0", 3, { kind: "tool.end", payload: { tool: "Read", toolUseId: "t1", ok: true } }),
    ]);
    smallBlob = await blobs.put("<script>alert(1)</script>\n+ added line\n");
    bigBlob = await blobs.put(new Uint8Array(BLOB_CAP_BYTES + 1000).fill(97));
    v = await startViewer({ index, blobs, port: 0 });
  });
  after(async () => {
    await v.close();
  });

  test("binds loopback and prints a tokenised URL", () => {
    assert.match(v.url, new RegExp(`^http://127\\.0\\.0\\.1:${v.port}/\\?t=[A-Za-z0-9_-]{40,}$`));
  });

  describe("auth", () => {
    test("API without token is 401", async () => {
      const r = await req(v, "/api/sessions", { auth: false });
      assert.equal(r.status, 401);
      assert.equal(r.json().error, "missing or invalid token");
    });
    test("API with wrong bearer is 401", async () => {
      const r = await req(v, "/api/sessions", { headers: { authorization: "Bearer nope" } });
      assert.equal(r.status, 401);
    });
    test("page without token is 401 and leaks nothing", async () => {
      const r = await req(v, "/", { auth: false });
      assert.equal(r.status, 401);
      assert.doesNotMatch(r.body, /__CSP_NONCE__|<script/);
    });
    test("bad ?t= is rejected without setting a cookie", async () => {
      const r = await req(v, "/?t=wrong", { auth: false });
      assert.equal(r.status, 401);
      assert.equal(r.headers["set-cookie"], undefined);
    });
    test("?t= sets a strict HttpOnly cookie and redirects; cookie then authorises", async () => {
      const r = await req(v, `/?t=${v.token}`, { auth: false });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, "/");
      const cookie = String(r.headers["set-cookie"]);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      const pair = cookie.split(";")[0]!;
      const page = await req(v, "/", { headers: { cookie: pair } });
      assert.equal(page.status, 200);
      assert.match(String(page.headers["content-type"]), /text\/html/);
      const api = await req(v, "/api/stats", { headers: { cookie: `other=1; ${pair}` } });
      assert.equal(api.status, 200);
    });
    test("query-string token does not authorise the API", async () => {
      const r = await req(v, `/api/sessions?t=${v.token}`, { auth: false });
      assert.equal(r.status, 401);
    });
  });

  describe("host / origin checks", () => {
    for (const host of ["evil.example:80", `evil.example:${0}`, "127.0.0.1:1", "localhost", ""]) {
      test(`Host ${JSON.stringify(host)} is 403 even with a valid token`, async () => {
        const r = await req(v, "/api/sessions", { headers: { host: host || "x" } });
        assert.equal(r.status, 403);
      });
    }
    test("localhost:<port> is accepted", async () => {
      const r = await req(v, "/api/stats", { headers: { host: `localhost:${v.port}` } });
      assert.equal(r.status, 200);
    });
    test("cross-origin POST is 403", async () => {
      const r = await post(v, "/api/labels", { sessionId: "s0", criterion: "outcome", value: "pass" }, { origin: "http://evil.example" });
      assert.equal(r.status, 403);
    });
  });

  describe("headers", () => {
    test("page has a strict nonce CSP and the nonce is injected", async () => {
      const r = await req(v, "/");
      const csp = String(r.headers["content-security-policy"]);
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce, csp);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
      assert.ok(r.body.includes(`<script nonce="${nonce}">`));
      assert.ok(!r.body.includes("__CSP_NONCE__"));
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      const again = await req(v, "/");
      assert.notEqual(String(again.headers["content-security-policy"]), csp, "nonce is per response");
    });
  });

  describe("sessions", () => {
    test("pagination with hasMore", async () => {
      const p1 = (await req(v, "/api/sessions?limit=3")).json();
      assert.deepEqual(p1.items.map((s: any) => s.id), ["s6", "s5", "s4"]);
      assert.equal(p1.hasMore, true);
      const p3 = (await req(v, "/api/sessions?limit=3&offset=6")).json();
      assert.deepEqual(p3.items.map((s: any) => s.id), ["s0"]);
      assert.equal(p3.hasMore, false);
      const exact = (await req(v, "/api/sessions?limit=7")).json();
      assert.equal(exact.items.length, 7);
      assert.equal(exact.hasMore, false);
    });
    test("filters by agent, flag, repo and q", async () => {
      const codex = (await req(v, "/api/sessions?agent=codex")).json();
      assert.deepEqual(codex.items.map((s: any) => s.id), ["s5", "s3", "s1"]);
      const flagged = (await req(v, "/api/sessions?flag=premature-completion")).json();
      assert.deepEqual(flagged.items.map((s: any) => s.id), ["s3"]);
      const web = (await req(v, `/api/sessions?repo=${encodeURIComponent("/work/web")}`)).json();
      assert.deepEqual(web.items.map((s: any) => s.id), ["s6", "s5", "s4"]);
      const q = (await req(v, "/api/sessions?q=SESSION%20s2")).json();
      assert.deepEqual(q.items.map((s: any) => s.id), ["s2"]);
      const qPaged = (await req(v, "/api/sessions?q=session&limit=2&offset=1")).json();
      assert.deepEqual(qPaged.items.map((s: any) => s.id), ["s5", "s4"]);
      assert.equal(qPaged.hasMore, true);
    });
    test("bad limit/offset are 400", async () => {
      for (const qs of ["limit=0", "limit=-1", "limit=abc", "limit=501", "offset=1.5", "offset=-3"]) {
        const r = await req(v, `/api/sessions?${qs}`);
        assert.equal(r.status, 400, qs);
        assert.ok(r.json().error);
      }
    });
    test("get one, events, 404s", async () => {
      assert.equal((await req(v, "/api/sessions/s0")).json().id, "s0");
      const ev = (await req(v, "/api/sessions/s0/events")).json();
      assert.deepEqual(ev.items.map((e: any) => e.kind), ["user.message", "tool.start", "tool.end"]);
      const paged = (await req(v, "/api/sessions/s0/events?limit=2")).json();
      assert.equal(paged.items.length, 2);
      assert.equal(paged.hasMore, true);
      assert.equal((await req(v, "/api/sessions/nope")).status, 404);
      assert.equal((await req(v, "/api/sessions/nope/events")).status, 404);
      assert.equal((await req(v, "/api/sessions/s0/bogus")).status, 404);
      assert.equal((await req(v, "/api/nothing")).status, 404);
      assert.equal((await req(v, "/api/sessions/%E0%A4%A")).status, 400);
    });
    test("wrong method is 405", async () => {
      assert.equal((await req(v, "/api/sessions", { method: "DELETE" })).status, 405);
    });
  });

  describe("search, stats, tasks, runs", () => {
    test("search requires q and returns hits", async () => {
      assert.equal((await req(v, "/api/search")).status, 400);
      const r = (await req(v, "/api/search?q=retry")).json();
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].event.sessionId, "s0");
    });
    test("stats counts by agent, flag and repo", async () => {
      const s = (await req(v, "/api/stats")).json();
      assert.equal(s.sessions, 7);
      assert.deepEqual(s.byAgent, { "claude-code": 4, codex: 3 });
      assert.deepEqual(s.byFlag, { "premature-completion": 1 });
      assert.deepEqual(s.byRepo, { "/work/api": 4, "/work/web": 3 });
    });
    test("tasks, runs (filtered by experimentId), bundles", async () => {
      const run = (id: string, experimentId: string, pass: boolean) => ({
        id, experimentId, taskId: "t1", bundleId: "b1", attempt: 1, pass, verifierExit: pass ? 0 : 1,
        agent: { exitCode: 0, timedOut: false, durationMs: 10, stdoutTail: "", stderrTail: "" },
        startedAt: 1, endedAt: 2,
      });
      await index.putRun(run("r1", "exp-a", true));
      await index.putRun(run("r2", "exp-b", false));
      await index.putBundle({ id: "b1", name: "baseline", agent: "claude-code", flags: [], env: { SECRET: "x" }, files: {}, remove: [], createdAt: 1 });
      assert.deepEqual((await req(v, "/api/runs?experimentId=exp-a")).json().items.map((r: any) => r.id), ["r1"]);
      assert.equal((await req(v, "/api/runs")).json().items.length, 2);
      const b = (await req(v, "/api/bundles")).json().items[0];
      assert.equal(b.name, "baseline");
      assert.equal(b.env, undefined, "bundle env is not exposed");
      assert.deepEqual((await req(v, "/api/tasks")).json(), { items: [] });
      assert.equal((await req(v, "/api/tasks?status=bogus")).status, 400);
    });
  });

  describe("labels", () => {
    test("POST round trip, relabel replaces", async () => {
      const r = await post(v, "/api/labels", { sessionId: "s0", criterion: "outcome", value: "fail", note: "stopped early" });
      assert.equal(r.status, 201);
      const label = r.json();
      assert.equal(label.value, "fail");
      assert.equal(label.note, "stopped early");
      assert.equal(typeof label.by, "string");
      assert.ok(label.by.length > 0);
      const again = (await post(v, "/api/labels", { sessionId: "s0", criterion: "outcome", value: "pass" })).json();
      assert.equal(again.id, label.id);
      const list = (await req(v, "/api/labels?sessionId=s0")).json().items;
      assert.equal(list.length, 1);
      assert.equal(list[0].value, "pass");
      assert.deepEqual((await req(v, "/api/labels?sessionId=s1")).json().items, []);
    });
    test("validation errors", async () => {
      const cases: [unknown, number][] = [
        [{ sessionId: "s0", criterion: "outcome", value: "maybe" }, 400],
        [{ criterion: "outcome", value: "pass" }, 400],
        [{ sessionId: "s0", criterion: "<b>", value: "pass" }, 400],
        [{ sessionId: "s0", value: "pass", note: 5 }, 400],
        [[1, 2], 400],
        ["{not json", 400],
        [{ sessionId: "missing", criterion: "outcome", value: "pass" }, 404],
      ];
      for (const [body, status] of cases) {
        const r = await post(v, "/api/labels", body);
        assert.equal(r.status, status, JSON.stringify(body));
        assert.ok(r.json().error);
      }
      const noType = await req(v, "/api/labels", { method: "POST", body: "{}" });
      assert.equal(noType.status, 415);
    });
    test("body over 1 MB is 413", async () => {
      const big = JSON.stringify({ sessionId: "s0", value: "pass", note: "x".repeat(MAX_BODY_BYTES) });
      const r = await post(v, "/api/labels", big);
      assert.equal(r.status, 413);
    });
  });

  describe("blobs", () => {
    test("served as text/plain, never as HTML", async () => {
      const r = await req(v, `/api/blobs/${smallBlob}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.match(String(r.headers["content-security-policy"]), /sandbox/);
      assert.equal(r.body, "<script>alert(1)</script>\n+ added line\n");
      assert.equal(r.headers["x-truncated"], "0");
    });
    test("capped at 2 MB unless ?full=1", async () => {
      const capped = await req(v, `/api/blobs/${bigBlob}`);
      assert.equal(capped.body.length, BLOB_CAP_BYTES);
      assert.equal(capped.headers["x-truncated"], "1");
      assert.equal(capped.headers["x-blob-size"], String(BLOB_CAP_BYTES + 1000));
      const full = await req(v, `/api/blobs/${bigBlob}?full=1`);
      assert.equal(full.body.length, BLOB_CAP_BYTES + 1000);
      assert.equal(full.headers["x-truncated"], "0");
    });
    test("unknown blob is 404", async () => {
      assert.equal((await req(v, `/api/blobs/${"0".repeat(64)}`)).status, 404);
    });
    test("path traversal and malformed refs are rejected", async () => {
      const attempts = [
        "/api/blobs/..%2F..%2Fetc%2Fpasswd",
        "/api/blobs/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "/api/blobs/..",
        `/api/blobs/${"a".repeat(63)}`,
        `/api/blobs/${"a".repeat(65)}`,
        `/api/blobs/${"A".repeat(64)}`,
        `/api/blobs/${"a".repeat(62)}%2F`,
        `/api/blobs/${smallBlob}%00`,
        `/api/blobs/${smallBlob.slice(0, 60)}..%5C`,
        `/api/blobs/${smallBlob}/extra`,
      ];
      for (const path of attempts) {
        const r = await req(v, path);
        assert.ok(r.status === 400 || r.status === 404, `${path} → ${r.status}`);
        assert.notEqual(r.status, 200);
      }
      // Dot segments are normalised away by the URL parser and land outside the API.
      const dots = await req(v, "/api/blobs/../../../etc/passwd");
      assert.equal(dots.status, 404);
    });
  });
});

describe("viewer server: subagent sessions", () => {
  const index = new FakeIndex();
  let v: Viewer;
  before(async () => {
    await index.upsertSession(session("p", { startedAt: 1_700_000_000_000, agent: "claude-code", repo: { root: "/work/api", head: "abc1234" } }));
    await index.upsertSession(session("q", { startedAt: 1_700_000_010_000, agent: "codex", repo: { root: "/work/web", head: "abc1234" } }));
    for (const [i, id] of ["p:sub:a", "p:sub:b"].entries()) {
      await index.upsertSession(
        session(id, { startedAt: 1_700_000_100_000 + i, agent: "claude-code", repo: { root: "/work/api", head: "abc1234" }, parent: { sessionId: "p", subagentId: id.slice(-1) } }),
      );
    }
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });

  test("scope=top lists top-level sessions with their subagent counts", async () => {
    const all = (await req(v, "/api/sessions")).json();
    assert.deepEqual(all.items.map((s: any) => s.id), ["p:sub:b", "p:sub:a", "q", "p"], "default lists every session");
    const top = (await req(v, "/api/sessions?scope=top")).json();
    assert.deepEqual(top.items.map((s: any) => [s.id, s.childCount]), [["q", 0], ["p", 2]]);
    const filtered = (await req(v, "/api/sessions?scope=top&q=session%20p")).json();
    assert.deepEqual(filtered.items.map((s: any) => s.id), ["p"]);
    assert.equal((await req(v, "/api/sessions?scope=bogus")).status, 400);
  });
  test("parent=<id> lists a session's subagents", async () => {
    const kids = (await req(v, "/api/sessions?parent=p")).json();
    assert.deepEqual(kids.items.map((s: any) => s.id), ["p:sub:b", "p:sub:a"]);
    assert.equal(kids.items[0].parent.sessionId, "p");
    assert.deepEqual((await req(v, "/api/sessions?parent=q")).json().items, []);
  });
  test("stats count subagents; scope=top scopes the facets", async () => {
    const all = (await req(v, "/api/stats")).json();
    assert.equal(all.sessions, 4);
    assert.equal(all.subagents, 2);
    assert.deepEqual(all.byAgent, { "claude-code": 3, codex: 1 });
    const top = (await req(v, "/api/stats?scope=top")).json();
    assert.equal(top.sessions, 2);
    assert.equal(top.subagents, 2);
    assert.deepEqual(top.byAgent, { "claude-code": 1, codex: 1 });
    assert.deepEqual(top.byRepo, { "/work/api": 1, "/work/web": 1 });
    assert.equal(top.toolCalls, all.toolCalls, "tool totals still cover every session");
  });
});

describe("viewer lifecycle", () => {
  test("tries the next port when busy", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as AddressInfo).port;
    const v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: busy });
    try {
      assert.ok(v.port > busy && v.port <= busy + 10, `${v.port} vs ${busy}`);
      const r = await req(v, "/api/stats");
      assert.equal(r.status, 200);
      // Host for the busy port no longer matches.
      assert.equal((await req(v, "/api/stats", { headers: { host: `127.0.0.1:${busy}` } })).status, 403);
    } finally {
      await v.close();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  test("closes cleanly with open keep-alive connections", async () => {
    const v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0 });
    const r = await req(v, "/api/stats", { headers: { connection: "keep-alive" } });
    assert.equal(r.status, 200);
    const t0 = Date.now();
    await v.close();
    await v.close(); // idempotent
    assert.ok(Date.now() - t0 < 1000);
    await assert.rejects(req(v, "/api/stats", { fresh: true }), /ECONNREFUSED/);
  });

  test("500s are JSON and do not leak internals", async () => {
    const index = new FakeIndex();
    index.listSessions = async () => {
      throw new Error("db exploded at /secret/path");
    };
    const v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
    const original = process.emitWarning;
    process.emitWarning = () => {};
    try {
      const r = await req(v, "/api/sessions");
      assert.equal(r.status, 500);
      assert.deepEqual(r.json(), { error: "internal error", status: 500 });
    } finally {
      process.emitWarning = original;
      await v.close();
    }
  });
});
