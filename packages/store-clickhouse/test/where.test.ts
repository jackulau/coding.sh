// `--where` in ClickHouse: the compiler without a database (shape, typed
// parameters, unknown keys), then, with CODING_SH_TEST_CH_URL, the same ids and
// facet counts as coding.sh's scan fallback (the memory store) on the shared fixture.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { HAS, IS, KEYS, QueryError, QueryUnsupported, type IndexStore, type Node, type QueryOpts } from "coding.sh/store";
import { facetCounts, findSessions } from "../../coding.sh/src/query/run.ts";
import { FACET_KEYS, parseWhere } from "../../coding.sh/src/query/where.ts";
import { MemoryIndexStore } from "../../coding.sh/src/store/memory.ts";
import { T0 } from "../../coding.sh/test/query/_seed.ts";
import { fixture, QUERIES, REPO_NAMES, repoNameSessions } from "../../coding.sh/test/query/_where-fixture.ts";
import { Params } from "../src/client.ts";
import { ChIndexStore } from "../src/index.ts";
import { compileWhere, facetRows, HAS_SQL, IS_SQL, KEY_SQL, orderBy } from "../src/where.ts";
import { SKIP, dbUrl } from "./helpers.ts";

const NOW = T0 + 3 * 86_400_000;
const p = (q: string) => parseWhere(q, { now: NOW });

function compile(q: string): { sql: string; params: Record<string, string> } {
  const params = new Params();
  const sql = compileWhere(p(q).root!, (type, v) => params.bind(type, v), "`t`.events");
  return { sql, params: params.values };
}

describe("clickhouse --where compiler", () => {
  it("has SQL for every key, has: and is: value in coding.sh", () => {
    for (const k of KEYS.keys()) assert.ok(KEY_SQL[k], `no SQL for ${k}`);
    for (const k of Object.keys(HAS)) assert.ok(HAS_SQL[k], `no SQL for has:${k}`);
    for (const k of Object.keys(IS)) assert.ok(IS_SQL[k], `no SQL for is:${k}`);
  });

  it("compiles to one condition with typed placeholders", () => {
    const c = compile("agent:codex -title:Fix cost>0.5 tool:Bash ok:false");
    const cost = "if(JSONType(stats, 'usage', 'costUsd') IN ('Int64', 'UInt64', 'Double'), JSONExtractFloat(stats, 'usage', 'costUsd'), NULL)";
    assert.equal(
      c.sql,
      "(id IN (SELECT session_id FROM `t`.events FINAL WHERE (tool = {p0:String} AND ok = {p1:Bool})) AND agent = {p2:String}" +
        ` AND NOT (ifNull(lower(title) LIKE {p3:String}, 0)) AND ${cost} > {p4:Float64})`,
    );
    assert.deepEqual(c.params, { p0: "Bash", p1: "false", p2: "codex", p3: "%fix%", p4: "0.5" });
    assert.equal(orderBy(p("sort:-cost").sort), `isNull(${cost}), ${cost} DESC, started_at DESC, id`);
    assert.equal(orderBy(undefined), "started_at DESC, id");
    const words = compile("migration flaky");
    assert.equal(words.sql, "id IN (SELECT session_id FROM `t`.events FINAL WHERE (search_text LIKE {p0:String} OR endsWith(search_text, {p1:String})) AND search_text LIKE {p2:String})");
    assert.deepEqual(words.params, { p0: "% migration %", p1: " migration", p2: "% flaky%" }, "a whole word, then a word prefix");
  });

  it("binds every value: hostile input never changes the SQL", () => {
    const evil = [`x' OR 1=1 --`, `"; DROP TABLE sessions; --`, `%_\\`, `{p0:String}`, `') UNION SELECT * FROM kv --`, "a\u0000b"];
    // Inside quotes \\, \" and \* stand for the character itself (a bare * is a wildcard).
    const qt = (x: string) => `"${x.replace(/[\\"*]/g, (ch) => `\\${ch}`)}"`;
    const shapes = new Set<string>();
    for (const v of evil) {
      const c = compile(`agent:${qt(v)} title:${qt(v)} skill:${qt(v)} tool:${qt(v)}`);
      for (const piece of ["DROP", "UNION", "1=1", "\u0000", "kv"]) assert.ok(!c.sql.includes(piece), c.sql);
      shapes.add(c.sql);
      // Values travel TSV-escaped in param_<name>; the server reads them back as is.
      const sent = Object.values(c.params);
      const tsv = (s: string) => s.replace(/\\/g, "\\\\").replace(/\u0000/g, "\\0");
      assert.ok(sent.includes(tsv(v)), `${JSON.stringify(v)} is bound`);
      assert.ok(sent.includes(tsv(`skill:${v}`)));
      // Free text is bound word by word (letters and digits only), whatever else it holds.
      const t = compile(`${qt(`${v} word`)}`);
      const words = Object.values(t.params);
      assert.ok(words.every((w) => /^(% [\p{L}\p{N}]+ ?%| [\p{L}\p{N}]+)$/u.test(w)), JSON.stringify(words));
      assert.equal(words.at(-1), "% word%");
      const whole = (i: number) => `(search_text LIKE {p${i}:String} OR endsWith(search_text, {p${i + 1}:String}))`;
      assert.equal(t.sql, `id IN (SELECT session_id FROM \`t\`.events FINAL WHERE ${[...Array.from({ length: (words.length - 1) / 2 }, (_, k) => whole(2 * k)), `search_text LIKE {p${words.length - 1}:String}`].join(" AND ")})`);
    }
    assert.equal(shapes.size, 1, "every value compiles to the same statement");
  });

  it("refuses keys it has no SQL for, and text with no words", () => {
    const bind = () => "{p0:String}";
    const node = (n: unknown) => n as Node;
    assert.throws(() => compileWhere(node({ t: "cmp", key: "nope", op: ":", values: [{ raw: "x", quoted: false, kind: "eq" }], at: 0 }), bind, "e"), QueryUnsupported);
    assert.throws(() => compileWhere(node({ t: "not", item: { t: "has", name: "nope", at: 0 } }), bind, "e"), /can't filter on has:nope/);
    assert.throws(() => compileWhere(p('"#!"').root!, bind, "e"), (e: unknown) => e instanceof QueryError && e.reason === "bad_value");
  });

  it("facet rows: flags through arrayJoin, event keys over the selected sessions", () => {
    const params = new Params();
    assert.equal(
      facetRows("skill", (t, v) => params.bind(t, v), "S", "E", "WHERE x"),
      "SELECT arrayJoin(arrayMap(f -> substring(f, 7), arrayFilter(f -> lower(f) LIKE {p0:String}, flags))) AS fv, id AS sid FROM S FINAL WHERE x",
    );
    assert.deepEqual(params.values, { p0: "skill:%" });
    assert.equal(facetRows("tool", () => "", "S", "E", ""), "SELECT tool AS fv, session_id AS sid FROM E FINAL WHERE session_id IN (SELECT id FROM S FINAL )");
  });
});

describe("clickhouse --where matches the scan", { skip: SKIP }, () => {
  let ch: ChIndexStore;
  const memory = new MemoryIndexStore();
  before(async () => {
    ch = await ChIndexStore.open(dbUrl(), { dropDatabaseOnClose: true });
    const { sessions, events } = fixture();
    // One more session in another project, for project scoping.
    sessions.push({ ...sessions[0]!, id: "p1", project: "acme", startedAt: T0 + 5 * 3_600_000 });
    // Sessions in temp dirs, whose repo name is not the path's last part.
    sessions.push(...repoNameSessions());
    for (const st of [ch, memory] as IndexStore[]) {
      await st.putEvents(events);
      for (const s of sessions) await st.upsertSession(s);
    }
    // A stale version of s2 that FINAL must hide.
    await ch.upsertSession({ ...sessions[1]!, agent: "stale" });
    await ch.upsertSession(sessions[1]!);
  });
  after(async () => {
    await ch?.close();
  });

  const ids = async (st: IndexStore, q: string, o: QueryOpts = {}) => {
    const parsed = p(q);
    return (await findSessions(st, parsed, { ...o, ...(parsed.limit ? { limit: parsed.limit } : {}) })).sessions.map((s) => s.id);
  };

  for (const q of QUERIES) {
    it(q, async () => {
      assert.deepEqual(await ids(ch, q), await ids(memory, q));
    });
  }

  it("applies the filter, project, limit and offset with the query", async () => {
    for (const [q, o] of [
      ["agent:codex", { filter: { parentSessionId: null } }],
      ["agent:codex", { filter: { project: "acme" } }],
      ["agent:codex", { filter: { project: "default" } }],
      ["-is:child", { filter: { agent: "claude-code" } }],
      ["has:cost", { filter: { flag: "compaction" } }],
      ["sort:-cost", { limit: 2, offset: 1 }],
      ["", { limit: 3 }],
    ] as [string, QueryOpts][]) {
      assert.deepEqual(await ids(ch, q, o), await ids(memory, q, o), `${q} ${JSON.stringify(o)}`);
    }
    assert.deepEqual(await ids(ch, "agent:codex", { filter: { project: "acme" } }), ["p1"]);
    assert.deepEqual(await ids(ch, "agent:stale"), []);
  });

  it("facets agree with the scan and leave out the key's own clause", async () => {
    for (const q of ["", "agent:codex", "agent:codex cost>0.1", "tool:Bash", "is:root", "-skill:pdf", "migration"]) {
      for (const key of FACET_KEYS) {
        assert.deepEqual(await facetCounts(ch, p(q), [key]), await facetCounts(memory, p(q), [key]), `${key} over ${JSON.stringify(q)}`);
      }
    }
    assert.deepEqual(await facetCounts(ch, p(""), ["agent"], { filter: { project: "acme" } }), { agent: [{ value: "codex", count: 1 }] });
  });

  it("names the macOS temp dir tmp, as the scan does", async () => {
    const tmp = (await facetCounts(ch, p(""), ["repo"])).repo!.filter((f) => REPO_NAMES.some(([v]) => v === f.value)).map((f): [string, number] => [f.value, f.count]).sort();
    assert.deepEqual(tmp, REPO_NAMES);
    assert.deepEqual((await ids(ch, "repo:tmp")).sort(), ["linux-tmp", "mac-private-tmp", "mac-tmp"]);
  });

  it("hostile values run as values", async () => {
    for (const v of [`x' OR 1=1 --`, `%`, `_`, `\\`, `{p0:String}`, `*`]) {
      const q = `title:"${v.replace(/\\/g, "\\\\")}" OR agent:"${v.replace(/\\/g, "\\\\")}"`;
      assert.deepEqual(await ids(ch, q), await ids(memory, q), q);
    }
  });
});
