#!/usr/bin/env node
// `coding.sh exp ab`, end to end with real Claude Code: install coding.sh from a
// tarball and the real Claude Code CLI from npm under a throwaway HOME, point it
// at a local stub model, and record a few real sessions where the agent edits a
// file and says it is done without running anything. Then edit CLAUDE.md and
// run `coding.sh exp ab` with no arguments: A = the committed CLAUDE.md, B = the
// edit, on the decision points mined from those sessions.
//
// The stub plays three parts:
//   Claude Code (its own system prompt, Read/Write/Bash tools): Read the file,
//     Write it, answer "Done." with no test run: one unverified claim per session.
//   The replayed next turn (coding.sh's continuation prompt): runs `npm test`
//     when the B rule's text reached it, else answers "Done." again.
//   The judge ("You are a strict..."): passes a turn that runs `npm test`.
// Expected: A 0/3 -> B 3/3, fixed 3, replay noise floor 0% (A repeats the
// recorded turn); --gate holds (3 wins is not enough evidence) and exits 1; an
// unchanged rerun makes no model or judge calls; --max-cost below the estimate
// refuses before any call; --watch prints one line per save of CLAUDE.md and
// asks only arm B again.
//
//   node scripts/e2e/exp-ab-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME. Exit 0 when every check passed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub, toolNames } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isWin = process.platform === "win32";
const CLAUDE_PKG = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-5-5";
const RULE = "VERIFY-RULE: after changing code, run npm test before you say you are done.";
const TASKS = {
  range: { instruction: "Make range.js include its end value.", before: "module.exports = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);\n", after: "module.exports = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);\n" },
  clamp: { instruction: "Make clamp.js clamp to the upper bound too.", before: "module.exports = (x, lo, hi) => Math.max(x, lo);\n", after: "module.exports = (x, lo, hi) => Math.min(Math.max(x, lo), hi);\n" },
  pad: { instruction: "Make pad.js pad on the left.", before: "module.exports = (s, n) => s.padEnd(n);\n", after: "module.exports = (s, n) => s.padStart(n);\n" },
};

function parseArgs(argv) {
  const o = { keep: false, tarball: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") o.keep = true;
    else if (a === "--tarball") o.tarball = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const log = (...a) => console.log("[exp-ab-capture]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

function run(file, args, { cwd, env, timeoutMs = 900_000, quiet = false } = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env: cwd && env ? { ...env, PWD: cwd } : env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!quiet && code !== 0 && code !== 1) log(`${file} ${args.join(" ")} exited ${code}\n--- stdout\n${stdout.slice(-4000)}\n--- stderr\n${stderr.slice(-4000)}`);
      done({ code, stdout, stderr });
    });
  });
}

// ------------------------------------------------------------------ the stub's parts

const CONTINUATION = "You are a coding agent working";
const JUDGE = "You are a strict";
const systemText = (body) => (typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map((b) => b?.text ?? "").join("\n") : "");
const counts = { claude: 0, continuation: 0, continuationWithRule: 0, judge: 0 };

/** Claude Code: Read the task's file, Write the fix, then claim done without running anything. */
function claudeTurn(body, all) {
  const names = toolNames(body);
  if (!names.includes("Read") || !names.includes("Write")) return { text: "ok" };
  const task = Object.keys(TASKS).find((t) => all.includes(TASKS[t].instruction));
  const cwd = /[Ww]orking directory: ([^\s"\\]+)/.exec(all)?.[1];
  if (!task || !cwd) return { text: "ok" };
  counts.claude++;
  const file = `${cwd}/${task}.js`;
  const step = body.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((c) => c?.type === "tool_result").length : 0), 0);
  if (step === 0) return { tool: { name: "Read", args: { file_path: file } } };
  if (step === 1) return { tool: { name: "Write", args: { file_path: file, content: TASKS[task].after } } };
  return { text: `Done: ${task}.js is fixed.` };
}

/** The judge: the turn under <output> passes when it runs npm test. */
function judgeTurn(body) {
  counts.judge++;
  const prompt = body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const output = /<output>([\s\S]*?)<\/output>/.exec(prompt)?.[1] ?? "";
  const pass = output.includes("npm test");
  return { text: JSON.stringify({ score: pass ? 1 : 0.2, pass, confidence: 0.9, reason: pass ? "runs the tests before claiming success" : "claims done without checking", citations: [] }) };
}

let lastBody;
function scenario(body) {
  if (!Array.isArray(body.messages)) return { text: "ok" };
  const sys = systemText(body);
  const all = JSON.stringify(body);
  if (sys.startsWith(JUDGE)) return judgeTurn(body);
  if (sys.startsWith(CONTINUATION)) {
    counts.continuation++;
    if (!all.includes("VERIFY-RULE")) return { text: "Done." };
    counts.continuationWithRule++;
    const shell = toolNames(body).find((n) => /bash/i.test(n)) ?? "Bash";
    return { tool: { name: shell, args: { command: "npm test" } } };
  }
  if (toolNames(body).length) lastBody = body;
  return claudeTurn(body, all);
}

// ------------------------------------------------------------------ main

const opts = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-expab-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const csHome = join(home, ".coding.sh");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
const binDir = isWin ? prefix : join(prefix, "bin");

const stub = await startStub({ decide: scenario });
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
  NO_COLOR: "1",
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  // Claude Code refuses bypassPermissions as root unless it is told it is sandboxed (the desk runs as root).
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (isWin) {
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
}
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
log(`temp root ${root}`);
log(`stub model on ${stub.url}`);

let exitCode = 0;
try {
  let tarball = opts.tarball;
  if (!tarball) {
    const pkgDir = join(REPO, "packages", "coding.sh");
    if (!existsSync(join(pkgDir, "dist", "cli.mjs"))) throw new Error("packages/coding.sh/dist is missing: run npm run build first, or pass --tarball");
    const packed = await run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: pkgDir });
    if (packed.code !== 0) throw new Error("npm pack failed");
    tarball = join(root, packed.stdout.trim().split(/\r?\n/).pop());
  }
  log(`installing ${tarball} and ${CLAUDE_PKG}`);
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, CLAUDE_PKG], { env, cwd: root });
  if (install.code !== 0) throw new Error("npm install -g failed");
  const json = (r, what) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`${what}: not JSON (exit ${r.code}):\n${r.stdout.slice(0, 2000)}\n${r.stderr.slice(0, 2000)}`);
    }
  };
  log(`coding.sh ${(await run("coding.sh", ["--version"], { env, cwd: root })).stdout.trim()}`);
  log(`claude ${(await run("claude", ["--version"], { env, cwd: root })).stdout.trim()}`);
  const init = await run("coding.sh", ["init", "--agent", "claude-code", "--yes", "--no-mcp", "--json"], { env, cwd: root });
  check(init.code === 0, "coding.sh init --agent claude-code", init.stderr);

  // A repo with three small bugs and a CLAUDE.md, committed.
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "CLAUDE.md"), "Keep changes small.\n");
  for (const [t, spec] of Object.entries(TASKS)) writeFileSync(join(repo, `${t}.js`), spec.before);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "demo", private: true, scripts: { test: "node --test" } }, null, 2)}\n`);
  const git = (...a) => execFileSync("git", a, { cwd: repo, env, stdio: "pipe" }).toString();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");

  // Real Claude Code sessions, captured by the hooks init installed: each edits and claims done untested.
  for (const [t, spec] of Object.entries(TASKS)) {
    const r = await run("claude", ["-p", spec.instruction, "--model", MODEL, "--permission-mode", "bypassPermissions"], { env, cwd: repo });
    check(r.code === 0, `claude -p: ${t}`, r.stderr.slice(-2000));
    check(readFileSync(join(repo, `${t}.js`), "utf8") === spec.after, `claude wrote ${t}.js`);
    git("checkout", "-q", `${t}.js`);
  }
  check(counts.claude >= 9, "the stub played Claude Code for every step", counts);
  const ingest = await run("coding.sh", ["ingest"], { env, cwd: repo });
  check(ingest.code === 0, "coding.sh ingest", ingest.stderr);
  const listed = json(await run("coding.sh", ["sessions", "--agent", "claude-code", "--json"], { env, cwd: repo }), "sessions");
  const rows = Array.isArray(listed) ? listed : (listed.sessions ?? []);
  check(rows.length >= 3, "three Claude Code sessions captured", rows.map((s) => s.id));

  // The edit under test: the rule goes into CLAUDE.md, uncommitted.
  writeFileSync(join(repo, "CLAUDE.md"), `Keep changes small.\n${RULE}\n`);
  const ab = (args, o = {}) => run("coding.sh", ["exp", "ab", ...args], { env, cwd: repo, ...o });

  // 1. The estimate, then the refusal below it: no model calls either way.
  let before = stub.requests.length;
  const dry = await ab(["--dry-run"]);
  log(`exp ab --dry-run:\n${dry.stdout}`);
  check(dry.code === 0, "exp ab --dry-run exits 0", dry.stderr);
  check(/3 decision points from 3 sessions/.test(dry.stdout), "dry run: 3 decision points from 3 sessions", dry.stdout);
  check(/Would make 6 of 6 model calls/.test(dry.stdout), "dry run: 6 model calls (3 cases x 2 arms)", dry.stdout);
  const capped = await ab(["--max-cost", "0.000001"]);
  check(capped.code === 1 && /--max-cost/.test(capped.stderr), "exp ab --max-cost below the estimate refuses", capped.stderr);
  check(stub.requests.length === before, "neither made a model call");

  // 2. The A/B: A = git:HEAD, B = your edits, as plain text.
  before = stub.requests.length;
  const text = await ab([]);
  log(`exp ab:\n${text.stdout}`);
  check(text.code === 0, "exp ab exits 0", text.stderr);
  check(stub.requests.length > before, "the A/B called the stub model");
  check(counts.continuation === 6 && counts.continuationWithRule === 3, "6 replayed turns, only arm B saw the rule", counts);
  check(new RegExp(`^A: git:HEAD {3}B: your edits {3}model: ${MODEL}$`, "m").test(text.stdout), `text: default arms git:HEAD vs your edits, the sessions' model (${MODEL})`);
  check(/3 decision points from 3 sessions \| A 0\/3 -> B 3\/3 \| fixed 3, broke 0 \| paired p=0\.25 \| (?:<\$0\.01|\$[\d.]+), 0\/6 cached/.test(text.stdout), "text: A 0/3 -> B 3/3, nothing cached");
  check(/^Hold: not enough evidence/m.test(text.stdout), "text: the gate line");
  check(/Replay noise floor 0%/.test(text.stdout), "text: the noise floor line");
  check(/^Fixed \(A failed, B passed\):$/m.test(text.stdout) && (text.stdout.match(/coding\.sh show /g) ?? []).length === 3, "text: the fixed list links each session");
  check(/^Full comparison: coding\.sh exp compare exp_\w+ exp_\w+$/m.test(text.stdout), "text: the full comparison hint");

  // 3. An unchanged rerun, as JSON: answered entirely from the caches.
  before = stub.requests.length;
  const again = json(await ab(["--json"]), "exp ab --json");
  log(`exp ab --json: fixed ${again.fixed?.length}, broke ${again.broke?.length}, cost ${JSON.stringify(again.cost)}, cache ${JSON.stringify(again.cacheHits)}`);
  check(stub.requests.length === before, "an unchanged rerun makes no model or judge calls", stub.requests.length - before);
  check(JSON.stringify(again.cacheHits) === JSON.stringify({ model: 6, of: 6, judgeCalls: 0 }), "rerun: 6/6 cached, no judge calls", again.cacheHits);
  check(again.arms?.a?.label === "git:HEAD" && again.arms?.b?.label === "your edits" && again.model === MODEL, "json: arms and model", { arms: again.arms, model: again.model });
  check(again.fixed?.length === 3 && again.broke?.length === 0, "json: B fixes all 3 decision points and breaks none", { fixed: again.fixed?.length, broke: again.broke?.length });
  check(again.comparison?.replay?.rate === 0 && again.comparison?.replay?.withinNoise === false, "json: replay noise floor 0%, B above it", again.comparison?.replay);
  check(again.comparison?.gate?.verdict !== undefined, "json: the ship gate is computed", again.comparison?.gate);

  // 4. --gate: 3 wins is not enough evidence to ship, so it holds and exits 1.
  const gated = await ab(["--gate"]);
  check(gated.code === 1 && /^Hold: /m.test(gated.stdout), "exp ab --gate holds and exits 1", gated.stdout);

  // 5. --watch: one history line per save, only arm B asked again, Ctrl-C exits 0 (no SIGINT to a child on Windows).
  if (!isWin) {
    const child = spawn("coding.sh", ["exp", "ab", "--watch"], { cwd: repo, env: { ...env, PWD: repo }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const closed = new Promise((done) => child.on("close", done));
    const until = async (re, ms = 60_000) => {
      for (let t = 0; t < ms && !re.test(out); t += 100) await new Promise((r) => setTimeout(r, 100));
      return re.test(out);
    };
    const historyLine = /^\d\d:\d\d:\d\d {2}A 0\/3 -> B 3\/3 \| fixed 3, broke 0 \| Hold \| (?:<\$0\.01|\$[\d.]+), 3 new calls$/m;
    check(await until(/Watching .* for changes to B/), "exp ab --watch starts watching", out);
    const turns = counts.continuationWithRule;
    const judged = counts.judge;
    writeFileSync(join(repo, "CLAUDE.md"), `Keep changes small.\n${RULE} Every time.\n`);
    check(await until(historyLine), "watch: one history line after the save", out);
    await new Promise((r) => setTimeout(r, 1000));
    log(`exp ab --watch:\n${out}`);
    check(out.match(/^\d\d:\d\d:\d\d {2}/gm)?.length === 1, "watch: exactly one rerun per save");
    check(counts.continuationWithRule - turns === 3, "watch: only arm B's 3 turns were asked again", counts);
    check(counts.judge === judged, "watch: the same turns keep their cached verdicts (new tool-call ids)", counts);
    child.kill("SIGINT");
    check((await closed) === 0, "watch: Ctrl-C exits 0", out);
  }
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : e}`);
  failures.push(String(e));
} finally {
  await stub.close();
  if (failures.length) {
    exitCode = 1;
    log(`stub requests (${stub.requests.length}): ${JSON.stringify(stub.requests.slice(-40))}`);
    if (lastBody) writeFileSync(join(root, "last-request.json"), JSON.stringify(lastBody, null, 1));
    const errLog = join(csHome, "spool", "errors.log");
    if (existsSync(errLog)) log(`hook errors:\n${readFileSync(errLog, "utf8").slice(-4000)}`);
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
  } else log("all checks passed");
  if (!opts.keep && !failures.length) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  else log(`kept ${root}`);
}
process.exit(exitCode);
