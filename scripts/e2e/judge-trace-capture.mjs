#!/usr/bin/env node
// Judge trace fixtures from a real `codex exec --json` run (AD-1): what the
// runner hands a task verifier as CODING_SH_AGENT_STDOUT for Codex, and the
// OpenAI Responses input Codex sent on its last model call.
//   - codex-exec.jsonl: three exec_command calls (two succeed, one exits 1),
//     then a final message. Each command_execution item has item.started and
//     item.completed records.
//   - openai-responses.json: the last request's `input` array, with
//     function_call / function_call_output items.
// Pinned Codex from npm under a throwaway HOME, against the local stub model.
// Temp paths are scrubbed to /work/demo and /home/user.
//
//   node scripts/e2e/judge-trace-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when both files were written.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@openai/codex@0.167.0";
const MODEL = "gpt-5";
const COMMANDS = ["echo hello from demo", "cat missing.txt", "ls"];

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-judge-trace-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "AGENTS.md"), "Keep changes small.\n");

let lastInput;
function decide(body) {
  const names = toolNames(body);
  if (!names.length) return { text: "ok" };
  const input = Array.isArray(body.input) ? body.input : [];
  lastInput = input;
  const done = input.filter((i) => i?.type === "function_call_output").length;
  if (done < COMMANDS.length) return { tool: { name: "exec_command", args: { cmd: COMMANDS[done] } } };
  return { text: "Ran three commands; missing.txt does not exist." };
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
  TZ: "UTC",
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
mkdirSync(env.CODEX_HOME, { recursive: true });

function run() {
  const argv = [
    "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", MODEL,
    "-c", "model_provider=stub",
    "-c", `model_providers.stub={name="stub",base_url="${stub.url}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`,
    "Run the three commands.",
  ];
  return new Promise((done, fail) => {
    const child = spawn("codex", argv, { env, cwd: project, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done(out) : fail(new Error(`codex exited ${c}`))));
  });
}

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(execFileSync("codex", ["--version"], { env, cwd: project }).toString().trim());
  const stdout = await run();
  const scrub = (s) => s.split(project).join("/work/demo").split(home).join("/home/user").split(root).join("/tmp/capture");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "codex-exec.jsonl"), scrub(stdout));
  // Only the conversation items: the system/developer prompt is Codex's, not the run's.
  const items = (lastInput ?? []).filter((i) => ["function_call", "function_call_output", "message"].includes(i?.type) && i.role !== "developer" && i.role !== "system");
  writeFileSync(join(outDir, "openai-responses.json"), scrub(JSON.stringify(items, null, 1)) + "\n");
  const n = stdout.split("\n").filter((l) => l.includes('"command_execution"')).length;
  console.error(`codex-exec.jsonl: ${n} command_execution records; openai-responses.json: ${items.length} items`);
  process.exitCode = n >= COMMANDS.length && items.length ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
