#!/usr/bin/env node
// A real Codex rollout that loads a skill by reading its files with the shell, the
// way Codex does (it has no Skill tool): `sed -n` of the skill's SKILL.md, then a
// `cat` of a plain project file that is no skill. coding.sh tags the first call
// with the skill (payload.skill) and the session with skill:<name>.
// Pinned Codex from npm under a throwaway HOME, against the local stub model.
// The rollout is copied out with temp paths scrubbed to /work/demo and /home/user.
//
//   node scripts/e2e/codex-skill-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when the rollout was written.
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
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-codex-skill-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(join(project, ".agents", "skills", "release-notes"), { recursive: true });
writeFileSync(join(project, ".agents", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Write release notes from the git log.\n---\n\nList each change in one line.\n");
writeFileSync(join(project, "README.md"), "# demo\n");

// The calls, in order: one per model request that already has n tool outputs.
const STEPS = ["sed -n '1,80p' .agents/skills/release-notes/SKILL.md", "cat README.md"];
const outputs = (body) => (Array.isArray(body.input) ? body.input : []).filter((i) => i?.type === "function_call_output").length;
let served = 0;
function decide(body) {
  if (!toolNames(body).length) return { text: "ok" };
  served++;
  const n = outputs(body);
  return n < STEPS.length ? { tool: { name: "exec_command", args: { cmd: STEPS[n] } } } : { text: "Release notes: one change." };
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

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(execFileSync("codex", ["--version"], { env, cwd: project }).toString().trim());
  const argv = [
    "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", MODEL,
    "-c", "model_provider=stub",
    "-c", `model_providers.stub={name="stub",base_url="${stub.url}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`,
    "Write release notes using the release-notes skill.",
  ];
  await new Promise((done, fail) => {
    // Async: the stub answers from this process, so a sync spawn would deadlock it.
    const child = spawn("codex", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`codex exited ${c}`))));
  });
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
  console.error(`${n} rollout(s) in ${outDir}; ${served} model calls`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = n === 1 ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
