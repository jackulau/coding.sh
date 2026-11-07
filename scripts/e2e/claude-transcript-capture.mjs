#!/usr/bin/env node
// A real Claude Code transcript for adapter fixtures: install the pinned Claude
// Code CLI from npm under a throwaway HOME, point it at the local stub model and
// play one scripted session that exercises what the transcript adapter reads
// beyond plain tool calls:
//   - a Read repeated with nothing changed in between (duplicate fetch);
//   - Bash edits: `sed -i`, a heredoc write, `tee` (toolUseResult.bashEditDiff,
//     turned on with CLAUDE_CODE_BASH_EDIT_DIFF);
//   - a Read under sub/ (sub/CLAUDE.md loads mid-session: nested_memory, and
//     sub/.claude/skills is listed: dynamic_skill);
//   - the Skill tool, then a run of a script in the skill's directory, and a
//     Read of a personal skill (~/.claude/skills/hello/SKILL.md);
//   - cache usage scripted per call: reads grow, then drop to zero (a cache
//     break); then /compact in the same process, which restores the invoked
//     skill (invoked_skills), and one more prompt on a cold cache.
// The transcript is copied out with the temp paths (and the project slug) scrubbed
// to /work/demo and /home/user, like the other adapter fixtures. Request snapshots
// (api-request lines, prompt_snapshot attachments) are dropped: they hold Claude
// Code's system prompt and most of the bytes, and the adapter never reads them.
//
//   node scripts/e2e/claude-transcript-capture.mjs --out <dir> [--keep]
//
// Needs network for npm. Never touches the real HOME. Exit 0 when a transcript was written.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { startStub, toolNames } from "./stub-model.mjs";

const PKG = "@anthropic-ai/claude-code@2.1.319";
const MODEL = "claude-sonnet-4-5";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;
const keep = args.includes("--keep");
if (!outDir) throw new Error("--out <dir> is required");

const root = mkdtempSync(join(tmpdir(), "csh-cc-capture-"));
const home = join(root, "home");
const prefix = join(root, "npm-global");
const project = join(root, "demo");
const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const p = (rel) => join(project, rel);
write(p("CLAUDE.md"), "Keep changes small.\n");
write(p("notes.txt"), "alpha\nbravo\n");
write(p("sub/CLAUDE.md"), "SUB-RULE: files under sub/ stay ASCII.\n");
write(p("sub/inner.txt"), "inner\n");
write(p("sub/.claude/skills/subskill/SKILL.md"), "---\nname: subskill\ndescription: Use when editing files under sub/.\n---\nKeep sub/ tidy.\n");
write(p(".claude/skills/greet/SKILL.md"), "---\nname: greet\ndescription: Use when greeting someone.\n---\nRun scripts/hi.js to greet.\n");
write(p(".claude/skills/greet/scripts/hi.js"), "console.log('hi');\n");
write(join(home, ".claude/skills/hello/SKILL.md"), "---\nname: hello\ndescription: Use when saying hello.\n---\nSay hello.\n");
// Bash edit diffs are taken against the working tree's git state.
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@coding.sh.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@coding.sh.invalid" };
for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync("git", a, { cwd: project, stdio: "pipe", env: gitEnv });

// One entry per main-loop model call: the tool it asks for (none: the final answer) and its prompt-side usage.
const u = (create, read) => ({ input_tokens: 40, cache_creation_input_tokens: create, cache_read_input_tokens: read });
const SCRIPT = [
  { tool: { name: "Read", args: { file_path: p("notes.txt") } }, usage: u(20000, 0) },
  { tool: { name: "Read", args: { file_path: p("notes.txt") } }, usage: u(400, 20000) },
  { tool: { name: "Bash", args: { command: "sed -i 's/alpha/beta/' notes.txt", description: "Rename alpha" } }, usage: u(400, 20400) },
  { tool: { name: "Bash", args: { command: "cat > gen.txt <<'EOF'\none\ntwo\nEOF", description: "Write gen.txt" } }, usage: u(400, 20800) },
  { tool: { name: "Bash", args: { command: "echo hi | tee out.txt", description: "Write out.txt" } }, usage: u(400, 21200) },
  { tool: { name: "Read", args: { file_path: p("sub/inner.txt") } }, usage: u(400, 21600) },
  { tool: { name: "Skill", args: { skill: "greet" } }, usage: u(400, 22000) },
  // The cache is gone: everything is written again.
  { tool: { name: "Bash", args: { command: "node .claude/skills/greet/scripts/hi.js", description: "Greet" } }, usage: u(22800, 0) },
  { tool: { name: "Read", args: { file_path: join(home, ".claude/skills/hello/SKILL.md") } }, usage: u(400, 22800) },
  { usage: u(400, 23200) },
  // Second prompt, after /compact: the prompt is short and the cache cold.
  { tool: { name: "Read", args: { file_path: p("notes.txt") } }, usage: u(9000, 0) },
  { usage: u(300, 9000) },
];
let call = 0;
/** Model calls answered so far (script calls and the compaction summary). */
let served = 0;

const lastUserText = (body) => {
  const m = [...body.messages].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c?.text ?? "").join("\n");
};

function decide(body) {
  if (!Array.isArray(body.messages)) return { text: "ok" };
  if (/create a detailed summary|summary of the conversation/i.test(lastUserText(body))) {
    if (process.env.CAPTURE_DEBUG) console.error("stub: compaction summary");
    served++;
    return { text: "<summary>Renamed alpha in notes.txt, wrote gen.txt and out.txt, ran the greet skill.</summary>" };
  }
  if (!toolNames(body).includes("Read")) return { text: "ok" };
  const s = SCRIPT[Math.min(call++, SCRIPT.length - 1)];
  served++;
  if (process.env.CAPTURE_DEBUG) console.error(`stub: call ${call - 1} -> ${s.tool?.name ?? "text"}`);
  return s.tool ? { tool: s.tool, usage: s.usage } : { text: "Done.", usage: s.usage };
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
  // Off by default without the remote flag; on in real bypassPermissions sessions.
  CLAUDE_CODE_BASH_EDIT_DIFF: "true",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
});
if (process.env.npm_config_cache) env.npm_config_cache = process.env.npm_config_cache;

try {
  execFileSync("npm", ["install", "-g", "--no-fund", "--no-audit", PKG], { env, cwd: root, stdio: "inherit" });
  console.error(`claude ${execFileSync("claude", ["--version"], { env, cwd: project }).toString().trim()}`);
  // Async: the stub answers from this process, so a sync spawn would deadlock it. Three prompts in one
  // process (stream-json input): the task, /compact (which restores the invoked skill), one more check.
  await new Promise((done, fail) => {
    const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--model", MODEL];
    const child = spawn("claude", argv, { env, cwd: project, stdio: ["pipe", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill(), 180_000);
    const say = (text) => child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    // Each prompt waits for the previous one's last model call (a queued prompt would join its turn).
    const after = (n) => new Promise((ok) => (function poll() { served >= n ? ok() : setTimeout(poll, 200); })());
    const pause = () => new Promise((ok) => setTimeout(ok, 1000));
    (async () => {
      say("Tidy notes.txt and greet.");
      await after(10);
      await pause();
      say("/compact");
      await after(11);
      await pause();
      say("Check notes.txt once more.");
      await after(13);
      await pause();
      child.stdin.end();
    })();
    child.on("error", fail);
    child.on("exit", (c) => (clearTimeout(timer), c === 0 ? done() : fail(new Error(`claude exited ${c}`))));
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
