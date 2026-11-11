// serve reads the [proxy] table of the --config file: /proxy/* forwards to the upstream
// that file names, never to the public API and never to the user's own config.toml.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { ConfigError } from "../../src/core/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { anthropicStream, startUpstream, type Upstream } from "../proxy/_helpers.ts";
import { blockRemoteSockets } from "./_no-remote.ts";

const dirs: string[] = [];
const handles: ServeHandle[] = [];
const ups: Upstream[] = [];
after(async () => {
  for (const h of handles) await h.shutdown().catch(() => {});
  for (const u of ups) await u.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "csh-serve-proxycfg-"));
  dirs.push(r);
  mkdirSync(join(r, "home"));
  return r;
}

const messages = (url: string, key: string) =>
  fetch(`${url}/proxy/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-x", "x-coding-sh-key": key },
    body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  });

describe("serve /proxy with --config", () => {
  it("forwards to the [proxy] upstream of the --config file, with remote sockets blocked", async () => {
    const guard = blockRemoteSockets();
    try {
      const up = await startUpstream((_r, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const s of anthropicStream({ text: "from the stub" })) res.write(s);
        res.end();
      });
      ups.push(up);
      const r = root();
      const ik = generateKey("ingest");
      const hash = (await import("../../src/server/auth.ts")).sha256(ik);
      const file = join(r, "serve.toml");
      writeFileSync(file, `[proxy]\nanthropic_upstream = "${up.url}"\n\n[[serve.projects]]\nid = "team"\ningest_keys = ["sha256:${hash}"]\n`);
      const cfg = resolveServeConfig({ port: 0, config: file }, { HOME: join(r, "home"), CODING_SH_HOME: join(r, "data"), CODING_SH_STORE_URL: "memory://" });
      const h = await startServe(cfg, { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() } });
      handles.push(h);
      const res = await messages(h.url, ik);
      assert.match(await res.text(), /from the stub/);
      assert.equal(up.seen.length, 1, "the stub got the call");
      assert.deepEqual(guard.blocked, [], "nothing tried a non-loopback host");
    } finally {
      guard.restore();
    }
  });

  it("ignores the user's own config.toml when --config is given", async () => {
    const r = root();
    mkdirSync(join(r, "data"), { recursive: true });
    writeFileSync(join(r, "data", "config.toml"), `[proxy]\nanthropic_upstream = "http://127.0.0.1:1"\n`);
    const file = join(r, "serve.toml");
    writeFileSync(file, `[serve]\nlog = "json"\n`);
    const cfg = resolveServeConfig({ port: 0, config: file }, { HOME: join(r, "home"), CODING_SH_HOME: join(r, "data"), CODING_SH_STORE_URL: "memory://" });
    assert.deepEqual(cfg.proxyUpstreams, {}, "no upstream from the user's config or proxy.json");
  });

  it("rejects an upstream that is not an http(s) URL and names the key", () => {
    const r = root();
    const file = join(r, "serve.toml");
    writeFileSync(file, `[proxy]\nopenai_upstream = "ftp://nope"\n`);
    assert.throws(
      () => resolveServeConfig({ port: 0, config: file }, { HOME: join(r, "home"), CODING_SH_HOME: join(r, "data"), CODING_SH_STORE_URL: "memory://" }),
      (e) => e instanceof ConfigError && /proxy\.openai_upstream/.test(e.message),
    );
  });
});
