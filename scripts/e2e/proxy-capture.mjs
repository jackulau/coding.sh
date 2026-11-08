#!/usr/bin/env node
// The model API proxy, end to end with real agents: install coding.sh from a
// tarball and the real Claude Code and Codex CLIs from npm under a throwaway
// HOME, `coding.sh init --proxy` (hooks, plus each agent's base URL pointed at
// the proxy, which it starts), then drive one headless session per agent. The
// proxy's upstream is a local stub model. Checks:
//   - every model call went agent → proxy → stub, streamed, with the agent's own key;
//   - each call is an llm.call (source proxy) inside the session the hooks captured;
//   - the request (system prompt, tools) and the response are readable back
//     (`show <session>#-1`, `diff-calls`), and no API key is stored anywhere;
//   - `exp replay` replays a logged call (dry run, then against the stub);
//   - `uninstall --proxy` puts both agents' configs back byte for byte;
//   - with a gateway already set (Claude Code's ANTHROPIC_BASE_URL, a Codex
//     provider of its own), `init --proxy` chains through it: the calls are
//     logged and sent on to it, and uninstall puts the old base URL back.
//
//   node scripts/e2e/proxy-capture.mjs [--agent claude-code|codex]... [--tarball coding.sh-x.y.z.tgz] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME. Exit 0 when every check passed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isWin = process.platform === "win32";
// Fake keys with a recognizable body: the store must never contain them.
const ANTHROPIC_KEY = "sk-ant-api03-PROXYE2ESECRETPROXYE2ESECRETPROXYE2E-abcdefAA";
const OPENAI_KEY = "sk-proj-PROXYE2ESECRETPROXYE2ESECRETPROXYE2E";
const SECRETS = ["PROXYE2ESECRET"];

const AGENTS = {
  "claude-code": { pkg: "@anthropic-ai/claude-code@2.1.319", bin: "claude", model: "claude-sonnet-4-5", config: (home) => join(home, ".claude", "settings.json") },
  codex: { pkg: "@openai/codex@0.167.0", bin: "codex", model: "gpt-5", config: (home) => join(home, ".codex", "config.toml") },
};

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined, agents: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--agent") {
      const id = argv[++i];
      if (!AGENTS[id]) throw new Error(`--agent ${id}: one of ${Object.keys(AGENTS).join(", ")}`);
      o.agents.push(id);
    } else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.agents.length) o.agents = Object.keys(AGENTS);
  return o;
}

const log = (...a) => console.log("[proxy-capture]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

function run(file, args, { cwd, env, input, timeoutMs = 300_000, quiet = false } = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env: cwd && env ? { ...env, PWD: cwd } : env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!quiet && code !== 0) log(`${file} ${args.join(" ")} exited ${code}\n--- stdout\n${stdout.slice(-3000)}\n--- stderr\n${stderr.slice(-3000)}`);
      done({ code, stdout, stderr });
    });
  });
}

const freePort = () =>
  new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** Every file under `dir`, as one string (for "never stored" checks). Binary files are read as latin1. */
function everyByte(dir) {
  let out = "";
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 256 * 1024 * 1024) out += readFileSync(p).toString("latin1");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-proxy-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const csHome = join(home, ".coding.sh");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
const binDir = isWin ? prefix : join(prefix, "bin");

// Codex's shell tool is exec_command ({ cmd }), which the stub's defaults don't know.
const codexShell = (body) => {
  const names = (body.tools || []).map((t) => t.name || t.function?.name);
  const answered = (Array.isArray(body.input) ? body.input : []).some((i) => i?.type === "function_call_output");
  return names.includes("exec_command") && !answered ? { tool: { name: "exec_command", args: { cmd: "echo hello from stub > hello.txt" } } } : undefined;
};
const stub = await startStub({ decide: codexShell });
const port = await freePort();
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) continue;
  env[k] = v;
}
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  CODING_SH_HOME: csHome,
  [pathKey]: [binDir, env[pathKey]].filter(Boolean).join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  CODING_SH_NO_UPDATE_CHECK: "1",
  CODING_SH_NO_UI: "1",
  // No base URL here: init --proxy points each agent at the proxy in its own config.
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (isWin) {
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
}
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
// The proxy's port and upstreams (the stub plays both APIs).
mkdirSync(csHome, { recursive: true });
writeFileSync(join(csHome, "config.toml"), `[proxy]\nport = ${port}\nanthropic_upstream = "${stub.url}"\nopenai_upstream = "${stub.url}"\n`);
log(`temp root ${root}`);
log(`stub model on ${stub.url}, proxy port ${port}`);

let exitCode = 0;
const cs = (args, o = {}) => run("coding.sh", args, { env, cwd: root, ...o });
try {
  let tarball = opts.tarball;
  if (!tarball) {
    const pkgDir = join(REPO, "packages", "coding.sh");
    if (!existsSync(join(pkgDir, "dist", "cli.mjs"))) throw new Error("packages/coding.sh/dist is missing: run npm run build first, or pass --tarball");
    const packed = await run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: pkgDir });
    if (packed.code !== 0) throw new Error("npm pack failed");
    tarball = join(root, packed.stdout.trim().split(/\r?\n/).pop());
  }
  const pkgs = opts.agents.map((a) => AGENTS[a].pkg);
  log(`installing ${tarball} and ${pkgs.join(", ")}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, ...pkgs], { env, cwd: root, timeoutMs: 600_000 });
  if (install.code !== 0) throw new Error("npm install -g failed");
  log(`coding.sh ${(await cs(["--version"])).stdout.trim()}`);
  for (const a of opts.agents) log(`${a} ${(await run(AGENTS[a].bin, ["--version"], { env, cwd: root })).stdout.trim()}`);

  // Configs as the user had them, to compare after uninstall.
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(AGENTS["claude-code"].config(home), '{\n  "theme": "dark"\n}\n');
  writeFileSync(AGENTS.codex.config(home), 'model = "gpt-5"\n\n[tui]\nnotifications = false\n');
  const before = Object.fromEntries(opts.agents.map((a) => [a, readFileSync(AGENTS[a].config(home), "utf8")]));
  if (opts.agents.includes("codex")) {
    // Codex reads its key from its own login; the proxy forwards it as sent.
    const login = await run("codex", ["login", "--with-api-key"], { env, cwd: root, input: `${OPENAI_KEY}\n` });
    check(login.code === 0, "codex login --with-api-key (temp CODEX_HOME)", login.stderr);
  }

  const init = await cs(["init", ...opts.agents.flatMap((a) => ["--agent", a]), "--proxy", "--yes", "--no-mcp"]);
  check(init.code === 0, `coding.sh init --proxy --agent ${opts.agents.join(" --agent ")}`, init.stderr);
  log(init.stdout.trim().split("\n").slice(-3).join("\n"));
  const proxyUrl = `http://127.0.0.1:${port}`;
  const health = await fetch(`${proxyUrl}/__codingsh/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  check(health.ok === true && health.upstreams?.anthropic === stub.url, "the proxy answers on its port with the configured upstreams", health);
  const doctor = JSON.parse((await cs(["doctor", "--json"], { quiet: true })).stdout || "{}");
  check(doctor.proxy?.running === true, "doctor: proxy running", doctor.proxy);

  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["init", "-q"], { cwd: repo, env });

  const sessions = {};
  if (opts.agents.includes("claude-code")) {
    const settings = JSON.parse(readFileSync(AGENTS["claude-code"].config(home), "utf8"));
    check(settings.env?.ANTHROPIC_BASE_URL === proxyUrl, "Claude Code settings.json: ANTHROPIC_BASE_URL is the proxy", settings.env);
    const n0 = stub.requests.length;
    const sid = randomUUID();
    const r = await run("claude", ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", AGENTS["claude-code"].model, "--session-id", sid, "create hello.txt"], { env, cwd: repo });
    check(r.code === 0, "claude -p through the proxy", r.stderr.slice(-2000));
    check(existsSync(join(repo, "hello.txt")), "claude: the stub's tool call ran (hello.txt)");
    const seen = stub.requests.slice(n0).filter((q) => /messages$/.test(q.url));
    check(seen.length >= 2 && seen.some((q) => q.stream) && seen.every((q) => q.auth === "x-api-key"), "claude: streamed calls reached the stub with the agent's key", seen);
    sessions["claude-code"] = sid;
    rmSync(join(repo, "hello.txt"), { force: true });
  }
  if (opts.agents.includes("codex")) {
    const toml = readFileSync(AGENTS.codex.config(home), "utf8");
    check(toml.includes('model_provider = "coding-sh"') && toml.includes(`base_url = "${proxyUrl}/v1"`), "Codex config.toml: the coding-sh provider points at the proxy", toml);
    const n0 = stub.requests.length;
    const r = await run("codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-s", "workspace-write", "--skip-git-repo-check", "-m", AGENTS.codex.model, "-C", repo, "create hello.txt"], { env, cwd: repo });
    check(r.code === 0, "codex exec through the proxy", r.stderr.slice(-2000));
    check(existsSync(join(repo, "hello.txt")), "codex: the stub's tool call ran (hello.txt)");
    const seen = stub.requests.slice(n0).filter((q) => /responses$/.test(q.url));
    check(seen.length >= 2 && seen.every((q) => q.stream && q.auth === "authorization"), "codex: streamed calls reached the stub with the agent's key", seen);
    const thread = /"thread_id"\s*:\s*"([^"]+)"/.exec(r.stdout)?.[1];
    check(!!thread, "codex: a thread id", r.stdout.slice(0, 500));
    sessions.codex = thread;
  }

  // Reading back. Give the background proxy a moment to flush its last call.
  await new Promise((r) => setTimeout(r, 1500));
  for (const [agent, sid] of Object.entries(sessions)) {
    if (!sid) continue;
    const tag = (w) => `${agent}: ${w}`;
    const shown = await cs(["show", sid, "--json"], { quiet: true });
    let doc = {};
    try {
      doc = JSON.parse(shown.stdout);
    } catch {}
    const s = doc.data ?? doc;
    const events = s.events ?? [];
    const proxied = events.filter((e) => e.kind === "llm.call" && e.source === "proxy");
    check((s.session?.agent ?? s.agent) === agent, tag("the hook-captured session"), { agent: s.session?.agent ?? s.agent, code: shown.code });
    check(proxied.length >= 2, tag(`proxy calls inside the session (${proxied.length})`), events.map((e) => `${e.kind}:${e.source ?? ""}`));
    check(proxied.every((e) => e.payload?.linkedBy === "header" || e.payload?.linkedBy === "metadata"), tag("linked by the agent's session id"), proxied.map((e) => e.payload?.linkedBy));
    check(proxied.every((e) => e.payload?.statusCode === 200 && e.payload?.stream === true && typeof e.payload?.ttfbMs === "number"), tag("status, stream and TTFB recorded"), proxied.map((e) => e.payload));
    check(proxied.some((e) => (e.usage?.outputTokens ?? 0) > 0), tag("usage from the stream"), proxied.map((e) => e.usage));
    const call = await cs(["show", `${sid}#-1`], { quiet: true });
    check(call.code === 0 && /^System {4}\d[\d,]* chars/m.test(call.stdout) && /^Tools {5}\d+/m.test(call.stdout), tag("show <session>#-1: the call's system prompt and tools"), call.stdout.slice(0, 1500) + call.stderr);
    log(`show ${sid}#-1:\n${call.stdout.split("\n").slice(0, 12).join("\n")}`);
    const diff = await cs(["diff-calls", `${sid}#-1`], { quiet: true });
    check(diff.code === 0 && /^Messages {2}\d+ → \d+, b extends a/m.test(diff.stdout), tag("diff-calls: the last call extends the one before"), diff.stdout + diff.stderr);
    log(`diff-calls ${sid}#-1:\n${diff.stdout}`);
  }

  // exp replay: a dry run, then a real replay against the stub (the replay uses the user's key from the env).
  const first = Object.entries(sessions).find(([, sid]) => sid);
  if (first) {
    const [agent, sid] = first;
    const vary = agent === "codex" ? "model=gpt-5,gpt-5-mini" : "model=claude-sonnet-4-5,claude-haiku-4-5";
    const dry = await cs(["exp", "replay", `${sid}#1`, "--vary", vary, "--n", "2", "--dry-run"], { quiet: true });
    check(dry.code === 0 && /model calls/.test(dry.stdout), "exp replay --dry-run", dry.stdout + dry.stderr);
    log(dry.stdout);
    const n0 = stub.requests.length;
    const rep = await cs(["exp", "replay", `${sid}#1`, "--vary", vary, "--n", "2", "--upstream", stub.url], { env: { ...env, OPENAI_API_KEY: OPENAI_KEY }, quiet: true });
    check(rep.code === 0 && stub.requests.length - n0 === 4 && /pass 100/.test(rep.stdout), "exp replay: 2 arms × 2 replays, same first action as recorded", rep.stdout + rep.stderr);
    log(rep.stdout.split("\n").slice(0, 6).join("\n"));
  }

  // Auth: no key anywhere coding.sh writes (store, blobs, spool, logs, backups).
  const stored = everyByte(csHome);
  check(stored.length > 0 && SECRETS.every((s) => !stored.includes(s)), "no API key in ~/.coding.sh");

  // Undo: configs back byte for byte, proxy stopped.
  const un = await cs(["uninstall", "--proxy", "--yes"]);
  check(un.code === 0, "coding.sh uninstall --proxy", un.stderr);
  for (const a of opts.agents) check(!readFileSync(AGENTS[a].config(home), "utf8").includes(proxyUrl), `${a}: routing removed, hooks kept`, readFileSync(AGENTS[a].config(home), "utf8"));
  const all = await cs(["uninstall", "--yes"]);
  check(all.code === 0, "coding.sh uninstall", all.stderr);
  // Codex itself records the repo as trusted (`codex exec -C repo`); that section is not coding.sh's.
  const own = (a, text) => (a === "codex" ? text.replace(/\n*\[projects\.[^\]\n]+\]\ntrust_level = "trusted"\n?/g, "\n").replace(/\n+$/, "\n") : text);
  for (const a of opts.agents) {
    const after = readFileSync(AGENTS[a].config(home), "utf8");
    check(own(a, after) === own(a, before[a]), `${a}: config byte for byte as before`, after);
  }

  // Chaining: each agent already calls a gateway (the stub plays a CLIProxyAPI). init --proxy keeps it
  // as the upstream instead of replacing it: no upstream in coding.sh's config, the proxy stopped first
  // so init starts it with the chained upstreams.
  await cs(["proxy", "stop"], { quiet: true });
  writeFileSync(join(csHome, "config.toml"), `[proxy]\nport = ${port}\n`);
  writeFileSync(AGENTS["claude-code"].config(home), `{\n  "env": { "ANTHROPIC_BASE_URL": "${stub.url}" }\n}\n`);
  writeFileSync(AGENTS.codex.config(home), `model = "gpt-5"\nmodel_provider = "cliproxy"\n\n[model_providers.cliproxy]\nname = "CLIProxyAPI"\nbase_url = "${stub.url}/v1"\nenv_key = "CLIPROXY_KEY"\nwire_api = "responses"\n`);
  const chainedBefore = Object.fromEntries(opts.agents.map((a) => [a, readFileSync(AGENTS[a].config(home), "utf8")]));
  const chainEnv = { ...env, CLIPROXY_KEY: OPENAI_KEY };
  const chain = await cs(["init", ...opts.agents.flatMap((a) => ["--agent", a]), "--proxy", "--yes", "--no-mcp"], { env: chainEnv });
  check(chain.code === 0 && /calls go on to/.test(chain.stderr), "init --proxy chains through the base URL each agent used, no --force", chain.stderr);
  const chainedHealth = await fetch(`${proxyUrl}/__codingsh/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const want = { ...(opts.agents.includes("claude-code") ? { anthropic: stub.url } : {}), ...(opts.agents.includes("codex") ? { openai: stub.url } : {}) };
  check(Object.entries(want).every(([k, v]) => chainedHealth.upstreams?.[k] === v), "the proxy's upstreams are the chained base URLs", chainedHealth);
  const chainDoctor = JSON.parse((await cs(["doctor", "--json"], { quiet: true })).stdout || "{}");
  check(opts.agents.every((a) => chainDoctor.proxy?.routes?.some((r) => r.agent === a && r.ok && r.chained)), "doctor: each agent routed, with its chained URL", chainDoctor.proxy);
  const chainedCalls = async (sid) => {
    await new Promise((r) => setTimeout(r, 1500));
    const doc = JSON.parse((await cs(["show", sid, "--json"], { quiet: true })).stdout || "{}");
    return ((doc.data ?? doc).events ?? []).filter((e) => e.kind === "llm.call" && e.source === "proxy");
  };
  if (opts.agents.includes("claude-code")) {
    const settings = JSON.parse(readFileSync(AGENTS["claude-code"].config(home), "utf8"));
    check(settings.env?.ANTHROPIC_BASE_URL === proxyUrl, "chained: Claude Code calls the proxy", settings.env);
    const sid = randomUUID();
    const r = await run("claude", ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", AGENTS["claude-code"].model, "--session-id", sid, "create hello.txt"], { env: chainEnv, cwd: repo });
    check(r.code === 0, "chained: claude -p through the proxy to the gateway", r.stderr.slice(-2000));
    const calls = await chainedCalls(sid);
    check(calls.length >= 2 && calls.every((e) => e.payload?.statusCode === 200 && e.payload?.upstream === stub.url), `chained: Claude Code calls logged and sent on to the gateway (${calls.length})`, calls.map((e) => e.payload));
    rmSync(join(repo, "hello.txt"), { force: true });
  }
  if (opts.agents.includes("codex")) {
    const toml = readFileSync(AGENTS.codex.config(home), "utf8");
    check(toml.includes('model_provider = "cliproxy"') && toml.includes(`base_url = "${proxyUrl}/v1"`) && !toml.includes("coding-sh"), "chained: Codex keeps its provider, whose base_url is now the proxy", toml);
    const r = await run("codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-s", "workspace-write", "--skip-git-repo-check", "-m", AGENTS.codex.model, "-C", repo, "create hello.txt"], { env: chainEnv, cwd: repo });
    check(r.code === 0, "chained: codex exec through the proxy to the gateway", r.stderr.slice(-2000));
    const thread = /"thread_id"\s*:\s*"([^"]+)"/.exec(r.stdout)?.[1];
    const calls = thread ? await chainedCalls(thread) : [];
    check(calls.length >= 2 && calls.every((e) => e.payload?.statusCode === 200 && e.payload?.upstream === stub.url), `chained: Codex calls logged and sent on to the gateway (${calls.length})`, calls.map((e) => e.payload));
  }
  check(SECRETS.every((s) => !everyByte(csHome).includes(s)), "chained: no API key in ~/.coding.sh");
  const unChain = await cs(["uninstall", "--yes"]);
  check(unChain.code === 0, "coding.sh uninstall after chaining", unChain.stderr);
  for (const a of opts.agents) {
    const after = readFileSync(AGENTS[a].config(home), "utf8");
    check(own(a, after) === own(a, chainedBefore[a]), `chained: ${a} config byte for byte as before, base URL back`, after);
  }
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await cs(["proxy", "stop"], { quiet: true }).catch(() => {});
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`stub requests (${stub.requests.length}): ${JSON.stringify(stub.requests.slice(-40))}`);
    const plog = join(csHome, "proxy.log");
    if (existsSync(plog)) log(`proxy log:\n${readFileSync(plog, "utf8").slice(-4000)}`);
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
