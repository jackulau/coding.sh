// GET /api/work and its ack and snooze writes: the Work page's data. The items must be
// what `coding.sh work --json` gives for the same store and filters, and an ack or a
// snooze made in the viewer must be one `coding.sh work` sees (the same work.json).
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import * as work from "../../src/cli/commands/work.ts";
import type { FlagValue } from "../../src/cli/args.ts";
import { workItemId } from "../../src/core/work.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { createViewerHandler, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";
import { FakeBlobs } from "./fakes.ts";
import { workSessions } from "./_work.ts";

interface Res {
  status: number;
  body: string;
  json: () => any;
}

function req(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string; token?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
      });
      res.on("error", reject);
    });
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

/** The fields of `work --json` both sides give: `since` is the window start, read a few ms apart. */
const KEYS = ["counts", "needYou", "hidden", "noPromptSignal", "items", "more", "groups", "truncated"];
const pick = (doc: Record<string, unknown>) => Object.fromEntries(KEYS.filter((k) => k in doc).map((k) => [k, doc[k]]));

describe("viewer /api/work", () => {
  let sb: Sandbox;
  let index: SqliteIndexStore;
  let v: Viewer;
  const now = Date.now();
  const get = (path: string) => req(v.port, path, { token: v.token });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    req(v.port, path, { method: "POST", token: v.token, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const cli = async (flags: Record<string, FlagValue> = {}) => {
    const r = await runCmd(work, sb, { json: true, flags });
    assert.equal(r.error, undefined, r.error?.stack);
    return r.json as Record<string, unknown>;
  };
  const query = (flags: Record<string, FlagValue>) =>
    new URLSearchParams(Object.entries(flags).map(([k, val]) => [k, val === true ? "1" : String(val)])).toString();

  before(async () => {
    sb = sandbox();
    await sb.seed(workSessions(now));
    const home = sb.env.CODING_SH_HOME!;
    index = await SqliteIndexStore.open(join(home, "index.db"));
    await index.migrate();
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      updateStatus: async () => ({ disabled: "test" }) as any,
      work: { overlay: join(home, "work.json"), home: sb.env.HOME!, cwd: sb.env.HOME! },
    });
  });
  after(async () => {
    await v?.close();
    await index?.close();
    sb?.cleanup();
  });

  const cases: Record<string, FlagValue>[] = [{}, { all: true }, { agent: "codex" }, { agent: "codex,gemini-cli" }, { repo: "api" }, { since: "60d", all: true }, { limit: 2 }, { agent: "nobody-ran-this", all: true }];
  for (const flags of cases) {
    test(`gives the items work --json gives (${JSON.stringify(flags)})`, async () => {
      const cliFlags = typeof flags.agent === "string" ? { ...flags, agent: flags.agent.split(",") } : flags;
      // An agent no session ran is an error in the CLI (a likely typo); the page shows the empty queue.
      const want = flags.agent === "nobody-ran-this" ? undefined : pick(await cli(cliFlags));
      const r = await get(`/api/work?${query(flags)}`);
      assert.equal(r.status, 200, r.body);
      const got = r.json();
      if (want) {
        assert.ok((want.items as unknown[]).length > 0, "the case lists something to compare");
        assert.deepEqual(pick(got), want);
      }
      else assert.deepEqual(got.items, []);
      assert.match(got.since, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(Object.keys(got.members), got.items.map((i: { id: string }) => i.id), "members lists each item shown");
    });
  }

  test("lists the buckets in the CLI's order, with each item's member sessions", async () => {
    const got = (await get("/api/work?all=1")).json();
    assert.deepEqual(got.items.map((i: { bucket?: string; hidden?: string }) => i.bucket ?? `hidden:${i.hidden}`), ["blocked", "failed", "stalled", "turn", "review", "hidden:done"]);
    assert.deepEqual(got.members[workItemId("blocked")], ["blocked", "blocked:sub:a1"]);
    const blocked = got.items[0];
    assert.equal(blocked.sessions, 2);
    assert.equal(blocked.costUsd, 1.25);
    assert.equal(got.hidden, 1);
    // Without --all the hidden items are not listed, but the page still says why they are hidden.
    const shown = (await get("/api/work")).json();
    assert.equal(shown.hidden, 1);
    assert.deepEqual(shown.hiddenBy, { done: 1 });
    assert.ok(shown.items.every((i: { hidden?: string }) => !i.hidden));
  });

  test("ack and snooze write the overlay coding.sh work reads", async () => {
    const blocked = workItemId("blocked");
    const ack = await post("/api/work/ack", { id: blocked });
    assert.equal(ack.status, 200, ack.body);
    assert.equal(ack.json().acked, true);
    assert.equal(ack.json().bucket, "blocked");
    const review = workItemId("review");
    const snooze = await post("/api/work/snooze", { id: review, duration: "1h" });
    assert.equal(snooze.status, 200, snooze.body);
    const until = Date.parse(snooze.json().snoozedUntil);
    assert.ok(until > Date.now() + 59 * 60e3 && until <= Date.now() + 3600e3, snooze.body);

    const after = await cli();
    assert.equal((after.counts as Record<string, number>).blocked, 0, "the CLI sees the viewer's ack");
    assert.equal((after.counts as Record<string, number>).review, 0, "the CLI sees the viewer's snooze");
    assert.deepEqual(pick((await get("/api/work")).json()), pick(after));
    const all = (await get("/api/work?all=1")).json();
    const hidden = Object.fromEntries(all.items.map((i: { id: string; hidden?: string }) => [i.id, i.hidden]));
    assert.equal(hidden[review], "snoozed");

    // An item with nothing to acknowledge says so and writes nothing.
    const again = await post("/api/work/ack", { id: workItemId("done") });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json(), { id: workItemId("done"), acked: false, hidden: "done" });
  });

  test("bad input is a 4xx with a message", async () => {
    assert.equal((await get("/api/work?since=yesterdayish")).status, 400);
    assert.equal((await get("/api/work?limit=0")).status, 400);
    const id = workItemId("failed");
    assert.equal((await post("/api/work/snooze", { id, duration: "soon" })).status, 400);
    assert.equal((await post("/api/work/snooze", { id })).status, 400);
    assert.equal((await post("/api/work/ack", { id: "w000000" })).status, 404);
    assert.equal((await post("/api/work/ack", { id: "not-an-id" })).status, 400);
    assert.equal((await post("/api/work/ack", {})).status, 400);
    assert.equal((await post("/api/work/ack", [id])).status, 400);
    assert.equal((await post("/api/work/close", { id })).status, 404);
    assert.equal((await post(`/api/work/ack/${id}`, { id })).status, 404);
    assert.equal((await get("/api/work/ack")).status, 405);
    assert.equal((await post("/api/work", {})).status, 405);
    const plain = await req(v.port, "/api/work/ack", { method: "POST", token: v.token, headers: { "content-type": "text/plain" }, body: JSON.stringify({ id }) });
    assert.equal(plain.status, 415, "a write takes a JSON body, as /api/star does");
    assert.equal((await post("/api/work/ack", { id }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await req(v.port, "/api/work")).status, 401);
  });

  test("a handler with no work source, or a project-scoped caller, has no queue (coding.sh serve)", async () => {
    const serve = async (opts: { work?: boolean; project?: string }) => {
      const handle = await createViewerHandler({
        index,
        blobs: new FakeBlobs(),
        authorize: () => (opts.project ? { project: opts.project } : {}),
        checkHost: () => true,
        updateStatus: async () => ({ disabled: "test" }) as any,
        work: opts.work ? { overlay: join(sb.env.CODING_SH_HOME!, "work.json") } : undefined,
      });
      const server: Server = createServer((rq, rs) => void handle(rq, rs));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        return (await req((server.address() as AddressInfo).port, "/api/work")).status;
      } finally {
        await new Promise((r) => server.close(r));
      }
    };
    assert.equal(await serve({}), 404);
    assert.equal(await serve({ work: true, project: "p" }), 404);
    assert.equal(await serve({ work: true }), 200);
  });
});
