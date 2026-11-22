// Regressions from round-7 QA of the MCP server: session_get with tail gave no
// nextCursor when the answer limit cut the page, since after until answered an
// empty window, a 2024-11-05 client got 2025-11-25 and fields its version lacks,
// error results carried structuredContent that broke the tool's outputSchema,
// and status listed 10 work items.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { LEGACY_VERSIONS } from "../../src/mcp/protocol.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { STATUS_WORK_ROWS } from "../../src/mcp/tools.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, seed, type World } from "./helpers.ts";

type Obj = Record<string, unknown>;
type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Obj; _meta?: Obj };
type Tool = { name: string; title?: string; description: string; inputSchema: Obj; outputSchema?: Obj; annotations?: Obj };

const LONG = "r7-long";
const ROUNDS = 300;
const WORK = 8;

let w: World;
let mcp: CodingShMcp;
let tools: Tool[];

let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Obj = {}, cwd = w.repo): AgentEvent {
  return { id: `${sessionId}-r7-${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, cwd };
}

async function call(name: string, args: Obj = {}, server = mcp): Promise<Result> {
  const r = await server.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r!.result as Result;
}

async function ok(name: string, args: Obj = {}): Promise<Obj> {
  const r = await call(name, args);
  assert.notEqual(r.isError, true, `${name}: ${r.content[0]?.text.slice(0, 300)}`);
  return r.structuredContent!;
}

before(async () => {
  w = makeWorld();
  await seed(w);
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    // One long session: ROUNDS prompts and replies, more rows than one answer holds.
    const t0 = w.now - 3 * 3600e3;
    const long: AgentEvent[] = [ev(LONG, t0, "session.start")];
    for (let i = 0; i < ROUNDS; i++) {
      long.push(ev(LONG, t0 + i * 100 + 1, "user.message", { text: `step ${i} `.padEnd(160, "x") }));
      long.push(ev(LONG, t0 + i * 100 + 50, "assistant.message", { text: `reply ${i} `.padEnd(160, "y") }));
    }
    long.push(ev(LONG, t0 + ROUNDS * 100 + 10, "session.end", { reason: "exit" }));
    await ctx.index.putEvents(long);
    await ctx.index.upsertSession(buildSession(long));
    // WORK finished sessions that changed files: each one is a "review" item in the work queue.
    for (let s = 0; s < WORK; s++) {
      const sid = `r7-work-${s}`;
      const cwd = `${w.root}/repos/work${s}`;
      const b = w.now - (s + 2) * 3600e3;
      const evs = [
        ev(sid, b, "session.start", {}, cwd),
        ev(sid, b + 1000, "user.message", { text: `Fix flaky test ${s}` }, cwd),
        ev(sid, b + 2000, "assistant.message", { text: "Done." }, cwd),
        ev(sid, b + 2500, "file.change", { path: `src/f${s}.ts`, op: "modify" }, cwd),
        ev(sid, b + 3000, "session.end", { reason: "exit" }, cwd),
      ];
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(buildSession(evs));
    }
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.repo, log: () => {}, now: () => w.now });
  tools = ((await mcp.server.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" }))!.result as { tools: Tool[] }).tools;
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("session_get with tail", () => {
  type Row = { at: number; kind: string; text: string };
  const key = (r: Row) => JSON.stringify(r);

  it("pages back with nextCursor to the first entry, no row twice and none missing", async () => {
    // Every row, oldest first, by head paging.
    const head: Row[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const args: Record<string, unknown> = { sessionId: LONG, limit: 200 };
      if (cursor) args.cursor = cursor;
      const d = await ok("session_get", args);
      head.push(...(d.timeline as Row[]));
      cursor = d.nextCursor as string | undefined;
      if (!cursor) break;
    }
    assert.equal(head.length, 2 * ROUNDS, "every prompt and reply");

    const pages: Row[][] = [];
    cursor = undefined;
    let total: unknown;
    for (let page = 0; page < 100; page++) {
      const args: Record<string, unknown> = { sessionId: LONG, tail: true, limit: 200 };
      if (cursor) args.cursor = cursor;
      const d = await ok("session_get", args);
      const rows = d.timeline as Row[];
      assert.ok(rows.length > 0, `page ${page} has rows`);
      if (page === 0) {
        assert.ok(rows.length < 200, "the answer limit cut the first page");
        assert.deepEqual(rows.at(-1), head.at(-1), "the first page ends at the last entry");
      }
      total = d.timelineTotal;
      pages.push(rows);
      cursor = d.nextCursor as string | undefined;
      if (!cursor) break;
    }
    assert.ok(pages.length > 1, "more than one page");
    assert.equal(total, head.length, "timelineTotal counts every entry");
    const walked = pages.reverse().flat();
    assert.equal(new Set(walked.map(key)).size, walked.length, "no row twice");
    assert.deepEqual(walked, head, "every row, in order, back to the first");
  });

  it("says so in the description and the outputSchema", () => {
    const t = tools.find((x) => x.name === "session_get")!;
    assert.match(t.description, /page with cursor \(with tail, backward\)/);
    const props = t.outputSchema!.properties as Record<string, { description?: string }>;
    assert.match(String(props.nextCursor?.description), /With tail: older entries/);
    assert.match(String((t.inputSchema.properties as Record<string, { description?: string }>).tail?.description), /nextCursor pages back/);
  });
});

describe("since after until", () => {
  for (const name of ["sessions_list", "usage", "failures", "latency"]) {
    it(`${name} answers an invalid-argument error that names both times`, async () => {
      const r = await call(name, { since: "1d", until: "7d" });
      assert.equal(r.isError, true, r.content[0]!.text);
      const text = r.content[0]!.text;
      assert.match(text, /^since must be before until: /, "worded like the CLI's --since must be before --until");
      assert.match(text, /since 1d is \d{4}-\d\d-\d\dT[\d:.]+Z/);
      assert.match(text, /until 7d is \d{4}-\d\d-\d\dT[\d:.]+Z/);
      assert.equal((r._meta?.["sh.coding/error"] as Obj | undefined)?.reason, "invalid_argument");
      // The same window the right way round is fine.
      assert.notEqual((await call(name, { since: "7d", until: "1d" })).isError, true);
    });
  }
});

describe("protocol versions", () => {
  // Every version the server lists, 2024-11-05 whether or not it is listed, and an unknown one.
  const ASKED = [...new Set([...LEGACY_VERSIONS, "2024-11-05", "1999-01-01"])];

  for (const asked of ASKED) {
    it(`initialize ${asked} gets a version it can read, and results valid for it`, async () => {
      const s = createCodingShMcp({ env: w.env, cwd: w.repo, log: () => {}, now: () => w.now });
      try {
        const init = (await s.server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "t", version: "0" } } }))!;
        const got = (init.result as Obj).protocolVersion as string;
        // 2024-11-05 is served as itself, not as the newest version (which it cannot read).
        const known = (LEGACY_VERSIONS as readonly string[]).includes(asked) || asked === "2024-11-05";
        assert.equal(got, known ? asked : LEGACY_VERSIONS[0], known ? "echoed" : "the newest legacy version");
        const structured = got >= "2025-06-18";
        const annotated = got >= "2025-03-26";

        const list = ((await s.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!.result as { tools: Tool[] }).tools;
        assert.ok(list.length > 0);
        for (const t of list) {
          assert.equal("outputSchema" in t, structured, `${t.name} outputSchema on ${got}`);
          assert.equal("title" in t, structured, `${t.name} title on ${got}`);
          assert.equal("annotations" in t, annotated, `${t.name} annotations on ${got}`);
          assert.ok(t.inputSchema && t.description, `${t.name} keeps name, description and inputSchema`);
        }

        const r = await call("sessions_list", {}, s);
        assert.notEqual(r.isError, true);
        assert.equal("structuredContent" in r, structured, `structuredContent on ${got}`);
        // Without structuredContent the content still carries the whole answer.
        assert.ok(Array.isArray((JSON.parse(r.content[0]!.text) as Obj).sessions), "the text is the JSON answer");
      } finally {
        await s.close();
      }
    });
  }
});

// A small JSON Schema validator: the keywords the outputSchemas use.
function violations(v: unknown, schema: Obj, root: Obj = schema, at = ""): string[] {
  if (typeof schema.$ref === "string") {
    const target = schema.$ref.slice(2).split("/").reduce<unknown>((o, k) => (o as Obj | undefined)?.[k], root);
    return violations(v, target as Obj, root, at);
  }
  const out: string[] = [];
  const type = schema.type as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    const fits = types.some((t) => t === actual || (t === "integer" && Number.isInteger(v)) || (t === "number" && actual === "number"));
    if (!fits) return [`${at || "/"}: is ${actual}, not ${types.join("|")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${at}: not one of the enum`);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => violations(v, s as Obj, root, at).length === 0)) out.push(`${at}: matches no anyOf branch`);
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => out.push(...violations(x, schema.items as Obj, root, `${at}/${i}`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Obj;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in o)) out.push(`${at}/${k}: required`);
    const props = (schema.properties as Record<string, Obj> | undefined) ?? {};
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) out.push(...violations(x, props[k], root, `${at}/${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}/${k}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...violations(x, schema.additionalProperties as Obj, root, `${at}/${k}`));
    }
  }
  return out;
}

describe("error results and the outputSchema", () => {
  // A bad argument per tool that the tool itself rejects (with details where it has them);
  // a tool not named here gets an unknown argument, which the input check rejects.
  const BAD: Record<string, Obj> = {
    sessions_list: { where: "cost>>" },
    session_get: { sessionId: "no-such-session" },
    session_current: { cwd: "/no/such/dir" },
    session_replay: { sessionId: "no-such-session" },
    search: { query: "x", where: "cost>>" },
    improve: { since: "zzz" },
    harness_changes: { since: "zzz" },
    harness_audit: { since: "zzz" },
    failures: { since: "1d", until: "7d" },
    latency: { since: "zzz" },
    usage: { where: "cost>>" },
    subagents: { sessionId: "no-such-session" },
    session_tree: { sessionId: "no-such-session" },
    eval_from_session: { sessionId: "no-such-session", confirm: true },
    eval_init: { name: "x", confirm: false, source: "sessions" },
    eval_candidates: { since: "zzz" },
    experiments_list: { cursor: "x" },
    experiment_compare: { baseline: "no-such", candidate: "no-such" },
    exp_session_summary: {},
    exp_session_note: { text: "x" },
    harness_compare: { experiment: "no-such" },
    benchmarks: { name: "no-such" },
    score_list: { since: "zzz" },
    score_add: { targetId: "x", name: "n", value: 1, dataType: "no-such" },
    score_add_batch: { scores: [] },
  };

  it("the validator in this test rejects an error shape that breaks a schema", () => {
    const t = tools.find((x) => x.name === "session_get")!;
    assert.deepEqual(violations({ session: { id: "a", agent: "b" }, timeline: [] }, t.outputSchema!), []);
    assert.notDeepEqual(violations({ error: { message: "x", reason: "not_found" } }, t.outputSchema!), []);
  });

  it("every tool's error result has no structuredContent, or one its outputSchema accepts", async () => {
    let detailed = 0;
    for (const t of tools) {
      const r = await call(t.name, BAD[t.name] ?? { bogus: 1 });
      assert.equal(r.isError, true, `${t.name} rejects ${JSON.stringify(BAD[t.name] ?? { bogus: 1 })}: ${r.content[0]?.text.slice(0, 200)}`);
      assert.ok(r.content[0]?.text, `${t.name}: the message is the content`);
      if (r.structuredContent !== undefined) assert.deepEqual(violations(r.structuredContent, t.outputSchema!), [], `${t.name} error result breaks its outputSchema`);
      // The chosen rule: errors carry no structuredContent; details go in _meta.
      assert.equal(r.structuredContent, undefined, `${t.name} error has no structuredContent`);
      const details = r._meta?.["sh.coding/error"] as Obj | undefined;
      if (details) {
        detailed++;
        assert.equal(typeof details.message, "string");
        assert.equal(typeof details.reason, "string");
      }
    }
    assert.ok(detailed >= 4, `errors with details: ${detailed}`);
  });

  it("the details a program reads move to _meta", async () => {
    const r = await call("exp_session_summary", {});
    assert.equal(r.isError, true);
    const details = r._meta?.["sh.coding/error"] as Obj;
    assert.equal(details.reason, "not_found");
    assert.equal(details.next, "coding.sh exp session new --name <topic>");
  });

  it("no outputSchema declares an error property any more", () => {
    for (const t of tools) assert.equal((t.outputSchema?.properties as Obj | undefined)?.error, undefined, t.name);
  });
});

describe("status work rows", () => {
  it(`lists the top ${STATUS_WORK_ROWS} items, counts the rest and names the command for them`, async () => {
    assert.equal(STATUS_WORK_ROWS, 5);
    const work = (await ok("status")).work as Obj;
    const items = work.items as Obj[];
    assert.equal(work.review, WORK + 1, "the seeded sessions and sess-a");
    assert.equal(items.length, STATUS_WORK_ROWS);
    assert.equal(work.more, WORK + 1 - STATUS_WORK_ROWS);
    assert.equal(work.rest, "coding.sh work --json");
    for (const i of items) for (const k of ["id", "bucket", "reason", "next", "rootId", "sessionId", "lastActivity"]) assert.ok(k in i, `item has ${k}`);
    const t = tools.find((x) => x.name === "status")!;
    assert.match(t.description, /top 5 items/);
    assert.match(t.description, /the work tool has the rest/);
  });
});
