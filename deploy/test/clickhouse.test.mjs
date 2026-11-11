// The ClickHouse collector recipe (deploy/clickhouse/, docs/reference/stores.md) end to end:
// compose up, send the fixture sessions through the otlp sink to the collector on 127.0.0.1:4319,
// wait for them in otel.otel_traces over HTTP on 8123, then run every SQL block in the doc.
// Needs Docker and free ports 8123 and 4319, so it runs only with CODING_SH_TEST_COMPOSE=1 (on the desk):
//   CODING_SH_TEST_COMPOSE=1 node --test deploy/test/clickhouse.test.mjs
// The static checks (the doc's collector YAML matches the file) always run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const doc = read("docs/reference/stores.md");
const section = doc.slice(doc.indexOf("### Export to ClickHouse through an OpenTelemetry Collector"), doc.indexOf("## Next"));
const blocks = (lang) => [...section.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);
const lines = (text) => text.split("\n").map((l) => l.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, "").trimEnd()).filter(Boolean);

describe("deploy/clickhouse static", () => {
  test("the doc's collector YAML is part of otel-collector.yaml, line for line", () => {
    const file = lines(read("deploy/clickhouse/otel-collector.yaml"));
    const [yaml] = blocks("yaml");
    assert.ok(yaml, "yaml block in the doc");
    const missing = lines(yaml).filter((l) => !file.includes(l));
    assert.deepEqual(missing, []);
  });

  test("compose pins both images and publishes on 127.0.0.1 only", () => {
    const dc = read("deploy/clickhouse/docker-compose.yml");
    assert.match(dc, /image: clickhouse\/clickhouse-server:\d+\.\d+\.\d+\.\d+$/m);
    assert.match(dc, /image: otel\/opentelemetry-collector-contrib:\d+\.\d+\.\d+$/m);
    const ports = [...dc.matchAll(/^\s+- "([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(ports, ["127.0.0.1:8123:8123", "127.0.0.1:4319:4318"]);
    assert.doesNotMatch(dc, /PASSWORD: [^$]/, "no literal password");
  });
});

const SKIP = process.env.CODING_SH_TEST_COMPOSE === "1" ? false : "set CODING_SH_TEST_COMPOSE=1 (needs Docker)";

describe("deploy/clickhouse compose", { skip: SKIP, timeout: 300_000 }, () => {
  const project = `csh-ch-otel-${randomBytes(3).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const env = { ...process.env, CLICKHOUSE_PASSWORD: password };
  const compose = (...args) => {
    const r = spawnSync("docker", ["compose", "-p", project, "-f", join(root, "deploy/clickhouse/docker-compose.yml"), ...args], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`docker compose ${args.join(" ")}: ${r.stderr}`);
  };
  const sql = async (query, params = {}) => {
    const url = new URL("http://127.0.0.1:8123/");
    url.searchParams.set("default_format", "JSONEachRow");
    url.searchParams.set("output_format_json_quote_64bit_integers", "0");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
    const res = await fetch(url, { method: "POST", body: query, headers: { "X-ClickHouse-User": "otel", "X-ClickHouse-Key": password } });
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let spans = 0;

  before(async () => {
    compose("up", "-d", "--wait");
    const { OtlpSink, toOtlpSpans } = await import("../../packages/coding.sh/src/sinks/otlp.ts");
    const { clickhouseFixture } = await import("../../packages/coding.sh/test/docs/clickhouse-fixture.ts");
    const { batch, sessions, open } = clickhouseFixture();
    // Both sessions were also sent while open: an earlier invoke_agent row each, with the same span id.
    spans = toOtlpSpans(batch, sessions, "metadata").length + open.length;
    // The sink config from the doc, pointed at the published port.
    const [toml] = blocks("toml");
    assert.match(toml, /kind = "otlp"/);
    const sink = new OtlpSink({ kind: "otlp", name: "clickhouse", endpoint: "http://127.0.0.1:4319", mode: "metadata" });
    for (let i = 0; ; i++) {
      const ack = await sink.writeOpenSessions(open, undefined);
      if (ack.ok) break;
      if (i > 30) throw new Error(`collector refused the open sessions: ${JSON.stringify(ack)}`);
      await sleep(1000);
    }
    const ack = await sink.write(batch, sessions, undefined);
    if (!ack.ok) throw new Error(`collector refused the batch: ${JSON.stringify(ack)}`);
    for (let i = 0; ; i++) {
      const rows = await sql("SELECT count() AS n FROM otel.otel_traces WHERE ServiceName = 'coding.sh'").catch(() => [{ n: 0 }]);
      if (rows[0].n >= spans) break;
      if (i > 90) throw new Error(`only ${rows[0].n} of ${spans} spans reached otel_traces`);
      await sleep(1000);
    }
  });
  after(() => compose("down", "-v"));

  test("every span the sink sent is a row", async () => {
    const rows = await sql("SELECT SpanAttributes['gen_ai.operation.name'] AS op, count() AS n FROM otel.otel_traces GROUP BY op ORDER BY op");
    assert.deepEqual(rows, [
      { op: "chat", n: 4 },
      { op: "execute_tool", n: 5 },
      { op: "invoke_agent", n: 4 },
    ]);
    assert.equal(spans, 13);
    const ids = await sql("SELECT uniqExact(SpanId) AS sessions, count() AS n FROM otel.otel_traces WHERE SpanAttributes['gen_ai.operation.name'] = 'invoke_agent'");
    assert.deepEqual(ids, [{ sessions: 2, n: 4 }]);
  });

  test("the doc's four queries run and answer for the fixture", async () => {
    const [cost, tools, failed, trace] = blocks("sql");
    assert.ok(trace, "four sql blocks");

    const byAgent = Object.fromEntries((await sql(cost)).map((r) => [`${r.agent}/${r.model}`, r]));
    assert.equal(byAgent["claude-code/claude-sonnet-4-5"].cost_usd, 0.42);
    assert.equal(byAgent["codex/gpt-5"].cost_usd, 1.25);
    assert.equal(byAgent["codex/gpt-5"].input_tokens, 30000);
    assert.equal(byAgent["claude-code/claude-sonnet-4-5"].sessions, 1);

    const tool = Object.fromEntries((await sql(tools)).map((r) => [r.tool, r]));
    assert.equal(tool.Bash.calls, 3);
    assert.equal(tool.Bash.errors, 2);
    assert.equal(tool.Bash.max_ms, 11000);
    assert.equal(tool.Read.errors, 0);
    assert.equal((await sql(tools))[0].tool, "Bash", "slowest first");

    const bad = await sql(failed);
    assert.deepEqual(bad.map((r) => r.session), ["ch-howto-failed"]);
    assert.equal(bad[0].tests_failed, 2);
    assert.deepEqual(bad[0].flags, ["repeated-tool-failure", "no-verification"]);

    const one = await sql(trace, { session: "ch-howto-ok" });
    assert.deepEqual(one.map((r) => r.SpanName), ["invoke_agent claude-code", "chat claude-sonnet-4-5", "execute_tool Read", "execute_tool Bash", "chat claude-sonnet-4-5"]);
    assert.equal(one[0].cost_usd, "0.42");
  });
});
