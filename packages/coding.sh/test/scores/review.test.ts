// Review queues: review create|list|status|next|done|skip on a SQLite store under a throwaway
// CODING_SH_HOME, the /api/review routes on the local ui and through the viewer handler as
// serve mounts it (the assignee filter, a project-scoped key), and the store methods on
// SQLite and memory.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { IndexStore, ReviewItem } from "../../src/core/types.ts";
import { reviewCliError } from "../../src/cli/commands/review.ts";
import { CliError } from "../../src/cli/output.ts";
import { completeItem, createQueue, NO_REVIEW, nextItem, queueStatus, ReviewError, reviewStore, sample, skipItem } from "../../src/scores/review.ts";
import { addScore, addScoreConfig } from "../../src/scores/scores.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { createViewerHandler, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session, T0 } from "../query/_seed.ts";

/** Three codex sessions (one flagged), one gemini session, and one codex subagent. */
const SESSIONS = [
  session("c1", { agent: "codex", startedAt: T0 + 1000, title: "fix the parser", flags: ["looping"] }),
  session("c2", { agent: "codex", startedAt: T0 + 2000, title: "add a flag" }),
  session("c3", { agent: "codex", startedAt: T0 + 3000, title: "write docs" }),
  session("g1", { agent: "gemini-cli", startedAt: T0 + 4000 }),
  session("c1-sub", { agent: "codex", startedAt: T0 + 1500, parent: { sessionId: "c1", type: "subagent" } as never }),
];

async function seeded(index: IndexStore): Promise<IndexStore> {
  for (const s of SESSIONS) await index.upsertSession(s);
  await addScoreConfig(index, { name: "correct", dataType: "boolean" }, T0);
  await addScoreConfig(index, { name: "stars", dataType: "numeric", min: 1, max: 5 }, T0);
  return index;
}

const humanWrite = (index: IndexStore, by = "tester") => async (body: Record<string, unknown>) => (await addScore(index, body, { by, source: "human", now: T0 })).score;

describe("store methods", () => {
  for (const [kind, open] of [
    ["memory", async () => new MemoryIndexStore()],
    ["sqlite", async () => SqliteIndexStore.open(":memory:")],
  ] as [string, () => Promise<IndexStore>][]) {
    test(`${kind}: a queue and its items, written together, by name and id; a taken name writes nothing`, async () => {
      const s = await open();
      try {
        const items: ReviewItem[] = [
          { queue: "b", id: 2, target: "session", targetId: "x2", sessionId: "x2", status: "pending" },
          { queue: "b", id: 1, target: "session", targetId: "x1", sessionId: "x1", status: "pending", assignee: "alice" },
        ];
        assert.equal(await s.createReviewQueue!({ name: "b", where: "agent:codex", config: "correct", createdAt: 5 }, items), true);
        assert.equal(await s.createReviewQueue!({ name: "a", where: "tool:Bash", config: "stars", createdAt: 6 }, []), true);
        assert.equal(await s.createReviewQueue!({ name: "b", where: "other", config: "x", createdAt: 7 }, [{ ...items[0]!, id: 9 }]), false);
        assert.deepEqual(await s.listReviewQueues!(), [
          { name: "a", where: "tool:Bash", config: "stars", createdAt: 6 },
          { name: "b", where: "agent:codex", config: "correct", createdAt: 5 },
        ]);
        assert.deepEqual(await s.listReviewItems!("b"), [items[1], items[0]]);
        await s.putReviewItem!({ ...items[0]!, status: "done", completedAt: 10, scoreId: "sc1" });
        await s.putReviewItem!({ queue: "b", id: 99, target: "session", targetId: "nope", status: "done" });
        assert.deepEqual(await s.listReviewItems!("b"), [items[1], { ...items[0], status: "done", completedAt: 10, scoreId: "sc1" }]);
        assert.deepEqual(await s.listReviewItems!("missing"), []);
        // Purging a session drops its items.
        await s.upsertSession(session("x1"));
        await s.deleteSessions!(["x1"]);
        assert.deepEqual((await s.listReviewItems!("b")).map((i) => i.id), [2]);
      } finally {
        await s.close();
      }
    });
  }

  test("a store without review queues says so, and the CLI exits 1", () => {
    const bare: IndexStore = { kind: "postgres" } as never;
    assert.throws(() => reviewStore(bare), (e: unknown) => e instanceof ReviewError && e.message === NO_REVIEW && e.status === 501);
    const err = reviewCliError(new ReviewError("no_review", NO_REVIEW));
    assert.ok(err instanceof CliError);
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /review queues need the local index/);
  });
});

describe("createQueue, nextItem, completeItem, skipItem", () => {
  test("the matching root sessions, newest first, empty ones left out", async () => {
    const index = await seeded(new MemoryIndexStore());
    await index.upsertSession(session("c0", { agent: "codex", startedAt: T0 + 500, stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    const r = await createQueue(index, { name: "q", where: "agent:codex", config: "correct", now: T0 });
    assert.deepEqual(r.items.map((i) => [i.id, i.targetId, i.status]), [[1, "c3", "pending"], [2, "c2", "pending"], [3, "c1", "pending"]]);
    assert.equal(r.matched, 3);
    assert.deepEqual(await queueStatus(index, "q"), { queue: "q", config: "correct", done: 0, skipped: 0, total: 3 });
  });

  test("--sample picks n at random; more than match takes them all", async () => {
    const index = await seeded(new MemoryIndexStore());
    const r = await createQueue(index, { name: "two", where: "agent:codex", config: "correct", sample: 2, random: () => 0.99 });
    assert.equal(r.items.length, 2);
    assert.equal(r.matched, 3);
    assert.deepEqual(r.items.map((i) => i.id), [1, 2]);
    assert.equal(new Set(r.items.map((i) => i.targetId)).size, 2);
    const all = await createQueue(index, { name: "ten", where: "agent:codex", config: "correct", sample: 10 });
    assert.equal(all.items.length, 3);
    // sample() itself: n distinct, drawn by `random`.
    const xs = Array.from({ length: 50 }, (_, i) => i);
    for (const n of [0, 1, 7, 50]) {
      const got = sample(xs, n, Math.random);
      assert.equal(got.length, n);
      assert.equal(new Set(got).size, n);
    }
    assert.deepEqual(sample([1, 2, 3, 4], 2, () => 0), [1, 2]);
  });

  test("the query is checked first, then the config, then the name", async () => {
    const index = await seeded(new MemoryIndexStore());
    await assert.rejects(createQueue(index, { name: "q", where: "agent:(", config: "nope" }), { name: "QueryError" });
    await assert.rejects(createQueue(index, { name: "q", where: "agent:codex", config: "nope" }), (e: unknown) => e instanceof ReviewError && e.reason === "unknown_config" && /Score configs: correct, stars\./.test(e.message));
    await createQueue(index, { name: "q", where: "agent:codex", config: "correct" });
    await assert.rejects(createQueue(index, { name: "q", where: "agent:codex", config: "correct" }), (e: unknown) => e instanceof ReviewError && e.reason === "queue_exists");
    await assert.rejects(createQueue(index, { name: "no match", where: "agent:codex", config: "correct" }), (e: unknown) => e instanceof ReviewError && e.reason === "bad_name");
    await assert.rejects(createQueue(index, { name: "none", where: "agent:nobody", config: "correct" }), (e: unknown) => e instanceof ReviewError && e.reason === "no_match");
  });

  test("with no score configs, the message says so and the CLI gives the fix once, as its next step", async () => {
    const index = new MemoryIndexStore();
    for (const s of SESSIONS) await index.upsertSession(s);
    const e = await createQueue(index, { name: "q", where: "agent:codex", config: "correct" }).then(() => undefined, (x: unknown) => x);
    assert.ok(e instanceof ReviewError && e.reason === "unknown_config");
    assert.equal(e.message, 'No score config named "correct". No score configs yet.');
    const err = reviewCliError(e, "agent:codex", "correct");
    assert.ok(err instanceof CliError);
    assert.deepEqual(err.next, ["Add a config, e.g.:", "coding.sh score config correct --type boolean"]);
    assert.equal([err.message, ...err.next].join(" ").split("coding.sh score config").length - 1, 1);
  });

  test("next skips items assigned to someone else and sessions the caller cannot see", async () => {
    const index = await seeded(new MemoryIndexStore());
    await createQueue(index, { name: "bobs", where: "agent:codex", config: "correct", assign: "bob" });
    assert.equal(await nextItem(index, "bobs", { assignee: "alice" }), undefined);
    const forBob = await nextItem(index, "bobs", { assignee: "bob" });
    assert.equal(forBob?.item, 1);
    assert.equal(forBob?.assignee, "bob");
    assert.equal((await nextItem(index, "bobs"))?.item, 1);
    const hidden = await nextItem(index, "bobs", { visible: async (sid) => sid !== "c3" });
    assert.equal(hidden?.targetId, "c2");
    await assert.rejects(completeItem(index, "bobs", 1, true, humanWrite(index), { assignee: "alice" }), (e: unknown) => e instanceof ReviewError && e.status === 403);
  });

  test("done writes a human score with the queue's config and marks the item; a value that does not fit is refused", async () => {
    const index = await seeded(new MemoryIndexStore());
    await createQueue(index, { name: "q", where: "agent:codex", config: "stars" });
    const first = await nextItem(index, "q");
    assert.deepEqual(
      { item: first?.item, sessionId: first?.sessionId, title: first?.title, agent: first?.agent, values: first?.values, command: first?.command, pending: first?.pending },
      { item: 1, sessionId: "c3", title: "write docs", agent: "codex", values: "1..5", command: "coding.sh review done q 1 <1..5>", pending: 3 },
    );
    await assert.rejects(completeItem(index, "q", 1, 9, humanWrite(index)), { name: "ScoreError", message: "value 9 is above stars's maximum 5" });
    assert.equal((await queueStatus(index, "q")).done, 0);
    const r = await completeItem(index, "q", 1, 4, humanWrite(index), { comment: "good", now: T0 + 5 });
    assert.deepEqual([r.score.name, r.score.value, r.score.source, r.score.by, r.score.target, r.score.targetId, r.score.configId, r.score.comment], ["stars", 4, "human", "tester", "session", "c3", "stars", "good"]);
    assert.deepEqual(r.item, { queue: "q", id: 1, target: "session", targetId: "c3", sessionId: "c3", status: "done", completedAt: T0 + 5, scoreId: r.score.id });
    await skipItem(index, "q", "c2");
    await assert.rejects(skipItem(index, "q", 1), /is done already/);
    await assert.rejects(skipItem(index, "q", 7), (e: unknown) => e instanceof ReviewError && e.reason === "unknown_item");
    assert.deepEqual(await queueStatus(index, "q"), { queue: "q", config: "stars", done: 1, skipped: 1, total: 3 });
    assert.equal((await nextItem(index, "q"))?.targetId, "c1");
    await completeItem(index, "q", 3, 2, humanWrite(index));
    assert.equal(await nextItem(index, "q"), undefined);
  });
});

describe("review on the CLI and /api/review on the local ui", () => {
  let env: TmpEnv;
  let viewer: Viewer;
  let index: SqliteIndexStore;
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${viewer.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${viewer.token}`, connection: "close", ...(body === undefined ? undefined : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, json: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
  };

  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: SESSIONS });
    index = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    viewer = await startViewer({ index, blobs: new FsBlobStore(join(env.dataHome, "blobs")), port: 0 });
    ok(["score", "config", "correct", "--type", "boolean"]);
  });
  after(async () => {
    await viewer.close();
    await index.close();
    env.restore();
  });

  test("create, complete one through POST /api/review, status and score list", async () => {
    const made = JSON.parse(ok(["review", "create", "q", "--where", "agent:codex", "--config", "correct", "--json"]).stdout);
    assert.equal(made.total, 3);
    assert.match(ok(["review", "list"]).stdout, /q\s+correct\s+0\s+0\s+3/);

    const next = await http("GET", "/api/review/q/next");
    assert.equal(next.status, 200);
    assert.equal(next.json.item, 1);
    assert.equal(next.json.sessionId, "c3");
    const posted = await http("POST", "/api/review/q/1", { value: true, comment: "right" });
    assert.equal(posted.status, 200, JSON.stringify(posted.json));
    const score = posted.json.score as Record<string, unknown>;
    assert.deepEqual([score.name, score.value, score.source, score.targetId, score.comment], ["correct", true, "human", "c3", "right"]);
    assert.equal((posted.json.item as Record<string, unknown>).status, "done");
    assert.equal((posted.json.next as Record<string, unknown>).item, 2);

    assert.deepEqual(JSON.parse(ok(["review", "status", "q", "--json"]).stdout), { queue: "q", config: "correct", done: 1, skipped: 0, total: 3 });
    const scores = JSON.parse(ok(["score", "list", "--name", "correct", "--json"]).stdout).items as { id: string; targetId: string; value: unknown }[];
    assert.deepEqual(scores.map((s) => [s.id, s.targetId, s.value]), [[score.id, "c3", true]]);

    const queues = (await http("GET", "/api/review")).json.items as Record<string, unknown>[];
    assert.equal(typeof queues[0]!.createdAt, "number");
    assert.deepEqual(queues.map(({ createdAt: _c, ...q }) => q), [{ queue: "q", config: "correct", done: 1, skipped: 0, total: 3, where: "agent:codex" }]);
    assert.deepEqual((await http("GET", "/api/review/q")).json, { queue: "q", config: "correct", done: 1, skipped: 0, total: 3 });
  });

  test("POST: a value that does not fit is a 400 and changes nothing; skip; then 204", async () => {
    ok(["review", "create", "p", "--where", "agent:codex", "--config", "correct"]);
    const bad = await http("POST", "/api/review/p/1", { value: "maybe" });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /true or false/);
    assert.equal((await http("POST", "/api/review/p/1", {})).status, 400);
    assert.equal((await http("POST", "/api/review/p/1", { value: true }, { origin: "https://evil.example" })).status, 403);
    assert.equal(JSON.parse(ok(["review", "status", "p", "--json"]).stdout).done, 0);
    const skipped = await http("POST", "/api/review/p/1", { skip: true });
    assert.equal(skipped.status, 200);
    assert.equal((skipped.json.item as Record<string, unknown>).status, "skipped");
    assert.equal((await http("POST", "/api/review/p/2", { value: false })).status, 200);
    assert.equal((await http("POST", "/api/review/p/c1", { value: 1 })).status, 200);
    const empty = await fetch(`http://127.0.0.1:${viewer.port}/api/review/p/next`, { headers: { authorization: `Bearer ${viewer.token}`, connection: "close" } });
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), "");
    assert.deepEqual(JSON.parse(ok(["review", "status", "p", "--json"]).stdout), { queue: "p", config: "correct", done: 2, skipped: 1, total: 3 });
    assert.equal((await http("GET", "/api/review/nope")).status, 404);
    assert.equal((await http("GET", "/api/review/nope/next")).status, 404);
    assert.equal((await http("GET", "/api/review/p/9")).status, 405, "an item answers POST only");
    assert.equal((await http("POST", "/api/review/p/9", { value: true })).status, 404);
    assert.equal((await http("DELETE", "/api/review/p/1")).status, 405);
  });

  test("review next, done and skip on the CLI", () => {
    ok(["review", "create", "cli", "--where", "agent:codex", "--config", "correct", "--sample", "2"]);
    const next = ok(["review", "next", "cli"]);
    assert.match(next.stdout, /Item 1 of cli \(2 pending items\)/);
    assert.match(next.stderr + next.stdout, /coding\.sh review done cli 1 <true\|false>/);
    const bad = cli(["review", "done", "cli", "1", "maybe"]);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /true or false/);
    const done = JSON.parse(ok(["review", "done", "cli", "1", "false", "--comment", "wrong file", "--json"]).stdout);
    assert.equal(done.score.value, false);
    assert.equal(done.score.source, "human");
    assert.equal(done.item.scoreId, done.score.id);
    assert.equal(done.next.item, 2);
    ok(["review", "skip", "cli", "2"]);
    assert.equal(JSON.parse(ok(["review", "next", "cli", "--json"]).stdout).next, null);
    assert.match(ok(["review", "next", "cli"]).stderr + ok(["review", "next", "cli"]).stdout, /is done: no pending items/);
    assert.deepEqual(JSON.parse(ok(["review", "status", "cli", "--json"]).stdout), { queue: "cli", config: "correct", done: 1, skipped: 1, total: 2 });
  });

  test("create refuses a bad query (2), an unknown config (1, naming the configs) and a taken name (1)", () => {
    const q = cli(["review", "create", "x", "--where", "agent:(", "--config", "nope"]);
    assert.equal(q.status, 2, q.stderr);
    assert.match(q.stderr, /--where: /);
    const c = cli(["review", "create", "x", "--where", "agent:codex", "--config", "nope"]);
    assert.equal(c.status, 1, c.stderr);
    assert.match(c.stderr, /No score config named "nope"\. Score configs: correct\./);
    ok(["review", "create", "taken", "--where", "agent:codex", "--config", "correct"]);
    const t = cli(["review", "create", "taken", "--where", "agent:gemini-cli", "--config", "correct"]);
    assert.equal(t.status, 1, t.stderr);
    assert.match(t.stderr, /exists already/);
    const u = cli(["review", "status", "missing"]);
    assert.equal(u.status, 1);
    assert.match(u.stderr, /No review queue named "missing"\. Review queues: /);
    const n = cli(["review", "create", "s", "--where", "agent:codex", "--config", "correct", "--sample", "0"]);
    assert.equal(n.status, 2, n.stderr);
  });

  test("printed commands run in the user's shell: the item's command in --json, and the query that matched nothing", () => {
    // PowerShell and cmd set no MSYSTEM or SHELL; there the CLI is codingsh, and a query takes double quotes.
    const ps = { MSYSTEM: undefined, SHELL: undefined };
    const win = process.platform === "win32";
    const bin = win ? "codingsh" : "coding.sh";
    ok(["review", "create", "ps", "--where", "agent:codex", "--config", "correct"]);
    assert.equal(JSON.parse(ok(["review", "next", "ps", "--json"], ps).stdout).next.command, `${bin} review done ps 1 <true|false>`);
    assert.equal(JSON.parse(ok(["review", "skip", "ps", "1", "--json"], ps).stdout).next.command, `${bin} review done ps 2 <true|false>`);
    const none = cli(["review", "create", "none", "--where", "agent:nobody is:flagged", "--config", "correct"], ps);
    assert.equal(none.status, 1, none.stderr);
    assert.match(none.stderr, new RegExp(`^\\s*${bin.replace(".", "\\.")} sessions --where ${win ? '"agent:nobody is:flagged"' : "'agent:nobody is:flagged'"}$`, "m"));
  });
});

describe("/api/review through the viewer handler (as serve mounts it)", () => {
  const servers: Server[] = [];
  after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });
  /** x-key names the caller like a read key's name; x-project scopes it like a project key. */
  const mount = async (index: IndexStore) => {
    let port = 0;
    const handler = await createViewerHandler({
      index,
      blobs: new MemoryBlobStore(),
      authorize: (req) => ({ ...projectOf(req.headers["x-project"]), by: String(req.headers["x-key"] ?? "alice") }),
      checkHost: (h) => h === `127.0.0.1:${port}`,
      updateStatus: async () => ({ current: "0.0.0" }) as never,
    });
    const server = createServer((req, res) => void handler(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { connection: "close", ...(body === undefined ? undefined : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, json: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
    };
  };

  test("next returns only items assigned to the key or to no one, and the score is by the key's name", async () => {
    const index = await seeded(new MemoryIndexStore());
    await createQueue(index, { name: "bobs", where: "agent:codex", config: "correct", assign: "bob" });
    await createQueue(index, { name: "open", where: "agent:codex", config: "correct" });
    const http = await mount(index);
    assert.equal((await http("GET", "/api/review/bobs/next", undefined, { "x-key": "alice" })).status, 204);
    const bob = await http("GET", "/api/review/bobs/next", undefined, { "x-key": "bob" });
    assert.equal(bob.status, 200);
    assert.equal(bob.json.assignee, "bob");
    assert.equal((await http("POST", "/api/review/bobs/1", { value: true }, { "x-key": "alice" })).status, 403);
    assert.equal((await http("POST", "/api/review/bobs/1", { skip: true }, { "x-key": "alice" })).status, 403);
    const done = await http("POST", "/api/review/bobs/1", { value: true }, { "x-key": "bob" });
    assert.equal(done.status, 200);
    assert.equal((done.json.score as Record<string, unknown>).by, "bob");
    assert.equal((await http("GET", "/api/review/open/next", undefined, { "x-key": "alice" })).json.item, 1);
    const alice = await http("POST", "/api/review/open/1", { value: false }, { "x-key": "alice" });
    assert.equal((alice.json.score as Record<string, unknown>).by, "alice");
  });

  test("a project-scoped key sees none of another project's items", async () => {
    const index = await seeded(new MemoryIndexStore());
    await createQueue(index, { name: "q", where: "agent:codex", config: "correct" });
    const http = await mount(index);
    const scoped = { "x-project": "elsewhere" };
    assert.equal((await http("GET", "/api/review/q/next", undefined, scoped)).status, 204);
    assert.equal((await http("POST", "/api/review/q/1", { value: true }, scoped)).status, 404);
    assert.equal((await http("POST", "/api/review/q/1", { skip: true }, scoped)).status, 404);
    assert.equal((await queueStatus(index, "q")).done, 0);
  });

  test("a store without review queues answers 501", async () => {
    const bare = new MemoryIndexStore();
    (bare as { listReviewQueues?: unknown }).listReviewQueues = undefined;
    const http = await mount(bare);
    const r = await http("GET", "/api/review");
    assert.equal(r.status, 501);
    assert.equal(r.json.error, NO_REVIEW);
  });
});

/** `{ project }` for a scoped caller, `{}` for one with no project header. */
function projectOf(h: string | string[] | undefined): { project?: string } {
  const out: { project?: string } = {};
  if (h) out.project = String(h);
  return out;
}
