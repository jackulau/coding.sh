// init --proxy points an agent only at a port the proxy can hold. With the configured port taken
// by another program or another home's proxy, set to 0, or left while this home's proxy runs on
// another port, it writes no base URL, still sets up the hooks, and names the command that fixes it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run as initRun } from "../../src/cli/commands/init.ts";
import { nextStepBin } from "../../src/cli/next-steps.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { parseToml } from "../../src/core/toml.ts";
import { readProxyInstalls } from "../../src/proxy/install.ts";
import { startProxy, type ProxyServer } from "../../src/proxy/server.ts";
import { readProxyState, writeProxyState } from "../../src/proxy/state.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

let t: TmpEnv;
let settings = "";
let codexConfig = "";
const servers: Server[] = [];
const proxies: ProxyServer[] = [];
// Base URLs in the environment are chained through: keep the developer's own out of these tests.
const SAVED = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "CODING_SH_HOOK_SOURCE"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  t = tmpEnv();
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.CLAUDE_CONFIG_DIR = join(t.home, ".claude");
  process.env.CODEX_HOME = join(t.home, ".codex");
  process.env.PATH = join(t.root, "nobin");
  const hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  process.env.CODING_SH_HOOK_SOURCE = hook;
  settings = join(t.home, ".claude", "settings.json");
  codexConfig = join(t.home, ".codex", "config.toml");
});

afterEach(async () => {
  // A proxy init started in the background: stopped by its PID. Run in-process, init can't start one.
  const st = readProxyState(process.env);
  if (st && st.pid !== process.pid) {
    try {
      process.kill(st.pid);
    } catch {
      // not running
    }
  }
  for (const p of proxies.splice(0)) if (p.server.listening) await p.close();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  t.restore();
});

/** A port another program holds: a server on a free loopback port, closed after the test. */
async function holdPort(): Promise<number> {
  // It speaks no HTTP and hangs up on each connection, so none is left open to stall close().
  const s = createServer((sock) => sock.destroy());
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return (s.address() as AddressInfo).port;
}

/** A loopback port nothing listens on now. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function configPort(port: number): void {
  writeFile(join(t.dataHome, "config.toml"), `[proxy]\nport = ${port}\n`);
}

function ctx(flags: Record<string, unknown> = {}, json = false): { c: CommandContext; out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  const out = new Output({ json, env: process.env, stdout: { write: (s: string) => ((stdout += s), true), isTTY: false }, stderr: { write: (s: string) => ((stderr += s), true), isTTY: false }, stdin: { isTTY: false } });
  const c: CommandContext = { flags: { yes: true, mcp: false, import: false, proxy: true, agent: ["claude-code"], ...flags }, positionals: [], rest: [], out, env: process.env, cwd: t.root, debug: false, signal: new AbortController().signal };
  return { c, out: () => stdout, err: () => stderr };
}

const claudeBaseUrl = (): unknown => (existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")).env?.ANTHROPIC_BASE_URL : undefined);
const bin = () => nextStepBin(process.env);

describe("init --proxy and the configured port", () => {
  test("another program holds it: no agent gets a base URL, the hooks go in, and the next steps pick another port", async () => {
    const port = await holdPort();
    configPort(port);
    const r = ctx({ agent: ["claude-code", "codex"] });
    assert.equal(await initRun(r.c), 1);
    assert.equal(claudeBaseUrl(), undefined, "no base URL for a port the proxy can't hold");
    assert.ok(JSON.parse(readFileSync(settings, "utf8")).hooks, "the hooks are set up");
    if (existsSync(codexConfig)) assert.equal(parseToml(readFileSync(codexConfig, "utf8")).model_provider, undefined);
    assert.deepEqual(readProxyInstalls(process.env), {});
    assert.equal(readProxyState(process.env), undefined, "no proxy started");
    const reason = `port ${port} is in use by another program`;
    assert.ok(r.err().includes(`✗ can't route through the proxy: ${reason}`), r.err());
    assert.ok(r.err().includes(`! Did not route Claude Code and Codex CLI through the proxy: ${reason}\n`), r.err());
    assert.doesNotMatch(r.err(), /now calls?|→ proxy at/);
    const pick = new RegExp(`\\n {2}Pick another port:\\n {4}(.+) config set proxy\\.port (\\d+)\\n`).exec(r.err());
    assert.ok(pick, r.err());
    assert.equal(pick[1], bin());
    assert.notEqual(Number(pick[2]), port);
    // Run in-process, init has no command line: --proxy is added back.
    assert.ok(r.err().endsWith(`\n  Then run init again:\n    ${bin()} init --proxy\n`), r.err());
  });

  test("--json gives the reason and the command that fixes it", async () => {
    const port = await holdPort();
    configPort(port);
    const r = ctx({}, true);
    assert.equal(await initRun(r.c), 1);
    const doc = JSON.parse(r.out());
    assert.equal(doc.outcome, "partial");
    const reason = `port ${port} is in use by another program`;
    assert.equal(doc.proxy.url, `http://127.0.0.1:${port}`);
    assert.equal(doc.proxy.running, false);
    assert.equal(doc.proxy.error, reason);
    assert.match(doc.proxy.next, /^\S+ config set proxy\.port \d+$/);
    assert.equal(doc.agents[0].proxy.error, reason);
    assert.equal(claudeBaseUrl(), undefined);
  });

  test("a dry run shows the blocker in the plan and the port command before the one that applies it", async () => {
    const port = await holdPort();
    configPort(port);
    const r = ctx({ "dry-run": true });
    assert.equal(await initRun(r.c), 1);
    assert.ok(r.out().includes(`✗ can't route through the proxy: port ${port} is in use by another program`), r.out());
    assert.match(r.err(), /\n {2}Pick another port:\n {4}\S+ config set proxy\.port \d+\n\n {2}Apply the plan:\n/);
    assert.ok(!existsSync(settings), "a dry run writes nothing");
  });

  test("another home's proxy holds it: says so, with its pid", async () => {
    const other = await startProxy({ port: 0, info: { pid: process.pid } });
    proxies.push(other);
    configPort(other.port);
    const r = ctx();
    assert.equal(await initRun(r.c), 1);
    assert.ok(r.err().includes(`! Did not route Claude Code through the proxy: port ${other.port} is in use by another coding.sh proxy (pid ${process.pid})\n`), r.err());
    assert.equal(claudeBaseUrl(), undefined);
  });

  test("this home's proxy runs on another port: says where, and the next step stops it", async () => {
    const running = await startProxy({ port: 0 });
    proxies.push(running);
    await writeProxyState({ pid: process.pid, url: running.url, host: running.host, port: running.port, startedAt: Date.now(), upstreams: { anthropic: "", openai: "", chatgpt: "" } }, process.env);
    const port = await freePort();
    configPort(port);
    const r = ctx();
    assert.equal(await initRun(r.c), 1);
    assert.ok(r.err().includes(`the coding.sh proxy runs on port ${running.port} (pid ${process.pid}), not on port ${port}, which proxy.port sets\n`), r.err());
    assert.ok(r.err().includes(`\n  Stop it:\n    ${bin()} proxy stop\n`), r.err());
    assert.equal(claudeBaseUrl(), undefined);
  });

  test("proxy.port 0: no base URL with port 0, and the next step sets a port that stays", async () => {
    configPort(0);
    const r = ctx();
    assert.equal(await initRun(r.c), 1);
    assert.ok(r.err().includes("Did not route Claude Code through the proxy: proxy.port is 0, which gives the proxy a new port each time it starts\n"), r.err());
    assert.match(r.err(), /\n {2}Pick a port that stays:\n {4}\S+ config set proxy\.port \d+\n/);
    assert.equal(claudeBaseUrl(), undefined);
  });

  test("a free port gets the route; a proxy that then fails to start is named with one agent's verb", async () => {
    const port = await freePort();
    configPort(port);
    const r = ctx();
    assert.equal(await initRun(r.c), 0);
    assert.equal(claudeBaseUrl(), `http://127.0.0.1:${port}`);
    // Run in-process, there is no CLI to start in the background.
    assert.ok(r.err().includes(`! Claude Code now calls http://127.0.0.1:${port}, but the proxy did not start (`), r.err());
    assert.doesNotMatch(r.err(), /Did not route/);
  });
});
