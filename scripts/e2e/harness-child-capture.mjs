#!/usr/bin/env node
// A real cross-harness child session: Claude Code's Bash tool runs `codex exec`,
// both with coding.sh's hooks installed by `coding.sh init`. Claude Code exports
// CLAUDE_CODE_SESSION_ID to the command, Codex's hooks inherit it, and the hook
// records it on Codex's spool lines (spawnedBy), so ingest links the Codex session
// to the Claude Code session as a child of type "harness".
// Pinned Claude Code and Codex from npm under a throwaway HOME, against the local
// stub model; the hooks are this checkout's build (dist/, run `npm run build` in
// packages/coding.sh first). The spool, Claude Code's transcript and Codex's rollout
// are copied out with temp paths scrubbed to /work/demo and /home/user.
//
//   node scripts/e2e/harness-child-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Never writes Codex hook
// trust: the codex command passes --dangerously-bypass-hook-trust, as eval runs do.
// Exit 0 when the capture has both sessions and ingest linked them.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub, toolNames } from "./stub-model.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(REPO, "packages", "coding.sh", "dist", "cli.mjs");
const CLAUDE = "@anthropic-ai/claude-code@2.1.319";
const CODEX = "@openai/codex@0.167.0";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");
if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run npm run build in packages/coding.sh`);

// Real path: both agents record the resolved cwd (/private/var/… on macOS), which the scrub must match.
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-harness-")));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# demo\n");

let stubUrl = "";
const served = [];
const text = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c?.text ?? c?.content ?? "").join("\n"));
const hasToolResult = (body) => (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"));

function decide(body) {
  // Codex (the responses API): answer in text.
  if (Array.isArray(body.input)) {
    served.push("codex");
    return { text: "Codex here: the README is a one-line title." };
  }
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Bash")) return { text: "ok" };
  if (hasToolResult(body)) {
    served.push("claude:2");
    return { text: "Codex says the README is a one-line title." };
  }
  served.push("claude:1");
  const provider = `model_providers.stub={name="stub",base_url="${stubUrl}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`;
  const command = `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m gpt-5 -c model_provider=stub -c '${provider}' 'Summarize README.md in one line.'`;
  return { tool: { name: "Bash", args: { command, description: "Ask Codex for a summary", timeout: 240000 } } };
}

const stub = await startStub({ decide });
stubUrl = stub.url;
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(XDG_|CLAUDE|ANTHROPIC|OPENAI|CODEX|CODING_SH|npm_config_|NPM_CONFIG_)/i.test(k)) env[k] = v;
Object.assign(env, {
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  CODING_SH_HOME: join(home, ".coding.sh"),
  // The capture's own ingest below reads the spool; no background ingest races it.
  CODING_SH_NO_AUTO_INGEST: "1",
  PATH: [join(prefix, "bin"), env.PATH].join(delimiter),
  npm_config_prefix: prefix,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
  ANTHROPIC_BASE_URL: stub.url,
  ANTHROPIC_API_KEY: "sk-stub",
  OPENAI_API_KEY: "sk-stub",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  // Codex writes the machine's time zone into its context: keep the capture's neutral.
  TZ: "UTC",
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;
mkdirSync(env.CODEX_HOME, { recursive: true });

const cs = (argv) => execFileSync(process.execPath, [CLI, ...argv], { env, cwd: project, encoding: "utf8" });
/** Claude Code's api-request lines keep only what the adapter reads; the large request records go. */
const API_REQUEST_KEYS = ["type", "sessionId", "agentId", "id", "timestamp", "version", "querySource"];
const slim = (line) => {
  if (!/^\{"type":"api-request"/.test(line)) return line;
  const e = JSON.parse(line);
  return JSON.stringify(Object.fromEntries(API_REQUEST_KEYS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])));
};
const dropped = (line) => /^\{"type":"api-request-(?:blob|shape)"/.test(line) || line.includes('"type":"prompt_snapshot"');
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
    .join("/tmp/capture")
    .split(stub.url)
    .join("http://127.0.0.1:8787");

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", CLAUDE, CODEX], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).toString().trim()}; ${execFileSync("codex", ["--version"], { env, cwd: project }).toString().trim()}`);
  cs(["init", "--agent", "claude-code", "--agent", "codex", "--yes", "--no-import", "--json"]);
  await new Promise((done, fail) => {
    const argv = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-5", "Ask Codex to summarize README.md."];
    // Async: the stub answers from this process, so a sync spawn would deadlock it.
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c}`))));
  });
  console.error(`model calls: ${served.join(" ")}`);

  // What coding.sh made of it, from this capture's own home.
  cs(["ingest", "--json"]);
  const sessions = JSON.parse(cs(["sessions", "--subagents", "--empty", "--limit", "20", "--json"])).sessions;
  const claude = sessions.find((s) => s.agent === "claude-code" && !s.parentSessionId);
  const codex = sessions.find((s) => s.agent === "codex");
  console.error(`sessions: ${sessions.map((s) => `${s.agent} ${s.id}${s.parentSessionId ? ` <- ${s.parentSessionId}` : ""}`).join("; ")}`);
  // The link's type shows in the parent's tree: `└ <codex id>  harness codex`.
  const tree = claude ? cs(["show", claude.id]) : "";
  const harness = Boolean(codex && tree.includes(`└ ${codex.id}  harness codex `));
  console.error(tree);

  mkdirSync(outDir, { recursive: true });
  const copy = (from, to, keepFile = () => true) => {
    if (!existsSync(from)) return 0;
    let n = 0;
    for (const f of readdirSync(from, { recursive: true })) {
      const src = join(from, String(f));
      if (!keepFile(String(f)) || !/\.(jsonl|json)$/.test(String(f))) continue;
      // Claude Code names its project dir after the cwd: scrub the path as well as the content.
      const dest = join(outDir, to, scrub(String(f)));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, scrub(readFileSync(src, "utf8")));
      n++;
    }
    return n;
  };
  const spool = copy(join(env.CODING_SH_HOME, "spool"), "home/.coding.sh/spool", (f) => f !== "errors.log");
  const transcripts = copy(join(home, ".claude", "projects"), "home/.claude/projects");
  const rollouts = copy(join(env.CODEX_HOME, "sessions"), "home/.codex/sessions");
  writeFileSync(join(outDir, "expected.json"), JSON.stringify({ claude: claude?.id, codex: codex?.id }, null, 2) + "\n");
  console.error(`${spool} spool file(s), ${transcripts} transcript(s), ${rollouts} rollout(s) in ${outDir}`);
  if (keep) cpSync(home, join(outDir, "_home"), { recursive: true });
  process.exitCode = claude && codex && codex.parentSessionId === claude.id && harness ? 0 : 1;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
