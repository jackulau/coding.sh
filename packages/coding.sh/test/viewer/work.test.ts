// GET /api/work and its ack and snooze writes: the Work page's data. The items must be
// what `coding.sh work --json` gives for the same store and filters, and an ack or a
// snooze made in the viewer must be one `coding.sh work` sees (the same work.json).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import * as work from "../../src/cli/commands/work.ts";
import type { FlagValue } from "../../src/cli/args.ts";
import { recordLastIngest } from "../../src/core/ingest-health.ts";
import { FLAGS } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { workItemId } from "../../src/core/work.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { createViewerHandler, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";
import { FakeBlobs } from "./fakes.ts";
import { workSessions } from "./_work.ts";

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  /** The bytes as sent: gzipped when the answer says Content-Encoding: gzip. */
  raw: Buffer;
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
        const raw = Buffer.concat(chunks);
        const body = raw.toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body, json: () => JSON.parse(body) });
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

/**
 * The CLI names each next step for the user's shell (`codingsh` in PowerShell or cmd), and the API
 * gives it as `coding.sh` on every platform. The CLI side is read as on Linux, where the two agree.
 */
const CLI_PLATFORM = "linux";

/** `work show <id> --json`, less what only the CLI gives: an old index's time and the ingest backlog. */
async function showJson(sb: Sandbox, id: string): Promise<Record<string, unknown>> {
  const r = await runCmd(work, sb, { action: "show", positionals: [id], json: true, platform: CLI_PLATFORM });
  assert.equal(r.error, undefined, r.error?.stack);
  const { indexUpdatedAt: _, asOf: __, pending: ___, ...doc } = r.json as Record<string, unknown>;
  return doc;
}

describe("viewer /api/work", () => {
  let sb: Sandbox;
  let index: SqliteIndexStore;
  let v: Viewer;
  const now = Date.now();
  const get = (path: string) => req(v.port, path, { token: v.token });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    req(v.port, path, { method: "POST", token: v.token, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const cli = async (flags: Record<string, FlagValue> = {}) => {
    const r = await runCmd(work, sb, { json: true, flags, platform: CLI_PLATFORM });
    assert.equal(r.error, undefined, r.error?.stack);
    return r.json as Record<string, unknown>;
  };
  const query = (flags: Record<string, FlagValue>) =>
    new URLSearchParams(Object.entries(flags).map(([k, val]) => [k, val === true ? "1" : String(val)])).toString();
  /**
   * `work --json` and the API's answer for the same query, read so that the clock cannot split them.
   * Each side reads the time itself, and a reason such as "for 2m" goes up each time a whole minute
   * since `now` ends, so on a loaded machine one can end between the two reads. The CLI is read
   * before and after the API: when its two answers match, no minute ended in between, and the
   * API's answer must match them. Up to 3 tries; the last one is returned as it is.
   */
  const cliAndApi = async (flags: Record<string, FlagValue>, path: string) => {
    for (let i = 0; ; i++) {
      const want = pick(await cli(flags));
      const res = await get(path);
      if (isDeepStrictEqual(pick(await cli(flags)), want) || i === 2) return { want, res };
    }
  };
  /** `work show <id> --json` and GET /api/work/<id>, read before and after as cliAndApi reads them. */
  const showAndApi = async (id: string) => {
    for (let i = 0; ; i++) {
      const want = await showJson(sb, id);
      const res = await get(`/api/work/${id}`);
      if (isDeepStrictEqual(await showJson(sb, id), want) || i === 2) return { want, res };
    }
  };

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

  const cases: Record<string, FlagValue>[] = [{}, { all: true }, { agent: "codex" }, { agent: "codex,gemini-cli" }, { repo: "api" }, { since: "60d", all: true }, { limit: 2 }, { agent: "nobody-ran-this", all: true }, { stage: "planning,approval" }, { stage: "review,done" }];
  for (const flags of cases) {
    test(`gives the items work --json gives (${JSON.stringify(flags)})`, async () => {
      const cliFlags = typeof flags.agent === "string" ? { ...flags, agent: flags.agent.split(",") } : flags;
      // An agent no session ran is an error in the CLI (a likely typo); the page shows the empty queue.
      const path = `/api/work?${query(flags)}`;
      const { want, res: r } = flags.agent === "nobody-ran-this" ? { want: undefined, res: await get(path) } : await cliAndApi(cliFlags, path);
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

  test("stage filters to those stages, hidden items too, and stages counts every item", async () => {
    const got = (await get("/api/work?stage=done&stage=review")).json();
    assert.ok(got.items.length > 0);
    assert.ok(got.items.every((i: { stage: string }) => i.stage === "done" || i.stage === "review"), JSON.stringify(got.items.map((i: { stage: string }) => i.stage)));
    assert.ok(got.items.some((i: { hidden?: string }) => i.hidden === "done"), "a done item the queue hides is listed");
    const all = (await get("/api/work?all=1")).json();
    assert.deepEqual(got.stages, all.stages);
    assert.deepEqual(got.hiddenBy, { done: 1 });
  });

  test("totals count each bucket over the whole answer, before limit cuts it", async () => {
    const countOf = (items: { bucket?: string }[]) => {
      const t: Record<string, number> = { blocked: 0, failed: 0, stalled: 0, turn: 0, review: 0, hidden: 0 };
      for (const i of items) t[i.bucket ?? "hidden"]!++;
      return t;
    };
    const two = (await get("/api/work?limit=2")).json();
    assert.equal(two.items.length, 2);
    assert.deepEqual(two.totals, { blocked: 1, failed: 1, stalled: 1, turn: 1, review: 1, hidden: 0 });
    assert.equal(two.more, 3);
    // Hidden items count when the answer lists them: with all=1, or a stage filter.
    assert.deepEqual((await get("/api/work?all=1&limit=1")).json().totals, { ...two.totals, hidden: 1 });
    const staged = (await get("/api/work?stage=review,done")).json();
    assert.deepEqual(staged.totals, countOf(staged.items));
    assert.equal(staged.totals.hidden, 1);
    // The filters narrow the totals as they narrow the items.
    assert.deepEqual((await get("/api/work?agent=codex&limit=1")).json().totals, { ...countOf([]), failed: 1 });
  });

  test("GET /api/work/<id> gives the item work show <id> --json gives, and the list's now", async () => {
    for (const sid of ["blocked", "failed", "review"]) {
      const { want, res } = await showAndApi(workItemId(sid));
      assert.equal(res.status, 200, res.body);
      const { now: at, ...got } = res.json();
      assert.deepEqual(got, want);
      assert.match(at, /^\d{4}-\d{2}-\d{2}T/);
    }
    const blocked = (await get(`/api/work/${workItemId("blocked")}`)).json();
    assert.deepEqual(blocked.sessions.map((s: { id: string }) => s.id), ["blocked", "blocked:sub:a1"]);
    assert.match(blocked.reason, /\S/);
    assert.equal(blocked.bucket, "blocked");
    // A hidden item has a page too, as `work show` shows it.
    assert.equal((await get(`/api/work/${workItemId("done")}`)).json().hidden, "done");
  });

  test("GET /api/work/<id>: a malformed id is a 400, an unknown one a 404, and the list's filters apply", async () => {
    const unknown = await get("/api/work/w000000");
    assert.equal(unknown.status, 404, unknown.body);
    assert.equal(unknown.json().error, "no work item w000000 since 7d");
    const bad = await get("/api/work/not-an-id");
    assert.equal(bad.status, 400, bad.body);
    assert.match(bad.json().error, /^id must be a work item id/);
    assert.equal((await get("/api/work/W1A2B3C")).status, 400);
    const id = workItemId("blocked");
    const other = await get(`/api/work/${id}?agent=codex`);
    assert.equal(other.status, 404, other.body);
    assert.equal(other.json().error, `no work item ${id} since 7d that matches the filters`);
    assert.equal((await get(`/api/work/${id}?repo=api`)).status, 404);
    assert.equal((await get(`/api/work/${id}?agent=claude-code&repo=demo`)).status, 200);
    // An item older than the window is found once the window takes it in.
    const old = workItemId("old");
    assert.equal((await get(`/api/work/${old}`)).status, 404);
    assert.equal((await get(`/api/work/${old}?since=60d`)).status, 200);
    assert.equal((await get(`/api/work/${id}?since=yesterdayish`)).status, 400);
    assert.equal((await post(`/api/work/${id}`, {})).status, 405);
    assert.equal((await get(`/api/work/${id}/sessions`)).status, 404);
    assert.equal((await req(v.port, `/api/work/${id}`)).status, 401);
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

    const { want: after, res } = await cliAndApi({}, "/api/work");
    assert.equal((after.counts as Record<string, number>).blocked, 0, "the CLI sees the viewer's ack");
    assert.equal((after.counts as Record<string, number>).review, 0, "the CLI sees the viewer's snooze");
    assert.deepEqual(pick(res.json()), after);
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
    const stage = await get("/api/work?stage=reveiw");
    assert.equal(stage.status, 400, "an unknown stage is refused, as --stage refuses it");
    assert.match(stage.json().error, /--stage must be one of planning, executing, review, approval, done/);
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

describe("viewer /api/work: workflow runs, superseded failures and the index's age", () => {
  const MIN = 60e3;
  const now = Date.now();
  let sb: Sandbox;
  let index: SqliteIndexStore;
  let v: Viewer;
  let bare: Viewer;
  type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
  const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { cwd: "/work/demo", ...extra });
  const failing = { flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } } as Extra["stats"] };
  const agent = (id: string, phase: string, startAgo: number, extra: Extra = {}): Session =>
    sess(`lead:sub:${id}`, startAgo, { ...extra, parent: { sessionId: "lead", subagentId: id, workflowId: "run-a", workflowName: "round", phase, label: `${phase}:${id}` } });
  const repo = { root: "/work/web", head: "", branch: "main" } as Extra["repo"];
  const change: AgentEvent = { id: "c1", v: 0, sessionId: "change", ts: now - 75 * MIN, agent: "claude-code", kind: "file.change", payload: { path: "src/header.ts", op: "modify" } };

  before(async () => {
    sb = sandbox();
    await sb.seed([
      sess("lead", 180 * MIN, { title: "run the round", endedAt: now - 60 * MIN }),
      agent("b1", "build", 170 * MIN, { stats: { usage: { estimatedCostUsd: 0.5 } } as Extra["stats"] }),
      agent("b2", "build", 169 * MIN, { ...failing, stats: { ...failing.stats, usage: { estimatedCostUsd: 0.25 } } as Extra["stats"] }),
      { ...agent("v1", "review", 120 * MIN), endedAt: undefined },
      sess("failed", 150 * MIN, { ...failing, cwd: "/work/web", repo, title: "deploy the site" }),
      sess("passed", 100 * MIN, { cwd: "/work/web", repo, title: "deploy the site again" }),
      // A change to review that ended 70 minutes ago, 30 minutes before the last ingest.
      sess("change", 80 * MIN, { title: "fix the header", endedAt: now - 70 * MIN, stats: { filesChanged: 1 } }),
    ], [change]);
    const home = sb.env.CODING_SH_HOME!;
    index = await SqliteIndexStore.open(join(home, "index.db"));
    await index.migrate();
    // The last ingest finished 40 minutes ago, past the 15-minute stall threshold: the index is old.
    recordLastIngest(home, "test", now - 40 * MIN);
    const base = { index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any };
    v = await startViewer({ ...base, indexHome: home });
    bare = await startViewer({ ...base });
  });
  after(async () => {
    await v?.close();
    await bare?.close();
    await index?.close();
    sb?.cleanup();
  });

  test("a run item carries its phases, and its agents by phase", async () => {
    const got = (await req(v.port, "/api/work?all=1", { token: v.token })).json();
    const run = got.items.find((i: { workflow?: { id: string } }) => i.workflow?.id === "run-a");
    assert.ok(run, JSON.stringify(got.items.map((i: { id: string }) => i.id)));
    assert.deepEqual(run.workflow.phases.map((p: Record<string, unknown>) => [p.name, p.running, p.failed, p.done, p.costUsd]), [["build", 0, 1, 1, 0.75], ["review", 1, 0, 0, undefined]]);
    const agents = got.workflowAgents[run.id];
    assert.deepEqual(agents.map((a: Record<string, unknown>) => [a.sessionId, a.phase, a.state]), [["lead:sub:b1", "build", "done"], ["lead:sub:b2", "build", "failed"], ["lead:sub:v1", "review", "running"]]);
    assert.equal(agents[0].label, "build:b1");
    assert.ok(agents.every((a: Record<string, unknown>) => !("startedAt" in a)));
    assert.deepEqual(Object.keys(got.workflowAgents), [run.id], "only run items have agents");
  });

  test("a superseded failure names the item that superseded it, with that item's session", async () => {
    const got = (await req(v.port, "/api/work", { token: v.token })).json();
    const failed = got.items.find((i: { sessionId: string }) => i.sessionId === "failed");
    assert.equal(failed.supersededBy, workItemId("passed"));
    // The item that superseded it ended with no failure, so it is hidden as done; the page still links it.
    assert.ok(!got.items.some((i: { id: string }) => i.id === failed.supersededBy));
    assert.deepEqual(got.sessionOf, { [workItemId("passed")]: "passed" });
  });

  test("an item's page carries a run's agents and a superseded failure's link, as work show gives them", async () => {
    const items = (await req(v.port, "/api/work?all=1", { token: v.token })).json().items;
    const run = items.find((i: { workflow?: { id: string } }) => i.workflow?.id === "run-a");
    const failed = workItemId("failed");
    const review = workItemId("change");
    for (const id of [run.id, failed, review]) {
      const res = await req(v.port, `/api/work/${id}`, { token: v.token });
      assert.equal(res.status, 200, res.body);
      // The index is old, so both sides judge the item as of its last ingest: no clock to split them.
      const { now: at, index: age, sessionOf: _, ...got } = res.json();
      assert.deepEqual(got, await showJson(sb, id));
      assert.equal(at, age.updatedAt);
    }
    assert.equal((await showJson(sb, review)).reason, "finished 30m ago with 1 file changed", "work show counts a review item's age from the last ingest, as the list does");
    const agents = (await req(v.port, `/api/work/${run.id}`, { token: v.token })).json().workflowAgents;
    assert.deepEqual(agents.map((a: Record<string, unknown>) => [a.sessionId, a.phase, a.state]), [["lead:sub:b1", "build", "done"], ["lead:sub:b2", "build", "failed"], ["lead:sub:v1", "review", "running"]]);
    assert.match(agents[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
    const superseded = (await req(v.port, `/api/work/${failed}`, { token: v.token })).json();
    assert.equal(superseded.supersededBy, workItemId("passed"));
    assert.deepEqual(superseded.sessionOf, { [workItemId("passed")]: "passed" });
    assert.equal((await req(bare.port, `/api/work/${failed}`, { token: bare.token })).json().index, undefined);
  });

  test("carries the index's age in the CLI's words, and judges an old index's queue as of its last ingest", async () => {
    const got = (await req(v.port, "/api/work", { token: v.token })).json();
    assert.deepEqual(got.index, { updatedAt: new Date(now - 40 * MIN).toISOString(), stale: true, text: "index updated 40m ago: waits and stalls are as of then; run coding.sh ingest" });
    assert.equal(got.now, got.index.updatedAt, "the reasons' ages count from the last ingest, as coding.sh work counts them");
    const ingest = (await req(v.port, "/api/ingest", { token: v.token })).json();
    assert.deepEqual(ingest.index, { ...got.index, text: "index updated 40m ago; run coding.sh ingest" });
    recordLastIngest(sb.env.CODING_SH_HOME!, "test", Date.now() - 4 * MIN);
    try {
      const fresh = (await req(v.port, "/api/work", { token: v.token })).json();
      assert.equal(fresh.index.stale, undefined);
      assert.equal(fresh.index.text, "index updated 4m ago");
      assert.notEqual(fresh.now, fresh.index.updatedAt);
    } finally {
      recordLastIngest(sb.env.CODING_SH_HOME!, "test", now - 40 * MIN);
    }
  });

  test("a viewer that names no index home (a --store, or coding.sh serve) sends no age", async () => {
    const got = (await req(bare.port, "/api/work", { token: bare.token })).json();
    assert.equal("index" in got, false);
    assert.equal("index" in (await req(bare.port, "/api/ingest", { token: bare.token })).json(), false);
  });
});

describe("viewer /api/work: a big queue", () => {
  const MIN = 60e3;
  const now = Date.now();
  const index = new MemoryIndexStore();
  let dir: string;
  let v: Viewer;
  const get = (path: string, headers: Record<string, string> = {}) => req(v.port, path, { token: v.token, headers });
  const gunzip = (r: Res) => JSON.parse(gunzipSync(r.raw).toString("utf8"));

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-big-"));
    // 1,050 changes to review, one a minute: more than one answer lists.
    for (let n = 0; n < 1050; n++) await index.upsertSession(mkSession(`r${n}`, now - (n + 10) * MIN, { cwd: "/work/demo", title: `change ${n}`, stats: { filesChanged: 1 } }));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
  });
  after(async () => {
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a limit lists up to 1,000 items, and totals count the rest", async () => {
    const got = (await get("/api/work?limit=5000")).json();
    assert.equal(got.items.length, 1000);
    assert.equal(got.more, 50);
    assert.equal(got.totals.review, 1050);
    assert.equal((await get("/api/work?limit=600")).json().items.length, 600);
  });

  test("gzips the answer when the request takes gzip, and sends it plain when not", async () => {
    const path = "/api/work?limit=200";
    const plain = await get(path);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.headers.vary, "Accept-Encoding");
    assert.ok(plain.raw.length > 32 * 1024, `${plain.raw.length} bytes: big enough to gzip`);
    const zipped = await get(path, { "accept-encoding": "gzip, deflate, br" });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers["content-encoding"], "gzip");
    assert.equal(zipped.headers.vary, "Accept-Encoding");
    assert.equal(zipped.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(Number(zipped.headers["content-length"]), zipped.raw.length);
    assert.ok(zipped.raw.length * 4 < plain.raw.length, `${zipped.raw.length} gzipped bytes, ${plain.raw.length} plain`);
    const ids = (doc: { items: { id: string }[] }) => doc.items.map((i) => i.id);
    assert.deepEqual(ids(gunzip(zipped)), ids(plain.json()));
    // A client that refuses gzip gets it plain.
    const refused = await get(path, { "accept-encoding": "gzip;q=0, identity" });
    assert.equal(refused.headers["content-encoding"], undefined);
    assert.deepEqual(ids(refused.json()), ids(plain.json()));
    // A small answer goes plain, with no Vary: it is the same whatever the client takes.
    const small = await get("/api/work?limit=1", { "accept-encoding": "gzip" });
    assert.equal(small.headers["content-encoding"], undefined);
    assert.equal(small.headers.vary, undefined);
  });

  test("gzips a big /api/sessions answer too", async () => {
    const r = await get("/api/sessions?scope=top&limit=500", { "accept-encoding": "gzip" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.equal(r.headers.vary, "Accept-Encoding");
    assert.equal(gunzip(r).items.length, 500);
  });
});
