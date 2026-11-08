// The --where language: parser (table-driven, errors with offsets, round trip, fuzz),
// and the same ids from compiled SQL (SQLite) and the scan fallback (memory store).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { IndexStore } from "../../src/core/types.ts";
import { compileWhere } from "../../src/query/compile.ts";
import { facetCounts, findEvents, findSessions, searchWhere, sessionMatcher } from "../../src/query/run.ts";
import { FACET_KEYS, keyDocs, parseWhere, printWhere, QueryError, QueryUnsupported, withoutKey } from "../../src/query/where.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { loadSqlite, SqliteIndexStore } from "../../src/store/sqlite.ts";
import { T0 } from "./_seed.ts";
import { fixture } from "./_where-fixture.ts";

const NOW = T0 + 3 * 86_400_000;
const p = (q: string) => parseWhere(q, { now: NOW });

describe("parseWhere", () => {
  const ok: [string, string][] = [
    ["agent:codex", "agent:codex"],
    ["agent:codex,claude-code", "agent:codex,claude-code"],
    ["  agent:codex   model:gpt-5*  ", "agent:codex model:gpt-5*"],
    ["cost>0.5 duration>=10m turns:5..20", "cost>0.5 duration>=10m turns:5..20"],
    ["-flag:compaction", "-flag:compaction"],
    ["agent:codex OR agent:claude-code", "agent:codex OR agent:claude-code"],
    ["(tool:Bash OR tool:Edit) ok:false", "(tool:Bash OR tool:Edit) ok:false"],
    ["-(agent:codex model:x)", "-(agent:codex model:x)"],
    ['title:"fix the build"', 'title:"fix the build"'],
    ['migration "rm -rf"', 'migration "rm -rf"'],
    ["has:tests is:root", "has:tests is:root"],
    ["sort:-cost limit:5 agent:codex", "agent:codex sort:-cost limit:5"],
    ["(a OR b) sort:cost", "(a OR b) sort:cost"],
    ['"agent:codex"', '"agent:codex"'],
    ["skill:pdf flag:skill:pdf", "skill:pdf flag:skill:pdf"],
    ["tokens>1M tokens.in<100k", "tokens>1M tokens.in<100k"],
    ["since:7d until:2026-11-02", "since:7d until:2026-11-02"],
  ];
  for (const [q, norm] of ok) {
    test(`parses ${q}`, () => {
      const ast = p(q);
      assert.equal(printWhere(ast), norm);
      // Round trip: the normalized string parses to the same tree.
      assert.deepEqual(stripAt(p(printWhere(ast))), stripAt(ast));
    });
  }

  test("resolves values for the key's type", () => {
    const q = p("cost>$0.5 duration>10m tokens>1.5k since:2d ok:false turns:3..7");
    const items = (q.root as { items: { values: { n?: number; lo?: number; hi?: number }[] }[] }).items;
    assert.deepEqual(items.map((i) => i.values[0]!.n ?? [i.values[0]!.lo, i.values[0]!.hi]), [0.5, 600_000, 1500, NOW - 2 * 86_400_000, 0, [3, 7]]);
  });

  test("adjacent words are one text clause", () => {
    assert.deepEqual((p("fix the build").root as { words: string[] }).words, ["fix", "the", "build"]);
  });

  const bad: [string, string, number][] = [
    ["agnet:codex", "unknown_key", 0],
    ["agent:codex modle:x", "unknown_key", 12],
    ["cost>abc", "bad_value", 5],
    ["duration>10", "bad_value", 9],
    ["agent>codex", "bad_value", 6],
    ["turns:9..2", "bad_value", 6],
    ["(agent:codex", "unbalanced_parens", 12],
    ["agent:codex)", "unbalanced_parens", 11],
    ['title:"open', "unterminated_quote", 6],
    ["OR agent:codex", "dangling_or", 0],
    ["agent:codex OR", "dangling_or", 12],
    ["has:nope", "bad_value", 4],
    ["sort:title", "bad_value", 5],
    ["(sort:cost)", "bad_directive", 1],
    ["limit:0", "bad_value", 6],
    ["ok:maybe", "bad_value", 3],
    ["agent:", "bad_value", 6],
    ["()", "empty_group", 0],
  ];
  for (const [q, reason, offset] of bad) {
    test(`rejects ${q}`, () => {
      assert.throws(() => p(q), (e: unknown) => e instanceof QueryError && e.reason === reason && e.offset === offset);
    });
  }

  test("an unknown key suggests the closest one", () => {
    assert.throws(() => p("modle:x"), (e: QueryError) => e.next.some((n) => n.includes("model:")));
    assert.throws(() => p("https://example.com"), (e: QueryError) => e.next.some((n) => n.includes("quote it")));
  });

  test("fuzz: random strings either parse and round-trip or throw QueryError", () => {
    const alphabet = ['a', 'g', 'e', 'n', 't', ':', ' ', '(', ')', '"', '-', ',', '*', '.', '>', '<', '=', 'O', 'R', '0', '5', 'm', 'c', 'o', 's', '\\', 'x'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 3000; i++) {
      let q = "";
      const len = Math.floor(rnd() * 24);
      for (let j = 0; j < len; j++) q += alphabet[Math.floor(rnd() * alphabet.length)];
      // Real keys mixed in so some clauses parse.
      if (rnd() < 0.5) q = `${["agent:", "cost>", "tool:", "-flag:", "("][Math.floor(rnd() * 5)]}${q}`;
      try {
        const ast = p(q);
        let again;
        try {
          again = p(printWhere(ast));
        } catch (e) {
          throw new Error(`${JSON.stringify(q)} printed as ${JSON.stringify(printWhere(ast))}: ${(e as Error).message}`);
        }
        assert.deepEqual(stripAt(again), stripAt(ast), `round trip of ${JSON.stringify(q)} via ${JSON.stringify(printWhere(ast))}`);
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
        if (!(e instanceof QueryError)) throw new Error(`${JSON.stringify(q)} threw ${(e as Error).stack}`);
        assert.ok(e.offset >= 0 && e.offset <= q.length, `offset ${e.offset} in ${JSON.stringify(q)}`);
      }
    }
  });

  test("every key has a doc and an example that parses", () => {
    for (const k of keyDocs()) {
      assert.ok(k.doc.length > 3, k.name);
      p(k.example);
    }
  });
});

describe("compileWhere", () => {
  test("values are bound parameters, never part of the SQL", () => {
    const evil = [`x' OR 1=1 --`, `"; DROP TABLE sessions; --`, `%_\\`, `') UNION SELECT * FROM kv --`, "a\u0000b"];
    const shapes = new Set<string>();
    for (const v of evil) {
      const qt = (x: string) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      const q = p(`agent:${qt(v)} title:${qt(v)} tool:${qt(v)} ${qt(v + " word")}`);
      const c = compileWhere(q.root!, "session");
      for (const piece of ["DROP", "UNION", "1=1", "\u0000"]) assert.ok(!c.sql.includes(piece), c.sql);
      shapes.add(c.sql);
      assert.ok(c.params.includes(v));
    }
    assert.equal(shapes.size, 1, "every value compiles to the same statement");
  });
});

// ------------------------------------------------------------ SQL vs scan

const QUERIES = [
  "agent:codex",
  "agent:codex,gemini",
  "-agent:codex",
  "model:claude-*",
  "model:CLAUDE-*",
  "model:claude-sonnet-4-5",
  "repo:demo",
  "repo:/work/other",
  "repo:proj",
  "repo:sub",
  "branch:feat/*",
  "dir:/work/*",
  "title:build",
  "title:BUILD",
  'title:"50%"',
  "title:done_now",
  "title:done*now",
  "-title:build",
  "flag:compaction",
  "flag:skill:*",
  "skill:pdf",
  "skill:d*",
  "-flag:skill:pdf",
  "is:flagged",
  "-is:flagged",
  "is:root",
  "is:child",
  "is:run",
  "is:ended",
  "has:tests",
  "has:cost",
  "-has:cost",
  "has:repo",
  "has:error",
  "since:2d",
  "since:2026-11-01T11:30:00Z",
  "until:2026-11-01T12:00:00Z",
  "duration>10m",
  "duration:1m..3h",
  "-duration>10m",
  "turns>=3",
  "turns:1",
  "tools>100",
  "tool.errors>0",
  "llm.errors>0",
  "tests.failed>0",
  "tests.passed>=10",
  "tokens>1M",
  "tokens.in<1k",
  "-tokens>100",
  "cost>0.5",
  "cost:0",
  "cost<=0.02",
  "-cost>0.5",
  "files>=1",
  "events<3",
  "run:run_*",
  "parent:s1",
  "id:s*",
  "provider:x",
  "tool:Bash",
  "-tool:Bash",
  "tool:Bash ok:false",
  "tool:Bash -ok:true",
  "(tool:Bash OR tool:Read) ok:true",
  "tool:Bash ok:false agent:codex",
  "-(tool:Bash ok:false)",
  "kind:llm.call ok:false",
  "kind:tool.*",
  "mcp:github",
  "error:enoent",
  "error:*denied",
  "event.duration>30s",
  "event.duration:1s..2s",
  "migration",
  "migration flaky",
  "-migration",
  '"fix the"',
  "migration OR deploy",
  "agent:codex OR model:claude-opus-*",
  "(agent:codex OR agent:gemini) -is:child",
  "agent:claude-code (tool:Read OR cost>1)",
  "-(agent:codex OR has:tests)",
  "agent:codex sort:-cost",
  "sort:cost",
  "sort:-duration",
  "sort:tokens",
  "sort:started",
  "sort:-turns limit:2",
];

describe("SQL and the scan fallback agree", () => {
  let sqlite: SqliteIndexStore;
  let memory: MemoryIndexStore;
  before(async () => {
    const { sessions, events } = fixture();
    sqlite = await SqliteIndexStore.open(":memory:");
    memory = new MemoryIndexStore();
    for (const st of [sqlite, memory] as IndexStore[]) {
      await st.putEvents(events);
      for (const s of sessions) await st.upsertSession(s);
    }
  });

  const ids = async (st: IndexStore, q: string, filter = {}) => {
    const parsed = p(q);
    return (await findSessions(st, parsed, { filter, ...(parsed.limit ? { limit: parsed.limit } : {}) })).sessions.map((s) => s.id);
  };

  for (const q of QUERIES) {
    test(q, async () => {
      const a = await ids(sqlite, q);
      const b = await ids(memory, q);
      assert.deepEqual(a, b, `sqlite ${JSON.stringify(a)} vs scan ${JSON.stringify(b)}`);
    });
  }

  test("the fixture exercises both sides: some queries match none, most match some", async () => {
    let empty = 0;
    let all = 0;
    for (const q of QUERIES) {
      const n = (await ids(sqlite, q)).length;
      if (n === 0) empty++;
      if (n === 5) all++;
    }
    assert.ok(empty <= 4, `${empty} queries match nothing`);
    assert.ok(all <= 8, `${all} queries match everything`);
  });

  test("spot checks", async () => {
    assert.deepEqual(await ids(sqlite, "tool:Bash ok:false"), ["s4", "s1"]);
    assert.deepEqual(await ids(sqlite, "-tool:Bash"), ["s5", "s2"]);
    assert.deepEqual(await ids(sqlite, "repo:proj"), ["s3"]);
    assert.deepEqual(await ids(sqlite, "sort:-cost"), ["s1", "s2", "s5", "s4", "s3"]);
    assert.deepEqual(await ids(sqlite, "migration"), ["s3", "s1"]);
    assert.deepEqual(await ids(sqlite, 'title:"50%"'), ["s3"]);
  });

  test("the base filter applies with the query", async () => {
    assert.deepEqual(await ids(sqlite, "agent:codex", { parentSessionId: null }), ["s1"]);
    assert.deepEqual(await ids(memory, "agent:codex", { parentSessionId: null }), ["s1"]);
  });

  test("facets agree and leave out the key's own clause", async () => {
    for (const q of ["", "agent:codex", "agent:codex cost>0.1", "tool:Bash", "is:root"]) {
      for (const key of FACET_KEYS) {
        const a = await facetCounts(sqlite, p(q), [key]);
        const b = await facetCounts(memory, p(q), [key]);
        assert.deepEqual(a, b, `${key} over ${JSON.stringify(q)}`);
      }
    }
    const f = await facetCounts(sqlite, p("agent:codex"), ["agent", "skill", "tool"]);
    assert.deepEqual(f.agent, [{ value: "claude-code", count: 2 }, { value: "codex", count: 2 }, { value: "gemini", count: 1 }]);
    assert.deepEqual(f.skill, [{ value: "docx", count: 1 }, { value: "pdf", count: 1 }]);
    assert.deepEqual(f.tool, [{ value: "Bash", count: 2 }, { value: "Edit", count: 1 }, { value: "Grep", count: 1 }]);
    assert.deepEqual(stripAt(withoutKey(p("agent:codex cost>1"), "agent").root), stripAt(p("cost>1").root));
  });

  test("search --where filters hits at event level", async () => {
    for (const [text, q, want] of [
      ["migration", "agent:codex", ["s1-e1"]],
      ["deploy", "kind:tool.start", ["s2-e2"]],
      ["migration", "-agent:codex", ["s3-e1"]],
    ] as [string, string, string[]][]) {
      const a = (await searchWhere(sqlite, text, p(q))).map((h) => h.event.id).sort();
      const b = (await searchWhere(memory, text, p(q))).map((h) => h.event.id).sort();
      assert.deepEqual(a, want, `${text} where ${q}`);
      assert.deepEqual(b, want, `${text} where ${q} (scan)`);
    }
  });

  test("a store without an event index refuses event keys and text with a clear error", async () => {
    const pg = Object.assign(Object.create(memory) as IndexStore, { kind: "postgres" });
    assert.throws(() => sessionMatcher(pg, p("tool:Bash").root), (e: unknown) => e instanceof QueryUnsupported && /postgres store answers --where with session keys only/.test(e.message));
    assert.throws(() => sessionMatcher(pg, p("migration").root), QueryUnsupported);
    // Session keys still work there.
    assert.deepEqual((await findSessions(pg, p("agent:codex"))).sessions.map((s) => s.id), ["s4", "s1"]);
  });
});

describe("event results and indexed keys (V-2, V-6)", () => {
  let sqlite: SqliteIndexStore;
  let memory: MemoryIndexStore;
  let dir: string;
  before(async () => {
    const { sessions, events } = fixture();
    dir = mkdtempSync(join(tmpdir(), "csh-where-"));
    sqlite = await SqliteIndexStore.open(join(dir, "index.db"));
    memory = new MemoryIndexStore();
    for (const st of [sqlite, memory] as IndexStore[]) {
      await st.putEvents(events);
      for (const s of sessions) await st.upsertSession(s);
    }
  });
  after(async () => {
    await sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const EVENT_QUERIES = ["", "tool:Bash", "tool:Bash ok:false", "-tool:Bash", "ok:false", "kind:tool.end", "mcp:github", "-mcp:github", "error:enoent", "event.duration>1s", "agent:codex", "agent:codex kind:tool.end", "tool:Bash OR kind:llm.call", "migration", "repo:demo tool:Edit,Grep", "cost>1", "is:child"];

  const all = async (st: IndexStore, q: string, limit: number) => {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await findEvents(st, p(q), { limit, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((e) => e.id));
      if (!page.next) return ids;
      cursor = page.next;
    }
    throw new Error("cursor never ended");
  };

  for (const q of EVENT_QUERIES) {
    test(`events ${JSON.stringify(q)}: SQL equals the scan, one page or many`, async () => {
      const want = await all(memory, q, 100);
      assert.deepEqual(await all(sqlite, q, 100), want);
      assert.deepEqual(await all(sqlite, q, 2), want, "paged by 2");
      assert.deepEqual(await all(memory, q, 2), want, "scan paged by 2");
      const first = await findEvents(sqlite, p(q), { limit: 2, countUpTo: 3 });
      assert.equal(first.total, Math.min(want.length, 3));
      assert.equal(first.totalCapped, want.length > 3 ? true : undefined);
    });
  }

  test("events spot checks: newest first, session keys apply to the event's session", async () => {
    assert.deepEqual(await all(sqlite, "tool:Bash ok:false", 50), ["s1-e3", "s4-e1"]);
    assert.deepEqual(await all(sqlite, "mcp:github", 50), ["s2-e2"]);
    assert.deepEqual(await all(sqlite, "agent:gemini", 50), []);
  });

  test("a bad cursor is a RangeError", async () => {
    await assert.rejects(findEvents(sqlite, p(""), { cursor: "nope" }), RangeError);
    await assert.rejects(findEvents(memory, p(""), { cursor: "nope" }), RangeError);
  });

  test("facet values filter by a typed prefix, case-insensitive", async () => {
    for (const [key, prefix, want] of [["tool", "b", ["Bash"]], ["tool", "MCP__", ["mcp__github__search"]], ["agent", "c", ["claude-code", "codex"]], ["mcp", "x", []], ["tool", "%", []], ["tool", "_", []]] as [string, string, string[]][]) {
      for (const st of [sqlite, memory]) {
        const got = (await facetCounts(st, p(""), [key], { prefix }))[key]!.map((f) => f.value).sort();
        assert.deepEqual(got, want, `${st.kind} ${key} ${prefix}`);
      }
    }
  });

  test("the indexed event keys never scan the events table", async () => {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(join(dir, "index.db"), { readOnly: true });
    try {
      for (const q of ["tool:Bash", "tool:Bash ok:false", "ok:false", "kind:tool.end", "mcp:github", "tool:Bash agent:codex", "-tool:Bash"]) {
        const c = compileWhere(parseWhere(q).root!, "session");
        const e = compileWhere(parseWhere(q).root!, "event");
        const plans = {
          session: `SELECT s.id FROM sessions s WHERE ${c.sql} ORDER BY s.started_at DESC LIMIT 50`,
          // The inner page query of queryEvents; a negated clause may walk events_ts newest first.
          ...(q.startsWith("-") ? {} : { event: `SELECT e.rowid FROM events e JOIN sessions s ON s.id = e.session_id WHERE ${e.sql} ORDER BY e.ts DESC, e.rowid DESC LIMIT 51` }),
        };
        for (const [level, sql] of Object.entries(plans)) {
          const params = level === "session" ? c.params : e.params;
          const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
          assert.ok(!detail.some((d) => /^SCAN e\b/.test(d)), `${q} at ${level} level scans events: ${detail.join(" | ")}`);
        }
      }
    } finally {
      db.close();
    }
  });
});

/** The AST without source offsets (round trips move them). */
function stripAt(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripAt);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "at").map(([k, x]) => [k, stripAt(x)]));
  return v;
}
