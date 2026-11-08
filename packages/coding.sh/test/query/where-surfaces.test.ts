// One --where string returns the same session ids from the CLI, the MCP tools and the
// viewer API, on a SQLite store under a throwaway CODING_SH_HOME. Bad queries are
// usage errors with a reason, an offset and a hint on every surface.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { openContext, type Context } from "../../src/core/context.ts";
import { buildTools, type ToolCtx } from "../../src/mcp/tools.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, T0 } from "./_seed.ts";
import { fixture } from "./_where-fixture.ts";

const QUERIES = [
  "agent:codex",
  "tool:Bash ok:false",
  "-tool:Bash",
  "cost>0.01 -flag:compaction",
  "(agent:gemini OR model:claude-*) has:cost",
  "repo:demo is:root",
  "migration",
  "skill:pdf OR skill:docx",
  "duration>10m",
  "agent:codex,claude-code sort:-cost",
];
// Every session in the fixture started before NOW; the MCP tools need a window that covers them.
const NOW = T0 + 86_400_000;

describe("--where on CLI, MCP and HTTP", () => {
  let env: TmpEnv;
  let viewer: Viewer;
  let index: SqliteIndexStore;
  const tools = buildTools();
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  let ctx: ToolCtx;
  let opened: Context;

  before(async () => {
    env = tmpEnv();
    const { sessions, events } = fixture();
    await seed(env.dataHome, { sessions, events });
    index = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    viewer = await startViewer({ index, blobs: new FsBlobStore(join(env.dataHome, "blobs")), port: 0 });
    opened = await openContext({ env: process.env });
    ctx = { env: process.env, cwd: env.root, now: () => NOW, store: async () => opened };
  });
  after(async () => {
    await viewer.close();
    await index.close();
    // The MCP tools' store: left open, Windows cannot remove index.db (EBUSY).
    await opened.close();
    env.restore();
  });

  // A fresh connection per request: the CLI runs below (spawnSync) block this event loop, so
  // fetch's keep-alive clock stalls while the viewer's runs on, and fetch would reuse a socket
  // the viewer has just closed (ECONNRESET).
  const http = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${viewer.port}${path}`, { headers: { authorization: `Bearer ${viewer.token}`, connection: "close" } });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  for (const q of QUERIES) {
    test(q, async () => {
      const viaCli = (JSON.parse(ok(["sessions", "--subagents", "--limit", "100", "--where", q, "--json"]).stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
      const viaHttp = ((await http(`/api/sessions?limit=100&where=${encodeURIComponent(q)}`)).json.items as { id: string }[]).map((s) => s.id);
      const mcp = (await tool("sessions_list").run({ where: q, includeSubagents: true, limit: 100 }, ctx)) as { sessions: { id: string }[] };
      const viaMcp = mcp.sessions.map((s) => s.id);
      // MCP lists newest first whatever the sort; compare as sets there, in order elsewhere.
      assert.deepEqual(viaHttp, viaCli, `HTTP vs CLI for ${q}`);
      assert.deepEqual([...viaMcp].sort(), [...viaCli].sort(), `MCP vs CLI for ${q}`);
    });
  }

  test("facets agree on CLI, MCP and HTTP", async () => {
    const q = "agent:codex";
    const viaCli = JSON.parse(ok(["sessions", "--subagents", "--facets", "agent,tool", "--where", q, "--json"]).stdout).facets;
    const viaHttp = (await http(`/api/facets?keys=agent,tool&limit=10&where=${encodeURIComponent(q)}`)).json.facets;
    const viaMcp = ((await tool("sessions_list").run({ where: q, includeSubagents: true, facets: ["agent", "tool"] }, ctx)) as { facets: unknown }).facets;
    assert.deepEqual(viaHttp, viaCli);
    assert.deepEqual(viaMcp, viaCli);
    assert.deepEqual(viaCli.agent[0], { value: "claude-code", count: 2 });
    // The example in docs/reference/api.md.
    const doc = await http(`/api/facets?keys=agent,tool&where=-flag:compaction`);
    assert.deepEqual(doc.json, {
      facets: {
        agent: [{ value: "codex", count: 2 }, { value: "claude-code", count: 1 }, { value: "gemini", count: 1 }],
        tool: [{ value: "Bash", count: 3 }, { value: "Edit", count: 1 }, { value: "Grep", count: 1 }],
      },
    });
    assert.equal((await http(`/api/facets?keys=nope`)).status, 400);
    assert.equal((await http(`/api/sessions?where=agent:codex&cursor=1:s1`)).status, 400);
  });

  test("search, usage and export take the same query", async () => {
    const hits = JSON.parse(ok(["search", "migration", "--where", "agent:codex", "--json"]).stdout).hits as { eventId: string }[];
    assert.deepEqual(hits.map((h) => h.eventId), ["s1-e1"]);
    const mcpHits = (await tool("search").run({ query: "migration", where: "agent:codex" }, ctx)) as { hits: { eventId: string }[] };
    assert.deepEqual(mcpHits.hits.map((h) => h.eventId), ["s1-e1"]);
    const httpHits = (await http(`/api/search?q=migration&where=${encodeURIComponent("agent:codex")}`)).json.items as { event: { id: string } }[];
    assert.deepEqual(httpHits.map((h) => h.event.id), ["s1-e1"]);

    const usage = JSON.parse(ok(["usage", "--since", "2026-10-01", "--where", "agent:codex", "--json"]).stdout) as { total: { sessions: number } };
    assert.equal(usage.total.sessions, 2);
    const mcpUsage = (await tool("usage").run({ since: "2026-10-01", groupBy: "agent", where: "agent:codex" }, ctx)) as { groups: { key: string }[] };
    assert.deepEqual(mcpUsage.groups.map((g) => g.key), ["codex"]);

    const lines = ok(["export", "sessions", "--subagents", "--where", "tool:Bash ok:false"]).stdout.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
    assert.deepEqual(lines, ["s4", "s1"]);
    const sorted = ok(["export", "sessions", "--subagents", "--where", "sort:-cost limit:2"]).stdout.trim().split("\n").map((l) => (JSON.parse(l) as { id: string }).id);
    assert.deepEqual(sorted, ["s1", "s2"]);
  });

  test("a bad query is a usage error with reason, offset and a hint", async () => {
    const r = cli(["sessions", "--where", "agent:codex modle:x", "--json"]);
    assert.equal(r.status, 2);
    const err = JSON.parse(r.stderr.trim().split("\n").pop()!);
    assert.equal(err.reason, "unknown_key");
    assert.deepEqual(err.data, { offset: 12 });
    assert.match(err.next[0], /model:/);
    const text = cli(["sessions", "--where", "cost>abc"]);
    assert.equal(text.status, 2);
    assert.match(text.stderr, /cost: must be a USD amount/);
    assert.match(text.stderr, /\n\s+\^/);

    const h = await http(`/api/sessions?where=${encodeURIComponent("agent:codex modle:x")}`);
    assert.equal(h.status, 400);
    assert.equal(h.json.reason, "unknown_key");
    assert.deepEqual(h.json, { error: 'where: unknown key "modle"', status: 400, reason: "unknown_key", offset: 12, next: ["did you mean model:?"] });

    await assert.rejects(tool("sessions_list").run({ where: "agent:codex modle:x" }, ctx), /Invalid where at character 13: unknown key "modle"/);
    assert.equal(cli(["sessions", "--facets", "nope"]).status, 2);
  });

  test("the viewer lists matching events, keyset-paged, with their session and a count", async () => {
    const first = await http(`/api/events?limit=1&where=${encodeURIComponent("tool:Bash ok:false")}`);
    assert.equal(first.status, 200);
    const items = first.json.items as { id: string; kind: string; payload: { tool: string }; session: { id: string; title?: string; agent: string } }[];
    assert.deepEqual(items.map((e) => [e.id, e.kind, e.payload.tool, e.session.id, e.session.agent]), [["s1-e3", "tool.end", "Bash", "s1", "codex"]]);
    assert.equal(items[0]!.session.title, "Fix the Build");
    assert.deepEqual([first.json.total, first.json.totalCapped], [2, false]);
    const second = await http(`/api/events?limit=1&where=${encodeURIComponent("tool:Bash ok:false")}&cursor=${encodeURIComponent(first.json.next as string)}`);
    assert.deepEqual((second.json.items as { id: string }[]).map((e) => e.id), ["s4-e1"]);
    assert.equal(second.json.next, undefined);
    assert.equal(second.json.total, undefined, "counted on the first page only");
    // scope=top leaves out the subagent session's (s4) events, as the list leaves out its row.
    const top = await http(`/api/events?scope=top&where=${encodeURIComponent("tool:Bash ok:false")}`);
    assert.deepEqual([(top.json.items as { id: string }[]).map((e) => e.id), top.json.total], [["s1-e3"], 1]);
    assert.equal((await http(`/api/events?scope=nope`)).status, 400);
    // Text queries carry a snippet with the matched words marked.
    const text = await http(`/api/events?where=${encodeURIComponent("migration agent:codex")}`);
    assert.deepEqual((text.json.items as { id: string }[]).map((e) => e.id), ["s1-e1"]);
    assert.match((text.json.items as { snippet: string }[])[0]!.snippet, /migration/);
    assert.equal((await http(`/api/events?cursor=nope`)).status, 400);
    assert.equal((await http(`/api/events?where=${encodeURIComponent("tool:")}`)).status, 400);
  });

  test("facet values autocomplete by prefix; stats follow the query", async () => {
    const f = await http(`/api/facets?keys=tool&prefix=b`);
    assert.deepEqual(f.json.facets, { tool: [{ value: "Bash", count: 3 }] });
    assert.equal((await http(`/api/facets?keys=tool&prefix=${"x".repeat(201)}`)).status, 400);
    const all = await http(`/api/stats`);
    const codex = await http(`/api/stats?where=${encodeURIComponent("agent:codex")}`);
    assert.equal(all.json.sessions, 5);
    assert.equal(codex.json.sessions, 2);
    assert.equal((await http(`/api/stats?where=${encodeURIComponent("modle:x")}`)).status, 400);
  });

  test("the viewer reads the keys it completes from /api/where", async () => {
    const keys = (await http(`/api/where`)).json.keys as { name: string; level: string; facet?: boolean; values?: { value: string }[] }[];
    const by = new Map(keys.map((k) => [k.name, k]));
    assert.equal(by.get("tool")?.level, "event");
    assert.equal(by.get("tool")?.facet, true);
    assert.deepEqual(by.get("ok")?.values?.map((v) => v.value), ["true", "false"]);
    assert.ok(by.get("is")?.values?.some((v) => v.value === "root"));
    assert.ok(by.get("sort")?.values?.some((v) => v.value === "-cost"));
    assert.equal((await http(`/api/where/x`)).status, 404);
  });

  test("old flags still work and combine with --where", () => {
    const ids = (args: string[]) => (JSON.parse(ok(["sessions", ...args, "--json"]).stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    // --agent codex, top-level by default, and turns>=1.
    assert.deepEqual(ids(["--agent", "codex", "--where", "turns>=1"]), ["s1"]);
    assert.deepEqual(ids(["--subagents", "--agent", "codex", "--where", "turns>=1"]), ["s4", "s1"]);
    // is:child (like id: and parent:) says itself that subagents are in; --agent still applies.
    assert.deepEqual(ids(["--agent", "codex", "--where", "is:child"]), ["s4"]);
    assert.deepEqual(ids(["--agent", "claude-code", "--where", "is:child"]), []);
  });
});
