// Unit tests for coding.sh serve's building blocks (docs/PRODUCTION.md §1-§2):
// key parsing, the refusal rule, config resolution, project scoping, native
// envelope validation, the log redactor and the pricing table.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import { createAuthenticator, generateKey, keyHash, parseBasicAuth, parseIngestKeys, parseReadKeys, sha256 } from "../../src/server/auth.ts";
import { checkExposure, resolveServeConfig, ServeRefusal } from "../../src/server/config.ts";
import { scopeEvents, scopeSessionId, sdkEventId } from "../../src/server/project.ts";
import { parseNativeBatch } from "../../src/server/native.ts";
import { createLogger } from "../../src/server/log.ts";
import { applyPricing, BUILTIN_PRICES, lookupPrice, priceTable } from "../../src/core/pricing.ts";
import { loadConfig } from "../../src/core/config.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "csh-serve-unit-"));
  dirs.push(root);
  mkdirSync(join(root, "home"));
  return { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), ...extra };
}
const req = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage;

describe("keys", () => {
  it("generates prefixed 32-byte base64url keys", () => {
    const k = generateKey("ingest");
    assert.match(k, /^csh_ik_[A-Za-z0-9_-]{43}$/);
    assert.match(generateKey("read"), /^csh_rk_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(k, generateKey("ingest"));
  });

  it("parses ingest entries: project:key, project:sha256:<hex>, bare key = default", () => {
    const a = generateKey("ingest");
    const b = generateKey("ingest");
    const c = generateKey("ingest");
    const m = parseIngestKeys(`demo:${a}, other:sha256:${sha256(b)},${c}`);
    assert.equal(m.get(sha256(a)), "demo");
    assert.equal(m.get(sha256(b)), "other");
    assert.equal(m.get(sha256(c)), "default");
    assert.throws(() => parseIngestKeys(`Bad_Project:${a}`), /invalid project id/);
    assert.equal(keyHash(`SHA256:${sha256(a).toUpperCase()}`), sha256(a));
  });

  it("parses read entries: *:key and bare keys read everything", () => {
    const a = generateKey("read");
    const b = generateKey("read");
    const m = parseReadKeys(`*:${a},demo:${b}`);
    assert.equal(m.get(sha256(a)), "*");
    assert.equal(m.get(sha256(b)), "demo");
    assert.equal(parseReadKeys(a).get(sha256(a)), "*");
    assert.throws(() => parseBasicAuth("nopassword"), /user:password/);
    assert.deepEqual(parseBasicAuth("ops:s3cret"), { user: "ops", passwordSha256: sha256("s3cret") });
  });

  it("authenticates bearer, cookie and basic; open only when no keys and allowed", () => {
    const ik = generateKey("ingest");
    const rk = generateKey("read");
    const auth = createAuthenticator(
      { ingest: parseIngestKeys(`demo:${ik}`), read: parseReadKeys(`demo:${rk}`), basic: parseBasicAuth("ops:pw")! },
      { openIngest: true, openRead: true },
    );
    assert.equal(auth.ingest(req({ authorization: `Bearer ${ik}` })), "demo");
    assert.equal(auth.ingest(req({ authorization: "Bearer csh_ik_wrong" })), undefined);
    assert.equal(auth.ingest(req({})), undefined, "keys configured: no open fallback");
    // Labels are keyed by `by`: each read key gets its own id (a hash prefix, never the secret).
    const rkBy = `reader:${sha256(rk).slice(0, 12)}`;
    assert.deepEqual(auth.read(req({ authorization: `Bearer ${rk}` })), { project: "demo", by: rkBy });
    assert.deepEqual(auth.read(req({ cookie: `x=1; csh_rk=${rk}` })), { project: "demo", by: rkBy });
    assert.ok(!rkBy.includes(rk.slice(7, 19)));
    assert.deepEqual(auth.read(req({ authorization: `Basic ${Buffer.from("ops:pw").toString("base64")}` })), { by: "ops" });
    assert.equal(auth.read(req({ authorization: `Basic ${Buffer.from("ops:nope").toString("base64")}` })), undefined);

    const open = createAuthenticator({ ingest: new Map(), read: new Map() }, { openIngest: true, openRead: true });
    assert.equal(open.ingest(req({})), "default");
    assert.deepEqual(open.read(req({})), {});
    const closed = createAuthenticator({ ingest: new Map(), read: new Map() }, { openIngest: false, openRead: false });
    assert.equal(closed.ingest(req({})), undefined);
    assert.equal(closed.read(req({})), undefined);
  });
});

describe("serve config", () => {
  it("refuses a non-loopback bind without keys, naming the env vars and --insecure", () => {
    const cfg = resolveServeConfig({ host: "0.0.0.0", port: 0 }, tmpEnv());
    assert.throws(
      () => checkExposure(cfg),
      (e: Error) => e instanceof ServeRefusal && /CODING_SH_INGEST_KEYS/.test(e.message) && /CODING_SH_READ_KEYS/.test(e.message) && /--insecure/.test(e.message),
    );
    checkExposure(resolveServeConfig({ host: "0.0.0.0", port: 0, insecure: true }, tmpEnv()));
    checkExposure(resolveServeConfig({ host: "0.0.0.0", port: 0 }, tmpEnv({ CODING_SH_INSECURE: "1" })));
    checkExposure(resolveServeConfig({ host: "127.0.0.1", port: 0 }, tmpEnv()));
    // Ingest key alone is not enough; a read key or basic auth is required too.
    const ingestOnly = resolveServeConfig({ host: "0.0.0.0", port: 0 }, tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${generateKey("ingest")}` }));
    assert.throws(() => checkExposure(ingestOnly), /read key or basic auth/);
    checkExposure(resolveServeConfig({ host: "0.0.0.0", port: 0 }, tmpEnv({ CODING_SH_INGEST_KEYS: generateKey("ingest"), CODING_SH_BASIC_AUTH: "ops:pw" })));
    // A viewer replica needs read credentials only.
    checkExposure(resolveServeConfig({ host: "0.0.0.0", port: 0, role: "viewer" }, tmpEnv({ CODING_SH_READ_KEYS: generateKey("read") })));
  });

  it("follows flags > env > file > defaults, and DATABASE_URL only when postgres", () => {
    const env = tmpEnv({ CODING_SH_PORT: "5000" });
    const file = join(env.HOME!, "serve.toml");
    const k = generateKey("ingest");
    writeFileSync(
      file,
      [
        "[serve]",
        'host = "10.0.0.1"',
        "port = 6000",
        "retention_days = 30",
        "[[serve.projects]]",
        'id = "demo"',
        `ingest_keys = ["sha256:${sha256(k)}"]`,
        "retention_days = 7",
        "[serve.viewer]",
        `read_keys = [{ project = "*", key = "sha256:${sha256("r")}" }]`,
        '[pricing."my-model"]',
        "input = 1",
        "output = 2",
      ].join("\n"),
    );
    const c = resolveServeConfig({ config: file }, env);
    assert.equal(c.host, "10.0.0.1");
    assert.equal(c.port, 5000, "env beats file");
    assert.equal(resolveServeConfig({ config: file, port: 7000 }, env).port, 7000, "flag beats env");
    assert.equal(c.credentials.ingest.get(sha256(k)), "demo");
    assert.equal(c.credentials.read.get(sha256("r")), "*");
    assert.deepEqual(c.projects, ["default", "demo"]);
    assert.equal(c.retentionDays.get("demo"), 7);
    assert.equal(c.retentionDays.get("default"), 30);
    assert.equal(c.core.update.check, false, "servers never phone home");
    assert.deepEqual(c.core.pricing?.["my-model"], { input: 1, output: 2 });

    const pg = resolveServeConfig({}, tmpEnv({ DATABASE_URL: "postgres://u:p@db:5432/x" }));
    assert.equal(pg.core.store.index, "postgres://u:p@db:5432/x");
    assert.equal(pg.core.store.blobs, "postgres://u:p@db:5432/x", "one DB is enough");
    const notPg = resolveServeConfig({}, tmpEnv({ DATABASE_URL: "mysql://db/x" }));
    assert.match(notPg.core.store.index, /^sqlite:/);
    const explicit = resolveServeConfig({}, tmpEnv({ DATABASE_URL: "postgres://a/b", CODING_SH_STORE_URL: "sqlite://:memory:" }));
    assert.equal(explicit.core.store.index, "sqlite://:memory:");
    assert.throws(() => resolveServeConfig({}, tmpEnv({ CODING_SH_CAPTURE_MODE: "bogus" })), /CODING_SH_CAPTURE_MODE/);
    assert.throws(() => resolveServeConfig({}, tmpEnv({ CODING_SH_INGEST_KEYS: "Nope!:x" })), /invalid project id/);
  });

  it("CODING_SH_STORE_URL overrides the store for every command, DATABASE_URL does not", () => {
    const env = tmpEnv({ CODING_SH_STORE_URL: "memory://", CODING_SH_BLOB_URL: "memory://" });
    const c = loadConfig({ env });
    assert.equal(c.store.index, "memory://");
    assert.equal(c.store.blobs, "memory://");
    assert.match(loadConfig({ env: tmpEnv({ DATABASE_URL: "postgres://a/b" }) }).store.index, /^sqlite:/);
  });
});

describe("projects", () => {
  const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({ id: "e", v: 0, sessionId: "s1", ts: 1, agent: "a", kind: "session.start", payload: {}, ...over });

  it("namespaces non-default sessions and keeps default ones unprefixed", () => {
    assert.equal(scopeSessionId("s1", "default"), "s1");
    assert.equal(scopeSessionId("s1", "demo"), "demo/s1");
    assert.equal(scopeSessionId("demo/s1", "demo"), "demo/s1", "idempotent");
    const [a] = scopeEvents([ev({ payload: { parentSessionId: "p", childSessionId: "c" } })], "demo");
    assert.equal(a!.sessionId, "demo/s1");
    assert.equal(a!.project, "demo");
    assert.deepEqual(a!.payload, { parentSessionId: "demo/p", childSessionId: "demo/c" });
    const [b] = scopeEvents([ev({ project: "x" })], "default");
    assert.equal(b!.sessionId, "s1");
    assert.equal(b!.project, undefined);
    assert.notEqual(sdkEventId("a", "1"), sdkEventId("b", "1"));
    assert.equal(sdkEventId("a", "1"), sdkEventId("a", "1"));
  });

  it("never lets a default-project id land in another project's namespace (INS-8)", () => {
    const [x] = scopeEvents([ev({ sessionId: "billing/x" })], "default");
    assert.notEqual(x!.sessionId, "billing/x");
    assert.equal(x!.sessionId, "default/billing/x");
    assert.equal(x!.project, undefined);
    assert.equal(scopeSessionId("default/billing/x", "default"), "default/billing/x", "idempotent for the caller's own prefix");
    assert.equal(scopeSessionId("billing/x", "demo"), "demo/billing/x", "another project's prefix is never kept");
    const [p] = scopeEvents([ev({ payload: { parentSessionId: "billing/p", childSessionId: "c" } })], "default");
    assert.deepEqual(p!.payload, { parentSessionId: "default/billing/p", childSessionId: "c" });
  });
});

describe("native envelope", () => {
  const now = Date.UTC(2026, 10, 6);
  const good = { v: 0, id: "c1", sessionId: "chat-1", ts: now - 1000, kind: "llm.call", payload: { text: "hi\u0000" }, usage: { inputTokens: 10 }, provider: "x", blobs: { a: "b" } };

  it("keeps valid events, rejects bad ones by index, strips NUL and unknown fields", () => {
    const r = parseNativeBatch({ v: 0, service: "My App", events: [good, { ...good, id: "" }, { ...good, kind: "nope" }, { ...good, ts: now + 2 * 86_400_000 }, { ...good, usage: { inputTokens: -1 } }] }, "demo", now);
    assert.equal(r.events.length, 1);
    assert.deepEqual(
      r.rejected.map((x) => x.index),
      [1, 2, 3, 4],
    );
    const e = r.events[0]!;
    assert.equal(e.id, sdkEventId("demo", "c1"));
    assert.equal(e.agent, "my-app");
    assert.equal(e.source, "sdk");
    assert.equal(e.payload.text, "hi");
    assert.equal((e as unknown as Record<string, unknown>).provider, undefined);
    assert.equal(e.blobs, undefined);
  });

  it("rejects a bad envelope with 400", () => {
    assert.throws(() => parseNativeBatch([], "default", now), (e: Error & { status?: number }) => e.status === 400);
    assert.throws(() => parseNativeBatch({ events: {} }, "default", now), /events must be an array/);
    assert.throws(() => parseNativeBatch({ v: 1, events: [] }, "default", now), /v must be 0/);
    assert.throws(() => parseNativeBatch({ events: Array.from({ length: 10_001 }, () => good) }, "default", now), /at most 10000/);
  });
});

describe("logs", () => {
  it("writes JSON lines with secrets redacted", () => {
    const lines: string[] = [];
    const log = createLogger({ format: "json", write: (l) => lines.push(l), now: () => 0 });
    const key = generateKey("ingest");
    log.info("hello", { url: "postgres://user:hunter2@db/x", auth: `Bearer ${key}` });
    const doc = JSON.parse(lines[0]!);
    assert.equal(doc.msg, "hello");
    assert.equal(doc.level, "info");
    assert.doesNotMatch(lines[0]!, /hunter2/);
    assert.ok(!lines[0]!.includes(key), "ingest key is redacted");
  });
});

describe("pricing", () => {
  it("looks up exact, provider-prefixed and dated variants", () => {
    const p = priceTable({ "my-model": { input: 1, output: 2 } });
    assert.deepEqual(lookupPrice("gpt-4o", p), BUILTIN_PRICES["gpt-4o"]);
    assert.deepEqual(lookupPrice("openai/gpt-4o", p), BUILTIN_PRICES["gpt-4o"]);
    assert.deepEqual(lookupPrice("gpt-4o-2024-08-06", p), BUILTIN_PRICES["gpt-4o"]);
    assert.deepEqual(lookupPrice("gpt-4o-mini-2024-07-18", p), BUILTIN_PRICES["gpt-4o-mini"], "longest prefix wins");
    assert.deepEqual(lookupPrice("claude-sonnet-4-5-20250929", p), BUILTIN_PRICES["claude-sonnet-4-5"]);
    assert.deepEqual(lookupPrice("my-model", p), { input: 1, output: 2 });
    assert.equal(lookupPrice("gpt-4o-turbo-x", p), undefined, "not a dated suffix");
    assert.equal(lookupPrice("unknown", p), undefined);
  });

  it("fills costUsd only for llm.call events with tokens and no cost", () => {
    const base = { v: 0 as const, sessionId: "s", ts: 1, agent: "a", payload: {} };
    const out = applyPricing(
      [
        { ...base, id: "1", kind: "llm.call", model: "gpt-4o", usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
        { ...base, id: "2", kind: "llm.call", model: "gpt-4o", usage: { inputTokens: 10, costUsd: 9 } },
        { ...base, id: "3", kind: "llm.call", model: "nope", usage: { inputTokens: 10 } },
        { ...base, id: "4", kind: "llm.call", payload: { responseModel: "gpt-4o" }, usage: { outputTokens: 1_000_000 } },
      ],
      priceTable(),
    );
    assert.equal(out[0]!.usage!.costUsd, 2.5 + 1);
    assert.equal(out[0]!.payload.costEstimated, true);
    assert.equal(out[1]!.usage!.costUsd, 9);
    assert.equal(out[2]!.usage!.costUsd, undefined);
    assert.equal(out[3]!.usage!.costUsd, 10);
  });
});
