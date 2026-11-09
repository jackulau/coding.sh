#!/usr/bin/env node
// A real Claude Code transcript with a fork subagent (Agent with subagent_type "fork"),
// the records the adapter reads to keep a fork from counting its parent's context again:
//   - the parent reads notes.txt, then starts a fork with a directive;
//   - the fork's transcript opens with the parent's context: here a `fork-context-ref`
//     line and a copy of the parent's Agent call (a new uuid, the same message.id and
//     usage); other runs copy every parent entry (same uuid and message.id). Either way
//     the context ends at a user entry with the "Fork started" tool_result for the
//     Agent call and the directive, and the fork's own calls follow. The .meta.json
//     sidecar says {"agentType":"fork","isFork":true,"toolUseId":…};
//   - the fork runs in the background (2.1.319 runs a fork that way under -p): the parent
//     answers the launch, the fork reads notes.txt and answers, and the parent answers
//     the fork's task-notification.
// Cache usage is scripted per call: the fork's calls read the parent's prefix from the
// cache, as a fork of a warm parent does.
// Pinned Claude Code from npm under a throwaway HOME, against the local stub model.
// Transcripts and meta sidecars are copied out with temp paths scrubbed to /work/demo
// and /home/user, like the other adapter fixtures; request snapshots are dropped.
//
//   node scripts/e2e/claude-fork-subagent-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when a fork transcript was written.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-4-5";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cc-forksub-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "CLAUDE.md"), "Keep changes small.\n");
writeFileSync(join(project, "notes.txt"), "alpha\nbravo\ncharlie\n");

const u = (create, read) => ({ input_tokens: 40, cache_creation_input_tokens: create, cache_read_input_tokens: read });
const DIRECTIVE = "Count the lines in notes.txt and report the number.";
const PARENT = [
  { tool: { name: "Read", args: { file_path: join(project, "notes.txt") } }, usage: u(20000, 0) },
  { tool: { name: "Agent", args: { subagent_type: "fork", description: "Count lines", prompt: DIRECTIVE } }, usage: u(400, 20000) },
  // The fork runs in the background: the parent answers its launch, then the fork's task-notification.
  { text: "The fork is counting.", usage: u(500, 20400) },
  { text: "The fork counted 3 lines.", usage: u(300, 20900) },
];
// The fork's requests carry the parent's conversation: they read the parent's prefix from the cache.
const FORK = [
  { tool: { name: "Read", args: { file_path: join(project, "notes.txt") } }, usage: u(600, 20400) },
  { text: "notes.txt has 3 lines.", usage: u(300, 21000) },
];
let parent = 0;
let fork = 0;
const served = [];

const texts = (m) => (Array.isArray(m?.content) ? m.content : []).flatMap((c) => (c?.type === "tool_result" ? (Array.isArray(c.content) ? c.content.map((x) => x?.text ?? "") : [String(c.content ?? "")]) : []));
const inFork = (body) => body.messages.some((m) => m.role === "user" && texts(m).some((t) => t.startsWith("Fork started")));

function decide(body) {
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Read")) return { text: "ok" };
  const f = inFork(body);
  const s = f ? FORK[Math.min(fork++, FORK.length - 1)] : PARENT[Math.min(parent++, PARENT.length - 1)];
  served.push(`${f ? "fork" : "parent"}:${s.tool?.name ?? "text"}`);
  if (process.env.CAPTURE_DEBUG) console.error(`stub: ${served.at(-1)}`);
  return s.tool ? { tool: s.tool, usage: s.usage } : { text: s.text, usage: s.usage };
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
  // Stream-json input keeps the process up until the fork and the parent's last call are served.
  await new Promise((done, fail) => {
    const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["pipe", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    const all = PARENT.length + FORK.length;
    (async () => {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "Read notes.txt, then fork to count its lines." } })}\n`);
      await new Promise((ok) => (function poll() { served.length >= all ? ok() : setTimeout(poll, 200); })());
      await new Promise((ok) => setTimeout(ok, 1500));
      child.stdin.end();
    })();
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c}`))));
  });
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
      .join("/tmp/capture")
      // A background agent's output file sits in Claude Code's temp dir, named by the user id.
      .replace(/(?:\/private)?\/tmp\/claude-\d+\//g, "/tmp/claude/");
  let n = 0;
  let forks = 0;
  for (const slug of readdirSync(projects)) {
    for (const f of readdirSync(join(projects, slug), { recursive: true })) {
      if (!/\.(jsonl|meta\.json)$/.test(String(f))) continue;
      const text = readFileSync(join(projects, slug, String(f)), "utf8");
      if (String(f).endsWith(".meta.json") && JSON.parse(text).isFork === true) forks++;
      const dest = join(outDir, String(f));
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, scrub(text));
      n++;
    }
  }
  console.error(`${n} file(s) in ${outDir}, ${forks} fork subagent(s); ${stub.requests.length} model requests`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = forks ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
