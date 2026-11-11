// `coding.sh serve` from source: the healthcheck reaches ports fetch refuses, and a config
// error points at a docs page a reader can open.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanup, runAsync, runSync, tmpHome } from "./_run-source.ts";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
  cleanup();
});

// Ports the fetch standard blocks (the "bad ports" list), tried until one is free.
const BLOCKED_PORTS = [6666, 6667, 6665, 6668, 6669, 4045, 3659, 2049];

async function listenOnBlockedPort(): Promise<number | undefined> {
  for (const port of BLOCKED_PORTS) {
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      servers.push(server);
      return port;
    }
  }
  return undefined;
}

describe("coding.sh serve healthcheck", () => {
  it("probes a port the fetch standard blocks", async (t) => {
    const port = await listenOnBlockedPort();
    if (port === undefined) return t.skip(`none of ${BLOCKED_PORTS.join(", ")} is free on this machine`);
    const r = await runAsync(["serve", "healthcheck", "--url", `http://127.0.0.1:${port}/healthz`, "--json"], tmpHome().env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.status, 200);
  });

  it("reports a refused connection with the reason", () => {
    const r = runSync(["serve", "healthcheck", "--url", "http://127.0.0.1:1/healthz", "--json", "--timeout", "1500"], tmpHome().env);
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error, /ECONNREFUSED|refused/i);
  });

  it("names a URL that is not http(s) once", () => {
    const r = runSync(["serve", "healthcheck", "--url", "ftp://x"], tmpHome().env);
    assert.equal(r.status, 1);
    const said = r.stdout + r.stderr;
    assert.match(said, /ftp:\/\/x must be an http:\/\/ or https:\/\/ URL/);
    assert.equal(said.split("ftp://x").length - 1, 1, said);
  });
});

describe("coding.sh serve config errors", () => {
  it("points at the published docs page, an https URL", () => {
    const h = tmpHome();
    const file = join(h.root, "serve.toml");
    mkdirSync(h.root, { recursive: true });
    writeFileSync(file, `[serve]\nretention_days = "a week"\n`);
    const r = runSync(["serve", "--config", file, "--port", "0"], h.env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Invalid serve configuration/);
    assert.match(r.stderr, /https:\/\/coding\.sh\/docs\/production/);
    assert.doesNotMatch(r.stderr, /PRODUCTION\.md/);
  });
});
