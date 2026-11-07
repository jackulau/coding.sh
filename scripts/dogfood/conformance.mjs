#!/usr/bin/env node
// Conformance (docs/DOGFOOD.md §3.3).
//
//   conformance.fixtures  fraction of adapter tests passing (node --test, TAP)
//   capture.health        fraction of this repo's sessions in the last 24 h
//                         that have session.start, tool events and session.end
//                         (+ at least one llm.call for Claude Code). Measured on
//                         a copy of the live home, because read commands
//                         auto-ingest and must not mutate it from the scorer.
//   conformance.smoke     scripts/dogfood/smoke.mjs when present; else skipped
//
//   node scripts/dogfood/conformance.mjs [fixtures|health]... [--home <dir>] [--repo <dir>] [--json]
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CLI, log, parseArgs, PKG, REPO, sh, shAsync, tempDir } from "./lib/util.mjs";

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

const hasData = (home) => existsSync(home) && readdirSync(home).some((f) => f.startsWith("index.db") || f === "spool");

/** capture.health over a clone of `home` (APFS clonefile via cp -c on macOS, plain copy elsewhere). */
export function captureHealth({ home = process.env.CODING_SH_LIVE_HOME ?? join(homedir(), ".coding.sh"), repo = REPO, cli = CLI, sinceHours = 24 } = {}) {
  if (!hasData(home)) return { value: null, reason: `no capture data in ${home}` };
  const root = tempDir("cs-health-");
  try {
    const copy = join(root, "home", ".coding.sh");
    const cp = process.platform === "darwin" ? sh("cp", ["-c", "-R", home, copy]) : { code: 1 };
    if (cp.code !== 0) cpSync(home, copy, { recursive: true });
    const env = { ...process.env, HOME: join(root, "home"), CODING_SH_HOME: copy, NO_COLOR: "1" };
    const cs = (args) => {
      const r = sh(process.execPath, [cli, ...args, "--json"], { env });
      if (r.code !== 0) throw new Error(`coding.sh ${args.join(" ")} exited ${r.code}: ${r.stderr.slice(0, 300)}`);
      return JSON.parse(r.stdout);
    };
    const inRepo = (cwd) => !!cwd && (cwd === repo || cwd.startsWith(repo + sep));
    const sessions = cs(["sessions", "--since", `${sinceHours}h`, "--limit", "10000"]).sessions.filter((s) => inRepo(s.cwd) && !s.parentSessionId);
    if (!sessions.length) return { value: null, reason: `no sessions under ${repo} in the last ${sinceHours} h` };
    const rows = sessions.map((s) => {
      const kinds = new Set(cs(["show", s.id]).events.map((e) => e.kind));
      const missing = [];
      if (!kinds.has("session.start")) missing.push("session.start");
      if (!kinds.has("tool.start") && !kinds.has("tool.end")) missing.push("tool events");
      if (!kinds.has("session.end")) missing.push("session.end");
      if (s.agent === "claude-code" && !kinds.has("llm.call")) missing.push("llm.call");
      return { id: s.id, agent: s.agent, missing };
    });
    const ok = rows.filter((r) => !r.missing.length).length;
    return { value: ok / rows.length, n: rows.length, incomplete: rows.filter((r) => r.missing.length).slice(0, 20) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json"] });
  const which = args._.length ? args._ : ["fixtures", "health", "smoke"];
  const out = {};
  if (which.includes("fixtures")) out["conformance.fixtures"] = await fixtures();
  if (which.includes("health")) out["capture.health"] = captureHealth({ home: args.home ? resolve(args.home) : undefined, repo: args.repo ? resolve(args.repo) : undefined });
  if (which.includes("smoke")) out["conformance.smoke"] = await smoke();
  if (!args.json) log(Object.entries(out).map(([k, v]) => `${k}: ${v.value ?? "null"}`).join("\n"));
  process.stdout.write(JSON.stringify(out, null, args.json ? 0 : 2) + "\n");
}
