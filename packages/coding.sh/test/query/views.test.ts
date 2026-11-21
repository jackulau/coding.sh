// Saved views: views save|list|rm, sessions --view, the MCP sessions_list view argument and
// /api/views, on a SQLite store under a throwaway CODING_SH_HOME; the store methods on SQLite
// and memory; and the AND of a view with --where keeping each side's OR and negations.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openContext, type Context } from "../../src/core/context.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { viewCliError } from "../../src/cli/commands/views.ts";
import { CliError } from "../../src/cli/output.ts";
import { buildTools, type ToolCtx } from "../../src/mcp/tools.ts";
import { NO_VIEWS, saveView, viewStore, ViewError, withView } from "../../src/query/views.ts";
import { parseWhere, printWhere } from "../../src/query/where.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { createViewerHandler, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, T0 } from "./_seed.ts";
import { fixture } from "./_where-fixture.ts";

const ids = (stdout: string): string[] => (JSON.parse(stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);

describe("withView", () => {
  test("each side keeps its OR and negation", () => {
    assert.equal(printWhere(withView(parseWhere("agent:codex OR agent:gemini"), parseWhere("-flag:x"))), "(agent:codex OR agent:gemini) -flag:x");
    assert.equal(printWhere(withView(parseWhere("-agent:codex"), parseWhere("model:a OR model:b"))), "-agent:codex (model:a OR model:b)");
    assert.equal(printWhere(withView(parseWhere("agent:codex sort:-cost limit:5"), parseWhere("turns>1 limit:2"))), "agent:codex turns>1 sort:-cost limit:2");
    assert.equal(printWhere(withView(parseWhere("agent:codex"), undefined)), "agent:codex");
  });
});

for (const [kind, open] of [
  ["memory", async () => new MemoryIndexStore()],
  ["sqlite", async () => SqliteIndexStore.open(":memory:")],
] as [string, () => Promise<IndexStore>][]) {
  test(`${kind} store keeps views by name`, async () => {
    const s = await open();
    try {
      await s.putView!({ name: "b", where: "agent:codex", createdAt: 1, updatedAt: 1 });
      await s.putView!({ name: "a", where: "tool:Bash", createdAt: 2, updatedAt: 2 });
      await s.putView!({ name: "b", where: "agent:gemini", createdAt: 1, updatedAt: 3 });
      assert.deepEqual(await s.listViews!(), [
        { name: "a", where: "tool:Bash", createdAt: 2, updatedAt: 2 },
        { name: "b", where: "agent:gemini", createdAt: 1, updatedAt: 3 },
      ]);
      assert.equal(await s.deleteView!("a"), true);
      assert.equal(await s.deleteView!("a"), false);
      assert.deepEqual((await s.listViews!()).map((v) => v.name), ["b"]);
      const r = await saveView(s, "b", " agent:codex ", 10);
      assert.deepEqual(r, { view: { name: "b", where: "agent:codex", createdAt: 1, updatedAt: 10 }, replaced: true });
    } finally {
      await s.close();
    }
  });
}

test("a store without views says so, and the CLI exits 1", async () => {
  const bare: IndexStore = { kind: "postgres" } as never;
  assert.throws(() => viewStore(bare), (e: unknown) => e instanceof ViewError && e.message === NO_VIEWS);
  const err = viewCliError(new ViewError("no_views", NO_VIEWS));
  assert.ok(err instanceof CliError);
  assert.equal(err.exitCode, 1);
  assert.equal(err.message, "saved views need the local index (this store has no views)");
});

test("saveView refuses a bad name or query and writes nothing", async () => {
  const s = new MemoryIndexStore();
  await assert.rejects(saveView(s, "has space", "agent:codex"), /view names are 1 to 64/);
  await assert.rejects(saveView(s, "x".repeat(65), "agent:codex"), /view names are 1 to 64/);
  await assert.rejects(saveView(s, "ok", "agent:("), { name: "QueryError" });
  await assert.rejects(saveView(s, "ok", "  "), /needs a query/);
  assert.deepEqual(await s.listViews(), []);
});

describe("saved views on CLI, MCP and HTTP", () => {
  let env: TmpEnv;
  let viewer: Viewer;
  let index: SqliteIndexStore;
  let opened: Context;
  let ctx: ToolCtx;
  const sessionsList = buildTools().find((t) => t.name === "sessions_list")!;

  before(async () => {
    env = tmpEnv();
    const { sessions, events } = fixture();
    await seed(env.dataHome, { sessions, events });
    index = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    viewer = await startViewer({ index, blobs: new FsBlobStore(join(env.dataHome, "blobs")), port: 0 });
    opened = await openContext({ env: process.env });
    ctx = { env: process.env, cwd: env.root, now: () => T0 + 86_400_000, store: async () => opened };
  });
  after(async () => {
    await viewer.close();
    await index.close();
    await opened.close();
    env.restore();
  });

  test("views save, sessions --view, views rm", () => {
    ok(["views", "save", "f", "--where", "flagged agent:codex"]);
    assert.deepEqual(JSON.parse(ok(["sessions", "--view", "f", "--json"]).stdout), JSON.parse(ok(["sessions", "--where", "flagged agent:codex", "--json"]).stdout));

    const saved = ok(["views", "save", "f", "--where", "is:flagged agent:codex", "--json"]);
    assert.equal(JSON.parse(saved.stdout).replaced, true);
    const replaced = ok(["views", "save", "f", "--where", "is:flagged agent:codex"]);
    assert.match(replaced.stderr, /Replaced view f's query/);
    const viaView = ok(["sessions", "--view", "f", "--subagents", "--json"]).stdout;
    assert.deepEqual(ids(viaView), ["s1"]);
    assert.deepEqual(JSON.parse(viaView), JSON.parse(ok(["sessions", "--where", "is:flagged agent:codex", "--subagents", "--json"]).stdout));

    const list = JSON.parse(ok(["views", "list", "--json"]).stdout) as { views: { name: string; where: string }[] };
    assert.deepEqual(list.views.map((v) => [v.name, v.where]), [["f", "is:flagged agent:codex"]]);
    assert.match(ok(["views", "list"]).stdout, /is:flagged agent:codex/);

    ok(["views", "rm", "f"]);
    assert.deepEqual(JSON.parse(ok(["views", "list", "--json"]).stdout).views, []);
    const gone = cli(["sessions", "--view", "f"]);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /No view named "f"\. No views are saved\./);
  });

  test("a query that does not parse exits 2 and stores nothing", () => {
    const r = cli(["views", "save", "bad", "--where", "agent:("]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--where: /);
    const name = cli(["views", "save", "no/slash", "--where", "agent:codex"]);
    assert.equal(name.status, 2, name.stderr);
    assert.deepEqual(JSON.parse(ok(["views", "list", "--json"]).stdout).views, []);
  });

  test("views rm of an unknown name exits 1 and names the views that exist", () => {
    ok(["views", "save", "keep", "--where", "agent:codex"]);
    const r = cli(["views", "rm", "nope"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No view named "nope"\. Saved views: keep\./);
    ok(["views", "rm", "keep"]);
  });

  test("--view and --where together: both hold, each keeps its OR and negation", () => {
    ok(["views", "save", "either", "--where", "agent:codex OR agent:gemini"]);
    ok(["views", "save", "not-codex", "--where", "-agent:codex"]);
    const both = ids(ok(["sessions", "--subagents", "--view", "either", "--where", "-flag:no-verification", "--json"]).stdout);
    assert.deepEqual(both, ids(ok(["sessions", "--subagents", "--where", "(agent:codex OR agent:gemini) -flag:no-verification", "--json"]).stdout));
    assert.deepEqual([...both].sort(), ["s4", "s5"]);
    const neg = ids(ok(["sessions", "--subagents", "--view", "not-codex", "--where", "agent:gemini OR model:claude-sonnet-*", "--json"]).stdout);
    assert.deepEqual([...neg].sort(), ["s2", "s5"]);
    ok(["views", "rm", "either"]);
    ok(["views", "rm", "not-codex"]);
  });

  test("MCP sessions_list takes a view", async () => {
    ok(["views", "save", "codex", "--where", "agent:codex"]);
    const byView = (await sessionsList.run({ view: "codex", includeSubagents: true }, ctx)) as { sessions: { id: string }[] };
    const byWhere = (await sessionsList.run({ where: "agent:codex", includeSubagents: true }, ctx)) as { sessions: { id: string }[] };
    assert.deepEqual(byView, byWhere);
    assert.deepEqual(byView.sessions.map((s) => s.id).sort(), ["s1", "s4"]);
    const and = (await sessionsList.run({ view: "codex", where: "is:root", includeSubagents: true }, ctx)) as { sessions: { id: string }[] };
    assert.deepEqual(and.sessions.map((s) => s.id), ["s1"]);
    await assert.rejects(sessionsList.run({ view: "missing" }, ctx), (e: Error) => e.name === "ToolError" && /No view named "missing"\. Saved views: codex\./.test(e.message));
    ok(["views", "rm", "codex"]);
  });

  test("/api/views: GET, POST, DELETE", async () => {
    const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`http://127.0.0.1:${viewer.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${viewer.token}`, connection: "close", ...(body === undefined ? undefined : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    assert.deepEqual(await http("GET", "/api/views"), { status: 200, json: { items: [] } });
    const made = await http("POST", "/api/views", { name: "zeta", where: "agent:codex" });
    assert.equal(made.status, 201);
    assert.equal(made.json.name, "zeta");
    assert.equal(made.json.where, "agent:codex");
    assert.equal(typeof made.json.createdAt, "number");
    assert.equal(made.json.updatedAt, made.json.createdAt);
    assert.equal((await http("POST", "/api/views", { name: "alpha", where: "tool:Bash" })).status, 201);
    const again = await http("POST", "/api/views", { name: "zeta", where: "agent:gemini" });
    assert.equal(again.status, 200);
    assert.equal(again.json.where, "agent:gemini");
    assert.equal(again.json.createdAt, made.json.createdAt);
    const list = await http("GET", "/api/views");
    assert.deepEqual((list.json.items as { name: string; where: string }[]).map((v) => [v.name, v.where]), [["alpha", "tool:Bash"], ["zeta", "agent:gemini"]]);

    const bad = await http("POST", "/api/views", { name: "bad", where: "agent:(" });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error), /^where: /);
    assert.equal(typeof bad.json.offset, "number");
    const badName = await http("POST", "/api/views", { name: "a b", where: "agent:codex" });
    assert.equal(badName.status, 400);
    assert.match(String(badName.json.error), /view names are 1 to 64/);
    assert.equal((await http("POST", "/api/views", { name: "x" })).status, 400);
    assert.equal((await http("POST", "/api/views", { name: "x", where: "agent:codex" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await http("PUT", "/api/views")).status, 405);

    assert.deepEqual(await http("DELETE", "/api/views/alpha"), { status: 200, json: { ok: true } });
    const missing = await http("DELETE", "/api/views/alpha");
    assert.equal(missing.status, 404);
    assert.match(String(missing.json.error), /Saved views: zeta\./);
    assert.equal((await http("DELETE", "/api/views/zeta", undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await http("DELETE", "/api/views/zeta")).status, 200);
    assert.deepEqual((await http("GET", "/api/views")).json, { items: [] });
  });
});

describe("/api/views through the viewer handler (as serve mounts it)", () => {
  const servers: Server[] = [];
  after(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });
  /** A handler on `index`; x-project scopes a caller like a project read key. */
  const mount = async (index: IndexStore) => {
    let port = 0;
    const handler = await createViewerHandler({
      index,
      blobs: new MemoryBlobStore(),
      authorize: (req) => ({ ...projectOf(req.headers["x-project"]), by: "alice" }),
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
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
  };

  test("a project-scoped key reads views but changes none", async () => {
    const http = await mount(new MemoryIndexStore());
    assert.equal((await http("POST", "/api/views", { name: "mine", where: "agent:codex" })).status, 201);
    const scoped = { "x-project": "demo" };
    assert.deepEqual((await http("GET", "/api/views", undefined, scoped)).json, (await http("GET", "/api/views")).json);
    assert.equal((await http("POST", "/api/views", { name: "x", where: "agent:codex" }, scoped)).status, 403);
    assert.equal((await http("DELETE", "/api/views/mine", undefined, scoped)).status, 403);
    assert.equal(((await http("GET", "/api/views")).json.items as unknown[]).length, 1);
  });

  test("a store without views answers 501 with the reason", async () => {
    const bare = new MemoryIndexStore() as IndexStore;
    Object.assign(bare, { putView: undefined, listViews: undefined, deleteView: undefined });
    const http = await mount(bare);
    const r = await http("GET", "/api/views");
    assert.equal(r.status, 501);
    assert.equal(r.json.error, NO_VIEWS);
  });
});

/** `{ project }` for a scoped caller, `{}` for one with no project header. */
function projectOf(h: string | string[] | undefined): { project?: string } {
  const out: { project?: string } = {};
  if (h) out.project = String(h);
  return out;
}
