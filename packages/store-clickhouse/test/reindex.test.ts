// Migration v2 indexes the error text of rows stored before it was searchable.
// The first test needs no server: it checks which rows get new search text. The
// others rewind a real database to the search text a v1 store wrote, then migrate it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "coding.sh/store";
import { ChClient, nextVer, parseChUrl, quoteIdent, reindexErrorText } from "../src/client.ts";
import { ChIndexStore } from "../src/index-store.ts";
import { searchText, staleSearchRows } from "../src/search.ts";
import { SKIP, dbUrl } from "./helpers.ts";

const ev = (id: string, kind: string, payload: Record<string, unknown>): AgentEvent => ({ id, v: 0, sessionId: `s-${id}`, ts: 1_700_000_000_000, agent: "sdk", kind, payload }) as AgentEvent;

const EVENTS: AgentEvent[] = [
  ev("e1", "error", { message: "API Error: 429", errorType: "rate_limit_error", statusCode: 429 }),
  ev("c1", "llm.call", { ok: false, error: "upstream connect error", errorType: "overloaded_error" }),
  ev("t1", "tool.end", { tool: "Bash", ok: false, error: "permission denied by sandbox", output: "exit 1" }),
  ev("s1", "subagent.end", { subagentId: "a1", type: "reviewer", ok: false, error: "quota exhausted" }),
  ev("x1", "session.end", { reason: "error", error: "agent process segfaulted" }),
];
const MESSAGE = ev("m1", "user.message", { text: "summarize the changelog" });

// The search text a store before v2 wrote: none for errors, tool text without the error.
const oldText = (e: AgentEvent): string => (e.kind === "tool.end" ? " bash exit 1" : e.kind === "user.message" ? searchText(e) : "");
const stored = (e: AgentEvent) => ({ id: e.id, kind: e.kind, payload: JSON.stringify(e.payload), search_text: oldText(e) });

describe("clickhouse search backfill (no server)", () => {
  it("gives new search text to the rows stored without their error text, and leaves the rest", () => {
    const current = ev("t2", "tool.end", { tool: "Read", ok: false, error: "ENOENT wombat", output: "x" });
    const rows = [
      ...EVENTS.map(stored),
      { ...stored(current), search_text: searchText(current) },
      stored(ev("s2", "subagent.end", { subagentId: "a2", ok: true, note: '"error":"in a string"' })),
      { id: "bad", kind: "error", payload: "{not json", search_text: "" },
    ];
    const stale = staleSearchRows(rows);
    assert.deepEqual(stale.map((r) => r.id), ["e1", "c1", "t1", "s1", "x1"], "an up-to-date row, an end without an error and an unreadable payload are left");
    const byId = new Map(stale.map((r) => [r.id, r.search_text]));
    assert.match(byId.get("e1")!, /\brate limit error\b/);
    assert.match(byId.get("t1")!, /\bsandbox\b.*\bexit 1\b/, "the tool's error, before its output");
    assert.equal(byId.get("s1"), " quota exhausted reviewer");
    assert.equal(byId.get("x1"), " agent process segfaulted");
  });
});

/** Stores EVENTS and MESSAGE, then rewrites their search text as a v1 store had it. */
async function rewound(url: string): Promise<{ client: ChClient; d: string }> {
  const store = await ChIndexStore.open(url);
  await store.putEvents([...EVENTS, MESSAGE]);
  await store.close();
  const client = new ChClient(parseChUrl(url));
  const d = quoteIdent(client.url.database);
  const rows = await client.query<Record<string, unknown>>(`SELECT * FROM ${d}.events FINAL`);
  const byId = new Map([...EVENTS, MESSAGE].map((e) => [e.id, e]));
  const floor = nextVer();
  await client.insert(`${d}.events`, rows.map((r) => ({ ...r, ver: nextVer(), search_text: oldText(byId.get(String(r.id))!) })));
  await client.exec(`DELETE FROM ${d}.events WHERE ver < ${floor}`);
  return { client, d };
}

async function versions(client: ChClient, d: string): Promise<Map<string, number>> {
  const rows = await client.query<{ id: string; n: number }>(`SELECT id, count() AS n FROM ${d}.events GROUP BY id`);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

describe("clickhouse search backfill", { skip: SKIP }, () => {
  it("migrating a v1 database indexes the error text stored before, so search finds it", async () => {
    const url = dbUrl();
    const { client, d } = await rewound(url);
    await client.exec(`DELETE FROM ${d}.coding_sh_migrations WHERE version >= 2`);
    const store = await ChIndexStore.open(url, { dropDatabaseOnClose: true });
    try {
      const ids = async (q: string) => (await store.search(q)).map((h) => h.event.id).sort();
      assert.deepEqual(await ids("rate_limit_error"), ["e1"]);
      assert.deepEqual(await ids("upstream connect"), ["c1"]);
      assert.deepEqual(await ids("sandbox"), ["t1"]);
      assert.deepEqual(await ids("exit"), ["t1"], "the tool's output is still found");
      assert.deepEqual(await ids("quota exhausted"), ["s1"]);
      assert.deepEqual(await ids("segfaulted"), ["x1"]);
      assert.deepEqual(await ids("changelog"), ["m1"]);
      assert.ok([...(await versions(client, d)).values()].every((n) => n === 1), "the old versions are gone, so no granule holds the old text");
    } finally {
      await store.close();
    }
  });

  it("reads in batches, and a second run writes nothing", async () => {
    const url = dbUrl();
    const { client, d } = await rewound(url);
    try {
      assert.equal(await reindexErrorText(client, d, 2), EVENTS.length);
      assert.equal(await reindexErrorText(client, d, 2), 0);
      const rows = await client.query<{ id: string; search_text: string }>(`SELECT id, search_text FROM ${d}.events FINAL ORDER BY id`);
      const byId = new Map([...EVENTS, MESSAGE].map((e) => [e.id, e]));
      for (const r of rows) assert.equal(r.search_text, searchText(byId.get(r.id)!), r.id);
      assert.deepEqual([...(await versions(client, d)).values()], [1, 1, 1, 1, 1, 1]);
    } finally {
      await client.exec(`DROP DATABASE IF EXISTS ${d}`);
    }
  });
});
