// The background refresh runs refreshUpdateCache's source text in a detached
// `node -e` child. These tests run that path for real (from source and from an
// esbuild bundle, like dist/cli.mjs) against a loopback server, so a stray
// reference to a module-level name fails here instead of silently in the field.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { cacheFile, scheduleUpdateCheck } from "../../src/update/index.ts";
import { release, tmpEnv } from "./helpers.ts";

let server: Server;
let base = "";
const hits: { url: string; ua: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", ua: String(req.headers["user-agent"] ?? "") });
    if (req.url === "/repos/jackulau/coding.sh/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(release("v9.8.7")));
    } else {
      res.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function waitForCache(file: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (c.checkedAt || c.error) return c;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no refreshed cache at ${file}`);
}

describe("background refresh child", () => {
  test("from source: writes the cache without the parent waiting", async () => {
    const env = tmpEnv();
    const t0 = Date.now();
    assert.equal(scheduleUpdateCheck(env, { githubApi: base, npmRegistry: base, current: "0.1.0" }), true);
    assert.ok(Date.now() - t0 < 500, "spawning does not wait on the network");
    const c = await waitForCache(cacheFile(env));
    assert.equal(c.error, undefined);
    assert.equal(c.latest, "9.8.7");
    assert.equal(c.current, "0.1.0");
    assert.equal(c.install, "https://github.com/jackulau/coding.sh/releases/download/v9.8.7/coding.sh-9.8.7.tgz");
    assert.match(hits.at(-1)!.ua, /^coding\.sh\/0\.1\.0 /);
  });

  test("from an esbuild bundle (the shape of dist/cli.mjs)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-update-bundle-")));
    try {
      const outfile = join(dir, "update.mjs");
      await build({
        entryPoints: [fileURLToPath(new URL("../../src/update/index.ts", import.meta.url))],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile,
        logLevel: "silent",
        define: { __CODING_SH_VERSION__: JSON.stringify("0.0.1") },
      });
      const mod = (await import(pathToFileURL(outfile).href)) as typeof import("../../src/update/index.ts");
      const env = tmpEnv();
      assert.equal(mod.scheduleUpdateCheck(env, { githubApi: base, npmRegistry: base }), true);
      const c = await waitForCache(mod.cacheFile(env));
      assert.equal(c.error, undefined);
      assert.equal(c.latest, "9.8.7");
      assert.equal(c.current, "0.0.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
