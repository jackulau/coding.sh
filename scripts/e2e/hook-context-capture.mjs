#!/usr/bin/env node
// Real Claude Code transcripts with hook-injected context, for adapter fixtures:
// install the pinned Claude Code CLI from npm under a throwaway HOME, point it at
// the local stub model and run two headless sessions (`claude -p`) in a project
// whose hooks add context:
//   - project hooks in .claude/settings.json: a SessionStart hook that prints
//     plain text (Claude Code adds hook stdout to the context) and a
//     UserPromptSubmit hook that answers JSON additionalContext;
//   - the second session also loads a local plugin ("terse", --plugin-dir)
//     whose SessionStart and PostToolUse(Read) hooks answer additionalContext;
//   - the third installs the same plugin from a local marketplace
//     (`claude plugin install terse@local`), so its install record and cache
//     (plugins/installed_plugins.json, plugins/cache/…) are copied out too.
// The stub checks the injected text reached the model. Each hook also records
// the env Claude Code gave it (CLAUDE_CODE_ENTRYPOINT), printed at the end.
// Transcripts are copied out with the temp paths scrubbed to /work/demo,
// /home/user and /tmp/capture, like the other adapter fixtures; request
// snapshots are dropped.
//
//   node scripts/e2e/hook-context-capture.mjs --out <dir> [--keep]
//
// <dir> is laid out like a Claude config dir: projects/-work-demo/<sid>.jsonl
// and plugins/{installed_plugins.json,cache/…}.
//
// Needs network for npm. Never touches the real HOME. Exit 0 when both
// transcripts were written and every injected text reached the model.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-4-5";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

const root = mkdtempSync(join(tmpdir(), "csh-hookctx-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
const market = join(root, "market");
const plugin = join(market, "plugins", "terse");
const envDir = join(root, "hook-env");
const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const p = (rel) => join(project, rel);

// Each hook script records its env, then prints what it injects.
const hookScript = (name, out) => `const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const e = process.env;
  fs.mkdirSync(${JSON.stringify(envDir)}, { recursive: true });
  fs.writeFileSync(path.join(${JSON.stringify(envDir)}, ${JSON.stringify(name)} + "-" + Date.now() + ".json"), JSON.stringify({ entrypoint: e.CLAUDE_CODE_ENTRYPOINT, pluginRoot: e.CLAUDE_PLUGIN_ROOT, input: JSON.parse(input || "{}") }));
  process.stdout.write(${JSON.stringify(out)});
});
`;
const ctx = (event, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

const PROJECT_START = "PROJECT-START: build with make, never npm.";
const PROJECT_PROMPT = "PROJECT-PROMPT: the user prefers short answers.";
const TERSE_START = "TERSE-MODE: answer in as few words as possible. Drop articles and filler.";
const TERSE_READ = "TERSE-READ: summarize files in one line.";

write(p("CLAUDE.md"), "Keep changes small.\n");
write(p("notes.txt"), "alpha\nbravo\n");
write(p(".claude/hooks/start.js"), hookScript("project-SessionStart", `${PROJECT_START}\n`));
write(p(".claude/hooks/prompt.js"), hookScript("project-UserPromptSubmit", ctx("UserPromptSubmit", PROJECT_PROMPT)));
write(
  p(".claude/settings.json"),
  `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/start.js"' }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prompt.js"' }] }],
      },
    },
    null,
    2,
  )}\n`,
);
write(join(plugin, ".claude-plugin/plugin.json"), `${JSON.stringify({ name: "terse", version: "0.1.0", description: "Short answers." }, null, 2)}\n`);
write(join(plugin, "hooks/start.js"), hookScript("plugin-SessionStart", ctx("SessionStart", TERSE_START)));
write(join(plugin, "hooks/read.js"), hookScript("plugin-PostToolUse", ctx("PostToolUse", TERSE_READ)));
write(
  join(plugin, "hooks/hooks.json"),
  `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/start.js"' }] }],
        PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/read.js"' }] }],
      },
    },
    null,
    2,
  )}\n`,
);
write(join(market, ".claude-plugin/marketplace.json"), `${JSON.stringify({ name: "local", owner: { name: "e2e" }, plugins: [{ name: "terse", source: "./plugins/terse", description: "Short answers." }] }, null, 2)}\n`);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@coding.sh.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@coding.sh.invalid" };
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync("git", a, { cwd: project, stdio: "pipe", env: gitEnv });

/** Every request body's text, to check what reached the model. */
const seen = [];
function decide(body) {
  seen.push(JSON.stringify(body));
  if (!Array.isArray(body.messages) || !toolNames(body).includes("Read")) return { text: "ok" };
  const done = body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_result"));
  return done ? { text: "Done.", usage: { input_tokens: 40 } } : { tool: { name: "Read", args: { file_path: p("notes.txt") } } };
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

/** One headless session; resolves when claude exits. */
const session = (prompt, extra) =>
  new Promise((done, fail) => {
    const argv = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL, ...extra];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["ignore", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c}`))));
  });

let failed = 0;
const check = (ok, what) => {
  console.error(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).toString().trim()}`);
  await session("Read notes.txt and say what it holds.", []);
  const plain = seen.join("\n");
  seen.length = 0;
  await session("Read notes.txt and say what it holds, with the terse plugin.", ["--plugin-dir", plugin]);
  const withPlugin = seen.join("\n");
  seen.length = 0;
  execFileSync("claude", ["plugin", "marketplace", "add", market], { env, cwd: project, stdio: "inherit" });
  execFileSync("claude", ["plugin", "install", "terse@local"], { env, cwd: project, stdio: "inherit" });
  await session("Read notes.txt and say what it holds, with the installed plugin.", []);
  const installed = seen.join("\n");
  check(plain.includes(PROJECT_START) && plain.includes(PROJECT_PROMPT), "session 1: both project hooks reached the model");
  check(!plain.includes("TERSE-"), "session 1: no plugin context");
  for (const t of [PROJECT_START, PROJECT_PROMPT, TERSE_START, TERSE_READ]) check(withPlugin.includes(t), `session 2: ${t.split(":")[0]} reached the model`);
  for (const t of [TERSE_START, TERSE_READ]) check(installed.includes(t), `session 3 (installed): ${t.split(":")[0]} reached the model`);
  const envs = readdirSync(envDir).map((f) => ({ f, ...JSON.parse(readFileSync(join(envDir, f), "utf8")) }));
  for (const e of envs) console.error(`hook env ${e.f}: CLAUDE_CODE_ENTRYPOINT=${e.entrypoint ?? "(unset)"} hook_event_name=${e.input?.hook_event_name}`);

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
      const dest = join(outDir, "projects", scrub(slug), String(f));
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, scrub(readFileSync(join(projects, slug, String(f)), "utf8")));
      n++;
    }
  }
  check(n === 3, `${n} transcript(s) in ${outDir}`);
  // The install record and the installed copy of the plugin, paths scrubbed.
  const plugins = join(home, ".claude", "plugins");
  for (const f of readdirSync(plugins, { recursive: true })) {
    const src = join(plugins, String(f));
    if (!String(f).startsWith("cache") && String(f) !== "installed_plugins.json") continue;
    if (!statSync(src).isFile()) continue;
    const dest = join(outDir, "plugins", String(f));
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, scrub(readFileSync(src, "utf8")));
  }
  if (keep) cpSync(root, join(outDir, "_root"), { recursive: true, filter: (s) => !s.includes("npm-global") });
  process.exitCode = failed ? 1 : 0;
} finally {
  await stub.close();
  if (!keep) rmSync(root, { recursive: true, force: true });
}
