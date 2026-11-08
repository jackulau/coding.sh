#!/usr/bin/env node
// Self-host smoke test: runs the image the way docs/how-to/self-host-team.md says, then checks a
// team's first minutes end to end. CI runs it (.github/workflows/ci.yml, job "image"); run it
// locally from the repo root after `npm ci && npm run build -w coding.sh`:
//
//   docker build -t coding-sh:smoke .
//   node deploy/test/smoke.mjs docker  coding-sh:smoke                      # docker run, zero config
//   node deploy/test/smoke.mjs compose coding-sh:smoke deploy/compose/compose.yml
//
// Each run: start with no keys -> read the first-start keys from the logs -> send an OTLP trace
// with curl-like fetch -> connect a throwaway HOME with `coding.sh init --remote` and replay a
// recorded Claude Code session through the real hook -> both show in /api/sessions and the viewer
// signs in with the read key -> restart -> the same keys and both sessions are still there.
// Everything runs under a temp HOME; containers, volumes and the compose project are removed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [mode, image, composeFile] = process.argv.slice(2);
if (!["docker", "compose"].includes(mode) || !image || (mode === "compose" && !composeFile)) {
  console.error("usage: smoke.mjs docker <image> | smoke.mjs compose <image> <compose file>");
  process.exit(2);
}
const CLI = join(root, "packages/coding.sh/dist/cli.mjs");
const HOOK = join(root, "packages/coding.sh/dist/hook.mjs");
const FIXTURES = join(root, "packages/coding.sh/test/fixtures/adapters");
const port = Number(process.env.SMOKE_PORT ?? 14318);
const url = `http://127.0.0.1:${port}`;
const tag = `csh-smoke-${process.pid}`;
const started = Date.now();
const step = (s) => console.log(`\n== ${s} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const compose = (...args) => sh("docker", ["compose", "-p", tag, "-f", composeFile, ...args], { env: { ...process.env, CODING_SH_IMAGE: image, CODING_SH_PUBLISH: `127.0.0.1:${port}` } });
const run = {
  start() {
    if (mode === "docker") sh("docker", ["run", "-d", "--name", tag, "-p", `127.0.0.1:${port}:4318`, "-v", `${tag}:/data`, image]);
    else compose("up", "-d", "--wait", "--pull", "missing");
  },
  restart() {
    if (mode === "docker") sh("docker", ["restart", tag]);
    else {
      compose("down"); // keeps the volumes
      compose("up", "-d", "--wait", "--pull", "missing");
    }
  },
  logs: () => (mode === "docker" ? sh("docker", ["logs", tag], { stdio: ["ignore", "pipe", "pipe"] }) : compose("logs", "--no-log-prefix", "coding-sh")),
  cleanup() {
    if (mode === "docker") {
      spawnSync("docker", ["rm", "-f", tag], { stdio: "ignore" });
      spawnSync("docker", ["volume", "rm", "-f", tag], { stdio: "ignore" });
    } else spawnSync("docker", ["compose", "-p", tag, "-f", composeFile, "down", "-v"], { stdio: "ignore", env: { ...process.env, CODING_SH_IMAGE: image } });
  },
};

async function ready(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${url}/readyz`);
      if (r.status === 200) return r.json();
    } catch {}
    if (Date.now() > until) throw new Error(`no 200 from ${url}/readyz within ${timeoutMs / 1000} s\n${run.logs()}`);
    await sleep(500);
  }
}

/** The read and ingest keys from the first-start block in the logs; every start prints them. */
function keysFromLogs() {
  const logs = run.logs();
  const read = /read key\s+(csh_rk_[A-Za-z0-9_-]+)/.exec(logs)?.[1];
  const ingest = /ingest key\s+(csh_ik_[A-Za-z0-9_-]+)/.exec(logs)?.[1];
  assert.ok(read && ingest, `no keys in the logs:\n${logs}`);
  assert.match(logs, /Connect\s+coding\.sh init --remote http:\/\/127\.0\.0\.1:4318 --key csh_ik_/);
  return { read, ingest, logs };
}

async function sessions(readKey, want, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${url}/api/sessions?limit=50`, { headers: { authorization: `Bearer ${readKey}` } });
    assert.equal(r.status, 200);
    const items = (await r.json()).items;
    if (want(items)) return items;
    if (Date.now() > until) throw new Error(`sessions never matched: ${JSON.stringify(items.map((s) => s.id))}`);
    await sleep(500);
  }
}

const OTLP_SESSION = "smoke-otlp-conversation";
const AGENT_SESSION = "11111111-2222-4333-8444-555555555555";
const both = (items) => items.some((s) => s.id === OTLP_SESSION) && items.some((s) => s.id === AGENT_SESSION && s.agent === "claude-code");

const home = mkdtempSync(join(tmpdir(), "csh-smoke-"));
try {
  step(`${mode}: start ${image} with no configuration`);
  try {
    run.start();
  } catch (e) {
    console.error(`${e.stderr ?? e.message}\n--- coding-sh logs\n${(() => { try { return run.logs(); } catch { return "(none)"; } })()}`);
    throw new Error("the server did not start");
  }
  const r0 = await ready();
  console.log(JSON.stringify(r0));
  const keys = keysFromLogs();
  console.log("keys found in the logs");

  step("an app sends an OTLP trace with the ingest key");
  const now = BigInt(Date.now()) * 1_000_000n;
  const span = {
    traceId: "5b8efff798038103d269b633813fc60c",
    spanId: "eee19b7ec3c1b174",
    name: "chat gpt-4o-mini",
    kind: 3,
    startTimeUnixNano: String(now - 900_000_000n),
    endTimeUnixNano: String(now - 400_000_000n),
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4o-mini" } },
      { key: "gen_ai.conversation.id", value: { stringValue: OTLP_SESSION } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: "30" } },
    ],
  };
  const otlp = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "smoke-app" } }] }, scopeSpans: [{ scope: { name: "smoke" }, spans: [span] }] }] };
  const post = (key) => fetch(`${url}/v1/traces`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(otlp) });
  assert.equal((await post()).status, 401, "ingest without a key is refused");
  assert.equal((await post(keys.ingest)).status, 200);

  step("a developer connects with coding.sh init --remote, and a Claude Code session goes through the real hook");
  const env = { PATH: process.env.PATH, HOME: join(home, "home"), USERPROFILE: join(home, "home"), CODING_SH_HOME: join(home, "home/.coding.sh"), CLAUDE_CONFIG_DIR: join(home, "home/.claude"), CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  mkdirSync(env.HOME, { recursive: true });
  const init = spawnSync(process.execPath, [CLI, "init", "--remote", url, "--key", keys.ingest, "--yes", "--no-mcp"], { env, encoding: "utf8" });
  console.log(init.stderr.trim());
  assert.equal(init.status, 0, init.stderr);
  assert.match(readFileSync(join(env.CODING_SH_HOME, "config.toml"), "utf8"), new RegExp(`endpoint = "${url}/v1/ingest"`));
  for (const line of readFileSync(join(FIXTURES, "claude-code/hooks.spool.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const ev = JSON.parse(line.replaceAll("${FIXTURES}", FIXTURES));
    const h = spawnSync(process.execPath, [HOOK, ev.agent, ev.event], { env, input: JSON.stringify(ev.raw), encoding: "utf8" });
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.stdout, "", "the hook prints nothing");
  }
  // The hook starts a background ingest at the end of the turn; an explicit one makes it certain.
  const ing = spawnSync(process.execPath, [CLI, "ingest"], { env, encoding: "utf8" });
  assert.equal(ing.status, 0, ing.stderr);

  step("both sessions show in the API; the viewer signs in with the read key");
  const items = await sessions(keys.read, both);
  console.log(items.map((s) => `${s.id} ${s.agent}`).join("\n"));
  assert.equal((await fetch(`${url}/api/sessions`)).status, 401, "the API needs the read key");
  assert.equal((await fetch(`${url}/api/sessions`, { headers: { authorization: `Bearer ${keys.ingest}` } })).status, 401, "an ingest key cannot read");
  const signIn = await fetch(`${url}/?t=${keys.read}`, { redirect: "manual" });
  assert.equal(signIn.status, 302);
  const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "the read key is traded for a cookie");
  const page = await fetch(`${url}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>coding\.sh/);
  const viaCookie = await fetch(`${url}/api/sessions/${encodeURIComponent(AGENT_SESSION)}`, { headers: { cookie } });
  assert.equal(viaCookie.status, 200, "the viewer reads the agent session with the cookie");

  step("restart: same keys, same sessions");
  run.restart();
  await ready();
  const again = keysFromLogs();
  assert.equal(again.read, keys.read);
  assert.equal(again.ingest, keys.ingest);
  await sessions(keys.read, both, 5_000);
  step(`ok: ${mode} smoke passed`);
} finally {
  run.cleanup();
  rmSync(home, { recursive: true, force: true });
}
