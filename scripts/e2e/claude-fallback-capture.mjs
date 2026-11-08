#!/usr/bin/env node
// A real Claude Code transcript where the model changes mid-session, the records the
// adapter reads for `model:fallback` and `model:switch`:
//   - turn 1 runs on the main model (claude-opus-5-5);
//   - turn 2: the main model answers 529 overloaded until Claude Code falls back to
//     `--fallback-model` (claude-opus-4-8) and writes a `system/model_fallback` record;
//   - turn 3: the main model is tried again (a fallback lasts one turn), so the session
//     switches back, then stops on a refusal twice. 2.1.319 retries a refusal once on the
//     same model and, with no refusal fallback routed (the stub sends no refusal
//     category), records `system/model_refusal_no_fallback`. A `model_refusal_fallback`
//     record needs the API's routing, so the adapter's tests build that one by hand.
// Pinned Claude Code from npm under a throwaway HOME, against the local stub model.
// The transcript is copied out with temp paths scrubbed to /work/demo and /home/user,
// like the other adapter fixtures; request snapshots are dropped.
//
//   node scripts/e2e/claude-fallback-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when a transcript was written.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-opus-5-5";
const FALLBACK = "claude-opus-4-8";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cc-fallback-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "CLAUDE.md"), "Keep changes small.\n");

const overloaded = { status: 529, headers: { "request-id": "req_stub_529" }, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
// A cached prompt, so the fallback's cache break shows in the usage.
const cached = (read, write) => ({ input_tokens: 40, cache_read_input_tokens: read, cache_creation_input_tokens: write });
// Main-loop steps in order. A step with `onModel` answers only that model; any other model skips past it.
const SCRIPT = [
  { tool: { name: "Bash", args: { command: "ls", description: "List files" } }, usage: cached(0, 12_000) },
  { text: "One file: CLAUDE.md.", usage: cached(12_000, 400) },
  { onModel: MODEL, error: overloaded },
  { tool: { name: "Bash", args: { command: "wc -l CLAUDE.md", description: "Count lines" } }, usage: cached(0, 12_800) },
  { text: "It has one line.", usage: cached(12_800, 300) },
  { onModel: MODEL, stop: "refusal", text: "I can't help with that.", usage: cached(0, 13_200) },
  { onModel: MODEL, stop: "refusal", text: "I still can't help with that.", usage: cached(13_200, 100) },
  { text: "It asks for small changes.", usage: cached(0, 13_300) },
];
let step = 0;
const served = [];

function decide(body) {
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Bash")) return { text: "ok" };
  while (SCRIPT[step]?.onModel && SCRIPT[step].onModel !== body.model) step++;
  const s = SCRIPT[Math.min(step, SCRIPT.length - 1)];
  // An error answers its model until the agent moves on; other steps are served once.
  if (!s.error) step++;
  served.push(`${body.model}:${s.error ? s.error.status : s.stop ?? (s.tool ? "tool" : "text")}`);
  if (process.env.CAPTURE_DEBUG) console.error(`stub: ${served.at(-1)}`);
  return s;
}

const stub = await startStub({ decide });
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) env[k] = v;
Object.assign(env, {
  HOME: home,
  PATH: [join(prefix, "bin"), env.PATH].join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;

/** One `claude -p` turn; `--continue` resumes the same session. Async: the stub answers from this process. */
const turn = (prompt, more = []) =>
  new Promise((done, fail) => {
    const argv = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL, "--fallback-model", FALLBACK, ...more, prompt];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on("error", fail);
    // A refused turn may exit non-zero; the transcript is what counts.
    child.on("exit", () => (clearTimeout(timer), done()));
  });

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).toString().trim()}`);
  await turn("What files are here?");
  await turn("How many lines does CLAUDE.md have?", ["--continue"]);
  await turn("What does CLAUDE.md ask for?", ["--continue"]);
  console.error(`main-loop calls: ${served.join(" ")}`);
  const projects = join(home, ".claude", "projects");
  mkdirSync(outDir, { recursive: true });
  const dropped = (line) => /^\{"type":"api-request/.test(line) || line.includes('"type":"prompt_snapshot"');
  const scrub = (s) =>
    s
      .split("\n")
      .filter((l) => !dropped(l))
      .join("\n")
      .split(project)
      .join("/work/demo")
      .split(project.replace(/[^A-Za-z0-9]/g, "-"))
      .join("-work-demo")
      .split(home)
      .join("/home/user")
      .split(root)
      .join("/tmp/capture");
  let n = 0;
  for (const slug of readdirSync(projects)) {
    for (const f of readdirSync(join(projects, slug), { recursive: true })) {
      if (!String(f).endsWith(".jsonl")) continue;
      const dest = join(outDir, String(f));
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, scrub(readFileSync(join(projects, slug, String(f)), "utf8")));
      n++;
    }
  }
  console.error(`${n} transcript(s) in ${outDir}; ${stub.requests.length} model requests`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = n ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
