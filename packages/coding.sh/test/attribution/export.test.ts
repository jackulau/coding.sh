import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AGENT_TRACE_VERSION, agentTraceRecords, commitRecord, modelId, stableUuid, validateAgentTrace } from "../../src/attribution/export.ts";
import { attributeRepo } from "../../src/attribution/index.ts";
import type { CommitAttribution } from "../../src/attribution/match.ts";
import { isolate, removeTmp } from "../capture/_helpers.ts";
import { buildFixture, type Fixture } from "./_fixture.ts";

before(() => isolate());
after(() => removeTmp());

const FIX = join(import.meta.dirname, "..", "fixtures", "attribution");
// The trace-record schema from agent-trace.dev §6.1 (RFC 0.1.0), copied as published.
const SCHEMA = JSON.parse(readFileSync(join(FIX, "agent-trace-0.1.0.schema.json"), "utf8")) as Schema;
const EXAMPLE = JSON.parse(readFileSync(join(FIX, "agent-trace-0.1.0.example.json"), "utf8")) as Record<string, unknown>;

type Schema = Record<string, unknown>;

/** The JSON Schema keywords the Agent Trace schema uses, checked independently of export.ts's validator. */
function schemaErrors(schema: Schema, v: unknown, at = "$", rootSchema: Schema = schema): string[] {
  if (typeof schema.$ref === "string") {
    const path = schema.$ref.replace(/^#\//, "").split("/");
    let s: unknown = rootSchema;
    for (const p of path) s = (s as Record<string, unknown>)[p];
    return schemaErrors(s as Schema, v, at, rootSchema);
  }
  const e: string[] = [];
  const type = schema.type;
  const isObj = typeof v === "object" && v !== null && !Array.isArray(v);
  if (type === "object" && !isObj) return [`${at}: not an object`];
  if (type === "array" && !Array.isArray(v)) return [`${at}: not an array`];
  if (type === "string" && typeof v !== "string") return [`${at}: not a string`];
  if (type === "integer" && !Number.isInteger(v)) return [`${at}: not an integer`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) e.push(`${at}: not in enum`);
  if (typeof schema.pattern === "string" && typeof v === "string" && !new RegExp(schema.pattern).test(v)) e.push(`${at}: does not match ${schema.pattern}`);
  if (typeof schema.maxLength === "number" && typeof v === "string" && v.length > schema.maxLength) e.push(`${at}: too long`);
  if (typeof schema.minimum === "number" && typeof v === "number" && v < schema.minimum) e.push(`${at}: below minimum`);
  if (schema.format === "uuid" && typeof v === "string" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) e.push(`${at}: not a uuid`);
  if (schema.format === "date-time" && typeof v === "string" && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) || Number.isNaN(Date.parse(v)))) e.push(`${at}: not a date-time`);
  if (schema.format === "uri" && typeof v === "string") {
    try {
      new URL(v);
    } catch {
      e.push(`${at}: not a uri`);
    }
  }
  if (isObj) {
    const o = v as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (o[r] === undefined) e.push(`${at}.${r}: required`);
    for (const [k, s] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) if (o[k] !== undefined) e.push(...schemaErrors(s, o[k], `${at}.${k}`, rootSchema));
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => e.push(...schemaErrors(schema.items as Schema, x, `${at}[${i}]`, rootSchema)));
  return e;
}

describe("Agent Trace export", () => {
  let fx: Fixture;
  before(async () => {
    fx = await buildFixture();
  });

  test("every record from the fixture repo passes the RFC schema and export's own validator", async () => {
    const report = await attributeRepo({ index: fx.index, blobs: fx.blobs, env: fx.env }, { cwd: fx.root });
    const records = agentTraceRecords(report, { toolVersion: "0.0.0-test" });
    // One record per commit with agent lines: C1, C2, the rebased C3 (not the human commit).
    assert.deepEqual(records.map((r) => r.vcs?.revision), [fx.commits.c1, fx.commits.c2, fx.commits.c3Rebased]);
    for (const r of records) {
      assert.deepEqual(schemaErrors(SCHEMA, r), [], JSON.stringify(r));
      assert.deepEqual(validateAgentTrace(r), []);
      assert.equal(r.version, AGENT_TRACE_VERSION);
      assert.equal(r.tool?.name, "coding.sh");
      for (const f of r.files) for (const c of f.conversations) assert.equal(c.contributor?.type, "ai");
    }
    const c3 = records[2]!;
    assert.deepEqual(c3.files.map((f) => f.path).sort(), ["src/feature.ts", "src/math.ts"]);
    const math = c3.files.find((f) => f.path === "src/math.ts")!.conversations[0]!;
    assert.equal(math.contributor?.model_id, "anthropic/claude-opus-4-1");
    assert.deepEqual(math.ranges.map((r) => [r.start_line, r.end_line]), [[17, 21]]);
    assert.match(math.ranges[0]!.content_hash!, /^sha256:[0-9a-f]{16}$/);
    assert.equal(math.url, "http://127.0.0.1:4319/#/s/s3-claude");
    assert.deepEqual(math.related, [{ type: "session", url: math.url }]);
    const c2meta = records[1]!.metadata!["sh.coding"] as { linesAdded: number; linesAttributed: number; sessions: { id: string; agent: string }[] };
    assert.equal(c2meta.linesAdded - c2meta.linesAttributed, 3);
    assert.deepEqual(c2meta.sessions.map((s) => [s.id, s.agent]), [["s2-codex", "codex"]]);
    // Exporting again gives the same records (ids come from the commit).
    assert.deepEqual(agentTraceRecords(report, { toolVersion: "0.0.0-test" }), records);
  });

  test("the validator agrees with the schema on bad records", () => {
    // The RFC's own example says "0.1.0", which its schema's version pattern rejects.
    assert.ok(schemaErrors(SCHEMA, EXAMPLE).some((x) => x.includes("version")));
    assert.ok(validateAgentTrace(EXAMPLE).some((x) => x.startsWith("version")));
    const fixed = { ...EXAMPLE, version: "0.1" };
    assert.deepEqual(schemaErrors(SCHEMA, fixed), []);
    assert.deepEqual(validateAgentTrace(fixed), []);
    const bad: unknown[] = [
      { ...fixed, id: "not-a-uuid" },
      { ...fixed, timestamp: "yesterday" },
      { ...fixed, vcs: { type: "cvs", revision: "x" } },
      { ...fixed, files: [{ path: "a", conversations: [{ ranges: [{ start_line: 0, end_line: 1 }] }] }] },
      { ...fixed, files: [{ path: "a", conversations: [{ contributor: { type: "robot" }, ranges: [] }] }] },
      { ...fixed, files: [{ path: "a", conversations: [{ url: "no scheme", ranges: [] }] }] },
      { ...fixed, files: [{ path: "a" }] },
      { version: "0.1", id: stableUuid("x"), timestamp: "2026-01-01T00:00:00Z" },
    ];
    for (const b of bad) {
      assert.notDeepEqual(schemaErrors(SCHEMA, b), [], JSON.stringify(b));
      assert.notDeepEqual(validateAgentTrace(b), [], JSON.stringify(b));
    }
  });

  test("a commit with no agent lines has no record; git-ai lines have no session link", () => {
    const c: CommitAttribution = { commit: "a".repeat(40), parents: [], subject: "x", author: "x", committedAt: 0, authoredAt: 0, added: 3, attributed: 0, attributions: [] };
    assert.equal(commitRecord(c), undefined);
    const r = commitRecord({
      ...c,
      attributed: 2,
      attributions: [{ commit: c.commit, path: "a.ts", ranges: [{ start: 1, end: 2, contentHash: "sha256:00" }], lines: 2, sessionId: "conv-1", agent: "cursor", model: "gpt-5", confidence: 0.9, method: "git-ai", source: "git-ai" }],
    })!;
    assert.deepEqual(validateAgentTrace(r), []);
    assert.equal(r.files[0]!.conversations[0]!.url, undefined);
    assert.equal(r.files[0]!.conversations[0]!.contributor?.model_id, "openai/gpt-5");
  });

  test("model ids follow models.dev provider/model", () => {
    assert.equal(modelId("claude-opus-4-1"), "anthropic/claude-opus-4-1");
    assert.equal(modelId("gpt-5-codex"), "openai/gpt-5-codex");
    assert.equal(modelId("o3"), "openai/o3");
    assert.equal(modelId("gemini-2.5-pro"), "google/gemini-2.5-pro");
    assert.equal(modelId("openrouter/qwen3-coder"), "openrouter/qwen3-coder");
    assert.equal(modelId("my-local-model"), undefined);
    assert.equal(modelId(undefined), undefined);
    assert.match(stableUuid("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
