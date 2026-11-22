// Langfuse trace tags (langfuse.trace.tags) through the OTel receiver: the mapper puts them on the
// session.start, the fold makes each a tag:<name> flag, and `sessions --where flag:tag:<name>` finds
// the session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { type MapContext, mapTraces, TRACE_TAG_CHARS, TraceSessionMap } from "../../src/otel/map.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { CLI } from "../_cli.ts";
import { otlpSpan, sAttr } from "./_encode.ts";
import { MemBlobs } from "./_memstore.ts";

type J = Record<string, unknown>;
const T = "2f0000000000000000000000000000aa";
const ctx = (): MapContext => {
  const blobs = new MemBlobs();
  return { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap() };
};
const arr = (key: string, values: string[]): J => ({ key, value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } } });
const request = (spans: J[], resource: J[] = []) => ({ resourceSpans: [{ resource: { attributes: [sAttr("service.name", "lf-app"), ...resource] }, scopeSpans: [{ scope: { name: "langfuse-sdk" }, spans }] }] });
const root = (attrs: J[], traceId = T, startMs = 0) =>
  otlpSpan(traceId, "2f00000000000001", undefined, "checkout", [sAttr("gen_ai.operation.name", "invoke_agent"), ...(attrs as never[])], startMs, startMs + 1000);
const mapped = async (spans: J[], resource: J[] = []): Promise<AgentEvent[]> => (await mapTraces(decodeTraceJson(request(spans, resource)), ctx())).events;
const tagFlags = (events: AgentEvent[]) => buildSession(events).flags.filter((f) => f.startsWith("tag:"));
const startTags = (events: AgentEvent[]) => events.find((e) => e.kind === "session.start")?.payload.tags;

describe("Langfuse trace tags", () => {
  it("an array of tags gives one tag:<name> flag each", async () => {
    const events = await mapped([root([arr("langfuse.trace.tags", ["prod", "checkout"])])]);
    assert.deepEqual(startTags(events), ["prod", "checkout"]);
    assert.deepEqual(tagFlags(events), ["tag:prod", "tag:checkout"]);
  });

  it("reads a JSON array string as tags, and any other string as one tag", async () => {
    assert.deepEqual(tagFlags(await mapped([root([sAttr("langfuse.trace.tags", '["a","b"]')])])), ["tag:a", "tag:b"]);
    assert.deepEqual(tagFlags(await mapped([root([sAttr("langfuse.trace.tags", "nightly")])])), ["tag:nightly"]);
    assert.deepEqual(tagFlags(await mapped([root([sAttr("langfuse.trace.tags", "[not json")])])), ["tag:[not json"]);
  });

  it("trims, drops empty ones and repeats, keeps 20 of at most 64 characters", async () => {
    assert.deepEqual(startTags(await mapped([root([arr("langfuse.trace.tags", [" prod ", "", "  ", "prod", "eu"])])])), ["prod", "eu"]);
    const many = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const events = await mapped([root([arr("langfuse.trace.tags", many)])]);
    assert.deepEqual(startTags(events), many.slice(0, 20));
    assert.equal(tagFlags(events).length, 20);
    const long = `${"x".repeat(TRACE_TAG_CHARS - 1)}😀tail`;
    assert.deepEqual(startTags(await mapped([root([arr("langfuse.trace.tags", [long])])])), ["x".repeat(TRACE_TAG_CHARS - 1)], "no half of a surrogate pair at the cut");
  });

  it("takes the resource's tags when the span has none, the span's when both do", async () => {
    assert.deepEqual(startTags(await mapped([root([])], [arr("langfuse.trace.tags", ["from-resource"])])), ["from-resource"]);
    assert.deepEqual(startTags(await mapped([root([arr("langfuse.trace.tags", ["from-span"])])], [arr("langfuse.trace.tags", ["from-resource"])])), ["from-span"]);
  });

  it("joins the tags of every trace of one conversation", async () => {
    const one = await mapped([root([sAttr("langfuse.session.id", "conv-1"), arr("langfuse.trace.tags", ["prod", "a"])])]);
    const two = await mapped([root([sAttr("langfuse.session.id", "conv-1"), arr("langfuse.trace.tags", ["a", "b"])], "2f0000000000000000000000000000bb", 2000)]);
    assert.deepEqual(tagFlags([...one, ...two]), ["tag:prod", "tag:a", "tag:b"]);
  });

  it("a span with no tags adds no payload key and no flag", async () => {
    const events = await mapped([root([sAttr("langfuse.user.id", "u1")])]);
    assert.equal("tags" in events.find((e) => e.kind === "session.start")!.payload, false);
    assert.deepEqual(tagFlags(events), []);
    assert.deepEqual(tagFlags(await mapped([root([arr("langfuse.trace.tags", ["", " "])])])), []);
  });
});

describe("sessions --where flag:tag:<name>", () => {
  let dir = "";
  let env: Record<string, string>;
  const ids = (where: string) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, "sessions", "--where", where, "--json"], { env, encoding: "utf8", cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    return (JSON.parse(r.stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort();
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-trace-tags-"));
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    env = {
      PATH: process.env.PATH ?? "",
      ["HO" + "ME"]: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CODEX_HOME: join(dir, "codex"),
      XDG_CONFIG_HOME: join(dir, "xdg-config"),
      XDG_DATA_HOME: join(dir, "xdg-data"),
      CURSOR_CONFIG_DIR: join(dir, "cursor"),
      OPENCODE_CONFIG_DIR: join(dir, "opencode"),
      OPENCODE_DB: join(dir, "opencode.db"),
      CODING_SH_NO_AUTO_INGEST: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      TZ: "UTC",
    };
    const c = await openContext({ env, cwd: dir });
    const t0 = Date.now() - 3600e3;
    for (const [sid, attrs] of [
      ["tagged", [arr("langfuse.trace.tags", ["prod", "checkout"])]],
      ["untagged", []],
    ] as const) {
      const events = await mapped([root([sAttr("langfuse.session.id", sid), ...attrs])]);
      const base = Math.min(...events.map((e) => e.ts));
      const recent = events.map((e) => ({ ...e, ts: e.ts - base + t0 }));
      await c.index.putEvents(recent);
      await c.index.upsertSession(buildSession(recent));
    }
    await c.close();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the session by each of its tags and not by another", () => {
    assert.deepEqual(ids("flag:tag:prod"), ["tagged"]);
    assert.deepEqual(ids("flag:tag:checkout"), ["tagged"]);
    assert.deepEqual(ids("flag:tag:nope"), []);
    assert.deepEqual(ids("-flag:tag:prod"), ["untagged"]);
  });
});
