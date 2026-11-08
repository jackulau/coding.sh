#!/usr/bin/env node
// Real Codex rollouts whose tool output Codex cut before the model saw it:
//   - a plain `exec_command` that prints a long JSON line: Codex keeps the head and
//     tail and puts `…N tokens truncated…` in the middle;
//   - the same command from a code-mode `exec` cell (features.code_mode), where the
//     cell's output starts with `Warning: truncated output (original token count: N)`.
// Pinned Codex from npm under a throwaway HOME, against the local stub model.
// Rollouts are copied out with temp paths scrubbed to /work/demo and /home/user.
//
//   node scripts/e2e/codex-cut-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when both rollouts were written.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@openai/codex@0.167.0";
const MODEL = "gpt-5";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

// Real path: Codex records the resolved cwd (/private/var/… on macOS), which the scrub must match.
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-codex-cut-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "AGENTS.md"), "Keep changes small.\n");
// One JSON line of about 40 KB: over what Codex hands the model from one call.
writeFileSync(join(project, "big.js"), "console.log(JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ i, name: `item-${i}` }))));\n");
const CMD = "node big.js";

const hasOutput = (body) => (Array.isArray(body.input) ? body.input : []).some((i) => i?.type === "function_call_output" || i?.type === "custom_tool_call_output");
let mode = "plain";
let served = 0;
function decide(body) {
  const names = toolNames(body);
  if (process.env.CAPTURE_DEBUG) console.error(`stub: ${mode} tools=${names.join(",")}`);
  if (!names.length) return { text: "ok" };
  served++;
  if (hasOutput(body)) return { text: "Done." };
  if (mode === "code") return { tool: { name: "exec", input: `text(await tools.exec_command({ cmd: ${JSON.stringify(CMD)} }));\n` } };
  return { tool: { name: "exec_command", args: { cmd: CMD } } };
}

const stub = await startStub({ decide });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) env[k] = v;
Object.assign(env, {
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  PATH: [join(prefix, "bin"), env.PATH].join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  OPENAI_API_KEY: "sk-stub",
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
mkdirSync(env.CODEX_HOME, { recursive: true });

/** One `codex exec` against the stub (a custom provider: Codex ignores OPENAI_BASE_URL). */
function run(extra) {
  const argv = [
    "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", MODEL,
    "-c", "model_provider=stub",
    "-c", `model_providers.stub={name="stub",base_url="${stub.url}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`,
    ...extra, "Print the items.",
  ];
  return new Promise((done, fail) => {
    // Async: the stub answers from this process, so a sync spawn would deadlock it.
    const child = spawn("codex", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`codex exited ${c}`))));
  });
}

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(execFileSync("codex", ["--version"], { env, cwd: project }).toString().trim());
  await run([]);
  mode = "code";
  await run(["-c", "features.code_mode=true"]);
  const sessions = join(env.CODEX_HOME, "sessions");
  const scrub = (s) => s.split(project).join("/work/demo").split(home).join("/home/user").split(root).join("/tmp/capture");
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const f of readdirSync(sessions, { recursive: true })) {
    if (!String(f).endsWith(".jsonl")) continue;
    const dest = join(outDir, "sessions", String(f));
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, scrub(readFileSync(join(sessions, String(f)), "utf8")));
    n++;
  }
  console.error(`${n} rollout(s) in ${outDir}; ${served} main-loop model calls`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = n === 2 ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
