#!/usr/bin/env node
// Real Devin CLI sessions captured by coding.sh's own hooks, the way a user sets it up: `coding.sh
// init --agent devin` (user scope, with the MCP server), one session; then uninstall, `init --scope
// project`, a second session. Each session has one hook scope, so no event is written twice. Devin's
// OpenTelemetry export goes to a local receiver that keeps every log record. Output (paths scrubbed
// to /work/demo and /home/user):
//   <out>/hooks.spool.jsonl   the spool lines the coding.sh hook wrote, both sessions
//   <out>/otlp-logs.json      every OTLP log record Devin exported, as one ExportLogsServiceRequest
//
//   npm run build            (in packages/coding.sh)
//   node scripts/e2e/devin-capture.mjs --bin <path to devin> --out <dir> [--keep] [--any-version]
//
// Devin is not on npm: pass its binary with --bin (or DEVIN_BIN). The pinned version is 3000.14.30821;
// --any-version runs another one. No login is needed: over ACP (`devin acp`) a session start, a
// prompt and a session end each fire their hooks, then the prompt fails for want of a login, so the
// capture has no tool calls and no Stop. (`devin -p` without a login waits at its login picker.)
// With a login Devin finds outside this run's home (a system keychain), the prompts would run.
//
// Everything runs under a throwaway HOME, %APPDATA% and XDG folders. On Windows Devin asks the system
// for the profile folder, so it would find Claude Code's, Cursor's, ... files in the real one: every
// read_config_from import is off before Devin first runs, and the run fails if a Devin folder appears
// or changes in the real profile. Sessions run in-process (process_model), and a background Devin
// process this run started is stopped. Exit 0 when every check passed.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PIN = "3000.14.30821";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO, "packages", "coding.sh", "dist", "cli.mjs");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outArg = opt("--out");
if (!outArg) throw new Error("--out <dir> is required");
const OUT = resolve(outArg);
const binArg = opt("--bin") ?? process.env.DEVIN_BIN;
if (!binArg) throw new Error("--bin <path to devin> (or DEVIN_BIN) is required: Devin is not on npm");
const BIN = isAbsolute(binArg) || /[\\/]/.test(binArg) ? resolve(binArg) : binArg;
const keep = args.includes("--keep");
const anyVersion = args.includes("--any-version");
if (!existsSync(CLI)) throw new Error("packages/coding.sh/dist is missing: run npm run build first");

const win = process.platform === "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-devin-capture-")));
const home = join(root, "home");
const project = join(root, "demo");
const csHome = join(root, "cs-home");
const tmp = join(root, "tmp");
for (const d of [home, project, csHome, tmp]) mkdirSync(d, { recursive: true });
// The folders a real home has: Devin stops with "Failed to determine cache directory" when its cache folder is missing.
for (const d of [["AppData", "Roaming"], ["AppData", "Local"], [".config"], [".cache"], [".local", "share"], [".local", "state"]]) mkdirSync(join(home, ...d), { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
// Where Devin keeps its config with DEVIN_CONFIG_HOME unset, as for a user: %APPDATA%\devin, ~/.config/devin.
const configDir = win ? join(home, "AppData", "Roaming", "devin") : join(home, ".config", "devin");

// Nothing from this shell reaches Devin or the hook: no agent, model, OTel, git or host variables.
const env = {};
const DROP = /^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|COPILOT|GEMINI|GITHUB|GH_|OTEL_|AI_AGENT|DEVIN|WINDSURF|T3CODE|GIT_|npm_config_|NPM_CONFIG_)/i;
for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k) && !/^path$/i.test(k)) env[k] = v;
// A binary given as a path puts its folder first on PATH.
const pathDirs = [process.env.PATH ?? process.env.Path ?? ""];
if (BIN.includes("/") || BIN.includes("\\")) pathDirs.unshift(dirname(BIN));
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TMP: tmp,
  TEMP: tmp,
  TMPDIR: tmp,
  CODING_SH_HOME: csHome,
  // No background ingest racing the spool, no update check, no viewer.
  CODING_SH_NO_AUTO_INGEST: "1",
  CODING_SH_NO_UPDATE_CHECK: "1",
  CODING_SH_NO_UI: "1",
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  GEMINI_CLI_HOME: home,
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  PATH: pathDirs.join(delimiter),
});

// The real profile (Windows hands Devin this one whatever HOME says): no Devin folder may appear or change.
const REAL = userInfo().homedir;
const REAL_DIRS = ["AppData/Roaming/devin", "AppData/Local/devin", ".config/devin", ".local/share/devin", ".cache/devin", ".devin"].map((d) => join(REAL, d));
function snapshot() {
  const seen = {};
  const walk = (dir, n = { left: 5000 }) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (n.left-- <= 0) return;
      const p = join(dir, name);
      let s;
      try {
        s = lstatSync(p);
      } catch {
        continue;
      }
      seen[p] = `${s.size}:${s.mtimeMs}`;
      if (s.isDirectory()) walk(p, n);
    }
  };
  for (const d of REAL_DIRS) {
    if (!existsSync(d)) continue;
    seen[d] = "dir";
    walk(d);
  }
  return seen;
}

const failures = [];
const check = (ok, what) => {
  console.error(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};

// OTLP/HTTP receiver: keeps every JSON log record; metrics are accepted and dropped.
const resourceLogs = [];
let otlpOther = 0;
const otlp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/v1/logs") {
      try {
        resourceLogs.push(...(JSON.parse(body).resourceLogs ?? []));
      } catch {
        otlpOther++;
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((ok) => otlp.listen(0, "127.0.0.1", ok));
const otlpUrl = `http://127.0.0.1:${otlp.address().port}`;

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { env, cwd: project, encoding: "utf8", timeout: 120_000, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), stdout: r.stdout ?? "" };
};
const cli = (...argv) => run(process.execPath, ["--no-warnings", CLI, ...argv]);
const devin = (...argv) => run(BIN, argv);
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** One `devin acp` session: initialize, session/new, one prompt, then stdin closes and the session ends. */
function acpSession(prompt) {
  return new Promise((done) => {
    const child = spawn(BIN, ["acp"], { env, cwd: project, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let nextId = 1;
    const pending = new Map();
    const result = { sessionId: undefined, promptError: undefined, code: undefined, stderr: "" };
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    const call = (method, params) =>
      new Promise((ok, fail) => {
        const id = nextId++;
        pending.set(id, { ok, fail });
        send({ jsonrpc: "2.0", id, method, params });
      });
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line ? json(line) : undefined;
        if (!m) continue;
        if (m.method && m.id !== undefined) {
          // A request from Devin: allow a permission once, refuse the rest.
          const opts = m.params?.options ?? [];
          const allow = opts.find((o) => o.kind === "allow_once") ?? opts[0];
          if (m.method === "session/request_permission") send({ jsonrpc: "2.0", id: m.id, result: { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } });
          else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `capture client: no ${m.method}` } });
        } else if (m.id !== undefined && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) p.fail(Object.assign(new Error(m.error.message), { rpc: m.error }));
          else p.ok(m.result);
        }
      }
    });
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (e) => (result.promptError = `spawn: ${e.message}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      for (const p of pending.values()) p.fail(new Error("devin acp exited"));
      result.code = code;
      result.stderr = stderr.slice(-2000);
      done(result);
    });
    (async () => {
      try {
        await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "coding-sh-capture", version: "0" } });
        const s = await call("session/new", { cwd: project, mcpServers: [] });
        result.sessionId = s?.sessionId;
        await call("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: prompt }] });
      } catch (e) {
        result.promptError = `${e.message}${e.rpc ? ` ${JSON.stringify(e.rpc)}` : ""}`;
      }
      // Closing stdin ends the session (SessionEnd) and the server.
      child.stdin.end();
      setTimeout(() => child.kill(), 15_000).unref();
    })();
  });
}

function doctorRow() {
  const r = cli("doctor", "--agent", "devin", "--json");
  const doc = json(r.stdout);
  const row = (doc?.agents ?? []).find((a) => a.id === "devin");
  const warnings = (doc?.warnings ?? []).filter((w) => !w.agent || w.agent === "devin");
  for (const w of warnings) console.error(`     doctor ! ${w.check}: ${w.message}`);
  return { code: r.code, row, warnings };
}

/** The native, JSON-escaped and forward-slash forms of a path, with either case of a drive letter. */
function forms(p) {
  const out = new Set();
  for (const s of [p, p.replaceAll("\\", "\\\\"), p.replaceAll("\\", "/")]) {
    out.add(s);
    if (/^[a-z]:/i.test(s)) {
      out.add(s[0].toLowerCase() + s.slice(1));
      out.add(s[0].toUpperCase() + s.slice(1));
    }
  }
  return [...out];
}
// Most specific first: the project and homes sit under the root.
const SCRUB = [
  [project, "/work/demo"],
  [csHome, "/home/user/.coding.sh"],
  [home, "/home/user"],
  [root, "/tmp/capture"],
].flatMap(([p, to]) => forms(p).map((f) => [f, to]));
const scrub = (s) => SCRUB.reduce((acc, [from, to]) => acc.split(from).join(to), s);

const before = snapshot();
let daemonBefore;
try {
  // config.json before Devin first runs: no imports from the real profile, sessions in-process, OTel to the receiver.
  mkdirSync(configDir, { recursive: true });
  const config = {
    version: 1,
    read_config_from: { agents_standard: false, cursor: false, windsurf: false, claude: false, copilot: false, codex: false, kiro: false, opencode: false, zed: false, cloud: false },
    process_model: "in-process",
    otel: { logs_endpoint: `${otlpUrl}/v1/logs`, metrics_endpoint: `${otlpUrl}/v1/metrics`, log_export_interval_ms: 1000, metric_export_interval_ms: 1000 },
  };
  writeFileSync(join(configDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  execFileSync("git", ["init", "-q"], { env, cwd: project });

  const version = devin("--version");
  console.error(`devin --version: ${version.out}`);
  if (!check(version.code === 0, "devin --version runs")) throw new Error(version.out);
  if (!anyVersion && !check(version.out.includes(PIN), `devin is ${PIN} (--any-version runs another)`)) throw new Error(`devin is not ${PIN}`);
  daemonBefore = devin("daemon", "status").out;

  // Session 1: hooks in the user config, MCP server registered.
  const init1 = cli("init", "--agent", "devin", "--yes", "--no-import");
  console.error(init1.out);
  check(init1.code === 0, "init --agent devin (user scope)");
  const d1 = doctorRow();
  check(d1.row?.hooked === true && !(d1.row?.blockers ?? []).length, "doctor: Devin hooked in the user config, nothing blocks its hooks");
  const mcp = devin("mcp", "list");
  console.error(mcp.out);
  check(/coding-sh/.test(mcp.out), "devin mcp list shows coding-sh");
  const s1 = await acpSession("write hello.txt");
  console.error(`session 1: ${s1.sessionId} exit ${s1.code}${s1.promptError ? `; prompt: ${s1.promptError}` : ""}`);
  check(!!s1.sessionId, "session 1 started");

  // Session 2: hooks in the project's .devin/config.local.json only.
  const un = cli("uninstall", "--agent", "devin", "--yes");
  console.error(un.out);
  check(un.code === 0, "uninstall --agent devin (user scope)");
  const kept = json(readFileSync(join(configDir, "config.json"), "utf8")) ?? {};
  check(kept.hooks === undefined && kept.process_model === "in-process" && kept.otel?.logs_endpoint === config.otel.logs_endpoint, "uninstall removed the hooks and kept the rest of config.json");
  const mcpAfter = existsSync(join(configDir, "mcp_config.json")) ? readFileSync(join(configDir, "mcp_config.json"), "utf8") : "";
  check(!/coding-sh/.test(mcpAfter), "uninstall removed the MCP entry");
  const init2 = cli("init", "--agent", "devin", "--scope", "project", "--yes", "--no-import");
  console.error(init2.out);
  check(init2.code === 0 && existsSync(join(project, ".devin", "config.local.json")), "init --scope project wrote .devin/config.local.json");
  const d2 = doctorRow();
  check((d2.row?.projectHooks ?? []).length > 0 || (d2.row?.hookFiles ?? []).some((f) => f.scope !== "user"), "doctor: Devin hooked in the project");
  const s2 = await acpSession("list the files here");
  console.error(`session 2: ${s2.sessionId} exit ${s2.code}${s2.promptError ? `; prompt: ${s2.promptError}` : ""}`);
  check(!!s2.sessionId && s2.sessionId !== s1.sessionId, "session 2 started, a new session");
  const un2 = cli("uninstall", "--agent", "devin", "--scope", "project", "--yes");
  check(un2.code === 0 && !existsSync(join(project, ".devin", "config.local.json")), "uninstall --scope project removed the file it made");

  // OTel batches every second and on exit.
  await new Promise((ok) => setTimeout(ok, 2500));
  // A background Devin process this run started is stopped; one that ran before is not ours to touch.
  const daemonAfter = devin("daemon", "status").out;
  console.error(`devin daemon status: ${daemonAfter}`);
  if (/no devin daemon/i.test(daemonBefore) && !/no devin daemon/i.test(daemonAfter)) {
    devin("daemon", "stop");
    check(false, "no background Devin process (process_model in-process)");
  }

  // The spool: Devin's lines only. A claude-code folder would mean Devin's run of Claude Code's hooks got through.
  const spoolRoot = join(csHome, "spool");
  const others = existsSync(spoolRoot) ? readdirSync(spoolRoot).filter((n) => n !== "devin" && statSync(join(spoolRoot, n)).isDirectory()) : [];
  check(!others.length, `no other agent's spool${others.length ? ` (found ${others.join(", ")})` : ""}`);
  const errors = join(spoolRoot, "errors.log");
  if (existsSync(errors)) console.error(readFileSync(errors, "utf8"));
  check(!existsSync(errors), "no spool errors");
  const dir = join(spoolRoot, "devin");
  const text = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => readFileSync(join(dir, f), "utf8"))
        .join("")
    : "";
  const lines = text.split("\n").filter(Boolean).map(json).filter(Boolean);
  const bySession = new Map();
  for (const l of lines) bySession.set(l.raw?.session_id, [...(bySession.get(l.raw?.session_id) ?? []), l.raw?.hook_event_name]);
  for (const [sid, events] of bySession) console.error(`     ${sid}: ${events.join(", ")}`);
  check(bySession.size === 2 && [...bySession.values()].every((e) => e.includes("SessionStart") && e.includes("UserPromptSubmit") && e.includes("SessionEnd")), "two sessions in the spool, each with SessionStart, UserPromptSubmit and SessionEnd");
  const payloads = lines.map((l) => JSON.stringify(l.raw));
  check(new Set(payloads).size === payloads.length, "no hook call written twice");
  check(lines.every((l) => l.agent === "devin" && !l.host && !l.spawnedBy && !l.gateway), "every line is Devin's, with no host, spawnedBy or gateway");

  const records = resourceLogs.flatMap((r) => r.scopeLogs ?? []).flatMap((s) => s.logRecords ?? []);
  const names = records.map((r) => r.attributes?.find((a) => a.key === "event.name")?.value?.stringValue);
  console.error(`     OTel log records: ${names.join(", ")}${otlpOther ? `; ${otlpOther} unreadable` : ""}`);
  check(names.filter((n) => n === "user_prompt").length === 2, "OTel: one user_prompt per session");

  // Scrub, then look for anything of this machine left.
  for (const rl of resourceLogs) {
    for (const a of rl.resource?.attributes ?? []) if (a.key === "os.version" || a.key === "host.timezone") a.value = { stringValue: "scrubbed" };
  }
  const spoolOut = scrub(text);
  const otlpOut = scrub(`${JSON.stringify({ resourceLogs }, null, 2)}\n`);
  const leaks = [REAL, userInfo().username, root, REPO, dirname(BIN), "T3CODE"].flatMap((s) => forms(s)).filter((s) => s.length > 2 && (spoolOut.includes(s) || otlpOut.includes(s)));
  const emails = `${spoolOut}${otlpOut}`.match(/[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/gi) ?? [];
  leaks.push(...emails.filter((m) => m !== "e2e@coding.sh.invalid"));
  check(!leaks.length, `nothing of this machine in the output${leaks.length ? ` (found ${[...new Set(leaks)].join(", ")})` : ""}`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "hooks.spool.jsonl"), spoolOut);
  writeFileSync(join(OUT, "otlp-logs.json"), otlpOut);

  // coding.sh reads what it captured: two Devin sessions.
  const ingest = cli("ingest");
  check(ingest.code === 0, "coding.sh ingest");
  const listed = json(cli("sessions", "--agent", "devin", "--empty", "--json").stdout);
  const sessions = Array.isArray(listed) ? listed : (listed?.sessions ?? []);
  for (const s of sessions) console.error(`     session ${s.id}: agent ${s.agent}, ${s.stats?.turns ?? 0} turn(s), title ${JSON.stringify(s.title ?? "")}`);
  check(sessions.length === 2 && sessions.every((s) => s.agent === "devin" && s.stats?.turns === 1), "coding.sh sessions lists the two Devin sessions, one turn each");
  console.error(`${lines.length} hook line(s), ${records.length} OTel log record(s) in ${OUT}`);
} catch (e) {
  check(false, `capture ran: ${e.message}`);
} finally {
  await new Promise((ok) => otlp.close(ok));
  const after = snapshot();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
  check(!changed.length, `no Devin folder in the real profile appeared or changed${changed.length ? ` (${changed.slice(0, 5).map((p) => relative(REAL, p)).join(", ")})` : ""}`);
  if (keep) cpSync(root, join(OUT, "_root"), { recursive: true });
  rmSync(root, { recursive: true, force: true });
  console.error(failures.length ? `${failures.length} check(s) failed` : "every check passed");
  process.exitCode = failures.length ? 1 : 0;
}
