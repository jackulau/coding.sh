// /api/scores and /api/score-configs through the viewer handler (as `coding.sh ui` and `serve` mount it).
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createViewerHandler } from "../../src/viewer/server.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { sdkEventId } from "../../src/server/project.ts";
import { fixtureSession } from "../../src/store/conformance.ts";
import type { IndexStore } from "../../src/core/types.ts";

interface Res {
  status: number;
  json(): any;
}

for (const [kind, open] of [
  ["sqlite", () => SqliteIndexStore.open(":memory:")],
  ["memory", async () => new MemoryIndexStore()],
] as const) {
  describe(`/api/scores (${kind})`, () => {
    let index: IndexStore;
    let server: Server;
    let port = 0;

    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> =>
      new Promise((resolve, reject) => {
        const h: Record<string, string> = { host: `127.0.0.1:${port}`, ...headers };
        if (body !== undefined) h["content-type"] = "application/json";
        const r = request({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
          });
        });
        r.on("error", reject);
        if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
        r.end();
      });
    const post = (path: string, body: unknown, headers?: Record<string, string>) => call("POST", path, body, headers);
    const get = (path: string, headers?: Record<string, string>) => call("GET", path, undefined, headers);
    const scoped = { "x-project": "demo" };

    before(async () => {
      index = await open();
      await index.upsertSession(fixtureSession({ id: "s1" }));
      await index.upsertSession(fixtureSession({ id: "s2", startedAt: 1_700_000_100_000 }));
      await index.upsertSession(fixtureSession({ id: "demo/s3", project: "demo" }));
      await index.putEvents([
        { id: "e1", v: 0, sessionId: "s1", ts: 1_700_000_000_001, agent: "claude-code", kind: "notification", payload: {} },
        // As serve stores an event an SDK client sent as "c1" with the demo project's key.
        { id: sdkEventId("demo", "c1"), v: 0, sessionId: "demo/s3", ts: 1_700_000_000_002, agent: "claude-code", kind: "notification", payload: {}, project: "demo" },
      ]);
      const handler = await createViewerHandler({
        index,
        blobs: new MemoryBlobStore(),
        // A test caller: x-project scopes it like a project read key; x-by names it.
        authorize: (req) => ({ ...(req.headers["x-project"] ? { project: String(req.headers["x-project"]) } : {}), by: String(req.headers["x-by"] ?? "alice") }),
        checkHost: (h) => h === `127.0.0.1:${port}`,
        updateStatus: async () => ({ current: "0.0.0" }) as never,
      });
      server = createServer((req, res) => void handler(req, res));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    after(async () => {
      await new Promise((r) => server.close(r));
      await index.close();
    });

    it("configs: create, validate, list, and refuse a second config for the same name", async () => {
      assert.deepEqual((await get("/api/score-configs")).json(), { items: [] });
      const r = await post("/api/score-configs", { name: "helpfulness", dataType: "numeric", min: 0, max: 5, description: "How much it helped" });
      assert.equal(r.status, 201);
      assert.deepEqual({ ...r.json(), ts: 0 }, { id: "helpfulness", name: "helpfulness", dataType: "numeric", min: 0, max: 5, description: "How much it helped", ts: 0 });
      assert.equal((await post("/api/score-configs", { name: "helpfulness", dataType: "numeric", min: 0, max: 5, description: "How much it helped" })).status, 200, "same config again is idempotent");
      assert.equal((await post("/api/score-configs", { name: "tone", dataType: "categorical", categories: ["positive", "neutral", "negative"] })).status, 201);
      assert.equal((await post("/api/score-configs", { id: "other", name: "tone", dataType: "categorical", categories: ["a"] })).status, 409);
      for (const bad of [
        { name: "x", dataType: "numeric", min: 5, max: 1 },
        { name: "x", dataType: "boolean", min: 0 },
        { name: "x", dataType: "categorical" },
        { name: "x", dataType: "categorical", categories: ["a", "a"] },
        { name: "x", dataType: "numeric", categories: ["a"] },
        { name: "bad name!", dataType: "numeric" },
        { name: "x", dataType: "fuzzy" },
        [1],
      ]) {
        const res = await post("/api/score-configs", bad);
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.ok(res.json().error);
      }
      assert.deepEqual((await get("/api/score-configs")).json().items.map((c: { id: string }) => c.id), ["helpfulness", "tone"]);
      assert.equal((await post("/api/score-configs", { name: "z", dataType: "text" }, scoped)).status, 403, "a scoped key cannot change configs");
    });

    it("a value outside the config's range or categories is a 400", async () => {
      for (const [body, re] of [
        [{ sessionId: "s1", name: "helpfulness", value: 7 }, /above helpfulness's maximum 5/],
        [{ sessionId: "s1", name: "helpfulness", value: -1 }, /below helpfulness's minimum 0/],
        [{ sessionId: "s1", name: "helpfulness", value: "high" }, /finite number/],
        [{ sessionId: "s1", name: "helpfulness", value: 3, dataType: "categorical" }, /does not match/],
        [{ sessionId: "s1", name: "tone", value: "angry" }, /not one of tone's categories/],
        [{ sessionId: "s1", configId: "nope", value: 1 }, /unknown configId/],
        [{ sessionId: "s1", configId: "tone", name: "helpfulness", value: 1 }, /does not match config/],
        [{ sessionId: "s1", name: "ok", value: null }, /number, a boolean or a string/],
        [{ sessionId: "s1", name: "ok", value: "yes", dataType: "boolean" }, /true or false/],
        [{ sessionId: "s1", name: "ok", value: 1, target: "trace" }, /target must be one of/],
        [{ name: "ok", value: 1 }, /targetId/],
        [{ sessionId: "s1", name: "ok", value: 1, source: "robot" }, /source must be one of/],
        [{ sessionId: "s1", name: "ok", value: 1, ts: -5 }, /ts must be/],
        [{ target: "session", targetId: "s1", sessionId: "s2", name: "ok", value: 1 }, /sessionId must equal targetId/],
      ] as const) {
        const r = await post("/api/scores", body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.json().error, re);
      }
      assert.equal((await post("/api/scores", { sessionId: "missing", name: "ok", value: 1 })).status, 404);
      assert.equal((await post("/api/scores", { target: "event", targetId: "nope", name: "ok", value: 1 })).status, 404);
      assert.equal((await post("/api/scores", { target: "event", targetId: "nope", sessionId: "s1", name: "ok", value: 1 })).status, 404, "a sessionId does not stand in for the event");
      const other = await post("/api/scores", { target: "event", targetId: "e1", sessionId: "s2", name: "ok", value: 1 });
      assert.equal(other.status, 400);
      assert.match(other.json().error, /event e1 belongs to session s1, not s2/);
      assert.equal((await post("/api/scores", { target: "event", targetId: "e1", sessionId: "demo/s3", name: "ok", value: 1 }, scoped)).status, 404, "a scoped key cannot put another project's event under its own session");
      assert.deepEqual((await get("/api/scores")).json().items, [], "nothing was stored");
    });

    it("stores every type; re-posting the same id is idempotent", async () => {
      const body = { id: "sc-1", sessionId: "s1", name: "helpfulness", value: 4, comment: "fixed it first try", source: "judge", judgeVersion: "j@1", calibrated: true };
      const first = await post("/api/scores", body);
      assert.equal(first.status, 201);
      const stored = first.json();
      assert.deepEqual({ ...stored, ts: 0 }, { id: "sc-1", target: "session", targetId: "s1", sessionId: "s1", name: "helpfulness", dataType: "numeric", value: 4, source: "judge", configId: "helpfulness", judgeVersion: "j@1", calibrated: true, comment: "fixed it first try", by: "alice", ts: 0 });
      for (let i = 0; i < 3; i++) {
        const again = await post("/api/scores", body);
        assert.equal(again.status, 200);
        assert.deepEqual(again.json(), stored, "same body: same score back, first ts kept");
      }
      assert.equal((await get("/api/scores?name=helpfulness")).json().items.length, 1);
      const changed = await post("/api/scores", { ...body, value: 5 });
      assert.equal(changed.status, 200);
      assert.equal(changed.json().value, 5);
      assert.equal((await get("/api/scores?name=helpfulness")).json().items.length, 1, "same id replaces");
      // With a ts, a repeat is idempotent too.
      const withTs = { target: "run", targetId: "run-1", name: "latency_ok", value: true, ts: 1_700_000_000_500 };
      assert.equal((await post("/api/scores", withTs)).status, 201);
      assert.equal((await post("/api/scores", withTs)).status, 200);

      const ev = await post("/api/scores", { target: "event", targetId: "e1", name: "correct", value: false, source: "code" });
      assert.equal(ev.status, 201);
      assert.equal(ev.json().sessionId, "s1", "an event's session is looked up");
      assert.equal(ev.json().dataType, "boolean");
      assert.equal((await post("/api/scores", { target: "event", targetId: "e1", sessionId: "s1", name: "correct", value: false, source: "code" })).status, 200, "its own sessionId is fine");
      // A stored score keeps its type: only dataType (or a config) changes it.
      const retyped = await post("/api/scores", { target: "event", targetId: "e1", name: "correct", value: "no", source: "code" });
      assert.equal(retyped.status, 400);
      assert.match(retyped.json().error, /correct is a boolean score on event e1.*dataType/);
      assert.equal((await get("/api/scores?name=correct")).json().items[0].value, false);
      const cat = await post("/api/scores", { target: "case", targetId: "case-1", sessionId: "s2", name: "tone", value: "neutral" });
      assert.equal(cat.status, 201);
      assert.equal(cat.json().configId, "tone");
      const text = await post("/api/scores", { sessionId: "s2", name: "summary", value: "clean diff", dataType: "text" });
      assert.equal(text.status, 201);
      assert.equal(text.json().source, "api", "the API's default source");

      assert.deepEqual((await get("/api/scores?sessionId=s1")).json().items.map((s: { name: string }) => s.name).sort(), ["correct", "helpfulness"]);
      assert.deepEqual((await get("/api/scores?target=case")).json().items.map((s: { targetId: string }) => s.targetId), ["case-1"]);
      assert.deepEqual((await get("/api/scores?source=code")).json().items.map((s: { name: string }) => s.name), ["correct"]);
      assert.equal((await get("/api/scores?limit=2")).json().items.length, 2);
      assert.equal((await get("/api/scores?limit=0")).status, 400);
      assert.equal((await get("/api/scores?target=trace")).status, 400);
      assert.equal((await get("/api/scores?sessionId=missing")).status, 404);
      assert.equal((await call("DELETE", "/api/scores")).status, 405);
      assert.equal((await post("/api/scores", { sessionId: "s1", name: "x", value: 1 }, { origin: "http://evil.example" })).status, 403);
    });

    it("labels and human boolean scores are the same rows", async () => {
      const label = (await post("/api/labels", { sessionId: "s2", criterion: "outcome", value: "fail", note: "stopped early" })).json();
      const [asScore] = (await get(`/api/scores?sessionId=s2&name=outcome`)).json().items;
      assert.deepEqual(asScore, { id: label.id, target: "session", targetId: "s2", sessionId: "s2", name: "outcome", dataType: "boolean", value: false, source: "human", comment: "stopped early", by: "alice", ts: label.ts });
      // The same person scoring the same session again (as a human) replaces the label.
      const r = await post("/api/scores", { sessionId: "s2", name: "outcome", value: true, source: "human" });
      assert.equal(r.status, 200);
      assert.equal(r.json().id, label.id);
      const labels = (await get("/api/labels?sessionId=s2")).json().items;
      assert.deepEqual(labels.map((l: { value: string }) => l.value), ["pass"]);
      assert.equal(labels[0].note, undefined);
    });

    it("a project-scoped caller sees and writes only its project's sessions", async () => {
      assert.equal((await post("/api/scores", { sessionId: "s1", name: "ok", value: 1 }, scoped)).status, 404);
      assert.equal((await post("/api/scores", { target: "run", targetId: "r9", name: "ok", value: 1 }, scoped)).status, 400);
      const r = await post("/api/scores", { sessionId: "demo/s3", name: "ok", value: 1 }, { ...scoped, "x-by": "bob" });
      assert.equal(r.status, 201);
      assert.equal(r.json().by, "bob");
      assert.deepEqual((await get("/api/scores", scoped)).json().items.map((s: { sessionId: string }) => s.sessionId), ["demo/s3"]);
      assert.equal((await get("/api/scores?sessionId=s1", scoped)).status, 404);
      assert.equal((await get("/api/score-configs", scoped)).status, 200);
      // An SDK client's own event id: read as the stored id, and its session is still the event's own.
      const sdk = await post("/api/scores", { target: "event", targetId: "c1", sessionId: "demo/s3", name: "correct", value: true }, scoped);
      assert.equal(sdk.status, 201);
      assert.deepEqual([sdk.json().targetId, sdk.json().sessionId], [sdkEventId("demo", "c1"), "demo/s3"]);
      assert.equal((await post("/api/scores", { target: "event", targetId: "c1", sessionId: "s1", name: "correct", value: true })).status, 404, "c1 is not an event of the default project");
    });
  });
}
