// `coding.sh collector import --clickhouse` against a real ClickHouse (docs/reference/stores.md,
// "Pull from ClickHouse"): compose up deploy/clickhouse (Map attributes) plus a second collector with
// `json: true` (JSON attributes), post the Claude Code and Vercel AI SDK fixtures to both, then import
// each table and compare with posting the same OTLP straight to the coding.sh receiver, field by field.
// A second import stores 0 events, --dry-run writes nothing, and a wrong password is refused.
// Needs Docker and free ports 8123, 4319 and 4321, so it runs only with CODING_SH_TEST_COMPOSE=1 (on the desk):
//   CODING_SH_TEST_COMPOSE=1 node --no-warnings --test deploy/test/clickhouse-import.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = join(root, "packages/coding.sh");
const SKIP = process.env.CODING_SH_TEST_COMPOSE === "1" ? false : "set CODING_SH_TEST_COMPOSE=1 (needs Docker)";
const FIXTURES = ["claude-code-traces.json", "vercel-ai.json"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fixture with every timestamp moved so its first span starts at `startMs` (the table's TTL drops old rows). */
function shifted(name, startMs) {
  const body = JSON.parse(readFileSync(join(pkg, "test/fixtures/otel", name), "utf8"));
  let first;
  for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) first = first === undefined || BigInt(s.startTimeUnixNano) < first ? BigInt(s.startTimeUnixNano) : first;
  const delta = BigInt(startMs) * 1_000_000n - first;
  const move = (v) => String(BigInt(v) + delta);
  for (const rs of body.resourceSpans)
    for (const ss of rs.scopeSpans)
      for (const s of ss.spans) {
        s.startTimeUnixNano = move(s.startTimeUnixNano);
        s.endTimeUnixNano = move(s.endTimeUnixNano);
        for (const e of s.events ?? []) e.timeUnixNano = move(e.timeUnixNano);
      }
  return JSON.stringify(body);
}

const { MemIndex } = await import(join(pkg, "test/otel/_memstore.ts"));
class KvIndex extends MemIndex {
  kv = new Map();
  async kvGet(k) {
    return this.kv.get(k);
  }
  async kvSet(k, v) {
    this.kv.set(k, v);
  }
}

const spanCount = (body) => JSON.parse(body).resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)).length;

describe("collector import from a live ClickHouse", { skip: SKIP, timeout: 600_000 }, () => {
  const project = `csh-ch-import-${randomBytes(3).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const env = { ...process.env, CLICKHOUSE_PASSWORD: password };
  const tmp = mkdtempSync(join(tmpdir(), "csh-ch-import-"));
  const files = ["-f", join(root, "deploy/clickhouse/docker-compose.yml"), "-f", join(tmp, "json.yml")];
  const compose = (...args) => {
    const r = spawnSync("docker", ["compose", "-p", project, ...files, ...args], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`docker compose ${args.join(" ")}: ${r.stderr}`);
  };
  const sql = async (query) => {
    const res = await fetch("http://127.0.0.1:8123/?default_format=JSONEachRow", { method: "POST", body: query, headers: { "X-ClickHouse-User": "otel", "X-ClickHouse-Key": password } });
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  const startMs = Date.now() - 60_000;
  const bodies = FIXTURES.map((f) => shifted(f, startMs));
  const total = bodies.reduce((n, b) => n + spanCount(b), 0);
  let m;

  before(async () => {
    // The same collector config with `json: true`, writing to database otel_json.
    const yaml = readFileSync(join(root, "deploy/clickhouse/otel-collector.yaml"), "utf8").replace("database: otel\n", "database: otel_json\n").replace("# json: true", "json: true");
    assert.match(yaml, /^\s+json: true/m);
    writeFileSync(join(tmp, "otel-collector-json.yaml"), yaml);
    writeFileSync(
      join(tmp, "json.yml"),
      [
        "services:",
        "  otel-collector-json:",
        "    image: otel/opentelemetry-collector-contrib:0.164.0",
        '    command: ["--config=/etc/otelcol-contrib/config.yaml"]',
        "    environment:",
        "      CLICKHOUSE_USER: otel",
        "      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD}",
        "    volumes:",
        `      - ${join(tmp, "otel-collector-json.yaml")}:/etc/otelcol-contrib/config.yaml:ro`,
        "    ports:",
        '      - "127.0.0.1:4321:4318"',
        "    depends_on:",
        "      clickhouse:",
        "        condition: service_healthy",
        "",
      ].join("\n"),
    );
    compose("up", "-d", "--wait");
    m = {
      ch: await import(join(pkg, "src/otel/clickhouse.ts")),
      rx: await import(join(pkg, "src/otel/receiver.ts")),
      mem: await import(join(pkg, "test/otel/_memstore.ts")),
    };
    for (const port of [4319, 4321]) {
      for (const body of bodies) {
        for (let i = 0; ; i++) {
          const res = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: "POST", body, headers: { "Content-Type": "application/json" } }).catch(() => undefined);
          if (res?.ok) break;
          if (i > 60) throw new Error(`collector on ${port} refused the spans: ${res?.status}`);
          await sleep(1000);
        }
      }
    }
    for (const db of ["otel", "otel_json"]) {
      for (let i = 0; ; i++) {
        const n = await sql(`SELECT count() AS n FROM ${db}.otel_traces`).then((r) => Number(r[0].n)).catch(() => 0);
        if (n >= total) break;
        if (i > 120) throw new Error(`${db}.otel_traces has ${n} of ${total} spans`);
        await sleep(1000);
      }
    }
  });
  after(() => {
    try {
      compose("down", "-v");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  async function dump(store) {
    const out = {};
    for (const [id, session] of [...store.sessions].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[id] = { session, events: (await store.listEvents(id)).sort((a, b) => (a.id < b.id ? -1 : 1)) };
    }
    return out;
  }

  async function posted() {
    const store = new KvIndex();
    const rx = await m.rx.startReceiver({ port: 0, store, blobs: new m.mem.MemBlobs() });
    try {
      for (const body of bodies) assert.equal((await fetch(`${rx.url}/v1/traces`, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status, 200);
    } finally {
      await rx.close();
    }
    return dump(store);
  }

  for (const [db, mode] of [["otel", "map"], ["otel_json", "json"]]) {
    test(`${db}.otel_traces (${mode} attributes) imports field by field equal to posting the OTLP`, async () => {
      const url = `http://127.0.0.1:8123/?database=${db}`;
      const target = { url, env: { CLICKHOUSE_USER: "otel", CLICKHOUSE_PASSWORD: password }, since: startMs - 60_000 };
      assert.equal(await m.ch.attributeMode(target), mode);
      const want = await posted();
      assert.ok(Object.keys(want).length >= 2);
      const store = new KvIndex();
      const dry = await m.ch.importClickHouse({ ...target, store, blobs: new m.mem.MemBlobs(), dryRun: true });
      assert.equal(dry.spans, total);
      assert.equal(store.events.size + store.sessions.size + store.kv.size, 0, "a dry run writes nothing");
      const r = await m.ch.importClickHouse({ ...target, store, blobs: new m.mem.MemBlobs(), limit: 3 });
      assert.equal(r.mode, mode);
      assert.equal(r.spans, total);
      assert.equal(r.rejected, 0, r.errors.join("; "));
      assert.deepEqual(await dump(store), want);
      const again = await m.ch.importClickHouse({ ...target, store, blobs: new m.mem.MemBlobs() });
      assert.deepEqual([again.inserted, again.sessions.length], [0, 0]);
      assert.deepEqual(await dump(store), want);
    });
  }

  test("the CLI imports once, then 0, and names the fix for a wrong password", () => {
    const home = join(tmp, "home");
    const cliEnv = { PATH: process.env.PATH, HOME: home, CODING_SH_HOME: join(home, ".coding.sh"), NO_COLOR: "1", CLICKHOUSE_USER: "otel", CLICKHOUSE_PASSWORD: password };
    const run = (args, extra = {}) => spawnSync(process.execPath, ["--no-warnings", join(pkg, "src/cli/main.ts"), "collector", "import", "--clickhouse", "http://127.0.0.1:8123/?database=otel", "--since", "1h", "--json", ...args], { env: { ...cliEnv, ...extra }, encoding: "utf8" });
    const first = run([]);
    assert.equal(first.status, 0, first.stderr);
    const a = JSON.parse(first.stdout);
    assert.equal(a.spans, total);
    assert.ok(a.inserted > 0 && a.sessions >= 2);
    const b = JSON.parse(run([]).stdout);
    assert.deepEqual([b.inserted, b.sessions], [0, 0]);
    const bad = run([], { CLICKHOUSE_PASSWORD: "wrong" });
    assert.equal(bad.status, 1);
    const err = JSON.parse(bad.stderr);
    assert.equal(err.reason, "clickhouse_unauthorized", bad.stderr);
    assert.match(err.next.join(" "), /CLICKHOUSE_PASSWORD/);
  });
});
