#!/usr/bin/env node
// Long-session scale bench: generate a synthetic 12-hour Claude Code session
// (packages/coding.sh/test/fixtures/longrun/generate.ts) under a throwaway HOME,
// ingest it both ways (transcript backfill, hook spool), then time what a user
// does with it: show, show --all, sessions, search, the viewer API, MCP reads,
// and a live hook ingest once the session is already huge. Prints one JSON
// object of numbers (ms, bytes, counts) on stdout; --budgets checks them.
//
//   node scripts/perf/longrun.mjs [--hours 12] [--scale 1] [--keep <dir>] [--budgets scripts/perf/longrun-budgets.json]
//
// Run it on the desk (docs/perf.md): `DESK_DIR=wt-longrun .claude/bin/desk run "node scripts/perf/longrun.mjs"`.
// Exit code: 0, or 1 when a budget is exceeded or a step fails.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG = join(ROOT, "packages/coding.sh");
const CLI = join(PKG, "src/cli/main.ts");
const { values } = parseArgs({ options: { hours: { type: "string", default: "12" }, scale: { type: "string", default: "1" }, keep: { type: "string" }, budgets: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.error("usage: node scripts/perf/longrun.mjs [--hours 12] [--scale 1] [--keep <dir>] [--budgets file]");
  process.exit(0);
}

const { generateLongSession } = await import(join(PKG, "test/fixtures/longrun/generate.ts"));
const work = values.keep ? resolve(values.keep) : mkdtempSync(join(tmpdir(), "csh-longrun-"));
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const m = generateLongSession({ out: join(work, "fixture"), hours: Number(values.hours), scale: Number(values.scale) });
const out = { sessionEvents: 0, toolCalls: m.toolCalls, compactions: m.compactions, subagents: m.subagents };
const notes = [];

function envFor(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: m.files.claudeConfigDir, CODEX_HOME: m.files.codexHome, CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1", TZ: "UTC" };
}
function cli(env, args, input) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, input });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 0) throw new Error(`coding.sh ${args.join(" ")} exited ${r.status}: ${r.stderr.slice(0, 2000)}`);
  return { ms, stdout: r.stdout, stderr: r.stderr };
}
/** Median of n runs of a CLI call (the first run warms the page cache). */
function timed(env, args, n = 3) {
  const runs = [];
  let last;
  for (let i = 0; i < n; i++) {
    last = cli(env, args);
    runs.push(last.ms);
  }
  runs.sort((a, b) => a - b);
  return { ms: runs[Math.floor(n / 2)], stdout: last.stdout };
}

// ---- 1. transcript backfill (claude-code + codex)
const homeA = join(work, "home-backfill");
mkdirSync(homeA, { recursive: true });
const envA = envFor(homeA);
out.ingest_backfill_ms = cli(envA, ["ingest", "--backfill", "--agent", "claude-code", "--agent", "codex"]).ms;
const sess = JSON.parse(cli(envA, ["sessions", "--json", "--limit", "50", "--subagents"]).stdout).sessions;
const main = sess.find((s) => s.id === m.sessionId);
if (!main) throw new Error(`session ${m.sessionId} not found after backfill`);
out.sessionEvents = main.stats.events;
out.sessions = sess.length;
out.index_bytes = statSync(join(homeA, ".coding.sh", "index.db")).size;

// ---- 2. hook spool ingest (what live capture stores), in one go
const homeB = join(work, "home-spool");
mkdirSync(join(homeB, ".coding.sh"), { recursive: true });
cpSync(m.files.spoolDir, join(homeB, ".coding.sh", "spool"), { recursive: true });
const envB = envFor(homeB);
out.ingest_spool_ms = cli(envB, ["ingest", "--agent", "claude-code"]).ms;

// ---- 3. live: the session is already huge and the hook appends a few lines (one tool call) per ingest
{
  const home = join(work, "home-live");
  mkdirSync(join(home, ".coding.sh", "spool", "claude-code"), { recursive: true });
  const env = envFor(home);
  const files = readdirSync(join(m.files.spoolDir, "claude-code")).sort();
  const lines = files.flatMap((f) => readFileSync(join(m.files.spoolDir, "claude-code", f), "utf8").split("\n").filter(Boolean));
  const tail = lines.splice(lines.length - 40);
  const target = join(home, ".coding.sh", "spool", "claude-code", files.at(-1));
  writeFileSync(target, lines.join("\n") + "\n");
  cli(env, ["ingest", "--agent", "claude-code"]);
  const ticks = [];
  for (let i = 0; i < tail.length; i += 4) {
    appendFileSync(target, tail.slice(i, i + 4).join("\n") + "\n");
    ticks.push(cli(env, ["ingest", "--agent", "claude-code"]).ms);
  }
  ticks.sort((a, b) => a - b);
  out.live_ingest_tick_p50_ms = ticks[Math.floor(ticks.length / 2)];
  out.live_ingest_tick_max_ms = ticks.at(-1);
}

// ---- 4. reads on the backfilled index
const sid = m.sessionId;
const show = timed(envA, ["show", sid]);
out.show_ms = show.ms;
out.show_lines = show.stdout.split("\n").length;
const optional = (key, f) => {
  try {
    f();
  } catch (e) {
    notes.push(`${key}: ${e.message.split("\n")[0]}`);
  }
};
optional("show --all", () => {
  const showAll = timed(envA, ["show", sid, "--all"], 1);
  out.show_all_ms = showAll.ms;
  out.show_all_lines = showAll.stdout.split("\n").length;
});
out.show_json_ms = timed(envA, ["show", sid, "--json"], 1).ms;
out.sessions_ms = timed(envA, ["sessions"]).ms;
optional("sessions --flag", () => (out.sessions_flag_ms = timed(envA, ["sessions", "--flag", "looping"]).ms));
out.search_rare_ms = timed(envA, ["search", "resolveRoute"]).ms;
out.search_common_ms = timed(envA, ["search", "cache"]).ms;

// ---- 5. viewer API (what the session page fetches)
await withServer(envA, async ({ url: base, token }) => {
  const get = async (path) => {
    const t0 = performance.now();
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    const body = await r.arrayBuffer();
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
    return { ms: Math.round(performance.now() - t0), bytes: body.byteLength, json: () => JSON.parse(Buffer.from(body).toString("utf8")) };
  };
  await get("/api/sessions?limit=50");
  const enc = encodeURIComponent(sid);
  out.api_session_ms = (await get(`/api/sessions/${enc}`)).ms;
  const first = await get(`/api/sessions/${enc}/events?limit=5000`);
  out.api_events_first_page_ms = first.ms;
  out.api_events_first_page_bytes = first.bytes;
  let all = 0;
  let bytes = 0;
  let pages = 0;
  // What the session page does: the first 5000 on screen, then the rest in pages of 20000 behind it.
  for (let off = 0; ; ) {
    const limit = off ? 20000 : 5000;
    const p = await get(`/api/sessions/${enc}/events?limit=${limit}&offset=${off}`);
    all += p.ms;
    bytes += p.bytes;
    pages++;
    off += limit;
    if (!p.json().hasMore) break;
  }
  out.api_events_all_ms = all;
  out.api_events_all_bytes = bytes;
  out.api_events_pages = pages;
  try {
    const o = await get(`/api/sessions/${enc}/outline`);
    out.api_outline_ms = o.ms;
    out.api_outline_bytes = o.bytes;
  } catch (e) {
    notes.push(`no outline route: ${e.message}`);
  }
});

// ---- 6. MCP reads over stdio
await mcpReads(envA, sid);

const result = { hours: Number(values.hours), scale: Number(values.scale), node: process.version, ...out, notes };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
let failed = false;
if (values.budgets) {
  const budgets = JSON.parse(readFileSync(resolve(values.budgets), "utf8"));
  for (const [k, max] of Object.entries(budgets)) {
    if (k.startsWith("$")) continue;
    if (typeof result[k] !== "number") continue;
    if (result[k] > max) {
      console.error(`over budget: ${k} = ${result[k]} > ${max}`);
      failed = true;
    }
  }
}
if (!values.keep) rmSync(work, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;

// ------------------------------------------------------------ helpers

async function withServer(env, fn) {
  const child = spawn(process.execPath, ["--no-warnings", CLI, "ui", "--no-open", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  const base = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`viewer did not start: ${buf}`)), 60_000);
    const on = (d) => {
      buf += d;
      const mm = /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([\w%-]+)/.exec(buf);
      if (mm) {
        clearTimeout(timer);
        res({ url: mm[1], token: decodeURIComponent(mm[2]) });
      }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
  });
  try {
    await fn(base);
  } finally {
    child.kill();
  }
}

async function mcpReads(env, sid) {
  const child = spawn(process.execPath, ["--no-warnings", CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((res) => {
      const n = ++id;
      waiting.set(n, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "longrun-bench", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const time = async (key, name, args) => {
    const t0 = performance.now();
    const r = await rpc("tools/call", { name, arguments: args });
    out[key] = Math.round(performance.now() - t0);
    if (r.error || r.result?.isError) notes.push(`mcp ${name}: ${JSON.stringify(r.error ?? r.result.content).slice(0, 300)}`);
    return r;
  };
  await time("mcp_sessions_list_ms", "sessions_list", { limit: 20 });
  await time("mcp_session_get_ms", "session_get", { sessionId: sid });
  await time("mcp_session_get_tail_ms", "session_get", { sessionId: sid, tail: true });
  await time("mcp_search_ms", "search", { query: "resolveRoute" });
  child.kill();
}
