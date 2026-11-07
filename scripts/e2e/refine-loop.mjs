#!/usr/bin/env node
// `coding.sh refine`, end to end against a local stub model, under a
// throwaway HOME: synthetic captured sessions in a git repo with a CLAUDE.md
// that has one protected line, then
//
//   refine propose --dry-run   -> the prompt marks the protected line READ-ONLY; no call
//   refine propose             -> one proposer call; a stored candidate r_…
//   refine test r_… --behavior unverified-claim
//                              -> keep: wins 8 of 8 decision points, no guard yet
//   refine apply               -> CLAUDE.md gets the marked block; a backup is kept
//   refine test v2 --behavior unchanged-retry --dry-run
//                              -> guard of 8 tasks the kept edit won; no call
//   refine test v2 --behavior unchanged-retry
//                              -> reject: wins its own 8 decision points but
//                                 forgets kept edit r_… (guard regression)
//   refine log                 -> both rounds with verdict, effect CI, guard, reason
//   refine rollback            -> CLAUDE.md is byte-for-byte what it was
//
// v2 is the original CLAUDE.md plus a retry rule: it drops the kept edit's line.
//
// The stub plays three parts:
//   the proposer ("You improve the instruction file…"): adds TEST-RULE;
//   the replayed next turn: `npm run build` when RETRY-RULE reached it on a
//     retried `npm run biuld`, `npm test` when TEST-RULE reached it, else "Done.";
//   the judge ("You are a strict…"): on a retry case passes `npm run build`,
//     on any other case passes `npm test`.
//
//   node scripts/e2e/refine-loop.mjs [--keep]
//
// Runs coding.sh from source (Node 22.18+ strips the types). No network. Never
// touches the real HOME. Exit 0 when every check passed.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startStub, toolNames } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(REPO, "packages", "coding.sh", "src");
const CLI = join(SRC, "cli", "main.ts");
const keep = process.argv.includes("--keep");
const MODEL = "claude-sonnet-5-5";
const BASE = "Keep answers short.\nNever run `git push --force`.\n";
const TEST_RULE = "TEST-RULE: run npm test before you say you are done.";
const RETRY_RULE = "RETRY-RULE: when a command fails, read the error and fix the command before you run it again.";
const N = 8;

const log = (...a) => console.log("[refine-loop]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

// ------------------------------------------------------------------ the stub's parts

const counts = { proposer: 0, turn: 0, judge: 0 };
const systemText = (body) => (typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text ?? "").join("\n") : "");
const userText = (body) => body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function scenario(body) {
  if (!Array.isArray(body.messages)) return undefined;
  const sys = systemText(body);
  const text = userText(body);
  if (sys.startsWith("You improve the instruction file")) {
    counts.proposer++;
    return { text: JSON.stringify({ lines: [TEST_RULE], rationale: "sessions end with an unverified claim" }) };
  }
  if (sys.startsWith("You are a strict")) {
    counts.judge++;
    const output = /<output>([\s\S]*?)<\/output>/.exec(text)?.[1] ?? "";
    const pass = text.includes("biuld") ? output.includes("npm run build") : output.includes("npm test");
    return { text: JSON.stringify({ score: pass ? 1 : 0.2, pass, confidence: 0.9, reason: pass ? "takes the right next step" : "does not", citations: [] }) };
  }
  counts.turn++;
  const shell = toolNames(body).find((n) => /bash/i.test(n)) ?? "Bash";
  const context = `${sys}\n${text}`;
  if (context.includes("RETRY-RULE") && text.includes("biuld")) return { tool: { name: shell, args: { command: "npm run build" } } };
  if (context.includes("TEST-RULE")) return { tool: { name: shell, args: { command: "npm test" } } };
  return { text: "Done." };
}

// ------------------------------------------------------------------ sessions

function events(id, cwd, startedAt, steps) {
  return steps.map(([kind, payload], i) => ({ id: `${id}-${i}`, v: 0, sessionId: id, ts: startedAt + i * 1000, agent: "claude-code", model: MODEL, cwd, kind, payload }));
}

/** Edits a file and says it is done without running anything: one unverified-claim decision point. */
const claim = (id, cwd, at, file) =>
  events(id, cwd, at, [
    ["session.start", {}],
    ["user.message", { text: `range(1, 3) should include 3. Fix ${file}.` }],
    ["tool.start", { tool: "Read", toolUseId: `${id}-r`, input: { file_path: `${cwd}/${file}` } }],
    ["tool.end", { tool: "Read", toolUseId: `${id}-r`, ok: true, output: "export const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);\n" }],
    ["tool.start", { tool: "Edit", toolUseId: `${id}-e`, input: { file_path: `${cwd}/${file}`, old_string: "b - a", new_string: "b - a + 1" } }],
    ["tool.end", { tool: "Edit", toolUseId: `${id}-e`, ok: true, output: "The file has been updated." }],
    ["file.change", { path: file, op: "modify", tool: "Edit", toolUseId: `${id}-e` }],
    ["assistant.message", { text: "Fixed: range() now includes the end value." }],
    ["turn.end", {}],
  ]);

/** Runs a misspelled script twice and gives up: one unchanged-retry decision point. */
const retry = (id, cwd, at) =>
  events(id, cwd, at, [
    ["session.start", {}],
    ["user.message", { text: "Build the project." }],
    ["tool.start", { tool: "Bash", toolUseId: `${id}-1`, input: { command: "npm run biuld" } }],
    ["tool.end", { tool: "Bash", toolUseId: `${id}-1`, ok: false, output: 'npm error Missing script: "biuld"' }],
    ["tool.start", { tool: "Bash", toolUseId: `${id}-2`, input: { command: "npm run biuld" } }],
    ["tool.end", { tool: "Bash", toolUseId: `${id}-2`, ok: false, output: 'npm error Missing script: "biuld"' }],
    ["assistant.message", { text: "The build script seems broken." }],
    ["turn.end", {}],
  ]);

// ------------------------------------------------------------------ setup

const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-refine-")));
const home = join(root, "home");
const repo = join(root, "repo");
mkdirSync(home, { recursive: true });
mkdirSync(repo, { recursive: true });
const stub = await startStub({ decide: scenario });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODING_SH|GIT_)/i.test(k)) env[k] = v;
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  CODING_SH_HOME: join(home, ".coding.sh"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  CODING_SH_NO_UPDATE_CHECK: "1",
  CODING_SH_RETRY_BASE_MS: "0",
  NO_COLOR: "1",
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
});

const git = (...a) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...a], { cwd: repo, env, stdio: "ignore" });
writeFileSync(join(repo, "CLAUDE.md"), BASE);
git("init", "-q");
git("add", "-A");
git("commit", "-qm", "init");

{
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const { openContext } = await import(pathToFileURL(join(SRC, "core", "context.ts")).href);
  const { buildSession } = await import(pathToFileURL(join(SRC, "core", "sessions.ts")).href);
  const ctx = await openContext({ env, cwd: repo });
  try {
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      for (const evs of [claim(`claim-${i}`, repo, now - (i + 1) * 3600_000, `src/mod${i}.js`), retry(`retry-${i}`, repo, now - (i + 30) * 3600_000)]) {
        await ctx.index.putEvents(evs);
        await ctx.index.upsertSession(buildSession(evs));
      }
    }
  } finally {
    await ctx.close();
  }
}

function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const show = (r) => {
  for (const l of `${r.stdout}${r.stderr}`.trimEnd().split("\n")) console.log(`     | ${l}`);
};
const calls = () => counts.proposer + counts.turn + counts.judge;

// ------------------------------------------------------------------ the loop

log(`stub model on ${stub.url}; repo ${repo}`);
try {
  let before = calls();
  const pd = await run(["refine", "propose", "--dry-run"]);
  check(pd.status === 0, "propose --dry-run exits 0", pd.stderr);
  check(/READ-ONLY[^\n]*\n- CLAUDE\.md:2: Never run `git push --force`\./.test(pd.stdout), "propose --dry-run: the protected line is READ-ONLY in the prompt", pd.stdout);
  check(calls() === before, "propose --dry-run makes no model call", counts);
  check(/^Findings: no-verification /m.test(pd.stdout), "propose --dry-run: the finding is the sessions' no-verification flag", pd.stdout);

  before = counts.proposer;
  const p = await run(["refine", "propose"]);
  show(p);
  const id = /^(r_[0-9a-f]{10}) /m.exec(p.stdout)?.[1];
  check(p.status === 0 && id !== undefined, "propose stores a candidate r_…", p.stderr);
  check(counts.proposer === before + 1, "propose makes one proposer call", counts);

  const t1 = await run(["refine", "test", id, "--behavior", "unverified-claim"]);
  show(t1);
  check(t1.status === 0, "round 1 exits 0 (kept)", t1.stderr);
  check(new RegExp(`^ {2}verdict {4}keep: dev: Ship it: B wins ${N} decision points, loses 0; guard: no earlier kept wins to hold$`, "m").test(t1.stdout), "round 1: keep, no guard yet", t1.stdout);

  const ap = await run(["refine", "apply"]);
  show(ap);
  const applied = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  check(ap.status === 0 && applied === `${BASE}\n<!-- coding.sh:refine ${id} begin -->\n${TEST_RULE}\n<!-- coding.sh:refine ${id} end -->\n`, "apply writes the kept block under the original text", applied);

  const v2 = join(root, "drafts", "v2", "CLAUDE.md");
  mkdirSync(dirname(v2), { recursive: true });
  writeFileSync(v2, `${BASE}${RETRY_RULE}\n`);
  before = calls();
  const d2 = await run(["refine", "test", v2, "--behavior", "unchanged-retry", "--dry-run"]);
  show(d2);
  check(d2.status === 0 && new RegExp(`^Guard: ${N} tasks earlier kept edits won \\(0 in this round's decision points, ${N} to rerun\\)$`, "m").test(d2.stdout), "round 2 --dry-run shows the guard size", d2.stdout);
  check(calls() === before, "round 2 --dry-run makes no model call", counts);

  const t2 = await run(["refine", "test", v2, "--behavior", "unchanged-retry"]);
  show(t2);
  check(t2.status === 1, "round 2 exits 1 (nothing kept)", t2.stderr);
  const lj = await run(["refine", "log", "--json"]);
  const r2 = lj.status === 0 ? JSON.parse(lj.stdout).entries.filter((e) => e.op === "test").at(-1) : undefined;
  check(r2?.gate?.verdict === "ship" && r2.gate.wins === N, "round 2 wins its own decision points", r2?.gate);
  check(r2?.verdict === "reject" && r2.stage === "guard" && r2.reasons.at(-1) === `guard: forgets kept edit ${id}`, "round 2 is rejected by the guard: forgets the kept edit", r2?.reasons);

  const lg = await run(["refine", "log"]);
  show(lg);
  check(lg.status === 0 && new RegExp(`^1\\t${id}\\tkeep, applied\\t`, "m").test(lg.stdout) && new RegExp(`^2\\tr_[0-9a-f]{10}\\treject\\t.*\\tforgets ${id}\\t.*guard: forgets kept edit ${id}$`, "m").test(lg.stdout), "log lists the keep and the guard reject", lg.stdout);

  const rb = await run(["refine", "rollback"]);
  show(rb);
  check(rb.status === 0 && readFileSync(join(repo, "CLAUDE.md"), "utf8") === BASE, "rollback restores CLAUDE.md byte for byte");
} finally {
  await stub.close();
  if (keep) log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

log(`calls: ${JSON.stringify(counts)}`);
if (failures.length) {
  log(`${failures.length} check(s) failed`);
  process.exit(1);
}
log("all checks passed");
