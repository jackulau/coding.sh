// docs/how-to/self-host-team.md's ClickHouse collector route queries otel_traces by span
// attribute. Every attribute key and span name it names must be one the otlp sink sends, so a
// renamed attribute fails here instead of silently returning empty columns.
// The Docker-gated deploy/test/clickhouse.test.mjs runs the same queries against real ClickHouse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { toOtlpRequest } from "../../src/sinks/otlp.ts";
import { clickhouseFixture } from "./clickhouse-fixture.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const doc = readFileSync(join(repo, "docs", "how-to", "self-host-team.md"), "utf8");
const section = doc.slice(doc.indexOf("### Export to ClickHouse through an OpenTelemetry Collector"), doc.indexOf("## Next"));

function sent(mode: "full" | "metadata") {
  const { batch, sessions } = clickhouseFixture(1_800_000_000_000);
  const spans = toOtlpRequest(batch, sessions, mode).resourceSpans[0]!.scopeSpans[0]!.spans;
  const keys = new Set<string>();
  for (const s of spans) for (const a of s.attributes) keys.add(a.key);
  return { keys, names: new Set(spans.map((s) => s.name.split(" ")[0]!)), ops: new Set(spans.flatMap((s) => s.attributes.filter((a) => a.key === "gen_ai.operation.name").map((a) => ("stringValue" in a.value ? a.value.stringValue : undefined)))) };
}

describe("ClickHouse collector how-to", () => {
  it("has the section, its SQL and its sink", () => {
    assert.ok(section.length > 1000, "section found");
    assert.ok((section.match(/```sql/g) ?? []).length >= 4, "four queries");
    assert.match(section, /kind = "otlp"/);
  });

  it("queries only attributes the otlp sink sends in metadata mode", () => {
    const { keys } = sent("metadata");
    const used = [...section.matchAll(/SpanAttributes\['([a-z_.]+)'\]/g)].map((m) => m[1]!);
    assert.ok(used.length >= 10, "found the queried keys");
    const missing = [...new Set(used)].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `the doc queries keys the sink does not send: ${missing.join(", ")}`);
  });

  it("names only attribute keys the sink sends", () => {
    const { keys } = sent("metadata");
    const named = [...section.matchAll(/`((?:gen_ai|coding_sh|vcs)\.[a-z_.]*[a-z_])`/g)].map((m) => m[1]!);
    const missing = [...new Set(named)].filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `the doc names keys the sink does not send: ${missing.join(", ")}`);
    const usage = section.match(/`gen_ai\.usage\.\*` is ([\s\S]*?)\.\s/)![1]!.match(/`([a-z_.]+)`/g)!;
    assert.equal(usage.length, 4);
    for (const k of usage) assert.ok(keys.has(`gen_ai.usage.${k.slice(1, -1)}`), k);
    for (const stat of section.match(/coding_sh\.stats\.\*` \(([^)]+)\)/)![1]!.split(", ")) assert.ok(keys.has(`coding_sh.stats.${stat}`), stat);
  });

  it("names the span names and operations the sink sends", () => {
    const { names, ops } = sent("metadata");
    for (const n of ["invoke_agent", "execute_tool", "chat"]) {
      assert.ok(names.has(n), n);
      assert.ok(ops.has(n), n);
      assert.ok(section.includes(`\`${n} <`), `table row for ${n}`);
    }
    for (const op of section.matchAll(/'gen_ai\.operation\.name'\] = '([a-z_]+)'/g)) assert.ok(ops.has(op[1]!), op[1]);
  });

  it("metadata mode sends no prompts or tool output, as the doc says", () => {
    const full = sent("full").keys;
    const meta = sent("metadata").keys;
    assert.ok(full.has("gen_ai.tool.call.arguments") && !meta.has("gen_ai.tool.call.arguments"));
    assert.ok(full.has("coding_sh.session.title") && !meta.has("coding_sh.session.title"));
  });
});
