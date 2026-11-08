#!/usr/bin/env node
// Fork from step N, end to end with the real Claude Code CLI against a stub
// model: install coding.sh from a tarball and a pinned Claude Code from npm
// under a throwaway HOME, `coding.sh init --proxy`, and run a session that
// fails: CLAUDE.md says "npm test", the project has no test script, so the
// agent's test step fails and it stops anyway. The stub plays the model: it
// writes a test, then runs the tests the way CLAUDE.md says, then says done.
// Checks:
//   - `replay --step N --fork --with CLAUDE.md=fixed.md -k 2`: the stored call
//     of the failing step, sent with the fixed CLAUDE.md, takes another action
//     (node --test) than the recorded one (npm test);
//   - `--run --verify "node --test"`: Claude Code runs from step N in a rolled
//     back copy, the stored history spliced into its requests, and the verifier
//     passes in the copy; the original project is untouched;
//   - `--save-case forks`, then `eval run forks`: fails with the project's
//     CLAUDE.md, passes once CLAUDE.md is fixed.
//
//   node scripts/e2e/fork-capture.mjs [--tarball coding.sh-x.y.z.tgz] [--keep]
//
// Without --tarball it packs packages/coding.sh (build it first: npm run build).
// Needs network for npm. Never touches the real HOME. Exit 0 when every check passed.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "../../packages/coding.sh/src/core/spawn.ts";
import { startStub } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isWin = process.platform === "win32";
const CLAUDE_PKG = "@anthropic-ai/claude-code@2.1.319";
const ANTHROPIC_KEY = "sk-ant-api03-FORKE2ESECRETFORKE2ESECRETFORKE2E-abcdefAA";
const FIXED = "Run the tests with node --test.";
const TEST = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../add.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n';

const opts = { keep: false, tarball: undefined };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--keep") opts.keep = true;
  else if (a === "--tarball") opts.tarball = resolve(process.argv[++i]);
  else throw new Error(`unknown argument ${a}`);
}

const log = (...a) => console.log("[fork-capture]", ...a);
const failures = [];
function check(ok, what, detail) {
  if (ok) log(`ok   ${what}`);
  else {
    log(`FAIL ${what}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    failures.push(what);
  }
  return ok;
}

function run(file, args, { cwd, env, timeoutMs = 300_000, quiet = false } = {}) {
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

// ------------------------------------------------------------------ the model

const textOf = (body) => JSON.stringify(body.messages ?? []);
/** The tool whose result the conversation ends on (Claude Code's main loop), if any. */
function lastResultTool(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const result = Array.isArray(last?.content) ? last.content.find((c) => c?.type === "tool_result") : undefined;
  if (!result) return undefined;
  for (const m of msgs) for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === "tool_use" && c.id === result.tool_use_id) return c.name;
  return "?";
}
const mainLoop = [];
function decide(body) {
  const names = (body.tools ?? []).map((t) => t.name);
  if (!names.includes("Bash") || !names.includes("Write")) return { text: "ok" };
  const text = textOf(body);
  if (!text.includes("add a test for add.js")) return { text: "ok" };
  mainLoop.push({ messages: (body.messages ?? []).length, fixed: text.includes(FIXED), stream: body.stream === true });
  const after = lastResultTool(body);
  if (!after) return { tool: { name: "Write", args: { file_path: "test/add.test.js", content: TEST } } };
  if (after === "Write") return { tool: { name: "Bash", args: { command: text.includes(FIXED) ? "node --test" : "npm test", description: "Run the tests" } } };
  return { text: "Done. I added the test and ran the tests." };
}

// ------------------------------------------------------------------ main

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "csh-fork-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const csHome = join(home, ".coding.sh");
mkdirSync(home, { recursive: true });
mkdirSync(prefix, { recursive: true });
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = coding.sh e2e\n\temail = e2e@coding.sh.invalid\n[init]\n\tdefaultBranch = main\n");
const binDir = isWin ? prefix : join(prefix, "bin");
const stub = await startStub({ decide });
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
  NO_COLOR: "1",
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
mkdirSync(csHome, { recursive: true });
writeFileSync(join(csHome, "config.toml"), `[proxy]\nport = ${port}\nanthropic_upstream = "${stub.url}"\n`);
log(`temp root ${root}`);
log(`stub model on ${stub.url}, proxy port ${port}`);

let exitCode = 0;
const repo = join(root, "repo");
const cs = (args, o = {}) => run("coding.sh", args, { env, cwd: repo, ...o });
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
  const install = await run("npm", ["install", "-g", "--no-fund", "--no-audit", tarball, CLAUDE_PKG], { env, cwd: root, timeoutMs: 600_000 });
  if (install.code !== 0) throw new Error("npm install -g failed");
  log(`claude ${(await run("claude", ["--version"], { env, cwd: root })).stdout.trim()}`);

  const init = await run("coding.sh", ["init", "--agent", "claude-code", "--proxy", "--yes", "--no-mcp"], { env, cwd: root });
  check(init.code === 0, "coding.sh init --proxy --agent claude-code", init.stderr);

  // The project: add.js, no test script, and a CLAUDE.md that says npm test.
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), '{\n  "name": "demo",\n  "type": "module"\n}\n');
  writeFileSync(join(repo, "add.js"), "export const add = (a, b) => a + b;\n");
  writeFileSync(join(repo, "CLAUDE.md"), "# demo\n\nRun the tests with npm test.\n");
  writeFileSync(join(root, "fixed.md"), `# demo\n\n${FIXED}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: repo, env });

  const sid = randomUUID();
  const r = await run("claude", ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-5", "--session-id", sid, "add a test for add.js and run the tests"], { env, cwd: repo });
  check(r.code === 0, "claude -p through the proxy", r.stderr.slice(-2000));
  check(existsSync(join(repo, "test", "add.test.js")), "the agent wrote test/add.test.js");
  check(mainLoop.length === 3 && !mainLoop.some((c) => c.fixed), `three main-loop calls, all with the npm test CLAUDE.md (${mainLoop.length})`, mainLoop);
  await new Promise((res) => setTimeout(res, 1500));

  const idx = JSON.parse((await cs(["replay", sid, "--json"], { quiet: true })).stdout || "{}");
  const steps = (idx.data ?? idx).steps ?? [];
  const failing = steps.find((s) => s.kind === "shell" && /npm test/.test(s.label));
  check(failing && failing.ok === false, "replay: the npm test step failed", steps);
  const n = String(failing?.n ?? 0);

  // One call, forked twice with the fixed CLAUDE.md.
  mainLoop.length = 0;
  const fork = await cs(["replay", sid, "--step", n, "--fork", "--with", `CLAUDE.md=${join(root, "fixed.md")}`, "-k", "2"]);
  log(`replay --step ${n} --fork:\n${fork.stdout}`);
  check(fork.code === 0 && /^harness: CLAUDE\.md replaced$/m.test(fork.stdout), "--fork: CLAUDE.md replaced where Claude Code put it", fork.stdout + fork.stderr);
  check(/made the step's tool call/.test(fork.stdout), "--fork: the call found by the step's tool_use id", fork.stdout);
  check(/^recorded {2}Bash: npm test$/m.test(fork.stdout) && /^2 of 2 forked calls took another action/m.test(fork.stdout), "--fork: recorded npm test, both forks another action", fork.stdout);
  check(mainLoop.length === 2 && mainLoop.every((c) => c.fixed && !c.stream && c.messages === 3), "--fork: two non-streamed calls carried the fixed CLAUDE.md and the stored history", mainLoop);

  // The whole agent from step N, in a rolled-back copy.
  mainLoop.length = 0;
  const work = join(root, "forkdir");
  const forked = await cs(["replay", sid, "--step", n, "--fork", "--with", `CLAUDE.md=${join(root, "fixed.md")}`, "--run", "--verify", "node --test", "--workdir", work, "--json"], { timeoutMs: 600_000 });
  let fr = {};
  try {
    fr = JSON.parse(forked.stdout);
  } catch {}
  const run1 = (fr.data ?? fr).run ?? {};
  log(`--run: ${JSON.stringify({ exitCode: run1.exitCode, spliced: run1.spliced, actions: run1.actions, verify: run1.verify && { ok: run1.verify.ok, exitCode: run1.verify.exitCode } })}`);
  check(forked.code === 0 && run1.exitCode === 0, "--run: Claude Code ran from the step", forked.stderr.slice(-2000));
  check(run1.spliced >= 1 && mainLoop.length >= 1 && mainLoop[0].messages >= 3 && mainLoop.every((c) => c.fixed), "--run: its requests carried the fixed CLAUDE.md and the stored history", mainLoop);
  check((run1.actions ?? []).some((a) => a.label === "Bash: node --test" && a.ok === true), "--run: the forked agent ran node --test, and it passed", run1.actions);
  check(run1.verify?.ok === true, "--run --verify node --test passed in the fork's directory", run1.verify);
  check(readFileSync(join(repo, "CLAUDE.md"), "utf8").includes("npm test") && readFileSync(join(work, "work", "CLAUDE.md"), "utf8").includes(FIXED), "--run: the fork's CLAUDE.md is the fixed one; the project's is untouched");

  // The step as a regression case.
  const save = await cs(["replay", sid, "--step", n, "--fork", "--with", `CLAUDE.md=${join(root, "fixed.md")}`, "--save-case", "forks"]);
  check(save.code === 0 && /Saved case fork-.* \(new suite\)/.test(save.stdout), "--save-case forks", save.stdout + save.stderr);
  const suiteDir = join(repo, "evals", "forks");
  check(existsSync(join(suiteDir, "suite.json")) && existsSync(join(suiteDir, "cases.jsonl")), "the suite's files");
  check(!readFileSync(join(suiteDir, "requests", readdirSync(join(suiteDir, "requests"))[0]), "utf8").includes("FORKE2ESECRET"), "no API key in the saved request");
  const before = await cs(["eval", "run", "forks", "--trials", "1"], { quiet: true });
  check(before.code !== 0 && /pass@1 {2}0\.0%/.test(before.stdout), "eval run: fails with the project's CLAUDE.md", before.stdout + before.stderr);
  copyFileSync(join(root, "fixed.md"), join(repo, "CLAUDE.md"));
  const after = await cs(["eval", "run", "forks", "--trials", "2"], { quiet: true });
  check(after.code === 0 && /pass@1 {2}100\.0%/.test(after.stdout), "eval run: passes once CLAUDE.md is fixed", after.stdout + after.stderr);
  log(after.stdout.split("\n").slice(0, 6).join("\n"));
} catch (e) {
  log(`error: ${e instanceof Error ? e.stack : String(e)}`);
  exitCode = 1;
} finally {
  await run("coding.sh", ["proxy", "stop"], { env, cwd: root, quiet: true }).catch(() => undefined);
  await stub.close();
  if (failures.length) {
    log(`${failures.length} check(s) failed: ${failures.join("; ")}`);
    exitCode = 1;
  } else if (exitCode === 0) log("all checks passed");
  if (!opts.keep) rmSync(root, { recursive: true, force: true });
  else log(`kept ${root}`);
}
process.exit(exitCode);

