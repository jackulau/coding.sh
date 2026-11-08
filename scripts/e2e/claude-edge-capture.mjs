#!/usr/bin/env node
// A real Claude Code transcript with the harness edge cases the adapter reads:
//   - API errors Claude Code retries: two 429s with rate-limit headers
//     (`anthropic-ratelimit-unified-*`, retry-after) and a 529 overloaded, then success;
//   - a Bash command whose output is too large, which Claude Code saves to a file
//     and replaces with a `<persisted-output>` preview in the tool result.
// Pinned Claude Code from npm under a throwaway HOME, against the local stub model.
// The transcript is copied out with temp paths scrubbed to /work/demo and /home/user,
// like the other adapter fixtures; request snapshots are dropped.
//
//   node scripts/e2e/claude-edge-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when a transcript was written.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-4-5";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

// Real path: Claude Code records the resolved cwd (/private/var/… on macOS), which the scrub must match.
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cc-edge-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "CLAUDE.md"), "Keep changes small.\n");

// A weekly limit the API rejects for now: the headers Claude Code reads its rate-limit state from.
const reset = Math.floor(Date.now() / 1000) + 3600;
const limited = {
  status: 429,
  headers: {
    "retry-after": "1",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(reset),
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(reset),
    "anthropic-ratelimit-unified-7d-utilization": "1.0",
    "request-id": "req_stub_429",
  },
  body: { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } },
};
const overloaded = { status: 529, headers: { "request-id": "req_stub_529" }, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
// Main-loop calls in order; each error is one attempt Claude Code retries.
const SCRIPT = [
  { error: limited },
  { error: limited },
  { error: overloaded },
  { tool: { name: "Bash", args: { command: "seq 1 200000", description: "Print many lines" } } },
  { text: "Done." },
];
let call = 0;
let served = 0;

function decide(body) {
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Bash")) return { text: "ok" };
  const s = SCRIPT[Math.min(call++, SCRIPT.length - 1)];
  served++;
  if (process.env.CAPTURE_DEBUG) console.error(`stub: call ${call - 1} -> ${s.error ? s.error.status : (s.tool?.name ?? "text")}`);
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

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).toString().trim()}`);
  // Async: the stub answers from this process, so a sync spawn would deadlock it.
  await new Promise((done, fail) => {
    const argv = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL, "Print the numbers."];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c} after ${served} main-loop calls`))));
  });
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
