import assert from "node:assert/strict";
import { request as httpRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBench } from "../../src/bench/run.ts";
import { runsDir } from "../../src/bench/store.ts";
import { benchmarkDir, BLOB_CAP_BYTES, MAX_BODY_BYTES, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { cleanup as benchCleanup, day, project } from "../bench/helpers.ts";
import { FakeBlobs, FakeIndex, event, experimentResult, failedRequestFixtures, session } from "./fakes.ts";

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

// Regression: API sessions with a failed request lost their red mark in the list.
// The list reads stats.llmErrors from the session row (computed at ingest), and a
// page costs the same store calls whatever its length (no per-row lookups).
describe("viewer server: failed requests and list query count", () => {
  let index: SqliteIndexStore;
  let v: Viewer;
  const calls: string[] = [];
  before(async () => {
    index = await SqliteIndexStore.open(":memory:");
    const { sessions, events } = failedRequestFixtures(1_700_000_500_000);
    await index.putEvents(events);
    for (const s of sessions) await index.upsertSession(s);
    for (let i = 0; i < 30; i++) {
      await index.upsertSession(session(`top${i}`, { startedAt: 1_700_000_000_000 + i * 1000 }));
      await index.upsertSession(session(`top${i}:sub`, { startedAt: 1_700_000_000_000 + i * 1000 + 1, parent: { sessionId: `top${i}` } }));
    }
    // Every store method call made while serving a request.
    const counted = new Proxy(index, {
      get(target, key, recv) {
        const val = Reflect.get(target, key, recv);
        return typeof val === "function" ? (...args: unknown[]) => (calls.push(String(key)), val.apply(target, args)) : val;
      },
    });
    v = await startViewer({ index: counted, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
    await index.close();
  });

  test("API rows carry stats.llmErrors: count, first status and message", async () => {
    const items = (await req(v, "/api/sessions?limit=500")).json().items;
    const failed = items.find((s: any) => s.id === "api-429");
    assert.deepEqual(failed.stats.llmErrors, { count: 1, statusCode: 429, error: "429 Rate limit reached for gpt-5-mini on tokens per min" });
    assert.equal(items.find((s: any) => s.id === "api-ok").stats.llmErrors, undefined);
  });

  test("the list makes as many store calls for 40 rows as for 2", async () => {
    const count = async (path: string) => {
      calls.length = 0;
      const body = (await req(v, path)).json();
      return { rows: body.items.length, calls: [...calls] };
    };
    for (const scope of ["", "&scope=top"]) {
      const small = await count(`/api/sessions?limit=2${scope}`);
      const big = await count(`/api/sessions?limit=40${scope}`);
      assert.equal(small.rows, 2);
      assert.ok(big.rows > 30, `${big.rows} rows`);
      assert.deepEqual(big.calls, small.calls, `scope${scope || "=all"}: ${big.calls.join(", ")}`);
    }
    const top = (await req(v, "/api/sessions?limit=40&scope=top")).json().items;
    assert.equal(top.find((s: any) => s.id === "top3").childCount, 1);
    assert.equal(top.find((s: any) => s.id === "api-429").childCount, 0);
  });
});

// Regression: `coding.sh exp run` results stored in the index (sqlite, postgres)
// never reached the viewer, which had no /api/experiments route.
describe("viewer server: dataset experiments", () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  before(async () => {
    await index.putExperiment(experimentResult("exp-1", { name: "baseline", createdAt: 1 }));
    await index.putExperiment(experimentResult("exp-2", { runs: [{ ...experimentResult("x").runs[0]!, output: "y".repeat(10_000) }] }));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });

  test("lists experiments from the index, newest id first, without per-case runs", async () => {
    const r = await req(v, "/api/experiments");
    assert.equal(r.status, 200);
    const items = r.json().items;
    assert.deepEqual(items.map((e: any) => e.id), ["exp-2", "exp-1"]);
    assert.equal(items[1].name, "baseline");
    assert.equal(items[1].runCount, 2);
    assert.equal(items[1].runs, undefined, "list rows leave out runs");
    assert.equal(items[1].summary.passRate.p, 0.5);
    assert.deepEqual((await req(v, "/api/experiments?name=baseline")).json().items.map((e: any) => e.id), ["exp-1"]);
    assert.deepEqual((await req(v, "/api/experiments?limit=1")).json().items.map((e: any) => e.id), ["exp-2"]);
    assert.equal((await req(v, "/api/experiments?limit=0")).status, 400);
  });

  test("detail returns case runs with long outputs clipped", async () => {
    const old = (await req(v, "/api/experiments/exp-1")).json();
    assert.deepEqual(old.runs.map((r: any) => [r.caseId, r.pass]), [["c1", true], ["c2", false]]);
    assert.equal(old.runsTruncated, false);
    const big = (await req(v, "/api/experiments/exp-2")).json();
    assert.equal(big.runs[0].output.length, 4000);
    assert.equal(big.runs[0].outputTruncated, true);
  });

  test("bad ids are 400, unknown ids 404, writes 405, auth required", async () => {
    assert.equal((await req(v, "/api/experiments/..%2Fetc")).status, 400);
    assert.equal((await req(v, "/api/experiments/nope")).status, 404);
    assert.equal((await req(v, "/api/experiments/exp-1/runs")).status, 404);
    assert.equal((await req(v, "/api/experiments", { method: "POST" })).status, 405);
    assert.equal((await req(v, "/api/experiments", { auth: false })).status, 401);
  });

  test("an index without experiment tables lists none; an explicit source is used", async () => {
    const bare = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0 });
    const src = await startViewer({
      index: new FakeIndex(),
      blobs: new FakeBlobs(),
      port: 0,
      experiments: { listExperiments: async () => [experimentResult("from-files")], getExperiment: async (id) => (id === "from-files" ? experimentResult(id) : undefined) },
    });
    try {
      assert.deepEqual((await req(bare, "/api/experiments")).json(), { items: [] });
      assert.equal((await req(bare, "/api/experiments/x")).status, 404);
      assert.deepEqual((await req(src, "/api/experiments")).json().items.map((e: any) => e.id), ["from-files"]);
      assert.equal((await req(src, "/api/experiments/from-files")).json().runs.length, 2);
    } finally {
      await bare.close();
      await src.close();
    }
  });
});

// Regression VWR-1: "Load more" paged by offset over a list that ingest keeps
// reordering, so a session that landed between pages repeated a row.
describe("viewer server: keyset pagination", () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  const T = 1_700_000_000_000;
  before(async () => {
    // s2 and s3 share a start time, so the cursor must break ties by id.
    const starts = [0, 1, 2, 2, 3, 4, 5].map((n) => T + n * 60_000);
    for (const [i, startedAt] of starts.entries()) await index.upsertSession(session(`s${i}`, { startedAt }));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });

  test("nextCursor pages without repeats or gaps while newer sessions land", async () => {
    const before_ = (await req(v, "/api/sessions?limit=50")).json().items.map((s: any) => s.id);
    const seen: string[] = [];
    let page = (await req(v, "/api/sessions?limit=3")).json();
    seen.push(...page.items.map((s: any) => s.id));
    let n = 0;
    while (page.hasMore) {
      assert.equal(typeof page.nextCursor, "string", "a page with more rows carries a cursor");
      // A session is ingested between every two pages.
      await index.upsertSession(session(`new${n++}`, { startedAt: T + 3_600_000 + n }));
      page = (await req(v, `/api/sessions?limit=3&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
      seen.push(...page.items.map((s: any) => s.id));
    }
    assert.equal(page.nextCursor, undefined, "the last page has no cursor");
    assert.deepEqual(seen, before_, "every pre-existing session once, in order");
  });

  test("a cursor works with filters, and a malformed one is 400", async () => {
    const p1 = (await req(v, "/api/sessions?scope=top&agent=claude-code&limit=2")).json();
    const p2 = (await req(v, `/api/sessions?scope=top&agent=claude-code&limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    assert.equal(p2.items.filter((s: any) => p1.items.some((x: any) => x.id === s.id)).length, 0);
    for (const c of ["nope", "123", "abc:def", "-5:x"]) assert.equal((await req(v, `/api/sessions?cursor=${c}`)).status, 400, c);
  });
});

describe("viewer server: facets, time range and model", () => {
  const index = new FakeIndex();
  const H = 3_600_000;
  const t0 = 1_762_000_000_000;
  let v: Viewer;
  before(async () => {
    await index.upsertSession(session("a", { startedAt: t0, model: "opus", flags: ["no-verification"] }));
    await index.upsertSession(session("b", { startedAt: t0 + 2 * H, model: "sonnet" }));
    await index.upsertSession(session("c", { startedAt: t0 + 5 * H, model: "opus", agent: "codex", repo: { root: "/work/web", head: "abc1234" } }));
    await index.upsertSession(session("c:sub", { startedAt: t0 + 5 * H, model: "haiku", parent: { sessionId: "c", subagentId: "x" } }));
    await index.putEvents(["a", "b", "c"].map((id) => event(id, 1, { payload: { text: "fix the queue" } })));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });

  test("each facet counts with every other filter applied but its own", async () => {
    const s = (await req(v, "/api/stats?scope=top&model=opus")).json();
    assert.equal(s.sessions, 2);
    assert.deepEqual(s.byModel, { opus: 2, sonnet: 1 }, "the model facet ignores the model filter");
    assert.deepEqual(s.byAgent, { "claude-code": 1, codex: 1 });
    assert.deepEqual(s.byRepo, { "/work/api": 1, "/work/web": 1 });
    const both = (await req(v, "/api/stats?scope=top&model=opus&agent=codex")).json();
    assert.equal(both.sessions, 1);
    assert.deepEqual(both.byModel, { opus: 1 });
    assert.deepEqual(both.byAgent, { "claude-code": 1, codex: 1 });
  });

  test("the histogram ignores the time range but honours other filters", async () => {
    const s = (await req(v, `/api/stats?scope=top&since=${t0 + H}`)).json();
    assert.equal(s.sessions, 2);
    const total = s.histogram.buckets.reduce((n: number, b: any) => n + b.n, 0);
    assert.equal(total, 3, "all three top-level sessions are charted");
    assert.ok(s.histogram.buckets.length <= 60);
    assert.equal(s.histogram.buckets.reduce((n: number, b: any) => n + b.flagged, 0), 1);
    for (const b of s.histogram.buckets) assert.equal((b.t - s.histogram.from) % s.histogram.step, 0);
    const codex = (await req(v, "/api/stats?scope=top&agent=codex")).json();
    assert.equal(codex.histogram.buckets.reduce((n: number, b: any) => n + b.n, 0), 1);
    assert.deepEqual((await req(v, "/api/stats?scope=top&agent=nobody")).json().histogram.buckets, []);
  });

  test("the list, its cursor and search honour since, until and model", async () => {
    const ids = async (path: string) => (await req(v, path)).json().items.map((x: any) => x.id ?? x.event.sessionId);
    assert.deepEqual(await ids(`/api/sessions?scope=top&since=${t0 + H}`), ["c", "b"]);
    assert.deepEqual(await ids(`/api/sessions?scope=top&until=${t0 + 3 * H}`), ["b", "a"]);
    assert.deepEqual(await ids(`/api/sessions?scope=top&model=opus`), ["c", "a"]);
    const p1 = (await req(v, `/api/sessions?scope=top&model=opus&limit=1`)).json();
    assert.deepEqual([p1.items[0].id, p1.hasMore], ["c", true]);
    assert.deepEqual(await ids(`/api/sessions?scope=top&model=opus&limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`), ["a"]);
    const p2 = (await req(v, `/api/sessions?scope=top&until=${t0 + 3 * H}&limit=1`)).json();
    assert.deepEqual(await ids(`/api/sessions?scope=top&until=${t0 + 3 * H}&limit=1&cursor=${encodeURIComponent(p2.nextCursor)}`), ["a"]);
    assert.deepEqual((await ids(`/api/search?q=queue&model=opus`)).sort(), ["a", "c"]);
    assert.deepEqual(await ids(`/api/search?q=queue&since=${t0 + H}&until=${t0 + 3 * H}`), ["b"]);
    assert.equal((await req(v, "/api/sessions?since=soon")).status, 400);
  });
});

describe("viewer server: experiment compare", () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  const run = (caseId: string, pass: boolean) => ({ ...experimentResult("x").runs[0]!, caseId, pass, grades: [{ graderId: "exact", result: { score: pass ? 1 : 0, pass } }] });
  before(async () => {
    await index.putExperiment(experimentResult("base", { runs: [run("c1", true), run("c2", false), run("c3", true)] }));
    await index.putExperiment(experimentResult("cand", { runs: [run("c1", false), run("c2", true), run("c3", true), run("c4", true)], status: "cancelled" }));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });

  test("pairs cases, lists regressions and improvements, and flags a partial side", async () => {
    const r = await req(v, "/api/compare?a=base&b=cand");
    assert.equal(r.status, 200);
    const c = r.json();
    assert.equal(c.paired, 3);
    assert.deepEqual(c.onlyInB, ["c4"]);
    assert.deepEqual(c.regressions.map((x: any) => x.caseId), ["c1"]);
    assert.deepEqual(c.improvements.map((x: any) => x.caseId), ["c2"]);
    assert.equal(c.verdict, "inconclusive");
    assert.deepEqual(c.partial, ["cand"]);
    assert.ok(c.diff.lo <= c.diff.mean && c.diff.mean <= c.diff.hi);
  });

  test("rejects bad ids and missing experiments", async () => {
    assert.equal((await req(v, "/api/compare?a=base")).status, 400);
    assert.equal((await req(v, "/api/compare?a=..%2Fx&b=base")).status, 400);
    assert.equal((await req(v, "/api/compare?a=base&b=nope")).status, 404);
    assert.equal((await req(v, "/api/compare?a=base&b=cand", { method: "POST" })).status, 405);
  });
});

// Regression VWR-5: search hits ignored the flag, repo and scope filters.
describe("viewer server: search follows the session filters", () => {
  const index = new FakeIndex();
  let v: Viewer;
  before(async () => {
    await index.upsertSession(session("a", { flags: ["no-verification"], repo: { root: "/work/api", head: "abc1234" } }));
    await index.upsertSession(session("b", { repo: { root: "/work/web", head: "abc1234" } }));
    await index.upsertSession(session("a:sub", { repo: { root: "/work/api", head: "abc1234" }, parent: { sessionId: "a", subagentId: "x" } }));
    await index.putEvents(["a", "b", "a:sub"].map((id) => event(id, 1, { payload: { text: "migrate the schema" } })));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  });
  after(async () => {
    await v.close();
  });
  const ids = async (qs: string) => (await req(v, `/api/search?q=migrate${qs}`)).json().items.map((h: any) => h.event.sessionId).sort();

  test("flag, repo and scope narrow the hits", async () => {
    assert.deepEqual(await ids(""), ["a", "a:sub", "b"]);
    assert.deepEqual(await ids("&flag=no-verification"), ["a"]);
    assert.deepEqual(await ids(`&repo=${encodeURIComponent("/work/api")}`), ["a", "a:sub"]);
    assert.deepEqual(await ids("&scope=top"), ["a", "b"]);
    assert.deepEqual(await ids(`&scope=top&repo=${encodeURIComponent("/work/api")}`), ["a"]);
    assert.equal((await req(v, "/api/search?q=migrate&scope=bogus")).status, 400);
  });
});

describe("viewer server: benchmarks", () => {
  const index = new FakeIndex();
  let v: Viewer;
  let env: NodeJS.ProcessEnv;
  before(async () => {
    // Two contenders over three days; "bad" is the definition's reference.
    const p = project();
    env = p.env;
    for (const d of ["2026-11-04", "2026-11-05", "2026-11-06"]) await runBench({ def: p.def('reference = "bad"'), env, now: day(d) });
    // Point two of the latest run's failures at sessions: one the index has, one it doesn't.
    const dir = runsDir("arith", env);
    const latest = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const bad = latest.cells.filter((c: any) => c.contender === "bad" && !c.pass);
    assert.ok(bad.length >= 2, "the bad contender fails some cases");
    bad[0].sessionId = "s-known";
    bad[1].sessionId = "s-missing";
    writeFileSync(join(dir, `${latest.id}.json`), JSON.stringify(latest));
    await index.upsertSession(session("s-known"));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, env });
  });
  after(async () => {
    await v.close();
    benchCleanup();
  });

  test("lists each benchmark with its latest leaderboard and pass-rate trend", async () => {
    const { items } = (await req(v, "/api/benchmarks")).json();
    assert.equal(items.length, 1);
    const b = items[0];
    assert.equal(b.name, "arith");
    assert.equal(b.counted, 3);
    assert.equal(b.reference, "bad", "reference comes from the definition file");
    assert.equal(b.latest.date, "2026-11-06");
    assert.deepEqual(b.contenders.map((c: any) => c.name), ["good", "bad"], "leader first");
    assert.equal(b.contenders[0].passRate.p, 1);
    assert.equal(b.trend.good.length, 3);
    assert.ok(b.trend.bad.every((x: number) => x > 0 && x < 1));
  });

  test("detail: history, gap to the reference, and failures that only link to sessions the index has", async () => {
    const r = (await req(v, "/api/benchmarks/arith")).json();
    assert.equal(r.bench, "arith");
    assert.equal(r.reference, "bad");
    assert.equal(r.history.pass.good.length, 3);
    assert.deepEqual(Object.keys(r.vsReference), ["good"]);
    assert.ok(r.vsReference.good.every((x: any) => x.value > 0), "good beats the reference every day");
    assert.equal(r.cases, undefined, "the frozen case list stays out");
    const fails = r.failures.bad;
    assert.ok(fails.length >= 2);
    assert.ok(fails.every((f: any) => f.sessionUrl === undefined && typeof f.hasSession === "boolean"));
    assert.equal(fails.find((f: any) => f.sessionId === "s-known").hasSession, true);
    assert.equal(fails.find((f: any) => f.sessionId === "s-missing").hasSession, false);
    assert.deepEqual(r.failures.good, []);
  });

  test("bad names are 400, unknown 404, writes 405, auth required; an empty data dir lists none", async () => {
    assert.equal((await req(v, "/api/benchmarks/..%2Fetc")).status, 400);
    assert.equal((await req(v, "/api/benchmarks/Nope")).status, 400);
    assert.equal((await req(v, "/api/benchmarks/nope")).status, 404);
    assert.equal((await req(v, "/api/benchmarks/arith/runs")).status, 404);
    assert.equal((await req(v, "/api/benchmarks", { method: "POST" })).status, 405);
    assert.equal((await req(v, "/api/benchmarks", { auth: false })).status, 401);
    const empty = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, benchmarks: benchmarkDir({ ...env, CODING_SH_HOME: join(String(env.HOME), "nowhere") }) });
    try {
      assert.deepEqual((await req(empty, "/api/benchmarks")).json(), { items: [] });
    } finally {
      await empty.close();
    }
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

describe("viewer server: session replay", () => {
  const index = new FakeIndex();
  let v: Viewer;
  let baselineCalls = 0;
  const ev = (n: number, kind: string, payload: Record<string, unknown>) => event("rp", n, { kind: kind as never, cwd: "/work/api", payload });
  before(async () => {
    await index.upsertSession(session("rp", { stats: { events: 7, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 1 } }));
    await index.putEvents([
      ev(1, "user.message", { text: "fix it" }),
      ev(2, "tool.start", { tool: "Edit", toolUseId: "a", input: { file_path: "/work/api/x.ts", old_string: "1", new_string: "2" } }),
      ev(3, "tool.end", { tool: "Edit", toolUseId: "a", ok: true }),
      ev(4, "tool.start", { tool: "Bash", toolUseId: "b", input: { command: "npm test" } }),
      ev(5, "tool.end", { tool: "Bash", toolUseId: "b", ok: true, exitCode: 0, output: "ok" }),
      ev(6, "tool.start", { tool: "Edit", toolUseId: "c", input: { file_path: "x.ts", old_string: "2", new_string: "3" } }),
      ev(7, "tool.end", { tool: "Edit", toolUseId: "c", ok: true }),
    ]);
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      // A start snapshot: x.ts held "const x = 1;".
      replayBaseline: () => (baselineCalls++, async (p) => (p === "x.ts" ? "const x = 1;\n" : undefined)),
    });
  });
  after(async () => {
    await v.close();
  });

  test("the index lists steps and files; ?step shows one step, ?file the file then, ?from&to a range", async () => {
    const idx = (await req(v, "/api/sessions/rp/replay")).json();
    assert.deepEqual(idx.steps.map((s: any) => s.kind), ["prompt", "edit", "shell", "edit"]);
    assert.deepEqual(idx.files, ["x.ts"]);
    const s2 = (await req(v, "/api/sessions/rp/replay?step=2&file=x.ts")).json();
    assert.equal(s2.steps, 4);
    assert.equal(s2.file.content, "const x = 2;\n");
    assert.equal(s2.changes[0].exact, true);
    const s3 = (await req(v, "/api/sessions/rp/replay?step=3")).json();
    assert.deepEqual(s3.detail.shell, { command: "npm test", ok: true, exitCode: 0, output: "ok" });
    const r = (await req(v, "/api/sessions/rp/replay?from=2&to=4")).json();
    assert.deepEqual(r.files.map((f: any) => [f.path, f.steps]), [["x.ts", [2, 4]]]);
    assert.match(r.files[0].diff, /^-const x = 1;$[\s\S]*^\+const x = 3;$/m);
    assert.equal(baselineCalls, 1, "the replay is built once and cached");
  });

  test("bad steps and lone bounds are 400; unknown sessions 404; auth required", async () => {
    assert.equal((await req(v, "/api/sessions/rp/replay?step=9")).status, 400);
    assert.equal((await req(v, "/api/sessions/rp/replay?step=0")).status, 400);
    assert.equal((await req(v, "/api/sessions/rp/replay?from=2")).status, 400);
    assert.equal((await req(v, "/api/sessions/rp/replay?file=x.ts")).status, 400);
    assert.equal((await req(v, "/api/sessions/nope/replay")).status, 404);
    assert.equal((await req(v, "/api/sessions/rp/replay", { auth: false })).status, 401);
  });
});

describe("viewer server: fork from a replay step", () => {
  const index = new FakeIndex();
  let plain: Viewer;
  let v: Viewer;
  const seen: unknown[][] = [];
  before(async () => {
    await index.upsertSession(session("fk", { stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([
      event("fk", 1, { kind: "user.message", payload: { text: "fix it" } }),
      event("fk", 2, { kind: "tool.start", payload: { tool: "Bash", toolUseId: "b", input: { command: "npm test" } } }),
      event("fk", 3, { kind: "tool.end", payload: { tool: "Bash", toolUseId: "b", ok: false } }),
    ]);
    plain = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      fork: {
        preview: async (s, replay, step) => (seen.push(["preview", s.id, replay.steps.length, step]), { files: [{ path: "CLAUDE.md", text: "Use npm test." }] }),
        run: async (s, _replay, step, files, trials) => {
          if (files["CLAUDE.md"] === "boom") throw Object.assign(new Error("This session has no model calls with stored requests."), { name: "ForkError" });
          seen.push(["run", s.id, step, files, trials]);
          return { differ: 1, trials: [{ label: "Bash: node --test", differs: true }] };
        },
      },
    });
  });
  after(async () => {
    await plain.close();
    await v.close();
  });

  test("only a viewer given a fork source forks, and its replay index says so", async () => {
    assert.equal((await req(plain, "/api/sessions/fk/fork?step=2")).status, 404);
    assert.equal((await req(plain, "/api/sessions/fk/replay")).json().canFork, undefined);
    assert.equal((await req(v, "/api/sessions/fk/replay")).json().canFork, true);
  });

  test("GET previews the step's call; POST forks it with the edited files", async () => {
    assert.deepEqual((await req(v, "/api/sessions/fk/fork?step=2")).json(), { files: [{ path: "CLAUDE.md", text: "Use npm test." }] });
    const r = await post(v, "/api/sessions/fk/fork", { step: 2, files: { "CLAUDE.md": "Use node --test." }, trials: 3 });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().differ, 1);
    assert.deepEqual(seen, [
      ["preview", "fk", 2, 2],
      ["run", "fk", 2, { "CLAUDE.md": "Use node --test." }, 3],
    ]);
  });

  test("bad input is 400, a fork that can't start is 400 with the reason, another origin is 403", async () => {
    assert.equal((await post(v, "/api/sessions/fk/fork", { step: 9, files: {} })).status, 400);
    assert.equal((await post(v, "/api/sessions/fk/fork", { step: 2, files: { "CLAUDE.md": 1 } })).status, 400);
    assert.equal((await post(v, "/api/sessions/fk/fork", { step: 2, files: {}, trials: 50 })).status, 400);
    const e = await post(v, "/api/sessions/fk/fork", { step: 2, files: { "CLAUDE.md": "boom" } });
    assert.equal(e.status, 400);
    assert.match(e.json().error, /no model calls with stored requests/);
    assert.equal((await post(v, "/api/sessions/fk/fork", { step: 2, files: {} }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await req(v, "/api/sessions/fk/fork", { method: "DELETE" })).status, 405);
    assert.equal((await req(v, "/api/sessions/fk/fork?step=2", { auth: false })).status, 401);
  });
});
