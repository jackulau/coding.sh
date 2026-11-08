#!/usr/bin/env node
// Ease benchmark: how easy is coding.sh to set up, for a person and for an AI agent?
// Two paths from nothing to a captured session, each under a throwaway HOME, npm prefix
// and npm cache. Nothing reads or writes the real ~/.claude, ~/.codex or ~/.coding.sh.
//
// HUMAN: the installer one-liner in a pseudo-terminal, answering each Y/n
// prompt with Enter as it appears, then one Claude Code session, then the viewer.
//   prompts          Y/n questions asked (goal: 1)
//   flags            options a person had to type (goal: 0)
//   steps            things a person does: run the one-liner, start an agent session
//   installMs        installer wall time, init included (local tarball: no network)
//   visibleMs        from the session's last hook to the session in the viewer's API,
//                    with no command typed in between
//   emptyStates      after init, before the first session: how many of the empty
//                    states (show latest, status, sessions, viewer, MCP status) name the
//                    right next step. Sending the user back to `coding.sh init`, which
//                    changes nothing at that point, counts as wrong.
//
// AGENT: given only /agents.md (read from the site source, or --agents-md <file|url>),
// run the commands it lists, in order, in a shell with no terminal. Each check is
// pass/fail; setupSuccess needs install, hook, verify, capture, read back and MCP.
//   install    the doc's non-interactive installer line exits 0, coding.sh on PATH
//   hook       the doc's `init` lines exit 0 and Claude Code's settings hold the hook
//   verify     `doctor --json` is one JSON document, ok: true, claude-code hooked
//   errors     before the first session, `show latest --json` fails with one JSON line
//              on stderr (status, reason, message, next) whose command is not init
//   capture    a Claude Code session runs the hooks init installed; they exit 0 silently
//              and write to the spool
//   readBack   the doc's `show latest --json` and `sessions --since 1d --json` return it
//   mcp        the MCP server from Claude Code's config lists tools and returns it
//   commands   every `coding.sh <command>` the doc names answers --help
//
// The session: by default, the hook payloads a pinned Claude Code recorded against the
// stub model (test/fixtures/adapters/claude-code/hooks.spool.jsonl), each piped to the
// exact command init wrote into ~/.claude/settings.json, as Claude Code does. --real
// installs Claude Code 2.1.319 from npm and runs `claude -p` against scripts/e2e/stub-model.mjs
// (network for npm). Detection uses a `claude` stub on PATH unless --real.
//
//   node scripts/e2e/ease.mjs [--pkg <packages/coding.sh dir with dist built>] [--install-sh <path>]
//                             [--agents-md <file|url>] [--real] [--json] [--keep]
//
// Needs python3 (its pty module) for the human path's terminal; without it that path is skipped.
// Exit 0 when the agent's setupSuccess holds and the human saw the session; 1 otherwise.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLAUDE_PKG = "@anthropic-ai/claude-code@2.1.319";
const FIXTURE = join(REPO, "packages/coding.sh/test/fixtures/adapters/claude-code/hooks.spool.jsonl");
const FIXTURE_SESSION = "11111111-2222-4333-8444-555555555555";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PKG = resolve(opt("--pkg", join(REPO, "packages/coding.sh")));
const INSTALL_SH = resolve(opt("--install-sh", join(REPO, "install.sh")));
const AGENTS_MD = opt("--agents-md", join(REPO, "apps/site/src/lib/agent-docs.ts"));
const REAL = argv.includes("--real");
const JSON_OUT = argv.includes("--json");
const KEEP = argv.includes("--keep");
const log = (...a) => JSON_OUT || console.error(...a);

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-ease-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A throwaway machine: HOME, npm prefix and cache, and a PATH with node, the prefix and (unless --real) a `claude` stub. */
function machine(name) {
  const base = join(root, name);
  const home = join(base, "home");
  const prefix = join(base, "prefix");
  const fakeBin = join(base, "fakebin");
  for (const d of [home, prefix, fakeBin, join(home, ".claude")]) mkdirSync(d, { recursive: true });
  if (!REAL) {
    writeFileSync(join(fakeBin, "claude"), '#!/bin/sh\necho "2.1.319 (Claude Code)"\n');
    chmodSync(join(fakeBin, "claude"), 0o755);
  }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|CURSOR|OPENCODE|npm_config_|NPM_CONFIG_|CI$|NO_COLOR|FORCE_COLOR)/i.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    PATH: [join(prefix, "bin"), fakeBin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    npm_config_prefix: prefix,
    npm_config_cache: join(base, "npm-cache"),
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  });
  return { base, home, prefix, env, cli: join(prefix, "bin", "coding.sh") };
}

function run(m, cmd, args, opts = {}) {
  const t = performance.now();
  const r = spawnSync(cmd, args, { env: { ...m.env, ...opts.env }, cwd: opts.cwd ?? m.home, encoding: "utf8", timeout: opts.timeout ?? 120_000, input: opts.input ?? "" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: performance.now() - t };
}
const sh = (m, line, opts) => run(m, "sh", ["-c", line], opts);

/** Pipes each recorded hook payload to the command init wrote for that event, the way Claude Code runs hooks. */
function replayHooks(m) {
  const settings = JSON.parse(readFileSync(join(m.home, ".claude", "settings.json"), "utf8"));
  const lines = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const out = { fired: 0, failed: 0, printed: 0 };
  for (const l of lines) {
    const command = (settings.hooks?.[l.event] ?? []).flatMap((x) => x.hooks ?? []).find((h) => h._codingsh)?.command;
    if (!command) {
      out.failed++;
      continue;
    }
    const r = sh(m, command, { input: JSON.stringify(l.raw), timeout: 15_000 });
    out.fired++;
    if (r.code !== 0) out.failed++;
    if (r.stdout.trim()) out.printed++;
  }
  return out;
}

/** --real: one `claude -p` session against the stub model (async: the stub answers from this process). */
async function realSession(m) {
  const { startStub } = await import("./stub-model.mjs");
  const stub = await startStub();
  const project = join(m.base, "demo");
  mkdirSync(project, { recursive: true });
  const env = { ...m.env, ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-stub", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" };
  try {
    const code = await new Promise((done) => {
      const child = spawn("claude", ["-p", "create hello.txt", "--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-5"], { env, cwd: project, stdio: ["ignore", "ignore", "ignore"] });
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on("exit", (c) => (clearTimeout(timer), done(c)));
      child.on("error", () => done(-1));
    });
    return { fired: code === 0 ? 1 : 0, failed: code === 0 ? 0 : 1, printed: 0 };
  } finally {
    await stub.close?.();
  }
}

/** --real: Claude Code is installed before coding.sh, as on a user's machine, so init finds it. */
function installAgent(m) {
  if (!REAL) return;
  const r = run(m, "npm", ["install", "-g", "--no-fund", "--no-audit", CLAUDE_PKG], { timeout: 300_000 });
  if (r.code !== 0) throw new Error(`npm install ${CLAUDE_PKG} failed: ${r.stderr.slice(-400)}`);
}

async function oneSession(m) {
  return REAL ? realSession(m) : replayHooks(m);
}

/** The newest top-level session id, read the way the doc says (`show latest --json`). */
function latestId(m) {
  const r = run(m, m.cli, ["show", "latest", "--json"]);
  try {
    return JSON.parse(r.stdout).session?.id ?? JSON.parse(r.stdout).id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- MCP

/** Starts the MCP server Claude Code would start (from ~/.claude.json) and runs `steps` against it. */
async function withMcp(m, steps) {
  const cfg = JSON.parse(readFileSync(join(m.home, ".claude.json"), "utf8")).mcpServers?.["coding-sh"];
  if (!cfg) throw new Error("no coding-sh entry in ~/.claude.json");
  const child = spawn(cfg.command, cfg.args ?? [], { env: { ...m.env, ...(cfg.env ?? {}) }, cwd: m.home, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        waiters.get(msg.id)?.(msg);
      } catch {}
    }
  });
  let id = 0;
  const request = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id;
      const timer = setTimeout(() => fail(new Error(`MCP ${method} timed out`)), 20_000);
      waiters.set(n, (msg) => (clearTimeout(timer), ok(msg)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ease", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await steps(request);
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------- empty states

/** After init, before any session: which empty states name the right next step (not init, which changes nothing now). */
async function emptyStates(m, viewer) {
  const wrong = (text) => /coding\.sh init\b/.test(text) && !/Capture is set up|start a new/i.test(text);
  const out = {};
  const show = run(m, m.cli, ["show", "latest", "--json"]);
  let next = [];
  try {
    next = JSON.parse(show.stderr.trim().split("\n").at(-1)).next ?? [];
  } catch {}
  out.showLatest = next.length > 0 && !wrong(next.join(" "));
  const status = run(m, m.cli, ["status"]);
  out.status = /coding\.sh \w/.test(status.stderr) && !wrong(status.stderr);
  const sessions = run(m, m.cli, ["sessions"]);
  out.sessions = /coding\.sh \w/.test(sessions.stderr) && !wrong(sessions.stderr);
  // The viewer's empty list reads /api/ingest: captureSetUp switches it from "run init" to "start a new session".
  out.viewer = viewer ? (await viewer.api("/api/ingest")).captureSetUp === true : false;
  out.mcpStatus = await withMcp(m, async (req) => {
    const r = await req("tools/call", { name: "status", arguments: {} });
    const hints = r.result?.structuredContent?.hints ?? [];
    return hints.length > 0 && !wrong(hints.join(" "));
  }).catch(() => false);
  return out;
}

// ---------------------------------------------------------------- viewer

async function startViewer(m) {
  const child = spawn(m.cli, ["ui", "--port", "0", "--no-open"], { env: m.env, cwd: m.home, stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => (text += d));
  for (let i = 0; i < 300 && !/^http/m.test(text); i++) await sleep(50);
  const url = new URL(text.trim().split("\n")[0]);
  const auth = { authorization: `Bearer ${url.searchParams.get("t")}` };
  return {
    api: async (path) => (await fetch(new URL(path, url), { headers: auth })).json(),
    close: () => child.kill(),
  };
}

// ---------------------------------------------------------------- the paths

function pack() {
  if (!existsSync(join(PKG, "dist", "cli.mjs"))) throw new Error(`${PKG}/dist/cli.mjs is missing: run npm run build there first`);
  const dest = join(root, "pack");
  mkdirSync(dest);
  execFileSync("npm", ["pack", "--silent", "--pack-destination", dest], { cwd: PKG, stdio: ["ignore", "pipe", "pipe"] });
  return join(dest, readdirSync(dest).find((f) => f.endsWith(".tgz")));
}

// A pseudo-terminal for the installer, as `curl … | sh` in a person's shell has (the
// installer and init talk to /dev/tty). Python's pty module: Node has no pty without a
// native addon, and script(1) refuses a socket for stdin on macOS. Output is relayed to
// stdout; what we write to stdin goes to the terminal.
const PTY_PY = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
watch = [fd, 0]
while True:
    r, _, _ = select.select(watch, [], [])
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        d = os.read(0, 1024)
        if d:
            os.write(fd, d)
        else:
            watch = [fd]
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

async function human(tarball) {
  const m = machine("human");
  installAgent(m);
  if (process.platform === "win32" || spawnSync("python3", ["-c", "import pty"]).status !== 0) return { skipped: "needs python3 with pty (macOS, Linux)" };
  const ptyPy = join(root, "pty.py");
  writeFileSync(ptyPy, PTY_PY);
  const args = ["-I", ptyPy, "sh", INSTALL_SH];
  // The viewer is a server that never exits: the bench starts it itself after the installer.
  const env = { ...m.env, CODING_SH_TARBALL: tarball, CODING_SH_NO_UI: "1" };
  const t = performance.now();
  let transcript = "";
  let prompts = 0;
  const code = await new Promise((done) => {
    const child = spawn("python3", args, { env, cwd: m.home, stdio: ["pipe", "pipe", "pipe"] });
    const onData = (d) => {
      transcript += d;
      // Answer each new question with Enter (the default).
      const asked = (transcript.match(/\((?:Y\/n|y\/N)\)/g) ?? []).length;
      while (prompts < asked) {
        prompts++;
        child.stdin.write("\n");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("exit", (c) => (clearTimeout(timer), done(c)));
  });
  const installMs = performance.now() - t;
  const installed = code === 0 && existsSync(m.cli);
  const result = { installed, exit: code, prompts, flags: 0, steps: 2, installMs: Math.round(installMs) };
  if (!installed) return { ...result, transcript: transcript.slice(-2000) };
  const viewer = await startViewer(m);
  try {
    result.emptyStates = await emptyStates(m, viewer);
    const s = await oneSession(m);
    const end = performance.now();
    let seen = false;
    while (!seen && performance.now() - end < 30_000) {
      seen = ((await viewer.api("/api/sessions?limit=5")).items ?? []).length > 0;
      if (!seen) await sleep(100);
    }
    result.capture = s;
    result.visible = seen;
    result.visibleMs = seen ? Math.round(performance.now() - end) : null;
  } finally {
    viewer.close();
  }
  return result;
}

/** agents.md as text (from the site source: unescape the template literal). */
async function agentsMdText() {
  if (/^https?:/.test(AGENTS_MD)) return (await fetch(AGENTS_MD)).text();
  return readFileSync(AGENTS_MD, "utf8").replace(/\\`/g, "`").replace(/\\\\/g, "\\");
}
function shBlocks(md) {
  return [...md.matchAll(/```sh\n([\s\S]*?)```/g)].map((x) =>
    x[1]
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .map((l) => l.replace(/\s+#.*$/, "").trim())
      .filter(Boolean),
  );
}

async function agent(tarball) {
  const m = machine("agent");
  installAgent(m);
  const md = await agentsMdText();
  // Commands in sh blocks, then commands quoted inline in the prose (`coding.sh sessions --since 1d --json`).
  const inline = [...md.matchAll(/`(coding\.sh [^`]+)`/g)].map((x) => x[1].trim());
  const lines = [...shBlocks(md).flat(), ...inline];
  const checks = {};
  const detail = {};
  // 1. Install: the doc's non-interactive line, with the download swapped for this checkout's installer and tarball.
  const installLine = lines.find((l) => /coding\.sh\/install/.test(l) && /CODING_SH_YES=1/.test(l));
  if (!installLine) {
    checks.install = false;
    detail.install = "agents.md has no non-interactive install line (CODING_SH_YES=1)";
  } else {
    const local = installLine.replace(/curl -fsSL https:\/\/coding\.sh\/install \|/, `cat '${INSTALL_SH}' |`);
    const r = sh(m, local, { env: { CODING_SH_TARBALL: tarball } });
    checks.install = r.code === 0 && run(m, m.cli, ["--version"]).code === 0;
    detail.install = { exit: r.code, ms: Math.round(r.ms), ...(r.code ? { stderr: r.stderr.slice(-600) } : {}) };
  }
  const cs = (l) => l.startsWith("coding.sh ");
  const runDoc = (l) => run(m, m.cli, l.slice("coding.sh ".length).split(/\s+/));
  // 2. Hook: the doc's init lines, in order.
  const inits = lines.filter((l) => cs(l) && /^coding\.sh init\b/.test(l));
  const initRuns = inits.map((l) => ({ line: l, code: runDoc(l).code }));
  const settings = join(m.home, ".claude", "settings.json");
  checks.hook = inits.length > 0 && initRuns.every((r) => r.code === 0) && existsSync(settings) && /_codingsh/.test(readFileSync(settings, "utf8"));
  detail.hook = initRuns;
  // 3. Verify.
  const doctorLine = lines.find((l) => /^coding\.sh doctor\b.*--json/.test(l));
  if (doctorLine) {
    const d = runDoc(doctorLine);
    try {
      const j = JSON.parse(d.stdout);
      checks.verify = j.ok === true && j.agents?.find((a) => a.id === "claude-code")?.hooked === true;
      detail.verify = { exit: d.code, ok: j.ok };
    } catch {
      checks.verify = false;
      detail.verify = { exit: d.code, stdout: d.stdout.slice(0, 200) };
    }
  } else checks.verify = false;
  // Error contract before the first session.
  const showLine = lines.find((l) => /^coding\.sh show latest\b.*--json/.test(l)) ?? "coding.sh show latest --json";
  const before = runDoc(showLine);
  try {
    const errLines = before.stderr.trim().split("\n");
    const e = JSON.parse(errLines.at(-1));
    const cmd = (e.next ?? []).at(-1) ?? "";
    checks.errors = before.code === 1 && errLines.length === 1 && e.status === "error" && typeof e.reason === "string" && typeof e.message === "string" && /^coding\.sh \w/.test(cmd) && cmd !== "coding.sh init";
    detail.errors = { exit: before.code, reason: e.reason, next: e.next };
  } catch {
    checks.errors = false;
    detail.errors = { exit: before.code, stderr: before.stderr.slice(0, 300) };
  }
  // 4. Capture.
  let cap = { fired: 0, failed: 1, printed: 0 };
  try {
    cap = await oneSession(m);
  } catch (e) {
    detail.captureError = String(e);
  }
  // The hooks wrote to the spool (not only a transcript import): live capture works.
  const spool = join(m.env.CODING_SH_HOME, "spool", "claude-code");
  const spooled = existsSync(spool) && readdirSync(spool).some((f) => f.endsWith(".jsonl"));
  checks.capture = cap.fired > 0 && cap.failed === 0 && cap.printed === 0 && spooled;
  detail.capture = { ...cap, spooled };
  // 5. Read back, with the doc's commands.
  const id = latestId(m);
  const listLine = lines.find((l) => /^coding\.sh sessions\b.*--json/.test(l));
  let listed = false;
  if (listLine) {
    try {
      listed = JSON.parse(runDoc(listLine).stdout).sessions.some((s) => s.id === id);
    } catch {}
  }
  checks.readBack = !!id && (REAL || id === FIXTURE_SESSION) && listed;
  detail.readBack = { id: id ?? null, listed };
  // 6. MCP, from the agent's own config.
  try {
    const r = await withMcp(m, async (req) => {
      const tools = (await req("tools/list")).result?.tools?.map((t) => t.name) ?? [];
      const list = await req("tools/call", { name: "sessions_list", arguments: {} });
      const ids = (list.result?.structuredContent?.sessions ?? []).map((s) => s.id);
      return { tools: tools.length, found: !!id && ids.includes(id) };
    });
    checks.mcp = r.tools > 0 && r.found;
    detail.mcp = r;
  } catch (e) {
    checks.mcp = false;
    detail.mcp = String(e);
  }
  // Every command the doc names exists.
  const named = [...new Set(lines.filter(cs).map((l) => l.split(/\s+/)[1]).filter((w) => /^[a-z][\w-]*$/.test(w)))];
  const missing = named.filter((w) => run(m, m.cli, [w, "--help"]).code !== 0);
  checks.commands = missing.length === 0;
  detail.commands = { named: named.length, missing };
  const core = ["install", "hook", "verify", "capture", "readBack", "mcp"];
  const passed = Object.values(checks).filter(Boolean).length;
  return { setupSuccess: core.every((k) => checks[k]), passed, total: Object.keys(checks).length, checks, detail };
}

// ---------------------------------------------------------------- main

let exit = 1;
try {
  log(`ease: packing ${PKG}`);
  const tarball = pack();
  log("ease: human path (installer in a terminal)");
  const h = await human(tarball);
  log("ease: agent path (agents.md, no terminal)");
  const a = await agent(tarball);
  const report = { pkg: PKG, installSh: INSTALL_SH, agentsMd: AGENTS_MD, session: REAL ? `claude -p (${CLAUDE_PKG}) against the stub model` : "recorded Claude Code hook payloads through the installed hooks", node: process.version, platform: `${process.platform}-${process.arch}`, human: h, agent: a };
  if (h.emptyStates) h.emptyStatesRight = `${Object.values(h.emptyStates).filter(Boolean).length}/${Object.keys(h.emptyStates).length}`;
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else {
    const row = (k, v) => console.log(`  ${k.padEnd(16)}${v}`);
    console.log("HUMAN  curl … | sh → init → a session in the viewer");
    if (h.skipped) row("skipped", h.skipped);
    else {
      row("installed", h.installed);
      row("prompts", h.prompts);
      row("flags", h.flags);
      row("steps", h.steps);
      row("install", `${(h.installMs / 1000).toFixed(1)} s (local tarball, init included)`);
      row("visible", h.visible ? `${h.visibleMs} ms after the session, nothing typed` : "no");
      row("empty states", `${h.emptyStatesRight} name the right next step ${JSON.stringify(h.emptyStates)}`);
    }
    console.log("AGENT  agents.md, no terminal");
    row("setupSuccess", a.setupSuccess);
    row("checks", `${a.passed}/${a.total}`);
    for (const [k, v] of Object.entries(a.checks)) row(`  ${k}`, v ? "pass" : `FAIL ${JSON.stringify(a.detail[k] ?? "")}`);
  }
  exit = a.setupSuccess && (h.skipped || h.visible) ? 0 : 1;
} catch (e) {
  console.error(`ease: ${e instanceof Error ? e.stack : e}`);
} finally {
  if (KEEP) console.error(`ease: kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
process.exit(exit);
