// `coding.sh init --remote <url> --key <ingest key>`: checks the server takes the key, then adds
// (or replaces) one http sink named "team" in ~/.coding.sh/config.toml, keeping every other line.
// A wrong URL or key writes nothing.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { run } from "../../src/cli/commands/init.ts";
import { Output } from "../../src/cli/output.ts";
import { parseRemote, withRemoteSink } from "../../src/cli/remote.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { loadConfig } from "../../src/core/config.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

const KEY = "csh_ik_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let server: Server;
let url = "";
const seen: { path: string; auth: string; body: string }[] = [];
before(async () => {
  // Stands in for `coding.sh serve`: /v1/ingest takes KEY and nothing else.
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body });
      const ok = req.url === "/v1/ingest" && req.method === "POST" && req.headers.authorization === `Bearer ${KEY}`;
      res.writeHead(req.url !== "/v1/ingest" ? 404 : ok ? 200 : 401, { "content-type": "application/json" });
      res.end(ok ? '{"accepted":0,"inserted":0,"rejected":[]}' : '{"error":"no"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

let t: TmpEnv;
beforeEach(() => {
  t = tmpEnv();
  process.env.PATH = join(t.root, "nobin");
  process.env.NO_UPDATE_NOTIFIER = "1";
  const hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  process.env.CODING_SH_HOOK_SOURCE = hook;
  seen.length = 0;
});
afterEach(() => {
  delete process.env.CODING_SH_HOOK_SOURCE;
  delete process.env.CODING_SH_INGEST_KEY;
  t.restore();
});

async function init(flags: Record<string, string | boolean>): Promise<{ code: number; stderr: string; error?: Error }> {
  let stderr = "";
  const out = new Output({ json: false, env: process.env, stdout: { write: () => true, isTTY: false }, stderr: { write: (s: string) => ((stderr += s), true), isTTY: false }, stdin: { isTTY: false } });
  const c: CommandContext = { flags: { yes: true, mcp: false, ...flags }, positionals: [], rest: [], out, env: process.env, cwd: t.root, debug: false, signal: new AbortController().signal };
  try {
    return { code: await run(c), stderr };
  } catch (e) {
    return { code: -1, stderr, error: e as Error };
  }
}

const configFile = () => join(t.dataHome, "config.toml");

describe("init --remote", () => {
  test("adds the team sink after checking the key, with no agents on the machine", async () => {
    const r = await init({ remote: `${url}/`, key: KEY });
    assert.equal(r.code, 0, r.error?.message);
    assert.deepEqual(seen.map((s) => [s.path, s.auth, s.body]), [["/v1/ingest", `Bearer ${KEY}`, '{"v":0,"events":[]}']]);
    assert.match(r.stderr, new RegExp(`Sending new sessions to ${url} \\(metadata only\\)`));
    if (process.platform !== "win32") assert.equal(statSync(configFile()).mode & 0o777, 0o600);
    const cfg = loadConfig({ env: process.env, file: configFile() });
    assert.equal(cfg.sinks.length, 1);
    const s = cfg.sinks[0]!;
    assert.deepEqual([s.name, s.kind, s.endpoint, s.mode, s.headers], ["team", "http", `${url}/v1/ingest`, "metadata", { Authorization: `Bearer ${KEY}` }]);
  });

  test("replaces an earlier team sink in place and keeps other sinks and comments", async () => {
    const before = [
      "# my settings",
      "[capture]",
      'mode = "full"',
      "",
      "[[sinks]]",
      'name = "collector"',
      'kind = "otlp"',
      'endpoint = "http://collector:4319"',
      "",
      "[[sinks]] # written by coding.sh init --remote",
      'name = "team"',
      'kind = "http"',
      'endpoint = "https://old.example.com/v1/ingest"',
      'mode = "metadata"',
      'headers = { Authorization = "Bearer csh_ik_old_old_old_old_old" }',
      "",
      "# trailing note",
      "",
    ].join("\n");
    writeFile(configFile(), before);
    const r = await init({ remote: url, key: KEY, "remote-mode": "full" });
    assert.equal(r.code, 0, r.error?.message);
    const text = readFileSync(configFile(), "utf8");
    assert.ok(text.startsWith("# my settings\n[capture]\nmode = \"full\"\n\n[[sinks]]\nname = \"collector\""), text);
    assert.ok(text.endsWith("\n\n# trailing note\n"), text);
    assert.doesNotMatch(text, /old\.example\.com|csh_ik_old/);
    const cfg = loadConfig({ env: process.env, file: configFile() });
    assert.deepEqual(cfg.sinks.map((s) => [s.name, s.kind, s.endpoint, s.mode]), [
      ["collector", "otlp", "http://collector:4319", "metadata"],
      ["team", "http", `${url}/v1/ingest`, "full"],
    ]);
    // Same flags again: nothing to change.
    const again = await init({ remote: url, key: KEY, "remote-mode": "full" });
    assert.equal(again.code, 0);
    assert.equal(readFileSync(configFile(), "utf8"), text);
  });

  test("a refused key, an unreachable server or a read key writes nothing", async () => {
    const bad = await init({ remote: url, key: "csh_ik_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    assert.match(bad.error?.message ?? "", /refused the key\. Nothing was changed/);
    const down = await init({ remote: "http://127.0.0.1:9", key: KEY });
    assert.match(down.error?.message ?? "", /Can't reach http:\/\/127\.0\.0\.1:9/);
    const notServe = await init({ remote: `${url}/elsewhere`, key: KEY });
    assert.match(notServe.error?.message ?? "", /answered 404/);
    const read = await init({ remote: url, key: "csh_rk_cccccccccccccccccccccccccccccccccccccccccccc" });
    assert.match(read.error?.message ?? "", /read key/);
    const noKey = await init({ remote: url });
    assert.match(noKey.error?.message ?? "", /needs the ingest key/);
    assert.match((await init({ key: KEY })).error?.message ?? "", /go with --remote/);
    assert.ok(!existsSync(configFile()), "no config written");
  });

  test("takes the key from CODING_SH_INGEST_KEY", async () => {
    process.env.CODING_SH_INGEST_KEY = KEY;
    const r = await init({ remote: url });
    assert.equal(r.code, 0, r.error?.message);
    assert.match(readFileSync(configFile(), "utf8"), new RegExp(`Bearer ${KEY}`));
  });
});

describe("withRemoteSink / parseRemote", () => {
  const r = parseRemote("https://obs.example.com/v1/ingest", KEY, undefined);
  test("normalizes the URL and defaults to metadata", () => {
    assert.deepEqual(r, { url: "https://obs.example.com", key: KEY, mode: "metadata" });
    assert.equal(parseRemote("https://example.com/obs/", KEY, "full").url, "https://example.com/obs");
    assert.throws(() => parseRemote("obs.example.com", KEY, undefined), /must be the server's URL/);
    assert.throws(() => parseRemote("ftp://obs.example.com", KEY, undefined), /http:\/\/ or https:\/\//);
    assert.throws(() => parseRemote("https://u:p@obs.example.com", KEY, undefined), /no query, fragment or credentials/);
    assert.throws(() => parseRemote("https://obs.example.com", KEY, "loud"), /--remote-mode/);
    assert.throws(() => parseRemote("https://obs.example.com", 'csh_ik_"x"yyyyyyyyyyyyyyyy', undefined), /quote/);
  });
  test("appends to a file with no team sink, keeping CRLF", () => {
    const text = withRemoteSink("[capture]\r\nmode = \"full\"\r\n", r);
    assert.ok(text.startsWith('[capture]\r\nmode = "full"\r\n\r\n[[sinks]] # written by coding.sh init --remote\r\nname = "team"\r\n'), JSON.stringify(text));
    assert.ok(text.endsWith('headers = { Authorization = "Bearer ' + KEY + '" }\r\n'));
    const file = join(t.root, "c.toml");
    writeFileSync(file, text);
    assert.equal(loadConfig({ env: process.env, file }).sinks[0]!.endpoint, "https://obs.example.com/v1/ingest");
  });
});
