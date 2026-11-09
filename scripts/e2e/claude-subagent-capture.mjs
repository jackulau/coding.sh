#!/usr/bin/env node
// A real Claude Code transcript for the adapter's call merging and subagent tree:
//   - one model response with two parallel Read calls, streamed slowly: Claude Code
//     writes one transcript line per content block and runs the first Read before the
//     second block arrives, so its tool_result line splits the message's lines;
//   - api-request records (the exact start of each model request), kept but cut down
//     to the fields the adapter reads (no system prompt, no params);
//   - an Agent call whose subagent itself calls Agent: a nested subagent, whose
//     .meta.json names its parent agent (parentAgentId, spawnDepth 2).
// Pinned Claude Code from npm under a throwaway HOME, against the local stub model.
// The transcripts (and subagent .meta.json sidecars) are copied out with temp paths
// scrubbed to /work/demo and /home/user, like the other adapter fixtures.
//
//   node scripts/e2e/claude-subagent-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when transcripts were written.
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

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cc-subagent-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "a.txt"), "alpha\n");
writeFileSync(join(project, "b.txt"), "bravo\n");
writeFileSync(join(project, "c.txt"), "charlie\n");

const MID = "MID-AGENT: ask a nested helper to read c.txt and report back.";
const LEAF = "LEAF-AGENT: read c.txt and say what it holds.";
const cached = (read, write) => ({ input_tokens: 40, cache_read_input_tokens: read, cache_creation_input_tokens: write });
// Steps per agent, picked by the agent's task (its first user message) and how many replies it has had.
const SCRIPTS = {
  main: [
    { text: "Reading both files.", tools: [{ name: "Read", args: { file_path: join(project, "a.txt") } }, { name: "Read", args: { file_path: join(project, "b.txt") } }], usage: cached(0, 12_000), pauseMs: 1500 },
    { tool: { name: "Agent", args: { description: "Delegate c.txt", prompt: MID, subagent_type: "general-purpose" } }, usage: cached(12_000, 400) },
    { text: "a.txt says alpha, b.txt says bravo, c.txt says charlie.", usage: cached(12_400, 300) },
  ],
  mid: [
    { tool: { name: "Agent", args: { description: "Read c.txt", prompt: LEAF, subagent_type: "general-purpose" } }, usage: cached(0, 9_000) },
    { text: "The nested helper says c.txt holds charlie.", usage: cached(9_000, 200) },
  ],
  leaf: [
    { tool: { name: "Read", args: { file_path: join(project, "c.txt") } }, usage: cached(0, 8_000) },
    { text: "c.txt holds charlie.", usage: cached(8_000, 100) },
  ],
};
const served = [];

const text = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c?.text ?? "").join("\n"));

function decide(body) {
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Read")) return { text: "ok" };
  const first = text(body.messages.find((m) => m.role === "user"));
  const who = first.includes(LEAF) ? "leaf" : first.includes(MID) ? "mid" : "main";
  const step = body.messages.filter((m) => m.role === "assistant").length;
  const s = SCRIPTS[who][Math.min(step, SCRIPTS[who].length - 1)];
  served.push(`${who}:${step}${who !== "main" ? `(agent tool offered: ${toolNames(body).includes("Agent")})` : ""}`);
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

/** api-request lines keep only what the adapter reads: when the request started, its id, and whose it was. */
const API_REQUEST_KEYS = ["type", "sessionId", "agentId", "id", "timestamp", "version", "querySource"];
const slim = (line) => {
  if (!/^\{"type":"api-request"/.test(line)) return line;
  const e = JSON.parse(line);
  return JSON.stringify(Object.fromEntries(API_REQUEST_KEYS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])));
};
const dropped = (line) => /^\{"type":"api-request-(?:blob|shape)"/.test(line) || line.includes('"type":"prompt_snapshot"');

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).toString().trim()}`);
  await new Promise((done, fail) => {
    const argv = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL, "Read a.txt and b.txt, then have a helper read c.txt."];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c}`))));
  });
  console.error(`calls: ${served.join(" ")}`);
  const projects = join(home, ".claude", "projects");
  mkdirSync(outDir, { recursive: true });
  const scrub = (s) =>
    s
      .split("\n")
      .filter((l) => !dropped(l))
      .map(slim)
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
      if (!/\.(jsonl|meta\.json)$/.test(String(f))) continue;
      const dest = join(outDir, String(f));
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, scrub(readFileSync(join(projects, slug, String(f)), "utf8")));
      if (String(f).endsWith(".jsonl")) n++;
    }
  }
  console.error(`${n} transcript(s) in ${outDir}; ${stub.requests.length} model requests`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = n ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
