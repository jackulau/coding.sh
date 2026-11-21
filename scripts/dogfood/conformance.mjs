#!/usr/bin/env node
// Conformance (docs/design/dogfood.md §3.3).
//
//   conformance.fixtures  fraction of adapter tests passing (node --test, TAP)
//   capture.health        fraction of this repo's sessions in the last 24 h that
//                         have what their kind of session should (scoreSession):
//                         wrappers start, end and llm.call; subagents tool events
//                         and llm.call; others start, tool events and end (+
//                         llm.call for Claude Code). Live sessions (no end, last
//                         event under 30 min old) are excluded. Measured on a copy
//                         of index.db only, with every home in a temp dir and
//                         auto-ingest off, so the scorer never reads the real
//                         profile or mutates the live store.
//   conformance.smoke     scripts/dogfood/smoke.mjs when present; else skipped
//
//   node scripts/dogfood/conformance.mjs [fixtures|health]... [--home <dir>] [--repo <dir>] [--json]
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLI, log, parseArgs, PKG, REPO, sh, shAsync, tempDir } from "./lib/util.mjs";
import { isMain } from "./lib/main.mjs";

/** Parse node:test TAP output into test-level counts (suites are not tests). */
export function parseTapSummary(text) {
  const num = (k) => {
    const m = new RegExp(`^# ${k} (\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped"), todo: num("todo"), cancelled: num("cancelled") };
}

export async function fixtures({ pkg = PKG } = {}) {
  const r = await shAsync(process.execPath, ["--no-warnings", "--test", "--test-reporter=tap", "test/adapters/**/*.test.ts"], { cwd: pkg, timeoutMs: 600_000 });
  const s = parseTapSummary(r.stdout);
  if (!s.tests) return { value: null, error: `no TAP summary (exit ${r.code}): ${r.stderr.slice(-300)}` };
  const failures = [...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]).slice(0, 20);
  return { value: s.pass / (s.tests - (s.skipped ?? 0) - (s.todo ?? 0)), n: s.tests, ...s, failures };
}

const hasData = (home) => existsSync(join(home, "index.db"));

/** Index files copied for capture.health: the database and its SQLite sidecars, never blobs or the spool. */
export const INDEX_FILES = ["index.db", "index.db-wal", "index.db-shm"];

/** A session is live (excluded) when it has no session.end and its last event is this recent. */
export const LIVE_MS = 30 * 60_000;

/** Agents whose sessions wrap another agent's process: they record model calls but no tool events. */
const WRAPPER_AGENTS = new Set(["wrapper", "t3code"]);

/** True for a subagent session: a parent link, or a Claude Code `<parent>:sub:<agentId>` id. */
export const isSubagent = (s) => !!(s.parent?.sessionId || s.parentSessionId) || String(s.id).includes(":sub:");

/**
 * What one session is missing for capture.health, or `{ excluded: "live" }` for a session still
 * running. Expectations by kind of session:
 *   wrapper (agent wrapper, t3code)  session.start, session.end, llm.call; no tool events expected
 *   subagent (parent link or :sub:) tool events and llm.call only
 *   claude-code                      session.start, tool events, session.end, llm.call
 *   any other agent                  session.start, tool events, session.end
 */
export function scoreSession(s, events, now = Date.now()) {
  const kinds = new Set(events.map((e) => e.kind));
  if (!kinds.has("session.end")) {
    const last = events.reduce((m, e) => Math.max(m, (e.ts ?? 0) + (String(e.kind).endsWith(".end") ? 0 : (e.durationMs ?? 0))), 0);
    if (last && now - last < LIVE_MS) return { excluded: "live" };
  }
  const tools = kinds.has("tool.start") || kinds.has("tool.end");
  const missing = [];
  if (isSubagent(s)) {
    if (!tools) missing.push("tool events");
    if (!kinds.has("llm.call")) missing.push("llm.call");
    return { missing, expect: "subagent" };
  }
  const wrapper = WRAPPER_AGENTS.has(s.agent);
  if (!kinds.has("session.start")) missing.push("session.start");
  if (!wrapper && !tools) missing.push("tool events");
  if (!kinds.has("session.end")) missing.push("session.end");
  if ((wrapper || s.agent === "claude-code") && !kinds.has("llm.call")) missing.push("llm.call");
  return { missing, expect: wrapper ? "wrapper" : "session" };
}

/** Copy (APFS clone on macOS) only the index database files from `home` into `dest`; returns the bytes copied. */
export function copyIndex(home, dest) {
  mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (const f of INDEX_FILES) {
    const src = join(home, f);
    if (!existsSync(src)) continue;
    const to = join(dest, f);
    const cp = process.platform === "darwin" ? sh("cp", ["-c", src, to]) : { code: 1 };
    if (cp.code !== 0) copyFileSync(src, to);
    bytes += statSync(to).size;
  }
  return bytes;
}

/**
 * Counts over every scored row that misses something: by agent, and by agent and what it misses.
 * A row missing two things counts once in byAgent and once under each thing.
 */
export function incompleteCounts(rows) {
  const byAgent = {};
  const byMissing = {};
  for (const r of rows) {
    if (!r.missing?.length) continue;
    const agent = r.agent ?? "unknown";
    byAgent[agent] = (byAgent[agent] ?? 0) + 1;
    const m = (byMissing[agent] ??= {});
    for (const k of r.missing) m[k] = (m[k] ?? 0) + 1;
  }
  return { byAgent, byMissing };
}

/**
 * The coding.sh that last wrote or migrated the copied index, from its kv row "store:writer"
 * (store/upgrade.ts), and the schema from its migrations table: { version, schema, at } or
 * undefined. Read-only, on the copy, before any CLI run opens it (a CLI run stamps itself).
 */
export function indexWriter(dir) {
  const file = join(dir, "index.db");
  if (!existsSync(file)) return undefined;
  let db;
  try {
    // Loaded here, not at the top: node:sqlite warns on load on Node 22, and only this reads it.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    let w;
    try {
      w = JSON.parse(db.prepare("SELECT value FROM kv WHERE key = ?").get("store:writer")?.value ?? "null");
    } catch {}
    let schema;
    try {
      schema = db.prepare("SELECT MAX(version) AS v FROM migrations").get()?.v ?? undefined;
    } catch {}
    const out = {};
    if (typeof w?.version === "string") out.version = w.version;
    const sch = schema ?? w?.schema;
    if (typeof sch === "number") out.schema = sch;
    if (typeof w?.at === "number" && w.at) out.at = w.at;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * Env for the scorer's CLI runs: every home the CLI or an adapter could read is under `root`, so
 * nothing reads the real profile, and no background ingest starts.
 */
export function healthEnv(root, codingShHome) {
  const home = join(root, "home");
  const env = { ...process.env };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_RUN_ID", "CODING_SH_SESSION_ID", "CODING_SH_DEV_REAL_STORE", "FORCE_COLOR"]) delete env[k];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: codingShHome,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
}

/** Remove a temp dir with retries; a failure (a Windows file lock) is returned as a warning, never thrown. */
export function removeTemp(root, rm = rmSync) {
  try {
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return undefined;
  } catch (e) {
    return `could not remove ${root}: ${e?.code ?? e?.message ?? e}`;
  }
}

/** True when `cwd` is `repo` or a folder under it. On Windows, case and slash direction do not matter. */
export function underRepo(cwd, repo, platform = process.platform) {
  if (!cwd || !repo) return false;
  const win = platform === "win32";
  const norm = (p) => (win ? p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : p.replace(/\/+$/, ""));
  const c = norm(cwd);
  const r = norm(repo);
  return c === r || c.startsWith(r + (win ? "\\" : "/"));
}

/** The checkout whose sessions capture.health scores: CODING_SH_HEALTH_REPO when set, else this one. */
export function healthRepo(env = process.env) {
  return env.CODING_SH_HEALTH_REPO ? resolve(env.CODING_SH_HEALTH_REPO) : REPO;
}

/**
 * capture.health over a copy of `home`'s index (index.db and its -wal/-shm only; cloned on macOS).
 * Scores the sessions under `repo` that started in the last `sinceHours`, subagents included.
 * Live sessions are left out of the score and listed in `excluded`.
 */
export function captureHealth({ home = process.env.CODING_SH_LIVE_HOME ?? join(homedir(), ".coding.sh"), repo = healthRepo(), cli = CLI, sinceHours = 24, now = Date.now } = {}) {
  if (!hasData(home)) return { value: null, reason: `no index.db in ${home}` };
  const root = tempDir("cs-health-");
  let result;
  try {
    const copy = join(root, "data");
    const copiedBytes = copyIndex(home, copy);
    const writer = indexWriter(copy);
    const stamp = writer ? { writer } : {};
    mkdirSync(join(root, "home"), { recursive: true });
    const env = healthEnv(root, copy);
    const cs = (args) => {
      const r = sh(process.execPath, ["--no-warnings", cli, ...args, "--json"], { env, cwd: root });
      if (r.code !== 0) throw new Error(`coding.sh ${args.join(" ")} exited ${r.code}: ${r.stderr.slice(0, 300)}`);
      return JSON.parse(r.stdout);
    };
    const sessions = cs(["sessions", "--since", `${sinceHours}h`, "--limit", "10000", "--subagents"]).sessions.filter((s) => underRepo(s.cwd, repo));
    if (!sessions.length) result = { value: null, reason: `no sessions under ${repo} in the last ${sinceHours} h`, copiedBytes, ...stamp };
    else {
      const rows = [];
      const excluded = [];
      for (const s of sessions) {
        // --all: a session over 200 events prints no events without it.
        const r = scoreSession(s, cs(["show", s.id, "--all"]).events, now());
        if (r.excluded) excluded.push({ id: s.id, agent: s.agent, reason: r.excluded });
        else rows.push({ id: s.id, agent: s.agent, expect: r.expect, missing: r.missing });
      }
      const ok = rows.filter((r) => !r.missing.length).length;
      result = rows.length
        ? { value: ok / rows.length, n: rows.length, ...stamp, incomplete: rows.filter((r) => r.missing.length).slice(0, 20), incompleteCounts: incompleteCounts(rows), excluded, copiedBytes }
        : { value: null, reason: `every session under ${repo} in the last ${sinceHours} h is still running`, n: 0, ...stamp, excluded, copiedBytes };
    }
  } catch (e) {
    result = { value: null, error: String(e?.message ?? e) };
  }
  const warning = removeTemp(root);
  return warning ? { ...result, warning } : result;
}

export async function smoke() {
  const p = join(REPO, "scripts", "dogfood", "smoke.mjs");
  if (!existsSync(p)) return { value: null, skipped: "scripts/dogfood/smoke.mjs not implemented yet (needs isolated agent installs and a long-lived Claude token)" };
  const r = await shAsync(process.execPath, [p, "--json"], { timeoutMs: 1_800_000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { value: null, error: `smoke exited ${r.code}` };
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json"] });
  const which = args._.length ? args._ : ["fixtures", "health", "smoke"];
  const out = {};
  if (which.includes("fixtures")) out["conformance.fixtures"] = await fixtures();
  if (which.includes("health")) out["capture.health"] = captureHealth({ home: args.home ? resolve(args.home) : undefined, repo: args.repo ? resolve(args.repo) : undefined });
  if (which.includes("smoke")) out["conformance.smoke"] = await smoke();
  if (!args.json) log(Object.entries(out).map(([k, v]) => `${k}: ${v.value ?? "null"}`).join("\n"));
  process.stdout.write(JSON.stringify(out, null, args.json ? 0 : 2) + "\n");
}
