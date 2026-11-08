// `coding.sh serve` mounts the proxy at /proxy/*: one URL for a team. The
// ingest key (x-coding-sh-key) picks the project and is never forwarded; the
// client's own API key goes upstream and is never stored.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { anthropicStream, startUpstream, type Upstream } from "./_helpers.ts";

const dirs: string[] = [];
const handles: ServeHandle[] = [];
const ups: Upstream[] = [];
after(async () => {
  for (const h of handles) await h.shutdown().catch(() => {});
  for (const u of ups) await u.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function setup(env: NodeJS.ProcessEnv): Promise<{ h: ServeHandle; up: Upstream; index: MemoryIndexStore; blobs: MemoryBlobStore }> {
  const root = mkdtempSync(join(tmpdir(), "csh-serve-proxy-"));
  dirs.push(root);
  mkdirSync(join(root, "home"));
  const up = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_up_1" });
    for (const s of anthropicStream({ text: "served" })) res.write(s);
    res.end();
  });
  ups.push(up);
  const index = new MemoryIndexStore();
  const blobs = new MemoryBlobStore();
  const cfg = resolveServeConfig({ port: 0 }, { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_STORE_URL: "memory://", ...env });
  const h = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, stores: { index, blobs }, proxyUpstreams: { anthropic: up.url, openai: up.url } });
  handles.push(h);
  return { h, up, index, blobs };
}

const messages = (h: ServeHandle, headers: Record<string, string>) =>
  fetch(`${h.url}/proxy/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-client-secret-123", "user-agent": "claude-cli/2.1.0 (external, cli)", "x-claude-code-session-id": "4f1c2a9e-8d7b-4c1a-9e2f-0a1b2c3d4e5f", ...headers },
    body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: "hi" }] }),
  });

describe("serve /proxy/*", () => {
  it("logs into the key's project, forwards the client's API key and not the ingest key", async () => {
    const ik = generateKey("ingest");
    const { h, up, index } = await setup({ CODING_SH_INGEST_KEYS: `team:${ik}` });

    const denied = await messages(h, {});
    assert.equal(denied.status, 401);
    assert.match(await denied.text(), /x-coding-sh-key/);
    assert.equal(up.seen.length, 0, "nothing forwarded without an ingest key");

    const r = await messages(h, { "x-coding-sh-key": ik });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /served/);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0]!.url, "/v1/messages?beta=true", "the /proxy prefix is stripped");
    assert.equal(up.seen[0]!.headers["x-api-key"], "sk-ant-client-secret-123");
    assert.equal(up.seen[0]!.headers["x-coding-sh-key"], undefined);

    // The call lands through the ingest queue, in the key's project.
    await h.shutdown();
    const sessions = await index.listSessions({ project: "team" });
    assert.equal(sessions.length, 1);
    const events = await index.listEvents(sessions[0]!.id);
    const call = events.find((e) => e.kind === "llm.call");
    assert.ok(call, "an llm.call");
    assert.equal(call!.project, "team");
    assert.equal(call!.source, "proxy");
    assert.equal(call!.usage?.cacheReadTokens, 5000);
    const stored = JSON.stringify(events) + JSON.stringify(sessions);
    assert.ok(!stored.includes("sk-ant-client-secret-123"), "the client's API key is never stored");
    assert.ok(!stored.includes(ik), "the ingest key is never stored");
  });

  it("an open loopback server takes calls into the default project", async () => {
    const { h, index } = await setup({});
    const r = await messages(h, {});
    assert.equal(r.status, 200);
    await r.text();
    await h.shutdown();
    const [s] = await index.listSessions({ project: "default" });
    assert.ok(s, "a session in project default");
  });
});
