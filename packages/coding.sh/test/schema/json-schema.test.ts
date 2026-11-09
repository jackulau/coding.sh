// The JSON Schema for coding.sh/trace (src/schema/trace.schema.json, shipped as
// dist/schema.json and `coding.sh/schema.json`): it matches the TypeScript types, and every
// event the adapters produce from their recorded fixtures (plus the OTLP fixtures) validates
// against it, as does the session ingest builds from those events.
import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { convertRollout } from "../../src/adapters/codex.ts";
import type { Adapter } from "../../src/core/types.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { validateJsonSchema, type JsonSchema } from "../../src/graders/json-schema.ts";
import { decodeLogsJson, decodeTraceJson } from "../../src/otel/json.ts";
import { mapLogs, mapTraces, SpanTree, TraceSessionMap } from "../../src/otel/map.ts";
import { decodeTraceRequest } from "../../src/otel/proto.ts";
import { EVENT_KINDS, KNOWN_AGENTS, type AgentEvent, type Session } from "../../src/schema/index.ts";
import { generateTraceSchema, renderTraceSchema, ROOT_TYPES, SCHEMA_JSON, SCHEMA_URL, type Schema } from "../../scripts/json-schema.ts";
import { collect, FIXTURES, loadSpool, PKG_ROOT, testCtx } from "../adapters/_helpers.ts";
import { moreEnv } from "../adapters/more/_helpers.ts";
import type { TmpEnv } from "../adapters/_helpers.ts";

const committed = JSON.parse(readFileSync(SCHEMA_JSON, "utf8")) as Schema;
const defs = committed.$defs as Record<string, Schema>;
const entry = (name: string): JsonSchema => ({ $defs: defs, $ref: `#/$defs/${name}` });
const EVENT = entry("AgentEvent");
const SESSION = entry("Session");

/** "<where> <pointer>: <message>" for each violation; [] when valid. */
function violations(value: unknown, schema: JsonSchema, where: string): string[] {
  return validateJsonSchema(value, schema, { maxErrors: 5 }).errors.map((e) => `${where} ${e.path || "/"}: ${e.message}`);
}

function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, keep));
    else if (keep(e.name)) out.push(full);
  }
  return out.sort();
}

const rel = (f: string) => relative(FIXTURES, f).split(sep).join("/");

/** Validates events, then the sessions buildSession folds from them; returns every violation. */
function checkAll(events: AgentEvent[], where: string): string[] {
  const bad = events.flatMap((e) => violations(e, EVENT, `${where} ${e.kind} ${e.id.slice(0, 8)}`));
  const by = new Map<string, AgentEvent[]>();
  for (const e of events) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
  for (const [id, evs] of by) bad.push(...violations(buildSession(evs), SESSION, `${where} session ${id}`));
  return bad;
}

describe("trace JSON Schema", () => {
  it("the committed schema matches the types (node --no-warnings scripts/json-schema.ts rewrites it)", () => {
    assert.equal(readFileSync(SCHEMA_JSON, "utf8"), renderTraceSchema(), `${relative(PKG_ROOT, SCHEMA_JSON)} is stale: run node --no-warnings packages/coding.sh/scripts/json-schema.ts`);
  });

  it("describes AgentEvent and Session as closed objects, with the kinds and agent ids from the code", () => {
    assert.equal(committed.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(committed.$id, SCHEMA_URL);
    assert.deepEqual(committed.anyOf, ROOT_TYPES.map((n) => ({ $ref: `#/$defs/${n}` })));
    assert.deepEqual(defs.EventKind, { enum: [...EVENT_KINDS] });
    assert.deepEqual((defs.AgentId as Schema).examples, [...KNOWN_AGENTS]);
    const ev = defs.AgentEvent!;
    assert.equal(ev.additionalProperties, false);
    assert.deepEqual(ev.required, ["id", "v", "sessionId", "ts", "agent", "kind", "payload"]);
    assert.deepEqual((ev.properties as Record<string, Schema>).v, { const: 0 });
    assert.equal(defs.Session!.additionalProperties, false);
    assert.deepEqual(defs.Session!.required, ["id", "agent", "startedAt", "stats", "flags"]);
  });

  it("every $ref resolves, and every def is reachable from AgentEvent or Session", () => {
    const refs = new Set<string>();
    const scan = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) k === "$ref" ? refs.add(String(x)) : scan(x);
    };
    scan(committed);
    for (const r of refs) assert.ok(r.startsWith("#/$defs/") && defs[r.slice(8)], `unresolved ${r}`);
    assert.deepEqual([...refs].map((r) => r.slice(8)).sort(), Object.keys(defs).sort());
  });

  it("rejects malformed events and sessions", () => {
    const good: AgentEvent = { id: "a".repeat(64), v: 0, sessionId: "s1", ts: 1, agent: "my-agent", kind: "tool.start", payload: { tool: "Bash" } };
    assert.deepEqual(violations(good, EVENT, "good"), []);
    const cases: [string, unknown][] = [
      ["missing kind", { ...good, kind: undefined }],
      ["unknown kind", { ...good, kind: "tool.begin" }],
      ["wrong version", { ...good, v: 1 }],
      ["string ts", { ...good, ts: "1" }],
      ["unknown field", { ...good, extra: true }],
      ["usage typo", { ...good, usage: { inputToken: 3 } }],
      ["payload not an object", { ...good, payload: "x" }],
    ];
    for (const [what, e] of cases) assert.ok(violations(e, EVENT, what).length > 0, `${what} should fail`);
    const s = buildSession([good]);
    assert.deepEqual(violations(s, SESSION, "session"), []);
    assert.ok(violations({ ...s, stats: { ...s.stats, toolCalls: "1" } }, SESSION, "x").length > 0);
    assert.ok(violations({ ...s, flags: undefined }, SESSION, "x").length > 0);
    assert.ok(violations({ ...s, stats: { ...s.stats, launch: "batch" } }, SESSION, "x").length > 0);
  });

  it("the generator maps the TypeScript forms the format uses", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "csh-jsonschema-"));
    try {
      const src = join(dir, "index.ts");
      writeFileSync(
        src,
        `export const SCHEMA_VERSION = 3 as const;
export const SCHEMA_ID = "x/trace" as const;
const IDS = ["a", "b"] as const;
export type AgentId = (typeof IDS)[number] | (string & {});
export type Mode = "on" | "off";
/** An event. */
export interface AgentEvent {
  /** The id. */
  id: string;
  v: typeof SCHEMA_VERSION;
  agent: AgentId;
  mode?: Mode;
  tags: string[];
  pairs?: [string, number];
  flag?: boolean;
  either?: string | boolean | 3;
  byKey: Partial<Record<Mode, { n: number }>>;
  counts?: Record<string, number>;
  payload: Record<string, unknown>;
}
export interface Session { id: string; events: AgentEvent[]; meta?: { [k: string]: string } }
`,
      );
      const s = generateTraceSchema(src);
      assert.equal(s.title, "x/trace v3");
      const d = s.$defs as Record<string, Schema>;
      assert.deepEqual(Object.keys(d), ["AgentEvent", "AgentId", "Mode", "Session"]);
      assert.deepEqual(d.AgentId, { type: "string", examples: ["a", "b"] });
      assert.deepEqual(d.Mode, { enum: ["on", "off"] });
      const p = d.AgentEvent!.properties as Record<string, Schema>;
      assert.equal(d.AgentEvent!.description, "An event.");
      assert.deepEqual(p.id, { description: "The id.", type: "string" });
      assert.deepEqual(p.v, { const: 3 });
      assert.deepEqual(p.mode, { $ref: "#/$defs/Mode" });
      assert.deepEqual(p.tags, { type: "array", items: { type: "string" } });
      assert.deepEqual(p.pairs, { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 2, maxItems: 2 });
      assert.deepEqual(p.flag, { type: "boolean" });
      assert.deepEqual(p.either, { anyOf: [{ const: 3 }, { type: "string" }, { type: "boolean" }] });
      const nObj = { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false };
      assert.deepEqual(p.byKey, { type: "object", properties: { on: nObj, off: nObj }, additionalProperties: false });
      assert.deepEqual(p.counts, { type: "object", additionalProperties: { type: "number" } });
      assert.deepEqual(p.payload, { type: "object" });
      assert.deepEqual(d.AgentEvent!.required, ["id", "v", "agent", "tags", "byKey", "payload"]);
      const sp = d.Session!.properties as Record<string, Schema>;
      assert.deepEqual(sp.events, { type: "array", items: { $ref: "#/$defs/AgentEvent" } });
      assert.deepEqual(sp.meta, { type: "object", additionalProperties: { type: "string" } });
      // A type it has no mapping for fails loudly instead of emitting a wrong schema.
      writeFileSync(src, `export const SCHEMA_VERSION = 0 as const;\nexport const SCHEMA_ID = "x" as const;\nexport interface AgentEvent { f: () => void }\nexport interface Session { id: string }\n`);
      assert.throws(() => generateTraceSchema(src), /cannot map function type/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is exported as coding.sh/schema.json and shipped in the tarball", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
    assert.equal(pkg.exports["./schema.json"], "./dist/schema.json");
    assert.ok((pkg.files as string[]).some((f) => f === "dist/schema.json" || f === "dist/*.json"), "package.json files includes dist/schema.json");
    assert.match(readFileSync(join(PKG_ROOT, "scripts", "bundle.mjs"), "utf8"), /trace\.schema\.json[^\n]*schema\.json/);
  });
});

describe("adapter fixtures validate against the schema", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  const byId = new Map<string, Adapter>(ADAPTERS.map((a) => [a.id, a]));

  it("every spool fixture: each normalized event, and the sessions built from them", async () => {
    const files = walk(FIXTURES, (f) => f.endsWith(".spool.jsonl"));
    assert.ok(files.length >= 20, `found ${files.length} spool fixtures`);
    const bad: string[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const file of files) {
      const { ctx } = testCtx();
      const events: AgentEvent[] = [];
      for (const line of loadSpool(rel(file))) {
        const adapter = byId.get(line.agent);
        assert.ok(adapter, `${rel(file)}: no adapter for agent ${line.agent}`);
        seen.add(adapter.id);
        events.push(...(await adapter.normalize(line, ctx)));
      }
      assert.ok(events.length > 0, `${rel(file)} produced no events`);
      total += events.length;
      bad.push(...checkAll(events, rel(file)));
    }
    assert.deepEqual(bad, [], bad.slice(0, 20).join("\n"));
    assert.ok(total > 200, `validated ${total} events`);
    // Every adapter with a hook or plugin capture path has a spool fixture.
    for (const id of ["claude-code", "codex", "opencode", "cursor", "gemini-cli", "antigravity", "copilot-cli", "amp", "pi", "droid", "goose", "aider", "wrapper"]) assert.ok(seen.has(id), `no spool fixture exercised ${id}`);
  });

  // Transcript and store fixtures, read the way each adapter's own tests read them.
  const BACKFILLS: { name: string; adapter: string; setup: () => void }[] = [
    ...["config", "real/config", "edge/config", "fallback/config", "hooks-real/config", "subagents/config"].map((d) => ({
      name: `claude-code/${d}`,
      adapter: "claude-code",
      setup: () => (process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", ...d.split("/"))),
    })),
    ...["home", "cut", "skill"].map((d) => ({ name: `codex/${d}`, adapter: "codex", setup: () => (process.env.CODEX_HOME = join(FIXTURES, "codex", d)) })),
    { name: "opencode/data", adapter: "opencode", setup: () => (process.env.XDG_DATA_HOME = join(FIXTURES, "opencode", "data")) },
    { name: "cursor/config", adapter: "cursor", setup: () => (process.env.CURSOR_CONFIG_DIR = join(FIXTURES, "cursor", "config")) },
    ...["home", "paired/home"].map((d) => ({ name: `gemini-cli/${d}`, adapter: "gemini-cli", setup: () => (process.env.GEMINI_CLI_HOME = join(FIXTURES, "gemini-cli", ...d.split("/"))) })),
    ...["home", "paired/home"].map((d) => ({ name: `antigravity/${d}`, adapter: "antigravity", setup: () => (process.env.HOME = join(FIXTURES, "antigravity", ...d.split("/"))) })),
    {
      name: "antigravity/db-home",
      adapter: "antigravity",
      // The adapter reads its SQLite store from a copy; copy the fixture so nothing lands next to it.
      setup: () => {
        process.env.HOME = join(env.root, "agy-db-home");
        cpSync(join(FIXTURES, "antigravity", "db-home"), process.env.HOME, { recursive: true });
      },
    },
    ...["home", "real/home"].map((d) => ({ name: `copilot-cli/${d}`, adapter: "copilot-cli", setup: () => (process.env.COPILOT_HOME = join(FIXTURES, "copilot-cli", ...d.split("/"), ".copilot")) })),
    ...["home", "real/home"].map((d) => ({ name: `droid/${d}`, adapter: "droid", setup: () => (process.env.HOME = join(FIXTURES, "droid", ...d.split("/"))) })),
    { name: "pi/agent", adapter: "pi", setup: () => (process.env.PI_CODING_AGENT_DIR = join(FIXTURES, "pi", "agent")) },
    { name: "pi/real/home", adapter: "pi", setup: () => (process.env.PI_CODING_AGENT_DIR = join(FIXTURES, "pi", "real", "home", ".pi", "agent")) },
  ];

  for (const b of BACKFILLS) {
    it(`backfill ${b.name}`, async () => {
      const home = process.env.HOME;
      try {
        b.setup();
        const events = await collect(byId.get(b.adapter)!.backfill!(testCtx().ctx));
        assert.ok(events.length > 0, `${b.name} backfilled no events`);
        const bad = checkAll(events, b.name);
        assert.deepEqual(bad, [], bad.slice(0, 20).join("\n"));
      } finally {
        process.env.HOME = home;
        for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "CURSOR_CONFIG_DIR", "GEMINI_CLI_HOME", "COPILOT_HOME", "PI_CODING_AGENT_DIR"]) delete process.env[k];
      }
    });
  }

  it("codex code-mode rollout", async () => {
    const dir = join(FIXTURES, "codex", "code-mode");
    const file = readdirSync(dir).find((f) => f.startsWith("rollout-"))!;
    const events = await convertRollout(testCtx().ctx, join(dir, file), { mode: "full" });
    assert.ok(events.length > 0);
    const bad = checkAll(events, "codex/code-mode");
    assert.deepEqual(bad, [], bad.slice(0, 20).join("\n"));
  });
});

describe("OTLP fixtures validate against the schema", () => {
  const OTEL = join(PKG_ROOT, "test", "fixtures", "otel");
  type J = Record<string, unknown>;
  const blobs = () => {
    const m = new Map<string, Uint8Array | string>();
    return async (d: string | Uint8Array) => {
      const ref = String(m.size).padStart(64, "0");
      m.set(ref, d);
      return ref;
    };
  };

  it("each mapped span and log record, and the sessions built from them (durable runs included)", async () => {
    const bodies: [string, J][] = [];
    for (const f of walk(OTEL, (n) => n.endsWith(".json"))) bodies.push([relative(OTEL, f), JSON.parse(readFileSync(f, "utf8")) as J]);
    for (const f of walk(join(FIXTURES, "copilot-cli", "otel", "otlp"), (n) => n.endsWith(".json"))) bodies.push([rel(f), JSON.parse(readFileSync(f, "utf8")) as J]);
    const durable: [string, J[]][] = walk(join(OTEL, "durable"), (n) => n.endsWith(".jsonl")).map((f) => [
      relative(OTEL, f),
      readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as J),
    ]);
    assert.ok(bodies.length >= 8 && durable.length >= 5, `${bodies.length} OTLP bodies, ${durable.length} durable captures`);
    const bad: string[] = [];
    let total = 0;
    const map = async (body: J, ctx: Parameters<typeof mapTraces>[1]): Promise<AgentEvent[]> => {
      if (typeof body.protobuf === "string") return (await mapTraces(decodeTraceRequest(Buffer.from(body.protobuf, "base64")), ctx)).events;
      if (Array.isArray(body.resourceLogs)) return (await mapLogs(decodeLogsJson(body), ctx)).events;
      return (await mapTraces(decodeTraceJson(body), ctx)).events;
    };
    const ctx = () => ({ maxInlineBytes: 4096, blob: blobs(), traceSessions: new TraceSessionMap(), spanTree: new SpanTree() });
    for (const [name, body] of bodies) {
      const events = await map(body, ctx());
      total += events.length;
      bad.push(...checkAll(events, name));
    }
    const sessions: Session[] = [];
    for (const [name, lines] of durable) {
      const c = ctx();
      const events: AgentEvent[] = [];
      for (const body of lines) events.push(...(await map(body, c)));
      total += events.length;
      bad.push(...checkAll(events, name));
      const by = new Map<string, AgentEvent[]>();
      for (const e of events) by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
      for (const evs of by.values()) sessions.push(buildSession(evs));
    }
    assert.deepEqual(bad, [], bad.slice(0, 20).join("\n"));
    assert.ok(total > 100, `validated ${total} events`);
    assert.ok(sessions.some((s) => s.stats.durable), "a durable capture produced Session.stats.durable");
  });
});
